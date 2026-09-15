/**
 * Đường chia giữa hai model mặc định là thứ dễ trôi nhất khi thêm vai mới: ai
 * cũng nhớ `editor`, ít ai nhớ `vision`. Ba ca dưới đây canh đúng chỗ đó.
 */
import { describe, it, expect } from 'vitest';
import { DEFAULT_MODEL_ID, DEFAULT_PLAN_MODEL_ID, defaultModelForRole } from './model.js';

describe('model mặc định theo vai', () => {
  it('đọc ảnh và lập kế hoạch đi tới model plan', () => {
    expect(defaultModelForRole('planner')).toBe(DEFAULT_PLAN_MODEL_ID);
    expect(defaultModelForRole('vision')).toBe(DEFAULT_PLAN_MODEL_ID);
  });

  it('sửa code và những lượt phụ đi tới model coding', () => {
    expect(defaultModelForRole('editor')).toBe(DEFAULT_MODEL_ID);
    // `fast` (đặt tiêu đề, nén hội thoại) chạy giữa một lượt làm việc thật nên
    // nó ở cùng phía với `editor`, không phải cùng phía với `planner`.
    expect(defaultModelForRole('fast')).toBe(DEFAULT_MODEL_ID);
  });

  it('hai mặc định là hai model khác nhau', () => {
    // Gộp chúng lại thì mọi thứ vẫn chạy, chỉ là toàn bộ lý do tách đôi biến
    // mất mà không có test nào đỏ.
    expect(DEFAULT_PLAN_MODEL_ID).not.toBe(DEFAULT_MODEL_ID);
  });
});
