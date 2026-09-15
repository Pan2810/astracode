/**
 * `find_references` / `impact_of` — mốc M12 (CodeGraph v1).
 *
 * Cùng khuôn `grep`/`glob`: `readOnly: true`, không cần `describe()`. Khác một
 * điểm: chỉ trả về VỊ TRÍ (đường dẫn + dòng), không trả nội dung file — diện
 * tích injection nhỏ hơn nhiều so với `read_file`, nhưng vẫn giữ
 * `untrusted: true` mặc định vì tên symbol trích từ file vẫn là dữ liệu không
 * tin cậy (AgentLoop bọc delimiter như mọi tool khác, không có lý do đặc cách).
 */
import { z } from 'zod';
import type { Tool, ToolContext, ToolResult } from './Tool.js';
import { PathGuardError } from '../security/pathGuard.js';

function noGraph(): ToolResult {
  return {
    content: 'CodeGraph chưa sẵn sàng trong phiên này.',
    isError: true,
    untrusted: false,
  };
}

const findReferencesSchema = z.object({
  symbol: z.string().min(1).describe('Tên symbol cần tìm — hàm, class, biến, interface, type...'),
});

export const findReferencesTool: Tool<typeof findReferencesSchema> = {
  name: 'find_references',
  description:
    'Tìm nơi ĐỊNH NGHĨA và mọi nơi DÙNG một symbol (hàm, class, biến, type) trong workspace, ' +
    'kể cả khi nó được import với tên khác (alias). Dùng CÁI NÀY thay vì grep khi câu hỏi là ' +
    '"X được dùng ở đâu" — grep chỉ khớp chữ, không biết alias và không phân biệt được symbol ' +
    'với một chuỗi trùng tên trong comment/string.',
  schema: findReferencesSchema,
  readOnly: true,

  async execute(args, ctx: ToolContext): Promise<ToolResult> {
    if (!ctx.codeGraph) return noGraph();
    const graph = await ctx.codeGraph.ensureFresh(ctx.signal);

    const def = graph.definitionOf(args.symbol);
    const refs = graph.referencesTo(args.symbol);

    if (!def && refs.length === 0) {
      return {
        content:
          `Không tìm thấy symbol "${args.symbol}" trong CodeGraph. Ngôn ngữ được hỗ trợ hiện ` +
          'tại: TypeScript/TSX, JavaScript, Python, Go. Thử grep để chắc chắn không sót.',
        untrusted: false,
        meta: { symbol: args.symbol, found: false },
      };
    }

    const lines: string[] = [];
    if (def) lines.push(`Định nghĩa: ${def.file}:${def.line} (${def.kind})`);
    if (refs.length > 0) {
      lines.push(`Tham chiếu (${refs.length}):`);
      for (const r of refs) lines.push(`  ${r.file}:${r.line}`);
    } else {
      lines.push('Không có tham chiếu nào khác trong graph.');
    }
    if (graph.truncated) lines.push('\n(CodeGraph chưa index hết repo — vượt trần số file, kết quả có thể thiếu.)');

    return {
      content: lines.join('\n'),
      untrusted: true,
      meta: {
        symbol: args.symbol,
        found: true,
        hasDefinition: def !== undefined,
        references: refs.length,
        truncated: graph.truncated,
      },
    };
  },
};

const impactOfSchema = z.object({
  file: z.string().min(1).describe('Đường dẫn file cần xem bán kính ảnh hưởng khi sửa'),
  depth: z
    .number()
    .int()
    .min(1)
    .max(10)
    .optional()
    .describe('Độ sâu lan truyền ngược qua cạnh import. Mặc định 3.'),
});

export const impactOfTool: Tool<typeof impactOfSchema> = {
  name: 'impact_of',
  description:
    'Liệt kê những file sẽ bị ảnh hưởng nếu sửa một file — đi ngược theo cạnh import (ai import ' +
    'file này, rồi ai import những file đó...). Gọi TRƯỚC khi sửa một file nhiều nơi dùng, để ' +
    'biết cần kiểm tra thêm chỗ nào.',
  schema: impactOfSchema,
  readOnly: true,

  async execute(args, ctx: ToolContext): Promise<ToolResult> {
    if (!ctx.codeGraph) return noGraph();
    const graph = await ctx.codeGraph.ensureFresh(ctx.signal);

    let relative: string;
    try {
      relative = await ctx.pathGuard.toRelative(await ctx.pathGuard.resolveExisting(args.file));
    } catch (err) {
      if (err instanceof PathGuardError) return { content: err.message, isError: true, untrusted: false };
      throw err;
    }

    if (graph.hashOf(relative) === undefined) {
      return {
        content:
          `"${relative}" chưa được index trong CodeGraph — ngôn ngữ không được hỗ trợ, bị ` +
          '.astraignore/denylist chặn, hoặc repo vượt trần số file lúc build graph.',
        untrusted: false,
        meta: { file: relative, found: false },
      };
    }

    const depth = args.depth ?? 3;
    const impacted = graph.impactRadius(relative, depth);
    const directImports = graph.importsOf(relative);

    const lines = [
      `File "${relative}" nhập (${directImports.length}): ${directImports.join(', ') || '(không có)'}`,
      `Bị ảnh hưởng trong bán kính ${depth} bước (${impacted.length} file):`,
      ...(impacted.length > 0 ? impacted.map((f) => `  ${f}`) : ['  (không có file nào import tới đây)']),
    ];
    if (graph.truncated) lines.push('\n(CodeGraph chưa index hết repo — vượt trần số file, kết quả có thể thiếu.)');

    return {
      content: lines.join('\n'),
      untrusted: true,
      meta: { file: relative, found: true, impacted: impacted.length, depth, truncated: graph.truncated },
    };
  },
};
