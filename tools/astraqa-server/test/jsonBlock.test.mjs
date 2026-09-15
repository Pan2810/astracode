/** Bóc + kiểm khối ```json. Mọi đường sai đều phải NÉM, không có giá trị mặc định. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractJsonBlock, pickItem } from '../lib/jsonBlock.mjs';

const ok = (key = 'K-1', over = {}) => ({
  items: [
    {
      key,
      code_status: 'partial',
      confidence: 0.4,
      evidence: [{ path: 'src/a.ts', lines: '10-20', note: 'n' }],
      reason: 'matched_by_key',
      ...over,
    },
  ],
});

const fence = (obj) => '· read_file x\n```json\n' + JSON.stringify(obj) + '\n```\n';

test('lấy khối json cuối cùng khi model in nhiều khối', () => {
  const out = fence(ok('K-1')) + fence(ok('K-2'));
  assert.equal(extractJsonBlock(out).items[0].key, 'K-2');
});

test('không có khối json thì ném', () => {
  assert.throws(() => extractJsonBlock('tôi nghĩ là đã xong rồi'), /không trả về khối/);
});

test('khối json hỏng cú pháp thì ném, không nuốt', () => {
  assert.throws(() => extractJsonBlock('```json\n{items: [}\n```'), /không parse được/);
});

test('item hợp lệ đi qua, key lấy theo tickets_md', () => {
  const item = pickItem(ok('K-1'), 'k-1');
  assert.equal(item.key, 'k-1');
  assert.equal(item.code_status, 'partial');
  assert.equal(item.evidence.length, 1);
});

test('mọi vi phạm schema đều ném kèm tên ticket và field sai', () => {
  const cases = [
    [{}, /items/],
    [{ items: [] }, /rỗng/],
    [ok('KHAC'), /không có item nào mang đúng key/],
    [ok('K-1', { code_status: 'DONE?' }), /code_status/],
    [ok('K-1', { confidence: 1.7 }), /confidence/],
    [ok('K-1', { confidence: 'cao' }), /confidence/],
    [ok('K-1', { evidence: 'src/a.ts' }), /evidence/],
    [ok('K-1', { evidence: [{ lines: '1' }] }), /path/],
    [ok('K-1', { reason: '' }), /reason/],
  ];
  for (const [payload, re] of cases) {
    assert.throws(() => pickItem(payload, 'K-1'), re, `phải ném với ${JSON.stringify(payload).slice(0, 60)}`);
    assert.throws(() => pickItem(payload, 'K-1'), /K-1/);
  }
});
