/**
 * Hỏi người dùng trong terminal.
 *
 * Hộp duyệt quyền là lớp an toàn cuối cùng trước khi agent chạm vào đĩa, nên nó
 * phải hiện đủ để quyết định có căn cứ: tool nào, file nào, và bản xem trước.
 * Một câu "Cho phép? [y/N]" trống trơn thì người dùng sẽ bấm y theo phản xạ, và
 * lúc đó cổng quyền chỉ còn là thủ tục.
 */
import { createInterface, type Interface } from 'node:readline/promises';
import type { PermissionRequest, PermissionDecision } from '@astra/core';
import { c, out } from './ui.js';

/** Số dòng preview tối đa. Dài hơn thì cắt — không ai đọc 300 dòng diff ở prompt. */
const PREVIEW_LINES = 24;

export function createReadline(): Interface {
  return createInterface({ input: process.stdin, output: process.stdout });
}

export async function askPermission(
  rl: Interface,
  req: PermissionRequest,
): Promise<PermissionDecision> {
  out('');
  out(c.yellow(`  ┌ Cần duyệt: ${c.bold(req.summary)}`));
  out(c.yellow(`  │ tool: ${req.tool}${req.path ? `   file: ${req.path}` : ''}`));
  if (req.downgradeReason) {
    // Phiên bị hạ cấp nghĩa là agent vừa đọc nội dung không tin cậy. Người dùng
    // phải biết điều đó TRƯỚC khi duyệt, không phải sau.
    out(c.red(`  │ ⚠ quyền đã bị hạ cấp: ${req.downgradeReason}`));
  }
  if (req.preview) {
    const lines = req.preview.split('\n');
    const shown = lines.slice(0, PREVIEW_LINES);
    // Chỉ tô khi tool KHAI đây là diff. Trước đây tô theo ký tự đầu dòng, nên
    // một script shell có dòng `-x` bị vẽ thành dòng bị xoá — hộp duyệt mô tả
    // sai thứ sắp chạy, đúng vào lúc người dùng đang dựa vào nó để quyết định.
    const paint = req.previewKind === 'diff' ? colorDiffLine : (s: string): string => s;
    out(c.yellow('  │'));
    for (const line of shown) out(c.yellow('  │ ') + paint(line));
    if (lines.length > shown.length) {
      out(c.yellow('  │ ') + c.dim(`… còn ${lines.length - shown.length} dòng`));
    }
  }
  out(c.yellow('  └'));

  for (;;) {
    const answer = (
      await rl.question(`  [${c.green('y')}] cho phép  [${c.green('a')}] luôn cho phép  [${c.red('n')}] từ chối > `)
    )
      .trim()
      .toLowerCase();
    if (answer === 'y' || answer === '') return 'allow_once';
    if (answer === 'a') return 'allow_always';
    if (answer === 'n' || answer === 'q') return 'deny';
    out(c.dim('  Trả lời y, a hoặc n.'));
  }
}

/**
 * Tô một dòng của `formatUnifiedDiff`: dấu + số dòng (6 ký tự) rồi tới nội dung.
 *
 * Máng số dòng làm nhạt để mắt bám vào phần code — trên một diff dài, cột số
 * sáng bằng code là thứ khiến đọc lướt không nổi.
 */
export function colorDiffLine(line: string): string {
  const sign = line.charAt(0);
  if (line.length < 6 || (sign !== '+' && sign !== '-' && sign !== ' ')) {
    // `…` và `… (còn N dòng nữa)` — dòng phụ, không phải nội dung file.
    return c.dim(line);
  }

  const gutter = c.dim(line.slice(0, 6));
  const text = line.slice(6);
  if (sign === '+') return gutter + c.green(text);
  if (sign === '-') return gutter + c.red(text);
  return gutter + c.dim(text);
}

/**
 * Người dùng không ngồi ở terminal (bị pipe, chạy trong CI) thì KHÔNG hỏi và
 * KHÔNG tự duyệt — từ chối. Tự duyệt khi không ai nhìn là bỏ hẳn cổng quyền
 * đúng vào lúc nó cần nhất.
 */
export function nonInteractiveAsker(): (req: PermissionRequest) => Promise<PermissionDecision> {
  return (req) => {
    out(
      c.red(
        `  Từ chối ${req.tool} (${req.summary}): không có terminal tương tác để hỏi duyệt.`,
      ),
    );
    return Promise.resolve('deny');
  };
}
