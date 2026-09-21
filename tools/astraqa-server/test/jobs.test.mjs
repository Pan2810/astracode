/**
 * Chính sách sổ job: ai được vào, ai bị đẩy ra.
 *
 * Test ở cấp hàm thuần chứ không qua HTTP, vì cảnh cần dựng là "sổ đã đầy
 * 200 job" — dựng nó bằng 200 request thật thì test thành một bài đo tốc độ.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { admitJob, SETTLED } from '../lib/jobs.mjs';

const job = (id, status) => ({ id, status });

function soVoi(...jobs) {
  const m = new Map();
  for (const j of jobs) m.set(j.id, j);
  return m;
}

test('còn chỗ thì nhận thẳng, không đẩy ai ra', () => {
  const jobs = soVoi(job('a', 'running'));
  assert.equal(admitJob(jobs, job('b', 'queued'), 5), true);
  assert.deepEqual([...jobs.keys()], ['a', 'b']);
});

test('hết chỗ: đẩy job ÐÃ ÐÓNG SỔ cũ nhất, không đụng job đang chạy', () => {
  // `a` cũ nhất nhưng đang chạy; `b` mới hơn nhưng đã xong → `b` phải đi.
  const jobs = soVoi(job('a', 'running'), job('b', 'succeeded'), job('c', 'running'));
  assert.equal(admitJob(jobs, job('d', 'queued'), 3), true);
  assert.deepEqual([...jobs.keys()], ['a', 'c', 'd']);
  assert.equal(jobs.size, 3, 'không được vượt trần');
});

test('ba trạng thái đóng sổ đều được đẩy ra', () => {
  for (const status of SETTLED) {
    const jobs = soVoi(job('x', status));
    assert.equal(admitJob(jobs, job('y', 'queued'), 1), true, `${status} phải đẩy được`);
    assert.deepEqual([...jobs.keys()], ['y']);
  }
});

test('sổ đầy mà TOÀN job đang chạy → từ chối, và không job nào bị mất', () => {
  const jobs = soVoi(job('a', 'running'), job('b', 'queued'));
  assert.equal(admitJob(jobs, job('c', 'queued'), 2), false);
  assert.deepEqual([...jobs.keys()], ['a', 'b'], 'từ chối thì sổ phải nguyên vẹn');
});

test('một job đang chạy KHÔNG bao giờ biến mất dù sổ quay vòng nhiều lần', () => {
  // Ðây là ca đã hỏng ở bản trước: job dài rơi khỏi sổ khi job thứ 201 vào,
  // rồi poll trả 404 trong khi nó vẫn đang tiêu hạn mức.
  const max = 10;
  const jobs = soVoi(job('dai', 'running'));
  for (let i = 0; i < 100; i++) {
    const moi = job(`n${i}`, 'queued');
    assert.equal(admitJob(jobs, moi, max), true, `lượt ${i} phải nhận được`);
    moi.status = 'succeeded'; // job ngắn xong ngay, nhường chỗ cho lượt sau
    assert.ok(jobs.size <= max, 'trần phải giữ');
  }
  assert.ok(jobs.has('dai'), 'job đang chạy phải còn trong sổ sau 100 lượt');
});
