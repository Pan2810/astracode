import { describe, expect, it } from 'vitest';
import { isDelegationRequested } from './delegation.js';

describe('isDelegationRequested', () => {
  it.each([
    'fix lỗi 422 theo hướng phù hợp',
    'implement tính năng lưu session',
    'scan toàn bộ source code và tạo tài liệu',
    'tại sao nó lại delegate rồi dừng?',
    'subagent trước đó vẫn implement bình thường mà?',
  ])('không tự delegate yêu cầu thông thường: %s', (conversation) => {
    expect(isDelegationRequested(conversation, ['code-implementer'])).toBe(false);
  });

  it.each([
    '/delegate scan repository',
    'delegate scan repository',
    'hãy delegate việc scan này cho agent con',
    'giao việc này cho agent con',
    'nhờ agent con kiểm tra dependency',
    'use a subagent to inspect the provider',
    'spawn the sub-agent for this investigation',
  ])('bật delegate khi người dùng yêu cầu rõ: %s', (conversation) => {
    expect(isDelegationRequested(conversation)).toBe(true);
  });

  it('bật delegate khi người dùng gọi đích danh agent', () => {
    expect(isDelegationRequested('nhờ code-explorer tìm luồng gọi gateway', ['code-explorer'])).toBe(
      true,
    );
  });

  it('không bật chỉ vì câu hỏi nhắc tên agent', () => {
    expect(
      isDelegationRequested('tại sao code-explorer được gọi ở lượt trước?', ['code-explorer']),
    ).toBe(false);
  });
});
