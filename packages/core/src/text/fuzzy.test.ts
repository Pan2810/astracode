import { describe, expect, it } from 'vitest';
import { fuzzyMatch, fuzzyRank } from './fuzzy.js';

const best = (items: string[], query: string): string | undefined =>
  fuzzyRank(items, query, (s) => s)[0]?.item;

describe('fuzzyMatch', () => {
  it('khớp dãy con, không cần liền nhau', () => {
    expect(fuzzyMatch('speckit-plan', 'spkpl')).toBeDefined();
    expect(fuzzyMatch('speckit-plan', 'plan')).toBeDefined();
  });

  it('thiếu một ký tự là không khớp', () => {
    expect(fuzzyMatch('speckit-plan', 'spx')).toBeUndefined();
  });

  it('không phân biệt hoa thường', () => {
    expect(fuzzyMatch('README.md', 'readme')).toBeDefined();
  });

  /** Ô gợi ý vừa mở phải hiện đủ danh sách, không phải hiện rỗng. */
  it('query rỗng khớp mọi thứ', () => {
    expect(fuzzyMatch('bất kỳ', '')).toEqual({ score: 0, positions: [] });
  });

  it('trả vị trí khớp để tô đậm', () => {
    expect(fuzzyMatch('plan', 'pn')!.positions).toEqual([0, 3]);
  });
});

describe('fuzzyRank', () => {
  it('khớp liền mạch thắng khớp rải rác', () => {
    expect(best(['p-l-a-n-x', 'plan'], 'plan')).toBe('plan');
  });

  it('khớp từ đầu thắng khớp giữa chuỗi', () => {
    expect(best(['xxxplan', 'planxxx'], 'plan')).toBe('planxxx');
  });

  it('khớp ở ranh giới từ được cộng điểm', () => {
    expect(best(['speckitplanxx', 'speckit-plan'], 'plan')).toBe('speckit-plan');
  });

  /** Đường dẫn dài không được đè bẹp file có tên đúng. */
  it('đường dẫn ngắn thắng đường dẫn dài khi cùng khớp', () => {
    expect(best(['a/b/c/d/e/chat.ts', 'chat.ts'], 'chat')).toBe('chat.ts');
  });

  it('loại thứ không khớp', () => {
    expect(fuzzyRank(['alpha', 'beta'], 'zzz', (s) => s)).toEqual([]);
  });

  it('thứ tự ổn định khi điểm bằng nhau', () => {
    const items = ['b.ts', 'a.ts'];
    expect(fuzzyRank(items, '', (s) => s).map((r) => r.item)).toEqual(['a.ts', 'b.ts']);
  });

  it('cắt theo limit', () => {
    expect(fuzzyRank(['a', 'ab', 'abc'], 'a', (s) => s, 2)).toHaveLength(2);
  });
});
