/**
 * Bất biến của lớp quan sát: log là thứ sống lâu nhất mà server để lại, nên nó
 * là chỗ rò secret nguy hiểm nhất — một dòng lỡ tay nằm trên đĩa đến sáng.
 *
 * Test này canh hai điều:
 *   1. Bốn bí mật mà hợp đồng nêu tên (FPT_API_KEY, ASTRAWORK_JWT, repo_token,
 *      ASTRACODE_SERVICE_TOKEN) không xuất hiện trong BẤT KỲ chuỗi nào — console,
 *      logs/<run_id>.log, results/<run_id>.json, results/<run_id>.md.
 *   2. Ba file vẫn được ghi kể cả khi không ai poll, và `run_id` của người lạ
 *      không lái được đường ghi ra khỏi thư mục results/.
 *
 * Chạy offline bằng backend `none`: không model, không token thật, không mạng.
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
import { slugifyRunId, bannerLines, createRunLog } from '../lib/observe.mjs';

const run = promisify(execFile);

// Bốn bí mật, mỗi thứ một hình dạng thật để cả lớp literal lẫn lớp pattern của
// redactor đều bị thử.
const SECRETS = {
  service: 'svc-token-quan-sat-bi-mat-0123456789',
  jwt: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJxYSJ9.chu-ky-bi-mat-khong-duoc-lo',
  fciKey: 'sk-QUANSATKHONGDUOCLOKEYNAY0123456789',
  repo: 'ghp_QUANSATKHONGDUOCLOTOKENNAY0123456789',
};

let tmp;
let server;
let base;
let runsDir;
/** Mọi dòng server in ra console trong suốt bài test. */
let consoleLines;

async function makeRepo(name, files) {
  const dir = path.join(tmp, name);
  await fs.mkdir(dir, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
    await fs.writeFile(path.join(dir, rel), content);
  }
  await run('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  await run('git', ['add', '-A'], { cwd: dir });
  await run('git', ['-c', 'user.email=t@example.invalid', '-c', 'user.name=t', 'commit', '-q', '-m', 'init'], { cwd: dir });
  return pathToFileURL(dir).href;
}

const post = (body) =>
  fetch(`${base}/api/v1/analyze`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${SECRETS.service}` },
    body: JSON.stringify(body),
  });

async function poll(jobId, { tries = 200 } = {}) {
  for (let i = 0; i < tries; i++) {
    const res = await fetch(`${base}/api/v1/analyze/${jobId}`, { headers: { Authorization: `Bearer ${SECRETS.service}` } });
    const json = await res.json();
    if (json.status === 'succeeded' || json.status === 'failed') return json;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('job không kết thúc trong thời gian chờ');
}

/** Chờ một file xuất hiện — artifact được ghi qua hàng đợi nên trễ vài ms sau khi job xong. */
async function waitForFile(file, { tries = 100 } = {}) {
  for (let i = 0; i < tries; i++) {
    try {
      return await fs.readFile(file, 'utf8');
    } catch {
      await new Promise((r) => setTimeout(r, 20));
    }
  }
  throw new Error(`không thấy file ${file}`);
}

function assertNoSecret(text, where) {
  for (const [name, value] of Object.entries(SECRETS)) {
    assert.ok(!text.includes(value), `${where} lộ secret "${name}"`);
  }
}

before(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'astraqa-observe-'));
  runsDir = path.join(tmp, 'runs');
  consoleLines = [];
  server = createServer(
    {
      port: 0,
      workspaceDir: path.join(tmp, 'ws'),
      runsDir,
      cliPath: path.join(tmp, 'khong-dung-toi.mjs'),
      // Cả ba bí mật của cấu hình đều có giá trị thật ở đây: nếu có đường nào in
      // config ra log, bài test này sẽ bắt được.
      astraworkJwt: SECRETS.jwt,
      serviceToken: SECRETS.service,
      judgeBackend: 'none',
      fciBaseUrl: 'https://vi-du.invalid/v1',
      fciApiKey: SECRETS.fciKey,
      fciModel: 'model-vi-du',
    },
    { log: (line) => consoleLines.push(String(line)) },
  );
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((r) => server.close(r));
  await fs.rm(tmp, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
});

test('banner khai đủ port/backend/model/workspace/logs và trạng thái token — không khai giá trị', () => {
  const lines = bannerLines(
    {
      port: 8000,
      judgeBackend: 'cli',
      fciModel: 'm',
      fciBaseUrl: 'https://vi-du.invalid/v1',
      fciApiKey: SECRETS.fciKey,
      workspaceDir: 'C:/tmp/ws',
      cliPath: 'C:/x/main.js',
      astraworkJwt: SECRETS.jwt,
      serviceToken: SECRETS.service,
    },
    { runsDir: 'C:/x/runs', devMode: false },
  );
  const text = lines.join('\n');

  assert.match(text, /cổng\s+: 8000/);
  assert.match(text, /backend\s+: cli/);
  assert.match(text, /model\s+:/);
  assert.match(text, /WORKSPACE_DIR : C:\/tmp\/ws/);
  assert.match(text, /logs\s+:/);
  assert.match(text, /results\s+:/);
  assert.match(text, /SERVICE_TOKEN : đã set/);
  assert.match(text, /ASTRAWORK_JWT : đã set/);
  assertNoSecret(text, 'banner');
});

test('banner nói rõ khi token CHƯA set, và cảnh báo chế độ dev', () => {
  const text = bannerLines(
    { port: 1, judgeBackend: 'none', workspaceDir: 'w', cliPath: 'c', fciModel: '', fciBaseUrl: '', fciApiKey: '', astraworkJwt: '', serviceToken: '' },
    { runsDir: 'r', devMode: true },
  ).join('\n');
  assert.match(text, /SERVICE_TOKEN : CHƯA set/);
  assert.match(text, /chế độ dev/);
});

test('run_id của người lạ không lái được đường ghi ra khỏi results/', () => {
  assert.equal(slugifyRunId('../../etc/passwd'), 'etc_passwd');
  assert.equal(slugifyRunId('..'), 'run');
  assert.equal(slugifyRunId('a/b\\c'), 'a_b_c');
  assert.equal(slugifyRunId('', 'job-1234abcd'), 'job-1234abcd');
  assert.equal(slugifyRunId('RUN-1'), 'RUN-1');
  for (const bad of ['../../x', '..\\..\\x', '/abs/x', '.', '...']) {
    assert.ok(!slugifyRunId(bad).includes('/'), `slug còn dấu /: ${bad}`);
    assert.ok(!slugifyRunId(bad).includes('\\'), `slug còn dấu \\: ${bad}`);
    assert.ok(!slugifyRunId(bad).startsWith('.'), `slug còn chấm đầu: ${bad}`);
  }
});

test('createRunLog với enabled:false không đụng đĩa', async () => {
  const dir = path.join(tmp, 'khong-duoc-tao');
  const rl = createRunLog({ runsDir: dir, runId: 'X', jobId: 'j', enabled: false, log: () => {} });
  rl.line('gì đó');
  await rl.saveResult({ report_md: 'x' });
  await rl.flush();
  await assert.rejects(() => fs.stat(dir), 'enabled:false mà vẫn tạo thư mục');
});

test('một job thật: ba file được ghi, và KHÔNG file nào chứa secret', async () => {
  const repoUrl = await makeRepo('repo-observe', {
    'src/login.ts': 'export function login() {\n  return true;\n}\n',
    'README.md': '# demo\n\nman hinh dang nhap\n',
  });

  const res = await post({
    run_id: 'RUN-OBS-1',
    repo_url: repoUrl,
    // Bí mật của request: cả hai phải bị che ở mọi đầu ra.
    repo_token: SECRETS.repo,
    astrawork_token: SECRETS.jwt,
    tickets_md: '## WEB-1 — Them man hinh dang nhap\n\nStatus: Done\n\n## WEB-2 — Xoa tai khoan\n\nStatus: To Do',
  });
  assert.equal(res.status, 202);
  const { job_id } = await res.json();
  const done = await poll(job_id);
  assert.equal(done.status, 'succeeded', done.error);

  const logText = await waitForFile(path.join(runsDir, 'logs', 'RUN-OBS-1.log'));
  const jsonText = await waitForFile(path.join(runsDir, 'results', 'RUN-OBS-1.json'));
  const mdText = await waitForFile(path.join(runsDir, 'results', 'RUN-OBS-1.md'));

  // [1] Bất biến secret — bốn nguồn, bốn chỗ.
  assertNoSecret(logText, 'logs/RUN-OBS-1.log');
  assertNoSecret(jsonText, 'results/RUN-OBS-1.json');
  assertNoSecret(mdText, 'results/RUN-OBS-1.md');
  assertNoSecret(consoleLines.join('\n'), 'console');

  // [2] Nội dung log đủ để debug: dòng request, dòng mỗi ticket, dòng kết thúc.
  assert.match(logText, /POST \/api\/v1\/analyze ← 127\.0\.0\.1/);
  assert.match(logText, /run_id RUN-OBS-1/);
  assert.match(logText, /ticket 2/);
  assert.match(logText, /\[1\/2\] WEB-1 \| \d+ms \| (done|partial|missing)/);
  assert.match(logText, /\[2\/2\] WEB-2 \| \d+ms \| (done|partial|missing)/);
  assert.match(logText, /bằng chứng giữ \d+, loại \d+, kẹp \d+/);
  assert.match(logText, /job xong: succeeded/);
  // Mỗi dòng có dấu thời gian ISO ở đầu — đọc log đêm cần biết lúc nào.
  for (const line of logText.trim().split('\n')) {
    assert.match(line, /^\d{4}-\d{2}-\d{2}T[\d:.]+Z \[RUN-OBS-1\] /);
  }

  // [3] results/*.json là đúng object `result` của hợp đồng, không bọc thêm.
  const saved = JSON.parse(jsonText);
  assert.equal(saved.run_id, 'RUN-OBS-1');
  assert.equal(saved.backend, 'none');
  assert.deepEqual(saved.items.map((i) => i.key), ['WEB-1', 'WEB-2']);
  assert.deepEqual(saved, done.result, 'file trên đĩa phải khớp hệt result trả qua HTTP');
  assert.equal(mdText.trimEnd(), saved.report_md.trimEnd());
});

test('job failed cũng để lại vết, và message trên đĩa không chứa repo_token', async () => {
  const { job_id } = await (
    await post({
      run_id: 'RUN-OBS-FAIL',
      repo_url: 'https://example.invalid/khong-co-that.git',
      repo_token: SECRETS.repo,
      tickets_md: '## K-1 — x',
    })
  ).json();
  const done = await poll(job_id);
  assert.equal(done.status, 'failed');

  const jsonText = await waitForFile(path.join(runsDir, 'results', 'RUN-OBS-FAIL.json'));
  const logText = await waitForFile(path.join(runsDir, 'logs', 'RUN-OBS-FAIL.log'));
  assertNoSecret(jsonText, 'results/RUN-OBS-FAIL.json');
  assertNoSecret(logText, 'logs/RUN-OBS-FAIL.log');

  const saved = JSON.parse(jsonText);
  assert.equal(saved.status, 'failed');
  assert.equal(saved.run_id, 'RUN-OBS-FAIL');
  assert.match(saved.error, /git clone thất bại/);
  assert.match(logText, /job xong: FAILED/);
});

test('không poll lần nào thì file vẫn có — đó là cả lý do ghi xuống đĩa', async () => {
  const repoUrl = await makeRepo('repo-khong-poll', { 'a.txt': 'mot\nhai\n' });
  const res = await post({ run_id: 'RUN-OBS-NOPOLL', repo_url: repoUrl, tickets_md: '## ONE — mot ticket' });
  assert.equal(res.status, 202);
  await res.json(); // nhận job_id rồi vứt đi, như một client vừa rớt

  const jsonText = await waitForFile(path.join(runsDir, 'results', 'RUN-OBS-NOPOLL.json'), { tries: 300 });
  assert.equal(JSON.parse(jsonText).run_id, 'RUN-OBS-NOPOLL');
  await waitForFile(path.join(runsDir, 'results', 'RUN-OBS-NOPOLL.md'));
});

test('run_id thiếu thì rơi về job id, không ghi đè lẫn nhau', async () => {
  const repoUrl = await makeRepo('repo-khong-runid', { 'a.txt': 'mot\n' });
  const { job_id } = await (await post({ repo_url: repoUrl, tickets_md: '## ONE — x' })).json();
  const done = await poll(job_id);
  assert.equal(done.status, 'succeeded', done.error);
  const file = path.join(runsDir, 'results', `job-${job_id.slice(0, 8)}.json`);
  assert.equal(JSON.parse(await waitForFile(file)).run_id, null);
});

test('log ghi NỐI: chạy lại cùng run_id không xoá vết lần trước', async () => {
  const repoUrl = await makeRepo('repo-noi-log', { 'a.txt': 'mot\n' });
  const body = { run_id: 'RUN-OBS-LAP', repo_url: repoUrl, tickets_md: '## ONE — x' };

  await poll((await (await post(body)).json()).job_id);
  const sau1 = await waitForFile(path.join(runsDir, 'logs', 'RUN-OBS-LAP.log'));
  await poll((await (await post(body)).json()).job_id);

  // Lần hai phải dài hơn lần một và vẫn chứa nguyên phần của lần một.
  for (let i = 0; i < 100; i++) {
    const sau2 = await fs.readFile(path.join(runsDir, 'logs', 'RUN-OBS-LAP.log'), 'utf8');
    if (sau2.length > sau1.length) {
      assert.ok(sau2.startsWith(sau1), 'log lần hai phải nối tiếp, không đè lên lần một');
      return;
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.fail('log không dài thêm sau lần chạy thứ hai');
});
