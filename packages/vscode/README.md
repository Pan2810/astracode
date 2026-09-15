# AstraCode

A coding agent for VS Code, running on FPT Cloud models through the AstraWork gateway.

## Install

```powershell
code --install-extension astracode.vsix
```

Then open the **AstraCode** icon in the activity bar.

## Two icons, two toggles

AstraCode contributes **two** containers, so you get two independent toggle icons in the activity bar:

| Icon | Used for |
|---|---|
| **AstraCode** | Primary side bar (left) |
| **AstraCode (right)** | Secondary side bar (right) |

Both share a single provider, so they are **always in the same state** — change the model on one side and the other updates immediately.

### Putting it in the same tab row as Claude Code

The goal: AstraCode sitting in the same row as `CHAT` / `CLAUDE CODE` in the right-hand side bar.

**The quick way** — right-click the AstraCode view title and choose VS Code's own **Move View**, then pick **Secondary Side Bar**.

**The reliable way** — drag the **AstraCode (right)** icon out of the left activity bar and drop it into that tab row. If you cannot see the right-hand bar, open it with `Ctrl+Alt+B`.

You only do this once; VS Code remembers it for good, including across restarts.

**Why this is not fully automatic:** VS Code exposes no API for an extension to place a view in the secondary side bar — panel placement is the user's call. That is a platform limit that applies to every extension. The command above only opens the destination picker and points the way.

### Title bar buttons

Just two buttons, for the two things you do every day:

| Button | Action |
|---|---|
| `+` | New chat |
| `⟲` | Chat history |

Nothing else sits up there — settings has its own gear button next to the composer, and `AstraCode: Show logs` is in the Command Palette.

### Or open it as a tab

`AstraCode: Open chat` turns the interface into a real editor tab next to your code. That path does not depend on side bar layout, so it always works.

## Permissions — what decides how far the agent can go

Three modes, switched from the picker below the chat box or with `AstraCode: Change permission mode`:

| Mode | What the agent may do |
|---|---|
| **Plan** | Read only. Every tool with a side effect is blocked **in the core layer** — not a hidden button, but no code path at all. |
| **Ask before editing** (default) | Approve each write, with the full diff attached. |
| **Auto-approve edits** | Edits files without asking. **Shell commands still always require approval.** |

Two constraints no setting can turn off:

- **`bash` is never auto-approved.** It lives in `PermissionManager.ALWAYS_ASK` in core. The "always allow" button does not even appear for it — two `bash` calls with the same name can do two completely different things.
- **Trust-based permission downgrade.** Once the agent reads content showing signs of prompt injection, the session falls back to "ask before editing" even if auto-approve was on, and every remembered permission is cleared. That is the cut in the chain *read hostile content → automatically write files as that content says*. Only you can lift it, by picking a mode again.

"Always allow" is scoped to the **directory containing the file**, not the whole workspace: approving an edit to `src/api/user.ts` does not carry over to `.github/workflows`.

## Tracking changes

Every file the agent touches goes into the **session change log**, visible in three places at once:

| Where | What you see |
|---|---|
| Explorer | `A`/`M`/`D` badges and colors, like git status |
| Editor | Added lines highlighted, deleted lines marked in the gutter |
| **Session changes** view | The full list, each row with View diff / Accept / Discard |

The diff is against **the original content from before the agent touched the file**, not against what is on disk — the log keeps its own copy of the original, so it stays correct even after the file has been overwritten several times.

Edits are applied through `WorkspaceEdit`, not `fs.writeFile`. That buys three things: **Ctrl+Z undoes them**, unsaved work you are in the middle of typing is not overwritten, and the editor sees the change right away.

## Running commands

Commands run directly on your machine by default. Change it with `astra.sandbox`:

| Value | Meaning |
|---|---|
| `host` (default) | Runs **directly on your machine**. No isolation. Every command has exactly your privileges. |
| `docker` | Runs in a container configured by the repo's `sandbox/` directory: no network, read-only rootfs, all capabilities dropped, only the workspace mounted |
| `off` | No command-running tool at all |

**AstraCode never silently falls back from `docker` to `host`.** If Docker cannot run, the bash tool disappears along with the reason — rather than commands still running, just without the isolation layer and without anyone saying so.

In `host` mode the chat shows a persistent warning banner, not a one-time notice.

Paths are translated both ways, `C:\Work\repo` ↔ `/workspace`, in the commands sent in and in the output coming back. Without that the model sees unfamiliar paths in the output and goes off editing the wrong file.

## Memory and long sessions

**`ASTRA.md`** — project notes, loaded into the prompt on every turn. Type `/memory <rule>` in the chat to append one, `/memory` on its own to open the file, or use *AstraCode: Edit the project ASTRA.md*. Keep one at `~/.astra/ASTRA.md` for personal notes shared across every repo.

A rule you only say in the chat lives in that conversation and nothing more — `/clear`, a new chat, or a compaction that swallows it, and the agent no longer knows. `/memory` is what makes it survive.

Keep it short. Every line here costs context on **every** later question. A file from the repo is capped at 12k characters and scanned for prompt-injection signals — it carries as much weight as the system's own words, so you need to know when it holds something suspect.

**Context** — the gauge appears from 70%. At 85% the conversation compacts itself: the most recent turns stay verbatim, the earlier part becomes a summary (goal / what was learned / what changed / what is left). Turn it off with `astra.autoCompact`, and run `/compact` yourself instead.

`/compact` takes a note: `/compact keep the details on PermissionManager` tells the summariser what to write out in full. It only ever adds emphasis — the four sections are always written, so naming one area never silently drops the rest.

**`/undo`** — returns files to their state **before the last turn**, not before the whole session. It survives restarts: the snapshots live in `~/.astra/file-history/`, so reopening a conversation from last week still lets you undo its last turn — with a confirmation, because the files on disk have moved on since then. It cannot restore files written by a `bash` command: the sandbox writes straight into the workspace, outside the reach of the change-tracking layer.

**Sessions** — saved automatically after each turn, outside the repo. The chat panel title bar has exactly two buttons for this:

| Button | Action |
|---|---|
| `+` | New chat — clears the open conversation and starts a new session (granted permissions and undo history reset with it) |
| `⟲` | Chat history — a list panel over the chat; click a row to reopen it |

The same actions are available from the Command Palette (*AstraCode: New chat* / *AstraCode: Chat history* / *AstraCode: Reopen a past session*) or `/sessions`.

Up arrow in an empty composer walks back through prompts you have already sent, including those typed in the `astracode` CLI — one history, both surfaces.

The list only shows sessions from **the folder you currently have open**, and a conversation is only saved after its first answer.

## Slash commands

Type `/` in the input box to pick one.

| Command | Action |
|---|---|
| `/undo` | Undo the files the agent edited in the last turn |
| `/compact` | Compact the conversation now — add a note (`/compact keep the auth work`) to say what must stay detailed |
| `/clear` | Clear the conversation and start a new session |
| `/sessions` | List past sessions |
| `/memory` | Save a project rule to `ASTRA.md`, or open the file to edit it |
| `/help` | Reload and list the commands |

Your own commands go in `~/.astra/commands/<name>.md`:

```markdown
---
name: review
description: Review the current diff
---
Read the diff on this branch and point out real bugs, skipping style questions.
Focus on $ARGUMENTS.
```

`$ARGUMENTS` receives everything typed after the command name, `$1`…`$9` receive individual words. With no placeholder at all, the arguments are appended at the end.

Commands from the repo (`.astra/commands/`) **only run in a trusted workspace**, and carry a *from the repo* label in the suggestion list — those are prompts written by someone else.

## Verifying after an edit

`astra.verifyCommand` runs after every agent turn that changed files. It needs `astra.sandbox` enabled.

```jsonc
// USER settings.json, not the workspace one
"astra.verifyCommand": "pnpm test"
```

On failure the output is fed back into the conversation so the agent can keep fixing. On success nothing is added to the context.

A value set in the repo's `.vscode/settings.json` is **ignored**, with a notice. That command comes from anyone who can open a PR against the repo — running it automatically would hand execution rights to a directory just because you opened it.

## Configuration

Everything below lives in a **settings popup inside the chat panel** — the gear button next to the attach button, or `AstraCode: Open settings`. It opens over the conversation instead of replacing it, so changing a model does not cost you the question you were in the middle of. Close it with Esc, the ✕, or a click outside. There is no separate "Settings" view: one settings surface, so there are never two panels disagreeing with each other.

The popup has four groups: **Account** · **Models** · **Usage** · **Preferences**.

**Chat is blocked until you sign in.** AstraCode's models come from your AstraWork account and **from no other source**, so "not signed in" is not a limited-use state — it is a not-usable state. The panel shows the sign-in gate instead of an input box that would swallow whatever you typed.

**1. Sign in**

Click *Sign in to AstraWork* → the browser opens `<AstraWork web address>/login`. If you are already signed in to Microsoft there, you re-enter nothing — you just paste that session's access token back into VS Code. The extension accepts both an access token (JWT) and a one-time SSO sign-in code.

The token is stored in VS Code SecretStorage (encrypted by the operating system), never written to `settings.json`.

AstraWork issues no refresh token, so an expired session means signing in again — that is the gateway's design, not a gap in the extension.

**2. Pick a model**

The model list, per-model access and quotas all come from the account you signed in with. One picker, one model — it handles everything: planning, edits, titles and summaries. Capabilities of every model in the list — tool calling, context window, injection resistance — sit behind the collapsed row under the picker.

**3. Server addresses** — nothing to do

The AstraWork gateway and web addresses are built into the extension. There is no setting for them, and a fresh install talks to the right place without being told. `AstraCode: Test connection` in the Command Palette checks that the address in the build answers with your account's models.

## Capability profile

The model table shows `tool calling`, `context`, `injection resistance` — the endpoint does not provide any of that. It comes from `models.json` (the capability profile), generated by `astracode measure`.

**You do not need to measure anything to get started.** A model missing from that file runs on assumed capabilities — native tool calling, image input, context window taken from the gateway's model list. If an assumption is wrong, the first turn stumbles, AstraCode switches to the XML path and remembers it, with a one-line notice.

Measuring only matters when you want to know a model's **prompt-injection resistance** before giving it the `editor` role (write access) — that is the one thing that cannot be probed at runtime, so until it is measured it reads `unknown`, not `low`.

## Where AstraCode keeps things: `~/.astra`

Shared with the `astracode` CLI, so a model measured in the terminal is known in the IDE and a conversation started in one is listed in the other. Nothing here belongs to a single repo — project configuration lives in `.astra/` inside the repo itself.

| Path | What is in it |
|---|---|
| `settings.json` | Your settings. Safe to copy to another machine — no secrets in it |
| `settings.local.json` | Overrides for this machine only (CLI) |
| `credentials.json` | The AstraWork token, `0600`. In VS Code the token lives in SecretStorage instead |
| `state.json` + `backups/` | Written by the app, not by you: startup count, when each repo was last used |
| `models.json` | Capability profile from `astracode measure` |
| `projects/<repo>/` | Chat sessions, one directory per repo |
| `file-history/<session>/` | The file snapshots `/undo` restores from |
| `history.jsonl` | Every prompt you have typed, for up-arrow recall |
| `cache/`, `.last-cleanup` | Disposable. Cleaned once a day |
| `commands/`, `skills/`, `agents/` | Your own slash commands, skills and sub-agents |

Point `ASTRA_HOME` somewhere else to move the whole directory.

## Settings in settings.json

| Key | Default |
|---|---|
| `astra.model` | the coding model AstraCode ships with — edits, commands, titles and summaries |
| `astra.planModel` | the planning model AstraCode ships with — images, and everything while plan mode is on |
| `astra.permissionMode` | `ask` |
| `astra.sandbox` | `host` |
| `astra.sandbox.network` | `none` |
| `astra.sandbox.dir` | `sandbox` |
| `astra.autoCompact` | `true` |
| `astra.verifyCommand` | `""` (read from user settings only) |
| `astra.logLevel` | `info` |

Logs: `AstraCode: Show logs` in the Command Palette. Everything logged has already passed through the secret redactor.
