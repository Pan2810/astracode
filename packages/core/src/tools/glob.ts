/**
 * glob — tìm file theo mẫu tên.
 *
 * Dùng picomatch cho ngữ nghĩa glob chuẩn (`**`, `{a,b}`, `?`, phủ định) thay
 * vì tự viết: glob nhìn đơn giản nhưng sai lệch nhỏ ở `**` sẽ khiến agent bỏ
 * sót file mà không ai nhận ra.
 */
import { z } from 'zod';
import picomatch from 'picomatch';
import type { Tool, ToolContext, ToolResult } from './Tool.js';
import { PathGuardError } from '../security/pathGuard.js';
import { walkFiles } from './walk.js';

const schema = z.object({
  pattern: z
    .string()
    .min(1)
    .describe('Mẫu glob, ví dụ "src/**/*.ts" hoặc "**/*.{js,json}"'),
  path: z
    .string()
    .optional()
    .describe('Thư mục con để giới hạn phạm vi tìm. Mặc định là toàn workspace.'),
  limit: z.number().int().min(1).max(1000).optional().describe('Số kết quả tối đa. Mặc định 200.'),
});

const DEFAULT_LIMIT = 200;

export const globTool: Tool<typeof schema> = {
  name: 'glob',
  description:
    'Tìm file theo mẫu tên trong thư mục làm việc. Dùng khi cần biết những file nào ' +
    'tồn tại trước khi đọc. Trả về đường dẫn, không trả nội dung.',
  schema,
  readOnly: true,

  async execute(args, ctx: ToolContext): Promise<ToolResult> {
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
    const isMatch = picomatch(args.pattern, { dot: true, posixSlashes: true });

    const { files, truncated: walkTruncated } = await walkFiles(ctx, { root });

    const scope = args.path ? await ctx.pathGuard.toRelative(root) : '';
    const matched = files
      .filter((f) => {
        // Mẫu được viết theo góc nhìn của `path` nếu có, nếu không thì theo root.
        const candidate =
          scope && scope !== '.' && f.relative.startsWith(scope + '/')
            ? f.relative.slice(scope.length + 1)
            : f.relative;
        return isMatch(candidate) || isMatch(f.relative);
      })
      .map((f) => f.relative)
      .sort();

    if (matched.length === 0) {
      return {
        content:
          `Không có file nào khớp "${args.pattern}"` +
          (args.path ? ` trong ${scope}` : '') +
          '. Kiểm tra lại mẫu, hoặc dùng list_dir để xem cấu trúc thư mục.',
        untrusted: false,
        meta: { pattern: args.pattern, count: 0 },
      };
    }

    const shown = matched.slice(0, limit);
    const cut = matched.length > shown.length || walkTruncated;

    return {
      content:
        shown.join('\n') +
        (cut ? `\n… ${matched.length - shown.length} kết quả nữa, thu hẹp mẫu lại` : ''),
      untrusted: true,
      meta: { pattern: args.pattern, count: matched.length, truncated: cut },
    };
  },
};
