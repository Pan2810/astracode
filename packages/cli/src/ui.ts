/**
 * In ra terminal.
 *
 * Màu tắt khi không phải TTY hoặc khi có `NO_COLOR` — output bị pipe vào file
 * hay vào một công cụ khác thì escape code là rác, không phải màu.
 */
const useColor = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;

function wrap(open: string, close: string) {
  return (s: string): string => (useColor ? `${open}${s}${close}` : s);
}

export const c = {
  dim: wrap('\x1b[2m', '\x1b[0m'),
  bold: wrap('\x1b[1m', '\x1b[0m'),
  red: wrap('\x1b[31m', '\x1b[0m'),
  green: wrap('\x1b[32m', '\x1b[0m'),
  yellow: wrap('\x1b[33m', '\x1b[0m'),
  blue: wrap('\x1b[34m', '\x1b[0m'),
  cyan: wrap('\x1b[36m', '\x1b[0m'),
};

export function out(text = ''): void {
  process.stdout.write(text + '\n');
}

/** Ghi thẳng, không xuống dòng — dùng cho chữ đang stream về. */
export function write(text: string): void {
  process.stdout.write(text);
}

export function err(text: string): void {
  process.stderr.write(text + '\n');
}

export function heading(text: string): void {
  out('');
  out(c.bold(c.cyan(text)));
}

/** Bảng thẳng cột. Không dùng thư viện — vài dòng là đủ. */
export function table(rows: Record<string, string>[]): void {
  if (rows.length === 0) return;
  const cols = Object.keys(rows[0]!);
  const width = new Map<string, number>();
  for (const col of cols) {
    width.set(col, Math.max(col.length, ...rows.map((r) => visibleLength(r[col] ?? ''))));
  }
  const pad = (s: string, n: number): string => s + ' '.repeat(Math.max(0, n - visibleLength(s)));
  out('  ' + cols.map((col) => c.bold(pad(col, width.get(col)!))).join('  '));
  out('  ' + cols.map((col) => c.dim('─'.repeat(width.get(col)!))).join('  '));
  for (const r of rows) {
    out('  ' + cols.map((col) => pad(r[col] ?? '', width.get(col)!)).join('  '));
  }
}

/** Độ dài KHÔNG tính escape màu — nếu không, cột có màu sẽ lệch. */
function visibleLength(s: string): number {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, '').length;
}
