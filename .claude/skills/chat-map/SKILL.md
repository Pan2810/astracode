---
name: chat-map
description: Build a concise architecture map of the code relevant to a feature, module, domain, or request.
argument-hint: "[feature-or-module]"
context: fork
agent: code-explorer
background: false
---

Create a focused architecture map for:

$ARGUMENTS

Do not map the entire repository unless explicitly requested.

Identify:

## Entry points

HTTP routes, CLI commands, jobs, events, UI actions, or other triggers.

## Core components

List:

- controllers/handlers
- services
- domain logic
- repositories
- clients
- models
- configuration
- tests

## Dependency graph

Use:

A
├── B
│   └── C
└── D

## Runtime flow

Use:

input
→ validation
→ business logic
→ persistence/external call
→ response

## Change hotspots

Identify files that are most likely to be changed for work involving this area.