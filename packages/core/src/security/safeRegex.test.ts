import { describe, expect, it } from 'vitest';
import { compileSafeRegex, findCatastrophicRisk } from './safeRegex.js';

describe('findCatastrophicRisk — bắt lượng từ lồng nhau', () => {
  it('bắt các khuôn thảm hoạ kinh điển', () => {
    for (const pattern of [
      '(a+)+',
      '(a+)+$',
      '^(a+)+b',
      '(a*)*',
      '(a*|b)*',
      '(x+x+)+y',
      '((a+))+',
      '(?:a+)+',
      '(\\d+)*',
      '(a{2,}){3,}',
    ]) {
      expect(findCatastrophicRisk(pattern), pattern).toBeTruthy();
    }
  });

  it('KHÔNG bắt mẫu bình thường mà agent thật sự dùng', () => {
    // Từ chối oan còn tệ hơn: model sẽ thử lại đúng mẫu đó rồi bế tắc, và grep
    // là tool nó dùng nhiều nhất.
    for (const pattern of [
      'function login',
      'export (default )?function',
      '\\bclass\\s+\\w+',
      'TODO|FIXME',
      '^import .* from',
      '(?:async )?function \\w+\\(',
      '(?<name>[A-Z]\\w+)',
      'a{2,8}',
      '\\d+\\.\\d+',
      'foo(bar|baz)*',
      '(?:const|let|var) \\w+ =',
      '\\[[a-z+*]+\\]',
      '\\(a\\+\\)\\+',
      'password\\s*[:=]\\s*.+',
      '(a|b)?c',
    ]) {
      expect(findCatastrophicRisk(pattern), pattern).toBeUndefined();
    }
  });

  it('dấu +/* NẰM TRONG [...] là ký tự thường, không tính là lượng từ', () => {
    // `([a+*])+` an toàn: dấu `+` và `*` bên trong lớp ký tự là nghĩa đen, nên
    // nhóm không có lượng từ nào bên trong.
    expect(findCatastrophicRisk('([a+*])+')).toBeUndefined();
    expect(findCatastrophicRisk('([a+*]+)')).toBeUndefined();
    // Nhưng `+` NGAY SAU `]` là lượng từ thật, nên đây đúng là `(a+)+`.
    expect(findCatastrophicRisk('([a+*]+)+')).toBeTruthy();
  });

  it('lượng từ đã escape không tính', () => {
    expect(findCatastrophicRisk('(a\\+)+')).toBeUndefined();
  });

  it('bắt biên lượng từ quá lớn', () => {
    expect(findCatastrophicRisk('a{5000}')).toContain('5000');
    expect(findCatastrophicRisk('(ab){2000,}')).toBeTruthy();
    expect(findCatastrophicRisk('a{1,1000}')).toBeUndefined();
  });
});

describe('compileSafeRegex', () => {
  it('trả regex dùng được cho mẫu lành', () => {
    const out = compileSafeRegex('function \\w+', { flags: 'gi' });
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.regex.test('async function login')).toBe(true);
      expect(out.regex.flags).toBe('gi');
    }
  });

  it('từ chối mẫu thảm hoạ kèm câu nói được phải sửa gì', () => {
    const out = compileSafeRegex('(a+)+$');
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.reason).toContain('lồng nhau');
      // Câu này đi thẳng về cho model; không nói cách viết lại thì nó thử lại mẫu cũ.
      expect(out.reason).toContain('Viết lại');
    }
  });

  it('từ chối mẫu quá dài', () => {
    const out = compileSafeRegex('a'.repeat(600));
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toContain('600');
  });

  it('tôn trọng maxLength riêng của người gọi', () => {
    expect(compileSafeRegex('a'.repeat(250)).ok).toBe(true);
    expect(compileSafeRegex('a'.repeat(250), { maxLength: 200 }).ok).toBe(false);
  });

  it('từ chối mẫu không biên dịch được, giữ nguyên thông báo của engine', () => {
    const out = compileSafeRegex('(unclosed');
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toContain('không hợp lệ');
  });

  it('từ chối mẫu rỗng', () => {
    expect(compileSafeRegex('').ok).toBe(false);
  });

  it('mẫu bị từ chối thì KHÔNG bao giờ chạy — kiểm bằng đồng hồ', () => {
    // Ca này là lý do cả module tồn tại: nếu `compileSafeRegex` cho qua `(a+)+b`
    // thì dòng dưới đây treo hàng phút. Nó phải trả về ngay.
    const started = Date.now();
    const out = compileSafeRegex('(a+)+b');
    expect(out.ok).toBe(false);
    expect(Date.now() - started).toBeLessThan(50);
  });
});
