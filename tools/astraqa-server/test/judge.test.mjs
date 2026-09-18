/**
 * Job judge, chạy offline: repo git thật trong thư mục tạm, endpoint model giả.
 *
 * Phủ đúng những điều một job judge phải giữ, và mỗi điều là một cách nó đã có
 * thể hỏng mà vẫn báo succeeded:
 *
 *   - `results` đọc được TỪNG PHẦN trong lúc chạy, không chờ cả job.
 *   - Model chỉ thấy đúng những dòng được trích, kèm số dòng thật.
 *   - Từ vựng verdict đến từ request; một verdict ngoài danh sách bị từ chối.
 *   - Một ticket hỏng thành `tier: "grep"` kèm lý do, không kéo job xuống.
 *   - Ticket không đọc được mảnh code nào KHÔNG được chấm mù.
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

const run = promisify(execFile);
const TOKEN = 'service-token-dung-cho-test-0123456789';
const KEY = 'sk-KHONG-DUOC-LO-RA-0123456789';

const GUIDE = {
  MATCH: 'kế hoạch và mã nguồn nói cùng một chuyện',
  CODE_AHEAD: 'mã đã có, ticket chưa đóng',
  JIRA_AHEAD: 'ticket đã đóng, mã chưa thấy',
  NO_EVIDENCE: 'không tìm được gì kiểm chứng được',
};

let tmp;
let model;
let modelUrl;
let server;
let base;
let repoUrl;
/** Prompt nào đã tới model, để kiểm nó thấy gì. */
const seen = [];
/** Trả lời kế tiếp, đặt riêng cho từng test. `null` = trả lời mặc định. */
let reply = null;

before(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'astraqa-judge-'));

  model = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      const payload = JSON.parse(body);
      const prompt = payload.messages.at(-1).content;
      seen.push({ auth: req.headers.authorization, prompt, payload });
      const key = (/Ticket key:\s*(.+)/.exec(prompt)?.[1] ?? '').trim();
      if (typeof reply === 'function') {
        const out = reply({ key, prompt });
        const send = () => {
          res.writeHead(out.status ?? 200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(out.body));
        };
        // `delayMs` là cách duy nhất để quan sát được một job đang dở: model giả
        // trả lời trong cùng một tick, nên cả sáu lượt xong trước khi lần GET
        // đầu tiên kịp chạy, và "trả dần" với "trả một lần ở cuối" trông y nhau.
        if (out.delayMs) setTimeout(send, out.delayMs);
        else send();
        return;
      }
      const content =
        '```json\n' +
        JSON.stringify({
          items: [{ key, verdict: 'MATCH', confidence: 0.82, reason: 'hàm đăng nhập có ở dòng được trích' }],
        }) +
        '\n```';
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }], usage: { total_tokens: 7 } }));
    });
  });
  await new Promise((r) => model.listen(0, '127.0.0.1', r));
  modelUrl = `http://127.0.0.1:${model.address().port}/v1`;

  // Repo thật, nội dung tuỳ ý — server không biết gì về nó.
  const dir = path.join(tmp, 'repo');
  await fs.mkdir(path.join(dir, 'src'), { recursive: true });
  await fs.writeFile(
    path.join(dir, 'src', 'auth.py'),
    Array.from({ length: 60 }, (_, i) => (i === 39 ? 'def login(user):' : `# dòng ${i + 1}`)).join('\n'),
  );
  await fs.writeFile(path.join(dir, 'README.md'), 'repo thử\n');
  await run('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  await run('git', ['add', '-A'], { cwd: dir });
  await run(
    'git',
    ['-c', 'user.email=t@example.invalid', '-c', 'user.name=t', 'commit', '-q', '-m', 'init'],
    { cwd: dir },
  );
  repoUrl = pathToFileURL(dir).href;

  server = createServer(
    {
      port: 0,
      workspaceDir: path.join(tmp, 'ws'),
      runsDir: path.join(tmp, 'runs'),
      cliPath: '(không dùng)',
      astraworkJwt: '',
      serviceToken: TOKEN,
      judgeConcurrency: 2,
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

function post(body, token = TOKEN) {
  return fetch(`${base}/api/v1/judge`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
}

function get(jobId) {
  return fetch(`${base}/api/v1/judge/${jobId}`, { headers: { Authorization: `Bearer ${TOKEN}` } }).then((r) => r.json());
}

const SETTLED = new Set(['succeeded', 'failed', 'cancelled']);

async function settle(jobId, { tries = 300 } = {}) {
  for (let i = 0; i < tries; i++) {
    const json = await get(jobId);
    if (SETTLED.has(json.status)) return json;
    await new Promise((r) => setTimeout(r, 30));
  }
  throw new Error('job judge không kết thúc trong thời gian chờ');
}

const ticket = (key, extra = {}) => ({
  key,
  summary: 'Đăng nhập bằng mật khẩu',
  status: 'done',
  grep_verdict: 'CODE_AHEAD',
  grep_reason: 'matched_by_key',
  evidence: [{ path: 'src/auth.py', lines: '40', note: '' }],
  ...extra,
});

test('một job judge trả 202 kèm tổng số ticket, rồi kết luận từng dòng', async () => {
  reply = null;
  const res = await post({ run_id: 'RUN-J1', repo_url: repoUrl, tickets: [ticket('PRJ-1'), ticket('PRJ-2')], verdict_guide: GUIDE });
  assert.equal(res.status, 202);
  const { job_id, total } = await res.json();
  // Tổng đi kèm ngay ở 202: thanh tiến độ vẽ được trước khi có kết quả nào.
  assert.equal(total, 2);

  const done = await settle(job_id);
  assert.equal(done.status, 'succeeded');
  assert.equal(done.done, 2);
  assert.equal(done.results.length, 2);
  for (const r of done.results) {
    assert.equal(r.verdict, 'MATCH');
    assert.equal(r.tier, 'ai');
    assert.equal(r.confidence, 0.82);
    assert.match(r.reason, /dòng được trích/);
  }
  // Commit đã đọc, để bên gọi dựng được link dẫn chứng.
  assert.match(done.source_revision, /^[0-9a-f]{40}$/);
});

test('kết quả đọc được từng phần, không phải chờ cả job', async () => {
  // Model chậm có chủ ý: đủ để một lần GET rơi vào giữa job.
  reply = ({ key }) => ({
    delayMs: 60,
    body: {
      choices: [
        {
          message: {
            content:
              '```json\n' +
              JSON.stringify({ items: [{ key, verdict: 'MATCH', confidence: 0.5, reason: 'ok' }] }) +
              '\n```',
          },
        },
      ],
    },
  });
  const keys = ['A-1', 'A-2', 'A-3', 'A-4', 'A-5', 'A-6'];
  const { job_id } = await post({
    repo_url: repoUrl,
    tickets: keys.map((k) => ticket(k)),
    verdict_guide: GUIDE,
  }).then((r) => r.json());

  // Ðọc liên tục và bắt lấy một lần thấy dở dang. Nếu `results` chỉ xuất hiện
  // ở phút cuối thì mọi lần đọc sẽ là 0 hoặc 6, và test này rơi.
  let midway = null;
  for (let i = 0; i < 400 && !midway; i++) {
    const snap = await get(job_id);
    if (snap.status === 'running' && snap.results.length > 0 && snap.results.length < keys.length) {
      midway = snap;
    }
    if (snap.status === 'succeeded' || snap.status === 'failed') break;
    // Nghỉ giữa hai lần đọc. Không nghỉ thì 400 lần đọc trôi hết trong lúc
    // `git clone` còn đang chạy, và mọi mẫu đều là 0 — test rơi vì đọc quá
    // nhanh, không phải vì server trả một lần ở cuối.
    await new Promise((r) => setTimeout(r, 15));
  }
  const done = await settle(job_id);
  assert.equal(done.results.length, keys.length);
  assert.ok(midway, 'không bắt được lần đọc nào ở giữa job — results không lớn dần');
  assert.equal(midway.done, midway.results.length);
  assert.equal(midway.total, keys.length);
  // Hai làn chạy song song (`judgeConcurrency: 2`), nên không bao giờ chạy hết
  // một lượt rồi mới bắt đầu lượt sau.
  assert.ok(midway.results.length <= keys.length);
});

test('model chỉ thấy đúng đoạn được trích, kèm số dòng thật', async () => {
  reply = null;
  seen.length = 0;
  const { job_id } = await post({
    repo_url: repoUrl,
    tickets: [ticket('CTX-1')],
    verdict_guide: GUIDE,
    options: { context_lines: 3 },
  }).then((r) => r.json());
  await settle(job_id);

  const prompt = seen.at(-1).prompt;
  // Đúng dòng 40 và ba dòng mỗi phía, số dòng đi kèm để model trích lại được.
  assert.match(prompt, /37: # dòng 37/);
  assert.match(prompt, /40: def login\(user\):/);
  assert.match(prompt, /43: # dòng 43/);
  assert.equal(prompt.includes('36: '), false);
  assert.equal(prompt.includes('44: '), false);
  // File không được trích thì không có mặt: prompt này là bằng chứng, không
  // phải cả repo.
  assert.equal(prompt.includes('README.md'), false);
  // Bốn verdict và định nghĩa của chúng đến TỪ REQUEST.
  for (const [name, text] of Object.entries(GUIDE)) {
    assert.ok(prompt.includes(name), `prompt thiếu verdict ${name}`);
    assert.ok(prompt.includes(text), `prompt thiếu định nghĩa của ${name}`);
  }
  // Kết luận sơ bộ được nói ra, để model biết nó đang soát lại cái gì.
  assert.match(prompt, /CODE_AHEAD/);
  // temperature 0: cùng ticket, cùng repo phải cho cùng kết luận.
  assert.equal(seen.at(-1).payload.temperature, 0);
  assert.equal(seen.at(-1).auth, `Bearer ${KEY}`);
});

test('một verdict ngoài danh sách bị từ chối, ticket đó giữ tầng grep', async () => {
  reply = ({ key }) => ({
    body: {
      choices: [
        {
          message: {
            content:
              '```json\n' +
              JSON.stringify({ items: [{ key, verdict: 'PROBABLY_FINE', confidence: 0.9, reason: 'tự nghĩ ra' }] }) +
              '\n```',
          },
        },
      ],
    },
  });
  const { job_id } = await post({ repo_url: repoUrl, tickets: [ticket('BAD-1')], verdict_guide: GUIDE }).then((r) => r.json());
  const done = await settle(job_id);

  assert.equal(done.status, 'succeeded');
  const row = done.results[0];
  // Không có `verdict`: một giá trị model tự nghĩ ra không được đi tiếp dưới
  // nhãn "AI" chỉ vì nó đọc như một kết luận.
  assert.equal(row.verdict, undefined);
  assert.equal(row.tier, 'grep');
  assert.match(row.error, /PROBABLY_FINE/);
  assert.equal(done.stats.failed, 1);
});

test('một ticket hỏng không kéo cả job xuống', async () => {
  reply = ({ key }) =>
    key === 'MID-2'
      ? { status: 500, body: { error: 'model rơi' } }
      : {
          body: {
            choices: [
              {
                message: {
                  content:
                    '```json\n' +
                    JSON.stringify({ items: [{ key, verdict: 'JIRA_AHEAD', confidence: 0.7, reason: 'không thấy trong code' }] }) +
                    '\n```',
                },
              },
            ],
          },
        };
  const { job_id } = await post({
    repo_url: repoUrl,
    tickets: ['MID-1', 'MID-2', 'MID-3'].map((k) => ticket(k)),
    verdict_guide: GUIDE,
  }).then((r) => r.json());
  const done = await settle(job_id);

  assert.equal(done.status, 'succeeded');
  assert.equal(done.results.length, 3);
  const bad = done.results.find((r) => r.key === 'MID-2');
  assert.equal(bad.tier, 'grep');
  assert.match(bad.error, /500/);
  // Hai ticket kia vẫn được chấm — đó là cả lý do vòng lặp bắt lỗi từng lượt.
  assert.equal(done.results.filter((r) => r.tier === 'ai').length, 2);
  assert.equal(done.stats.judged, 2);
  assert.equal(done.stats.failed, 1);
});

test('không đọc được mảnh code nào thì không chấm mù', async () => {
  reply = null;
  seen.length = 0;
  const { job_id } = await post({
    repo_url: repoUrl,
    tickets: [
      ticket('GONE-1', { evidence: [{ path: 'src/da-xoa.py', lines: '10', note: '' }] }),
      ticket('GONE-2', { evidence: [] }),
      ticket('GONE-3', { evidence: [{ path: '../../etc/passwd', lines: '1', note: '' }] }),
    ],
    verdict_guide: GUIDE,
  }).then((r) => r.json());
  const done = await settle(job_id);

  assert.equal(done.status, 'succeeded');
  assert.equal(done.results.length, 3);
  for (const row of done.results) {
    assert.equal(row.tier, 'grep');
    assert.equal(row.verdict, undefined);
  }
  assert.match(done.results.find((r) => r.key === 'GONE-1').error, /không đọc được/);
  assert.match(done.results.find((r) => r.key === 'GONE-2').error, /không có dẫn chứng/);
  assert.match(done.results.find((r) => r.key === 'GONE-3').error, /thoát khỏi repo/);
  assert.equal(done.stats.no_snippet, 3);
  // Và không lượt gọi model nào bị tiêu cho chúng.
  assert.equal(seen.length, 0);
});

test('thiếu field bắt buộc là 400, và nói thiếu cái gì', async () => {
  const bad = await post({ repo_url: repoUrl }).then((r) => r.json());
  assert.match(bad.error, /tickets/);
  assert.match(bad.error, /verdict_guide/);

  const noRepo = await post({ tickets: [ticket('X-1')], verdict_guide: GUIDE }).then((r) => r.json());
  assert.match(noRepo.error, /repo_url/);

  // Một guide chỉ có một tên không phân biệt được gì.
  const thin = await post({ repo_url: repoUrl, tickets: [ticket('X-2')], verdict_guide: { MATCH: 'x' } });
  const settled = await settle((await thin.json()).job_id);
  assert.equal(settled.status, 'failed');
  assert.match(settled.error, /ít nhất hai verdict/);
});

test('sai token là 401, và một job id lạ là 404', async () => {
  const unauth = await post({ repo_url: repoUrl, tickets: [ticket('Z-1')], verdict_guide: GUIDE }, 'sai-token');
  assert.equal(unauth.status, 401);
  const missing = await fetch(`${base}/api/v1/judge/khong-ton-tai`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  assert.equal(missing.status, 404);
});

test('hai họ job không đọc lẫn nhau', async () => {
  reply = null;
  const { job_id } = await post({ repo_url: repoUrl, tickets: [ticket('MIX-1')], verdict_guide: GUIDE }).then((r) => r.json());
  await settle(job_id);
  // Đọc một job judge qua đường analyze là 404, không phải một job "succeeded"
  // với `result: undefined` — bên gọi sẽ đọc cái đó thành "không có phát hiện nào".
  const wrongDoor = await fetch(`${base}/api/v1/analyze/${job_id}`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  assert.equal(wrongDoor.status, 404);
});

test('gọi dừng thì cắt lượt đang bay và giữ nguyên kết quả đã có', async () => {
  // Model chậm, để job còn đang chạy khi lệnh dừng tới.
  reply = ({ key }) => ({
    delayMs: 120,
    body: {
      choices: [
        {
          message: {
            content:
              '```json\n' +
              JSON.stringify({ items: [{ key, verdict: 'MATCH', confidence: 0.5, reason: 'ok' }] }) +
              '\n```',
          },
        },
      ],
    },
  });
  const keys = ['C-1', 'C-2', 'C-3', 'C-4', 'C-5', 'C-6', 'C-7', 'C-8'];
  const { job_id } = await post({
    repo_url: repoUrl,
    tickets: keys.map((k) => ticket(k)),
    verdict_guide: GUIDE,
  }).then((r) => r.json());

  // Chờ tới khi có ít nhất một kết quả, rồi gọi dừng.
  let before = 0;
  for (let i = 0; i < 200; i++) {
    const snap = await get(job_id);
    if (snap.results.length > 0) {
      before = snap.results.length;
      break;
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.ok(before > 0, 'job chưa chấm được dòng nào trước khi gọi dừng');

  const stopped = await fetch(`${base}/api/v1/judge/${job_id}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  assert.equal(stopped.status, 200);

  const done = await settle(job_id);
  // `cancelled`, không phải `succeeded`: job làm đúng thứ được bảo, nhưng nói
  // "xong" sẽ khiến bên gọi tưởng cả danh sách đã được xét.
  assert.equal(done.status, 'cancelled');
  // Kết quả đã trả tiền rồi thì ở lại.
  assert.ok(done.results.length >= before, 'dừng làm mất kết quả đã có');
  // Và không chấm hết: đó là cả lý do có nút dừng.
  assert.ok(done.results.filter((r) => r.tier === 'ai').length < keys.length);
});

test('dừng một job id lạ là 404', async () => {
  const missing = await fetch(`${base}/api/v1/judge/khong-co-that`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  assert.equal(missing.status, 404);
});

test('/healthz khai đường judge, không khai key', async () => {
  const health = await fetch(`${base}/healthz`).then((r) => r.json());
  assert.deepEqual(health.routes, ['/api/v1/analyze', '/api/v1/judge']);
  assert.equal(health.judge_concurrency, 2);
  assert.equal(health.model, 'model-thu');
  assert.equal(JSON.stringify(health).includes(KEY), false);
});

test('quy ước của codebase tới được prompt, nhưng không nới được từ vựng verdict', async () => {
  // Ðội để tệp quy ước trong repo, và AstraQA trỏ tới nó bằng `guidance_path`.
  // Ðường dẫn do bên gọi đưa vì bộ rules đang áp có thể ở cấp tenant chứ không
  // nằm trong repo — chỉ bên kia biết bộ nào đang thắng.
  const dir = path.join(tmp, 'repo');
  await fs.mkdir(path.join(dir, '.astraqa'), { recursive: true });
  await fs.writeFile(
    path.join(dir, '.astraqa', 'judge.md'),
    'Ở repo này "adapter" và "connector" là một thứ.\n',
  );
  await run('git', ['add', '-A'], { cwd: dir });
  await run(
    'git',
    ['-c', 'user.email=t@example.invalid', '-c', 'user.name=t', 'commit', '-q', '-m', 'quy uoc'],
    { cwd: dir },
  );

  seen.length = 0;
  const started = await post({
    run_id: 'run-guidance',
    repo_url: repoUrl,
    verdict_guide: GUIDE,
    guidance_path: '.astraqa/judge.md',
    tickets: [{ key: 'G-1', summary: 'connector', evidence: [{ path: 'src/auth.py', lines: '40' }] }],
  });
  const { job_id } = await started.json();
  let state;
  do {
    await new Promise((r) => setTimeout(r, 15));
    state = await get(job_id);
  } while (!SETTLED.has(state.status));

  const prompt = seen.at(-1).prompt;
  assert.match(prompt, /adapter/, 'quy ước phải tới được model');
  // Và nó nằm SAU danh sách kết luận: nó giải thích cách đọc mã nguồn này, chứ
  // không được thêm hay đổi nghĩa một kết luận nào.
  assert.ok(prompt.indexOf('CODE_AHEAD') < prompt.indexOf('adapter'));
});

test('không có guidance_path thì prompt không mọc thêm mục nào', async () => {
  seen.length = 0;
  const started = await post({
    run_id: 'run-no-guidance',
    repo_url: repoUrl,
    verdict_guide: GUIDE,
    tickets: [{ key: 'G-2', summary: 'login', evidence: [{ path: 'src/auth.py', lines: '40' }] }],
  });
  const { job_id } = await started.json();
  let state;
  do {
    await new Promise((r) => setTimeout(r, 15));
    state = await get(job_id);
  } while (!SETTLED.has(state.status));

  assert.doesNotMatch(seen.at(-1).prompt, /QUY ƯỚC CỦA CODEBASE/);
});
