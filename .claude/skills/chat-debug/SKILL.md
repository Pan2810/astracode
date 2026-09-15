---
name: chat-debug
description: Investigate a bug, exception, failing test, or incorrect runtime behavior and identify its root cause.
argument-hint: "[bug-description]"
context: fork
agent: code-debugger
background: false
---

Debug:

$ARGUMENTS

Use an evidence-driven investigation.

Do not patch immediately.

Follow:

symptom
→ execution path
→ evidence
→ hypotheses
→ experiments
→ root cause

Search dynamically as new evidence appears.

Return:

## Root cause

## Evidence

## Execution flow

## Suggested fix

## Verification