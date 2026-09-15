/**
 * Bọc `web-tree-sitter` (WASM) — nguồn sự thật của CodeGraph, chốt ở ADR-020.
 *
 * WASM, không phải native binding: native `tree-sitter` là `.node` addon phải
 * build riêng theo platform/arch, đóng gói vào một VS Code extension qua
 * esbuild/vsce là rủi ro packaging không đáng cho v1. WASM chạy giống nhau
 * trong Node (CLI) và extension host, không cần compile theo máy.
 *
 * Ngôn ngữ không có grammar tương ứng, hoặc grammar/query nạp lỗi, đều CHỈ log
 * warn rồi trả `undefined` — một extension chưa hỗ trợ hay một câu query viết
 * sai không được phép làm hỏng cả lượt build graph (yêu cầu M12: "không đoán
 * bằng regex", ngầm định luôn là "không throw" nữa).
 *
 * Đường vào `Language.load()`/`Parser.init()` dưới đây là I/O nội bộ của chính
 * thư viện `web-tree-sitter` (đọc file .wasm) — không phải core tự ý chạm
 * `node:fs`, nên không phạm nguyên tắc "filesystem một cửa" (đó nói về việc
 * ĐỌC FILE CỦA WORKSPACE, không phải asset của một thư viện đã cài).
 *
 * PIN cứng ở `0.22.x` (xem packages/core/package.json) — không phải sở thích.
 * `web-tree-sitter` ≥ 0.25 đổi cách nạp `.wasm` ngữ pháp (đòi dylink metadata,
 * kiểu side-module Emscripten); các file trong `tree-sitter-wasms` được build
 * bằng `tree-sitter-cli@0.20.x` và KHÔNG có metadata đó — `Language.load()` ném
 * lỗi "getDylinkMetadata" ngay lập tức trên bản 0.26. Nâng version của một
 * trong hai package thì phải test lại bằng `pnpm --filter @astra/core test`
 * (GraphBuilder.test.ts parse thật bằng 5 grammar, không mock) trước khi đổi.
 */
import { createRequire } from 'node:module';
import * as nodePath from 'node:path';
import Parser from 'web-tree-sitter';
import type { Logger } from '../../telemetry/logger.js';
import type { DefinitionKind, ParsedFile, SymbolDefinition, SymbolLocation } from '../types.js';
import { JAVASCRIPT_QUERY } from './queries/javascript.js';
import { TYPESCRIPT_QUERY } from './queries/typescript.js';
import { PYTHON_QUERY } from './queries/python.js';
import { GO_QUERY } from './queries/go.js';

export type LanguageId = 'javascript' | 'typescript' | 'tsx' | 'python' | 'go';

const EXTENSION_LANGUAGE: Record<string, LanguageId> = {
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.ts': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.tsx': 'tsx',
  '.py': 'python',
  '.go': 'go',
};

const QUERY_SOURCE: Record<LanguageId, string> = {
  javascript: JAVASCRIPT_QUERY,
  typescript: TYPESCRIPT_QUERY,
  tsx: TYPESCRIPT_QUERY,
  python: PYTHON_QUERY,
  go: GO_QUERY,
};

/**
 * Tên file runtime wasm của chính `web-tree-sitter`, nằm ở gốc package.
 * `tree-sitter.wasm` — ĐÚNG cho dòng 0.22.x đang pin (bản ≥0.25 đổi tên thành
 * `web-tree-sitter.wasm`, xem comment ABI ở đầu file).
 */
export const RUNTIME_WASM_FILENAME = 'tree-sitter.wasm';

/**
 * Tên file .wasm ngữ pháp trong `tree-sitter-wasms/out/`. Xuất công khai để
 * `packages/vscode` biết copy đúng file nào vào `dist/wasm` lúc build (xem
 * `esbuild.mjs`) — một extension đã đóng gói không có `node_modules` để tự
 * `require.resolve`.
 */
export const GRAMMAR_WASM_FILENAMES: Record<LanguageId, string> = {
  javascript: 'tree-sitter-javascript.wasm',
  typescript: 'tree-sitter-typescript.wasm',
  tsx: 'tree-sitter-tsx.wasm',
  python: 'tree-sitter-python.wasm',
  go: 'tree-sitter-go.wasm',
};

/** Ngôn ngữ suy từ phần mở rộng file — `undefined` = bỏ qua im lặng (đúng yêu cầu M12). */
export function languageForFile(relativePath: string): LanguageId | undefined {
  return EXTENSION_LANGUAGE[nodePath.extname(relativePath).toLowerCase()];
}

function defaultResolveGrammarWasm(lang: LanguageId): string {
  const require = createRequire(import.meta.url);
  return require.resolve(`tree-sitter-wasms/out/${GRAMMAR_WASM_FILENAMES[lang]}`);
}

export interface TreeSitterParserOptions {
  /**
   * Đường dẫn tới runtime `web-tree-sitter.wasm`. Không truyền = để thư viện
   * tự tìm cạnh chính nó trong `node_modules` — đúng cho CLI và test, SAI cho
   * extension đã đóng gói (vsix không kèm `node_modules`, xem esbuild.mjs).
   */
  runtimeWasmPath?: string;
  /** Đường dẫn file .wasm ngữ pháp cho một ngôn ngữ. Không truyền = resolve qua `tree-sitter-wasms` trong node_modules. */
  resolveGrammarWasm?: (language: LanguageId) => string;
  logger?: Logger;
}

function toLocation(file: string, node: Parser.SyntaxNode): SymbolLocation {
  return {
    file,
    line: node.startPosition.row + 1,
    column: node.startPosition.column,
    name: node.text,
  };
}

/** Bỏ ngoặc kép/nháy đơn/backtick quanh chuỗi module — không đổi gì nếu không có. */
function stripQuotes(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length < 2) return trimmed;
  const first = trimmed[0];
  const last = trimmed[trimmed.length - 1];
  if ((first === '"' || first === "'" || first === '`') && first === last) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

const DEFINITION_PREFIX = 'definition.';

export class TreeSitterParser {
  private initPromise: Promise<void> | undefined;
  private readonly languages = new Map<LanguageId, Parser.Language | null>();
  private readonly queries = new Map<LanguageId, Parser.Query | null>();

  constructor(private readonly opts: TreeSitterParserOptions = {}) {}

  private ensureInit(): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = Parser.init(
        this.opts.runtimeWasmPath ? { locateFile: () => this.opts.runtimeWasmPath! } : undefined,
      );
    }
    return this.initPromise;
  }

  private async loadLanguage(lang: LanguageId): Promise<Parser.Language | null> {
    const cached = this.languages.get(lang);
    if (cached !== undefined) return cached;

    await this.ensureInit();
    try {
      const resolve = this.opts.resolveGrammarWasm ?? defaultResolveGrammarWasm;
      const language = await Parser.Language.load(resolve(lang));
      this.languages.set(lang, language);
      return language;
    } catch (err) {
      this.opts.logger?.warn(`CodeGraph: không nạp được ngữ pháp "${lang}"`, {
        reason: err instanceof Error ? err.message : String(err),
      });
      this.languages.set(lang, null);
      return null;
    }
  }

  private loadQuery(lang: LanguageId, language: Parser.Language): Parser.Query | null {
    const cached = this.queries.get(lang);
    if (cached !== undefined) return cached;

    try {
      const query = language.query(QUERY_SOURCE[lang]);
      this.queries.set(lang, query);
      return query;
    } catch (err) {
      this.opts.logger?.warn(`CodeGraph: query "${lang}" không hợp lệ`, {
        reason: err instanceof Error ? err.message : String(err),
      });
      this.queries.set(lang, null);
      return null;
    }
  }

  /** Ngôn ngữ không nhận ra, hoặc grammar/query nạp lỗi -> `undefined`, không ném. */
  async parseFile(relativePath: string, content: string): Promise<ParsedFile | undefined> {
    const lang = languageForFile(relativePath);
    if (!lang) return undefined;

    const language = await this.loadLanguage(lang);
    if (!language) return undefined;
    const query = this.loadQuery(lang, language);
    if (!query) return undefined;

    const parser = new Parser();
    parser.setLanguage(language);
    const tree = parser.parse(content);
    if (!tree) return undefined;

    const imports: string[] = [];
    const definitions: SymbolDefinition[] = [];
    const references: SymbolLocation[] = [];
    const importAliases = new Map<string, string>();
    const definitionSites = new Set<string>();

    for (const match of query.matches(tree.rootNode)) {
      let aliasLocal: string | undefined;
      let aliasOriginal: string | undefined;

      for (const cap of match.captures) {
        const loc = toLocation(relativePath, cap.node);

        if (cap.name === 'import.source') {
          imports.push(stripQuotes(cap.node.text));
        } else if (cap.name === 'import.alias.local') {
          aliasLocal = cap.node.text;
        } else if (cap.name === 'import.alias.original') {
          aliasOriginal = cap.node.text;
        } else if (cap.name.startsWith(DEFINITION_PREFIX)) {
          const kind = cap.name.slice(DEFINITION_PREFIX.length) as DefinitionKind;
          definitions.push({ ...loc, kind });
          definitionSites.add(`${loc.line}:${loc.column}`);
        } else if (cap.name === 'reference') {
          references.push(loc);
        }
      }

      if (aliasLocal && aliasOriginal) importAliases.set(aliasLocal, aliasOriginal);
    }

    // Một identifier ở VỊ TRÍ định nghĩa cũng khớp pattern `@reference` (nó vẫn
    // là một identifier) — loại theo toạ độ để không tự đếm chỗ định nghĩa là
    // một tham chiếu.
    const filteredReferences = references.filter((r) => !definitionSites.has(`${r.line}:${r.column}`));

    return {
      file: relativePath,
      imports,
      definitions,
      references: filteredReferences,
      importAliases,
    };
  }
}
