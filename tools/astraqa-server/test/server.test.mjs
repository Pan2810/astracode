/**
 * Đường ống đầy đủ, chạy offline: repo git thật dựng trong thư mục tạm, CLI
 * đóng thế bằng `test/fakeCli.mjs`. Không cần mạng, không cần gateway, không
 * tốn token nào — nhưng đi qua đúng mọi bước mà bản chạy thật đi.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createServer } from '../server.mjs';

const run = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const TOKEN = 'service-token-dung-cho-test-0123456789';

let tmp;
let server;
let base;
const fixture = (n) => fs.readFile(path.join(here, '..', 'fixtures', n), 'utf8');

/** Một repo git thật, nội dung tuỳ ý — server không được biết gì về nó. */
async function makeRepo(name, files) {
  const dir = path.join(tmp, name);
  await fs.mkdir(dir, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
    await fs.writeFile(path.join(dir, rel), content);
  }
  await run('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  await run('git', ['add', '-A'], { cwd: dir });
  await run(
    'git',
    ['-c', 'user.email=t@example.invalid', '-c', 'user.name=t', 'commit', '-q', '-m', 'init'],
    { cwd: dir },
  );
  return pathToFileURL(dir).href;
}

async function post(body, token = TOKEN) {
  return fetch(`${base}/api/v1/analyze`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
}

async function poll(jobId, { tries = 200 } = {}) {
  for (let i = 0; i < tries; i++) {
    const res = await fetch(`${base}/api/v1/analyze/${jobId}`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    const json = await res.json();
    if (json.status === 'succeeded' || json.status === 'failed') return json;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('job không kết thúc trong thời gian chờ');
}

async function pollJudge(jobId) {
  for (let i = 0; i < 200; i++) {
    const res = await fetch(`${base}/api/v1/judge/${jobId}`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    const json = await res.json();
    if (json.status === 'succeeded' || json.status === 'failed') return json;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('judge job did not finish');
}

before(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'astraqa-test-'));
  server = createServer(
    {
      port: 0,
      workspaceDir: path.join(tmp, 'ws'),
      runsDir: path.join(tmp, 'runs'),
      cliPath: path.join(here, 'fakeCli.mjs'),
      astraworkJwt: '',
      serviceToken: TOKEN,
      // Test chạy offline nên dùng backend `cli` với CLI đóng thế; backend `fci`
      // được phủ riêng ở fci.test.mjs (không gọi mạng).
      judgeBackend: 'cli',
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

test('GET /healthz → 200 ok và khai rõ backend đang chạy', async () => {
  const res = await fetch(`${base}/healthz`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, 'ok');
  assert.equal(body.backend, 'cli');
  assert.ok(!JSON.stringify(body).includes('FPT_API_KEY'), 'healthz không được lộ key');
});

test('result mang theo backend đã dùng', async () => {
  const repoUrl = await makeRepo('repo-backend', { 'x.txt': 'mot\nhai\n' });
  const done = await poll((await (await post({ repo_url: repoUrl, tickets_md: '## K-BE — x' })).json()).job_id);
  assert.equal(done.status, 'succeeded', done.error);
  assert.equal(done.result.backend, 'cli');
  assert.equal(done.result.stats.judge_calls, 1);
  assert.equal(done.result.stats.judge_parsed, 1);
});

test('judge endpoint uses CLI and reads the pinned source SHA', async () => {
  const repoUrl = await makeRepo('repo-judge-pin', { 'src/old.ts': 'export const version = 1;\n' });
  const dir = fileURLToPath(repoUrl);
  const { stdout } = await run('git', ['rev-parse', 'HEAD'], { cwd: dir });
  const pinned = stdout.trim();
  await fs.writeFile(path.join(dir, 'src/old.ts'), 'export const version = 2;\n');
  await run('git', ['add', '-A'], { cwd: dir });
  await run('git', ['-c', 'user.email=t@example.invalid', '-c', 'user.name=t', 'commit', '-q', '-m', 'second'], { cwd: dir });
  const res = await fetch(`${base}/api/v1/judge`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ repo_url: repoUrl, ref: pinned, verdict_guide: { MATCH: 'signals agree' },
      tickets: [{ key: 'K-JUDGE', summary: 'old version', evidence: [{ path: 'src/old.ts', lines: '1' }] }] }),
  });
  assert.equal(res.status, 202);
  const done = await pollJudge((await res.json()).job_id);
  assert.equal(done.status, 'succeeded', done.error);
  assert.equal(done.source_revision, pinned);
  assert.equal(done.results[0].verdict, 'MATCH');
  assert.equal(done.results[0].tier, 'ai');
});

test('CLI judge supports selection and caches verdicts without dropping acceptance criteria', async () => {
  const repoUrl = await makeRepo('repo-cli-cache', { 'src/order.ts': 'export const orders = [];\n' });
  const body = {
    repo_url: repoUrl, verdict_guide: { MATCH: 'signals agree' },
    mode: 'selected', skip_above: 0.9, tenant: 'cli-merge',
    tickets: [
      { key: 'K-SKIP', grep_confidence: 0.95, grep_verdict: 'MATCH' },
      { key: 'K-CLI', summary: 'Create order', acceptance_criteria: ['Returns 201'],
        evidence: [{ path: 'src/order.ts', lines: '1' }] },
    ],
  };
  const judge = async () => {
    const res = await fetch(`${base}/api/v1/judge`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify(body),
    });
    assert.equal(res.status, 202);
    const done = await pollJudge((await res.json()).job_id);
    assert.equal(done.status, 'succeeded', done.error);
    return done;
  };
  const first = await judge();
  assert.equal(first.progress.model_calls, 1);
  assert.equal(first.progress.skipped, 1);
  assert.equal(first.results.find((row) => row.key === 'K-CLI').tier, 'ai');
  const cached = await judge();
  assert.equal(cached.progress.model_calls, 0);
  assert.equal(cached.progress.cached, 1);
  body.tickets[1].acceptance_criteria = ['Returns 400'];
  const changed = await judge();
  assert.equal(changed.progress.model_calls, 1);
  assert.equal(changed.progress.cached, 0);
});

test('structured tickets combine subset filtering with unassessed acceptance criteria', async () => {
  const repoUrl = await makeRepo('repo-structured-subset', { 'src/order.ts': 'export const orders = [];\n' });
  const res = await post({ repo_url: repoUrl, tickets_schema_version: 1, tickets_subset: ['A-1'],
    tickets: [
      { key: 'A-1', summary: 'Create order', acceptance_criteria: ['Returns 201'] },
      { key: 'B-1', summary: 'Reject order', acceptance_criteria: ['Returns 400'] },
    ],
  });
  assert.equal(res.status, 202);
  const done = await poll((await res.json()).job_id);
  assert.equal(done.status, 'succeeded', done.error);
  assert.equal(done.result.stats.judge_calls, 1);
  const skipped = done.result.items.find((row) => row.key === 'B-1');
  assert.equal(skipped.reason, 'not_in_subset');
  assert.equal(skipped.assessment.state, 'not_assessed');
  assert.equal(skipped.mapping_state, 'unlinked');
});

test('structured tickets run through the server with distinct keys and AC', async () => {
  const repoUrl = await makeRepo('repo-structured', { 'src/orders.ts': 'export const orders = [];\n' });
  const res = await post({
    repo_url: repoUrl,
    tickets_schema_version: 1,
    tickets: [
      { key: 'A-1', summary: 'Create order', status: 'done',
        description: 'POST /orders creates an order.\n### acceptance criteria is text here.',
        acceptance_criteria: ['Returns 201', 'Writes one order'] },
      { key: 'B-1', summary: 'Reject invalid order', status: 'in_progress',
        description: 'Reject an empty customer ID.', acceptance_criteria: ['Returns 400'] },
    ],
  });
  assert.equal(res.status, 202);
  const done = await poll((await res.json()).job_id);
  assert.equal(done.status, 'succeeded', done.error);
  assert.deepEqual(done.result.items.map((item) => item.key), ['A-1', 'B-1']);
  assert.equal(done.result.items[0].assessment.state, 'partial');
  assert.deepEqual(done.result.items[0].assessment.criteria.map((criterion) => criterion.status), ['satisfied', 'unknown']);
  assert.equal(done.result.items[0].assessment.test_status, 'not_run');
  assert.equal(done.result.items[0].mapping_state, 'weak_link');
  assert.equal(done.result.items[1].assessment.state, 'not_assessed');
  assert.equal(done.result.stats.judge_calls, 2);
  assert.match(done.result.source_revision, /^[a-f0-9]{40}$/);
});

test('structured tickets reject malformed input before cloning', async () => {
  const common = { repo_url: 'https://example.invalid/repo.git', tickets_schema_version: 1 };
  const ticket = { key: 'A-1', summary: 'Create order', description: 'details', acceptance_criteria: ['Returns 201'] };
  assert.equal((await post({ ...common, tickets: [ticket, ticket] })).status, 400);
  assert.equal((await post({ ...common, tickets: [{ ...ticket, key: '' }] })).status, 400);
});

test('thiếu/sai token → 401', async () => {
  assert.equal((await post({ repo_url: 'x', tickets_md: 'y' }, '')).status, 401);
  assert.equal((await post({ repo_url: 'x', tickets_md: 'y' }, 'sai-token-nhung-dung-do-dai-012345678')).status, 401);
});

test('thiếu field bắt buộc → 400 và nói rõ thiếu gì', async () => {
  const res = await post({ ref: 'main' });
  assert.equal(res.status, 400);
  const { error } = await res.json();
  assert.match(error, /repo_url/);
  assert.match(error, /tickets_md/);
});

test('job_id lạ → 404', async () => {
  const res = await fetch(`${base}/api/v1/analyze/khong-co-that`, { headers: { Authorization: `Bearer ${TOKEN}` } });
  assert.equal(res.status, 404);
});

test('repo A + tickets heading: chạy hết, bằng chứng bịa bị loại', async () => {
  const repoUrl = await makeRepo('repo-a', {
    'src/login.ts': 'export function login() {\n  return true;\n}\n',
    'README.md': '# repo a\n\nmot hai ba\n',
  });
  const res = await post({ run_id: 'RUN-A', repo_url: repoUrl, tickets_md: await fixture('tickets-heading.md') });
  assert.equal(res.status, 202);
  const { job_id, status } = await res.json();
  assert.equal(status, 'queued');

  const done = await poll(job_id);
  assert.equal(done.status, 'succeeded', done.error);
  const { result } = done;

  assert.equal(result.run_id, 'RUN-A');
  assert.match(result.generated_at, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(
    result.items.map((i) => i.key),
    ['WEB-1001', '1024', 'EXP_7'],
  );
  for (const item of result.items) {
    assert.ok(['done', 'partial', 'missing'].includes(item.code_status));
    assert.ok(item.confidence >= 0 && item.confidence <= 1);
    for (const ev of item.evidence) {
      assert.ok(['src/login.ts', 'README.md'].includes(ev.path), `đường dẫn lạ: ${ev.path}`);
      assert.match(ev.lines, /^\d+(-\d+)?$/);
    }
    assert.ok(!item.evidence.some((e) => e.path.startsWith('khong/ton/tai')), 'đường dẫn bịa phải bị loại');
  }
  assert.match(result.report_md, /WEB-1001/);
  assert.match(result.report_md, /EXP_7/);
});

test('repo B + tickets bảng: cùng server, không có gì set cứng theo repo A', async () => {
  const repoUrl = await makeRepo('repo-b', {
    'app/main.py': 'def upload(f):\n    return None\n',
    'docs/guide.md': 'huong dan\n',
  });
  const done = await poll(
    (await (await post({ run_id: 'RUN-B', repo_url: repoUrl, tickets_md: await fixture('tickets-table.md') })).json())
      .job_id,
  );
  assert.equal(done.status, 'succeeded', done.error);
  assert.deepEqual(
    done.result.items.map((i) => i.key),
    ['#77', 'ABC_42', 'ops.deploy.v2'],
  );
  for (const ev of done.result.items.flatMap((i) => i.evidence)) {
    assert.ok(['app/main.py', 'docs/guide.md'].includes(ev.path), `đường dẫn lạ: ${ev.path}`);
  }
});

test('exclude_globs và max_files_per_ticket được tôn trọng', async () => {
  const repoUrl = await makeRepo('repo-c', {
    'a.txt': 'mot\nhai\n',
    'dist/built.js': 'console.log(1)\n',
  });
  const done = await poll(
    (
      await (
        await post({
          run_id: 'RUN-C',
          repo_url: repoUrl,
          tickets_md: '## ONE — chỉ một ticket',
          options: { max_files_per_ticket: 1, exclude_globs: ['**/dist/**'] },
        })
      ).json()
    ).job_id,
  );
  assert.equal(done.status, 'succeeded', done.error);
  const ev = done.result.items[0].evidence;
  assert.ok(ev.length <= 1, 'phải cắt theo max_files_per_ticket');
  assert.ok(!ev.some((e) => e.path.startsWith('dist/')), 'exclude_globs phải cắt dist/');
});

test('tickets_md không dò được → failed, KHÔNG phải items rỗng', async () => {
  const repoUrl = await makeRepo('repo-d', { 'x.txt': 'x\n' });
  const done = await poll((await (await post({ repo_url: repoUrl, tickets_md: 'chỉ là văn xuôi' })).json()).job_id);
  assert.equal(done.status, 'failed');
  assert.match(done.error, /không dò ra ticket nào/);
  assert.equal(done.result, undefined);
});

test('clone hỏng → failed, và message KHÔNG chứa repo_token', async () => {
  const secret = 'ghp_TESTTOKENKHONGDUOCLORA0123456789';
  const done = await poll(
    (
      await (
        await post({
          repo_url: 'https://example.invalid/khong-co-that.git',
          repo_token: secret,
          tickets_md: '## K-1 — x',
        })
      ).json()
    ).job_id,
  );
  assert.equal(done.status, 'failed');
  assert.match(done.error, /git clone thất bại/);
  assert.ok(!done.error.includes(secret), `lộ repo_token: ${done.error}`);
  assert.ok(!done.error.includes('x-access-token:'), `lộ userinfo: ${done.error}`);
});

/*
 * Gọi dừng một job analyze.
 *
 * `AbortController` vốn đã được tạo cho analyze và truyền xuống tận `runCli`/
 * `askFci`, nhưng KHÔNG route nào gọi `.abort()`: một job 184 ticket bắn nhầm
 * chỉ còn cách giết cả tiến trình. Ba thứ phải đúng cùng lúc thì lệnh dừng mới
 * có nghĩa: nó phải cắt thật, phần đã chấm phải ở lại, và phần chưa tới lượt
 * phải nói rõ là CHƯA XÉT chứ không phải "đã kiểm tra và thấy thiếu".
 */
async function pollAny(jobId, { tries = 400 } = {}) {
  for (let i = 0; i < tries; i++) {
    const res = await fetch(`${base}/api/v1/analyze/${jobId}`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    const json = await res.json();
    if (json.status === 'failed') return json;
    if ((json.status === 'succeeded' || json.status === 'cancelled') && json.result) return json;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('job không đóng sổ trong thời gian chờ');
}

test('DELETE /api/v1/analyze/<id> dừng job, giữ phần đã chấm, phần còn lại là "cancelled"', async () => {
  const repo = await makeRepo('repo-huy', { 'src/a.py': 'def login():\n    return True\n' });
  const soTicket = 30;
  const tickets_md = Array.from({ length: soTicket }, (_, i) => `## HUY-${i + 1} — viec so ${i + 1}\n\nStatus: Done`).join('\n\n');

  /*
   * Hai thời điểm dừng, vì chúng đi qua hai nhánh khác nhau: `0ms` rơi trước
   * vòng quét (và phải KHÔNG bị cái chốt "không lượt nào chấm được" biến thành
   * `failed`), `150ms` rơi giữa vòng quét. Mọi khẳng định dưới đây không phụ
   * thuộc vào việc bao nhiêu ticket kịp chấm — máy tải nặng vẫn đúng.
   */
  for (const doTre of [0, 150]) {
    const res = await post({ run_id: `R-HUY-${doTre}`, repo_url: repo, tickets_md });
    assert.equal(res.status, 202);
    const { job_id } = await res.json();
    if (doTre) await new Promise((r) => setTimeout(r, doTre));

    const bo = await fetch(`${base}/api/v1/analyze/${job_id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(bo.status, 200);
    assert.equal((await bo.json()).status, 'cancelled');

    const done = await pollAny(job_id);
    assert.equal(done.status, 'cancelled', `dừng sau ${doTre}ms: KHÔNG được đóng sổ là succeeded/failed`);

    // Mọi ticket vẫn có mặt: một ticket vắng mặt trông y như một ticket đã xét
    // và không thấy gì.
    assert.equal(done.result.items.length, soTicket);
    const chuaXet = done.result.items.filter((i) => i.reason === 'cancelled');
    const daXet = done.result.items.filter((i) => i.reason !== 'cancelled');
    assert.ok(chuaXet.length > 0, `dừng sau ${doTre}ms: phải có ticket mang reason "cancelled"`);
    assert.equal(chuaXet.length + daXet.length, soTicket);
    assert.equal(done.result.stats.tickets_cancelled, chuaXet.length);
    for (const it of chuaXet) {
      assert.equal(it.code_status, 'missing');
      assert.equal(it.scan, null, 'chưa xét thì cũng chưa quét');
      assert.equal(it.confidence, 0);
    }
    // Phần đã chấm xong ở lại nguyên vẹn — chúng đã được trả tiền rồi.
    for (const it of daXet) {
      assert.ok(!String(it.reason).startsWith('judge_failed'), `${it.key}: lệnh dừng không được làm hỏng lượt đã xong`);
    }
    assert.match(done.result.report_md, /job bị gọi dừng/);
  }
});

test('DELETE analyze: id lạ → 404, và không đụng được job judge', async () => {
  const la = await fetch(`${base}/api/v1/analyze/khong-co-that`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  assert.equal(la.status, 404);

  // Một job judge không được dừng qua đường analyze — hai sổ, hai hợp đồng.
  const repo = await makeRepo('repo-kind', { 'a.py': 'x = 1\n' });
  const j = await fetch(`${base}/api/v1/judge`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({
      repo_url: repo,
      tickets: [{ key: 'K-1', evidence: [{ path: 'a.py', lines: '1' }] }],
      verdict_guide: { MATCH: 'khop', JIRA_AHEAD: 'lech' },
    }),
  });
  const { job_id } = await j.json();
  const nham = await fetch(`${base}/api/v1/analyze/${job_id}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  assert.equal(nham.status, 404);
  await pollJudge(job_id).catch(() => {});
});
