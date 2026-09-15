/**
 * reconcileAnswers — chỗ nhạy cảm nhất về ranh giới tin cậy của
 * ask_user_question: webview có thể gửi lên bất cứ chuỗi nào, hàm này phải
 * lọc về đúng những gì model thật sự đã đưa ra làm lựa chọn.
 */
import { describe, expect, it } from 'vitest';
import { reconcileAnswers } from './questionReconcile.js';
import type { AskUserQuestion } from '@astra/core';

const singleSelect: AskUserQuestion = {
  header: 'Nguyên nhân',
  question: 'Nguyên nhân nào khả dĩ nhất?',
  options: [{ label: 'A' }, { label: 'B' }, { label: 'C' }],
};

const multiSelect: AskUserQuestion = {
  header: 'Kiểm tra',
  question: 'Kiểm tra những gì?',
  options: [{ label: 'X' }, { label: 'Y' }, { label: 'Z' }],
  multiSelect: true,
};

describe('reconcileAnswers', () => {
  it('lọc bỏ nhãn lạ không nằm trong options đã gửi', () => {
    const answers = reconcileAnswers([singleSelect], [['B', 'không tồn tại', '<script>']]);
    expect(answers).toEqual([{ header: 'Nguyên nhân', selected: ['B'] }]);
  });

  it('câu không multiSelect chỉ giữ lựa chọn đầu tiên dù webview gửi nhiều', () => {
    const answers = reconcileAnswers([singleSelect], [['A', 'B', 'C']]);
    expect(answers).toEqual([{ header: 'Nguyên nhân', selected: ['A'] }]);
  });

  it('câu multiSelect giữ mọi lựa chọn hợp lệ', () => {
    const answers = reconcileAnswers([multiSelect], [['X', 'Z']]);
    expect(answers).toEqual([{ header: 'Kiểm tra', selected: ['X', 'Z'] }]);
  });

  it('không chọn gì vẫn hợp lệ — trả về mảng rỗng, không phải bị loại', () => {
    const answers = reconcileAnswers([singleSelect], [[]]);
    expect(answers).toEqual([{ header: 'Nguyên nhân', selected: [] }]);
  });

  it('nhiều câu hỏi: đối chiếu đúng vị trí của từng câu', () => {
    const answers = reconcileAnswers([singleSelect, multiSelect], [['C'], ['X', 'Y']]);
    expect(answers).toEqual([
      { header: 'Nguyên nhân', selected: ['C'] },
      { header: 'Kiểm tra', selected: ['X', 'Y'] },
    ]);
  });

  it('số câu trả lời lệch số câu hỏi thì trả về undefined, không đoán ghép', () => {
    expect(reconcileAnswers([singleSelect, multiSelect], [['A']])).toBeUndefined();
    expect(reconcileAnswers([singleSelect], [['A'], ['X']])).toBeUndefined();
    expect(reconcileAnswers([singleSelect], [])).toBeUndefined();
  });
});
