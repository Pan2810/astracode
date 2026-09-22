import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseJsonTickets } from '../lib/tickets.mjs';
import { buildPrompt, buildJudgePrompt } from '../lib/prompt.mjs';

test('document version and citation survive ticket parsing and both judge prompts', () => {
  const statement = 'Tài khoản bị khóa sau 5 lần đăng nhập sai.';
  const [ticket] = parseJsonTickets([{
    key: 'SG-1', summary: statement, status: '',
    description: JSON.stringify({ issue_key: 'APP-1', axis: 'code_vs_docs', subject_id: 'claim-1',
      document_citations: [{ path: 'docs/login.md', version_id: 'version-2', chunk_id: 'chunk-4', section: 'Login' }] }),
    acceptance_criteria: [statement],
  }]);
  for (const prompt of [buildPrompt({ ticket }), buildJudgePrompt({ ticket, context: 'src/login.py:1' })]) {
    assert.ok(prompt.includes(statement));
    assert.ok(prompt.includes('version-2'));
    assert.ok(prompt.includes('chunk-4'));
    assert.ok(prompt.includes('docs/login.md'));
    assert.ok(prompt.includes('never cite documentation prose as proof of implementation'));
  }
});
