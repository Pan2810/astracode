/** AI re-judge jobs used by AstraQA snapshot verdicts. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { cloneRepo } from './git.mjs';
import { askFci, fciConfigured } from './fciJudge.mjs';
import { extractJsonBlock } from './jsonBlock.mjs';
import { runCli } from './analyze.mjs';

function safeEvidenceContext(repoDir, evidence) {
  return Promise.all((Array.isArray(evidence) ? evidence : []).slice(0, 8).map(async (item) => {
    const rel = String(item?.path || '').replace(/\\/g, '/').replace(/^\/+/, '');
    const abs = path.resolve(repoDir, rel);
    if (!rel || (abs !== repoDir && !abs.startsWith(repoDir + path.sep))) return '';
    try {
      const realRepo = await fs.realpath(repoDir);
      const real = await fs.realpath(abs);
      if (real !== realRepo && !real.startsWith(realRepo + path.sep)) return '';
      const lines = (await fs.readFile(abs, 'utf8')).split(/\r?\n/);
      const match = /^(\d+)(?:-(\d+))?$/.exec(String(item?.lines || ''));
      const start = match ? Math.max(1, Number(match[1]) - 8) : 1;
      const end = match ? Math.min(lines.length, Number(match[2] || match[1]) + 8) : Math.min(lines.length, 80);
      return `FILE ${rel}:${start}-${end}\n${lines.slice(start - 1, end).map((line, i) => `${start + i}: ${line}`).join('\n')}`;
    } catch { return ''; }
  })).then((parts) => parts.filter(Boolean).join('\n\n'));
}

function promptFor(ticket, guide, context, backend) {
  return `${backend === 'cli' ? 'Inspect the repository at the current commit and independently check the cited implementation.\n' : ''}` +
    `Review the supplied code evidence for ticket ${ticket.key}. Choose exactly one verdict key from this guide: ${JSON.stringify(guide)}.\n` +
    `The prior grep verdict is ${ticket.grep_verdict || ''}; independently correct it only when the evidence supports it.\n` +
    `Reply only with a JSON fenced block: {"key":"${ticket.key}","verdict":"<one guide key>","confidence":0.0,"reason":"short evidence-grounded explanation"}.\n\n` +
    `TICKET:\n${ticket.summary || ticket.title || ''}\n${ticket.description || ''}\n` +
    `ACCEPTANCE CRITERIA:\n${(ticket.acceptance_criteria || []).map((item, i) => `${i + 1}. ${item}`).join('\n') || '(none provided)'}\n\n` +
    `EVIDENCE:\n${context || '(No readable cited code; retain the grep tier.)'}`;
}

function parseVerdict(text, ticket, guide) {
  const value = extractJsonBlock(text);
  const row = Array.isArray(value?.results) ? value.results[0] : value;
  const verdict = String(row?.verdict || '').trim();
  const confidence = Number(row?.confidence);
  if (String(row?.key || '').trim() !== String(ticket.key || '').trim()) throw new Error('model returned a different ticket key');
  if (!Object.hasOwn(guide, verdict)) throw new Error('model returned an unknown verdict');
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) throw new Error('model returned an invalid confidence');
  const reason = String(row?.reason || '').trim();
  if (!reason) throw new Error('model returned no reason');
  return { key: String(ticket.key), verdict, confidence, reason, tier: 'ai' };
}

export async function runJudgeJob({ job, body, config, redact, limiter, usage }) {
  const backend = config.judgeBackend;
  if (backend === 'none') throw new Error('AI judge requires a model-backed backend.');
  if (backend === 'fci' && !fciConfigured(config)) throw new Error('AI judge requires configured FPT_BASE_URL, FPT_API_KEY and FPT_MODEL.');
  const tickets = Array.isArray(body.tickets) ? body.tickets.filter((t) => t && typeof t === 'object' && String(t.key || '').trim()) : [];
  if (!tickets.length) throw new Error('tickets must be a non-empty array.');
  if (!body.repo_url || typeof body.repo_url !== 'string') throw new Error('repo_url is required.');
  if (!body.verdict_guide || typeof body.verdict_guide !== 'object' || Array.isArray(body.verdict_guide)) throw new Error('verdict_guide is required.');
  const repoDir = path.join(config.workspaceDir, job.id, 'repo');
  await fs.mkdir(repoDir, { recursive: true });
  try {
  const { head } = await cloneRepo({ repoUrl: body.repo_url, ref: String(body.ref || ''), repoToken: String(body.repo_token || ''), destDir: repoDir, redact, timeoutMs: 300000 });
  if (/^[a-f0-9]{40}$/i.test(String(body.ref || '')) && head.toLowerCase() !== body.ref.toLowerCase()) {
    throw new Error('Judge clone did not resolve to the pinned source revision.');
  }
  job.total = tickets.length;
  job.done = 0;
  job.results = [];
  job.source_revision = head;
  for (const ticket of tickets) {
    if (job.abort.signal.aborted) { job.status = 'cancelled'; return; }
    job.current = String(ticket.key);
    try {
      const context = await safeEvidenceContext(repoDir, ticket.evidence);
      if (!context) throw new Error('no cited code could be read');
      const prompt = promptFor(ticket, body.verdict_guide, context, backend);
      let text;
      if (backend === 'cli') {
        usage.model_calls += 1;
        const result = await runCli({
          cliPath: config.cliPath,
          cwd: repoDir,
          prompt,
          astraworkToken: config.astraworkJwt,
          timeoutMs: 120000,
          signal: job.abort.signal,
          traceFile: path.join(config.runsDir, 'traces', job.id, `judge-${job.done + 1}.jsonl`),
        });
        if (result.timedOut || result.code !== 0) throw new Error(`AstraCode CLI failed (${result.code}).`);
        text = result.stdout;
      } else {
        ({ text } = await limiter.run(() => askFci({ config, prompt, timeoutMs: 120000, redact, signal: job.abort.signal, onAttempt: () => { usage.model_calls += 1; } })));
      }
      job.results.push(parseVerdict(text, ticket, body.verdict_guide));
    } catch (err) {
      job.results.push({ key: String(ticket.key), tier: 'grep', error: redact(err instanceof Error ? err.message : String(err)) });
    }
    job.done += 1;
  }
  job.status = 'succeeded';
  } finally {
    await fs.rm(path.join(config.workspaceDir, job.id), { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
  }
}
