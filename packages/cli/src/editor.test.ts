import { describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { LineEditor, type MenuKind, type SuggestItem, type SuggestSource } from './editor.js';

/**
 * Chạy editor trên một cặp stream giả.
 *
 * Dùng `PassThrough` thật chứ không giả lập sự kiện `keypress`: như vậy chuỗi
 * escape của phím mũi tên đi qua đúng bộ phân tích của `node:readline` mà bản
 * chạy thật dùng. Giả lập ở tầng trên sẽ test một bộ phím không có thật.
 */
function harness(source: SuggestSource, history: string[] = []) {
  const input = new PassThrough();
  const frames: string[] = [];
  const output = Object.assign(new EventEmitter(), {
    columns: 100,
    write(text: string): boolean {
      frames.push(text);
      return true;
    },
  });

  const editor = new LineEditor({
    prompt: '> ',
    promptWidth: 2,
    source,
    history,
    input: input as unknown as NodeJS.ReadStream,
    output: output as unknown as NodeJS.WriteStream,
  });

  return {
    editor,
    read: (): Promise<string | undefined> => editor.read(),
    async type(text: string): Promise<void> {
      input.write(text);
      await new Promise((r) => setTimeout(r, 10));
    },
    /** Toàn bộ những gì đã in, đã bỏ mã điều khiển. */
    screen(): string {
      return frames.join('').replace(/\x1b\[[0-9;]*[A-Za-z]/g, ''); // eslint-disable-line no-control-regex
    },
    /** Chỉ khung vẽ gần nhất — đủ để kiểm tra menu đang hiện gì. */
    last(): string {
      const joined = frames.join('');
      const at = joined.lastIndexOf('\x1b[0J');
      return joined.slice(at).replace(/\x1b\[[0-9;]*[A-Za-z]/g, ''); // eslint-disable-line no-control-regex
    },
  };
}

const items = (...names: string[]): SuggestItem[] => names.map((value) => ({ value }));

const staticSource = (map: Partial<Record<MenuKind, SuggestItem[]>>): SuggestSource => ({
  items: (kind) => map[kind],
});

const COMMANDS = staticSource({
  command: items('help', 'exit', 'speckit-plan', 'speckit-tasks'),
  file: [
    { value: 'src/', label: 'src', badge: 'dir', keepOpen: true },
    { value: 'src/app.ts', label: 'src/app.ts', badge: 'file' },
    { value: 'README.md', label: 'README.md', badge: 'file' },
  ],
});

describe('LineEditor — gõ và gửi', () => {
  it('gõ chữ thường rồi Enter thì gửi nguyên văn', async () => {
    const h = harness(COMMANDS);
    const line = h.read();
    await h.type('sửa hàm login');
    await h.type('\r');
    expect(await line).toBe('sửa hàm login');
  });

  it('backspace xoá lùi', async () => {
    const h = harness(COMMANDS);
    const line = h.read();
    await h.type('abcd');
    await h.type('\x7f\x7f');
    await h.type('\r');
    expect(await line).toBe('ab');
  });

  it('Ctrl-D khi trống là thoát', async () => {
    const h = harness(COMMANDS);
    const line = h.read();
    await h.type('\x04');
    expect(await line).toBeUndefined();
  });

  it('mũi tên lên lấy lại dòng cũ', async () => {
    const h = harness(COMMANDS, ['câu trước']);
    const line = h.read();
    await h.type('\x1b[A');
    await h.type('\r');
    expect(await line).toBe('câu trước');
  });
});

describe('LineEditor — menu /', () => {
  it('gõ / mở menu và hiện danh sách', async () => {
    const h = harness(COMMANDS);
    void h.read();
    await h.type('/');

    expect(h.last()).toContain('help');
    expect(h.last()).toContain('speckit-plan');
  });

  it('lọc dần theo từng ký tự', async () => {
    const h = harness(COMMANDS);
    void h.read();
    await h.type('/spe');

    expect(h.last()).toContain('speckit-plan');
    expect(h.last()).not.toContain('help');
  });

  /** `/` giữa câu là dấu gạch chéo trong đường dẫn, không phải lệnh. */
  it('/ giữa câu KHÔNG mở menu', async () => {
    const h = harness(COMMANDS);
    void h.read();
    await h.type('sửa src/app.ts');
    expect(h.last()).not.toContain('speckit-plan');
  });

  it('gõ khoảng trắng thì menu đóng', async () => {
    const h = harness(COMMANDS);
    void h.read();
    await h.type('/help ');
    expect(h.last()).not.toContain('speckit-plan');
  });

  it('Enter lần một chọn, lần hai mới gửi', async () => {
    const h = harness(COMMANDS);
    const line = h.read();
    await h.type('/spe');
    await h.type('\r');
    await h.type('\r');
    expect(await line).toBe('/speckit-plan ');
  });

  it('Tab cũng chọn', async () => {
    const h = harness(COMMANDS);
    const line = h.read();
    await h.type('/exi\t');
    await h.type('\r');
    expect(await line).toBe('/exit ');
  });

  it('mũi tên xuống đổi mục đang chọn', async () => {
    const h = harness(COMMANDS);
    const line = h.read();
    await h.type('/spe');
    await h.type('\x1b[B');
    await h.type('\r\r');
    expect(await line).toBe('/speckit-tasks ');
  });

  it('không khớp gì thì nói ra, không hiện rỗng', async () => {
    const h = harness(COMMANDS);
    void h.read();
    await h.type('/zzzz');
    expect(h.last()).toContain('không có lệnh nào khớp');
  });

  it('nguồn chưa nạp xong thì hiện đang quét', async () => {
    const h = harness(staticSource({}));
    void h.read();
    await h.type('/');
    expect(h.last()).toContain('đang quét');
  });
});

describe('LineEditor — menu @', () => {
  it('@ đầu dòng mở menu file', async () => {
    const h = harness(COMMANDS);
    void h.read();
    await h.type('@');
    expect(h.last()).toContain('README.md');
  });

  it('@ sau khoảng trắng cũng mở', async () => {
    const h = harness(COMMANDS);
    void h.read();
    await h.type('sửa @app');
    expect(h.last()).toContain('src/app.ts');
  });

  /** `ai@example.com` không phải lời yêu cầu đọc file. */
  it('@ giữa từ KHÔNG mở menu', async () => {
    const h = harness(COMMANDS);
    void h.read();
    await h.type('gửi ai@exa');
    expect(h.last()).not.toContain('README.md');
  });

  it('chọn file thì chèn đường dẫn kèm khoảng trắng', async () => {
    const h = harness(COMMANDS);
    const line = h.read();
    await h.type('sửa @app');
    await h.type('\r');
    await h.type('\r');
    expect(await line).toBe('sửa @src/app.ts ');
  });

  /** Chọn thư mục rồi chọn file trong đó là cách người ta thật sự dùng `@`. */
  it('chọn thư mục thì giữ menu mở để đi tiếp vào trong', async () => {
    const h = harness(COMMANDS);
    const line = h.read();
    await h.type('@src');
    await h.type('\r');

    expect(h.last()).toContain('src/app.ts');
    await h.type('\r');
    await h.type('\r');
    expect(await line).toBe('@src/app.ts ');
  });
});

describe('LineEditor — Ctrl-C ba tầng', () => {
  it('menu đang mở thì chỉ đóng menu', async () => {
    const h = harness(COMMANDS);
    const line = h.read();
    await h.type('/spe');
    await h.type('\x03');

    expect(h.last()).not.toContain('speckit-plan');
    await h.type('\r');
    expect(await line).toBe('/spe');
  });

  it('còn chữ thì xoá chữ, không thoát', async () => {
    const h = harness(COMMANDS);
    const line = h.read();
    await h.type('câu dở');
    await h.type('\x03');
    await h.type('câu khác');
    await h.type('\r');
    expect(await line).toBe('câu khác');
  });

  it('trống thì mới thoát', async () => {
    const h = harness(COMMANDS);
    const line = h.read();
    await h.type('\x03');
    expect(await line).toBeUndefined();
  });
});
