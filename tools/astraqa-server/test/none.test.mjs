/**
 * Backend `none` — chạy được khi KHÔNG có credential nào.
 *
 * Đây cũng là bài test duy nhất chứng minh đường ống hoàn chỉnh mà không cần
 * key, JWT, mạng hay CLI: clone → tách ticket → quét → lọc evidence → report.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { createServer } from '../server.mjs';

const run = promisify(execFile);
let tmp;
let server;
let base;
let repoUrl;

before(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'astraqa-none-'));
  const dir = path.join(tmp, 'repo');
  await fs.mkdir(path.join(dir, 'src'), { recursive: true });
  await fs.writeFile(path.join(dir, 'src', 'login.py'), 'import os\n\n\ndef login(user):\n    return True\n');
  await fs.writeFile(path.join(dir, 'README.md'), '# demo\n\nWEB-1001 da duoc lam o src/login.py\n');
  await run('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  await run('git', ['add', '-A'], { cwd: dir });
  await run('git', ['-c', 'user.email=t@e.invalid', '-c', 'user.name=t', 'commit', '-q', '-m', 'i'], { cwd: dir });
  repoUrl = pathToFileURL(dir).href;

  server = createServer(
    {
      port: 0,
      workspaceDir: path.join(tmp, 'ws'),
      runsDir: path.join(tmp, 'runs'),
      // Cố ý để trống HẾT: không CLI, không JWT, không key.
      cliPath: '',
      astraworkJwt: '',
      serviceToken: '',
      judgeBackend: 'none',
      fciBaseUrl: '',
      fciApiKey: '',
      fciModel: '',
    },
    { log: () => {} },
  );
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((r) => server.close(r));
  await fs.rm(tmp, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
});

async function analyze(body) {
  const { job_id } = await (
    await fetch(`${base}/api/v1/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  ).json();
  for (let i = 0; i < 200; i++) {
    const j = await (await fetch(`${base}/api/v1/analyze/${job_id}`)).json();
    if (j.status === 'succeeded' || j.status === 'failed') return j;
    await new Promise((s) => setTimeout(s, 25));
  }
  throw new Error('job không kết thúc');
}

test('/healthz khai backend none', async () => {
  const body = await (await fetch(`${base}/healthz`)).json();
  assert.equal(body.backend, 'none');
  assert.equal(body.model, null);
});

test('chạy trọn job mà không có key/JWT/CLI nào', async () => {
  const done = await analyze({
    run_id: 'R-NONE',
    repo_url: repoUrl,
    tickets_md: '## WEB-1001 — them man hinh login\n\nStatus: Done\n\n## ZZZ-999 — viec khong ai lam\n\nStatus: To Do',
  });
  assert.equal(done.status, 'succeeded', done.error);
  assert.equal(done.result.backend, 'none');
  assert.equal(done.result.stats.judge_calls, 2);
  assert.equal(done.result.stats.judge_parsed, 2);

  const [hit, miss] = done.result.items;
  assert.equal(hit.key, 'WEB-1001');
  assert.equal(hit.code_status, 'partial');
  assert.equal(hit.reason, 'matched_by_key');
  assert.ok(hit.evidence.length > 0);
  for (const ev of hit.evidence) {
    assert.ok(['README.md', 'src/login.py'].includes(ev.path), `đường dẫn lạ: ${ev.path}`);
    assert.match(ev.lines, /^\d+$/);
  }

  assert.equal(miss.key, 'ZZZ-999');
  assert.equal(miss.code_status, 'missing');
  assert.equal(miss.reason, 'no_match');
  assert.deepEqual(miss.evidence, []);
});

test('không bao giờ trả "done" — quét từ khoá không chứng minh được hoàn thành', async () => {
  const done = await analyze({ repo_url: repoUrl, tickets_md: '## login — login login login' });
  assert.equal(done.status, 'succeeded', done.error);
  assert.notEqual(done.result.items[0].code_status, 'done');
  assert.ok(done.result.items[0].confidence <= 0.5);
});

test('ép backend theo từng request qua field "backend"', async () => {
  const done = await analyze({ repo_url: repoUrl, tickets_md: '## K-1 — x', backend: 'none' });
  assert.equal(done.result.backend, 'none');
});
