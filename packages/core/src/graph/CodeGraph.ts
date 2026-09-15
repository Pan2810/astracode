/**
 * Đồ thị import/export + bảng symbol của workspace — mốc M12.
 *
 * Thuần dữ liệu trong bộ nhớ, không tự parse gì (đó là việc của
 * `GraphBuilder`/`TreeSitterParser`) và không tự đọc/ghi đĩa (đó là việc của
 * `GraphCache`). Tách vậy để test được đồ thị bằng dữ liệu giả, không cần
 * dựng cả tree-sitter.
 */
import type { GraphSnapshot, SymbolDefinition, SymbolLocation } from './types.js';

export class CodeGraph {
  private readonly imports = new Map<string, Set<string>>();
  private readonly importedByIndex = new Map<string, Set<string>>();
  private readonly definitions = new Map<string, SymbolDefinition[]>();
  private readonly references = new Map<string, SymbolLocation[]>();
  private readonly fileHashes = new Map<string, string>();

  /** Repo vượt trần số file lúc build — kết quả graph không đầy đủ. */
  truncated = false;

  hashOf(file: string): string | undefined {
    return this.fileHashes.get(file);
  }

  knownFiles(): string[] {
    return [...this.fileHashes.keys()];
  }

  /**
   * Ghi (hoặc ghi đè) toàn bộ dữ liệu của một file. Gọi lại cho file đã có sẽ
   * tự xoá dữ liệu cũ trước — không cộng dồn.
   */
  setFile(
    file: string,
    hash: string,
    resolvedImports: string[],
    definitions: SymbolDefinition[],
    references: SymbolLocation[],
  ): void {
    this.removeFile(file);

    this.fileHashes.set(file, hash);

    const importSet = new Set(resolvedImports);
    this.imports.set(file, importSet);
    for (const target of importSet) {
      let back = this.importedByIndex.get(target);
      if (!back) {
        back = new Set();
        this.importedByIndex.set(target, back);
      }
      back.add(file);
    }

    for (const def of definitions) {
      let list = this.definitions.get(def.name);
      if (!list) {
        list = [];
        this.definitions.set(def.name, list);
      }
      list.push(def);
    }

    for (const ref of references) {
      let list = this.references.get(ref.name);
      if (!list) {
        list = [];
        this.references.set(ref.name, list);
      }
      list.push(ref);
    }
  }

  /** Xoá sạch dữ liệu của một file — cạnh, định nghĩa, tham chiếu. Không throw nếu file chưa có. */
  removeFile(file: string): void {
    const oldImports = this.imports.get(file);
    if (oldImports) {
      for (const target of oldImports) this.importedByIndex.get(target)?.delete(file);
      this.imports.delete(file);
    }
    // CỐ Ý không xoá `importedByIndex.get(file)`: đó là "ai import file này",
    // dữ liệu thuộc về NHỮNG FILE KHÁC (đã ghi lúc chính chúng gọi `setFile`),
    // không phải của `file`. Xoá nó ở đây sẽ làm mất cạnh hợp lệ nếu file này
    // được set lại SAU file import nó — đúng thứ tự `setFile('a', imports:
    // ['b']); setFile('b')` tạo ra.
    this.fileHashes.delete(file);

    for (const [name, defs] of [...this.definitions]) {
      const kept = defs.filter((d) => d.file !== file);
      if (kept.length > 0) this.definitions.set(name, kept);
      else this.definitions.delete(name);
    }
    for (const [name, refs] of [...this.references]) {
      const kept = refs.filter((r) => r.file !== file);
      if (kept.length > 0) this.references.set(name, kept);
      else this.references.delete(name);
    }
  }

  importsOf(file: string): string[] {
    return [...(this.imports.get(file) ?? [])];
  }

  importedBy(file: string): string[] {
    return [...(this.importedByIndex.get(file) ?? [])];
  }

  /**
   * Định nghĩa đầu tiên tìm được cho tên này. Nhiều file định nghĩa cùng tên
   * (rất thường gặp: `run`, `main`...) thì đây chỉ là best-effort — CodeGraph
   * v1 không phân giải theo scope/import, đó là việc của một mốc sau (L2).
   */
  definitionOf(symbol: string): SymbolDefinition | undefined {
    return this.definitions.get(symbol)?.[0];
  }

  referencesTo(symbol: string): SymbolLocation[] {
    return [...(this.references.get(symbol) ?? [])];
  }

  /** BFS ngược trên `importedBy`, giới hạn độ sâu — file nào sẽ bị ảnh hưởng nếu sửa `file`. */
  impactRadius(file: string, depth: number): string[] {
    const seen = new Set<string>([file]);
    let frontier = [file];

    for (let d = 0; d < depth && frontier.length > 0; d++) {
      const next: string[] = [];
      for (const current of frontier) {
        for (const dependent of this.importedBy(current)) {
          if (seen.has(dependent)) continue;
          seen.add(dependent);
          next.push(dependent);
        }
      }
      frontier = next;
    }

    seen.delete(file);
    return [...seen];
  }

  toSnapshot(schemaVersion: number): GraphSnapshot {
    const files: GraphSnapshot['files'] = {};
    for (const file of this.fileHashes.keys()) {
      files[file] = {
        imports: [...(this.imports.get(file) ?? [])],
        importedBy: [...(this.importedByIndex.get(file) ?? [])],
      };
    }

    const definitions: GraphSnapshot['definitions'] = {};
    for (const [name, defs] of this.definitions) definitions[name] = defs;

    const references: GraphSnapshot['references'] = {};
    for (const [name, refs] of this.references) references[name] = refs;

    return {
      schemaVersion,
      fileHashes: Object.fromEntries(this.fileHashes),
      files,
      definitions,
      references,
      truncated: this.truncated,
    };
  }

  static fromSnapshot(snapshot: GraphSnapshot): CodeGraph {
    const graph = new CodeGraph();
    for (const [file, hash] of Object.entries(snapshot.fileHashes)) graph.fileHashes.set(file, hash);
    for (const [file, edges] of Object.entries(snapshot.files)) {
      graph.imports.set(file, new Set(edges.imports));
      graph.importedByIndex.set(file, new Set(edges.importedBy));
    }
    for (const [name, defs] of Object.entries(snapshot.definitions)) graph.definitions.set(name, defs);
    for (const [name, refs] of Object.entries(snapshot.references)) graph.references.set(name, refs);
    graph.truncated = snapshot.truncated;
    return graph;
  }
}
