/**
 * Chạy một job: clone → tách ticket → mỗi ticket một lượt judge → gộp kết quả.
 *
 * Hai backend, cùng một schema trả về:
 *   - `fci` (mặc định): một request HTTP tới endpoint OpenAI-compatible, ngữ
 *     cảnh repo gom sẵn, `temperature: 0`.
 *   - `cli`: spawn CLI của AstraCode, agent tự duyệt repo.
 * Chỗ duy nhất biết chúng khác nhau là `judgeOnce()`; từ đó trở đi đường đi
 * giống hệt — cùng bộ bóc JSON, cùng bộ lọc evidence, cùng report.
 *
 * Tuần tự, cố ý: tiến độ `done/total` chỉ có nghĩa khi các lượt không chồng nhau.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { cloneRepo } from './git.mjs';
import { parseTickets } from './tickets.mjs';
import { buildPrompt, buildJudgePrompt } from './prompt.mjs';
import { extractJsonBlock, pickItem } from './jsonBlock.mjs';
import { matchesAny } from './globs.mjs';
import { askFci, fciConfigured } from './fciJudge.mjs';
import { judgeWithoutModel } from './noneJudge.mjs';
import { buildRepoContext, renderContext } from './repoContext.mjs';

export const DEFAULT_OPTIONS = {
  max_files_per_ticket: 5,
  exclude_globs: ['**/__pycache__/**', '**/node_modules/**', '**/.venv/**', '**/dist/**'],
  timeout_sec: 600,
  prompt_override: null,
};

/** Biến môi trường cho tiến trình con: chỉ những gì OS cần, cộng token AstraWork. */
function childEnv(astraworkToken) {
  const pass = [
    'PATH', 'Path', 'SystemRoot', 'windir', 'TEMP', 'TMP', 'TMPDIR', 'HOME',
    'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA',
    'ProgramFiles', 'ProgramFiles(x86)', 'ProgramData', 'COMSPEC', 'ComSpec',
    'PATHEXT', 'LANG', 'LC_ALL',
  ];
  const env = {};
  for (const k of pass) if (process.env[k] !== undefined) env[k] = process.env[k];
  env.NO_COLOR = '1';
  env.ASTRA_MARKDOWN = '0';
  // CLI đọc token ở đây (packages/cli/src/tokenStore.ts) trước khi rơi về ~/.astra.
  if (astraworkToken) env.ASTRAWORK_TOKEN = astraworkToken;
  return env;
}

function runCli({ cliPath, cwd, prompt, astraworkToken, timeoutMs, signal }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, '--mode=plan', '--raw', '-p', prompt], {
      cwd,
      env: childEnv(astraworkToken),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    const onAbort = () => child.kill('SIGKILL');
    signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout.on('data', (d) => {
      stdout += d;
    });
    child.stderr.on('data', (d) => {
      stderr += d;
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}

/**
 * Một lượt judge cho một ticket. Trả về văn bản thô của model — phần bóc JSON
 * nằm ngoài, dùng chung cho cả hai backend.
 */
async function judgeOnce({ backend, ticket, options, repoDir, config, timeoutMs, redact, job }) {
  if (backend === 'none') {
    // Không có model nên không có gì để bóc: trả thẳng object đã dựng, nhưng nó
    // vẫn đi qua `pickItem` như hai backend kia để không có đường nào lách được
    // phần kiểm schema.
    return { parsed: await judgeWithoutModel({ ticket, options, repoDir }), note: 'quét tất định (backend none)', stderr: '' };
  }

  if (backend === 'cli') {
    const prompt = buildPrompt({ ticket, options, promptOverride: options.prompt_override });
    const res = await runCli({
      cliPath: config.cliPath,
      cwd: repoDir,
      prompt,
      astraworkToken: job.astraworkToken,
      timeoutMs,
      signal: job.abort?.signal,
    });
    if (res.timedOut) throw new Error(`Ticket "${ticket.key}": CLI quá ${Math.round(timeoutMs / 1000)}s, đã bị dừng.`);
    return { text: res.stdout, note: `CLI thoát với mã ${res.code}`, stderr: res.stderr };
  }

  if (!fciConfigured(config)) {
    throw new Error('Backend "fci" chưa cấu hình: cần FPT_BASE_URL, FPT_API_KEY và FPT_MODEL.');
  }
  const ctx = await buildRepoContext({ repoDir, ticket, excludeGlobs: options.exclude_globs });
  const prompt = buildJudgePrompt({
    ticket,
    options,
    context: renderContext(ctx),
    promptOverride: options.prompt_override,
  });
  const { text, usage } = await askFci({ config, prompt, timeoutMs, redact });
  return { text, note: `FCI ${config.fciModel}`, usage, stderr: '' };
}

/** `src/a.ts:120-148` → {path, lines}. Model hay gộp như vậy dù schema tách hai field. */
function splitPathLine(raw) {
  const m = /^(.*?):(\d+(?:\s*-\s*\d+)?)$/.exec(raw);
  return m ? { path: m[1], lines: m[2] } : { path: raw, lines: '' };
}

function normalizeRel(raw, repoDir) {
  let p = String(raw).replace(/\\/g, '/').trim();
  if (!p) return '';
  if (path.isAbsolute(p) || /^[A-Za-z]:\//.test(p)) {
    const rel = path.relative(repoDir, path.resolve(p));
    if (rel.startsWith('..')) return '';
    p = rel.replace(/\\/g, '/');
  }
  return p.replace(/^\.\//, '').replace(/^\/+/, '');
}

async function countLines(file) {
  const buf = await fs.readFile(file);
  if (!buf.length) return 0;
  let n = 1;
  for (const b of buf) if (b === 10) n++;
  return buf[buf.length - 1] === 10 ? n - 1 : n;
}

/**
 * Giữ lại bằng chứng có thật. Luật, theo đúng thứ tự:
 *
 *   - path không tồn tại (hoặc không phải file, hoặc thoát khỏi repo, hoặc khớp
 *     exclude_globs)            → LOẠI
 *   - start > số dòng file      → LOẠI (trỏ vào chỗ không có gì)
 *   - end   > số dòng file      → KẸP end về số dòng file, giữ lại
 *   - thiếu `lines`             → GIỮ, `lines: null`
 *
 * Kẹp thay vì loại là có lý do: model đoán hụt điểm kết thúc của một hàm vẫn
 * đang chỉ đúng chỗ, còn `start` sai thì nó đang chỉ vào hư không.
 */
export async function keepRealEvidence(evidence, repoDir, options) {
  const kept = [];
  const dropped = [];
  const clamped = [];
  const seen = new Set();
  const paths = new Set();

  for (const ev of evidence) {
    const merged = ev.lines ? ev : { ...ev, ...splitPathLine(ev.path) };
    const rel = normalizeRel(merged.path, repoDir);
    const drop = (why) => dropped.push({ path: ev.path, why });

    if (!rel) {
      drop('đường dẫn rỗng hoặc nằm ngoài repo');
      continue;
    }
    if (matchesAny(rel, options.exclude_globs)) {
      drop('khớp exclude_globs');
      continue;
    }
    const abs = path.resolve(repoDir, rel);
    if (abs !== repoDir && !abs.startsWith(repoDir + path.sep)) {
      drop('đường dẫn thoát khỏi repo');
      continue;
    }
    let stat;
    try {
      stat = await fs.stat(abs);
    } catch {
      drop('không tồn tại trong repo');
      continue;
    }
    if (!stat.isFile()) {
      drop('không phải file');
      continue;
    }

    const rawLines = String(merged.lines ?? '').replace(/\s+/g, '');
    let lines = null;
    if (rawLines) {
      const m = /^(\d+)(?:-(\d+))?$/.exec(rawLines);
      if (!m) {
        drop(`khoảng dòng "${merged.lines}" không đúng dạng "120-148" hoặc "42"`);
        continue;
      }
      const start = Number(m[1]);
      let end = m[2] ? Number(m[2]) : start;
      const total = await countLines(abs);
      if (start < 1 || start > total) {
        drop(`dòng bắt đầu ${start} nằm ngoài file (${total} dòng)`);
        continue;
      }
      if (end < start) {
        drop(`khoảng dòng ${rawLines} có điểm kết thúc nhỏ hơn điểm bắt đầu`);
        continue;
      }
      if (end > total) {
        clamped.push({ path: rel, from: rawLines, to: start === total ? `${start}` : `${start}-${total}` });
        end = total;
      }
      lines = start === end ? `${start}` : `${start}-${end}`;
    }

    const sig = `${rel}#${lines ?? 'null'}`;
    if (seen.has(sig)) continue;
    if (!paths.has(rel) && paths.size >= options.max_files_per_ticket) {
      drop(`vượt max_files_per_ticket=${options.max_files_per_ticket}`);
      continue;
    }
    seen.add(sig);
    paths.add(rel);
    kept.push({ path: rel, lines, note: merged.note ?? '' });
  }

  return { evidence: kept, dropped, clamped };
}

function buildReportMd({ runId, generatedAt, backend, repoUrl, ref, head, items, tickets, droppedByKey, clampedByKey, stats }) {
  const byKey = new Map(tickets.map((t) => [t.key, t]));
  const count = (s) => items.filter((i) => i.code_status === s).length;

  const out = [];
  out.push('# AstraCode — báo cáo đối chiếu code');
  out.push('');
  out.push(`- run_id: \`${runId}\``);
  out.push(`- generated_at: ${generatedAt}`);
  out.push(`- backend: \`${backend}\`${stats.model ? ` (model \`${stats.model}\`)` : ''}`);
  out.push(`- repo: ${repoUrl}${ref ? ` (ref: ${ref})` : ''}`);
  if (head) out.push(`- commit: \`${head}\``);
  out.push(`- tickets: ${items.length} — done ${count('done')}, partial ${count('partial')}, missing ${count('missing')}`);
  out.push(`- bằng chứng: giữ ${stats.evidence_kept}, loại ${stats.evidence_dropped}, kẹp ${stats.evidence_clamped}`);
  out.push('');
  out.push('| Ticket | Trạng thái ngoài | Code | Confidence | Bằng chứng |');
  out.push('|---|---|---|---:|---:|');
  for (const it of items) {
    const t = byKey.get(it.key);
    out.push(
      `| \`${it.key}\` | ${t?.status || '—'} | **${it.code_status}** | ${it.confidence.toFixed(2)} | ${it.evidence.length} |`,
    );
  }
  out.push('');

  for (const it of items) {
    const t = byKey.get(it.key);
    out.push(`## ${it.key}${t?.title ? ` — ${t.title}` : ''}`);
    out.push('');
    out.push(`- code_status: **${it.code_status}** (confidence ${it.confidence.toFixed(2)}, reason: ${it.reason})`);
    if (t?.status) out.push(`- trạng thái do nguồn ngoài báo: ${t.status}`);
    out.push('');
    if (it.evidence.length) {
      for (const ev of it.evidence) {
        out.push(`- \`${ev.path}${ev.lines ? `:${ev.lines}` : ''}\`${ev.lines ? '' : ' _(không nêu số dòng)_'}${ev.note ? ` — ${ev.note}` : ''}`);
      }
    } else {
      out.push('- _không có bằng chứng nào trụ lại sau khi đối chiếu với repo._');
    }
    const clamped = clampedByKey.get(it.key) ?? [];
    if (clamped.length) {
      out.push('');
      out.push(
        `<sub>đã kẹp ${clamped.length} khoảng dòng về cuối file: ${clamped
          .map((c) => `\`${c.path}\` ${c.from} → ${c.to}`)
          .join(', ')}</sub>`,
      );
    }
    const dropped = droppedByKey.get(it.key) ?? [];
    if (dropped.length) {
      out.push('');
      out.push(`<sub>đã loại ${dropped.length} bằng chứng: ${dropped.map((d) => `\`${d.path}\` (${d.why})`).join(', ')}</sub>`);
    }
    out.push('');
  }

  return out.join('\n');
}

/**
 * Chạy job. Cập nhật `job.progress` / `job.current` tại chỗ để endpoint poll
 * đọc được ngay, trả về `result` đúng hợp đồng.
 */
export async function runAnalyzeJob({ job, body, config, redact, log }) {
  const options = { ...DEFAULT_OPTIONS, ...(body.options ?? {}) };
  const timeoutMs = Math.max(1, Number(options.timeout_sec) || DEFAULT_OPTIONS.timeout_sec) * 1000;
  const maxFiles = Math.max(1, Number(options.max_files_per_ticket) || DEFAULT_OPTIONS.max_files_per_ticket);
  const excludes = Array.isArray(options.exclude_globs) ? options.exclude_globs : DEFAULT_OPTIONS.exclude_globs;
  const effective = { ...options, max_files_per_ticket: maxFiles, exclude_globs: excludes };

  const backend = ['cli', 'fci', 'none'].includes(body.backend) ? body.backend : config.judgeBackend;

  // Tách ticket TRƯỚC khi clone: tickets_md hỏng thì không việc gì phải kéo cả
  // một repo về rồi mới báo lỗi.
  const tickets = parseTickets(body.tickets_md);

  const repoDir = path.join(config.workspaceDir, job.id, 'repo');
  await fs.mkdir(repoDir, { recursive: true });

  job.progress = { done: 0, total: tickets.length };
  job.astraworkToken = body.astrawork_token || config.astraworkJwt || '';
  const startedAt = Date.now();
  const stats = {
    backend,
    model: backend === 'fci' ? config.fciModel : undefined,
    judge_calls: 0,
    judge_parsed: 0,
    evidence_kept: 0,
    evidence_dropped: 0,
    evidence_clamped: 0,
    duration_ms: 0,
  };
  job.stats = stats;

  try {
    const { head } = await cloneRepo({
      repoUrl: body.repo_url,
      ref: body.ref,
      repoToken: body.repo_token,
      destDir: repoDir,
      redact,
      timeoutMs,
    });

    const items = [];
    const droppedByKey = new Map();
    const clampedByKey = new Map();

    log(`clone xong: ${tickets.length} ticket, commit ${head || '(không rõ)'} — bắt đầu chấm bằng backend ${backend}`);

    for (const ticket of tickets) {
      job.current = ticket.key;
      const ticketStartedAt = Date.now();

      stats.judge_calls += 1;
      const res = await judgeOnce({ backend, ticket, options: effective, repoDir, config, timeoutMs, redact, job });

      let parsed;
      try {
        parsed = res.parsed ?? extractJsonBlock(res.text);
      } catch (err) {
        const tail = redact(res.stderr ?? '').trim().split('\n').slice(-3).join(' ');
        throw new Error(
          `Ticket "${ticket.key}": ${err instanceof Error ? err.message : String(err)} ` +
            `(${res.note}${tail ? `, stderr: ${tail}` : ''})`,
        );
      }

      const item = pickItem(parsed, ticket.key);
      stats.judge_parsed += 1;

      const { evidence, dropped, clamped } = await keepRealEvidence(item.evidence, repoDir, effective);
      item.evidence = evidence;
      droppedByKey.set(item.key, dropped);
      clampedByKey.set(item.key, clamped);
      stats.evidence_kept += evidence.length;
      stats.evidence_dropped += dropped.length;
      stats.evidence_clamped += clamped.length;
      // Một dòng cho MỌI ticket, không chỉ ticket có evidence bị loại: đọc log
      // ban đêm cần thấy cả những lượt trôi chảy, nếu không thì im lặng là nhập
      // nhằng giữa "chạy tốt" và "chưa chạy tới".
      log(
        `[${items.length + 1}/${tickets.length}] ${ticket.key} | ${Date.now() - ticketStartedAt}ms | ` +
          `${item.code_status} (confidence ${item.confidence.toFixed(2)}, ${item.reason}) | ` +
          `bằng chứng giữ ${evidence.length}, loại ${dropped.length}, kẹp ${clamped.length}` +
          (dropped.length ? ` — loại: ${dropped.map((d) => `${d.path} (${d.why})`).join('; ')}` : '') +
          (clamped.length ? ` — kẹp: ${clamped.map((c) => `${c.path} ${c.from}→${c.to}`).join('; ')}` : ''),
      );

      items.push(item);
      job.progress = { done: items.length, total: tickets.length };
    }

    stats.duration_ms = Date.now() - startedAt;
    const generatedAt = new Date().toISOString();
    return {
      run_id: body.run_id ?? null,
      generated_at: generatedAt,
      backend,
      items,
      report_md: buildReportMd({
        runId: body.run_id ?? job.id,
        generatedAt,
        backend,
        repoUrl: redact(body.repo_url),
        ref: body.ref ?? '',
        head,
        items,
        tickets,
        droppedByKey,
        clampedByKey,
        stats,
      }),
      stats,
    };
  } finally {
    stats.duration_ms = stats.duration_ms || Date.now() - startedAt;
    job.current = undefined;
    // Xong job là xoá. Repo của người khác không có lý do gì nằm lại trên đĩa.
    await fs
      .rm(path.join(config.workspaceDir, job.id), { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
      .catch((err) => log(`job ${job.id}: không xoá được thư mục tạm — ${redact(String(err))}`));
  }
}
