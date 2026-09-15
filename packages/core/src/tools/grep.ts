/**
 * grep — tìm theo regex trong nội dung file.
 *
 * Đây là tool quan trọng nhất của M2: nó cho phép agent định vị code mà không
 * phải đọc tuần tự cả repo, tức là không đốt hết context window ngay ở bước
 * tìm hiểu. Với model 32k context, đây là khác biệt giữa dùng được và không.
 *
 * Cài đặt bằng Node thuần qua FileSystem port. Chậm hơn ripgrep nhưng test
 * được và không kéo thêm binary. packages/vscode có thể thay bằng ripgrep có
 * sẵn của VS Code sau, cùng interface.
 */
import { z } from 'zod';
import picomatch from 'picomatch';
import type { Tool, ToolContext, ToolResult } from './Tool.js';
import { PathGuardError } from '../security/pathGuard.js';
import { compileSafeRegex } from '../security/safeRegex.js';
import { walkFiles } from './walk.js';

const schema = z.object({
  pattern: z.string().min(1).describe('Biểu thức chính quy cần tìm'),
  path: z.string().optional().describe('Thư mục con để giới hạn phạm vi. Mặc định toàn workspace.'),
  glob: z
    .string()
    .optional()
    .describe('Chỉ tìm trong file khớp mẫu này, ví dụ "**/*.ts"'),
  caseSensitive: z.boolean().optional().describe('Phân biệt hoa thường. Mặc định không.'),
  contextLines: z
    .number()
    .int()
    .min(0)
    .max(10)
    .optional()
    .describe('Số dòng ngữ cảnh quanh mỗi kết quả. Mặc định 0.'),
  limit: z.number().int().min(1).max(500).optional().describe('Số kết quả tối đa. Mặc định 100.'),
});

const DEFAULT_LIMIT = 100;
/** File nhị phân và file khổng lồ bị bỏ qua — grep chúng chỉ sinh rác. */
const MAX_FILE_BYTES = 2 * 1024 * 1024;

/**
 * Phần đầu mỗi dòng thật sự đem khớp regex.
 *
 * Đây là lớp chặn KHÔNG dựa vào việc đoán đúng hình dạng mẫu (xem
 * `security/safeRegex.ts`): chi phí backtracking là hàm của độ dài input, nên
 * chặn input là chặn trần trên của thiệt hại kể cả khi phép quét tĩnh bỏ sót một
 * khuôn. Dòng dài hơn ngần này gần như chỉ có trong file minify/generated —
 * thứ mà kết quả grep cũng không dùng được.
 */
const MAX_LINE_CHARS = 4_000;

/** Số dòng giữa hai lần nhường event loop. Xem `yieldToEventLoop`. */
const LINES_PER_YIELD = 2_000;

/** Trần thời gian cho một lời gọi. Chạm trần thì trả phần đã tìm được. */
const TIME_BUDGET_MS = 15_000;

/**
 * Nhường lại event loop một nhịp.
 *
 * Bắt buộc phải có để nút Stop hoạt động: `signal.aborted` chỉ đổi giá trị khi
 * tác vụ gọi `abort()` được chạy, mà JavaScript đơn luồng thì không tác vụ nào
 * chen được vào giữa một vòng `for` đồng bộ. Kiểm `signal.aborted` trong vòng
 * lặp mà không nhường ở đâu cả là kiểm một biến không bao giờ đổi.
 */
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

export const grepTool: Tool<typeof schema> = {
  name: 'grep',
  description:
    'Tìm một biểu thức chính quy trong nội dung file. Dùng CÁI NÀY thay vì đọc ' +
    'tuần tự nhiều file khi cần định vị hàm, biến, hay chuỗi trong codebase.',
  schema,
  readOnly: true,

  async execute(args, ctx: ToolContext): Promise<ToolResult> {
    // Mẫu đến từ model, tức là từ nguồn không tin cậy. `new RegExp` trần ở đây
    // đủ để một mẫu như `(a+)+b` treo cứng luồng duy nhất của extension host —
    // xem `security/safeRegex.ts`.
    const compiled = compileSafeRegex(args.pattern, {
      flags: args.caseSensitive ? 'g' : 'gi',
    });
    if (!compiled.ok) {
      return { content: compiled.reason, isError: true, untrusted: false };
    }
    const regex = compiled.regex;

    let root: string;
    try {
      root = await ctx.pathGuard.resolveExisting(args.path ?? '.');
    } catch (err) {
      if (err instanceof PathGuardError) {
        return { content: err.message, isError: true, untrusted: false };
      }
      throw err;
    }

    const limit = args.limit ?? DEFAULT_LIMIT;
    const contextLines = args.contextLines ?? 0;
    const matchesGlob = args.glob
      ? picomatch(args.glob, { dot: true, posixSlashes: true })
      : undefined;

    const { files } = await walkFiles(ctx, { root });

    const blocks: string[] = [];
    let total = 0;
    let filesWithMatch = 0;
    let longLinesClipped = 0;
    let outOfTime = false;

    const deadline = Date.now() + TIME_BUDGET_MS;
    /** Số dòng đã quét từ lần nhường event loop gần nhất. */
    let sinceYield = 0;

    files: for (const file of files) {
      if (ctx.signal?.aborted) break;
      if (total >= limit) break;
      if (matchesGlob && !matchesGlob(file.relative)) continue;

      const stat = await ctx.fs.stat(file.absolute).catch(() => undefined);
      if (!stat || stat.size > MAX_FILE_BYTES) continue;

      let content: string;
      try {
        content = await ctx.fs.readFile(file.absolute);
      } catch {
        continue;
      }
      if (isProbablyBinary(content)) continue;

      const lines = content.split(/\r?\n/);
      const hits: string[] = [];

      for (let i = 0; i < lines.length && total < limit; i++) {
        // Nhường event loop định kỳ. Không có bước này thì hai thứ dưới đây đều
        // vô nghĩa trên một file lớn: `signal.aborted` không bao giờ đổi giá trị,
        // và extension host đứng hình cho tới khi quét xong.
        if (++sinceYield >= LINES_PER_YIELD) {
          sinceYield = 0;
          await yieldToEventLoop();
          if (ctx.signal?.aborted) break files;
          if (Date.now() > deadline) {
            outOfTime = true;
            break files;
          }
        }

        const line = lines[i]!;
        // Chỉ khớp phần đầu dòng. Xem `MAX_LINE_CHARS`: đây là trần trên của
        // thiệt hại khi phép quét tĩnh bỏ sót một mẫu thảm hoạ.
        const probe = line.length > MAX_LINE_CHARS ? line.slice(0, MAX_LINE_CHARS) : line;
        if (probe.length < line.length) longLinesClipped++;

        regex.lastIndex = 0;
        if (!regex.test(probe)) continue;

        total++;
        if (contextLines === 0) {
          hits.push(`${i + 1}:${line.trimEnd()}`);
        } else {
          const from = Math.max(0, i - contextLines);
          const to = Math.min(lines.length - 1, i + contextLines);
          for (let j = from; j <= to; j++) {
            hits.push(`${j + 1}${j === i ? ':' : '-'}${lines[j]!.trimEnd()}`);
          }
          hits.push('--');
        }
      }

      if (hits.length > 0) {
        filesWithMatch++;
        blocks.push(`${file.relative}\n${hits.join('\n')}`);
      }
    }

    if (total === 0) {
      return {
        content:
          `Không tìm thấy "${args.pattern}"` +
          (args.glob ? ` trong file khớp ${args.glob}` : '') +
          (outOfTime ? ` (dừng sau ${TIME_BUDGET_MS / 1000}s, chưa quét hết)` : '') +
          '. Thử mẫu rộng hơn, hoặc dùng glob để xem những file nào đang có.',
        untrusted: false,
        meta: { pattern: args.pattern, count: 0, ...(outOfTime ? { outOfTime } : {}) },
      };
    }

    const capped = total >= limit;
    // Nói ra mọi lý do kết quả có thể thiếu. Im lặng ở đây nghĩa là model coi
    // một kết quả bị cắt là kết quả đầy đủ, rồi kết luận sai trên đó.
    const notes: string[] = [];
    if (capped) notes.push(`đã đạt trần ${limit} kết quả, thu hẹp mẫu để thấy phần còn lại`);
    if (outOfTime) notes.push(`dừng sau ${TIME_BUDGET_MS / 1000}s, chưa quét hết repo`);
    if (longLinesClipped > 0) {
      notes.push(
        `${longLinesClipped} dòng dài hơn ${MAX_LINE_CHARS} ký tự chỉ được khớp ở phần đầu`,
      );
    }

    return {
      content: blocks.join('\n\n') + (notes.length > 0 ? `\n\n… ${notes.join('; ')}` : ''),
      untrusted: true,
      meta: {
        pattern: args.pattern,
        count: total,
        files: filesWithMatch,
        truncated: capped || outOfTime,
        ...(longLinesClipped > 0 ? { longLinesClipped } : {}),
        ...(outOfTime ? { outOfTime } : {}),
      },
    };
  },
};

/** Có NUL byte trong 8 KB đầu thì gần như chắc chắn là file nhị phân. */
function isProbablyBinary(content: string): boolean {
  const head = content.slice(0, 8192);
  return head.includes(' ');
}
