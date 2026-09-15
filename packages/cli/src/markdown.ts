/**
 * Tô markdown cho chữ đang stream về từ model.
 *
 * Ràng buộc quyết định toàn bộ thiết kế: **không tô được cho tới khi hết dòng.**
 * `**đậm` chưa biết có đóng hay không, `| a | b |` chưa biết cột rộng bao nhiêu
 * cho tới khi cả bảng về. Nên bộ này gom theo DÒNG: chữ hiện ra từng dòng một
 * chứ không từng ký tự như trước.
 *
 * Đổi cảm giác stream lấy chữ đọc được — đánh đổi có chủ ý. Model xuống dòng
 * khá thường xuyên nên thực tế vẫn thấy chữ chảy; đoạn văn dài là trường hợp
 * xấu nhất và nó đứng im một nhịp.
 *
 * Bảng là chỗ phải gom cả khối: giữ các dòng `|…|` liên tiếp lại, tới khi gặp
 * dòng không phải bảng (hoặc hết lượt) mới đo cột rồi in. Đây đúng là thứ hỏng
 * ở bản trước — bảng markdown rơi ra terminal ở dạng thô, cột chạy lung tung.
 *
 * KHÔNG tô khi output bị pipe, cùng nguyên tắc với màu ở `ui.ts`: `astracode -p
 * "…" > ghi-chu.md` phải ra markdown sạch để còn dùng tiếp, không phải một mớ
 * escape code và khung kẻ.
 */
import { c } from './ui.js';

/**
 * Chỗ giữ chỗ cho code span khi đang tô các luật khác.
 *
 * Ký tự vùng Private Use: không xuất hiện trong văn bản thật, và không phải ký
 * tự điều khiển nên đặt được thẳng trong regex. Dùng số trần (` 0 `) thì một
 * câu như "in 3 dòng" sẽ bị hiểu nhầm là chỗ giữ chỗ và bị nuốt mất.
 */
const HOLD = '\uE000';

/** Độ dài KHÔNG tính escape màu — cột có màu sẽ lệch nếu đếm cả chúng. */
export function visibleLength(s: string): number {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, '').length;
}

/**
 * Tô phần trong một dòng: `code`, **đậm**, *nghiêng*, [chữ](link).
 *
 * Xử lý code span TRƯỚC và cất đi: `**` nằm trong code là ký tự thật của code,
 * không phải cú pháp. Không cất thì một đoạn code có dấu sao sẽ bị hiểu nhầm và
 * biến dạng — mà code sai một ký tự là code không chạy.
 */
export function inline(text: string): string {
  const stash: string[] = [];
  let s = text.replace(/`([^`]+)`/g, (_m, code: string) => {
    stash.push(c.cyan(code));
    return HOLD + (stash.length - 1) + HOLD;
  });

  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, label: string, url: string) =>
    `${c.cyan(label)} ${c.dim(url)}`,
  );
  // Đậm trước nghiêng: `**x**` cũng khớp luật nghiêng, làm ngược thứ tự sẽ ăn
  // mất một dấu sao ở mỗi đầu và để lại `*x*` lửng lơ.
  s = s.replace(/\*\*([^*]+)\*\*/g, (_m, t: string) => c.bold(t));
  s = s.replace(/(?<![\w*])\*([^*\n]+)\*(?![\w*])/g, (_m, t: string) => c.dim(t));
  s = s.replace(/~~([^~]+)~~/g, (_m, t: string) => c.dim(t));

  return s.replace(new RegExp(`${HOLD}(\\d+)${HOLD}`, 'g'), (_m, i: string) => stash[Number(i)]!);
}

function isTableRow(line: string): boolean {
  return /^\s*\|.*\|\s*$/.test(line);
}

/** `|---|:--:|` — dòng kẻ ngăn tiêu đề, không phải dữ liệu. */
function isTableDivider(line: string): boolean {
  return /^\s*\|[\s:|-]+\|\s*$/.test(line) && line.includes('-');
}

function splitRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\||\|$/g, '')
    .split('|')
    .map((cell) => cell.trim());
}

export interface MarkdownStreamOptions {
  /** Bề ngang terminal, để kẻ ngang và cắt bảng cho vừa. */
  width?: number;
  /** Lề trái, khớp với phần còn lại của CLI. */
  indent?: string;
}

/**
 * Nhận từng mẩu chữ stream về, nhả ra từng dòng đã tô.
 *
 * Dùng: `push()` cho mỗi delta, `end()` khi hết lượt. `end()` bắt buộc — dòng
 * cuối và bảng cuối còn nằm trong bộ đệm, không gọi thì chúng biến mất.
 */
export class MarkdownStream {
  private partial = '';
  private table: string[] = [];
  private fence = false;
  private lastBlank = true;
  private readonly width: number;
  private readonly indent: string;

  constructor(
    private readonly sink: (line: string) => void,
    opts: MarkdownStreamOptions = {},
  ) {
    this.width = opts.width ?? 80;
    this.indent = opts.indent ?? '  ';
  }

  /**
   * Gộp các dòng trống liên tiếp thành một.
   *
   * Cần vì tiêu đề và bảng tự chèn một dòng thở phía trước, mà markdown thật
   * thường đã có sẵn dòng trống ở đó — cộng lại thành khoảng hở đôi, và cả
   * câu trả lời trôi mất khỏi màn hình. `lastBlank` khởi tạo là `true` nên
   * lượt trả lời cũng không mở đầu bằng một dòng trống thừa.
   */
  private emit(line: string): void {
    const blank = line.trim() === '';
    if (blank && this.lastBlank) return;
    this.lastBlank = blank;
    this.sink(line);
  }

  push(chunk: string): void {
    this.partial += chunk;
    const lines = this.partial.split('\n');
    // Mẩu cuối chưa chắc đã hết dòng — giữ lại chờ mẩu sau.
    this.partial = lines.pop() ?? '';
    for (const line of lines) this.line(line);
  }

  /** Hết lượt: xả nốt dòng dở và bảng đang gom. */
  end(): void {
    if (this.partial) {
      this.line(this.partial);
      this.partial = '';
    }
    this.flushTable();
    if (this.fence) {
      // Model quên đóng ``` — vẫn phải trả terminal về trạng thái sạch.
      this.fence = false;
    }
  }

  private line(raw: string): void {
    const line = raw.replace(/\s+$/, '');

    if (this.fence) {
      if (/^\s*```/.test(line)) {
        this.fence = false;
        return;
      }
      this.emit(this.indent + c.dim('│ ') + c.cyan(line));
      return;
    }

    if (/^\s*```/.test(line)) {
      this.flushTable();
      this.fence = true;
      return;
    }

    if (isTableRow(line)) {
      this.table.push(line);
      return;
    }
    this.flushTable();

    if (line.trim() === '') {
      this.emit('');
      return;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      this.emit('');
      this.emit(this.indent + c.bold(c.cyan(inline(heading[2]!))));
      return;
    }

    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
      this.emit(this.indent + c.dim('─'.repeat(Math.max(4, this.width - 4))));
      return;
    }

    const quote = /^\s*>\s?(.*)$/.exec(line);
    if (quote) {
      this.emit(this.indent + c.dim('│ ') + c.dim(inline(quote[1]!)));
      return;
    }

    const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(line);
    if (bullet) {
      this.emit(`${this.indent}${bullet[1]}${c.cyan('•')} ${inline(bullet[2]!)}`);
      return;
    }

    const numbered = /^(\s*)(\d+)\.\s+(.*)$/.exec(line);
    if (numbered) {
      this.emit(`${this.indent}${numbered[1]}${c.cyan(`${numbered[2]}.`)} ${inline(numbered[3]!)}`);
      return;
    }

    this.emit(this.indent + inline(line));
  }

  /**
   * In bảng đã gom, cột thẳng hàng.
   *
   * Đo theo độ rộng THẤY ĐƯỢC, không phải `.length`: ô đã tô màu mang thêm
   * escape code, đếm cả chúng thì mọi cột sau đó lệch đi.
   */
  private flushTable(): void {
    if (this.table.length === 0) return;
    const rows = this.table.filter((l) => !isTableDivider(l)).map(splitRow);
    this.table = [];
    if (rows.length === 0) return;

    const cols = Math.max(...rows.map((r) => r.length));
    const cells = rows.map((r) => {
      const padded = [...r];
      while (padded.length < cols) padded.push('');
      return padded.map(inline);
    });

    const width: number[] = [];
    for (let i = 0; i < cols; i++) {
      width[i] = Math.max(...cells.map((r) => visibleLength(r[i]!)));
    }

    const pad = (s: string, n: number): string =>
      s + ' '.repeat(Math.max(0, n - visibleLength(s)));
    const render = (r: string[]): string =>
      this.indent + r.map((cell, i) => pad(cell, width[i]!)).join('  ').replace(/\s+$/, '');

    const [head, ...body] = cells;
    this.emit('');
    // Dòng đầu của bảng markdown là tiêu đề — in đậm sau khi đã đo cột, để việc
    // thêm escape code không kéo lệch hàng bên dưới.
    this.emit(
      this.indent +
        head!
          .map((cell, i) => c.bold(pad(cell, width[i]!)))
          .join('  ')
          .replace(/\s+$/, ''),
    );
    this.emit(this.indent + width.map((w) => c.dim('─'.repeat(w))).join('  '));
    for (const r of body) this.emit(render(r));
    this.emit('');
  }
}
