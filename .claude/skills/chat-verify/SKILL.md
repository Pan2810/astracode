---
name: chat-verify
description: Verify that a code change works by running diagnostics, build commands, and the smallest relevant test suite.
disable-model-invocation: true
allowed-tools: Read Grep Glob Bash
---

Verify the current code changes.

## Determine affected area

Inspect the changed files first.

Determine:

- language
- package/module
- test framework
- build system

## AstraCode commands

Map the affected package to its command:

- `packages/core` → `pnpm --filter @astra/core typecheck` then
  `pnpm --filter @astra/core test` (vitest, pure Node — tests must not hit real network;
  provider calls go through `MockProvider`)
- `packages/cli` → `pnpm --filter @astra/cli typecheck` then
  `pnpm --filter @astra/cli test`
- `packages/vscode` → build core first (`pnpm --filter @astra/core build`, typecheck
  reads its `.d.ts`), then `pnpm --filter astracode typecheck` and
  `pnpm --filter astracode test`
- `evals` → `pnpm --filter @astra/evals test` for unit tests; only run
  `pnpm eval:list` / `pnpm eval -- --model <id>` when explicitly asked (network-dependent
  eval harness, needs a real model)
- cross-cutting or unclear scope → `pnpm -r typecheck` / `pnpm -r test`

`pnpm -r test` runs 5 vitest projects in parallel; a single 5s-timeout failure in one
package is a known flaky pattern under machine load — rerun that package alone
(`pnpm --filter <pkg> test`) before reporting it as a real failure.

## Verification order

Prefer:

1. diagnostics/type checking
2. affected unit tests
3. affected integration tests
4. build
5. broader tests only when justified

Do not run expensive repository-wide tests when targeted verification is sufficient.

For every command report:

- command
- exit status
- relevant output

If a command fails:

1. determine whether failure is caused by current changes
2. identify the failing component
3. report the evidence

Do not claim success when verification was incomplete.

## Result

Return one of:

PASS

PARTIAL

FAIL

Include reasons.