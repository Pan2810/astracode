/**
 * Kiểu dữ liệu dùng chung cho CodeGraph — mốc M12.
 *
 * Tách riêng khỏi `CodeGraph.ts` để `GraphBuilder`, `GraphCache` và các tool
 * dùng cùng một định nghĩa mà không phải import ngược vào lớp đồ thị.
 */
import type { CodeGraph } from './CodeGraph.js';

/** Vị trí một symbol trong file — đường dẫn LUÔN tương đối workspace (qua pathGuard). */
export interface SymbolLocation {
  /** Đường dẫn tương đối, dùng `/`. */
  file: string;
  /** Dòng 1-based, khớp với cách `grep`/`read_file` báo số dòng. */
  line: number;
  /** Cột 0-based — chỉ để phân biệt hai symbol cùng dòng, không hiển thị riêng. */
  column: number;
  name: string;
}

export type DefinitionKind =
  | 'function'
  | 'class'
  | 'method'
  | 'variable'
  | 'interface'
  | 'type';

export interface SymbolDefinition extends SymbolLocation {
  kind: DefinitionKind;
}

/** Một file đã parse xong — đầu ra của `TreeSitterParser`, đầu vào của `GraphBuilder`. */
export interface ParsedFile {
  file: string;
  /** Đường dẫn module trong mỗi câu `import`, CHƯA giải thành file thật. */
  imports: string[];
  definitions: SymbolDefinition[];
  /** Mọi identifier được dùng làm giá trị (không tính chỗ nó được định nghĩa). */
  references: SymbolLocation[];
  /**
   * Tên cục bộ -> tên gốc, cho `import { foo as bar }`. Cho phép `referencesTo('foo')`
   * tìm ra cả những chỗ gọi `bar()` — điều grep văn bản không làm được.
   */
  importAliases: Map<string, string>;
}

/** Ảnh chụp toàn bộ graph để lưu cache — chỉ dữ liệu thuần, không Map/Set. */
export interface GraphSnapshot {
  schemaVersion: number;
  /** file -> sha256 nội dung lúc index, để biết file nào đổi khi load lại. */
  fileHashes: Record<string, string>;
  files: Record<string, { imports: string[]; importedBy: string[] }>;
  definitions: Record<string, SymbolDefinition[]>;
  references: Record<string, SymbolLocation[]>;
  /** Repo vượt trần số file lúc build — graph không đầy đủ. */
  truncated: boolean;
}

/**
 * Nguồn CodeGraph cho một workspace, đủ mới để trả lời truy vấn.
 *
 * Cố ý KHÔNG bắt tool tự gọi `GraphBuilder`/`GraphCache` — mỗi bề mặt làm mới
 * theo cách khác nhau (CLI so hash lại mỗi lượt; extension dựng lười + watcher
 * đánh dấu dirty, xem `packages/vscode/src/graph/CodeGraphService.ts`), và tool
 * không cần biết bên nào đang chạy nó.
 */
export interface CodeGraphProvider {
  ensureFresh(signal?: AbortSignal): Promise<CodeGraph>;
}
