# AI Coding Agent Rules

## Repository map

AstraCode: a VS Code coding-agent extension + CLI, pnpm monorepo with `packages/core`
(agent loop, tools, security, provider, mcp — **zero** `vscode` import, pure-Node
vitest), `packages/cli` (`astracode` terminal client reusing core), `packages/vscode`
(extension host + webview), `evals` (quality harness), `sandbox` (Docker configs for
bash/MCP), `documents` (architecture, technical flows, security threat model, roadmap,
open issues, test plan, ADRs). `code-explorer` carries
a concept → file map — use it instead of guessing paths from filenames.

Two invariants override any other instruction below: `packages/core` never imports
`vscode`, and exec-style tools (`bash`/`python`/`install_package`) are never
auto-approvable under any permission mode. `code-implementer` and `code-reviewer` carry
the full invariant list — check it before editing or reviewing security/permission code.

## Core behavior

For coding tasks:

1. Understand the request.
2. Search before assuming.
3. Read the minimum relevant code.
4. Build a mental model of the execution path.
5. Plan multi-file changes.
6. Make minimal edits.
7. Verify.
8. Review the diff.
9. Report clearly.

## Repository exploration

Never assume a file implements behavior based only on its name.

Locate behavior using:

- exact identifiers
- semantic concepts
- references
- callers
- tests
- configuration

Start broad and progressively narrow.

Avoid reading unrelated large files.

## Editing

Before editing a symbol understand:

- its responsibility
- callers
- dependencies
- expected behavior
- tests

Prefer minimal patches.

Do not:

- rewrite files unnecessarily
- refactor unrelated code
- add abstractions without need
- silently change public contracts

## Tool usage

Use tools instead of guessing when repository evidence can answer the question.

Search first.

Read second.

Edit only after sufficient context exists.

## Subagents

Use `code-explorer` when repository investigation would produce substantial search/file context.

Use `code-planner` for complex multi-file changes.

Use `code-debugger` for unclear runtime failures.

Use `code-reviewer` after significant changes.

Keep the main conversation focused on:

- user intent
- decisions
- implementation result
- unresolved issues