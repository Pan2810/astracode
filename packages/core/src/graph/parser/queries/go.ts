export const GO_QUERY = `
(import_spec path: (interpreted_string_literal) @import.source)

(function_declaration name: (identifier) @definition.function)
(method_declaration name: (field_identifier) @definition.method)
(type_spec name: (type_identifier) @definition.type)

(identifier) @reference
(field_identifier) @reference
(type_identifier) @reference
(package_identifier) @reference
`;
