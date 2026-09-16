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
import { buildIndex, queryTerms, discriminating } from '../lib/candidates.mjs';
import { matchesAny } from '../lib/globs.mjs';

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
  // Ðủ file mã nguồn để document_frequency có nghĩa (§4.2). `README.md` cố ý
  // KHÔNG còn: §3.1 dùng allowlist đuôi mã nguồn nên tài liệu không được quét.
  await fs.writeFile(
    path.join(repoDir, 'src', 'login.py'),
    'import hashlib\n\n\ndef authenticate(username, password):\n    """man hinh dang nhap"""\n    return hashlib.sha256(password.encode()).hexdigest()\n',
  );
  await fs.writeFile(path.join(repoDir, 'src', 'cache.py'), 'CACHE = {}\n\n\ndef cache_lookup(key):\n    return CACHE.get(key)\n');
  await fs.writeFile(path.join(repoDir, 'src', 'billing.py'), 'def invoice_total(items):\n    return sum(i.amount for i in items)\n');
  await fs.writeFile(path.join(repoDir, 'src', 'report.py'), 'def render_report(rows):\n    return len(rows)\n');
  await fs.writeFile(path.join(repoDir, 'src', 'upload.py'), 'def store_attachment(blob):\n    return len(blob)\n');
  await fs.writeFile(path.join(repoDir, 'src', 'router.py'), 'ROUTES = {}\n\n\ndef dispatch(route):\n    return ROUTES.get(route)\n');
  // Thư mục để kiểm `files_scanned` đếm SAU khi áp exclude_globs. Cố ý KHÔNG đặt
  // tên `dist`/`build`/`vendor`: §3.1 có danh sách thư mục loại cứng, luôn bị bỏ
  // bất kể exclude_globs, nên các tên đó không đo được tác dụng của glob.
  await fs.mkdir(path.join(repoDir, 'generated'), { recursive: true });
  for (let i = 0; i < 5; i++) {
    await fs.writeFile(path.join(repoDir, 'generated', `helper${i}.js`), `export function helper${i}(x) {\n  return x + ${i};\n}\n`);
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

/**
 * Ticket thứ hai cố ý dùng hai từ ÐỀU CÓ trong repo nhưng nằm ở hai file khác
 * nhau (`invoice` ở billing.py, `attachment` ở upload.py). Nhờ vậy `scan.terms`
 * không rỗng — chứng minh phép quét đã chạy thật — mà không file nào đạt sàn
 * `_MIN_TERMS = 2`, nên shortlist rỗng. Ðó đúng là hình dạng một dòng JIRA_AHEAD.
 */
const HAI_TICKET =
  '## WEB-1001 — authenticate password hashing\n\nStatus: Done\n\n## ZZZ-999 — invoice attachment\n\nStatus: To Do';

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

test('[2] scan.terms là term THẬT sau mọi bộ lọc, không phải mọi từ trong ticket', async () => {
  const ticket = {
    key: 'WEB-1001',
    title: 'authenticate password hashing',
    body: ['Status: Done', 'PO: NguyenVanA'].join('\n'),
  };
  const index = await buildIndex({ repoDir, fs, path, excludeGlobs: ['**/generated/**'], matchesAny });
  const r = await judgeWithoutModel({ ticket, options: { max_files_per_ticket: 5 }, index });

  const { terms: sauLoc } = discriminating(queryTerms(ticket), index.df, index.N);
  // Ðúng tập term mà `shortlistFor` dùng để chấm — không phải bản sao gần đúng.
  assert.deepEqual(r.scan.terms, sauLoc);

  // §1.1 — siêu dữ liệu quản trị KHÔNG được thành từ khoá.
  for (const rac of ['status', 'done']) {
    assert.ok(!r.scan.terms.includes(rac), `"${rac}" là metadata, không được vào terms`);
  }
  // §1.2 — tên người trong dòng `PO:` cũng vậy.
  assert.ok(!r.scan.terms.includes('nguyenvana'), 'tên người không được thành từ khoá');
  // §1.3 — mảnh của ticket key không bao giờ được lọt vào.
  assert.ok(!r.scan.terms.includes('web'), 'mảnh của ticket key không được vào terms');
});

test('[2] files_scanned đếm SAU khi áp exclude_globs', async () => {
  const ticket = { key: 'CACHE-1', title: 'cache lookup', body: '' };
  const opts = { max_files_per_ticket: 5 };

  const idxLoai = await buildIndex({ repoDir, fs, path, excludeGlobs: ['**/generated/**'], matchesAny });
  const idxGiu = await buildIndex({ repoDir, fs, path, excludeGlobs: [], matchesAny });
  const loai = await judgeWithoutModel({ ticket, options: opts, index: idxLoai });
  const giu = await judgeWithoutModel({ ticket, options: opts, index: idxGiu });

  // repo có 6 file .py + 5 file .js trong generated/ (cả hai đuôi đều nằm trong
  // allowlist §3.1, nên chênh lệch đúng là do glob chứ không do đuôi file).
  assert.equal(loai.scan.files_scanned, 6, 'loại generated/ thì chỉ còn 6 file .py');
  assert.equal(giu.scan.files_scanned, 11, 'giữ generated/ thì đếm cả 5 file .js kia');
});

test('[2] files_scanned là TOÀN BỘ corpus đã lọc — không dừng sớm giữa chừng', async () => {
  // Bản trước dừng quét khi đủ `maxSnippets`, nên `files_scanned` phụ thuộc
  // ticket. Từ khi theo CANDIDATE_MATCHING_SPEC, index đọc hết corpus một lần và
  // `document_frequency` mới có nghĩa — `files_scanned` vì thế là một con số của
  // REPO, giống nhau cho mọi ticket. Spec §6 ca C trông cậy đúng vào điều này
  // (`files_scanned: 154` cho một ticket không khớp gì cả).
  const nhieu = path.join(tmp, 'repo-nhieu');
  await fs.mkdir(nhieu, { recursive: true });
  for (let i = 0; i < 40; i++) {
    await fs.writeFile(path.join(nhieu, `mod${i}.py`), `def handler_${i}(payload):\n    return payload\n`);
  }
  const index = await buildIndex({ repoDir: nhieu, fs, path, excludeGlobs: [], matchesAny });
  assert.equal(index.N, 40, 'phải đọc hết 40 file, không dừng sớm');

  // Cùng một index → mọi ticket khai cùng một `files_scanned`, kể cả ticket
  // khớp nhiều lẫn ticket không khớp gì.
  const khop = await judgeWithoutModel({ ticket: { key: 'K-1', title: 'handler payload' }, options: {}, index });
  const truot = await judgeWithoutModel({ ticket: { key: 'K-2', title: 'quantum blockchain sharding' }, options: {}, index });
  assert.equal(khop.scan.files_scanned, 40);
  assert.equal(truot.scan.files_scanned, 40);
  assert.deepEqual(truot.items[0].evidence, [], 'ticket không liên quan phải cho shortlist rỗng');
});

test('[2] file tài liệu, minified và generated KHÔNG được vào corpus (§3.1, §3.3)', async () => {
  const loc = path.join(tmp, 'repo-loc');
  await fs.mkdir(path.join(loc, 'assets'), { recursive: true });
  await fs.writeFile(path.join(loc, 'thuc.py'), 'def handler(payload):\n    return payload\n');
  // Tài liệu: ngoài allowlist đuôi.
  await fs.writeFile(path.join(loc, 'README.md'), '# handler payload\n');
  await fs.writeFile(path.join(loc, 'notes.txt'), 'handler payload\n');
  // Minified: khớp marker trong tên file.
  await fs.writeFile(path.join(loc, 'assets', 'd3.min.js'), 'var handler=function(payload){return payload}\n');
  // Generated: tên bình thường nhưng dòng dài — bắt bằng §3.3.
  await fs.writeFile(path.join(loc, 'assets', 'bundle_lon.js'), `var x=${'"handler payload",'.repeat(400)}0;\n`);

  const index = await buildIndex({ repoDir: loc, fs, path, excludeGlobs: [], matchesAny });
  assert.deepEqual(index.files.map((f) => f.path), ['thuc.py'], `corpus lạ: ${index.files.map((f) => f.path)}`);
  assert.equal(index.N, 1);
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
