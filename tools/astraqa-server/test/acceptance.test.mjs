/**
 * Tiêu chí chấp nhận: vào prompt thành từng dòng, về thành `assessment` per-AC.
 *
 * Hình dạng `assessment` ở đây KHÔNG phải do bên này đặt — nó là hợp đồng của
 * AstraQA, đọc ra từ `management-core/code_reconcile._assessment`:
 *
 *   assessment: { criteria: [{ id, text, status, evidence[], reason }] }
 *   status ∈ {satisfied, partial, not_satisfied, unknown}   (AC_STATUSES)
 *
 * Bên kia đọc NGHIÊM: `assessment` không phải object có `criteria` là mảng thì
 * nó ném `CodeReportError`, và một `id` không phải số nguyên dương duy nhất
 * cũng vậy. Nên những ca dưới đây canh đúng hình dạng ấy, không canh một hình
 * dạng "hợp lý" nào khác.
 *
 * Model giả, repo git thật, không mạng và không token.
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
import { MAX_BODY_CHARS, parseAcceptance, parseSchemaVersion, parseJsonTickets } from '../lib/tickets.mjs';

const run = promisify(execFile);
const TOKEN = 'service-token-ac-0123456789';

const AC = [
  'Người dùng đăng nhập được bằng mật khẩu',
  'Sai mật khẩu ba lần thì khoá tài khoản 15 phút',
  'Có log cho mỗi lần đăng nhập hỏng',
];

let tmp;
let server;
let base;
let repoUrl;
let model;
let modelUrl;
/** Prompt nào đã tới model. */
let seen = [];
/** Trả lời kế tiếp: hàm nhận {key, prompt} trả về `items[0]`. */
let answer = null;

function block(item) {
  return '```json\n' + JSON.stringify({ items: [item] }) + '\n```';
}

before(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'astraqa-ac-'));

  model = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', () => {
      const prompt = JSON.parse(raw).messages.at(-1).content;
      const key = (/Ticket key:\s*(.+)/.exec(prompt)?.[1] ?? '').trim();
      seen.push({ key, prompt });
      const item = answer
        ? answer({ key, prompt })
        : {
            key,
            code_status: 'partial',
            confidence: 0.7,
            evidence: [{ path: 'src/login.py', lines: '1-2', note: 'hàm đăng nhập' }],
            reason: 'matched_by_key',
          };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: block(item) } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }));
    });
  });
  await new Promise((r) => model.listen(0, '127.0.0.1', r));
  modelUrl = `http://127.0.0.1:${model.address().port}/v1`;

  const dir = path.join(tmp, 'repo');
  await fs.mkdir(path.join(dir, 'src'), { recursive: true });
  await fs.writeFile(path.join(dir, 'src', 'login.py'), 'def authenticate(user, password):\n    return True\n');
  await fs.writeFile(path.join(dir, 'src', 'lockout.py'), 'ATTEMPTS = {}\n\n\ndef too_many(user):\n    return ATTEMPTS.get(user, 0) > 3\n');
  await run('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  await run('git', ['add', '-A'], { cwd: dir });
  await run('git', ['-c', 'user.email=t@e.invalid', '-c', 'user.name=t', 'commit', '-q', '-m', 'i'], { cwd: dir });
  repoUrl = pathToFileURL(dir).href;

  server = createServer(
    {
      port: 0,
      workspaceDir: path.join(tmp, 'ws'),
      runsDir: path.join(tmp, 'runs'),
      cliPath: '',
      astraworkJwt: '',
      serviceToken: TOKEN,
      judgeBackend: 'fci',
      fciBaseUrl: modelUrl,
      fciApiKey: 'sk-khong-lo-ra',
      fciModel: 'model-thu',
      fciExtraBody: null,
      judgeConcurrency: 2,
      maxTickets: 0,
    },
    { log: () => {}, persist: false },
  );
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((r) => server.close(r));
  await new Promise((r) => model.close(r));
  await fs.rm(tmp, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
});

function post(body) {
  return fetch(`${base}/api/v1/analyze`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify(body),
  });
}

async function analyze(body) {
  const { job_id } = await post(body).then((r) => r.json());
  for (let i = 0; i < 400; i++) {
    const j = await fetch(`${base}/api/v1/analyze/${job_id}`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    }).then((r) => r.json());
    if (j.status === 'succeeded' || j.status === 'failed') return j;
    await new Promise((s) => setTimeout(s, 25));
  }
  throw new Error('job không kết thúc trong thời gian chờ');
}

const ticket = (extra = {}) => ({
  key: 'WEB-1001',
  summary: 'Màn hình đăng nhập',
  status: 'Done',
  description: 'Cho phép đăng nhập bằng mật khẩu.',
  acceptance_criteria: AC,
  ...extra,
});

// ───────────────────────── vào prompt ─────────────────────────

test('tiêu chí chấp nhận vào prompt, mỗi tiêu chí một dòng, đánh số bằng id', async () => {
  seen = [];
  answer = null;
  const done = await analyze({ run_id: 'AC-1', repo_url: repoUrl, tickets_schema_version: 1, tickets: [ticket()] });
  assert.equal(done.status, 'succeeded', done.error);

  const prompt = seen.at(-1).prompt;
  assert.match(prompt, /Acceptance criteria/);
  AC.forEach((text, i) => {
    // Ðúng dạng "1. <tiêu chí>" — số ấy chính là `id` model phải dùng lại.
    assert.ok(prompt.includes(`${i + 1}. ${text}`), `prompt thiếu dòng "${i + 1}. ${text}"`);
  });
  // Và schema yêu cầu chấm từng tiêu chí, bằng đúng từ vựng của AstraQA.
  assert.match(prompt, /"ac_assessment"/);
  assert.match(prompt, /satisfied \| partial \| not_satisfied \| unknown/);
});

test('acceptance_hint là đường lui khi không có danh sách', () => {
  assert.deepEqual(parseAcceptance({ acceptance_criteria: AC }), AC);
  // AstraQA dựng hint bằng "\n".join(criteria) — tách lại theo dòng là khôi phục.
  assert.deepEqual(parseAcceptance({ acceptance_hint: AC.join('\n') }), AC);
  assert.deepEqual(parseAcceptance({ acceptance_hint: 'một tiêu chí duy nhất' }), ['một tiêu chí duy nhất']);
  assert.deepEqual(parseAcceptance({}), []);
  // Danh sách thắng hint khi có cả hai.
  assert.deepEqual(parseAcceptance({ acceptance_criteria: ['A'], acceptance_hint: 'B' }), ['A']);
  // Trần 200 đúng bằng max_length của schema AstraQA.
  assert.throws(() => parseAcceptance({ acceptance_criteria: Array.from({ length: 201 }, (_, i) => `AC ${i}`) }), /trần là 200/);
});

// ───────────────────────── assessment trả về ─────────────────────────

test('assessment về đúng hình dạng AstraQA đọc: {criteria:[{id,text,status,evidence,reason}]}', async () => {
  answer = ({ key }) => ({
    key,
    code_status: 'partial',
    confidence: 0.8,
    evidence: [{ path: 'src/login.py', lines: '1-2', note: '' }],
    reason: 'matched_by_key',
    ac_assessment: [
      { id: 1, status: 'satisfied', evidence: [{ path: 'src/login.py', lines: '1-2', note: 'authenticate()' }], reason: 'có hàm đăng nhập' },
      { id: 2, status: 'partial', evidence: [{ path: 'src/lockout.py', lines: '4-5', note: 'đếm lần hỏng' }], reason: 'thiếu phần 15 phút' },
      // Tiêu chí 3 model không nhắc tới.
    ],
  });
  const done = await analyze({ repo_url: repoUrl, tickets: [ticket({ key: 'AC-SHAPE' })] });
  answer = null;
  assert.equal(done.status, 'succeeded', done.error);

  const item = done.result.items[0];
  const a = item.assessment;
  // `assessment` là OBJECT có `criteria` là mảng — mảng trần sẽ làm AstraQA ném.
  assert.equal(typeof a, 'object');
  assert.ok(Array.isArray(a.criteria));
  // Một mục cho MỘT tiêu chí đã gửi, không hơn không kém.
  assert.equal(a.criteria.length, AC.length);
  assert.deepEqual(a.criteria.map((c) => c.id), [1, 2, 3]);
  // `text` là chữ của bên gọi, không phải chữ model viết lại.
  assert.deepEqual(a.criteria.map((c) => c.text), AC);
  assert.deepEqual(a.criteria.map((c) => c.status), ['satisfied', 'partial', 'unknown']);
  // Tiêu chí model bỏ qua → unknown, không bằng chứng, không bịa.
  assert.deepEqual(a.criteria[2].evidence, []);
  assert.equal(a.criteria[2].reason, null);
  // Bằng chứng của từng tiêu chí giữ nguyên path + lines để AstraQA mở được.
  assert.equal(a.criteria[0].evidence[0].path, 'src/login.py');
  assert.equal(a.criteria[0].evidence[0].lines, '1-2');
  assert.equal(a.criteria[1].reason, 'thiếu phần 15 phút');
  assert.equal(done.result.stats.items_with_assessment, 1);

  // Bảng ấy cũng đọc được bằng mắt trong report.
  assert.match(done.result.report_md, /Tiêu chí chấp nhận:/);
  assert.match(done.result.report_md, /1\. \*\*satisfied\*\*/);
});

test('not_satisfied cần phạm vi quét đã đi tìm, không chỉ cần dẫn chứng; id lạ và đường dẫn bịa đều tụt về unknown', async () => {
  answer = ({ key }) => ({
    key,
    code_status: 'done',
    confidence: 0.9,
    evidence: [{ path: 'src/login.py', lines: '1', note: '' }],
    scan: { complete: true, files_scanned: 2 },
    reason: 'matched_by_key',
    ac_assessment: [
      { id: 1, status: 'satisfied', evidence: [{ path: 'src/login.py', lines: '1-2' }], reason: 'x' },
      // Ðã tìm và không thấy — lượt này có scan.complete nên not_satisfied trụ được.
      { id: 2, status: 'not_satisfied', evidence: [], reason: 'không thấy khoá tài khoản' },
      // Ðường dẫn bịa: bị bộ lọc loại, nên trạng thái cũng không giữ được.
      { id: 3, status: 'satisfied', evidence: [{ path: 'src/khong-co-that.py', lines: '10-12' }], reason: 'y' },
    ],
  });
  const done = await analyze({ repo_url: repoUrl, tickets: [ticket({ key: 'AC-MAP' })] });
  answer = null;
  assert.equal(done.status, 'succeeded', done.error);

  const c = done.result.items[0].assessment.criteria;
  assert.equal(c[0].status, 'satisfied');
  assert.equal(c[1].status, 'not_satisfied', 'lượt có scan.complete thì một khẳng định âm không cần dẫn chứng');
  assert.equal(c[2].status, 'unknown', 'đường dẫn bịa bị loại, trạng thái không trụ lại');
  assert.deepEqual(c[2].evidence, []);
});

test('ticket không có tiêu chí thì assessment là not_assessed rỗng, không phải mảng ac_assessment', async () => {
  answer = null;
  const done = await analyze({ repo_url: repoUrl, tickets: [ticket({ key: 'AC-NULL', acceptance_criteria: [] })] });
  assert.deepEqual(done.result.items[0].assessment, { state: 'not_assessed', test_status: 'not_run', criteria: [] });
  assert.equal(done.result.stats.items_with_assessment, 0);
});

// ───────────────────────── phiên bản schema ─────────────────────────

test('tickets_schema_version: thiếu → 1, khác 1 → 400 nêu con số nhận được', async () => {
  assert.equal(parseSchemaVersion(undefined), 1);
  assert.equal(parseSchemaVersion(null), 1);
  assert.equal(parseSchemaVersion(1), 1);
  assert.equal(parseSchemaVersion('1'), 1);

  const res = await post({ repo_url: repoUrl, tickets: [ticket()], tickets_schema_version: 2 });
  assert.equal(res.status, 400);
  const { error } = await res.json();
  assert.match(error, /tickets_schema_version/);
  assert.match(error, /chỉ đọc được schema 1/);
  assert.match(error, /nhận được 2/);

  // Kiểu lạ cũng dừng, và cũng nói ra nó nhận được gì.
  const weird = await post({ repo_url: repoUrl, tickets: [ticket()], tickets_schema_version: 'v2' });
  assert.equal(weird.status, 400);
  assert.match((await weird.json()).error, /nhận được "v2"/);

  // Thiếu hẳn thì chạy bình thường, và job khai nó đã đọc theo schema 1.
  const done = await analyze({ repo_url: repoUrl, tickets: [ticket({ key: 'VER-1' })] });
  assert.equal(done.status, 'succeeded', done.error);
  assert.equal(done.result.stats.tickets_schema_version, 1);
});

// ───────────────────────── mô tả quá dài ─────────────────────────

test('description 15k: cắt ở 12000, item khai truncated, report có dòng cảnh báo', async () => {
  answer = null;
  const long = 'Mô tả rất dài. '.repeat(1000); // ~15.000 ký tự
  assert.ok(long.length > MAX_BODY_CHARS);

  const done = await analyze({
    repo_url: repoUrl,
    tickets: [ticket({ key: 'LONG-1', description: long }), ticket({ key: 'SHORT-1', description: 'ngắn thôi' })],
  });
  assert.equal(done.status, 'succeeded', done.error);

  const by = Object.fromEntries(done.result.items.map((i) => [i.key, i]));
  assert.equal(by['LONG-1'].truncated, true);
  assert.equal(by['SHORT-1'].truncated, false, 'mô tả ngắn thì không được đánh dấu');
  assert.equal(done.result.stats.tickets_truncated, 1);

  // Cảnh báo gọi đúng tên ticket, và nằm cả trong JSON lẫn trong report.
  const warn = done.result.warnings.find((w) => /đã bị cắt/.test(w));
  assert.ok(warn, `không thấy cảnh báo cắt mô tả trong ${JSON.stringify(done.result.warnings)}`);
  assert.match(warn, /LONG-1/);
  assert.match(warn, /12000 ký tự/);
  assert.match(done.result.report_md, /\*\*MÔ TẢ ÐÃ CẮT\*\*/);

  // Model chỉ thấy phần đã cắt, và phần ấy nói rõ là đã cắt.
  const prompt = seen.filter((s) => s.key === 'LONG-1').at(-1).prompt;
  assert.match(prompt, /đã cắt \d+ ký tự/);

  // Trần áp ở parser, nên nó đo được mà không cần chạy cả job.
  const [parsed] = parseJsonTickets([{ key: 'X', description: long }]);
  assert.equal(parsed.truncated, true);
  assert.ok(parsed.body.length < long.length);
  assert.ok(parsed.body.startsWith('Mô tả rất dài.'));
});
