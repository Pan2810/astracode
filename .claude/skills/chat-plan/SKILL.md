---
name: chat-plan
description: Analyze a coding request and create a concrete file-level implementation plan before code changes.
argument-hint: "[task]"
context: fork
agent: code-planner
background: false
---

Create an implementation plan for:

$ARGUMENTS

First verify the relevant existing implementation.

Do not propose changes based only on filenames or assumptions.

For every proposed change specify:

- file
- symbol
- current behavior
- desired behavior
- exact modification
- dependencies
- test impact

Prefer minimal modifications.

End with:

## Implementation order

1.
2.
3.

## Verification

Commands or checks required.