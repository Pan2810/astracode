import { describe, expect, it } from 'vitest';
import { Redactor } from './redactor.js';

describe('Redactor', () => {
  const r = new Redactor();

  it('che private key trọn khối', () => {
    const input = `trước
-----BEGIN RSA PRIVATE KEY-----
MIIEowIBAAKCAQEA1234567890
-----END RSA PRIVATE KEY-----
sau`;
    const { text, hits } = r.redact(input);
    expect(text).toContain('[REDACTED:private-key]');
    expect(text).not.toContain('MIIEowIBAAKCAQEA');
    expect(text).toContain('trước');
    expect(text).toContain('sau');
    expect(hits.map((h) => h.rule)).toContain('private-key');
  });

  it('che AWS access key', () => {
    const { text } = r.redact('AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE rồi thôi');
    expect(text).toContain('[REDACTED:aws-access-key]');
    expect(text).not.toContain('AKIAIOSFODNN7EXAMPLE');
  });

  it('che JWT', () => {
    const jwt =
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhZG1pbiIsImV4cCI6OTk5OTk5OTk5OX0.abcdefghijklmnop';
    expect(r.redactText(`token: ${jwt}`)).toContain('[REDACTED:jwt]');
  });

  it('che GitHub PAT và OpenAI key', () => {
    const out = r.redactText(
      'ghp_abcdefghijklmnopqrstuvwxyz0123456789 và sk-proj-abcdefghijklmnopqrstuvwxyz',
    );
    expect(out).toContain('[REDACTED:github-token]');
    expect(out).toContain('[REDACTED:openai-key]');
  });

  it('giữ scheme và host của connection string, chỉ che mật khẩu', () => {
    const out = r.redactText('postgresql://appuser:sup3rs3cret@db.internal:5432/prod');
    expect(out).toContain('postgresql://appuser:');
    expect(out).toContain('[REDACTED:connection-string]');
    expect(out).not.toContain('sup3rs3cret');
    // Host phải còn lại để log vẫn chẩn đoán được.
    expect(out).toContain('db.internal');
  });

  it('che Bearer token nhưng giữ chữ Bearer', () => {
    const out = r.redactText('Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345');
    expect(out).toContain('Bearer [REDACTED:bearer-token]');
    expect(out).not.toContain('abcdefghijklmnopqrstuvwxyz012345');
  });

  it('KHÔNG che password= ở chế độ mặc định (tránh báo nhầm trong code)', () => {
    const code = 'const password = "hunter2placeholder";';
    expect(r.redactText(code)).toBe(code);
  });

  it('che password= khi bật aggressive', () => {
    const code = 'const password = "hunter2placeholder";';
    const out = r.redactText(code, { aggressive: true });
    expect(out).toContain('[REDACTED:secret-assignment]');
    expect(out).not.toContain('hunter2placeholder');
    // Opt-in chỉ áp dụng cho lần gọi này; logger dùng cùng instance vẫn giữ
    // chế độ mặc định để không che nhầm mọi đoạn source trong log.
    expect(r.redactText(code)).toBe(code);
  });

  it('che literal đã đăng ký — lớp chắn cuối cho token đang giữ trong bộ nhớ', () => {
    const withLiteral = new Redactor();
    withLiteral.addLiteral('my-super-secret-session-token');
    const out = withLiteral.redactText('gọi với my-super-secret-session-token xong');
    expect(out).toContain('[REDACTED:literal]');
    expect(out).not.toContain('my-super-secret-session-token');
  });

  it('bỏ qua literal quá ngắn để không che nhầm mọi thứ', () => {
    const short = new Redactor();
    short.addLiteral('abc');
    expect(short.redactText('abc def abc')).toBe('abc def abc');
  });

  it('removeLiteral gỡ được sau khi logout', () => {
    const x = new Redactor();
    x.addLiteral('token-that-is-long-enough');
    x.removeLiteral('token-that-is-long-enough');
    expect(x.redactText('token-that-is-long-enough')).toBe('token-that-is-long-enough');
  });

  it('không dính lastIndex giữa các lần gọi (regex /g)', () => {
    const key = 'AKIAIOSFODNN7EXAMPLE';
    expect(r.redactText(key)).toContain('[REDACTED:aws-access-key]');
    // Lần thứ hai phải cho kết quả y hệt — nếu regex mang state thì sẽ trượt.
    expect(r.redactText(key)).toContain('[REDACTED:aws-access-key]');
  });

  describe('redactObject', () => {
    it('che theo TÊN key, bất kể giá trị trông thế nào', () => {
      const out = r.redactObject({
        authorization: 'giá trị vô hại',
        api_key: 'abc',
        nested: { password: 'x', keep: 'ok' },
      });
      expect(out.authorization).toBe('[REDACTED:key:authorization]');
      expect(out.api_key).toBe('[REDACTED:key:api_key]');
      expect(out.nested.password).toBe('[REDACTED:key:password]');
      expect(out.nested.keep).toBe('ok');
    });

    it('quét cả giá trị chuỗi ở key không nhạy cảm', () => {
      const out = r.redactObject({ note: 'key là AKIAIOSFODNN7EXAMPLE' });
      expect(out.note).toContain('[REDACTED:aws-access-key]');
    });

    it('xử lý mảng và giá trị null', () => {
      const out = r.redactObject({ list: ['AKIAIOSFODNN7EXAMPLE', null, 42] });
      expect(out.list[0]).toContain('[REDACTED:aws-access-key]');
      expect(out.list[1]).toBeNull();
      expect(out.list[2]).toBe(42);
    });

    it('không lặp vô hạn với object lồng quá sâu', () => {
      const deep: Record<string, unknown> = {};
      let cursor = deep;
      for (let i = 0; i < 20; i++) {
        const next: Record<string, unknown> = {};
        cursor.next = next;
        cursor = next;
      }
      expect(() => r.redactObject(deep)).not.toThrow();
    });
  });
});
