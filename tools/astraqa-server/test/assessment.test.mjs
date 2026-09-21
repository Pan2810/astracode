import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { normalizeAssessment, notAssessed } from '../lib/assessment.mjs';
import { keepRealEvidence } from '../lib/analyze.mjs';

const options = { exclude_globs: [], max_files_per_ticket: 5 };

test('AC citations must have real lines and model-reported tests do not verify implementation', async () => {
  const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'astra-ac-'));
  try {
    await fs.writeFile(path.join(repoDir, 'api.ts'), 'export function enabled() {\n  return true;\n}\n');
    const assessment = await normalizeAssessment({
      raw: [
        { id: 1, status: 'satisfied', test_status: 'passed', evidence: [{ path: 'api.ts', lines: '1-2' }] },
        { id: 2, status: 'satisfied', evidence: [{ path: 'absent.ts', lines: '1' }] },
      ],
      ticket: { acceptance_criteria: ['API is enabled', 'Audit is written'] },
      repoDir, options, validateEvidence: keepRealEvidence,
    });
    assert.equal(assessment.state, 'partial');
    assert.deepEqual(assessment.criteria.map((c) => c.status), ['satisfied', 'unknown']);
    assert.equal(assessment.criteria[0].test_status, 'not_run');
    assert.equal(assessment.test_status, 'not_run');
  } finally {
    await fs.rm(repoDir, { recursive: true, force: true });
  }
});

test('missing AC replies remain unknown; all cited AC still only yields unverified', async () => {
  const validateEvidence = async (evidence) => ({ evidence });
  const base = { ticket: { acceptance_criteria: ['one', 'two'] }, repoDir: '.', options, validateEvidence };
  const missing = await normalizeAssessment({ ...base, raw: [{ id: 1, status: 'satisfied', evidence: [{ path: 'a', lines: '1' }] }] });
  assert.equal(missing.criteria[1].status, 'unknown');
  const all = await normalizeAssessment({ ...base, raw: [1, 2].map((id) => ({ id, status: 'satisfied', evidence: [{ path: 'a', lines: '1' }] })) });
  assert.equal(all.state, 'implemented_unverified');
  const noAc = await normalizeAssessment({ ...base, ticket: { acceptance_criteria: [] }, raw: [] });
  assert.equal(noAc.state, 'not_assessed');
  assert.deepEqual(notAssessed(base.ticket).criteria.map((criterion) => criterion.status), ['unknown', 'unknown']);
});

/*
 * Hai chiều khẳng định, hai luật.
 *
 * Bản trước đòi dẫn chứng cho MỌI status khác `unknown`, kể cả
 * `not_satisfied` — mà một tiêu chí chưa làm thì tự nhiên không có dẫn chứng.
 * Hệ quả: mọi `not_satisfied` bị hạ về `unknown`, `state: "not_implemented"`
 * gần như không bao giờ đạt tới, và AstraQA mất đúng tín hiệu dẫn tới
 * JIRA_AHEAD.
 */
const khongCanDoc = async (evidence) => ({ evidence, dropped: [], clamped: [] });

test('not_satisfied KHÔNG đòi dẫn chứng — nó đòi phạm vi quét', async () => {
  const chung = {
    raw: [{ id: 1, status: 'not_satisfied', reason: 'không có endpoint nào' }],
    ticket: { acceptance_criteria: ['POST /orders trả 201'] },
    repoDir: '.', options: {}, validateEvidence: khongCanDoc,
  };

  // Ðã quét thật → giữ nguyên khẳng định âm.
  const daQuet = await normalizeAssessment({ ...chung, coverage: true });
  assert.equal(daQuet.criteria[0].status, 'not_satisfied');
  assert.equal(daQuet.state, 'not_implemented');

  // Chưa chứng minh được là đã tìm → "không thấy" chỉ là "chưa nhìn".
  const chuaQuet = await normalizeAssessment({ ...chung, coverage: false });
  assert.equal(chuaQuet.criteria[0].status, 'unknown');
  assert.equal(chuaQuet.state, 'not_assessed');
});

test('coverage KHÔNG nới lỏng chiều dương: satisfied vẫn phải có dòng mở được', async () => {
  const r = await normalizeAssessment({
    raw: [
      { id: 1, status: 'satisfied', evidence: [] },
      { id: 2, status: 'partial', evidence: [{ path: 'a', lines: '' }] },
    ],
    ticket: { acceptance_criteria: ['một', 'hai'] },
    repoDir: '.', options: {}, validateEvidence: khongCanDoc,
    coverage: true,
  });
  // Không dẫn chứng, và dẫn chứng không có số dòng — cả hai đều không đủ.
  assert.deepEqual(r.criteria.map((c) => c.status), ['unknown', 'unknown']);
});

test('mặc định không truyền coverage thì hành xử như chưa quét', async () => {
  const r = await normalizeAssessment({
    raw: [{ id: 1, status: 'not_satisfied' }],
    ticket: { acceptance_criteria: ['một'] },
    repoDir: '.', options: {}, validateEvidence: khongCanDoc,
  });
  assert.equal(r.criteria[0].status, 'unknown');
});

test('trộn: một AC đạt, một AC chưa làm → partial, và cả hai giữ nguyên chữ', async () => {
  const r = await normalizeAssessment({
    raw: [
      { id: 1, status: 'satisfied', evidence: [{ path: 'a', lines: '3' }] },
      { id: 2, status: 'not_satisfied', reason: 'chưa có' },
    ],
    ticket: { acceptance_criteria: ['một', 'hai'] },
    repoDir: '.', options: {}, validateEvidence: khongCanDoc,
    coverage: true,
  });
  assert.deepEqual(r.criteria.map((c) => c.status), ['satisfied', 'not_satisfied']);
  assert.equal(r.state, 'partial');
});
