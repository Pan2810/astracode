/**
 * `tickets_subset` và `base_revision` — hai field làm mỏng một job analyze.
 *
 * Chạy bằng backend `none`: không key, không JWT, không CLI, không mạng. Cả hai
 * tính năng ở đây đều là chuyện tất định (lọc danh sách, và `git diff`), nên
 * không có lý do gì phải trả tiền model để kiểm chúng.
 *
 * Mỗi ca canh một kiểu hỏng đã thấy trước:
 *
 *   - Tập con không ăn (quét cả 190 ticket) — hoá đơn và thời gian vẫn như cũ.
 *   - Ticket ngoài tập BIẾN MẤT khỏi `items` — AstraQA đọc bảng thành
 *     "`tickets_md` chỉ có 6 ticket".
 *   - `base_revision` lạ đánh hỏng cả job — vứt đi phần phân tích đã chạy xong
 *     để đổi lấy một danh sách tệp phụ trợ.
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
const GIT_WHO = ['-c', 'user.email=t@e.invalid', '-c', 'user.name=t'];

let tmp;
let server;
let base;
let repoUrl;
/** Commit đầu — mốc so sánh trong các ca dưới. */
let baseSha;
/** Ticket key của cả bảng, và sáu key được xin. */
let allKeys;
const WANT = ['T-3', 'T-17', 'T-88', 'T-120', 'T-155', 'T-190'];

/** 190 ticket, đúng một dạng heading. */
function ticketsMd(keys) {
  return keys.map((k) => `## ${k} — viec ${k}\n\nStatus: Done\n`).join('\n');
}

before(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'astraqa-subset-'));
  const dir = path.join(tmp, 'repo');
  await fs.mkdir(path.join(dir, 'src'), { recursive: true });

  // ── commit 1: mốc base ──────────────────────────────────────────────
  await fs.writeFile(path.join(dir, 'src', 'login.py'), 'def authenticate(user, password):\n    return True\n');
  await fs.writeFile(path.join(dir, 'src', 'cache.py'), 'CACHE = {}\n\n\ndef cache_lookup(key):\n    return CACHE.get(key)\n');
  await fs.writeFile(path.join(dir, 'src', 'billing.py'), 'def invoice_total(items):\n    return 0\n');
  await fs.writeFile(path.join(dir, 'src', 'router.py'), 'ROUTES = {}\n');
  await fs.writeFile(path.join(dir, 'src', 'report.py'), 'def render_report(rows):\n    return ""\n');
  await run('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  await run('git', ['add', '-A'], { cwd: dir });
  await run('git', [...GIT_WHO, 'commit', '-q', '-m', 'moc base'], { cwd: dir });
  baseSha = (await run('git', ['rev-parse', 'HEAD'], { cwd: dir })).stdout.trim();

  // ── commit 2: đúng ba tệp đổi (một sửa, một thêm, một xoá) ──────────
  await fs.writeFile(path.join(dir, 'src', 'login.py'), 'def authenticate(user, password):\n    # T-3: man hinh dang nhap\n    return password == "x"\n');
  await fs.writeFile(path.join(dir, 'src', 'session.py'), '# T-17: phien dang nhap\n\n\ndef start_session(user):\n    return {"user": user}\n');
  await fs.rm(path.join(dir, 'src', 'report.py'));
  await run('git', ['add', '-A'], { cwd: dir });
  await run('git', [...GIT_WHO, 'commit', '-q', '-m', 'ba tep doi'], { cwd: dir });

  repoUrl = pathToFileURL(dir).href;
  allKeys = Array.from({ length: 190 }, (_, i) => `T-${i + 1}`);

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

test('tickets_subset 6/190: đúng 6 lượt quét, 184 ticket còn lại vẫn có mặt', async () => {
  const done = await analyze({
    run_id: 'SUB-1',
    repo_url: repoUrl,
    tickets_md: ticketsMd(allKeys),
    tickets_subset: WANT,
  });
  assert.equal(done.status, 'succeeded', done.error);

  // Ðúng sáu lượt quét — đây là chỗ tiết kiệm, và cũng là chỗ dễ hỏng thầm lặng nhất.
  assert.equal(done.result.stats.judge_calls, 6);
  assert.equal(done.result.stats.judge_parsed, 6);
  assert.equal(done.result.stats.tickets_subset, 6);
  assert.equal(done.result.stats.tickets_out_of_subset, 184);
  assert.equal(done.result.stats.tickets_total, 190);

  // Cả bảng vẫn về đủ: bỏ qua không phải là biến mất.
  assert.equal(done.result.items.length, 190);
  const judged = done.result.items.filter((i) => i.reason !== 'not_in_subset');
  const untouched = done.result.items.filter((i) => i.reason === 'not_in_subset');
  assert.equal(judged.length, 6);
  assert.equal(untouched.length, 184);
  assert.deepEqual(judged.map((i) => i.key).sort(), [...WANT].sort());

  // Sáu ticket được xin có kết luận thật; `scan` có mặt để AstraQA được phép
  // kết luận JIRA_AHEAD.
  for (const it of judged) {
    assert.ok(['done', 'partial', 'missing'].includes(it.code_status));
    assert.notEqual(it.scan, null);
  }
  // 184 ticket kia là "không được xét lần này", KHÔNG phải "đã xét và thấy thiếu".
  for (const it of untouched) {
    assert.equal(it.code_status, 'missing');
    assert.equal(it.confidence, 0);
    assert.equal(it.scan, null, 'chưa quét thì scan phải là null');
    assert.deepEqual(it.evidence, []);
  }
  // Báo cáo nói ra sự khác nhau ấy bằng chữ, không chỉ bằng field.
  assert.match(done.result.report_md, /KHÔNG QUÉT/);
  assert.match(done.result.report_md, /không được xét lần này/);
  assert.match(done.result.report_md, /tickets_subset: xin 6 key/);

  // Không hỏi base thì hai field kia là null, và không có cảnh báo nào.
  assert.equal(done.result.base_revision, null);
  assert.equal(done.result.changed_files, null);
  assert.deepEqual(done.result.warnings, []);
});

test('base_revision: changed_files đúng ba tệp của commit sau', async () => {
  const done = await analyze({
    run_id: 'SUB-2',
    repo_url: repoUrl,
    tickets_md: ticketsMd(['T-3']),
    base_revision: baseSha,
  });
  assert.equal(done.status, 'succeeded', done.error);

  // Bản clone là --depth 1 nên base KHÔNG có sẵn: ca này đi qua đúng đường đào
  // thêm lịch sử. Hỏng đường ấy thì `changed_files` thành null và test rơi.
  assert.equal(done.result.base_revision, baseSha);
  assert.deepEqual([...done.result.changed_files].sort(), ['src/login.py', 'src/report.py', 'src/session.py']);
  assert.deepEqual(done.result.warnings, []);
  assert.match(done.result.report_md, new RegExp(`base_revision: \`${baseSha}\``));
  assert.match(done.result.report_md, /3 tệp đổi tới HEAD/);
});

test('base_revision lạ: changed_files null kèm cảnh báo, job vẫn succeeded', async () => {
  const done = await analyze({
    run_id: 'SUB-3',
    repo_url: repoUrl,
    tickets_md: ticketsMd(['T-3', 'T-17']),
    base_revision: '0123456789abcdef0123456789abcdef01234567',
  });
  // Cả job KHÔNG được hỏng vì một mốc so sánh không tìm thấy.
  assert.equal(done.status, 'succeeded', done.error);
  assert.equal(done.result.changed_files, null);
  assert.equal(done.result.base_revision, null);
  assert.equal(done.result.warnings.length, 1);
  assert.match(done.result.warnings[0], /base_revision "0123456789abcdef0123456789abcdef01234567"/);
  assert.match(done.result.warnings[0], /changed_files là null/);
  // Phần phân tích vẫn chạy đủ — đó là cả lý do không ném.
  assert.equal(done.result.items.length, 2);
  assert.equal(done.result.stats.judge_parsed, 2);
  // Cảnh báo phải NHÌN THẤY ÐƯỢC trong báo cáo, không chỉ nằm trong JSON.
  assert.match(done.result.report_md, /\*\*Cảnh báo:\*\*/);
});

test('key trong tickets_subset mà tickets_md không có: cảnh báo, không hỏng', async () => {
  const done = await analyze({
    run_id: 'SUB-4',
    repo_url: repoUrl,
    tickets_md: ticketsMd(['T-3', 'T-17']),
    tickets_subset: ['T-3', 'KHONG-CO-1', 'KHONG-CO-2'],
  });
  assert.equal(done.status, 'succeeded', done.error);
  assert.equal(done.result.stats.judge_calls, 1, 'chỉ key có thật mới được quét');
  assert.equal(done.result.items.length, 2);
  assert.equal(done.result.warnings.length, 1);
  assert.match(done.result.warnings[0], /2 key không có trong tickets_md/);
  assert.match(done.result.warnings[0], /KHONG-CO-1/);
});

test('tickets_subset không khớp ai: nói ra, chứ không im lặng trả bảng trắng', async () => {
  const done = await analyze({
    repo_url: repoUrl,
    tickets_md: ticketsMd(['T-3', 'T-17']),
    tickets_subset: ['KHONG-CO-1'],
  });
  assert.equal(done.status, 'succeeded', done.error);
  assert.equal(done.result.stats.judge_calls, 0);
  assert.equal(done.result.items.length, 2);
  assert.ok(done.result.warnings.some((w) => /không khớp ticket nào/.test(w)));
});

test('sai kiểu thì 400 ngay, không thành một job chạy tới lúc clone xong mới chết', async () => {
  const cases = [
    [{ tickets_subset: 'T-3' }, /"tickets_subset" phải là một mảng key/],
    [{ tickets_subset: [] }, /bỏ hẳn field nếu muốn quét tất cả/],
    [{ base_revision: 42 }, /"base_revision" phải là một chuỗi/],
  ];
  for (const [extra, re] of cases) {
    const res = await post({ repo_url: repoUrl, tickets_md: ticketsMd(['T-3']), ...extra });
    assert.equal(res.status, 400, JSON.stringify(extra));
    assert.match((await res.json()).error, re);
  }
});

/*
 * Tiến độ phải đếm VIỆC PHẢI LÀM.
 *
 * Ðo trên lần chạy thật 2026-09-21: một request gửi 184 ticket kèm
 * `tickets_subset` 8 key báo về `{"done":1,"total":184}` — người ngồi xem
 * tưởng còn 183 lượt nữa, trong khi chỉ có 8 lượt phải chạy.
 */
test('progress.total là số lượt PHẢI QUÉT, không phải số ticket gửi lên', async () => {
  const { job_id } = await post({
    run_id: 'SUB-PROGRESS',
    repo_url: repoUrl,
    tickets_md: ticketsMd(allKeys),
    tickets_subset: WANT,
  }).then((r) => r.json());

  // Chờ tới khi job ÐÓNG SỔ, và nói ra nếu không — bản trước bỏ cuộc sau 10s
  // rồi vẫn đi kiểm tiếp, nên dưới tải song song nó đọc một tiến độ dở dang.
  let xong = null;
  for (let i = 0; i < 1200 && !xong; i++) {
    const j = await fetch(`${base}/api/v1/analyze/${job_id}`).then((r) => r.json());
    if (j.status === 'succeeded' || j.status === 'failed') {
      xong = j;
      break;
    }
    if (j.progress) {
      assert.equal(j.progress.total, WANT.length, `total phải là ${WANT.length}, nhận ${j.progress.total}`);
      assert.ok(j.progress.done <= j.progress.total, 'done không bao giờ vượt total');
    }
    await new Promise((s) => setTimeout(s, 25));
  }
  assert.ok(xong, 'job phải đóng sổ trong thời gian chờ');
  assert.equal(xong.status, 'succeeded', xong.error);

  // Sau khi xong, sổ /admin vẫn giữ tiến độ cuối — chỗ kiểm được tất định.
  const rows = await fetch(`${base}/api/v1/jobs`, { headers: { Accept: 'application/json' } }).then((r) => r.json());
  const row = rows.jobs.find((x) => x.run_id === 'SUB-PROGRESS');
  assert.ok(row, 'phải có dòng cho run này');
  assert.equal(row.progress.done, WANT.length);
  assert.equal(row.progress.total, WANT.length);
  // Bốn ô nói vì sao total nhỏ hơn số ticket, để bên gọi không phải tự trừ.
  assert.equal(row.progress.tickets, 190);
  assert.equal(row.progress.not_in_subset, 184);
  assert.equal(row.progress.skipped_quota_limit, 0);
  assert.equal(row.progress.cancelled, 0);
});
