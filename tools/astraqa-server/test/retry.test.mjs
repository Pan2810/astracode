/**
 * Ba thứ thêm vào vì nhà cung cấp có hạn mức, và vì một ticket hỏng không được
 * kéo cả job xuống:
 *
 *   1. `withRetry` — thử lại ĐÚNG 429 và 503, không gì khác.
 *   2. `createLimiter` — trần lượt judge chạy cùng lúc trên cả server.
 *   3. cách ly lỗi theo ticket — ticket hỏng thành một item `missing` có
 *      `reason: judge_failed: …`, job vẫn trả về những ticket đã chấm xong.
 *
 * Không ca nào gọi mạng: `sleep` được đóng thế nên bốn lần chờ 1/2/4/8s trôi
 * qua tức thì, và HTTP được đóng thế bằng một server cục bộ.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import {
  withRetry,
  RetryableHttpError,
  BACKOFF_MS,
  RETRY_STATUSES,
  RETRY_AFTER_CAP_MS,
  parseRetryAfter,
} from '../lib/retry.mjs';
import { createLimiter } from '../lib/limit.mjs';
import { createServer } from '../server.mjs';

const run = promisify(execFile);
const TOKEN = 'service-token-retry-test-0123456789';

// ───────────────────────── withRetry ─────────────────────────

test('chỉ 429 và 503 nằm trong danh sách thử lại', () => {
  assert.deepEqual([...RETRY_STATUSES].sort(), [429, 503]);
  assert.deepEqual(BACKOFF_MS, [1000, 2000, 4000, 8000]);
});

test('429 được thử lại 4 lần, chờ đúng 1s/2s/4s/8s', async () => {
  const waits = [];
  let calls = 0;
  await assert.rejects(
    () =>
      withRetry(
        async () => {
          calls += 1;
          throw new RetryableHttpError(429, 'FCI trả 429: quota');
        },
        { sleep: async (ms) => void waits.push(ms), onRetry: () => {} },
      ),
    /đã thử lại 4 lần \(1s\/2s\/4s\/8s\) mà vẫn 429/,
  );
  assert.deepEqual(waits, [1000, 2000, 4000, 8000]);
  assert.equal(calls, 5, 'một lượt đầu + bốn lần thử lại');
});

test('503 rồi 200: trả kết quả, không ném', async () => {
  let calls = 0;
  const waits = [];
  const out = await withRetry(
    async () => {
      calls += 1;
      if (calls < 3) throw new RetryableHttpError(503, 'FCI trả 503');
      return 'xong';
    },
    { sleep: async (ms) => void waits.push(ms) },
  );
  assert.equal(out, 'xong');
  assert.equal(calls, 3);
  assert.deepEqual(waits, [1000, 2000], 'chỉ chờ đúng số lần đã hỏng');
});

test('4xx khác KHÔNG được thử lại — ném ngay lượt đầu', async () => {
  for (const status of [400, 401, 403, 404, 422, 500]) {
    let calls = 0;
    const waits = [];
    await assert.rejects(
      () =>
        withRetry(
          async () => {
            calls += 1;
            throw new Error(`FCI trả ${status}: thôi khỏi thử lại`);
          },
          { sleep: async (ms) => void waits.push(ms) },
        ),
      new RegExp(`FCI trả ${status}`),
    );
    assert.equal(calls, 1, `${status} không được gọi lại`);
    assert.deepEqual(waits, [], `${status} không được chờ`);
  }
});

test('onRetry báo đủ mã, lần thứ mấy, chờ bao lâu', async () => {
  const seen = [];
  await assert.rejects(() =>
    withRetry(
      async () => {
        throw new RetryableHttpError(503, 'tạm không phục vụ');
      },
      { sleep: async () => {}, onRetry: (info) => seen.push(info) },
    ),
  );
  assert.equal(seen.length, 4);
  assert.deepEqual(seen.map((s) => s.attempt), [1, 2, 3, 4]);
  assert.deepEqual(seen.map((s) => s.waitMs), [1000, 2000, 4000, 8000]);
  assert.ok(seen.every((s) => s.status === 503 && s.of === 4));
  // Không có `Retry-After` thì chờ theo bảng, và nói rõ là theo bảng.
  assert.ok(seen.every((s) => s.source === 'backoff'));
});

test('Retry-After thắng bảng chờ, và header hỏng thì rơi về bảng', async () => {
  const now = Date.parse('2026-09-20T10:00:00Z');
  // Hai dạng RFC cho phép: số giây, và một mốc thời gian.
  assert.equal(parseRetryAfter('30'), 30_000);
  assert.equal(parseRetryAfter('Sun, 20 Sep 2026 10:00:05 GMT', now), 5000);
  // Mốc đã qua, số 0, chữ rác, header vắng — tất cả là "không đọc được".
  assert.equal(parseRetryAfter('Sun, 20 Sep 2026 09:59:00 GMT', now), null);
  assert.equal(parseRetryAfter('0'), null);
  assert.equal(parseRetryAfter('lát nữa nhé'), null);
  assert.equal(parseRetryAfter(null), null);

  const waits = [];
  const seen = [];
  let calls = 0;
  const out = await withRetry(
    async () => {
      calls += 1;
      if (calls === 1) throw new RetryableHttpError(429, 'FCI trả 429: quota', 3000);
      if (calls === 2) throw new RetryableHttpError(429, 'FCI trả 429: quota');
      return 'xong';
    },
    { sleep: async (ms) => void waits.push(ms), onRetry: (info) => seen.push(info) },
  );
  assert.equal(out, 'xong');
  // Lần đầu chờ đúng 3s nhà cung cấp đòi; lần sau không có header nên về bảng.
  assert.deepEqual(waits, [3000, 2000]);
  assert.deepEqual(seen.map((s) => s.source), ['retry-after', 'backoff']);
});

test('Retry-After quá trần thì không chờ theo nó — thà hỏng sớm', async () => {
  const waits = [];
  let calls = 0;
  await withRetry(
    async () => {
      calls += 1;
      // Một giờ: chờ chừng ấy là treo cả job, AstraQA chạy lại còn rẻ hơn.
      if (calls === 1) throw new RetryableHttpError(429, 'FCI trả 429', 3_600_000);
      return 'xong';
    },
    { sleep: async (ms) => void waits.push(ms) },
  );
  assert.ok(RETRY_AFTER_CAP_MS < 3_600_000);
  assert.deepEqual(waits, [1000], 'quá trần thì rơi về bảng chờ');
});

// ───────────────────────── limiter ─────────────────────────

test('limiter giữ đúng trần: không bao giờ quá 2 lượt cùng lúc', async () => {
  const limiter = createLimiter(2);
  let dangChay = 0;
  let dinhNhat = 0;
  const task = async () => {
    dangChay += 1;
    dinhNhat = Math.max(dinhNhat, dangChay);
    await new Promise((r) => setTimeout(r, 20));
    dangChay -= 1;
    return true;
  };
  await Promise.all(Array.from({ length: 10 }, () => limiter.run(task)));
  assert.equal(dinhNhat, 2, `đỉnh phải là 2, đo được ${dinhNhat}`);
  assert.equal(limiter.active, 0, 'phải nhả hết chỗ sau khi xong');
});

test('lượt ném lỗi vẫn nhả chỗ — không rò slot', async () => {
  const limiter = createLimiter(1);
  await assert.rejects(() => limiter.run(async () => { throw new Error('hỏng'); }), /hỏng/);
  assert.equal(limiter.active, 0);
  assert.equal(await limiter.run(async () => 'van chay duoc'), 'van chay duoc');
});

// ───────── cách ly lỗi theo ticket, qua cả đường ống thật ─────────

let tmp;
let fake;
let server;
let base;
/** Mã HTTP mà model giả sẽ trả cho lượt thứ n. */
let plan;
let hits;

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

before(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'astraqa-retry-'));

  // Model giả: trả theo kịch bản `plan`, phần tử thứ n cho lượt thứ n.
  fake = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const step = plan[Math.min(hits, plan.length - 1)];
      hits += 1;
      if (typeof step === 'number') {
        res.writeHead(step, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: `ma gia lap ${step}` } }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: step } }] }));
    });
  });
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));

  server = createServer(
    {
      port: 0,
      workspaceDir: path.join(tmp, 'ws'),
      runsDir: path.join(tmp, 'runs'),
      cliPath: path.join(tmp, 'khong-dung.mjs'),
      astraworkJwt: '',
      serviceToken: TOKEN,
      judgeBackend: 'fci',
      fciBaseUrl: `http://127.0.0.1:${fake.address().port}/v1`,
      fciApiKey: 'key-gia-lap-0123456789',
      fciModel: 'model-gia-lap',
      judgeConcurrency: 2,
    },
    { log: () => {}, persist: false },
  );
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((r) => server.close(r));
  await new Promise((r) => fake.close(r));
  await fs.rm(tmp, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
});

/** Câu trả lời hợp lệ cho một ticket. */
const ok = (key, status = 'done') =>
  '```json\n' +
  JSON.stringify({ items: [{ key, code_status: status, confidence: 0.9, evidence: [], reason: 'matched_by_key' }] }) +
  '\n```';

test('một ticket hỏng: job VẪN trả về các ticket còn lại', async () => {
  const repoUrl = await makeRepo('repo-fail-1', { 'a.txt': 'mot\nhai\n' });
  // Ticket 2 nhận 400 (không thử lại) → hỏng đúng một lượt.
  plan = [ok('T-1'), 400, ok('T-3')];
  hits = 0;

  const done = await poll((await (await post({
    run_id: 'RUN-RETRY-1',
    repo_url: repoUrl,
    tickets_md: '## T-1 — mot\n\n## T-2 — hai\n\n## T-3 — ba',
  })).json()).job_id);

  assert.equal(done.status, 'succeeded', done.error);
  const { items, stats } = done.result;
  assert.deepEqual(items.map((i) => i.key), ['T-1', 'T-2', 'T-3'], 'đủ ba ticket, không ticket nào biến mất');

  assert.equal(items[0].code_status, 'done');
  assert.equal(items[2].code_status, 'done');

  const hong = items[1];
  assert.equal(hong.code_status, 'missing');
  assert.equal(hong.confidence, 0);
  assert.deepEqual(hong.evidence, []);
  assert.match(hong.reason, /^judge_failed: /, `reason phải nói rõ là hỏng: ${hong.reason}`);
  assert.match(hong.reason, /400/);

  assert.equal(stats.judge_calls, 3);
  assert.equal(stats.judge_parsed, 2);
  assert.equal(stats.judge_failed, 1);

  // report_md phải phân biệt "chưa biết" với "đã kiểm tra và thấy thiếu".
  assert.match(done.result.report_md, /1 lượt hỏng/);
  assert.match(done.result.report_md, /KHÔNG chấm được/);
  assert.match(done.result.report_md, /"chưa biết"/);
});

test('429 rồi thành công: đếm vào stats, ticket vẫn chấm được', async () => {
  const repoUrl = await makeRepo('repo-429', { 'a.txt': 'mot\n' });
  plan = [429, ok('T-1')];
  hits = 0;

  const done = await poll(
    (await (await post({ run_id: 'RUN-RETRY-429', repo_url: repoUrl, tickets_md: '## T-1 — mot' })).json()).job_id,
    { tries: 400 },
  );
  assert.equal(done.status, 'succeeded', done.error);
  assert.equal(done.result.items[0].code_status, 'done');
  assert.equal(done.result.stats.hits_429, 1);
  assert.equal(done.result.stats.judge_failed, 0);
  assert.match(done.result.report_md, /1 lần 429/);
});

test('hỏng HẾT thì job failed, KHÔNG trả bảng toàn missing', async () => {
  const repoUrl = await makeRepo('repo-fail-all', { 'a.txt': 'mot\n' });
  plan = [400];
  hits = 0;

  const done = await poll((await (await post({
    run_id: 'RUN-RETRY-ALL',
    repo_url: repoUrl,
    tickets_md: '## T-1 — mot\n\n## T-2 — hai',
  })).json()).job_id);

  assert.equal(done.status, 'failed');
  assert.match(done.error, /Không lượt judge nào thành công \(2\/2 ticket hỏng\)/);
  assert.equal(done.result, undefined);
});

test('/healthz đếm MỖI request HTTP tới model, kể cả lần thử lại', async () => {
  const repoUrl = await makeRepo('repo-dem-luot', { 'a.txt': 'mot\n' });
  const truoc = (await (await fetch(`${base}/healthz`)).json()).model_calls_this_session;

  // Một ticket: 503 hai lần rồi 200 → 3 request thật, dù chỉ một lượt judge.
  plan = [503, 503, ok('T-1')];
  hits = 0;
  const done = await poll((await (await post({ run_id: 'RUN-DEM', repo_url: repoUrl, tickets_md: '## T-1 — mot' })).json()).job_id);
  assert.equal(done.status, 'succeeded', done.error);

  const sau = (await (await fetch(`${base}/healthz`)).json()).model_calls_this_session;
  assert.equal(sau - truoc, 3, 'phải đếm cả hai lần thử lại — mỗi lần là một viên đạn của hạn mức');
  assert.equal(done.result.stats.judge_calls, 1, 'nhưng judge_calls vẫn đếm theo ticket');
  assert.equal(done.result.stats.hits_503, 2);
});

test('JSON xấu của model là lỗi của ticket đó, không nới parser', async () => {
  const repoUrl = await makeRepo('repo-json-xau', { 'a.txt': 'mot\n' });
  // Lượt 1: không có khối json. Lượt 2: khối json nhưng sai schema. Lượt 3: đúng.
  plan = ['toi khong muon tra loi bang json', '```json\n{"items":[{"key":"T-2"}]}\n```', ok('T-3')];
  hits = 0;

  const done = await poll((await (await post({
    run_id: 'RUN-RETRY-JSON',
    repo_url: repoUrl,
    tickets_md: '## T-1 — mot\n\n## T-2 — hai\n\n## T-3 — ba',
  })).json()).job_id);

  assert.equal(done.status, 'succeeded', done.error);
  assert.equal(done.result.stats.judge_calls, 3);
  assert.equal(done.result.stats.judge_parsed, 1);
  assert.equal(done.result.stats.judge_failed, 2);
  assert.match(done.result.items[0].reason, /khối ```json|không trả về khối/i);
  assert.match(done.result.items[1].reason, /sai schema/);
  assert.equal(done.result.items[2].code_status, 'done');
});
