/** CodeGraph — mốc M12. Symbol table + dependency graph, tree-sitter (WASM) trong core. */
export { CodeGraph } from './CodeGraph.js';
export { GraphBuilder, DEFAULT_MAX_GRAPH_FILES, resolveImportPath } from './GraphBuilder.js';
export { GraphCache, GRAPH_SCHEMA_VERSION } from './GraphCache.js';
export type {
  CodeGraphProvider,
  DefinitionKind,
  GraphSnapshot,
  ParsedFile,
  SymbolDefinition,
  SymbolLocation,
} from './types.js';
export {
  TreeSitterParser,
  languageForFile,
  GRAMMAR_WASM_FILENAMES,
  RUNTIME_WASM_FILENAME,
} from './parser/TreeSitterParser.js';
export type { LanguageId, TreeSitterParserOptions } from './parser/TreeSitterParser.js';
