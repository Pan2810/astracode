import { describe, expect, it } from 'vitest';
import { extractCredential } from './credential.js';

/**
 * Đầu vào của hàm này là clipboard của người dùng — văn bản tuỳ ý, đọc trong
 * lúc chờ họ đăng nhập. Hai hướng sai có giá khác nhau:
 *
 *   - Nhận sót: người dùng ngồi đợi một thứ không bao giờ tới.
 *   - Nhận nhầm: tốn một request 401 rồi thôi, vì gateway mới là chỗ phán xử.
 *
 * Nên phần dễ tính bên dưới là cố ý, còn phần từ chối chỉ cần chặn những thứ
 * KHÔNG THỂ là mã đăng nhập.
 */
describe('extractCredential', () => {
  const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJxdWFuZyJ9.c2lnbmF0dXJl';
  const CODE = 'Yy1kZWFkYmVlZi0xMjM0NTY3OA';

  describe('URL — dạng hay gặp nhất, vì copy thanh địa chỉ dễ hơn bôi đen mã', () => {
    it('lấy sso_code… à không, `code` từ query', () => {
      expect(extractCredential(`https://astrawork.vi-du.com/ide-auth?code=${CODE}`)).toEqual({
        kind: 'code',
        value: CODE,
      });
    });

    it('lấy `code` kể cả khi có tham số khác đứng trước', () => {
      expect(
        extractCredential(`https://astrawork.vi-du.com/login?next=%2F&code=${CODE}`),
      ).toEqual({ kind: 'code', value: CODE });
    });

    it('lấy token từ fragment — luồng implicit để token sau dấu #', () => {
      expect(extractCredential(`https://x.test/cb#access_token=${JWT}&type=bearer`)).toEqual({
        kind: 'token',
        value: JWT,
      });
    });

    it('đọc được cả deep link vscode://', () => {
      expect(extractCredential(`vscode://astracode.astracode/auth?code=${CODE}`)).toEqual({
        kind: 'code',
        value: CODE,
      });
    });

    it('token thắng code khi URL có cả hai — token dùng được ngay', () => {
      expect(extractCredential(`https://x.test/cb?code=${CODE}&token=${JWT}`)).toEqual({
        kind: 'token',
        value: JWT,
      });
    });

    it('URL không có tham số nào dùng được thì trả undefined', () => {
      expect(extractCredential('https://astrawork.vi-du.com/login')).toBeUndefined();
      expect(extractCredential('https://astrawork.vi-du.com/?next=/')).toBeUndefined();
    });
  });

  describe('chuỗi trần', () => {
    it('JWT ba phần là token', () => {
      expect(extractCredential(JWT)).toEqual({ kind: 'token', value: JWT });
    });

    it('bỏ tiền tố Bearer và khoảng trắng thừa', () => {
      expect(extractCredential(`  Bearer ${JWT}  `)).toEqual({ kind: 'token', value: JWT });
    });

    it('chuỗi đủ dài, đúng bộ ký tự là code', () => {
      expect(extractCredential(CODE)).toEqual({ kind: 'code', value: CODE });
    });
  });

  describe('từ chối', () => {
    it('văn bản người ta copy cho việc khác', () => {
      for (const junk of [
        'const x = 1;',
        'Đăng nhập AstraWork',
        'https://astrawork.vi-du.com',
        'a b c d e f g h i j k l m n o p',
      ]) {
        expect(extractCredential(junk)).toBeUndefined();
      }
    });

    it('chuỗi quá ngắn — dễ đụng phải một từ vừa copy', () => {
      expect(extractCredential('abc123')).toBeUndefined();
      expect(extractCredential('x'.repeat(15))).toBeUndefined();
    });

    it('rỗng, không phải chuỗi, hoặc dài bất thường', () => {
      expect(extractCredential('')).toBeUndefined();
      expect(extractCredential('   ')).toBeUndefined();
      expect(extractCredential('x'.repeat(9000))).toBeUndefined();
      expect(extractCredential(undefined as unknown as string)).toBeUndefined();
    });

    it('mã trong URL nhưng sai bộ ký tự thì không lấy', () => {
      expect(extractCredential('https://x.test/cb?code=' + encodeURIComponent('a b c d e f g h'))).toBeUndefined();
    });
  });
});
