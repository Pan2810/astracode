/**
 * Build/refresh CodeGraph — mốc M12.
 *
 * Tái dùng đúng hạ tầng `grep`/`glob` đang dùng: `walkFiles` (bỏ `SKIP_DIRS`,
 * lọc `Denylist`, giới hạn qua `PathGuard`) — không viết lại traversal riêng
 * cho graph. Mọi đường vào graph đi qua đúng cổng đó, nên `.env`/khoá riêng
 * không bao giờ lọt vào graph, giống `read_file`.
 *
 * Tăng dần theo hash nội dung: file không đổi hash so với graph cũ thì bỏ qua
 * parse — không cần watcher ở tầng này, `packages/vscode` chỉ cần gọi lại
 * `build(graph)` với graph cũ và việc so hash tự lo phần "chỉ parse lại file
 * đã đổi".
 */
import { createHash } from 'node:crypto';
import * as posixPath from 'node:path/posix';
import type { FileSystem } from '../fs/FileSystem.js';
import type { PathGuard } from '../security/pathGuard.js';
import type { Denylist } from '../security/denylist.js';
import type { Logger } from '../telemetry/logger.js';
import type { ToolContext } from '../tools/Tool.js';
import { walkFiles } from '../tools/walk.js';
import { CodeGraph } from './CodeGraph.js';
import type { ParsedFile, SymbolLocation } from './types.js';
import type { TreeSitterParser } from './parser/TreeSitterParser.js';

/**
 * Trần số file PARSE, thấp hơn trần 20 000 của `walkFiles` — parse tốn hơn
 * nhiều so với chỉ liệt kê tên file (yêu cầu M12: "repo lớn thì không index
 * hết"). Vượt trần thì graph vẫn dùng được, chỉ thiếu file — `truncated: true`.
 */
export const DEFAULT_MAX_GRAPH_FILES = 8_000;

const RESOLVE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.go'];

export interface GraphBuilderOptions {
  workspaceRoot: string;
  fs: FileSystem;
  pathGuard: PathGuard;
  denylist: Denylist;
  logger: Logger;
  parser: TreeSitterParser;
  maxFiles?: number;
  signal?: AbortSignal;
}

/**
 * Giải một specifier import thành đường dẫn workspace-relative, nếu nó CHỈ
 * TRỎ vào file trong `knownFiles`. Package ngoài (`react`, `os`, module chuẩn
 * không có tiền tố `.`/`/`) trả `undefined` — chúng không thuộc dependency
 * graph của repo.
 */
export function resolveImportPath(
  fromFile: string,
  specifier: string,
  knownFiles: ReadonlySet<string>,
): string | undefined {
  if (!specifier.startsWith('.') && !specifier.startsWith('/')) return undefined;

  const fromDir = posixPath.dirname(fromFile);
  const joined = specifier.startsWith('/') ? specifier.slice(1) : posixPath.join(fromDir, specifier);
  const normalized = posixPath.normalize(joined);

  if (knownFiles.has(normalized)) return normalized;

  for (const ext of RESOLVE_EXTENSIONS) {
    if (knownFiles.has(normalized + ext)) return normalized + ext;
  }
  for (const ext of RESOLVE_EXTENSIONS) {
    const indexPath = `${normalized}/index${ext}`;
    if (knownFiles.has(indexPath)) return indexPath;
  }
  return undefined;
}

/**
 * Thêm bản tham chiếu dưới TÊN GỐC cho mỗi lần dùng một alias import (`import
 * { foo as bar }` rồi gọi `bar()`) — cho phép `referencesTo('foo')` tìm ra cả
 * những chỗ này, điều grep văn bản không làm được vì nó chỉ khớp đúng chữ
 * "foo".
 */
function expandAliasedReferences(parsed: ParsedFile): SymbolLocation[] {
  if (parsed.importAliases.size === 0) return parsed.references;

  const extra: SymbolLocation[] = [];
  for (const ref of parsed.references) {
    const original = parsed.importAliases.get(ref.name);
    if (original) extra.push({ ...ref, name: original });
  }
  return extra.length > 0 ? [...parsed.references, ...extra] : parsed.references;
}

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

export class GraphBuilder {
  constructor(private readonly opts: GraphBuilderOptions) {}

  /**
   * Build hoặc refresh. Truyền `existing` để cập nhật tăng dần (file không đổi
   * hash bị bỏ qua, file đã xoá bị dọn khỏi graph); không truyền thì build mới.
   */
  async build(existing?: CodeGraph): Promise<CodeGraph> {
    const graph = existing ?? new CodeGraph();

    const ctx: ToolContext = {
      workspaceRoot: this.opts.workspaceRoot,
      fs: this.opts.fs,
      pathGuard: this.opts.pathGuard,
      denylist: this.opts.denylist,
      logger: this.opts.logger,
      ...(this.opts.signal ? { signal: this.opts.signal } : {}),
    };

    const maxFiles = this.opts.maxFiles ?? DEFAULT_MAX_GRAPH_FILES;
    const { files, truncated } = await walkFiles(ctx, {
      root: this.opts.workspaceRoot,
      maxFiles,
      applyDenylist: true,
    });
    graph.truncated = truncated;

    const knownFiles = new Set(files.map((f) => f.relative));
    const seen = new Set<string>();

    for (const file of files) {
      if (ctx.signal?.aborted) break;
      seen.add(file.relative);

      let content: string;
      try {
        content = await ctx.fs.readFile(file.absolute);
      } catch {
        continue;
      }

      const hash = sha256(content);
      if (graph.hashOf(file.relative) === hash) continue;

      const parsed = await this.opts.parser.parseFile(file.relative, content);
      if (!parsed) {
        // Ngôn ngữ không hỗ trợ — vẫn ghi hash để không parse lại vô ích lần
        // sau, nhưng không có cạnh/symbol nào cho file này.
        graph.setFile(file.relative, hash, [], [], []);
        continue;
      }

      const resolvedImports = parsed.imports
        .map((spec) => resolveImportPath(file.relative, spec, knownFiles))
        .filter((x): x is string => x !== undefined);

      graph.setFile(file.relative, hash, resolvedImports, parsed.definitions, expandAliasedReferences(parsed));
    }

    for (const known of graph.knownFiles()) {
      if (!seen.has(known)) graph.removeFile(known);
    }

    return graph;
  }
}
