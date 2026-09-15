import { describe, expect, it } from 'vitest';
import { XmlTextStream } from './xmlStream.js';

const TOOLS = ['grep', 'read_file', 'g'];

/** Bơm từng ký tự một — trường hợp xấu nhất, và cũng là điều SSE hay làm. */
function perChar(source: string, names = TOOLS): { visible: string; tail: string } {
  const stream = new XmlTextStream(names);
  let visible = '';
  for (const ch of source) visible += stream.push(ch);
  return { visible, tail: stream.flush() };
}

/** Bơm theo mẩu cố định — mô phỏng chunk của model. */
function chunked(source: string, size: number, names = TOOLS): string {
  const stream = new XmlTextStream(names);
  let out = '';
  for (let i = 0; i < source.length; i += size) out += stream.push(source.slice(i, i + size));
  return out + stream.flush();
}

describe('XmlTextStream', () => {
  it('phát text thường ngay, không giữ lại', () => {
    const stream = new XmlTextStream(TOOLS);
    expect(stream.push('Để tôi tìm ')).toBe('Để tôi tìm ');
    expect(stream.push('trong mã nguồn.')).toBe('trong mã nguồn.');
  });

  it('nuốt trọn khối thẻ tool', () => {
    const source = 'Tìm nào.\n<grep>\n<pattern>login</pattern>\n</grep>';
    const { visible, tail } = perChar(source);
    expect(visible + tail).toBe('Tìm nào.\n');
  });

  it('không để lộ thẻ dở dang khi thẻ bị cắt ngang hai mẩu', () => {
    const stream = new XmlTextStream(TOOLS);
    expect(stream.push('xong.<gr')).toBe('xong.');
    expect(stream.push('ep><pattern>a</pattern></gr')).toBe('');
    expect(stream.push('ep>')).toBe('');
    expect(stream.flush()).toBe('');
  });

  it('giữ nguyên dấu < không phải mở đầu thẻ tool', () => {
    const { visible, tail } = perChar('nếu a < b thì <div>x</div> chạy');
    expect(visible + tail).toBe('nếu a < b thì <div>x</div> chạy');
  });

  it('phát cả text trước và sau khối tool', () => {
    const source = 'trước <grep><pattern>a</pattern></grep> sau';
    for (const size of [1, 3, 7, 100]) {
      expect(chunked(source, size)).toBe('trước  sau');
    }
  });

  it('xử lý nhiều khối tool liên tiếp', () => {
    const source = 'a<grep><pattern>x</pattern></grep>b<read_file><path>p</path></read_file>c';
    expect(chunked(source, 2)).toBe('abc');
  });

  it('nuốt phần đuôi khi thẻ mở không bao giờ đóng', () => {
    const { visible, tail } = perChar('đây rồi <grep><pattern>a</pattern>');
    expect(visible + tail).toBe('đây rồi ');
  });

  it('không phình buffer khi nội dung trong thẻ rất dài', () => {
    const stream = new XmlTextStream(TOOLS);
    stream.push('<read_file><path>');
    for (let i = 0; i < 1000; i++) stream.push('x'.repeat(100));
    expect(stream.push('</path></read_file>hết')).toBe('hết');
  });

  it('không có tool nào thì mọi thứ là text thường', () => {
    const { visible, tail } = perChar('<grep>vẫn hiện</grep>', []);
    expect(visible + tail).toBe('<grep>vẫn hiện</grep>');
  });

  it('ghép lại đúng bằng nguồn khi không có thẻ nào', () => {
    const source = 'Câu một.\n\n```ts\nconst a = 1 < 2;\n```\n\nCâu hai.';
    expect(chunked(source, 4)).toBe(source);
  });

  // Model viết thẻ lệch chuẩn là chuyện thường xuyên. Khớp cứng `<name>` thì
  // những biến thể dưới đây rò nguyên văn ra màn hình người dùng.
  it.each([
    ['thừa khoảng trắng', '<read_file >\n<path>p</path>\n</read_file>'],
    ['có thuộc tính', '<read_file id="1">\n<path>p</path>\n</read_file>'],
    ['xuống dòng trong thẻ', '<read_file\n>\n<path>p</path>\n</read_file>'],
    ['khoảng trắng ở thẻ đóng', '<read_file>\n<path>p</path>\n</read_file >'],
  ])('vẫn nuốt trọn thẻ khi %s', (_label, source) => {
    for (const size of [1, 3, 7, 100]) {
      expect(chunked(`trước ${source} sau`, size)).toBe('trước  sau');
    }
  });

  it('không giữ lại vô hạn khi dấu < không bao giờ thành thẻ', () => {
    const stream = new XmlTextStream(TOOLS);
    // `<read_file` mở ra nhưng sau đó là văn xuôi, không bao giờ có dấu `>`.
    stream.push('<read_file ');
    const visible = stream.push('x'.repeat(400));
    expect(visible).toContain('<read_file');
    expect(visible.length).toBeGreaterThan(300);
  });

  // Cùng luật với `recoverBrokenCalls`: parser cứu được thẻ hụt dấu `<` thì
  // lớp này cũng phải giấu được nó, nếu không tool chạy đúng nhưng người dùng
  // vẫn thấy `read_file>` rơi giữa câu trả lời.
  it('giấu cả thẻ hụt dấu <', () => {
    const source = 'Tôi cần đọc file.read_file>\n<path>a.ts</path>\n</read_file>';
    for (const size of [1, 3, 7, 100]) {
      expect(chunked(source, size)).toBe('Tôi cần đọc file.');
    }
  });

  it('không nuốt tên tool nằm giữa một từ dài hơn', () => {
    const { visible, tail } = perChar('xem xread_file> và agrep> nhé');
    expect(visible + tail).toBe('xem xread_file> và agrep> nhé');
  });

  it('không nuốt tên tool khi nó chỉ là chữ trong câu', () => {
    const { visible, tail } = perChar('công cụ read_file dùng để đọc file');
    expect(visible + tail).toBe('công cụ read_file dùng để đọc file');
  });

  it('thả dấu < ra ngay khi thẻ đã đóng khung mà không phải tool', () => {
    const { visible, tail } = perChar('so sánh <readFile> với <read_file2>');
    expect(visible + tail).toBe('so sánh <readFile> với <read_file2>');
  });
});
