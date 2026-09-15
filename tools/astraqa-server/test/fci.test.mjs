/**
 * Backend `fci` chạy offline: một endpoint OpenAI-compatible giả dựng tại chỗ.
 *
 * Phủ đúng phần mà backend `cli` không phủ — dựng ngữ cảnh repo, gọi HTTP,
 * `temperature: 0`, header Authorization — mà không chạm mạng thật.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { createServer } from '../server.mjs';
import { buildRepoContext, keywordsOf, renderContext } from '../lib/repoContext.mjs';

const run = promisify(execFile);
const TOKEN = 'service-token-dung-cho-test-0123456789';
const KEY = 'sk-KHONG-DUOC-LO-RA-0123456789';

let tmp;
let fci;
let fciUrl;
const seen = [];
let server;
let base;
let repoUrl;

before(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'astraqa-fci-'));

  // Endpoint giả: trả về khối ```json dựng từ chính prompt nhận được.
  fci = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      const payload = JSON.parse(body);
      seen.push({ auth: req.headers.authorization, payload });
      const prompt = payload.messages.at(-1).content;
      const key = (/Ticket key:\s*(.+)/.exec(prompt)?.[1] ?? '').trim();
      const first = (/^\s{2}(\S+)$/m.exec(prompt.split('--- NGỮ CẢNH REPO ---')[1] ?? '')?.[1] ?? 'README.md').trim();
      const content =
        '```json\n' +
        JSON.stringify({
          items: [
            {
              key,
              code_status: 'partial',
              confidence: 0.6,
              evidence: [{ path: first, lines: '1-999', note: 'kep ve cuoi file' }],
              reason: 'matched_by_key',
            },
          ],
        }) +
        '\n```';
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }], usage: { total_tokens: 42 } }));
    });
  });
  await new Promise((r) => fci.listen(0, '127.0.0.1', r));
  fciUrl = `http://127.0.0.1:${fci.address().port}/v1`;

  const dir = path.join(tmp, 'repo');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'README.md'), 'mot\nhai\nba\n');
  await fs.writeFile(path.join(dir, 'login.py'), 'def login():\n    return True\n');
  await run('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  await run('git', ['add', '-A'], { cwd: dir });
  await run('git', ['-c', 'user.email=t@e.invalid', '-c', 'user.name=t', 'commit', '-q', '-m', 'i'], { cwd: dir });
  repoUrl = pathToFileURL(dir).href;

  server = createServer(
    {
      port: 0,
      workspaceDir: path.join(tmp, 'ws'),
      cliPath: 'khong-dung-toi',
      astraworkJwt: '',
      serviceToken: TOKEN,
      judgeBackend: 'fci',
      fciBaseUrl: fciUrl,
      fciApiKey: KEY,
      fciModel: 'Qwen3.8-27B',
    },
    { log: () => {} },
  );
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((r) => server.close(r));
  await new Promise((r) => fci.close(r));
  await fs.rm(tmp, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
});

async function analyze(body) {
  const res = await fetch(`${base}/api/v1/analyze`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify(body),
  });
  const { job_id } = await res.json();
  for (let i = 0; i < 200; i++) {
    const r = await fetch(`${base}/api/v1/analyze/${job_id}`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    const j = await r.json();
    if (j.status === 'succeeded' || j.status === 'failed') return j;
    await new Promise((s) => setTimeout(s, 25));
  }
  throw new Error('job không kết thúc');
}

test('/healthz khai backend fci và model, không lộ key', async () => {
  const body = await (await fetch(`${base}/healthz`)).json();
  assert.equal(body.backend, 'fci');
  assert.equal(body.model, 'Qwen3.8-27B');
  assert.equal(body.fci_configured, true);
  assert.ok(!JSON.stringify(body).includes(KEY));
});

test('job chạy qua fci: temperature 0, Bearer đúng, schema như backend cli', async () => {
  const done = await analyze({ run_id: 'R-FCI', repo_url: repoUrl, tickets_md: '## LOGIN-1 — them login\n\nStatus: Done' });
  assert.equal(done.status, 'succeeded', done.error);
  assert.equal(done.result.backend, 'fci');
  assert.equal(done.result.run_id, 'R-FCI');
  assert.deepEqual(done.result.items.map((i) => i.key), ['LOGIN-1']);
  assert.equal(done.result.stats.judge_calls, 1);
  assert.equal(done.result.stats.judge_parsed, 1);
  // Bằng chứng "1-999" phải bị kẹp về số dòng thật của file.
  assert.equal(done.result.stats.evidence_clamped, 1);
  assert.match(done.result.report_md, /đã kẹp 1 khoảng dòng/);

  const call = seen.at(-1);
  assert.equal(call.auth, `Bearer ${KEY}`);
  assert.equal(call.payload.temperature, 0);
  assert.equal(call.payload.model, 'Qwen3.8-27B');
  assert.match(call.payload.messages.at(-1).content, /Ticket key: LOGIN-1/);
  assert.match(call.payload.messages.at(-1).content, /Trả lời CHỈ bằng một khối/);
});

test('fci thiếu cấu hình → job failed với message rõ ràng', async () => {
  const bare = createServer(
    {
      port: 0,
      workspaceDir: path.join(tmp, 'ws2'),
      cliPath: 'x',
      astraworkJwt: '',
      serviceToken: '',
      judgeBackend: 'fci',
      fciBaseUrl: '',
      fciApiKey: '',
      fciModel: '',
    },
    { log: () => {} },
  );
  await new Promise((r) => bare.listen(0, '127.0.0.1', r));
  const b = `http://127.0.0.1:${bare.address().port}`;
  const { job_id } = await (
    await fetch(`${b}/api/v1/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repo_url: repoUrl, tickets_md: '## K — x' }),
    })
  ).json();
  let j;
  for (let i = 0; i < 200; i++) {
    j = await (await fetch(`${b}/api/v1/analyze/${job_id}`)).json();
    if (j.status === 'failed' || j.status === 'succeeded') break;
    await new Promise((s) => setTimeout(s, 25));
  }
  assert.equal(j.status, 'failed');
  assert.match(j.error, /chưa cấu hình/);
  await new Promise((r) => bare.close(r));
});

test('ngữ cảnh repo: từ khoá lấy từ ticket, dòng khớp kèm số dòng thật', async () => {
  const dir = path.join(tmp, 'ctx');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'a.py'), 'import os\ndef login(user):\n    pass\n');
  const ticket = { key: 'LOGIN-1', title: 'them man hinh login', body: '' };
  assert.ok(keywordsOf(ticket).includes('login'));
  const ctx = await buildRepoContext({ repoDir: dir, ticket, excludeGlobs: [] });
  assert.deepEqual(ctx.files, ['a.py']);
  assert.ok(ctx.snippets.some((s) => s.path === 'a.py' && s.line === 2));
  assert.match(renderContext(ctx), /a\.py:2:/);
});
