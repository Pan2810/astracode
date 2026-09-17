/**
 * WORKSPACE_DIR: đường dẫn phải TUYỆT ĐỐI, và job không được im lặng khi bộ lọc
 * bằng chứng loại sạch.
 *
 * Nguồn gốc: `.env` đặt `WORKSPACE_DIR=./.workspace`. Đường dẫn tương đối đi
 * thẳng vào `repoDir`, còn `keepRealEvidence` so nó với `path.resolve(...)` nên
 * phép so không bao giờ đúng — 771/771 mảnh bằng chứng bị loại với lý do "thoát
 * khỏi repo", 184 ticket vẫn trả về `done` với `evidence: []`, và job báo
 * succeeded. AstraQA đọc bảng đó thành 182 NO_EVIDENCE.
 *
 * Hai lớp chặn, test cả hai: resolve ở `readConfig`, và job chết thành tiếng nếu
 * bằng chứng vẫn bị loại sạch vì lý do nào khác.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { readConfig, ensureWorkspaceWritable, createServer } from '../server.mjs';
import { keepRealEvidence } from '../lib/analyze.mjs';

const run = promisify(execFile);
const cwd0 = process.cwd();
let tmp;
let repoUrl;
let server;
let base;

before(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'astraqa-ws-'));
  // Đứng trong tmp để một WORKSPACE_DIR tương đối vẫn rơi vào tmp, không rải
  // thư mục vào cây làm việc của AstraCode.
  process.chdir(tmp);

  const dir = path.join(tmp, 'repo');
  await fs.mkdir(path.join(dir, 'src'), { recursive: true });
  await fs.writeFile(
    path.join(dir, 'src', 'session.py'),
    '# WEB-1001: man hinh dang nhap\n\n\ndef start_session(user):\n    return {"user": user}\n',
  );
  await fs.writeFile(path.join(dir, 'src', 'cache.py'), 'CACHE = {}\n\n\ndef cache_lookup(key):\n    return CACHE.get(key)\n');
  await fs.writeFile(path.join(dir, 'src', 'billing.py'), 'def invoice_total(items):\n    return sum(i.amount for i in items)\n');
  await fs.writeFile(path.join(dir, 'src', 'report.py'), 'def render_report(rows):\n    return "\n".join(str(r) for r in rows)\n');
  await fs.writeFile(path.join(dir, 'src', 'upload.py'), 'def store_attachment(blob):\n    return len(blob)\n');
  await fs.writeFile(path.join(dir, 'src', 'router.py'), 'ROUTES = {}\n\n\ndef dispatch(p):\n    return ROUTES.get(p)\n');
  await run('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  await run('git', ['add', '-A'], { cwd: dir });
  await run('git', ['-c', 'user.email=t@e.invalid', '-c', 'user.name=t', 'commit', '-q', '-m', 'i'], { cwd: dir });
  repoUrl = pathToFileURL(dir).href;
});

after(async () => {
  if (server) await new Promise((r) => server.close(r));
  process.chdir(cwd0);
  await fs.rm(tmp, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
});

test('readConfig: WORKSPACE_DIR tương đối vẫn ra đường dẫn tuyệt đối', () => {
  const cfg = readConfig({ WORKSPACE_DIR: './.workspace' });
  assert.ok(path.isAbsolute(cfg.workspaceDir), `phải tuyệt đối, nhận "${cfg.workspaceDir}"`);
  assert.equal(cfg.workspaceDir, path.resolve(tmp, '.workspace'));
  // Mặc định (không đặt biến) vốn đã tuyệt đối — đừng để resolve làm hỏng nó.
  assert.ok(path.isAbsolute(readConfig({}).workspaceDir));
});

test('keepRealEvidence: repoDir dựng từ config tương đối vẫn giữ được bằng chứng', async () => {
  // Đúng phép thử đã tái hiện lỗi: trước khi sửa, repoDir ra ".workspace\j\repo"
  // và mảnh này bị loại vì "đường dẫn thoát khỏi repo".
  const cfg = readConfig({ WORKSPACE_DIR: './.workspace' });
  const repoDir = path.join(cfg.workspaceDir, 'job-1', 'repo');
  await fs.mkdir(path.join(repoDir, 'core'), { recursive: true });
  await fs.writeFile(path.join(repoDir, 'core', 'task.py'), 'a\nb\nc\n');

  const r = await keepRealEvidence([{ path: 'core/task.py', lines: '2', note: '' }], repoDir, {
    max_files_per_ticket: 5,
    exclude_globs: [],
  });
  assert.equal(r.evidence.length, 1, `phải giữ 1, loại ${r.dropped.length}: ${JSON.stringify(r.dropped)}`);
  assert.equal(r.dropped.length, 0);
});

test('ensureWorkspaceWritable: tạo thư mục còn thiếu và không để lại file thăm dò', async () => {
  const dir = path.join(tmp, 'ws-probe', 'sâu');
  await ensureWorkspaceWritable(dir);
  assert.deepEqual(await fs.readdir(dir), []);
});

test('job loại sạch bằng chứng → failed, không phải succeeded với bảng rỗng', async () => {
  // workspaceDir tương đối = đúng cấu hình đã gây ra 182 NO_EVIDENCE. Ở đây nó
  // đi thẳng vào createServer nên không qua readConfig — chặn lớp hai phải bắt.
  server = createServer(
    {
      port: 0,
      workspaceDir: 'ws-tuong-doi',
      runsDir: path.join(tmp, 'runs'),
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

  const { job_id } = await (
    await fetch(`${base}/api/v1/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ run_id: 'R-WS', repo_url: repoUrl, tickets_md: '## WEB-1001 — them man hinh login\n\nStatus: Done' }),
    })
  ).json();

  let job;
  for (let i = 0; i < 200; i++) {
    job = await (await fetch(`${base}/api/v1/analyze/${job_id}`)).json();
    if (job.status === 'succeeded' || job.status === 'failed') break;
    await new Promise((s) => setTimeout(s, 25));
  }
  assert.equal(job.status, 'failed');
  assert.match(job.error, /Bộ lọc bằng chứng loại toàn bộ 1\/1 mảnh/);
  assert.match(job.error, /WORKSPACE_DIR\/repoDir/);

  // Job hỏng vẫn để lại vết ở results/<run_id>.json — người trực đêm đọc file đó.
  const jsonFile = path.join(tmp, 'runs', 'results', 'R-WS.json');
  let saved = null;
  for (let i = 0; i < 40 && !saved; i++) {
    saved = await fs.readFile(jsonFile, 'utf8').then(JSON.parse).catch(() => null);
    if (!saved) await new Promise((s) => setTimeout(s, 25));
  }
  assert.equal(saved?.status, 'failed');
  assert.match(saved.error, /loại toàn bộ/);
});
