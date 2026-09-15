/** Bộ tách ticket: nhận cấu trúc, không nhận hình dạng của key. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseTickets } from '../lib/tickets.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name) => fs.readFileSync(path.join(here, '..', 'fixtures', name), 'utf8');

test('heading: key lấy từ tiêu đề, field Key: thắng tiêu đề', () => {
  const t = parseTickets(fixture('tickets-heading.md'));
  assert.deepEqual(
    t.map((x) => x.key),
    ['WEB-1001', '1024', 'EXP_7'],
  );
  assert.equal(t[0].status, 'Done');
  assert.equal(t[1].status, 'In Progress');
  assert.equal(t[0].title, 'Thêm màn hình đăng nhập');
});

test('bảng: cột "Mã"/"Trạng thái" tiếng Việt vẫn đọc được', () => {
  const t = parseTickets(fixture('tickets-table.md'));
  assert.deepEqual(
    t.map((x) => x.key),
    ['#77', 'ABC_42', 'ops.deploy.v2'],
  );
  assert.equal(t[0].title, 'Sửa lỗi 500 khi upload file rỗng');
  assert.equal(t[2].status, 'To Do');
});

test('key không theo quy ước Jira nào vẫn ra đúng', () => {
  const t = parseTickets(['## 7', '## feature/login', '## задача-3', '## TICKET~9'].join('\n'));
  assert.deepEqual(
    t.map((x) => x.key),
    ['7', 'feature/login', 'задача-3', 'TICKET~9'],
  );
});

test('danh sách gạch đầu dòng', () => {
  const t = parseTickets(['- P1 — làm A', '- P2 — làm B', '  Status: Done'].join('\n'));
  assert.deepEqual(
    t.map((x) => x.key),
    ['P1', 'P2'],
  );
  assert.equal(t[1].status, 'Done');
});

test('bỏ qua nội dung trong khối code', () => {
  const md = ['## K1 — thật', '', '```md', '## K2 — giả trong code fence', '```'].join('\n');
  assert.deepEqual(
    parseTickets(md).map((x) => x.key),
    ['K1'],
  );
});

test('rỗng hoặc không dò được cấu trúc thì ném, không trả mảng rỗng', () => {
  assert.throws(() => parseTickets(''), /rỗng/);
  assert.throws(() => parseTickets('chỉ là một đoạn văn xuôi không có cấu trúc gì'), /không dò ra ticket nào/);
});

test('key trùng thì ném', () => {
  assert.throws(() => parseTickets('## A-1 — x\n## A-1 — y'), /trùng/);
});
