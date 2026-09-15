/**
 * Bộ tô markdown cho terminal.
 *
 * Test chạy với `NO_COLOR` (vitest không phải TTY) nên `c.*` là hàm rỗng —
 * điều đó thành ra tiện: những gì kiểm ở đây là CẤU TRÚC (cột có thẳng không,
 * cú pháp có bị nuốt không), không phải mã màu. Cấu trúc mới là thứ hỏng thì
 * người dùng thấy.
 */
import { describe, it, expect } from 'vitest';
import { MarkdownStream, inline, visibleLength } from './markdown.js';

/** Chạy một chuỗi qua bộ tô, trả về các dòng in ra. */
function render(input: string, opts?: { chunks?: number }): string[] {
  const lines: string[] = [];
  const md = new MarkdownStream((l) => lines.push(l), { width: 40 });
  if (opts?.chunks) {
    // Cắt vụn để mô phỏng stream — kết quả phải y hệt khi đẩy một lần.
    const size = Math.ceil(input.length / opts.chunks);
    for (let i = 0; i < input.length; i += size) md.push(input.slice(i, i + size));
  } else {
    md.push(input);
  }
  md.end();
  return lines;
}

describe('inline', () => {
  it('bỏ dấu cú pháp của đậm, nghiêng, code', () => {
    expect(inline('**đậm** và `code` và *nghiêng*')).toBe('đậm và code và nghiêng');
  });

  it('không đụng vào dấu sao NẰM TRONG code', () => {
    // Code sai một ký tự là code không chạy. `**` ở đây là toán tử luỹ thừa,
    // không phải cú pháp markdown.
    expect(inline('dùng `a ** b` để tính')).toBe('dùng a ** b để tính');
  });

  it('không nuốt số nằm giữa hai khoảng trắng', () => {
    // Bản đầu dùng " 0 " làm chỗ giữ chỗ cho code span; một câu như câu này
    // sẽ bị ăn mất chữ số. Chỗ giữ chỗ phải là ký tự không có trong văn bản.
    expect(inline('in 0 dòng và `x` nữa')).toBe('in 0 dòng và x nữa');
  });

  it('link giữ lại cả nhãn lẫn địa chỉ', () => {
    // Terminal không bấm được, nên giấu URL đi là làm mất thông tin.
    expect(inline('xem [tài liệu](https://a.b)')).toBe('xem tài liệu https://a.b');
  });

  it('dấu sao lẻ không phải cú pháp thì để yên', () => {
    expect(inline('2 * 3 = 6')).toBe('2 * 3 = 6');
  });
});

describe('MarkdownStream — khối', () => {
  it('tiêu đề bỏ dấu thăng', () => {
    expect(render('### Tóm lại').join('\n')).toContain('Tóm lại');
    expect(render('### Tóm lại').join('\n')).not.toContain('#');
  });

  it('gạch đầu dòng đổi thành chấm tròn', () => {
    const out = render('- một\n- hai').join('\n');
    expect(out).toContain('• một');
    expect(out).toContain('• hai');
  });

  it('giữ nguyên từng ký tự bên trong ```', () => {
    // Trong khối code, `**` và `#` là nội dung, không phải cú pháp. Tô chúng
    // là làm hỏng đoạn code người dùng sắp copy đi chạy.
    const out = render('```ts\nconst a = b ** 2; // # ghi chú\n```').join('\n');
    expect(out).toContain('const a = b ** 2; // # ghi chú');
  });

  it('không in dấu ``` ra màn hình', () => {
    expect(render('```\nx\n```').join('\n')).not.toContain('```');
  });
});

describe('MarkdownStream — bảng', () => {
  const TABLE = [
    '| Hàm | File | Mục đích |',
    '|---|---|---|',
    '| `runLogin` | `cli/src/auth-cmd.ts:29` | entry point |',
    '| `exchangeSsoCode` | `core/src/auth/AstraWorkAuth.ts:99` | đổi mã SSO |',
  ].join('\n');

  it('không còn dấu gạch đứng nào', () => {
    // Đây chính là thứ xấu ở bản trước: bảng rơi ra terminal ở dạng thô.
    const out = render(TABLE);
    expect(out.join('\n')).not.toContain('|');
  });

  it('bỏ dòng kẻ ngăn |---|', () => {
    expect(render(TABLE).join('\n')).not.toContain('---');
  });

  it('cột thẳng hàng', () => {
    const rows = render(TABLE).filter((l) => l.includes('runLogin') || l.includes('exchangeSsoCode'));
    expect(rows).toHaveLength(2);
    // Cột 2 của mọi hàng phải bắt đầu ở cùng một vị trí.
    const start = rows.map((r) => r.indexOf('cli/src') >= 0 ? r.indexOf('cli/src') : r.indexOf('core/src'));
    expect(start[0]).toBe(start[1]);
  });

  it('bảng cuối lượt vẫn được in ra', () => {
    // Bảng phải gom cả khối mới đo được cột, nên nó nằm trong bộ đệm cho tới
    // khi gặp dòng không phải bảng — hoặc tới `end()`. Quên xả là mất bảng.
    expect(render(TABLE).join('\n')).toContain('runLogin');
  });

  it('hàng thiếu ô không làm lệch bảng', () => {
    const out = render('| a | b | c |\n|---|---|---|\n| 1 |').join('\n');
    expect(out).toContain('1');
    expect(out).not.toContain('|');
  });
});

describe('MarkdownStream — stream', () => {
  it('cắt vụn thành nhiều mẩu vẫn ra kết quả y hệt', () => {
    // Model trả chữ theo token, dấu `**` thường bị cắt làm đôi giữa hai mẩu.
    const src = '## Tiêu đề\n\n- **đậm** và `code`\n\n| a | b |\n|---|---|\n| 1 | 2 |\n';
    expect(render(src, { chunks: 37 })).toEqual(render(src));
  });

  it('end() xả nốt dòng chưa xuống hàng', () => {
    const lines: string[] = [];
    const md = new MarkdownStream((l) => lines.push(l));
    md.push('dòng cuối không có ký tự xuống dòng');
    expect(lines).toHaveLength(0); // chưa hết dòng thì chưa in
    md.end();
    expect(lines.join('')).toContain('dòng cuối');
  });
});

describe('MarkdownStream — khoảng trắng', () => {
  it('không nhân đôi dòng trống quanh tiêu đề và bảng', () => {
    // Tiêu đề và bảng tự chèn một dòng thở, mà markdown thật thường đã có sẵn
    // dòng trống ở đó. Cộng lại thì cả câu trả lời trôi khỏi màn hình.
    const out = render('# T\n\n| a |\n|---|\n| 1 |\n\nxong');
    expect(out.some((l, i) => l === '' && out[i + 1] === '')).toBe(false);
  });

  it('không mở đầu bằng dòng trống', () => {
    expect(render('# Tiêu đề')[0]).not.toBe('');
  });
});

describe('visibleLength', () => {
  it('không tính mã màu', () => {
    expect(visibleLength('\x1b[1mabc\x1b[0m')).toBe(3);
  });
});
