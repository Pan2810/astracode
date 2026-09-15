/**
 * Cache CodeGraph trên đĩa — mốc M12.
 *
 * Vị trí: `graphDir(layout, workspaceRoot)`, tái dùng `projectSlug()` đã có
 * (không phát minh cách hash workspace mới). Version guard theo đúng mẫu
 * "reject nếu file mới hơn code đang chạy" của `StateStore.parseState`, nhưng
 * là một hợp đồng RIÊNG — không tái dùng version counter của StateStore.
 *
 * Không gắn vào `HomeCleanup`: cache này "cũ khi workspace đổi", không phải
 * "cũ khi hết hạn tuổi", nên trục dọn dẹp 30 ngày của HomeCleanup sai cho nó.
 * v1 chỉ cần một điều: cache hỏng hoặc lệch schema thì bỏ qua và build lại từ
 * đầu, không bao giờ throw — đúng nguyên tắc đang áp cho `state.json`.
 */
import { join } from 'node:path';
import type { FileSystem } from '../fs/FileSystem.js';
import type { Logger } from '../telemetry/logger.js';
import { CodeGraph } from './CodeGraph.js';
import type { GraphSnapshot } from './types.js';

export const GRAPH_SCHEMA_VERSION = 1;
const SNAPSHOT_FILE = 'snapshot.json';

export interface GraphCacheOptions {
  fs: FileSystem;
  /** `graphDir(layout, workspaceRoot)`. */
  dir: string;
  logger: Logger;
}

export class GraphCache {
  constructor(private readonly opts: GraphCacheOptions) {}

  /** `undefined` = chưa từng build, hoặc cache hỏng/lệch schema — không throw. */
  async load(): Promise<CodeGraph | undefined> {
    try {
      const raw = await this.opts.fs.readFile(join(this.opts.dir, SNAPSHOT_FILE));
      const snapshot = parseSnapshot(raw);
      return snapshot ? CodeGraph.fromSnapshot(snapshot) : undefined;
    } catch {
      return undefined;
    }
  }

  async save(graph: CodeGraph): Promise<void> {
    try {
      await this.opts.fs.writeFile(
        join(this.opts.dir, SNAPSHOT_FILE),
        JSON.stringify(graph.toSnapshot(GRAPH_SCHEMA_VERSION)),
      );
    } catch (err) {
      // Ghi cache lỗi không được làm hỏng lượt hiện tại: graph vẫn dùng được
      // trong bộ nhớ, chỉ là lần sau phải build lại từ đầu.
      this.opts.logger.warn('CodeGraph: không ghi được cache', {
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

function parseSnapshot(raw: string): GraphSnapshot | undefined {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof data !== 'object' || data === null) return undefined;
  const d = data as Partial<GraphSnapshot>;

  // Lệch schema (cũ HAY mới) đều bỏ ở v1: build lại từ đầu rẻ hơn viết logic
  // migrate cho một cache dựng lại được 100% từ source, không phải dữ liệu gốc.
  if (typeof d.schemaVersion !== 'number' || d.schemaVersion !== GRAPH_SCHEMA_VERSION) return undefined;
  if (!d.fileHashes || !d.files || !d.definitions || !d.references) return undefined;

  return d as GraphSnapshot;
}
