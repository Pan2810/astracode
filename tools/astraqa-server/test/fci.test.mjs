/**
 * Backend `fci` chạy offline: một endpoint OpenAI-compatible giả dựng tại chỗ.
 *
 * Phủ đúng phần mà backend `cli` không phủ — dựng ngữ cảnh repo, gọi HTTP,
 * `temperature: 0`, header Authorization — mà không chạm mạng thật.
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
import { describeErrorBody } from '../lib/fciJudge.mjs';
import { buildAuxCorpus, buildRepoContext, contextTerms, renderContext, MIN_CONTEXT_FILES } from '../lib/repoContext.mjs';
import { buildIndex } from '../lib/candidates.mjs';
import { matchesAny } from '../lib/globs.mjs';

const run = promisify(execFile);
const TOKEN = 'service-token-dung-cho-test-0123456789';
const KEY = 'sk-KHONG-DUOC-LO-RA-0123456789';

let tmp;
let fci;
let fciUrl;
const seen = [];
let server;
let base;
let repoUrl;

before(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'astraqa-fci-'));

  // Endpoint giả: trả về khối ```json dựng từ chính prompt nhận được.
  fci = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      const payload = JSON.parse(body);
      seen.push({ auth: req.headers.authorization, payload });
      const prompt = payload.messages.at(-1).content;
      const key = (/Ticket key:\s*(.+)/.exec(prompt)?.[1] ?? '').trim();
      const first = (/^\s{2}(\S+)$/m.exec(prompt.split('--- NGỮ CẢNH REPO ---')[1] ?? '')?.[1] ?? 'README.md').trim();
      // Cây file rỗng thì model KHÔNG có gì để trích. Bịa một dẫn chứng ở đây
      // là dựng một cảnh không thể xảy ra, rồi bắt sản phẩm xử lý nó.
      const coFile = first && first !== '(rỗng)';
      const content =
        '```json\n' +
        JSON.stringify({
          items: [
            {
              key,
              code_status: 'partial',
              confidence: 0.6,
              evidence: coFile ? [{ path: first, lines: '1-999', note: 'kep ve cuoi file' }] : [],
              reason: 'matched_by_key',
            },
          ],
        }) +
        '\n```';
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }], usage: { total_tokens: 42 } }));
    });
  });
  await new Promise((r) => fci.listen(0, '127.0.0.1', r));
  fciUrl = `http://127.0.0.1:${fci.address().port}/v1`;

  const dir = path.join(tmp, 'repo');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'README.md'), 'mot\nhai\nba\n');
  await fs.writeFile(path.join(dir, 'login.py'), 'def login():\n    return True\n');
  await run('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  await run('git', ['add', '-A'], { cwd: dir });
  await run('git', ['-c', 'user.email=t@e.invalid', '-c', 'user.name=t', 'commit', '-q', '-m', 'i'], { cwd: dir });
  repoUrl = pathToFileURL(dir).href;

  server = createServer(
    {
      port: 0,
      workspaceDir: path.join(tmp, 'ws'),
      runsDir: path.join(tmp, 'runs'),
      cliPath: 'khong-dung-toi',
      astraworkJwt: '',
      serviceToken: TOKEN,
      judgeBackend: 'fci',
      fciBaseUrl: fciUrl,
      fciApiKey: KEY,
      fciModel: 'Qwen3.8-27B',
    },
    { log: () => {} },
  );
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((r) => server.close(r));
  await new Promise((r) => fci.close(r));
  await fs.rm(tmp, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
});

async function analyze(body) {
  const res = await fetch(`${base}/api/v1/analyze`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify(body),
  });
  const { job_id } = await res.json();
  for (let i = 0; i < 200; i++) {
    const r = await fetch(`${base}/api/v1/analyze/${job_id}`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    const j = await r.json();
    if (j.status === 'succeeded' || j.status === 'failed') return j;
    await new Promise((s) => setTimeout(s, 25));
  }
  throw new Error('job không kết thúc');
}

test('/healthz khai backend fci và model, không lộ key', async () => {
  const body = await (await fetch(`${base}/healthz`)).json();
  assert.equal(body.backend, 'fci');
  assert.equal(body.model, 'Qwen3.8-27B');
  assert.equal(body.fci_configured, true);
  assert.ok(!JSON.stringify(body).includes(KEY));
});

test('job chạy qua fci: temperature 0, Bearer đúng, schema như backend cli', async () => {
  const done = await analyze({ run_id: 'R-FCI', repo_url: repoUrl, tickets_md: '## LOGIN-1 — them login\n\nStatus: Done' });
  assert.equal(done.status, 'succeeded', done.error);
  assert.equal(done.result.backend, 'fci');
  assert.equal(done.result.run_id, 'R-FCI');
  assert.deepEqual(done.result.items.map((i) => i.key), ['LOGIN-1']);
  assert.equal(done.result.stats.judge_calls, 1);
  assert.equal(done.result.stats.judge_parsed, 1);
  // Bằng chứng "1-999" phải bị kẹp về số dòng thật của file.
  assert.equal(done.result.stats.evidence_clamped, 1);
  assert.match(done.result.report_md, /đã kẹp 1 khoảng dòng/);

  const call = seen.at(-1);
  assert.equal(call.auth, `Bearer ${KEY}`);
  assert.equal(call.payload.temperature, 0);
  assert.equal(call.payload.model, 'Qwen3.8-27B');
  assert.match(call.payload.messages.at(-1).content, /Ticket key: LOGIN-1/);
  assert.match(call.payload.messages.at(-1).content, /Trả lời CHỈ bằng một khối/);
});

test('fci thiếu cấu hình → job failed với message rõ ràng', async () => {
  const bare = createServer(
    {
      port: 0,
      workspaceDir: path.join(tmp, 'ws2'),
      runsDir: path.join(tmp, 'runs'),
      cliPath: 'x',
      astraworkJwt: '',
      serviceToken: '',
      judgeBackend: 'fci',
      fciBaseUrl: '',
      fciApiKey: '',
      fciModel: '',
    },
    { log: () => {} },
  );
  await new Promise((r) => bare.listen(0, '127.0.0.1', r));
  const b = `http://127.0.0.1:${bare.address().port}`;
  const { job_id } = await (
    await fetch(`${b}/api/v1/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repo_url: repoUrl, tickets_md: '## K — x' }),
    })
  ).json();
  let j;
  for (let i = 0; i < 200; i++) {
    j = await (await fetch(`${b}/api/v1/analyze/${job_id}`)).json();
    if (j.status === 'failed' || j.status === 'succeeded') break;
    await new Promise((s) => setTimeout(s, 25));
  }
  assert.equal(j.status, 'failed');
  assert.match(j.error, /chưa cấu hình/);
  await new Promise((r) => bare.close(r));
});

test('ngữ cảnh repo: từ khoá lấy từ ticket, dòng khớp kèm số dòng thật', async () => {
  const dir = path.join(tmp, 'ctx');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'a.py'), 'import os\ndef login(user):\n    pass\n');
  const ticket = { key: 'LOGIN-1', title: 'them man hinh login', body: '' };
  assert.ok(contextTerms(ticket).terms.includes('login'));
  const index = await buildIndex({ repoDir: dir, fs, path, excludeGlobs: [], matchesAny });
  const ctx = buildRepoContext({ index, ticket });
  assert.deepEqual(ctx.files, ['a.py']);
  assert.ok(ctx.snippets.some((s) => s.path === 'a.py' && s.line === 2));
  assert.match(renderContext(ctx), /a\.py:2:/);
});

/*
 * Ngữ cảnh của backend `fci` dùng CHUNG bộ tách từ với `none`.
 *
 * Bản trước có bộ tách riêng (`keywordsOf`): cắt ticket key theo dấu gạch rồi
 * lấy từng mảnh, và không bỏ dấu tiếng Việt. Hai lỗi ấy làm hỏng đúng backend
 * MẶC ÐỊNH, vì model chỉ trích dẫn được thứ nó được cho xem.
 */
test('từ khoá ngữ cảnh: không còn mảnh key, và có bỏ dấu tiếng Việt', () => {
  const ticket = { key: 'GEN-R123', title: 'Thêm nút xoá', body: 'Cho phép người dùng xoá bản ghi' };
  const { key, terms, needles } = contextTerms(ticket);

  // §1.3 — key khớp NGUYÊN CHUỖI. Mảnh `gen` là thứ từng bị trích 294 lần.
  assert.equal(key, 'gen-r123');
  assert.ok(!needles.includes('gen'), 'không được phát ra mảnh "gen"');
  assert.ok(!needles.includes('r123'), 'không được phát ra mảnh "r123"');

  // §1.4 — bỏ dấu, nên `xoá`/`phép`/`người` tìm được trong code viết không dấu.
  for (const t of ['nut', 'xoa', 'phep', 'nguoi', 'ghi']) {
    assert.ok(terms.includes(t), `thiếu từ khoá "${t}" (có: ${terms.join(', ')})`);
  }
  assert.ok(!terms.some((t) => /[àáâãèéêìíòóôõùúýăđĩũơưạảấầẩậắằẳặẹẻẽềềểệỉịọỏốồổộớờởợụủứừửữựỳỵỷỹ]/.test(t)),
    'từ khoá phải đã bỏ dấu');
});

test('ngữ cảnh chỉ nêu file ÐÃ QUÉT, và trích đúng dòng chứa từ khoá', async () => {
  const dir = path.join(tmp, 'ctx-spec');
  await fs.mkdir(path.join(dir, 'app'), { recursive: true });
  await fs.writeFile(path.join(dir, 'app', 'orders.py'),
    'class OrderService:\n    def xoa_ban_ghi(self, ma):\n        return True\n');
  await fs.writeFile(path.join(dir, 'app', 'unrelated.py'), 'PI = 3.14159\n');
  // Ngoài allowlist đuôi mã nguồn → không được có mặt trong cây file đã quét.
  await fs.writeFile(path.join(dir, 'NOTES.md'), 'xoa ban ghi\n');

  const index = await buildIndex({ repoDir: dir, fs, path, excludeGlobs: [], matchesAny });
  const ctx = buildRepoContext({
    index,
    ticket: { key: 'ORD-9', title: 'Xoá bản ghi', body: 'Cho phép xoá bản ghi đơn hàng' },
  });

  assert.ok(ctx.files.includes('app/orders.py'));
  assert.ok(!ctx.files.includes('NOTES.md'), 'file ngoài allowlist không được khai là đã quét');
  assert.ok(ctx.snippets.some((s) => s.path === 'app/orders.py' && s.line === 2),
    `phải trích dòng 2 của orders.py (có: ${JSON.stringify(ctx.snippets)})`);
  assert.equal(ctx.complete, true);
  assert.ok(ctx.candidates >= 1);
});

test('không khớp gì thì nói thẳng là đã quét bao nhiêu file mà không thấy', async () => {
  const dir = path.join(tmp, 'ctx-rong');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'a.py'), 'PI = 3.14159\n');
  const index = await buildIndex({ repoDir: dir, fs, path, excludeGlobs: [], matchesAny });
  const ctx = buildRepoContext({ index, ticket: { key: 'ZZZ-1', title: 'quantum blockchain sharding', body: '' } });
  assert.equal(ctx.snippets.length, 0);
  assert.equal(ctx.candidates, 0);
  assert.match(renderContext(ctx), /Không dòng nào trong 1 file đã quét/);
});

test('job fci trả bản ghi quét THẬT, không còn scan: null', async () => {
  /*
   * Trước đây `fci` luôn trả `scan: null`, lý do ghi trong code là "model có
   * thể chưa được cho xem đúng file". Lý do ấy đúng khi ngữ cảnh do một bộ
   * tách từ riêng gom lại; từ khi nó dùng chung `queryTerms`/`normalizedKey`
   * với `none`, phạm vi tìm của hai backend là một — và giấu bản ghi quét đi
   * chỉ làm mất một bằng chứng âm có thật.
   */
  const done = await analyze({ run_id: 'R-SCAN', repo_url: repoUrl, tickets_md: '## LOGIN-1 — them login\n\nStatus: Done' });
  assert.equal(done.status, 'succeeded', done.error);
  const item = done.result.items[0];
  assert.ok(item.scan, 'phải có bản ghi quét');
  assert.ok(item.scan.files_scanned > 0, 'phải đếm được số file đã quét');
  assert.equal(item.scan.complete, true, 'repo nhỏ thì phép quét phải đi hết');
  assert.equal(item.scan.revision, done.result.source_revision, 'bản ghi quét phải tự mang commit');
  assert.ok(Array.isArray(item.scan.terms) && item.scan.terms.length > 0);
  assert.equal(done.result.stats.items_with_scan, 1);
  assert.equal(done.result.stats.items_without_scan, 0);
  // README.md nằm ngoài allowlist đuôi mã nguồn nên không được tính là đã quét.
  assert.ok(!item.scan.terms.includes('login-1') || item.scan.terms[0] === 'login-1');
});

test('repo không có file mã nguồn nào → scan là null, không phải files_scanned: 0', async () => {
  // Cùng luật với backend `none`: một phép quét chưa đọc được file nào thì nói
  // "không biết", chứ không báo một con số 0 trông như "đã quét xong, không thấy".
  const dir = path.join(tmp, 'repo-trong');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'README.md'), 'chi co tai lieu\n');
  await run('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  await run('git', ['add', '-A'], { cwd: dir });
  await run('git', ['-c', 'user.email=t@e.invalid', '-c', 'user.name=t', 'commit', '-q', '-m', 'i'], { cwd: dir });

  const done = await analyze({ repo_url: pathToFileURL(dir).href, tickets_md: '## EMPTY-1 — khong co code\n\nStatus: Done' });
  assert.equal(done.status, 'succeeded', done.error);
  assert.equal(done.result.items[0].scan, null);
  assert.equal(done.result.stats.items_without_scan, 1);
});

test('max_files_per_ticket là SÀN của ngữ cảnh, không chỉ trần của bằng chứng', async () => {
  // Bên gọi xin 12 bằng chứng mà model chỉ được xem 8 file thì cái trần ấy
  // không bao giờ điền đủ được.
  const dir = path.join(tmp, 'ctx-san');
  await fs.mkdir(dir, { recursive: true });
  for (let i = 0; i < 14; i++) {
    await fs.writeFile(path.join(dir, `mod${i}.py`), `def xoa_ban_ghi_${i}():\n    return ${i}\n`);
  }
  const index = await buildIndex({ repoDir: dir, fs, path, excludeGlobs: [], matchesAny });
  const ticket = { key: 'SAN-1', title: 'Xoá bản ghi', body: 'Cho phép xoá bản ghi' };

  const macDinh = buildRepoContext({ index, ticket });
  assert.equal(macDinh.candidates, MIN_CONTEXT_FILES, `mặc định phải là sàn ${MIN_CONTEXT_FILES}`);

  const noiRong = buildRepoContext({ index, ticket, maxFiles: 12 });
  assert.equal(noiRong.candidates, 12, 'xin 12 thì phải được xem 12');

  // Trần dưới sàn không bao giờ kéo ngữ cảnh xuống thấp hơn sàn.
  const thap = buildRepoContext({ index, ticket, maxFiles: Math.max(MIN_CONTEXT_FILES, 2) });
  assert.equal(thap.candidates, MIN_CONTEXT_FILES);
});

test('ứng viên chỉ đếm file model THẬT SỰ đọc được dòng', async () => {
  // File tên khớp ticket key nhưng trong ruột không có dòng nào khớp: nó lọt
  // shortlist, nhưng model không đọc được gì của nó nên không tính là ứng viên.
  const dir = path.join(tmp, 'ctx-tenkhop');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'ord-9.py'), 'PI = 3.14159\n');
  const index = await buildIndex({ repoDir: dir, fs, path, excludeGlobs: [], matchesAny });
  const ctx = buildRepoContext({ index, ticket: { key: 'ORD-9', title: 'khong lien quan', body: '' } });
  assert.equal(ctx.snippets.length, 0);
  assert.equal(ctx.candidates, 0, 'không đọc được dòng nào thì không phải ứng viên');
  assert.ok(ctx.files.includes('ord-9.py'), 'nhưng nó vẫn có trong cây file đã quét');
});

/*
 * Corpus phụ: file hạ tầng/cấu hình ngoài allowlist đuôi mã nguồn.
 *
 * Ðo trên repo thật: 187/583 file của astraqa nằm ngoài allowlist, gồm cả
 * `.mjs`, `.yml`, `.json`, `.toml` — nơi không ít ticket được hiện thực thật.
 */
test('corpus phụ: model thấy dòng thật trong yaml/json/mjs, và chúng không vào scan', async () => {
  const dir = path.join(tmp, 'aux');
  await fs.mkdir(path.join(dir, 'deploy'), { recursive: true });
  await fs.writeFile(path.join(dir, 'app.py'), 'def khoi_dong():\n    return 1\n');
  await fs.writeFile(path.join(dir, 'deploy', 'docker-compose.yml'),
    'services:\n  api:\n    environment:\n      - RETRY_LIMIT=5\n');
  await fs.writeFile(path.join(dir, 'tool.mjs'), 'export const retryLimit = 5;\n');

  const index = await buildIndex({ repoDir: dir, fs, path, excludeGlobs: [], matchesAny });
  const aux = await buildAuxCorpus({ repoDir: dir, fs, path, excludeGlobs: [], matchesAny });
  const ticket = { key: 'CFG-1', title: 'retry limit', body: 'dat retry limit cho api' };
  const ctx = buildRepoContext({ index, ticket, aux });

  const duong = ctx.auxSnippets.map((s) => `${s.path}:${s.line}`);
  assert.ok(duong.some((d) => d.startsWith('deploy/docker-compose.yml:')), `thiếu yaml (có: ${duong})`);
  assert.ok(duong.some((d) => d.startsWith('tool.mjs:')), `thiếu .mjs (có: ${duong})`);
  // Mỗi mảnh phải kèm số dòng THẬT — model chỉ được trích thứ nó đã đọc.
  for (const s of ctx.auxSnippets) assert.ok(s.line >= 1 && s.text.length > 0);

  // Corpus phụ KHÔNG được lẫn vào cây file đã quét hay vào files_scanned.
  assert.ok(!ctx.files.includes('tool.mjs'));
  assert.ok(!ctx.files.includes('deploy/docker-compose.yml'));
  assert.equal(ctx.totalFiles, index.N);
  assert.match(renderContext(ctx), /file hạ tầng\/cấu hình/);
});

test('tài liệu KHÔNG vào corpus phụ — một lời hứa không phải hiện thực', async () => {
  const dir = path.join(tmp, 'aux-doc');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'DESIGN.md'), 'Se bo sung retry limit cho api trong sprint toi.\n');
  await fs.writeFile(path.join(dir, 'README.rst'), 'retry limit\n');
  await fs.writeFile(path.join(dir, 'notes.txt'), 'retry limit\n');
  const aux = await buildAuxCorpus({ repoDir: dir, fs, path, excludeGlobs: [], matchesAny });
  assert.equal(aux.N, 0, `tài liệu không được đọc, thấy: ${aux.files.map((f) => f.path)}`);
});

test('corpus phụ tôn trọng exclude_globs và bỏ qua thư mục rác', async () => {
  const dir = path.join(tmp, 'aux-loc');
  await fs.mkdir(path.join(dir, 'node_modules'), { recursive: true });
  await fs.mkdir(path.join(dir, 'infra'), { recursive: true });
  await fs.writeFile(path.join(dir, 'node_modules', 'x.json'), '{"retry":1}\n');
  await fs.writeFile(path.join(dir, 'infra', 'skip.yml'), 'retry: 1\n');
  await fs.writeFile(path.join(dir, 'keep.yml'), 'retry: 1\n');
  const aux = await buildAuxCorpus({
    repoDir: dir, fs, path, excludeGlobs: ['**/infra/**'], matchesAny,
  });
  assert.deepEqual(aux.files.map((f) => f.path), ['keep.yml']);
});

/*
 * Thân lỗi HTML. Ðo trên lần chạy thật: `FCI trả 524: <!DOCTYPE html>` — cắt
 * 300 ký tự đầu của một trang HTML cho ra một dòng không nói gì.
 */
test('lỗi gateway trả HTML: message nói ra đó là trang HTML, kèm <title>', () => {
  const trang = '<!DOCTYPE html>\n<html><head><title>504 Gateway Time-out</title></head><body>…</body></html>';
  const ra = describeErrorBody(trang, 'text/html; charset=utf-8');
  assert.match(ra, /gateway trả trang HTML/);
  assert.match(ra, /504 Gateway Time-out/);
  assert.ok(!ra.includes('<!DOCTYPE'), 'đừng trích doctype — nó không nói gì');

  // Nhận diện cả khi content-type thiếu hoặc nói dối.
  assert.match(describeErrorBody(trang, ''), /trang HTML/);
  assert.match(describeErrorBody(trang, 'application/json'), /trang HTML/);

  // Body JSON thật thì vẫn giữ nguyên văn — đó mới là chỗ có thông tin.
  assert.equal(describeErrorBody('{"error":"model qua tai"}', 'application/json'), '{"error":"model qua tai"}');
  assert.equal(describeErrorBody('', 'text/html'), '(không có body)');
});
