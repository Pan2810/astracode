/**
 * write_file — tạo mới hoặc ghi đè toàn bộ một file (M4).
 *
 * Cố ý ĐỂ MÔ TẢ NGHIÊNG về edit_file: ghi đè cả file là cách nhanh nhất để
 * model xoá mất phần nó chưa từng đọc. Một model chỉ nhìn thấy 200 dòng đầu
 * của file 800 dòng sẽ vui vẻ ghi đè bằng đúng 200 dòng đó.
 *
 * Chốt chặn cho đúng chuyện ấy nằm ở dưới: ghi đè file đã tồn tại mà nội dung
 * mới ngắn hơn nhiều so với bản cũ thì bị từ chối, kèm hướng dẫn dùng edit_file.
 */
import { z } from 'zod';
import type { Tool, ToolContext, ToolIntent, ToolResult } from './Tool.js';
import {
  commitWrite,
  matchLineEndings,
  resolveWriteTarget,
  scriptWriteWarnings,
} from './writeCommon.js';
import { diffStat, diffLines, formatUnifiedDiff } from '../changes/diff.js';

const schema = z.object({
  path: z.string().min(1).describe('Đường dẫn file, tương đối so với thư mục làm việc'),
  content: z.string().describe('Toàn bộ nội dung mới của file'),
});

/** Ghi đè còn lại dưới tỉ lệ này so với bản cũ thì gần như chắc chắn là nhầm. */
const SHRINK_LIMIT = 0.1;
/** File nhỏ hơn ngưỡng này thì không áp luật co ngót — viết lại là bình thường. */
const SHRINK_MIN_LINES = 30;

export const writeFileTool: Tool<typeof schema> = {
  name: 'write_file',
  description:
    'Tạo file mới, hoặc ghi đè TOÀN BỘ nội dung một file đã có. ' +
    'Chỉ dùng cho file mới hoặc khi thực sự cần viết lại cả file. ' +
    'Muốn sửa một phần của file đã có thì dùng edit_file — an toàn hơn nhiều.',
  schema,
  readOnly: false,

  async describe(args, ctx: ToolContext): Promise<ToolIntent> {
    const resolved = await resolveWriteTarget(args.path, ctx);
    if (!resolved.ok) return { summary: `Write ${args.path}`, path: args.path };

    const { target } = resolved;
    const warnings = scriptWriteWarnings(target.relative, args.content, ctx);

    if (target.original === null) {
      const lines = args.content.split(/\r?\n/).length;
      return {
        summary: `Create ${target.relative} (${lines} lines)`,
        path: target.relative,
        preview: args.content.slice(0, 2000),
        ...(warnings.length ? { warnings } : {}),
      };
    }

    const next = matchLineEndings(target.original, args.content);
    const stat = diffStat(diffLines(target.original, next));
    return {
      summary: `Overwrite ${target.relative} (+${stat.added}/−${stat.removed})`,
      path: target.relative,
      preview: formatUnifiedDiff(target.original, next),
      previewKind: 'diff',
      ...(warnings.length ? { warnings } : {}),
    };
  },

  async execute(args, ctx: ToolContext): Promise<ToolResult> {
    const resolved = await resolveWriteTarget(args.path, ctx);
    if (!resolved.ok) return resolved.result;

    const { target } = resolved;
    const next = matchLineEndings(target.original, args.content);

    if (target.original !== null) {
      const oldLines = target.original.split(/\r?\n/).length;
      const newLines = next.split(/\r?\n/).length;
      if (oldLines >= SHRINK_MIN_LINES && newLines < oldLines * SHRINK_LIMIT) {
        return {
          content:
            `Từ chối: ${target.relative} đang có ${oldLines} dòng, nội dung bạn gửi chỉ ` +
            `${newLines} dòng. Ghi đè như vậy sẽ xoá phần bạn chưa đọc. ` +
            `Dùng edit_file để sửa đúng đoạn cần sửa, hoặc read_file toàn bộ trước ` +
            `nếu thật sự muốn viết lại cả file.`,
          isError: true,
          untrusted: false,
        };
      }
    }

    if (target.original === next) {
      return {
        content: `${target.relative} đã đúng nội dung đó rồi, không có gì để ghi.`,
        untrusted: false,
      };
    }

    const status = await commitWrite(target, next, ctx);
    const lines = next.split(/\r?\n/).length;

    return {
      content:
        status === 'created'
          ? `Đã tạo ${target.relative} (${lines} dòng).`
          : `Đã ghi đè ${target.relative} (${lines} dòng).`,
      untrusted: false,
      meta: { path: target.relative, status, lines },
    };
  },
};
