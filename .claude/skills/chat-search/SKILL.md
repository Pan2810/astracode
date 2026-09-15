---
name: chat-search
description: Locate files, symbols, callers, implementations, routes, tests, configuration, and execution paths relevant to a coding question. Use when the user asks where code lives, how something is implemented, or when implementation location is unknown.
argument-hint: "[query]"
context: fork
agent: code-explorer
background: false
---

Investigate:

$ARGUMENTS

Find the minimum relevant subset of the repository.

Search progressively:

1. exact identifiers
2. filenames
3. symbols
4. textual references
5. callers
6. implementations
7. tests
8. configuration

Avoid dumping large file contents.

Return:

- relevant files
- relevant symbols
- dependency/execution flow
- tests
- likely modification points