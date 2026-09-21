/**
 * Hai bất biến mà chỉ lộ ra khi có thứ gì đó hỏng giữa chừng:
 *
 *   1. MỖI request nhận đúng một hồi âm — kể cả khi một route ném.
 *   2. Một job đã chiếm chỗ trong sổ mà chưa ai chạy thì phải được bỏ ra.
 *
 * Cả hai đi chung một cảnh: cho sổ log ném đúng ở dòng POST, tức trong khoảng
 * giữa `admit()` và `start()`. Ðo trên bản trước khi sửa: client báo
 * "KHÔNG CÓ HỒI ÂM (TimeoutError)", Node báo unhandled rejection, và job nằm
 * lại sổ ở trạng thái `queued` — vĩnh viễn, vì sổ chỉ đẩy job đã đóng sổ.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from '../server.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const TOKEN = 'service-token-dung-cho-test-0123456789';

let tmp;
let server;
let base;
/** Bật lên thì sổ log ném đúng ở dòng POST của analyze. */
let soLogHong = false;

before(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'astraqa-resil-'));
  server = createServer(
    {
      port: 0,
      workspaceDir: path.join(tmp, 'ws'),
      runsDir: path.join(tmp, 'runs'),
      cliPath: path.join(here, 'fakeCli.mjs'),
      astraworkJwt: '',
      serviceToken: TOKEN,
      judgeBackend: 'cli',
      fciBaseUrl: '',
      fciApiKey: '',
      fciModel: '',
    },
    {
      log: (row) => {
        if (soLogHong && String(row).includes('POST /api/v1/analyze')) throw new Error('đĩa hỏng');
      },
      persist: false,
    },
  );
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((r) => server.close(r));
  await fs.rm(tmp, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
});

const H = { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` };

async function postAnalyze() {
  return fetch(`${base}/api/v1/analyze`, {
    method: 'POST',
    headers: H,
    body: JSON.stringify({ repo_url: 'file:///khong-ton-tai', tickets_md: '## A-1 — x' }),
    // Nếu server không trả lời thì đây là thứ cứu test khỏi treo — và cũng là
    // đúng thứ đã xảy ra trước khi sửa.
    signal: AbortSignal.timeout(4000),
  });
}

async function demSo() {
  const res = await fetch(`${base}/api/v1/jobs`, { headers: H });
  const body = await res.json();
  const rows = body?.jobs ?? body;
  return Array.isArray(rows) ? rows : [];
}

test('route ném → 500 có thân JSON, KHÔNG phải một request treo', async () => {
  soLogHong = true;
  try {
    const res = await postAnalyze();
    assert.equal(res.status, 500);
    const body = await res.json();
    assert.match(body.error, /lỗi nội bộ/);
  } finally {
    soLogHong = false;
  }
});

test('job vào sổ rồi hỏng trước khi chạy → được bỏ ra, không giữ chỗ', async () => {
  soLogHong = true;
  try {
    // Ðủ nhiều để nếu có rò thì rò thấy rõ, mà vẫn nhanh: không lượt nào clone.
    for (let i = 0; i < 25; i++) {
      const res = await postAnalyze();
      assert.equal(res.status, 500, `lượt ${i} phải là 500`);
      await res.arrayBuffer();
    }
  } finally {
    soLogHong = false;
  }
  const treo = (await demSo()).filter((j) => j.status === 'queued');
  assert.equal(treo.length, 0, `không được để lại job "queued" nào, thấy ${treo.length}`);
});

test('sau 25 lượt hỏng, server vẫn nhận job mới bình thường', async () => {
  // Ðây mới là hệ quả thật của việc rò chỗ: đủ 200 lần là chỉ còn 503.
  const res = await fetch(`${base}/api/v1/analyze`, {
    method: 'POST',
    headers: H,
    body: JSON.stringify({ repo_url: 'file:///khong-ton-tai', tickets_md: '## OK-1 — x' }),
  });
  assert.equal(res.status, 202);
  const { job_id } = await res.json();
  assert.ok(job_id);
});
