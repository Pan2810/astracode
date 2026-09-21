/**
 * Backend `none` — chạy được khi KHÔNG có credential nào.
 *
 * Đây cũng là bài test duy nhất chứng minh đường ống hoàn chỉnh mà không cần
 * key, JWT, mạng hay CLI: clone → tách ticket → quét → lọc evidence → report.
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
let tmp;
let server;
let base;
let repoUrl;

before(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'astraqa-none-'));
  const dir = path.join(tmp, 'repo');
  // Repo phải có đủ vài file CODE thật: từ 2026-09-16 backend `none` chấm điểm
  // theo document_frequency toàn repo (CANDIDATE_MATCHING_SPEC §4.2), nên một
  // repo hai file cho ceiling = 1 và gần như mọi term bị coi là phổ biến.
  // `README.md` cũng không còn được quét — §3.1 dùng allowlist đuôi mã nguồn.
  await fs.mkdir(path.join(dir, 'src'), { recursive: true });
  await fs.writeFile(
    path.join(dir, 'src', 'login.py'),
    'import hashlib\n\n\ndef authenticate(username, password):\n    """man hinh dang nhap"""\n    return hashlib.sha256(password.encode()).hexdigest()\n\n\ndef logout(session):\n    session.clear()\n',
  );
  await fs.writeFile(path.join(dir, 'src', 'cache.py'), 'CACHE = {}\n\n\ndef cache_lookup(key):\n    return CACHE.get(key)\n');
  await fs.writeFile(path.join(dir, 'src', 'billing.py'), 'def invoice_total(items):\n    return sum(i.amount for i in items)\n');
  await fs.writeFile(path.join(dir, 'src', 'report.py'), 'def render_report(rows):\n    return "\\n".join(str(r) for r in rows)\n');
  await fs.writeFile(path.join(dir, 'src', 'upload.py'), 'def store_attachment(blob):\n    return len(blob)\n');
  await fs.writeFile(path.join(dir, 'src', 'router.py'), 'ROUTES = {}\n\n\ndef dispatch(path):\n    return ROUTES.get(path)\n');
  // Ticket key nằm trong chính mã nguồn → §1.3 khớp nguyên chuỗi, matched_by_key.
  // README.md không dùng được nữa: §3.1 chỉ quét file có đuôi mã nguồn.
  await fs.writeFile(
    path.join(dir, 'src', 'session.py'),
    '# WEB-1001: man hinh dang nhap\n\n\ndef start_session(user):\n    return {"user": user}\n',
  );
  await run('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  await run('git', ['add', '-A'], { cwd: dir });
  await run('git', ['-c', 'user.email=t@e.invalid', '-c', 'user.name=t', 'commit', '-q', '-m', 'i'], { cwd: dir });
  repoUrl = pathToFileURL(dir).href;

  server = createServer(
    {
      port: 0,
      workspaceDir: path.join(tmp, 'ws'),
      runsDir: path.join(tmp, 'runs'),
      // Cố ý để trống HẾT: không CLI, không JWT, không key.
      cliPath: '',
      astraworkJwt: '',
      serviceToken: '',
      judgeBackend: 'none',
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

async function analyze(body) {
  const { job_id } = await (
    await fetch(`${base}/api/v1/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  ).json();
  for (let i = 0; i < 200; i++) {
    const j = await (await fetch(`${base}/api/v1/analyze/${job_id}`)).json();
    if (j.status === 'succeeded' || j.status === 'failed') return j;
    await new Promise((s) => setTimeout(s, 25));
  }
  throw new Error('job không kết thúc');
}

test('/healthz khai backend none', async () => {
  const body = await (await fetch(`${base}/healthz`)).json();
  assert.equal(body.backend, 'none');
  assert.equal(body.model, null);
});

test('chạy trọn job mà không có key/JWT/CLI nào', async () => {
  const done = await analyze({
    run_id: 'R-NONE',
    repo_url: repoUrl,
    tickets_md: '## WEB-1001 — them man hinh login\n\nStatus: Done\n\n## ZZZ-999 — viec khong ai lam\n\nStatus: To Do',
  });
  assert.equal(done.status, 'succeeded', done.error);
  assert.equal(done.result.backend, 'none');
  assert.equal(done.result.stats.judge_calls, 2);
  assert.equal(done.result.stats.judge_parsed, 2);

  const [hit, miss] = done.result.items;
  assert.equal(hit.key, 'WEB-1001');
  // Hợp đồng v1.1: có evidence path thật → `done` với confidence thấp. Ðọc là
  // "source có code cho ticket này", không phải "đã làm đầy đủ".
  assert.equal(hit.code_status, 'done');
  assert.equal(hit.confidence, 0.25);
  assert.equal(hit.reason, 'matched_by_key');
  assert.equal(hit.mapping_state, 'linked');
  assert.ok(hit.evidence.length > 0);
  for (const ev of hit.evidence) {
    assert.ok(ev.path.endsWith('.py'), `chỉ file mã nguồn mới được trích: ${ev.path}`);
    assert.match(ev.lines, /^\d+$/);
  }
  assert.ok(hit.evidence.some((e) => e.path === 'src/session.py'), 'file mang ticket key phải có trong evidence');

  assert.equal(miss.key, 'ZZZ-999');
  assert.equal(miss.code_status, 'missing');
  assert.equal(miss.reason, 'no_match');
  assert.equal(miss.mapping_state, 'unlinked');
  assert.deepEqual(miss.evidence, []);
  // Ðây mới là lúc bản ghi quét quan trọng nhất: evidence rỗng mà ĐÃ quét thật.
  assert.ok(miss.scan, 'ticket không có evidence vẫn phải mang bản ghi quét');
  assert.ok(miss.scan.files_scanned > 0);
});

test('"done" của backend none là "source có code", không phải "đã làm đầy đủ"', async () => {
  // Ticket phải có ÍT NHẤT hai term đặc trưng: §4.1 đặt sàn `_MIN_TERMS = 2`, nên
  // một từ lặp lại ba lần vẫn chỉ là một term và cho shortlist rỗng (đúng như ca C).
  // Ba term đặc trưng, không phải hai: `min_terms_3` đòi ít nhất 3 term chung
  // giữa ticket và file. Cả ba đều có thật trong `src/login.py`.
  const done = await analyze({ repo_url: repoUrl, tickets_md: '## AUTH-7 — authenticate password username' });
  assert.equal(done.status, 'succeeded', done.error);
  const it = done.result.items[0];
  assert.equal(it.code_status, 'done');
  // Confidence thấp CHÍNH LÀ chỗ nói "đây chỉ là quét từ khoá". Trần cũ
  // ("không bao giờ done") sinh ra 138 JIRA_AHEAD giả trên 184 ticket nên đã bỏ;
  // nhưng con số này thì đừng nâng — nó là thứ còn lại để cảnh báo người đọc.
  assert.ok(it.confidence <= 0.3, `confidence phải thấp, nhận ${it.confidence}`);
  assert.ok(it.evidence.length > 0, '"done" mà không có evidence là vô nghĩa');
});

test('ép backend theo từng request qua field "backend"', async () => {
  const done = await analyze({ repo_url: repoUrl, tickets_md: '## K-1 — x', backend: 'none' });
  assert.equal(done.result.backend, 'none');
});
