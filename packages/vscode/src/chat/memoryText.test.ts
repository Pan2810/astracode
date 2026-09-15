/**
 * `withConvention` là hàm duy nhất trong đường `/memory` có thể ăn mất chữ của
 * người dùng: ASTRA.md do họ viết tay, và lệnh này ghi đè cả file. Hỏng ở đây
 * không báo lỗi gì — file vẫn ghi được, chỉ là mất một đoạn hoặc mọc thêm một
 * mục thứ hai mà lần gọi sau không tìm ra.
 */
import { describe, it, expect } from 'vitest';
import { CONVENTIONS_HEADING, MEMORY_TEMPLATE, withConvention } from './memoryText.js';

describe('withConvention — nối vào đúng mục', () => {
  it('đặt gạch đầu dòng ở cuối mục Project conventions, không phải cuối file', () => {
    const out = withConvention(MEMORY_TEMPLATE, 'Đặt tên biến bằng tiếng Anh');
    const lines = out.split('\n');

    const bullet = lines.findIndex((l) => l === '- Đặt tên biến bằng tiếng Anh');
    const nextHeading = lines.findIndex((l) => l === '## Careful around here');

    expect(bullet).toBeGreaterThan(lines.indexOf(CONVENTIONS_HEADING));
    expect(bullet).toBeLessThan(nextHeading);
  });

  it('giữ nguyên phần còn lại của file', () => {
    const out = withConvention(MEMORY_TEMPLATE, 'x');
    expect(out).toContain('- (example) Tests run with `pnpm test`, not `npm test`.');
    expect(out).toContain('- (example) Do not edit `src/generated/` — it is generated.');
    expect(out).toContain('# Notes for AstraCode');
  });

  it('gọi nhiều lần thì các rule nằm cạnh nhau, không rải rác', () => {
    const out = withConvention(withConvention(MEMORY_TEMPLATE, 'rule một'), 'rule hai');
    const lines = out.split('\n');

    expect(lines.indexOf('- rule hai')).toBe(lines.indexOf('- rule một') + 1);
  });

  /**
   * Không có mục thì phải DỰNG mục, không phải nối bừa vào cuối. Nối bừa thì
   * lần gọi sau lại không tìm thấy tiêu đề và lại nối bừa tiếp — mỗi lần một
   * chỗ khác nhau.
   */
  it('dựng mục khi file không có tiêu đề đó', () => {
    const out = withConvention('# Ghi chú\n\nMột đoạn văn.\n', 'không dùng var');

    expect(out).toContain(CONVENTIONS_HEADING);
    expect(out).toContain('- không dùng var');
    expect(out).toContain('Một đoạn văn.');
    expect(withConvention(out, 'thêm nữa').match(/## Project conventions/g)).toHaveLength(1);
  });

  it('mục rỗng vẫn chừa một dòng trắng sau tiêu đề', () => {
    const out = withConvention(`# T\n\n${CONVENTIONS_HEADING}\n\n## Sau\n\nx\n`, 'r');
    expect(out).toContain(`${CONVENTIONS_HEADING}\n\n- r\n`);
  });
});

describe('withConvention — chuẩn hoá câu người dùng gõ', () => {
  it('gộp rule nhiều dòng thành một gạch đầu dòng', () => {
    const out = withConvention(MEMORY_TEMPLATE, 'dòng một\ndòng hai   dòng ba');
    expect(out).toContain('- dòng một dòng hai dòng ba');
  });

  it('không nhân đôi dấu gạch khi người dùng tự gõ', () => {
    expect(withConvention(MEMORY_TEMPLATE, '- đã có gạch')).toContain('- đã có gạch');
    expect(withConvention(MEMORY_TEMPLATE, '- đã có gạch')).not.toContain('- - đã có gạch');
  });

  it('rule rỗng thì không đụng vào file', () => {
    expect(withConvention(MEMORY_TEMPLATE, '   \n  ')).toBe(MEMORY_TEMPLATE);
  });
});

/**
 * Repo này chạy trên Windows. Viết lại một file CRLF bằng LF làm git báo đổi
 * TOÀN BỘ dòng: một rule ba chữ biến thành diff cả trăm dòng, và người review
 * không còn thấy được thay đổi thật nằm ở đâu.
 */
describe('withConvention — kiểu xuống dòng', () => {
  it('file CRLF vẫn là CRLF sau khi ghi', () => {
    const crlf = MEMORY_TEMPLATE.replace(/\n/g, '\r\n');
    const out = withConvention(crlf, 'giữ CRLF');

    expect(out).toContain('- giữ CRLF');
    expect(out.split('\r\n').length).toBe(out.split('\n').length);
  });

  it('file LF không bị lẫn CR', () => {
    expect(withConvention(MEMORY_TEMPLATE, 'giữ LF')).not.toContain('\r');
  });
});
