/**
 * Ô nhập của phiên chat: raw mode, có panel gợi ý cho `/` và `@`.
 *
 * Vì sao không dùng `readline.question`: nó trả về CẢ DÒNG sau khi người dùng
 * nhấn Enter. Một panel lọc dần theo từng ký tự cần thấy phím ngay lúc gõ, nên
 * không có cách nào dựng nó trên `question`. `completer` của readline cũng
 * không thay thế được — nó chỉ chạy khi nhấn Tab và chỉ in ra một danh sách
 * phẳng rồi vẽ lại dòng.
 *
 * Hai quyết định để phần vẽ không thành nguồn bug:
 *
 *   1. **Ô nhập luôn nằm trên MỘT dòng**, dài quá thì cuộn ngang. Cho dòng tự
 *      xuống hàng nghĩa là phải đoán terminal wrap ở cột nào — và mỗi terminal
 *      xử lý ký tự ở đúng cột cuối một kiểu. Cuộn ngang thì số dòng ta vẽ luôn
 *      là con số ta tự tính ra.
 *   2. **Chỉ vẽ lại vùng của mình**: nhớ đã in bao nhiêu dòng, lần sau lùi lên
 *      đúng bấy nhiêu rồi xoá xuống hết. Mọi thứ in trước đó (chữ của model,
 *      dòng tool) không bị đụng tới.
 */
import { emitKeypressEvents } from 'node:readline';
import { fuzzyRank } from '@astra/core';
import { c } from './ui.js';

export type MenuKind = 'command' | 'file';

export interface SuggestItem {
  /** Chuỗi được chèn vào ô nhập khi chọn. */
  value: string;
  /** Chuỗi đem đi khớp mờ và hiển thị. Mặc định bằng `value`. */
  label?: string;
  /** Chữ mờ ngay sau nhãn — gợi ý đối số. */
  hint?: string;
  description?: string;
  /** Nhãn phân loại bên trái: `skill`, `cmd`, `dir`… */
  badge?: string;
  /** Nguồn khả nghi (quét injection) — hiện dấu cảnh báo. */
  suspicious?: boolean;
  /** Chọn xong thì mở tiếp menu thay vì đóng (thư mục trong menu `@`). */
  keepOpen?: boolean;
}

export interface SuggestSource {
  /**
   * Danh sách cho menu. `undefined` nghĩa là đang nạp — panel hiện "đang
   * quét…" thay vì hiện rỗng, vì rỗng trông y hệt "không có gì" và người dùng
   * sẽ bỏ đi trước khi kết quả kịp về.
   */
  items(kind: MenuKind): SuggestItem[] | undefined;
  /** Menu vừa mở. Nơi để nạp lười rồi gọi `refresh` khi xong. */
  open?(kind: MenuKind, refresh: () => void): void;
}

export interface LineEditorOptions {
  /** Dấu nhắc đã tô màu. */
  prompt: string;
  /** Độ dài THẤY ĐƯỢC của dấu nhắc — không tính escape màu. */
  promptWidth: number;
  source: SuggestSource;
  /** Lịch sử dùng chung giữa các lượt; editor tự thêm dòng mới vào. */
  history: string[];
  maxVisible?: number;
  input?: NodeJS.ReadStream;
  output?: NodeJS.WriteStream;
}

interface ActiveMenu {
  kind: MenuKind;
  /** Vị trí ký tự `/` hoặc `@` trong buffer. */
  start: number;
}

const MAX_VISIBLE = 8;

export class LineEditor {
  private buffer = '';
  private cursor = 0;
  private menu: ActiveMenu | undefined;
  private selected = 0;
  private scroll = 0;
  /** Số dòng đã vẽ lần trước, để biết lùi lên bao nhiêu. */
  private rows = 0;
  private historyIndex: number;
  private draft = '';
  private done: ((value: string | undefined) => void) | undefined;
  private readonly input: NodeJS.ReadStream;
  private readonly output: NodeJS.WriteStream;
  private readonly onKey = (str: string | undefined, key: KeyEvent | undefined): void =>
    this.handleKey(str, key);
  private readonly onResize = (): void => this.render();

  constructor(private readonly opts: LineEditorOptions) {
    this.input = opts.input ?? process.stdin;
    this.output = opts.output ?? process.stdout;
    this.historyIndex = opts.history.length;
  }

  /** Một dòng. `undefined` = người dùng muốn thoát (Ctrl-D, hoặc Ctrl-C khi trống). */
  read(): Promise<string | undefined> {
    this.buffer = '';
    this.cursor = 0;
    this.menu = undefined;
    this.rows = 0;
    this.historyIndex = this.opts.history.length;
    this.draft = '';

    emitKeypressEvents(this.input);
    if (this.input.isTTY) this.input.setRawMode(true);
    this.input.resume();
    this.input.on('keypress', this.onKey);
    this.output.on('resize', this.onResize);

    this.render();

    return new Promise<string | undefined>((resolve) => {
      this.done = resolve;
    });
  }

  /** Vẽ lại — dùng khi danh sách gợi ý vừa nạp xong ở nền. */
  refresh(): void {
    if (this.done) this.render();
  }

  private finish(value: string | undefined): void {
    this.input.off('keypress', this.onKey);
    this.output.off('resize', this.onResize);
    if (this.input.isTTY) this.input.setRawMode(false);
    this.input.pause();

    // Xoá vùng đang vẽ rồi in lại dòng đã chốt, KHÔNG kèm panel: dòng này ở
    // lại trong scrollback nên nó phải là thứ người dùng đã gõ, không phải một
    // ảnh chụp menu.
    this.erase();
    if (value !== undefined) {
      this.output.write(this.opts.prompt + value + '\n');
    }

    const resolve = this.done;
    this.done = undefined;
    resolve?.(value);
  }

  // ── Phím ────────────────────────────────────────────────────────────────

  private handleKey(str: string | undefined, key: KeyEvent | undefined): void {
    if (!this.done) return;
    const k = key ?? {};

    if (k.ctrl) {
      switch (k.name) {
        case 'c':
          // Menu mở thì đóng menu; còn chữ thì xoá chữ; trống thì mới là thoát.
          // Ba tầng để Ctrl-C không bao giờ làm mất nhiều hơn thứ người dùng
          // vừa nhắm tới.
          if (this.menu) return this.closeMenu();
          if (this.buffer) {
            this.buffer = '';
            this.cursor = 0;
            return this.render();
          }
          return this.finish(undefined);
        case 'd':
          if (!this.buffer) return this.finish(undefined);
          return this.deleteForward();
        case 'a':
          this.cursor = 0;
          return this.render();
        case 'e':
          this.cursor = this.buffer.length;
          return this.render();
        case 'u':
          this.buffer = this.buffer.slice(this.cursor);
          this.cursor = 0;
          return this.render();
        case 'k':
          this.buffer = this.buffer.slice(0, this.cursor);
          return this.render();
        case 'w':
          return this.deleteWord();
        case 'l':
          this.output.write('\x1b[2J\x1b[H');
          this.rows = 0;
          return this.render();
        default:
          return;
      }
    }

    switch (k.name) {
      case 'return':
      case 'enter': {
        // Menu đang mở thì Enter là "chọn", không phải "gửi". Gửi cần một Enter
        // nữa — cùng nhịp với Claude Code, và nó chặn được cú gửi nhầm khi
        // người dùng vừa gõ xong `/spec` và định chọn mục đầu.
        if (this.menu && this.visible().length > 0) return this.accept();
        const line = this.buffer;
        if (line.trim()) this.opts.history.push(line);
        return this.finish(line);
      }
      case 'tab':
        if (this.menu && this.visible().length > 0) return this.accept();
        return;
      case 'escape':
        if (this.menu) return this.closeMenu();
        return;
      case 'up':
        if (this.menu) return this.move(-1);
        return this.historyBack();
      case 'down':
        if (this.menu) return this.move(1);
        return this.historyForward();
      case 'pageup':
        if (this.menu) return this.move(-MAX_VISIBLE);
        return;
      case 'pagedown':
        if (this.menu) return this.move(MAX_VISIBLE);
        return;
      case 'left':
        this.cursor = Math.max(0, this.cursor - 1);
        return this.sync();
      case 'right':
        this.cursor = Math.min(this.buffer.length, this.cursor + 1);
        return this.sync();
      case 'home':
        this.cursor = 0;
        return this.render();
      case 'end':
        this.cursor = this.buffer.length;
        return this.render();
      case 'backspace':
        if (this.cursor === 0) return;
        this.buffer = this.buffer.slice(0, this.cursor - 1) + this.buffer.slice(this.cursor);
        this.cursor--;
        return this.sync();
      case 'delete':
        return this.deleteForward();
      default:
        break;
    }

    // Ký tự thường. Lọc điều khiển: một cú dán có thể mang theo `\r`, `\n` và
    // cả escape sequence, và chúng làm hỏng phép đếm dòng của phần vẽ.
    if (!str) return;
    const text = [...str].filter((ch) => ch >= ' ' && ch !== '\x7f').join('');
    if (!text) return;

    this.buffer = this.buffer.slice(0, this.cursor) + text + this.buffer.slice(this.cursor);
    this.cursor += text.length;
    this.sync();
  }

  private deleteForward(): void {
    if (this.cursor >= this.buffer.length) return;
    this.buffer = this.buffer.slice(0, this.cursor) + this.buffer.slice(this.cursor + 1);
    this.sync();
  }

  private deleteWord(): void {
    if (this.cursor === 0) return;
    const before = this.buffer.slice(0, this.cursor);
    const cut = before.replace(/\S*\s*$/, '');
    this.buffer = cut + this.buffer.slice(this.cursor);
    this.cursor = cut.length;
    this.sync();
  }

  private historyBack(): void {
    if (this.historyIndex === this.opts.history.length) this.draft = this.buffer;
    if (this.historyIndex === 0) return;
    this.historyIndex--;
    this.buffer = this.opts.history[this.historyIndex] ?? '';
    this.cursor = this.buffer.length;
    this.render();
  }

  private historyForward(): void {
    if (this.historyIndex >= this.opts.history.length) return;
    this.historyIndex++;
    this.buffer =
      this.historyIndex === this.opts.history.length
        ? this.draft
        : (this.opts.history[this.historyIndex] ?? '');
    this.cursor = this.buffer.length;
    this.render();
  }

  // ── Menu ────────────────────────────────────────────────────────────────

  /**
   * Menu nào đang hợp lệ với buffer + cursor hiện tại.
   *
   * `/` chỉ tính khi nó là ký tự ĐẦU dòng: `/` giữa câu là dấu gạch chéo trong
   * một đường dẫn, không phải lệnh. `@` tính khi đứng đầu một từ.
   */
  private detectMenu(): ActiveMenu | undefined {
    const before = this.buffer.slice(0, this.cursor);

    if (before.startsWith('/') && !/\s/.test(before)) return { kind: 'command', start: 0 };

    const at = before.lastIndexOf('@');
    if (at !== -1) {
      const prev = at === 0 ? '' : before[at - 1]!;
      const query = before.slice(at + 1);
      if ((at === 0 || /\s/.test(prev)) && !/\s/.test(query)) return { kind: 'file', start: at };
    }
    return undefined;
  }

  /** Gọi sau mỗi thay đổi buffer: mở/đóng menu cho khớp rồi vẽ. */
  private sync(): void {
    const next = this.detectMenu();
    const changed = next?.kind !== this.menu?.kind || next?.start !== this.menu?.start;

    if (next && changed) {
      this.selected = 0;
      this.scroll = 0;
      this.opts.source.open?.(next.kind, () => this.refresh());
    }
    if (next && !changed) {
      // Query đổi thì thứ hạng đổi — con trỏ chọn phải về đầu, nếu không nó trỏ
      // vào một mục khác hẳn với thứ vừa được xếp lên trên.
      this.selected = 0;
      this.scroll = 0;
    }
    this.menu = next;
    this.render();
  }

  private closeMenu(): void {
    this.menu = undefined;
    this.render();
  }

  private query(): string {
    if (!this.menu) return '';
    return this.buffer.slice(this.menu.start + 1, this.cursor);
  }

  private visible(): SuggestItem[] {
    if (!this.menu) return [];
    const items = this.opts.source.items(this.menu.kind);
    if (!items) return [];
    return fuzzyRank(items, this.query(), (i) => i.label ?? i.value, 60).map((r) => r.item);
  }

  private move(delta: number): void {
    const list = this.visible();
    if (list.length === 0) return;
    this.selected = Math.min(list.length - 1, Math.max(0, this.selected + delta));

    const max = this.opts.maxVisible ?? MAX_VISIBLE;
    if (this.selected < this.scroll) this.scroll = this.selected;
    if (this.selected >= this.scroll + max) this.scroll = this.selected - max + 1;
    this.render();
  }

  private accept(): void {
    const menu = this.menu;
    if (!menu) return;
    const item = this.visible()[this.selected];
    if (!item) return;

    // Giữ nguyên phần trước dấu hiệu: người dùng gõ "sửa @app" thì chữ "sửa "
    // phải còn đó sau khi chọn.
    const head = this.buffer.slice(0, menu.start);
    const sigil = this.buffer[menu.start] ?? '';
    const inserted = sigil + item.value + (item.keepOpen ? '' : ' ');
    this.buffer = head + inserted + this.buffer.slice(this.cursor);
    this.cursor = head.length + inserted.length;

    // Thư mục: giữ menu mở để đi tiếp vào trong. Đó là cách người ta thật sự
    // dùng `@` — chọn thư mục rồi chọn file trong đó, không phải gõ lại từ đầu.
    if (item.keepOpen) {
      this.selected = 0;
      this.scroll = 0;
      this.menu = { kind: menu.kind, start: menu.start };
      this.render();
      return;
    }
    this.sync();
  }

  // ── Vẽ ──────────────────────────────────────────────────────────────────

  private width(): number {
    return Math.max(20, this.output.columns ?? 80);
  }

  private erase(): void {
    if (this.rows > 1) this.output.write(`\x1b[${this.rows - 1}A`);
    this.output.write('\r\x1b[0J');
    this.rows = 0;
  }

  private render(): void {
    const width = this.width();
    const room = Math.max(8, width - this.opts.promptWidth - 1);

    // Cuộn ngang: giữ con trỏ luôn trong khung nhìn.
    let from = 0;
    if (this.cursor > room) from = this.cursor - room;
    const shown = this.buffer.slice(from, from + room);
    const cursorCol = this.opts.promptWidth + (this.cursor - from);

    const lines = [this.opts.prompt + shown, ...this.renderMenu(width)];

    this.erase();
    this.output.write(lines.join('\n'));

    // Con trỏ đang ở cuối dòng cuối. Lùi lên dòng nhập rồi đặt đúng cột.
    const up = lines.length - 1;
    if (up > 0) this.output.write(`\x1b[${up}A`);
    this.output.write('\r');
    if (cursorCol > 0) this.output.write(`\x1b[${cursorCol}C`);

    this.rows = lines.length;
  }

  private renderMenu(width: number): string[] {
    if (!this.menu) return [];

    const items = this.opts.source.items(this.menu.kind);
    if (!items) return [c.dim('    đang quét…')];

    const list = this.visible();
    if (list.length === 0) {
      return [c.dim(this.menu.kind === 'command' ? '    không có lệnh nào khớp' : '    không có file nào khớp')];
    }

    const max = this.opts.maxVisible ?? MAX_VISIBLE;
    const page = list.slice(this.scroll, this.scroll + max);
    const badgeWidth = Math.max(0, ...page.map((i) => (i.badge ?? '').length));
    const labelWidth = Math.min(
      34,
      Math.max(...page.map((i) => (i.label ?? i.value).length + (i.hint ? i.hint.length + 1 : 0))),
    );

    const lines = page.map((item, i) => {
      const active = this.scroll + i === this.selected;
      const label = item.label ?? item.value;
      const hint = item.hint ? ' ' + c.dim(item.hint) : '';
      const badge = badgeWidth > 0 ? c.dim((item.badge ?? '').padEnd(badgeWidth)) + ' ' : '';
      const pad = ' '.repeat(Math.max(0, labelWidth - label.length - (item.hint?.length ?? 0) - (item.hint ? 1 : 0)));
      const warn = item.suspicious ? c.red('⚠ ') : '';
      const desc = item.description ? c.dim('  ' + item.description) : '';

      const body = `${badge}${warn}${active ? c.cyan(label) : label}${hint}${pad}${desc}`;
      const marker = active ? c.cyan('  ❯ ') : '    ';
      return truncate(marker + body, width - 1);
    });

    const hidden = list.length - this.scroll - page.length;
    if (hidden > 0) lines.push(c.dim(`    … còn ${hidden}`));
    return lines;
  }
}

/** Cắt theo độ dài THẤY ĐƯỢC, giữ nguyên escape màu đã chèn. */
function truncate(text: string, max: number): string {
  let visible = 0;
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === '\x1b') {
      const end = text.indexOf('m', i);
      if (end !== -1) {
        out += text.slice(i, end + 1);
        i = end;
        continue;
      }
    }
    if (visible >= max) return out + '\x1b[0m…';
    out += ch;
    visible++;
  }
  return out;
}

interface KeyEvent {
  name?: string;
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
}
