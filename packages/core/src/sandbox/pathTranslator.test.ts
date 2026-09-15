import { describe, expect, it } from 'vitest';
import { PathTranslator } from './Sandbox.js';

describe('PathTranslator — host ↔ container', () => {
  const t = new PathTranslator('C:\\Work\\repo');

  it('đổi đường dẫn Windows sang đường container', () => {
    expect(t.toContainer('C:\\Work\\repo\\src\\a.ts')).toBe('/workspace/src/a.ts');
    expect(t.toContainer('C:\\Work\\repo')).toBe('/workspace');
  });

  it('không phân biệt hoa thường khi so root — Windows không phân biệt', () => {
    expect(t.toContainer('c:\\work\\REPO\\src\\a.ts')).toBe('/workspace/src/a.ts');
  });

  it('để nguyên đường dẫn ngoài workspace', () => {
    expect(t.toContainer('C:\\Windows\\System32')).toBe('C:\\Windows\\System32');
  });

  it('đổi ngược về đường host', () => {
    expect(t.toHost('/workspace/src/a.ts')).toBe('C:\\Work\\repo\\src\\a.ts');
    expect(t.toHost('/workspace')).toBe('C:\\Work\\repo');
  });

  it('đi vòng qua lại vẫn ra chính nó', () => {
    const original = 'C:\\Work\\repo\\packages\\core\\src\\index.ts';
    expect(t.toHost(t.toContainer(original))).toBe(original);
  });

  it('viết lại output của lệnh để model không thấy đường dẫn lạ', () => {
    const output = [
      '/workspace/src/a.ts:12:5 - error TS2304',
      '  tại /workspace/test/b.spec.ts',
      'không đụng /usr/lib/node',
    ].join('\n');

    const rewritten = t.rewriteOutput(output);

    expect(rewritten).toContain('C:\\Work\\repo\\src\\a.ts:12:5');
    expect(rewritten).toContain('C:\\Work\\repo\\test\\b.spec.ts');
    // Đường dẫn thật của container thì để yên — nó không phải file của repo.
    expect(rewritten).toContain('/usr/lib/node');
  });

  it('viết lại lệnh: model nghĩ theo đường host vì đó là thứ nó đọc được', () => {
    expect(t.rewriteCommand('npx tsc -p C:\\Work\\repo\\tsconfig.json')).toBe(
      'npx tsc -p /workspace\\tsconfig.json',
    );
    expect(t.rewriteCommand('cat C:/Work/repo/package.json')).toBe(
      'cat /workspace/package.json',
    );
  });

  it('dùng được với root kiểu POSIX', () => {
    const posix = new PathTranslator('/home/me/repo');
    expect(posix.toContainer('/home/me/repo/src/a.ts')).toBe('/workspace/src/a.ts');
    expect(posix.toHost('/workspace/src/a.ts')).toBe('/home/me/repo/src/a.ts');
  });
});
