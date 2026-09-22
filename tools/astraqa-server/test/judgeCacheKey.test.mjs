/**
 * Khoá cache judge theo NỘI DUNG, không theo commit.
 *
 * Bài toán đo được trên bản trước: khoá có `revision` trong đó, nên một commit
 * sửa ba tệp làm 164 ticket trượt cache sạch — 12 phút và ~700k token để nhận
 * lại 161 câu trả lời không đổi. Ðổi khoá sang vân tay nội dung của chính
 * những tệp mỗi ticket dẫn ra thì ba ticket bị chạm là ba lượt gọi, phần còn
 * lại trúng cache.
 *
 * Ðổi khoá là chuyện nguy hiểm theo hai hướng ngược nhau, và mỗi ca dưới đây
 * canh đúng một hướng:
 *
 *   - **Trúng nhầm**: khoá không đổi trong khi code đã đổi → cache trả lời
 *     thay cho một đoạn code khác. (b), (c), (d).
 *   - **Trượt oan**: khoá đổi trong khi câu hỏi không đổi → hoá đơn cũ quay
 *     lại, và cả cache 164 dòng đang có thành rác. (a), (e).
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
import { blobIds, normalizeRepoPath } from '../lib/git.mjs';
import { cacheKey, cacheKeyV2, contentFingerprint, MISSING_BLOB } from '../lib/judgeCache.mjs';

const run = promisify(execFile);
const TOKEN = 'service-token-khoa-noi-dung-0123456789';
const KEY = 'sk-KHONG-DUOC-LO-RA-1234567890';
const MODEL = 'model-thu';
const RULES = 'judge-v3';

const GUIDE = {
  MATCH: 'kế hoạch và mã nguồn nói cùng một chuyện',
  CODE_AHEAD: 'mã đã có, ticket chưa đóng',
  JIRA_AHEAD: 'ticket đã đóng, mã chưa thấy',
};

let tmp;
let wsDir;
let model;
let modelUrl;
let server;
let base;
let repoDir;
let repoUrl;
let calls = [];

function body80(marker) {
  return Array.from({ length: 80 }, (_, i) => (i === 39 ? `def login(user):  # ${marker}` : `# dòng ${i + 1}`)).join('\n');
}

async function commit(message) {
  await run('git', ['add', '-A'], { cwd: repoDir });
  await run('git', ['-c', 'user.email=t@example.invalid', '-c', 'user.name=t', 'commit', '-q', '-m', message], {
    cwd: repoDir,
  });
  const { stdout } = await run('git', ['rev-parse', 'HEAD'], { cwd: repoDir });
  return stdout.trim();
}

async function headSha() {
  const { stdout } = await run('git', ['rev-parse', 'HEAD'], { cwd: repoDir });
  return stdout.trim();
}

function ok(key) {
  const block = JSON.stringify({
    items: [{ key, verdict: 'MATCH', confidence: 0.77, reason: 'code có ở dòng được trích' }],
  });
  return {
    choices: [{ message: { content: '```json\n' + block + '\n```' } }],
    usage: { prompt_tokens: 120, completion_tokens: 30 },
  };
}

before(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'astraqa-keyv2-'));
  wsDir = path.join(tmp, 'ws');

  model = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', () => {
      const payload = JSON.parse(raw);
      const prompt = payload.messages.at(-1).content;
      const key = (/Ticket key:\s*(.+)/.exec(prompt)?.[1] ?? '').trim();
      calls.push({ key, prompt });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(ok(key)));
    });
  });
  await new Promise((r) => model.listen(0, '127.0.0.1', r));
  modelUrl = `http://127.0.0.1:${model.address().port}/v1`;

  repoDir = path.join(tmp, 'repo');
  await fs.mkdir(path.join(repoDir, 'src'), { recursive: true });
  await fs.writeFile(path.join(repoDir, 'src', 'auth.py'), body80('v1'));
  await fs.writeFile(path.join(repoDir, 'src', 'billing.py'), body80('hoa-don'));
  await fs.writeFile(path.join(repoDir, 'README.md'), 'repo thử\n');
  await run('git', ['init', '-q', '-b', 'main'], { cwd: repoDir });
  await commit('init');
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
      fciModel: MODEL,
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

const SETTLED = new Set(['succeeded', 'failed', 'cancelled']);

async function judged(payload) {
  const { job_id } = await fetch(`${base}/api/v1/judge`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify(payload),
  }).then((r) => r.json());
  for (let i = 0; i < 400; i++) {
    const json = await fetch(`${base}/api/v1/judge/${job_id}`, {
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

/**
 * Khoá v2 tính đúng như job tính, nhưng từ chính repo nguồn.
 *
 * `paths` là danh sách dẫn chứng, `rev` là commit muốn soi. Mọi thành phần
 * khác giữ cố định, nên khoá chỉ còn phụ thuộc đúng hai thứ ấy — đó là điều
 * bốn ca đầu cần đo.
 */
async function keyAt(rev, paths) {
  const oids = await blobIds({ repoDir, rev, paths });
  return cacheKeyV2({
    ticketKey: 'AUTH-1',
    summary: 'Đăng nhập bằng mật khẩu',
    description: '',
    status: 'done',
    rulesVersion: RULES,
    model: MODEL,
    prompt: 'vân tay prompt cố định',
    contentFp: contentFingerprint(paths, oids),
  });
}

test('(a) cùng nội dung tệp ở hai commit khác nhau thì cùng một khoá', async () => {
  const truoc = await headSha();
  // Một commit KHÔNG chạm tệp được dẫn ra: đây chính là 161/164 ticket của bản
  // demo, và là toàn bộ lý do bỏ `revision` khỏi khoá.
  await fs.writeFile(path.join(repoDir, 'README.md'), 'repo thử — sửa một dòng không liên quan\n');
  const sau = await commit('đổi README');

  assert.notEqual(truoc, sau, 'hai commit phải khác nhau, nếu không ca này không đo gì cả');
  assert.equal(await keyAt(truoc, ['src/auth.py']), await keyAt(sau, ['src/auth.py']));
});

test('(b) đổi một byte trong tệp được dẫn ra thì khoá khác', async () => {
  const cu = await keyAt(await headSha(), ['src/auth.py']);

  await fs.writeFile(path.join(repoDir, 'src', 'auth.py'), body80('v1') + ' ');
  const sau = await commit('thêm đúng một dấu cách vào auth.py');

  assert.notEqual(await keyAt(sau, ['src/auth.py']), cu);
});

test('(c) thêm hoặc bớt một đường dẫn dẫn chứng thì khoá khác', async () => {
  const head = await headSha();
  const mot = await keyAt(head, ['src/auth.py']);
  const hai = await keyAt(head, ['src/auth.py', 'src/billing.py']);

  assert.notEqual(hai, mot, 'thêm một dẫn chứng là hỏi một câu khác');
  assert.equal(await keyAt(head, ['src/billing.py', 'src/auth.py']), hai, 'thứ tự dẫn chứng thì không');
  assert.equal(await keyAt(head, ['src/auth.py', 'src/auth.py']), mot, 'trùng lặp cũng không');
  // Dấu gạch ngược của Windows là cùng một tệp, không phải một tệp thứ hai.
  assert.equal(await keyAt(head, [String.raw`src\auth.py`]), mot);
});

test('(d) tệp dẫn chứng bị xoá ở commit mới thì khoá khác, và "đã xoá" khác "chưa từng có"', async () => {
  const conDu = await keyAt(await headSha(), ['src/auth.py', 'src/billing.py']);

  await fs.rm(path.join(repoDir, 'src', 'billing.py'));
  const daXoa = await commit('xoá billing.py');

  assert.notEqual(await keyAt(daXoa, ['src/auth.py', 'src/billing.py']), conDu);

  // Một tệp đã xoá vẫn phải để lại dấu trong vân tay. Bỏ qua nó thì "dẫn chứng
  // trỏ vào tệp vừa bị xoá" và "ticket chỉ dẫn ra auth.py" cho cùng một khoá —
  // và cache sẽ trả lời rằng code vẫn còn nguyên ở đó.
  const oids = await blobIds({ repoDir, rev: daXoa, paths: ['src/auth.py', 'src/billing.py'] });
  assert.equal(oids.get('src/billing.py'), null);
  assert.notEqual(
    contentFingerprint(['src/auth.py', 'src/billing.py'], oids),
    contentFingerprint(['src/auth.py'], oids),
  );

  // Trả lại để các ca sau chạy trên một repo đủ hai tệp.
  await fs.writeFile(path.join(repoDir, 'src', 'billing.py'), body80('hoa-don'));
  await commit('trả lại billing.py');
});

test('vân tay nội dung ghi "<missing>" cho tệp không có ở revision ấy', async () => {
  const oids = await blobIds({ repoDir, rev: await headSha(), paths: ['src/khong-he-co.py'] });

  assert.equal(oids.get('src/khong-he-co.py'), null);
  assert.equal(normalizeRepoPath('./src/khong-he-co.py'), 'src/khong-he-co.py');
  assert.equal(
    contentFingerprint(['src/khong-he-co.py'], oids),
    contentFingerprint(['src/khong-he-co.py'], new Map([['src/khong-he-co.py', MISSING_BLOB]])),
    'không có tệp và ghi thẳng "<missing>" phải ra cùng một vân tay',
  );
});

/**
 * Hai khoá ÐỜI ÐẦU, dựng lại y nguyên hai công thức `lib/judge.mjs` từng ghi.
 *
 * Có HAI chứ không phải một: công thức khoá đã đổi một lần trước lần này, và
 * một tệp cache đang chạy có thể mang dòng của cả hai thế hệ. Chép lại ở đây
 * là có chủ ý — đây là thứ duy nhất đọc được những dòng đã nằm trên đĩa, nên
 * hai ca dưới chỉ xanh khi công thức khớp từng ký tự với bản đang chạy. Ai sửa
 * chúng bên kia thì ca này đỏ, đúng lúc cần đỏ.
 */
function legacyKeyFor(t, head, doi = 'sau') {
  const shapeSau = JSON.stringify({
    backend: 'fci',
    cliPath: undefined,
    guide: GUIDE,
    guidance: '',
    context_lines: 20,
    max_snippets: 3,
    max_snippet_lines: 41,
  });
  const shapeDau = JSON.stringify({
    guidance: '',
    context_lines: 20,
    max_snippets: 3,
    max_snippet_lines: 41,
  });
  return cacheKey({
    repoUrl,
    revision: head,
    ticketKey: t.key,
    summary: t.summary,
    description: '',
    status: t.status,
    rulesVersion: RULES,
    model: MODEL,
    prompt:
      doi === 'đầu'
        ? shapeDau
        : JSON.stringify({
            shape: shapeSau,
            acceptance_criteria: [],
            evidence: t.evidence,
            grep_verdict: t.grep_verdict,
            grep_reason: t.grep_reason,
          }),
  });
}

/** Ghi sẵn một dòng cache dưới một khoá đời đầu, rồi trả lại kết quả đã lưu. */
async function gieoDongCu(t, head, doi) {
  const cacheFile = path.join(wsDir, 'judge-cache', 'default.jsonl');
  await fs.mkdir(path.dirname(cacheFile), { recursive: true });
  const rec = {
    k: legacyKeyFor(t, head, doi),
    at: new Date().toISOString(),
    repo_url: repoUrl,
    revision: head,
    key: t.key,
    rules_version: RULES,
    model: MODEL,
    result: { key: t.key, verdict: 'JIRA_AHEAD', confidence: 0.9, reason: `từ dòng cache đời ${doi}`, tier: 'ai' },
  };
  await fs.appendFile(cacheFile, JSON.stringify(rec) + '\n', 'utf8');
  return { cacheFile, rec };
}

test('(e)+(f) dòng cache cũ vẫn dùng được một lần, được chép sang khoá v2, và model không bị gọi', async () => {
  const head = await headSha();
  const t = ticket('LEG-1');
  const { cacheFile, rec: luuSan } = await gieoDongCu(t, head, 'sau');

  const payload = { repo_url: repoUrl, rules_version: RULES, verdict_guide: GUIDE, tickets: [t] };

  calls = [];
  const lan1 = await judged({ ...payload, run_id: 'LEG-1' });
  assert.equal(lan1.status, 'succeeded');
  // (f) model không bị gọi một lần nào.
  assert.deepEqual(calls, [], 'trúng cache thì không được gửi gì cho model');
  assert.equal(lan1.progress.model_calls, 0);
  assert.equal(lan1.progress.cached, 1);
  assert.equal(lan1.progress.cached_legacy, 1);
  assert.equal(lan1.progress.cached_v2, 0);
  assert.equal(lan1.results[0].verdict, 'JIRA_AHEAD', 'trả đúng kết luận đã lưu, không chấm lại');
  assert.equal(lan1.results[0].cached, true);
  assert.equal(lan1.results[0].cache_hit, 'legacy');
  assert.equal(lan1.stats.cache_upgrades, 1);

  // Dòng cũ KHÔNG bị xoá; dòng mới được nối thêm.
  const dong = (await fs.readFile(cacheFile, 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.equal(dong.length, 2, 'append một dòng, không viết lại tệp');
  assert.equal(dong[0].k, luuSan.k, 'dòng đời đầu còn nguyên');
  assert.equal(dong[1].v, 2);
  assert.deepEqual(dong[1].result, luuSan.result, 'chép nguyên kết luận, không chấm lại');

  // (e) lần sau đã là khoá v2.
  calls = [];
  const lan2 = await judged({ ...payload, run_id: 'LEG-2' });
  assert.equal(lan2.status, 'succeeded');
  assert.deepEqual(calls, []);
  assert.equal(lan2.progress.cached, 1);
  assert.equal(lan2.progress.cached_v2, 1);
  assert.equal(lan2.progress.cached_legacy, 0);
  assert.equal(lan2.results[0].cache_hit, 'v2');
  assert.equal(lan2.stats.cache_upgrades, 0, 'không chép lại lần nữa');
  assert.equal((await fs.readFile(cacheFile, 'utf8')).split('\n').filter(Boolean).length, 2);
});

/*
 * Thế hệ khoá cũ HƠN nữa — và đây là thế hệ nằm trong tệp cache đang chạy.
 *
 * Công thức khoá đã đổi một lần trước lát này (`prompt: promptShape` thành một
 * object bọc quanh nó, và `promptShape` cũng mọc thêm ba field). Ðỡ mỗi thế hệ
 * sau cùng thì đúng 164 dòng đã trả tiền để có vẫn chết — chúng được ghi bởi
 * phiên bản server chạy trước lần đổi ấy, và không có gì trong dòng cache nói
 * ra nó thuộc thế hệ nào.
 */
test('dòng cache của thế hệ khoá cũ hơn nữa cũng được đọc và chép sang v2', async () => {
  const head = await headSha();
  const t = ticket('LEG-0');
  const { cacheFile } = await gieoDongCu(t, head, 'đầu');
  const truoc = (await fs.readFile(cacheFile, 'utf8')).split('\n').filter(Boolean).length;

  const payload = { repo_url: repoUrl, rules_version: RULES, verdict_guide: GUIDE, tickets: [t] };

  calls = [];
  const lan1 = await judged({ ...payload, run_id: 'LEG-0-A' });
  assert.equal(lan1.status, 'succeeded');
  assert.deepEqual(calls, [], 'thế hệ cũ hơn vẫn phải cứu được, không gọi model');
  assert.equal(lan1.progress.cached_legacy, 1);
  assert.equal(lan1.results[0].reason, 'từ dòng cache đời đầu');
  assert.equal(lan1.stats.cache_upgrades, 1);

  calls = [];
  const lan2 = await judged({ ...payload, run_id: 'LEG-0-B' });
  assert.deepEqual(calls, []);
  assert.equal(lan2.progress.cached_v2, 1);
  assert.equal(lan2.results[0].cache_hit, 'v2');
  assert.equal(
    (await fs.readFile(cacheFile, 'utf8')).split('\n').filter(Boolean).length,
    truoc + 1,
    'đúng một dòng được nối thêm, không dòng nào bị xoá',
  );
});

test('commit không chạm tệp được dẫn ra thì lần chạy sau vẫn trúng cache', async () => {
  const t = ticket('KEEP-1');
  const payload = { repo_url: repoUrl, rules_version: RULES, verdict_guide: GUIDE, tickets: [t] };

  calls = [];
  const lan1 = await judged({ ...payload, run_id: 'KEEP-1' });
  assert.equal(lan1.status, 'succeeded');
  assert.equal(lan1.progress.model_calls, 1, 'lần đầu phải trả tiền');

  await fs.writeFile(path.join(repoDir, 'README.md'), 'sửa một tệp không ticket nào dẫn ra\n');
  await commit('đổi README lần nữa');

  calls = [];
  const lan2 = await judged({ ...payload, run_id: 'KEEP-2' });
  assert.equal(lan2.status, 'succeeded');
  // Ðây là con số cả lát này nhắm tới: commit mới, 0 lượt gọi model.
  assert.deepEqual(calls, []);
  assert.equal(lan2.progress.cached_v2, 1);
  assert.equal(lan2.results[0].verdict, 'MATCH');

  // Còn tệp ÐƯỢC dẫn ra mà đổi thì phải trượt — cache không được che code mới.
  await fs.writeFile(path.join(repoDir, 'src', 'auth.py'), body80('v2'));
  await commit('sửa thật vào auth.py');

  calls = [];
  const lan3 = await judged({ ...payload, run_id: 'KEEP-3' });
  assert.equal(lan3.status, 'succeeded');
  assert.equal(lan3.progress.cached, 0, 'tệp đã đổi thì không được trả lời bằng kết luận cũ');
  assert.equal(lan3.progress.model_calls, 1);
});
