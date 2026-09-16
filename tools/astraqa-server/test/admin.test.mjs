/**
 * Trang admin chỉ đọc và bốn route nuôi nó.
 *
 * Bốn thứ được canh chặt:
 *   1. Job đang chạy hiện đúng `done/total` và tên ticket đang xử lý.
 *   2. Job xong tải được cả ba file, đúng nội dung và đúng Content-Type.
 *   3. `run_id` bịa → 404.
 *   4. `run_id` có `../` → KHÔNG thoát khỏi `results/` `logs/`.
 *
 * Cộng thêm: trang không lộ token, và không route nào ở đây sửa được gì (chỉ GET).
 *
 * Chạy offline bằng backend `none` — KHÔNG gọi model.
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
const TOKEN = 'service-token-admin-test-0123456789';

let tmp;
let runsDir;
let server;
let base;

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
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify(body),
  });

async function poll(jobId, { tries = 400 } = {}) {
  for (let i = 0; i < tries; i++) {
    const res = await fetch(`${base}/api/v1/analyze/${jobId}`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    const json = await res.json();
    if (json.status === 'succeeded' || json.status === 'failed') return json;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('job không kết thúc trong thời gian chờ');
}

const jobsApi = () => fetch(`${base}/api/v1/jobs`).then((r) => r.json());
const findRun = (list, runId) => list.jobs.find((j) => j.run_id === runId);

before(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'astraqa-admin-'));
  runsDir = path.join(tmp, 'runs');
  server = createServer(
    {
      port: 0,
      workspaceDir: path.join(tmp, 'ws'),
      runsDir,
      cliPath: path.join(tmp, 'khong-dung.mjs'),
      astraworkJwt: '',
      serviceToken: TOKEN,
      judgeBackend: 'none',
      fciBaseUrl: '',
      fciApiKey: '',
      fciModel: '',
      judgeConcurrency: 2,
      maxTickets: 0,
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

test('GET /admin trả HTML tự chứa: không CDN, không lộ token', async () => {
  const res = await fetch(`${base}/admin`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);
  const html = await res.text();

  assert.match(html, /<style>/, 'CSS phải inline');
  assert.match(html, /<script>/, 'JS phải inline');
  // Tự chứa: không kéo gì từ ngoài về.
  assert.ok(!/src\s*=\s*["']https?:/i.test(html), 'không được nạp script từ mạng');
  assert.ok(!/href\s*=\s*["']https?:/i.test(html), 'không được nạp stylesheet từ mạng');
  assert.ok(!html.includes(TOKEN), 'trang lộ service token');
  assert.match(html, /setInterval\(tick, 2000\)/, 'phải tự làm mới mỗi 2 giây');
});

test('trang admin chỉ đọc: POST/DELETE bị từ chối, không có nút dừng', async () => {
  for (const method of ['POST', 'DELETE', 'PUT']) {
    const res = await fetch(`${base}/api/v1/jobs`, { method, headers: { Authorization: `Bearer ${TOKEN}` } });
    assert.equal(res.status, 405, `${method} phải bị chặn`);
  }
  const html = await (await fetch(`${base}/admin`)).text();
  for (const tu of ['/cancel', '/stop', '/abort']) {
    assert.ok(!html.includes(tu), `trang không được có đường ${tu}`);
  }
});

test('job đang chạy hiện đúng tiến độ done/total và ticket đang xử lý', async () => {
  const repoUrl = await makeRepo('repo-tiendo', { 'a.txt': 'mot\nhai\n' });
  const tickets = Array.from({ length: 6 }, (_, i) => `## RUN-${i + 1} — viec ${i + 1}`).join('\n\n');

  const { job_id } = await (await post({ run_id: 'ADMIN-TIENDO', repo_url: repoUrl, tickets_md: tickets })).json();

  // Bắt trang thái giữa chừng: đọc /api/v1/jobs liên tục cho tới khi thấy `running`.
  let batDuoc = null;
  for (let i = 0; i < 400; i++) {
    const row = findRun(await jobsApi(), 'ADMIN-TIENDO');
    if (row && row.status === 'running') {
      batDuoc = row;
      if (row.progress.done > 0 && row.current) break;
    }
    if (row && row.status === 'succeeded') break;
    await new Promise((r) => setTimeout(r, 10));
  }

  assert.ok(batDuoc, 'phải thấy job ở trạng thái running ít nhất một lần');
  assert.equal(batDuoc.progress.total, 6, 'total phải là số ticket thật');
  assert.ok(batDuoc.progress.done >= 0 && batDuoc.progress.done <= 6);
  assert.equal(batDuoc.repo, repoUrl, 'phải hiện repo của job');
  assert.equal(batDuoc.backend, 'none');
  assert.ok(batDuoc.started_at, 'phải có thời điểm bắt đầu');

  const done = await poll(job_id);
  assert.equal(done.status, 'succeeded', done.error);

  const sau = findRun(await jobsApi(), 'ADMIN-TIENDO');
  assert.equal(sau.status, 'succeeded');
  assert.equal(sau.progress.done, 6);
  assert.equal(sau.current, null, 'xong rồi thì không còn ticket nào đang xử lý');
  assert.ok(sau.finished_at, 'phải có thời điểm kết thúc');
  assert.equal(sau.stats.judge_calls, 6);
});

test('job xong: tải được result.json, report.md và log', async () => {
  const repoUrl = await makeRepo('repo-taive', { 'a.txt': 'mot\nhai\n' });
  const { job_id } = await (await post({ run_id: 'ADMIN-TAI', repo_url: repoUrl, tickets_md: '## T-1 — mot' })).json();
  const done = await poll(job_id);
  assert.equal(done.status, 'succeeded', done.error);

  // File được ghi qua hàng đợi nên có thể trễ vài ms sau khi job báo xong.
  let resultRes;
  for (let i = 0; i < 100; i++) {
    resultRes = await fetch(`${base}/api/v1/jobs/ADMIN-TAI/result`);
    if (resultRes.status === 200) break;
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.equal(resultRes.status, 200);
  assert.match(resultRes.headers.get('content-type'), /application\/json/);
  const saved = JSON.parse(await resultRes.text());
  assert.equal(saved.run_id, 'ADMIN-TAI');
  assert.deepEqual(saved, done.result, 'file tải về phải khớp hệt result trả qua API cũ');

  const reportRes = await fetch(`${base}/api/v1/jobs/ADMIN-TAI/report`);
  assert.equal(reportRes.status, 200);
  assert.match(reportRes.headers.get('content-type'), /text\/markdown/);
  assert.match(await reportRes.text(), /# AstraCode — báo cáo đối chiếu code/);

  const logRes = await fetch(`${base}/api/v1/jobs/ADMIN-TAI/log`);
  assert.equal(logRes.status, 200);
  assert.match(logRes.headers.get('content-type'), /text\/plain/);
  const logText = await logRes.text();
  assert.match(logText, /\[ADMIN-TAI\] POST \/api\/v1\/analyze/);
  assert.match(logText, /job xong: succeeded/);
  assert.ok(!logText.includes(TOKEN), 'log tải về lộ service token');
});

test('job failed: /api/v1/jobs hiện message lỗi, và message không chứa repo_token', async () => {
  const secret = 'ghp_ADMINTESTKHONGDUOCLORA0123456789';
  const { job_id } = await (
    await post({
      run_id: 'ADMIN-HONG',
      repo_url: 'https://example.invalid/khong-co-that.git',
      repo_token: secret,
      tickets_md: '## T-1 — mot',
    })
  ).json();
  const done = await poll(job_id);
  assert.equal(done.status, 'failed');

  const row = findRun(await jobsApi(), 'ADMIN-HONG');
  assert.equal(row.status, 'failed');
  assert.match(row.error, /git clone thất bại/);
  assert.ok(!row.error.includes(secret), 'trang lộ repo_token');
});

test('run_id bịa → 404 cho cả ba đường tải', async () => {
  for (const kind of ['result', 'report', 'log']) {
    const res = await fetch(`${base}/api/v1/jobs/KHONG-CO-THAT-9999/${kind}`);
    assert.equal(res.status, 404, `${kind} phải trả 404`);
    const body = await res.json();
    assert.match(body.error, /không có|không hợp lệ/);
  }
});

test('run_id có ../ KHÔNG thoát ra khỏi thư mục results/ và logs/', async () => {
  // Một file bí mật nằm NGOÀI runsDir — nếu đường dẫn thoát được thì nó sẽ lộ.
  const beo = path.join(tmp, 'bi-mat.json');
  await fs.writeFile(beo, JSON.stringify({ khong_duoc_doc: 'NOI_DUNG_BI_MAT_KHONG_DUOC_LO' }), 'utf8');
  await fs.writeFile(path.join(tmp, 'runs', 'bi-mat.json'), 'khong phai cho nay', 'utf8').catch(() => {});

  const doc = [
    '../bi-mat',
    '../../bi-mat',
    '..%2F..%2Fbi-mat',
    '....//bi-mat',
    '/etc/passwd',
    '..\\..\\bi-mat',
    '.',
    '..',
  ];

  for (const xau of doc) {
    for (const kind of ['result', 'report', 'log']) {
      const res = await fetch(`${base}/api/v1/jobs/${encodeURIComponent(xau)}/${kind}`);
      // Khẳng định đúng là "không bao giờ trả file", không phải "đúng mã 404":
      // một chuỗi như `..` bị chuẩn hoá ngay trên URL (`/api/v1/jobs/../result`
      // → `/api/v1/result`) nên nó không còn là route admin nữa và rơi xuống
      // cổng token cũ, trả 401. Cả hai đường đều không chạm tới đĩa.
      assert.ok(res.status !== 200, `"${xau}"/${kind} phải bị từ chối, nhận ${res.status}`);
      const text = await res.text();
      assert.ok(!text.includes('NOI_DUNG_BI_MAT_KHONG_DUOC_LO'), `"${xau}" đọc được file ngoài thư mục!`);
    }
  }

  // Ðường đi thật sự nguy hiểm là chuỗi KHÔNG bị URL chuẩn hoá: `%2F` giữ nguyên
  // trong pathname rồi mới được decode trong handler. Nó phải bị slugify chặn.
  for (const xau of ['%2F..%2F..%2Fbi-mat', '..%2Fbi-mat', '%2Fetc%2Fpasswd']) {
    for (const kind of ['result', 'report', 'log']) {
      const res = await fetch(`${base}/api/v1/jobs/${xau}/${kind}`);
      assert.equal(res.status, 404, `"${xau}"/${kind} phải 404, nhận ${res.status}`);
      assert.ok(!(await res.text()).includes('NOI_DUNG_BI_MAT_KHONG_DUOC_LO'), `"${xau}" đọc được file ngoài thư mục!`);
    }
  }

  // File thật vẫn đọc được — bài test trên không phải chặn nhầm tất cả.
  assert.ok((await fetch(`${base}/api/v1/jobs/ADMIN-TAI/result`)).ok, 'run_id hợp lệ vẫn phải tải được');
});

test('/api/v1/jobs khai backend, model và bộ đếm — không khai key', async () => {
  const data = await jobsApi();
  assert.equal(data.server.backend, 'none');
  assert.equal(data.server.model, null);
  assert.equal(typeof data.server.model_calls_this_session, 'number');
  assert.ok(data.server.jobs_this_session >= 1);
  const raw = JSON.stringify(data);
  assert.ok(!raw.includes(TOKEN), '/api/v1/jobs lộ service token');
  assert.ok(!Object.keys(data.server).some((k) => /key|token|secret/i.test(k)), `field đáng ngờ: ${Object.keys(data.server)}`);
});

test('gọi từ máy khác (không loopback) thì phải có token', async () => {
  // Giả bên gọi ở xa bằng cách thay `remoteAddress` của socket trước khi route chạy.
  const s = createServer(
    {
      port: 0,
      workspaceDir: path.join(tmp, 'ws-xa'),
      runsDir,
      cliPath: 'x',
      astraworkJwt: '',
      serviceToken: TOKEN,
      judgeBackend: 'none',
      fciBaseUrl: '',
      fciApiKey: '',
      fciModel: '',
      judgeConcurrency: 2,
      maxTickets: 0,
    },
    { log: () => {}, persist: false },
  );
  s.on('connection', (socket) => {
    // Chỉ đổi thứ `isLoopback()` đọc; kết nối thật vẫn là loopback.
    Object.defineProperty(socket, 'remoteAddress', { value: '203.0.113.7', configurable: true });
  });
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const b = `http://127.0.0.1:${s.address().port}`;
  try {
    assert.equal((await fetch(`${b}/admin`)).status, 401, 'không token từ xa phải 401');
    assert.equal((await fetch(`${b}/api/v1/jobs`)).status, 401);
    assert.equal(
      (await fetch(`${b}/admin`, { headers: { Authorization: `Bearer ${TOKEN}` } })).status,
      200,
      'có token thì vẫn vào được từ xa',
    );
  } finally {
    await new Promise((r) => s.close(r));
  }
});

test('route cũ không đổi: /healthz và /api/v1/analyze vẫn y như trước', async () => {
  const h = await (await fetch(`${base}/healthz`)).json();
  assert.equal(h.status, 'ok');
  // Cổng token của route cũ KHÔNG được nới theo loopback.
  const res = await fetch(`${base}/api/v1/analyze`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ repo_url: 'x', tickets_md: 'y' }),
  });
  assert.equal(res.status, 401, 'POST /api/v1/analyze không token vẫn phải 401 dù gọi từ loopback');
});
