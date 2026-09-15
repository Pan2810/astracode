---
name: chat-review
description: Independently review the current working tree changes for correctness, regressions, security issues, and missing tests.
context: fork
agent: code-reviewer
background: false
---

Review the current implementation changes.

Start by examining the git diff.

Then inspect enough surrounding code to understand:

- affected contracts
- callers
- data flow
- tests

Focus on real defects.

Do not report style-only comments unless they materially affect maintainability.

Prioritize:

Critical
High
Medium
Low

For every finding include:

- file
- location
- problem
- failing scenario
- recommendation

If there are no meaningful problems say:

"No blocking issues found."