export const PYTHON_QUERY = `
(import_statement name: (dotted_name) @import.source)
(import_statement
  name: (aliased_import
    name: (dotted_name) @import.alias.original
    alias: (identifier) @import.alias.local))

(import_from_statement module_name: (dotted_name) @import.source)
(import_from_statement
  name: (aliased_import
    name: (dotted_name) @import.alias.original
    alias: (identifier) @import.alias.local))

(function_definition name: (identifier) @definition.function)
(class_definition name: (identifier) @definition.class)

(identifier) @reference
`;
