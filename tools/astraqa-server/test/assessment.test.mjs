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
