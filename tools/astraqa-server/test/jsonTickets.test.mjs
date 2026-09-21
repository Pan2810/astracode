/**
 * `tickets` (JSON) song song với `tickets_md`, và lỗi của parser phải chỉ được chỗ.
 *
 * Lý do đường JSON tồn tại nằm ngay trong ca đầu tiên: một tiêu đề bình thường
 * của con người — có ngoặc, có `#`, có `|`, có xuống dòng, viết bằng tiếng Nhật
 * — là thứ phá được phép dò markdown, trong khi cùng dữ liệu ấy gửi dưới dạng
 * JSON thì không có gì để dò và cũng không có gì để hỏng.
 *
 * Backend `none`: không key, không JWT, không CLI, không mạng.
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
import { parseTickets, parseJsonTickets, resolveTickets } from '../lib/tickets.mjs';

const run = promisify(execFile);
let tmp;
let server;
let base;
let repoUrl;

/** Năm tiêu đề khó, đúng những thứ markdown hay nuốt. */
const HARD = [
  { key: 'WEB-1', summary: 'Thêm màn hình đăng nhập (SSO) cho web', status: 'Done', description: 'dùng authenticate()' },
  { key: 'WEB-2', summary: 'Sửa lỗi #500 khi upload file rỗng', status: 'In Progress', description: 'xem upload' },
  { key: 'WEB-3', summary: 'Bảng | cột | mới cho báo cáo', status: 'To Do', description: 'render_report' },
  { key: 'WEB-4', summary: 'Tiêu đề có\nxuống dòng ở giữa', status: 'Done', description: 'cache_lookup' },
  { key: 'WEB-5', summary: 'ログイン画面を追加する', status: 'Done', description: 'authenticate' },
];

before(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'astraqa-json-'));
  const dir = path.join(tmp, 'repo');
  await fs.mkdir(path.join(dir, 'src'), { recursive: true });
  await fs.writeFile(path.join(dir, 'src', 'login.py'), 'def authenticate(user, password):\n    return True\n');
  await fs.writeFile(path.join(dir, 'src', 'cache.py'), 'CACHE = {}\n\n\ndef cache_lookup(key):\n    return CACHE.get(key)\n');
  await fs.writeFile(path.join(dir, 'src', 'upload.py'), 'def store_attachment(blob):\n    return len(blob)\n');
  await fs.writeFile(path.join(dir, 'src', 'report.py'), 'def render_report(rows):\n    return ""\n');
  await fs.writeFile(path.join(dir, 'src', 'router.py'), 'ROUTES = {}\n');
  await fs.writeFile(path.join(dir, 'src', 'billing.py'), 'def invoice_total(items):\n    return 0\n');
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
      serviceToken: '',
      judgeBackend: 'none',
      fciBaseUrl: '',
      fciApiKey: '',
      fciModel: '',
    },
    { log: () => {}, persist: false },
  );
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((r) => server.close(r));
  await fs.rm(tmp, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
});

function post(body) {
  return fetch(`${base}/api/v1/analyze`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function analyze(body) {
  const { job_id } = await post(body).then((r) => r.json());
  for (let i = 0; i < 400; i++) {
    const j = await fetch(`${base}/api/v1/analyze/${job_id}`).then((r) => r.json());
    if (j.status === 'succeeded' || j.status === 'failed') return j;
    await new Promise((s) => setTimeout(s, 25));
  }
  throw new Error('job không kết thúc trong thời gian chờ');
}

// ───────────────────────── đường JSON ─────────────────────────

test('tickets JSON: tiêu đề có "(", "#", "|", xuống dòng và tiếng Nhật vẫn đủ ticket', async () => {
  const done = await analyze({ run_id: 'JS-1', repo_url: repoUrl, tickets: HARD });
  assert.equal(done.status, 'succeeded', done.error);

  // Ðủ năm, không thiếu, không thừa — markdown là chỗ những tiêu đề này bị nuốt.
  assert.equal(done.result.items.length, 5);
  assert.deepEqual(
    done.result.items.map((i) => i.key),
    ['WEB-1', 'WEB-2', 'WEB-3', 'WEB-4', 'WEB-5'],
  );
  assert.equal(done.result.stats.tickets_total, 5);
  assert.equal(done.result.stats.tickets_source, 'json');
  assert.equal(done.result.stats.judge_calls, 5);
  assert.equal(done.result.stats.judge_parsed, 5);

  // Tiêu đề đi nguyên vào báo cáo: không bị cắt ở `|`, không bị hiểu là heading.
  assert.match(done.result.report_md, /Thêm màn hình đăng nhập \(SSO\) cho web/);
  assert.match(done.result.report_md, /ログイン画面を追加する/);
});

test('cùng một dữ liệu: JSON giữ nguyên tiêu đề, markdown cắt mất phần sau dấu xuống dòng', () => {
  // Ðúng năm tiêu đề ấy, ép qua markdown theo cách tự nhiên nhất.
  const md = HARD.map((t) => `## ${t.key} — ${t.summary}\n\nStatus: ${t.status}\n`).join('\n');
  const viaMd = parseTickets(md);
  const viaJson = parseJsonTickets(HARD);

  assert.equal(viaJson.length, 5);
  assert.deepEqual(viaJson.map((t) => t.title), HARD.map((t) => t.summary));
  assert.deepEqual(viaJson.map((t) => t.status), HARD.map((t) => t.status));
  // `description` vào `body` — đúng hai trường §1.1 cho phép quét.
  assert.deepEqual(viaJson.map((t) => t.body), HARD.map((t) => t.description));

  /*
   * Markdown đếm đủ năm, nhưng MẤT DỮ LIỆU ở chỗ không ai nhìn thấy: phần sau
   * dấu xuống dòng của WEB-4 rơi khỏi tiêu đề (nó thành thân ticket), nên
   * `queryTerms` quét một tiêu đề cụt. Ðây mới là lý do đường JSON tồn tại —
   * không phải vì markdown đếm sai, mà vì nó đếm đúng trong khi đã cắt mất
   * một nửa câu.
   */
  assert.equal(viaMd.length, 5);
  assert.equal(viaMd[3].title, 'Tiêu đề có');
  assert.equal(viaJson[3].title, HARD[3].summary);
  assert.match(viaJson[3].title, /xuống dòng ở giữa/);
  assert.notEqual(viaMd[3].title, viaJson[3].title);
  // Bốn tiêu đề còn lại thì markdown giữ nguyên được — chỉ xuống dòng là bẫy.
  for (const i of [0, 1, 2, 4]) assert.equal(viaMd[i].title, viaJson[i].title);
});

test('có cả hai thì JSON thắng, và nói ra là đã dùng đường nào', async () => {
  const done = await analyze({
    repo_url: repoUrl,
    tickets: [HARD[0]],
    tickets_md: '## MD-1 — ticket chỉ có trong markdown\n\nStatus: Done',
  });
  assert.equal(done.status, 'succeeded', done.error);
  assert.deepEqual(done.result.items.map((i) => i.key), ['WEB-1']);
  assert.equal(done.result.stats.tickets_source, 'json');

  // Hàm chọn nguồn là một chỗ duy nhất, và nó khai rõ nguồn.
  assert.equal(resolveTickets({ tickets: [HARD[0]], tickets_md: 'x' }).source, 'json');
  assert.equal(resolveTickets({ tickets_md: '## A-1 — x' }).source, 'markdown');
});

test('tickets JSON hỏng thì 400 ngay, kèm chỉ số mảng', async () => {
  const cases = [
    [{ tickets: 'WEB-1' }, /"tickets" phải là một mảng/],
    [{ tickets: [] }, /mảng rỗng/],
    [{ tickets: [{ summary: 'không có key' }] }, /tickets\[0\]\.key/],
    [{ tickets: ['WEB-1'] }, /tickets\[0\] phải là một object/],
    [
      { tickets: [{ key: 'WEB-1' }, { key: 'web-1' }] },
      /key bị trùng — "WEB-1" \(tickets\[0\]\) và "web-1" \(tickets\[1\]\)/,
    ],
  ];
  for (const [extra, re] of cases) {
    const res = await post({ repo_url: repoUrl, ...extra });
    assert.equal(res.status, 400, JSON.stringify(extra));
    assert.match((await res.json()).error, re);
  }
});

test('không gửi nguồn ticket nào thì 400 nói rõ cả hai đường', async () => {
  const res = await post({ repo_url: repoUrl });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /tickets_md hoặc tickets/);
});

test('/healthz khai nhận được ticket dạng JSON', async () => {
  const health = await fetch(`${base}/healthz`).then((r) => r.json());
  assert.equal(health.accepts_json_tickets, true);
});

// ───────────────────────── lỗi của parser markdown ─────────────────────────

test('key trùng: vẫn là lỗi, nhưng nêu số dòng và cả hai key gốc', () => {
  const md = [
    '# Sprint 12', // dòng 1
    '', // 2
    '## WEB-1001 — thêm đăng nhập', // 3
    'Status: Done', // 4
    '', // 5
    '## WEB-2002 — sửa upload', // 6
    '', // 7
    '## web-1001 — vẫn là ticket ấy, viết thường', // 8
  ].join('\n');

  assert.throws(
    () => parseTickets(md),
    (err) => {
      // Hai key GỐC, đúng như người gửi viết — không phải bản đã chuẩn hoá.
      assert.match(err.message, /"WEB-1001"/);
      assert.match(err.message, /"web-1001"/);
      // Và chỗ của chúng trong tệp.
      assert.match(err.message, /dòng 3/);
      assert.match(err.message, /dòng 8/);
      assert.match(err.message, /key bị trùng/);
      return true;
    },
  );
});

test('key trùng trong bảng: số dòng là dòng của chính ô ấy', () => {
  const md = [
    '| Key | Summary |', // 1
    '|---|---|', // 2
    '| A-1 | làm A |', // 3
    '| A-2 | làm B |', // 4
    '| a-1 | làm lại A |', // 5
  ].join('\n');
  assert.throws(() => parseTickets(md), /"A-1" \(dòng 3\) và "a-1" \(dòng 5\)/);
});

test('tickets_md không dò ra cấu trúc: lỗi chỉ ra đọc từ dòng nào', () => {
  const md = ['', '   ', 'chỉ là một đoạn văn xuôi không có cấu trúc gì', 'và một dòng nữa'].join('\n');
  assert.throws(() => parseTickets(md), /Ðọc từ dòng 3: "chỉ là một đoạn văn xuôi/);
  assert.throws(() => parseTickets(md), /không dò ra ticket nào/);
  // Rỗng hẳn thì không có dòng nào để chỉ, và câu lỗi cũ vẫn đúng.
  assert.throws(() => parseTickets('   '), /tickets_md rỗng/);
});

test('job hỏng vì tickets_md: message đầy đủ tới được bên gọi', async () => {
  const done = await analyze({
    repo_url: repoUrl,
    tickets_md: '## A-1 — x\n\n## a-1 — x lần nữa',
  });
  assert.equal(done.status, 'failed');
  assert.match(done.error, /"A-1" \(dòng 1\) và "a-1" \(dòng 3\)/);
});

test('tiêu đề markdown một dòng có "(", "#", "|", tiếng Nhật vẫn ra đủ ticket', () => {
  const md = [
    '## WEB-1 — Thêm (SSO) cho web',
    '## WEB-2 — Sửa lỗi #500 khi upload',
    '## WEB-3 — Bảng | cột | mới',
    '## WEB-4 — ログイン画面を追加する',
    '## WEB-5: Có hai chấm | và gạch đứng',
  ].join('\n');
  const t = parseTickets(md);
  assert.equal(t.length, 5);
  assert.deepEqual(t.map((x) => x.key), ['WEB-1', 'WEB-2', 'WEB-3', 'WEB-4', 'WEB-5']);
  // `|` trong tiêu đề không được cắt key: dấu ngăn là dấu XUẤT HIỆN SỚM NHẤT,
  // không phải dấu đứng trước trong danh sách.
  assert.equal(t[2].title, 'Bảng | cột | mới');
  assert.equal(t[4].title, 'Có hai chấm | và gạch đứng');
});
