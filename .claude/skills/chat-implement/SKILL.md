---
name: chat-implement
description: Implement a coding task using repository context, minimal edits, tests, diagnostics, and diff verification.
argument-hint: "[task]"
disable-model-invocation: true
allowed-tools: Read Grep Glob Edit Write Bash
---

Implement:

$ARGUMENTS

Follow this workflow.

## 1. Understand

Before editing:

- locate implementation
- inspect relevant symbols
- inspect callers
- inspect related tests

If the implementation location is unclear, explore first.

## 2. Define scope

Identify the minimum files necessary.

Do not modify unrelated files.

## 3. Edit

Prefer localized edits.

Preserve:

- project architecture
- code style
- public contracts
- existing patterns

## AstraCode guardrails

- `packages/core` never imports `vscode`; `node:fs` only under `core/src/fs/**`;
  `child_process` only under `core/src/sandbox/**` — eslint fails the build otherwise.
- `bash`/`python`/`install_package` must stay always-ask; never make them
  auto-approvable.
- Tool results stay `untrusted` and injection-scanned before entering history; org
  policy merges only tighten, never loosen; subagents stay read-only and can't spawn
  further subagents.
- English for anything the user reads in the IDE (manifest, webview, tool summaries,
  permission dialogs, mode labels); Vietnamese for comments/docs/commit messages/test
  `describe`/`it` names; `packages/core/src/prompts/` and `packages/cli` stay Vietnamese.
- `packages/vscode/package.json`: no comments inside `contributes.configuration.properties`;
  every `registerCommand` needs a matching `contributes.commands` entry; never add a
  settings key for the AstraWork address (it's a constant in `core/config/endpoints.ts`).
- Version number lives only in `packages/vscode/package.json` — never hand-type a
  version into README prose.

## 4. Validate

Run the narrowest relevant, mapped to the changed package:

- core: `pnpm --filter @astra/core typecheck && pnpm --filter @astra/core test`
- cli: `pnpm --filter @astra/cli typecheck && pnpm --filter @astra/cli test`
- vscode: `pnpm --filter @astra/core build` first (typecheck reads its `.d.ts`), then
  `pnpm --filter astracode typecheck && pnpm --filter astracode test`
- whole repo: `pnpm -r typecheck` / `pnpm -r test` — a lone timeout in one of the 5
  parallel projects is often machine load; rerun that package alone before treating it
  as a real failure.

## 5. Inspect diff

Review all changed lines.

Look for:

- accidental changes
- unused imports
- missing error handling
- incompatible API changes
- missing tests

## 6. Report

Return:

### Changed
### Tests
### Verification
### Remaining issues