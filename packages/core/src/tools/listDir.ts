/**
 * list_dir — xem nội dung một thư mục.
 *
 * Giữ riêng khỏi glob vì hai việc khác nhau: glob trả lời "file nào khớp mẫu",
 * list_dir trả lời "ở đây có gì" — câu hỏi đầu tiên khi agent chưa biết gì về
 * cấu trúc repo.
 */
import { z } from 'zod';
import * as nodePath from 'node:path';
import type { Tool, ToolContext, ToolResult } from './Tool.js';
import { PathGuardError } from '../security/pathGuard.js';
import { SKIP_DIRS } from './walk.js';

const schema = z.object({
  path: z
    .string()
    .optional()
    .describe('Thư mục cần xem, tương đối so với thư mục làm việc. Mặc định là gốc.'),
});

export const listDirTool: Tool<typeof schema> = {
  name: 'list_dir',
  description:
    'Liệt kê file và thư mục con tại một đường dẫn. Dùng khi chưa biết cấu trúc ' +
    'repo và cần định hướng trước khi tìm chi tiết.',
  schema,
  readOnly: true,

  async execute(args, ctx: ToolContext): Promise<ToolResult> {
    let absolute: string;
    try {
      absolute = await ctx.pathGuard.resolveExisting(args.path ?? '.');
    } catch (err) {
      if (err instanceof PathGuardError) {
        return { content: err.message, isError: true, untrusted: false };
      }
      throw err;
    }

    const relative = await ctx.pathGuard.toRelative(absolute);

    const stat = await ctx.fs.stat(absolute);
    if (stat.type !== 'directory') {
      return {
        content: `${relative} không phải thư mục. Dùng read_file để đọc nội dung.`,
        isError: true,
        untrusted: false,
      };
    }

    const entries = await ctx.fs.readDir(absolute);

    const dirs: string[] = [];
    const files: string[] = [];
    let hiddenByDenylist = 0;
    let skippedDirs = 0;

    for (const e of entries) {
      if (e.type === 'directory') {
        if (SKIP_DIRS.has(e.name)) {
          skippedDirs++;
          continue;
        }
        dirs.push(`${e.name}/`);
        continue;
      }
      if (e.type !== 'file') continue;

      const rel = await ctx.pathGuard.toRelative(nodePath.join(absolute, e.name));
      if (ctx.denylist.isDenied(rel)) {
        hiddenByDenylist++;
        continue;
      }
      files.push(e.name);
    }

    dirs.sort();
    files.sort();

    if (dirs.length === 0 && files.length === 0) {
      const why =
        hiddenByDenylist > 0 || skippedDirs > 0
          ? ` (${hiddenByDenylist} mục bị ẩn theo quy tắc bảo mật, ${skippedDirs} thư mục sinh ra bởi build bị bỏ qua)`
          : '';
      return { content: `${relative} rỗng${why}.`, untrusted: false, meta: { path: relative } };
    }

    const notes: string[] = [];
    if (hiddenByDenylist > 0) {
      notes.push(`${hiddenByDenylist} file bị ẩn vì có thể chứa thông tin bí mật`);
    }
    if (skippedDirs > 0) {
      notes.push(`${skippedDirs} thư mục sinh ra bởi build/deps bị bỏ qua`);
    }

    return {
      content:
        `${relative}/\n` +
        [...dirs, ...files].join('\n') +
        (notes.length > 0 ? `\n\n(${notes.join('; ')})` : ''),
      untrusted: true,
      meta: { path: relative, dirs: dirs.length, files: files.length },
    };
  },
};
