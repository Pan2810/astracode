/**
 * Chọn lọc và cache của job judge — chạy offline, model giả, repo git thật.
 *
 * Mỗi ca ở đây canh một cách tiêu tiền vô ích mà vẫn báo succeeded:
 *
 *   - Ticket tầng grep đã chắc vẫn bị gửi cho model (`skip_above` không ăn).
 *   - Chạy lại đúng một job đã chạy vẫn trả tiền lại từ đầu (cache không ăn).
 *   - Cache trả lời thay cho một commit KHÁC — lỗi ngược lại, và là lỗi nguy
 *     hiểm hơn: kết luận sai chứ không phải hoá đơn cao.
 *   - 429 làm hỏng cả ticket thay vì chờ rồi thử lại.
 *
 * `total` trong tiến độ là số lượt THẬT SỰ gọi model, nên nó cũng là thứ đếm
 * được: bỏ qua hai ticket thì `total` phải tụt hai.
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
import { cacheKey, parseDuration, safeTenant, sweepCache } from '../lib/judgeCache.mjs';

const run = promisify(execFile);
const TOKEN = 'service-token-chon-loc-0123456789';
const KEY = 'sk-KHONG-DUOC-LO-RA-9876543210';

const GUIDE = {
  MATCH: 'kế hoạch và mã nguồn nói cùng một chuyện',
  CODE_AHEAD: 'mã đã có, ticket chưa đóng',
  JIRA_AHEAD: 'ticket đã đóng, mã chưa thấy',
};

let tmp;
let repoDir;
let model;
let modelUrl;
let server;
let base;
let repoUrl;
let wsDir;

/** Mỗi request tới model giả để lại một dòng ở đây. */
let calls = [];
/** Ðặt riêng cho từng ca: hàm trả `{status, headers, body}`. `null` = trả lời mặc định. */
let reply = null;

function ok(key) {
  return {
    choices: [
      {
        message: {
          content:
            '```json\n' +
            JSON.stringify({ items: [{ key, verdict: 'MATCH', confidence: 0.77, reason: 'code có ở dòng được trích' }] }) +
            '\n```',
        },
      },
    ],
    usage: { prompt_tokens: 120, completion_tokens: 30 },
  };
}

before(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'astraqa-select-'));
  wsDir = path.join(tmp, 'ws');

  model = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', () => {
      const payload = JSON.parse(raw);
      const prompt = payload.messages.at(-1).content;
      const key = (/Ticket key:\s*(.+)/.exec(prompt)?.[1] ?? '').trim();
      calls.push({ key, prompt });
      const out = reply ? reply({ key, prompt, nth: calls.length }) : null;
      res.writeHead(out?.status ?? 200, { 'Content-Type': 'application/json', ...(out?.headers ?? {}) });
      res.end(JSON.stringify(out?.body ?? ok(key)));
    });
  });
  await new Promise((r) => model.listen(0, '127.0.0.1', r));
  modelUrl = `http://127.0.0.1:${model.address().port}/v1`;

  repoDir = path.join(tmp, 'repo');
  await fs.mkdir(path.join(repoDir, 'src'), { recursive: true });
  await fs.writeFile(
    path.join(repoDir, 'src', 'auth.py'),
    Array.from({ length: 80 }, (_, i) => (i === 39 ? 'def login(user):' : `# dòng ${i + 1}`)).join('\n'),
  );
  await run('git', ['init', '-q', '-b', 'main'], { cwd: repoDir });
  await run('git', ['add', '-A'], { cwd: repoDir });
  await run('git', ['-c', 'user.email=t@example.invalid', '-c', 'user.name=t', 'commit', '-q', '-m', 'init'], {
    cwd: repoDir,
  });
  repoUrl = pathToFileURL(repoDir).href;

  server = createServer(
    {
      port: 0,
      workspaceDir: wsDir,
      runsDir: path.join(tmp, 'runs'),
      cliPath: '(không dùng)',
      astraworkJwt: '',
      serviceToken: TOKEN,
      judgeConcurrency: 4,
      maxTickets: 0,
      judgeBackend: 'fci',
      fciBaseUrl: modelUrl,
      fciApiKey: KEY,
      fciModel: 'model-thu',
      fciExtraBody: null,
    },
    { log: () => {}, persist: false },
  );
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((r) => server.close(r));
  await new Promise((r) => model.close(r));
  await fs.rm(tmp, { recursive: true, force: true });
});

function post(body) {
  return fetch(`${base}/api/v1/judge`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify(body),
  });
}

const SETTLED = new Set(['succeeded', 'failed', 'cancelled']);

async function settle(jobId, { tries = 400 } = {}) {
  for (let i = 0; i < tries; i++) {
    const json = await fetch(`${base}/api/v1/judge/${jobId}`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    }).then((r) => r.json());
    if (SETTLED.has(json.status)) return json;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('job judge không kết thúc trong thời gian chờ');
}

const ticket = (key, extra = {}) => ({
  key,
  summary: 'Đăng nhập bằng mật khẩu',
  status: 'done',
  grep_verdict: 'CODE_AHEAD',
  grep_reason: 'matched_by_key',
  grep_confidence: 0.4,
  evidence: [{ path: 'src/auth.py', lines: '40', note: '' }],
  ...extra,
});

async function judged(body) {
  const { job_id } = await post(body).then((r) => r.json());
  return settle(job_id);
}

test('skip_above: ticket tầng grep đã chắc thì không tiêu một lượt model nào', async () => {
  reply = null;
  calls = [];
  const done = await judged({
    run_id: 'SEL-1',
    repo_url: repoUrl,
    mode: 'selected',
    skip_above: 0.8,
    cache: false,
    verdict_guide: GUIDE,
    tickets: [
      ticket('SK-1', { grep_confidence: 0.95 }),
      ticket('SK-2', { grep_confidence: 0.8 }), // đúng ngưỡng cũng là "đã chắc"
      ticket('SK-3', { grep_confidence: 0.79 }),
      ticket('SK-4', { grep_confidence: null }), // không nói thì không được bỏ qua
    ],
  });

  assert.equal(done.status, 'succeeded');
  // Bốn dòng vẫn đủ mặt: bỏ qua không phải là biến mất.
  assert.equal(done.results.length, 4);
  assert.deepEqual(
    calls.map((c) => c.key).sort(),
    ['SK-3', 'SK-4'],
    'chỉ hai ticket chưa chắc được gửi cho model',
  );

  const by = Object.fromEntries(done.results.map((r) => [r.key, r]));
  for (const k of ['SK-1', 'SK-2']) {
    assert.equal(by[k].tier, 'grep');
    assert.equal(by[k].skipped, true);
    assert.equal(by[k].reason, 'đã chắc ở tầng grep');
    // Kết luận của tầng trước đi cùng, không phải một ô trống.
    assert.equal(by[k].verdict, 'CODE_AHEAD');
    // Bỏ qua KHÔNG phải lỗi — không được lẫn với "giữ tầng grep vì hỏng".
    assert.equal(by[k].error, undefined);
  }
  for (const k of ['SK-3', 'SK-4']) {
    assert.equal(by[k].tier, 'ai');
    assert.equal(by[k].verdict, 'MATCH');
  }

  // `total` là số lượt thật sự gọi model, không phải số ticket gửi lên.
  assert.equal(done.progress.total, 2);
  assert.equal(done.progress.done, 2);
  assert.equal(done.progress.skipped, 2);
  assert.equal(done.progress.cached, 0);
  assert.equal(done.progress.model_calls, 2);
  assert.equal(done.progress.token_in, 240);
  assert.equal(done.progress.token_out, 60);
  assert.equal(done.progress.throttled, 0);
  assert.equal(done.stats.skipped_sure, 2);
});

test('mode "full" xét mọi ticket, dù tầng grep có chắc đến đâu', async () => {
  reply = null;
  calls = [];
  const done = await judged({
    repo_url: repoUrl,
    mode: 'full',
    cache: false,
    verdict_guide: GUIDE,
    tickets: [ticket('FU-1', { grep_confidence: 0.99 }), ticket('FU-2', { grep_confidence: 1 })],
  });
  assert.equal(done.status, 'succeeded');
  assert.equal(calls.length, 2);
  assert.equal(done.progress.skipped, 0);
  assert.equal(done.progress.total, 2);
});

test('tổ hợp vô nghĩa bị chặn ngay bằng 400, không thành job hỏng', async () => {
  const cases = [
    [{ mode: 'selected' }, /skip_above/],
    [{ skip_above: 0.9 }, /chỉ có nghĩa với mode "selected"/],
    [{ mode: 'selected', skip_above: 5 }, /\(0, 1\]/],
    [{ mode: 'nhanh' }, /"selected" hoặc "full"/],
    [{ cache: 'có' }, /"cache" phải là true hoặc false/],
  ];
  for (const [extra, re] of cases) {
    const res = await post({ repo_url: repoUrl, tickets: [ticket('BAD-0')], verdict_guide: GUIDE, ...extra });
    assert.equal(res.status, 400, JSON.stringify(extra));
    assert.match((await res.json()).error, re);
  }
});

test('lần hai cùng repo, cùng commit, cùng ticket: không gọi model lần nào', async () => {
  reply = null;
  calls = [];
  const tickets = ['CA-1', 'CA-2', 'CA-3'].map((k) => ticket(k));
  const body = {
    repo_url: repoUrl,
    verdict_guide: GUIDE,
    cache: true,
    rules_version: 'rules-v1',
    tenant: 'doi-alpha',
    tickets,
  };

  const first = await judged(body);
  assert.equal(first.status, 'succeeded');
  assert.equal(calls.length, 3, 'lần đầu phải trả tiền đủ ba lượt');
  assert.equal(first.progress.cached, 0);
  assert.equal(first.progress.total, 3);

  calls = [];
  const second = await judged(body);
  assert.equal(second.status, 'succeeded');
  assert.equal(calls.length, 0, 'lần hai KHÔNG được gọi model lần nào');
  assert.equal(second.progress.cached, 3);
  assert.equal(second.progress.total, 0, 'không còn lượt nào phải chờ');
  assert.equal(second.progress.model_calls, 0);
  assert.equal(second.progress.token_in, 0);
  assert.equal(second.results.length, 3);
  for (const r of second.results) {
    // Cùng kết luận, nhưng nói rõ là lấy lại chứ không phải vừa xét.
    assert.equal(r.verdict, 'MATCH');
    assert.equal(r.tier, 'ai');
    assert.equal(r.cached, true);
  }

  // Tệp cache nằm đúng chỗ, mỗi tenant một tệp, đọc được bằng mắt.
  const file = path.join(wsDir, 'judge-cache', 'doi-alpha.jsonl');
  const lines = (await fs.readFile(file, 'utf8')).trim().split('\n');
  assert.equal(lines.length, 3);
  const rec = JSON.parse(lines[0]);
  assert.match(rec.revision, /^[0-9a-f]{40}$/);
  assert.equal(rec.model, 'model-thu');
  assert.equal(rec.rules_version, 'rules-v1');
  assert.equal(rec.result.tier, 'ai');
});

test('đổi commit là miss — cache không bao giờ trả lời thay cho code đã đổi', async () => {
  reply = null;
  const body = {
    repo_url: repoUrl,
    verdict_guide: GUIDE,
    cache: true,
    tenant: 'doi-beta',
    tickets: [ticket('REV-1')],
  };

  calls = [];
  const first = await judged(body);
  assert.equal(calls.length, 1);
  const revA = first.source_revision;

  calls = [];
  assert.equal((await judged(body)).progress.cached, 1, 'chưa đổi gì thì trúng cache');
  assert.equal(calls.length, 0);

  // Commit mới trên cùng repo ấy.
  await fs.appendFile(path.join(repoDir, 'src', 'auth.py'), '\n# thêm một dòng\n');
  await run('git', ['add', '-A'], { cwd: repoDir });
  await run('git', ['-c', 'user.email=t@example.invalid', '-c', 'user.name=t', 'commit', '-q', '-m', 'đổi'], {
    cwd: repoDir,
  });

  calls = [];
  const third = await judged(body);
  assert.notEqual(third.source_revision, revA, 'phải là commit khác');
  assert.equal(calls.length, 1, 'commit mới thì phải hỏi lại model');
  assert.equal(third.progress.cached, 0);
  assert.equal(third.progress.total, 1);

  // Ðổi rules_version cũng là câu hỏi khác, dù commit không đổi.
  calls = [];
  const fourth = await judged({ ...body, rules_version: 'rules-v2' });
  assert.equal(calls.length, 1, 'rules khác thì không được dùng lại câu trả lời cũ');
  assert.equal(fourth.progress.cached, 0);
});

test('nới tham số prompt là câu hỏi khác — cache không trả lời thay bằng bản rẻ hơn', async () => {
  reply = null;
  const body = {
    repo_url: repoUrl,
    verdict_guide: GUIDE,
    cache: true,
    tenant: 'doi-gamma',
    tickets: [ticket('OPT-1')],
  };

  calls = [];
  await judged(body);
  assert.equal(calls.length, 1);

  calls = [];
  assert.equal((await judged(body)).progress.cached, 1, 'cùng tham số thì trúng cache');

  // Bên gọi nới để model được đọc nhiều code hơn — đúng lúc họ muốn một câu
  // trả lời tốt hơn, nên trả lại kết luận cũ là hỏng thầm lặng.
  calls = [];
  const wider = await judged({ ...body, options: { max_snippets: 5, context_lines: 30 } });
  assert.equal(calls.length, 1, 'tham số prompt đổi thì phải hỏi lại');
  assert.equal(wider.progress.cached, 0);
});

test('khoá cache đổi theo đúng từng thành phần, và tenant lạ không thoát ra khỏi thư mục', () => {
  const base0 = {
    repoUrl: 'https://git/x.git',
    revision: 'a'.repeat(40),
    ticketKey: 'WEB-1',
    summary: 'Đăng nhập',
    description: 'bằng mật khẩu',
    status: 'done',
    rulesVersion: 'v1',
    model: 'm1',
    // Dấu vân tay prompt: quy ước codebase + tham số cắt mảnh.
    prompt: '{"guidance":"","max_snippets":3}',
  };
  const k0 = cacheKey(base0);
  assert.equal(cacheKey({ ...base0 }), k0, 'cùng đầu vào thì cùng khoá');
  for (const field of [
    'repoUrl',
    'revision',
    'ticketKey',
    'summary',
    'description',
    'status',
    'rulesVersion',
    'model',
    'prompt',
  ]) {
    assert.notEqual(cacheKey({ ...base0, [field]: 'khác' }), k0, `${field} đổi mà khoá không đổi`);
  }
  // Băm nội dung ticket không được nhập nhằng: "ab"+"c" phải khác "a"+"bc".
  assert.notEqual(
    cacheKey({ ...base0, summary: 'ab', description: 'c' }),
    cacheKey({ ...base0, summary: 'a', description: 'bc' }),
  );

  // Tên lạ không được thoát ra khỏi thư mục cache…
  assert.equal(safeTenant('../../etc/passwd').includes('/'), false);
  assert.match(safeTenant('../../etc/passwd'), /^etc-passwd-[0-9a-f]{8}$/);
  assert.equal(safeTenant(''), 'default');
  assert.equal(safeTenant('doi-alpha'), 'doi-alpha', 'tên đã sạch thì giữ nguyên');
  // …và hai tên khác nhau KHÔNG được rút về cùng một tệp, nếu không thì đội
  // này đọc được kết luận đã trả tiền của đội kia.
  assert.notEqual(safeTenant('Đội A'), safeTenant('Nội A'));
  assert.notEqual(safeTenant('a/b'), safeTenant('a\b'));
});

test('DELETE /api/v1/judge/cache dọn theo mốc, và đòi nói rõ mốc ấy', async () => {
  const dir = path.join(wsDir, 'judge-cache');
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, 'doi-cu.jsonl');
  const old = new Date(Date.now() - 40 * 86_400_000).toISOString();
  const fresh = new Date().toISOString();
  await fs.writeFile(
    file,
    [
      JSON.stringify({ k: 'k-cu', at: old, result: { key: 'A', tier: 'ai' } }),
      JSON.stringify({ k: 'k-moi', at: fresh, result: { key: 'B', tier: 'ai' } }),
      '{ dòng hỏng',
    ].join('\n') + '\n',
    'utf8',
  );

  assert.equal(parseDuration('30d'), 30 * 86_400_000);
  assert.equal(parseDuration('90m'), 90 * 60_000);
  assert.equal(parseDuration('mãi mãi'), null);

  const bad = await fetch(`${base}/api/v1/judge/cache`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).error, /older_than/);

  const res = await fetch(`${base}/api/v1/judge/cache?older_than=30d`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  assert.equal(res.status, 200);
  const out = await res.json();
  assert.equal(out.older_than, '30d');
  assert.ok(out.removed >= 2, 'entry quá hạn và dòng hỏng đều bị dọn');

  const left = (await fs.readFile(file, 'utf8')).trim().split('\n').filter(Boolean);
  assert.equal(left.length, 1);
  assert.equal(JSON.parse(left[0]).k, 'k-moi');

  // Dọn thẳng bằng hàm: mốc chưa tới thì không ai bị xoá.
  const again = await sweepCache(dir, 365 * 86_400_000);
  assert.equal(again.removed, 0);
});

test('429 kèm Retry-After: chờ rồi thử lại, ticket vẫn có kết luận, throttled đếm đúng', async () => {
  calls = [];
  // Lượt đầu bị chặn, lượt sau qua — đúng hình dạng một cửa sổ hạn mức.
  reply = ({ key, nth }) =>
    nth === 1
      ? { status: 429, headers: { 'Retry-After': '1' }, body: { error: 'quota' } }
      : { status: 200, body: ok(key) };

  const done = await judged({
    repo_url: repoUrl,
    verdict_guide: GUIDE,
    cache: false,
    tickets: [ticket('TH-1')],
  });
  reply = null;

  assert.equal(done.status, 'succeeded');
  assert.equal(calls.length, 2, 'một lượt bị chặn + một lượt thử lại');
  assert.equal(done.results[0].verdict, 'MATCH');
  assert.equal(done.results[0].tier, 'ai');
  assert.equal(done.progress.throttled, 1);
  assert.equal(done.stats.hits_429, 1);
  // Mỗi lần thử lại cũng là một request thật, nên nó được đếm như một lượt gọi.
  assert.equal(done.progress.model_calls, 2);
  // Lượt hỏng không có `usage`, nên token chỉ đếm lượt thành công.
  assert.equal(done.progress.token_in, 120);
});
