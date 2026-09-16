/**
 * Hợp đồng v1.1 — bản ghi quét.
 *
 * Lý do tồn tại, ghi lại để đừng ai gỡ: đo thật trên 184 ticket cho ra 140
 * `JIRA_AHEAD` mà 138 là giả, chỉ vì `evidence: []` một mình không phân biệt
 * được "đã quét thật, không thấy gì" với "chưa quét lần nào". `scan` là chỗ
 * phân biệt đó, nên nó phải có mặt ở MỌI item — `null` cũng là một câu trả lời.
 *
 * Bốn điều được canh:
 *   [1] `result.source_revision` là SHA đầy đủ 40 ký tự.
 *   [2] mọi item có field `scan`; `scan != null` thì đủ ba field và số liệu thật.
 *   [3] ngữ nghĩa mới của backend `none` (có evidence → done 0.25).
 *   [5] field cũ còn nguyên — client cũ đọc được response mới.
 *
 * Chạy offline bằng backend `none`, KHÔNG gọi model.
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
import { judgeWithoutModel } from '../lib/noneJudge.mjs';
import { buildRepoContext } from '../lib/repoContext.mjs';

const run = promisify(execFile);
const TOKEN = 'service-token-v11-0123456789';

let tmp;
let server;
let base;
let repoUrl;
let repoDir;
let repoSha;

before(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'astraqa-v11-'));
  repoDir = path.join(tmp, 'repo');
  await fs.mkdir(path.join(repoDir, 'src'), { recursive: true });
  await fs.writeFile(path.join(repoDir, 'src', 'login.py'), 'def login(user):\n    """man hinh dang nhap"""\n    return True\n');
  await fs.writeFile(path.join(repoDir, 'src', 'cache.py'), 'CACHE = {}\n\n\ndef cache_get(k):\n    return CACHE.get(k)\n');
  await fs.writeFile(path.join(repoDir, 'README.md'), '# demo\n\nWEB-1001 lam o src/login.py\n');
  // Thư mục để kiểm `files_scanned` đếm SAU khi áp exclude_globs. Cố ý KHÔNG đặt
  // tên `dist`: `repoContext` có SKIP_DIRS cứng (.git, node_modules, .venv,
  // __pycache__, dist, build, .next, vendor) luôn bị bỏ bất kể exclude_globs, nên
  // `dist` sẽ không đo được tác dụng của glob.
  await fs.mkdir(path.join(repoDir, 'generated'), { recursive: true });
  for (let i = 0; i < 5; i++) {
    await fs.writeFile(path.join(repoDir, 'generated', `bundle${i}.js`), 'console.log("login cache")\n');
  }
  await run('git', ['init', '-q', '-b', 'main'], { cwd: repoDir });
  await run('git', ['add', '-A'], { cwd: repoDir });
  await run('git', ['-c', 'user.email=t@e.invalid', '-c', 'user.name=t', 'commit', '-q', '-m', 'i'], { cwd: repoDir });
  repoSha = (await run('git', ['rev-parse', 'HEAD'], { cwd: repoDir })).stdout.trim();
  repoUrl = pathToFileURL(repoDir).href;

  server = createServer(
    {
      port: 0,
      workspaceDir: path.join(tmp, 'ws'),
      runsDir: path.join(tmp, 'runs'),
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
    { log: () => {}, persist: false },
  );
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((r) => server.close(r));
  await fs.rm(tmp, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
});

async function analyze(body) {
  const { job_id } = await (
    await fetch(`${base}/api/v1/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify(body),
    })
  ).json();
  for (let i = 0; i < 400; i++) {
    const j = await (await fetch(`${base}/api/v1/analyze/${job_id}`, { headers: { Authorization: `Bearer ${TOKEN}` } })).json();
    if (j.status === 'succeeded' || j.status === 'failed') return j;
    await new Promise((s) => setTimeout(s, 25));
  }
  throw new Error('job không kết thúc');
}

const HAI_TICKET =
  '## WEB-1001 — them man hinh dang nhap\n\nStatus: Done\n\n## ZZZ-999 — viec khong ai lam bao gio\n\nStatus: To Do';

test('[1] result.source_revision là SHA đầy đủ của commit đã clone', async () => {
  const done = await analyze({ run_id: 'V11-REV', repo_url: repoUrl, tickets_md: HAI_TICKET });
  assert.equal(done.status, 'succeeded', done.error);
  assert.equal(done.result.source_revision, repoSha);
  assert.match(done.result.source_revision, /^[0-9a-f]{40}$/, 'phải là SHA đầy đủ, không rút gọn');
});

test('[2] MỌI item có field scan — kể cả item evidence rỗng', async () => {
  const done = await analyze({ run_id: 'V11-SCAN', repo_url: repoUrl, tickets_md: HAI_TICKET });
  assert.equal(done.status, 'succeeded', done.error);
  const [hit, miss] = done.result.items;

  for (const it of done.result.items) {
    assert.ok('scan' in it, `item ${it.key} thiếu hẳn field scan — client không phân biệt được với null`);
  }

  // Ticket CÓ evidence.
  assert.ok(hit.scan, 'item có evidence phải có bản ghi quét');
  assert.equal(typeof hit.scan.files_scanned, 'number');
  assert.ok(Number.isInteger(hit.scan.files_scanned) && hit.scan.files_scanned > 0);
  assert.ok(Array.isArray(hit.scan.terms) && hit.scan.terms.length > 0);
  assert.equal(hit.scan.revision, repoSha, 'revision lặp lại để item tự chứa');

  // Ticket KHÔNG có evidence — đây mới là lúc bản ghi quét quan trọng nhất.
  assert.deepEqual(miss.evidence, []);
  assert.ok(miss.scan, 'item evidence rỗng PHẢI có bản ghi quét — đó là cả lý do v1.1 tồn tại');
  assert.ok(miss.scan.files_scanned > 0, 'phải chứng minh được đã quét thật');
  assert.ok(miss.scan.terms.length > 0);
  assert.equal(miss.scan.revision, repoSha);

  // Ðây chính là cặp điều kiện AstraQA dùng để ra JIRA_AHEAD.
  assert.ok(miss.scan !== null && miss.scan.files_scanned > 0 && miss.evidence.length === 0,
    'ZZZ-999 phải thoả đúng ba điều kiện JIRA_AHEAD');
});

test('[2] scan.terms là từ khoá THẬT đã dùng, không phải danh sách dựng lại', async () => {
  const ticket = { key: 'WEB-1001', title: 'them man hinh dang nhap', body: '' };
  const ctx = await buildRepoContext({ repoDir, ticket, excludeGlobs: ['**/generated/**'], maxSnippets: 60 });
  const r = await judgeWithoutModel({ ticket, options: { exclude_globs: ['**/generated/**'], max_files_per_ticket: 5 }, repoDir });

  // Cùng một mảng mà `buildRepoContext` dùng để dò từng dòng — không phải bản sao gần đúng.
  assert.deepEqual(r.scan.terms, ctx.keywords);
  assert.ok(r.scan.terms.includes('web-1001'), 'phải có key nguyên văn');
  // Và mọi từ khoá trong evidence phải nằm trong danh sách đã khai.
  for (const ev of r.items[0].evidence) {
    const dung = /khớp từ khoá "([^"]+)"/.exec(ev.note)?.[1];
    assert.ok(r.scan.terms.includes(dung), `từ khoá "${dung}" không có trong scan.terms`);
  }
});

test('[2] files_scanned đếm SAU khi áp exclude_globs', async () => {
  const opts = { max_files_per_ticket: 5 };
  const ticket = { key: 'CACHE-1', title: 'cache login', body: '' };

  const loai = await judgeWithoutModel({ ticket, options: { ...opts, exclude_globs: ['**/generated/**'] }, repoDir });
  const giu = await judgeWithoutModel({ ticket, options: { ...opts, exclude_globs: [] }, repoDir });

  // repo có 3 file nguồn + 5 file trong generated/.
  assert.equal(loai.scan.files_scanned, 3, 'loại generated/ thì chỉ còn 3 file');
  assert.equal(giu.scan.files_scanned, 8, 'giữ generated/ thì đếm cả 5 file kia');
  assert.ok(giu.scan.files_scanned > loai.scan.files_scanned);
});

test('[2] files_scanned là số file ÐÃ MỞ, không phải số file ứng viên', async () => {
  // `maxSnippets` làm vòng quét dừng sớm; con số phải phản ánh thực tế đó chứ
  // không phải kích thước corpus.
  const nhieu = path.join(tmp, 'repo-nhieu');
  await fs.mkdir(nhieu, { recursive: true });
  for (let i = 0; i < 40; i++) await fs.writeFile(path.join(nhieu, `f${i}.txt`), 'login login login\n'.repeat(5));

  const ctx = await buildRepoContext({ repoDir: nhieu, ticket: { key: 'K-1', title: 'login' }, excludeGlobs: [], maxSnippets: 10 });
  assert.equal(ctx.totalFiles, 40, 'có 40 file ứng viên');
  assert.ok(ctx.scannedFiles < 40, `dừng sớm thì scannedFiles phải nhỏ hơn 40, nhận ${ctx.scannedFiles}`);
  assert.ok(ctx.scannedFiles > 0);
  assert.equal(ctx.scanTruncated, true);
});

test('[3] có evidence → done 0.25; không evidence nhưng đã quét → missing kèm scan', async () => {
  const done = await analyze({ run_id: 'V11-NGHIA', repo_url: repoUrl, tickets_md: HAI_TICKET });
  const [hit, miss] = done.result.items;

  assert.equal(hit.code_status, 'done');
  assert.equal(hit.confidence, 0.25, 'confidence thấp là chỗ nói "chỉ là quét từ khoá"');
  assert.ok(hit.evidence.length > 0);
  for (const ev of hit.evidence) {
    // "path thật" nghĩa là file có thật trong repo — bộ lọc cũ vẫn canh việc này.
    assert.ok(['README.md', 'src/login.py', 'src/cache.py'].includes(ev.path), `đường dẫn lạ: ${ev.path}`);
  }

  assert.equal(miss.code_status, 'missing');
  assert.ok(miss.scan && miss.scan.files_scanned > 0);
});

test('[3] không quét được file nào → missing và scan null, KHÔNG phải files_scanned 0', async () => {
  const rong = path.join(tmp, 'repo-rong');
  await fs.mkdir(rong, { recursive: true });
  await fs.writeFile(path.join(rong, 'anh.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  await run('git', ['init', '-q', '-b', 'main'], { cwd: rong });
  await run('git', ['add', '-A'], { cwd: rong });
  await run('git', ['-c', 'user.email=t@e.invalid', '-c', 'user.name=t', 'commit', '-q', '-m', 'i'], { cwd: rong });

  const done = await analyze({ run_id: 'V11-RONG', repo_url: pathToFileURL(rong).href, tickets_md: '## K-1 — viec gi do' });
  assert.equal(done.status, 'succeeded', done.error);
  const it = done.result.items[0];
  assert.equal(it.code_status, 'missing');
  assert.equal(it.scan, null, 'không quét được thì phải null — "files_scanned: 0" trông như đã quét xong');
  assert.deepEqual(it.evidence, []);
});

test('[3] ticket judge_failed và skipped_quota_limit đều mang scan null', async () => {
  // Trần ticket: ticket thứ hai chưa được xét lần nào.
  const s = createServer(
    {
      port: 0,
      workspaceDir: path.join(tmp, 'ws-tran'),
      runsDir: path.join(tmp, 'runs'),
      cliPath: 'x',
      astraworkJwt: '',
      serviceToken: TOKEN,
      judgeBackend: 'none',
      fciBaseUrl: '',
      fciApiKey: '',
      fciModel: '',
      judgeConcurrency: 2,
      maxTickets: 1,
    },
    { log: () => {}, persist: false },
  );
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const b = `http://127.0.0.1:${s.address().port}`;
  try {
    const { job_id } = await (
      await fetch(`${b}/api/v1/analyze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({ run_id: 'V11-TRAN', repo_url: repoUrl, tickets_md: HAI_TICKET }),
      })
    ).json();
    let done;
    for (let i = 0; i < 400; i++) {
      done = await (await fetch(`${b}/api/v1/analyze/${job_id}`, { headers: { Authorization: `Bearer ${TOKEN}` } })).json();
      if (done.status === 'succeeded' || done.status === 'failed') break;
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.equal(done.status, 'succeeded', done.error);
    const [daXet, boQua] = done.result.items;
    assert.ok(daXet.scan, 'ticket đã xét phải có bản ghi quét');
    assert.equal(boQua.reason, 'skipped_quota_limit');
    assert.equal(boQua.scan, null, 'ticket chưa xét thì chưa quét — phải null, không được là JIRA_AHEAD');
  } finally {
    await new Promise((r) => s.close(r));
  }
});

test('[5] field cũ còn nguyên — client cũ đọc được response mới', async () => {
  const done = await analyze({ run_id: 'V11-CU', repo_url: repoUrl, tickets_md: HAI_TICKET });
  const r = done.result;

  // Sáu field cũ của result, không thiếu không đổi tên.
  for (const f of ['run_id', 'generated_at', 'backend', 'items', 'report_md', 'stats']) {
    assert.ok(f in r, `result mất field cũ "${f}"`);
  }
  // Năm field cũ của item.
  for (const it of r.items) {
    for (const f of ['key', 'code_status', 'confidence', 'evidence', 'reason']) {
      assert.ok(f in it, `item ${it.key} mất field cũ "${f}"`);
    }
    assert.ok(['done', 'partial', 'missing'].includes(it.code_status), 'code_status vẫn đúng ba giá trị cũ');
    assert.ok(it.confidence >= 0 && it.confidence <= 1);
    for (const ev of it.evidence) {
      for (const f of ['path', 'lines', 'note']) assert.ok(f in ev, `evidence mất field cũ "${f}"`);
    }
  }
  // Giá trị `reason` cũ không bị đổi tên — client cũ đang so chuỗi.
  assert.ok(r.items.some((i) => ['matched_by_key', 'matched_by_summary', 'no_match'].includes(i.reason)));

  // stats cũ còn nguyên, và có thêm hai bộ đếm mới.
  for (const f of ['judge_calls', 'judge_parsed', 'evidence_kept', 'evidence_dropped', 'evidence_clamped', 'duration_ms']) {
    assert.ok(f in r.stats, `stats mất field cũ "${f}"`);
  }
  assert.equal(r.stats.items_with_scan + r.stats.items_without_scan, r.items.length);
});

test('report_md ghi bản ghi quét, và phân biệt hai loại "không thấy gì"', async () => {
  const done = await analyze({ run_id: 'V11-BAOCAO', repo_url: repoUrl, tickets_md: HAI_TICKET });
  const md = done.result.report_md;
  assert.match(md, /commit \(source_revision\)/);
  assert.match(md, new RegExp(repoSha));
  assert.match(md, /đã quét \*\*\d+ file\*\*/);
  assert.match(md, /từ khoá:/);
});

test('dựng được link dẫn chứng từ source_revision + evidence.path + lines', async () => {
  const done = await analyze({ run_id: 'V11-LINK', repo_url: repoUrl, tickets_md: HAI_TICKET });
  const r = done.result;
  const hit = r.items.find((i) => i.evidence.length > 0);
  const ev = hit.evidence[0];

  // Ðủ ba mảnh để ghép một URL kiểu GitHub blob — và file phải có thật ở đúng dòng đó.
  const link = `<repo>/blob/${r.source_revision}/${ev.path}#L${ev.lines}`;
  assert.match(link, /\/blob\/[0-9a-f]{40}\/.+#L\d+$/);

  const noiDung = await fs.readFile(path.join(repoDir, ev.path), 'utf8');
  const soDong = noiDung.split(/\r?\n/).length;
  const dong = Number(String(ev.lines).split('-')[0]);
  assert.ok(dong >= 1 && dong <= soDong, `dòng ${dong} nằm ngoài ${ev.path} (${soDong} dòng)`);
});
