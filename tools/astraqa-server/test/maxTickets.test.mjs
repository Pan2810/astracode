/**
 * `ASTRACODE_MAX_TICKETS` và bộ đếm lượt gọi trên `/healthz`.
 *
 * Lý do tồn tại của trần này: hạn mức của nhà cung cấp tính theo NGÀY (free tier
 * của Google cho 20 lượt/ngày/model), mà một ticket là một lượt. Một buổi demo
 * chỉ cần vài ticket đầu; để nguyên 184 ticket là hết sạch hạn mức ngay lượt đầu.
 *
 * Toàn bộ chạy bằng backend `none`: KHÔNG gọi model, không tốn một lượt nào.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { createServer, readConfig } from '../server.mjs';
import { bannerLines } from '../lib/observe.mjs';

const run = promisify(execFile);
const TOKEN = 'service-token-maxtickets-0123456789';

let tmp;
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

/** Dựng server riêng cho từng ca, vì `maxTickets` nằm ở cấu hình cấp server. */
async function withServer(maxTickets, fn) {
  const s = createServer(
    {
      port: 0,
      workspaceDir: path.join(tmp, `ws-${maxTickets}`),
      runsDir: path.join(tmp, 'runs'),
      cliPath: path.join(tmp, 'khong-dung.mjs'),
      astraworkJwt: '',
      serviceToken: TOKEN,
      judgeBackend: 'none',
      fciBaseUrl: '',
      fciApiKey: '',
      fciModel: '',
      judgeConcurrency: 2,
      maxTickets,
    },
    { log: () => {}, persist: false },
  );
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  try {
    return await fn(`http://127.0.0.1:${s.address().port}`);
  } finally {
    await new Promise((r) => s.close(r));
  }
}

const post = (b, body) =>
  fetch(`${b}/api/v1/analyze`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify(body),
  });

async function poll(b, jobId, { tries = 300 } = {}) {
  for (let i = 0; i < tries; i++) {
    const res = await fetch(`${b}/api/v1/analyze/${jobId}`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    const json = await res.json();
    if (json.status === 'succeeded' || json.status === 'failed') return json;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('job không kết thúc trong thời gian chờ');
}

const FIVE = ['## T-1 — mot', '## T-2 — hai', '## T-3 — ba', '## T-4 — bon', '## T-5 — nam'].join('\n\n');

before(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'astraqa-maxtickets-'));
  server = null;
});

after(async () => {
  await fs.rm(tmp, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
});

test('mặc định 0 = không giới hạn: cả 5 ticket đều được chấm', async () => {
  const repoUrl = await makeRepo('repo-khong-tran', { 'a.txt': 'mot\nhai\n' });
  await withServer(0, async (b) => {
    const done = await poll(b, (await (await post(b, { run_id: 'MT-0', repo_url: repoUrl, tickets_md: FIVE })).json()).job_id);
    assert.equal(done.status, 'succeeded', done.error);
    const { items, stats } = done.result;
    assert.equal(items.length, 5);
    assert.equal(stats.judge_calls, 5);
    assert.equal(stats.tickets_skipped, 0);
    assert.equal(stats.max_tickets, 0);
    assert.ok(!items.some((i) => i.reason === 'skipped_quota_limit'));
  });
});

test('MAX_TICKETS=3: chấm 3 ticket đầu, 2 ticket sau là skipped_quota_limit', async () => {
  const repoUrl = await makeRepo('repo-tran-3', { 'a.txt': 'mot\nhai\n' });
  await withServer(3, async (b) => {
    const done = await poll(b, (await (await post(b, { run_id: 'MT-3', repo_url: repoUrl, tickets_md: FIVE })).json()).job_id);
    assert.equal(done.status, 'succeeded', done.error);
    const { items, stats } = done.result;

    // [1] Không ticket nào biến mất khỏi báo cáo.
    assert.deepEqual(items.map((i) => i.key), ['T-1', 'T-2', 'T-3', 'T-4', 'T-5']);

    // [2] Ðúng 3 lượt judge — đây là cả mục đích của biến này.
    assert.equal(stats.judge_calls, 3, 'chỉ được tiêu đúng 3 lượt');
    assert.equal(stats.judge_parsed, 3);
    assert.equal(stats.tickets_total, 5);
    assert.equal(stats.tickets_skipped, 2);
    assert.equal(stats.max_tickets, 3);

    // [3] Hai ticket cuối mang đúng dấu hiệu đã thoả thuận.
    for (const it of items.slice(3)) {
      assert.equal(it.code_status, 'missing');
      assert.equal(it.confidence, 0);
      assert.deepEqual(it.evidence, []);
      assert.equal(it.reason, 'skipped_quota_limit');
    }
    // [4] Ba ticket đầu KHÔNG mang dấu hiệu đó.
    for (const it of items.slice(0, 3)) {
      assert.notEqual(it.reason, 'skipped_quota_limit');
    }

    // [5] report_md phải nói rõ "chưa xét" chứ không phải "đã kiểm tra và thấy thiếu".
    assert.match(done.result.report_md, /bỏ qua 2\/5 ticket/);
    assert.match(done.result.report_md, /BỎ QUA/);
    assert.match(done.result.report_md, /"chưa xét"/);
  });
});

test('MAX_TICKETS lớn hơn số ticket thì không bỏ qua gì', async () => {
  const repoUrl = await makeRepo('repo-tran-lon', { 'a.txt': 'mot\n' });
  await withServer(99, async (b) => {
    const done = await poll(b, (await (await post(b, { run_id: 'MT-99', repo_url: repoUrl, tickets_md: FIVE })).json()).job_id);
    assert.equal(done.status, 'succeeded', done.error);
    assert.equal(done.result.stats.tickets_skipped, 0);
    assert.equal(done.result.stats.judge_calls, 5);
  });
});

test('MAX_TICKETS=1: đúng một lượt, bốn ticket còn lại bỏ qua', async () => {
  const repoUrl = await makeRepo('repo-tran-1', { 'a.txt': 'mot\n' });
  await withServer(1, async (b) => {
    const done = await poll(b, (await (await post(b, { run_id: 'MT-1', repo_url: repoUrl, tickets_md: FIVE })).json()).job_id);
    assert.equal(done.status, 'succeeded', done.error);
    assert.equal(done.result.stats.judge_calls, 1);
    assert.equal(done.result.stats.tickets_skipped, 4);
    assert.equal(done.result.items.filter((i) => i.reason === 'skipped_quota_limit').length, 4);
  });
});

test('readConfig đọc ASTRACODE_MAX_TICKETS, và giá trị rác rơi về 0', () => {
  assert.equal(readConfig({ ASTRACODE_MAX_TICKETS: '5' }).maxTickets, 5);
  assert.equal(readConfig({}).maxTickets, 0, 'mặc định phải là 0 = không giới hạn');
  for (const rac of ['', 'abc', '-3', '0']) {
    assert.equal(readConfig({ ASTRACODE_MAX_TICKETS: rac }).maxTickets, 0, `"${rac}" phải rơi về 0`);
  }
});

test('/healthz khai model, MAX_TICKETS và số lượt gọi của phiên', async () => {
  const repoUrl = await makeRepo('repo-healthz', { 'a.txt': 'mot\n' });
  await withServer(2, async (b) => {
    const truoc = await (await fetch(`${b}/healthz`)).json();
    assert.equal(truoc.status, 'ok');
    assert.equal(truoc.backend, 'none');
    assert.equal(truoc.max_tickets, 2);
    assert.equal(truoc.judge_concurrency, 2);
    assert.equal(truoc.model, null, 'backend none thì không có model');
    assert.equal(truoc.model_calls_this_session, 0);
    assert.equal(truoc.jobs_this_session, 0);

    await poll(b, (await (await post(b, { run_id: 'MT-HZ', repo_url: repoUrl, tickets_md: FIVE })).json()).job_id);

    const sau = await (await fetch(`${b}/healthz`)).json();
    assert.equal(sau.jobs_this_session, 1, 'đếm job đã nhận');
    // backend `none` không gọi model lần nào — bộ đếm phải đứng yên.
    assert.equal(sau.model_calls_this_session, 0, 'backend none không được tính lượt gọi model nào');

    // Không lộ key ở bất kỳ đâu trong healthz.
    assert.ok(!JSON.stringify(sau).includes('FPT_API_KEY'));
    assert.ok(!Object.keys(sau).some((k) => /key|token|secret/i.test(k)), `healthz có field đáng ngờ: ${Object.keys(sau)}`);
  });
});

test('/healthz của backend fci khai đúng tên model, không khai key', async () => {
  const s = createServer(
    {
      port: 0,
      workspaceDir: path.join(tmp, 'ws-fci'),
      runsDir: path.join(tmp, 'runs'),
      cliPath: 'x',
      astraworkJwt: '',
      serviceToken: TOKEN,
      judgeBackend: 'fci',
      fciBaseUrl: 'https://vi-du.invalid/v1',
      fciApiKey: 'sk-KHONG-DUOC-LO-0123456789',
      fciModel: 'gemini-3.5-flash',
      judgeConcurrency: 2,
      maxTickets: 4,
    },
    { log: () => {}, persist: false },
  );
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  try {
    const h = await (await fetch(`http://127.0.0.1:${s.address().port}/healthz`)).json();
    assert.equal(h.backend, 'fci');
    assert.equal(h.model, 'gemini-3.5-flash');
    assert.equal(h.max_tickets, 4);
    assert.equal(h.fci_configured, true);
    assert.equal(h.model_calls_this_session, 0);
    assert.ok(!JSON.stringify(h).includes('sk-KHONG-DUOC-LO-0123456789'), 'healthz lộ key');
  } finally {
    await new Promise((r) => s.close(r));
  }
});

test('banner khai MAX_TICKETS ở cả hai trạng thái', () => {
  const co = bannerLines(
    { port: 1, judgeBackend: 'fci', fciModel: 'm', fciBaseUrl: 'u', fciApiKey: 'k', workspaceDir: 'w', cliPath: 'c', astraworkJwt: '', serviceToken: 's', judgeConcurrency: 2, maxTickets: 3 },
    { runsDir: 'r', devMode: false },
  ).join('\n');
  assert.match(co, /MAX_TICKETS   : 3 ticket đầu mỗi job/);

  const khong = bannerLines(
    { port: 1, judgeBackend: 'none', fciModel: '', fciBaseUrl: '', fciApiKey: '', workspaceDir: 'w', cliPath: 'c', astraworkJwt: '', serviceToken: 's', judgeConcurrency: 2, maxTickets: 0 },
    { runsDir: 'r', devMode: false },
  ).join('\n');
  assert.match(khong, /MAX_TICKETS   : 0 \(không giới hạn\)/);
});
