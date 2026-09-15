/** Dùng chung cho grammar "typescript" và "tsx" — cùng tên node/field cần bắt ở đây. */
export const TYPESCRIPT_QUERY = `
(import_statement source: (string) @import.source)

(import_specifier
  name: (identifier) @import.alias.original
  alias: (identifier) @import.alias.local)

(function_declaration name: (identifier) @definition.function)
(class_declaration name: (type_identifier) @definition.class)
(method_definition name: (property_identifier) @definition.method)
(interface_declaration name: (type_identifier) @definition.interface)
(type_alias_declaration name: (type_identifier) @definition.type)

(variable_declarator
  name: (identifier) @definition.variable
  value: [(arrow_function) (function_expression)])

(identifier) @reference
(type_identifier) @reference
(property_identifier) @reference
(shorthand_property_identifier) @reference
`;
