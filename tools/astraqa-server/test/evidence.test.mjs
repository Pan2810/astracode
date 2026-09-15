/**
 * Bộ lọc evidence — phần tất định duy nhất của cả pipeline.
 *
 * Bốn luật, test đủ bốn:
 *   path không tồn tại  → loại
 *   start > số dòng     → loại
 *   end   > số dòng     → KẸP về cuối file, giữ lại
 *   thiếu lines         → giữ, lines = null
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { keepRealEvidence } from '../lib/analyze.mjs';

const OPTS = { max_files_per_ticket: 5, exclude_globs: ['**/dist/**'] };
let repo;

before(async () => {
  repo = await fs.mkdtemp(path.join(os.tmpdir(), 'astraqa-ev-'));
  // 5 dòng đúng theo quy ước đếm (xuống dòng cuối không thành dòng thứ 6).
  await fs.writeFile(path.join(repo, 'five.txt'), 'a\nb\nc\nd\ne\n');
  await fs.mkdir(path.join(repo, 'dist'), { recursive: true });
  await fs.writeFile(path.join(repo, 'dist', 'built.js'), 'x\n');
});

after(async () => {
  await fs.rm(repo, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
});

const run = (evidence, opts = OPTS) => keepRealEvidence(evidence, repo, opts);

test('path không tồn tại → loại', async () => {
  const r = await run([{ path: 'khong/co/that.ts', lines: '1-2', note: '' }]);
  assert.equal(r.evidence.length, 0);
  assert.equal(r.dropped.length, 1);
  assert.match(r.dropped[0].why, /không tồn tại trong repo/);
});

test('start > số dòng file → loại', async () => {
  const r = await run([{ path: 'five.txt', lines: '99-120', note: '' }]);
  assert.equal(r.evidence.length, 0);
  assert.equal(r.clamped.length, 0, 'start sai thì loại hẳn, không kẹp');
  assert.match(r.dropped[0].why, /dòng bắt đầu 99 nằm ngoài file \(5 dòng\)/);
});

test('end > số dòng file → kẹp về số dòng file, giữ lại', async () => {
  const r = await run([{ path: 'five.txt', lines: '3-999', note: 'hàm X' }]);
  assert.equal(r.dropped.length, 0);
  assert.deepEqual(r.evidence, [{ path: 'five.txt', lines: '3-5', note: 'hàm X' }]);
  assert.deepEqual(r.clamped, [{ path: 'five.txt', from: '3-999', to: '3-5' }]);
});

test('kẹp về đúng một dòng khi start trùng dòng cuối', async () => {
  const r = await run([{ path: 'five.txt', lines: '5-900', note: '' }]);
  assert.equal(r.evidence[0].lines, '5');
  assert.deepEqual(r.clamped, [{ path: 'five.txt', from: '5-900', to: '5' }]);
});

test('thiếu lines → giữ, lines = null', async () => {
  for (const ev of [{ path: 'five.txt', note: 'n' }, { path: 'five.txt', lines: '', note: 'n' }]) {
    const r = await run([ev]);
    assert.equal(r.dropped.length, 0);
    assert.equal(r.evidence.length, 1);
    assert.equal(r.evidence[0].lines, null, 'phải là null, không phải chuỗi rỗng');
  }
});

test('lines đúng dạng và nằm trọn trong file thì giữ nguyên', async () => {
  const r = await run([{ path: 'five.txt', lines: '2-4', note: '' }]);
  assert.equal(r.evidence[0].lines, '2-4');
  assert.equal(r.clamped.length, 0);
});

test('các luật phụ vẫn giữ: exclude_globs, thoát repo, dạng lines lạ, trần số file', async () => {
  assert.match((await run([{ path: 'dist/built.js', lines: '1' }])).dropped[0].why, /exclude_globs/);
  assert.match((await run([{ path: '../../etc/passwd', lines: '1' }])).dropped[0].why, /thoát khỏi repo|ngoài repo/);
  assert.match((await run([{ path: 'five.txt', lines: 'khoang 3 toi 4' }])).dropped[0].why, /không đúng dạng/);

  const many = await run(
    [
      { path: 'five.txt', lines: '1' },
      { path: 'khong-co-1.txt', lines: '1' },
    ],
    { ...OPTS, max_files_per_ticket: 1 },
  );
  assert.equal(many.evidence.length, 1);
});

test('lines gộp trong path (five.txt:2-3) vẫn tách và kiểm được', async () => {
  const r = await run([{ path: 'five.txt:2-3', note: '' }]);
  assert.deepEqual(r.evidence, [{ path: 'five.txt', lines: '2-3', note: '' }]);
});
