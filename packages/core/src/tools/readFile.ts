/**
 * read_file — đọc một file trong workspace.
 *
 * Ba lớp chắn, theo thứ tự: pathGuard (có ra ngoài workspace không) ->
 * denylist (có phải file bí mật không) -> giới hạn kích thước.
 * Thứ tự quan trọng: đừng bao giờ đọc nội dung rồi mới quyết định được phép hay
 * không, vì lúc đó bí mật đã nằm trong bộ nhớ tiến trình.
 */
import { z } from 'zod';
import type { Tool, ToolContext, ToolResult } from './Tool.js';
import { PathGuardError } from '../security/pathGuard.js';

const schema = z.object({
  path: z.string().min(1).describe('Đường dẫn file, tương đối so với thư mục làm việc'),
  offset: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe('Dòng bắt đầu, đánh số từ 1. Dùng cho file lớn.'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(5000)
    .optional()
    .describe('Số dòng tối đa cần đọc. Mặc định 2000.'),
});

const DEFAULT_LIMIT = 2000;
/** Trên ngưỡng này thì bắt buộc phải phân trang, không đọc cả file. */
const MAX_BYTES = 512 * 1024;

/**
 * Trần TUYỆT ĐỐI, áp cả khi đã phân trang.
 *
 * Cần một trần thứ hai vì `FileSystem.readFile` không đọc được từng khoảng dòng
 * — nó nạp cả file thành một string rồi mới cắt. Nên nếu trần đầu chỉ áp khi
 * KHÔNG có `limit` (đúng như bản trước), model chỉ cần gửi `limit: 1` là trần
 * 512 KB bị vô hiệu và một file log vài trăm MB vẫn được nạp trọn vào bộ nhớ
 * extension host để trả về đúng một dòng.
 *
 * 8 MB là chỗ dừng có lý: rộng hơn mọi file mã nguồn thật, và một file lớn hơn
 * thế thì `grep` mới là công cụ đúng, không phải `read_file`. Đọc theo dòng
 * thật sự (streaming) là việc của một bản sau — nó cần thêm phương thức vào
 * `FileSystem`, tức là chạm cả ba cài đặt kể cả bản của VS Code.
 */
const MAX_PAGED_BYTES = 8 * 1024 * 1024;

export const readFileTool: Tool<typeof schema> = {
  name: 'read_file',
  description:
    'Đọc nội dung một file trong thư mục làm việc. Dùng khi cần xem mã nguồn ' +
    'trước khi trả lời hoặc sửa. Với file lớn, dùng offset/limit để đọc từng phần.',
  schema,
  readOnly: true,

  async execute(args, ctx: ToolContext): Promise<ToolResult> {
    let absolute: string;
    try {
      absolute = await ctx.pathGuard.resolveExisting(args.path);
    } catch (err) {
      if (err instanceof PathGuardError) {
        return { content: err.message, isError: true, untrusted: false };
      }
      throw err;
    }

    const relative = await ctx.pathGuard.toRelative(absolute);

    const deny = ctx.denylist.check(relative);
    if (deny.denied) {
      ctx.logger.warn('chặn đọc file theo denylist', { path: relative, source: deny.source });
      return { content: ctx.denylist.explain(relative), isError: true, untrusted: false };
    }

    const stat = await ctx.fs.stat(absolute);
    if (stat.type === 'directory') {
      return {
        content: `${relative} là thư mục. Dùng list_dir hoặc glob để xem nội dung.`,
        isError: true,
        untrusted: false,
      };
    }
    const paged = args.limit !== undefined || args.offset !== undefined;

    // Trần TUYỆT ĐỐI, không phụ thuộc offset/limit — xem `MAX_PAGED_BYTES`.
    if (stat.size > MAX_PAGED_BYTES) {
      return {
        content:
          `${relative} nặng ${Math.round(stat.size / (1024 * 1024))} MB — vượt trần ` +
          `${MAX_PAGED_BYTES / (1024 * 1024)} MB của read_file, kể cả khi phân trang. ` +
          `Dùng grep để tìm đúng phần cần, hoặc bash để xử lý file này.`,
        isError: true,
        untrusted: false,
      };
    }

    if (stat.size > MAX_BYTES && !paged) {
      return {
        content:
          `${relative} nặng ${Math.round(stat.size / 1024)} KB — quá lớn để đọc một lần. ` +
          `Gọi lại với offset và limit, hoặc dùng grep để tìm đúng phần cần.`,
        isError: true,
        untrusted: false,
      };
    }

    const raw = await ctx.fs.readFile(absolute);
    const lines = raw.split(/\r?\n/);

    const start = (args.offset ?? 1) - 1;
    const limit = args.limit ?? DEFAULT_LIMIT;
    const slice = lines.slice(start, start + limit);

    if (slice.length === 0) {
      return {
        content: `${relative} chỉ có ${lines.length} dòng, offset ${args.offset} vượt quá.`,
        isError: true,
        untrusted: false,
      };
    }

    // Đánh số dòng để model trích dẫn được vị trí chính xác, và để edit_file
    // ở M4 có mốc tham chiếu.
    const width = String(start + slice.length).length;
    const body = slice
      .map((line, i) => `${String(start + i + 1).padStart(width)}\t${line}`)
      .join('\n');

    const truncated = start + slice.length < lines.length;
    const header = truncated
      ? `${relative} (dòng ${start + 1}–${start + slice.length} trong tổng ${lines.length})`
      : `${relative} (${lines.length} dòng)`;

    return {
      content: `${header}\n${body}${truncated ? '\n… còn nữa, gọi lại với offset lớn hơn' : ''}`,
      untrusted: true,
      meta: { path: relative, totalLines: lines.length, truncated },
    };
  },
};
