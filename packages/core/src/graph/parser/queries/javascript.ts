/**
 * Tree-sitter query cho grammar "javascript" — KHÔNG có interface/type alias của TS.
 *
 * Viết thành hằng chuỗi TS (không phải file `.scm` rời) để `tsc` build ra
 * `dist/` như mọi module khác — không cần thêm bước copy asset riêng.
 */
export const JAVASCRIPT_QUERY = `
(import_statement source: (string) @import.source)

(import_specifier
  name: (identifier) @import.alias.original
  alias: (identifier) @import.alias.local)

(function_declaration name: (identifier) @definition.function)
(class_declaration name: (identifier) @definition.class)
(method_definition name: (property_identifier) @definition.method)

(variable_declarator
  name: (identifier) @definition.variable
  value: [(arrow_function) (function_expression)])

(identifier) @reference
(property_identifier) @reference
(shorthand_property_identifier) @reference
`;
