# Claude Code integration surface — research notes

Verified on 2026-10-16 against Claude Code **2.1.301** on Windows 11 (`C:\Users\emils\.local\bin\claude.exe`).
Anything marked **verify** was not exercised and must be checked in the story that depends on it.

## CLI flags we rely on (from `claude --help`)

| Flag | Use in Switchboard |
|---|---|
| `--session-id <uuid>` | App-assigned id for every new session, so the node knows its transcript before launch |
| `-r, --resume <id>` / `--fork-session` | Resume / fork from a historic session node |
| `-n, --name <name>` | Display name; also how peers refer to each other via `SendMessage` |
| `--add-dir <dirs...>` | Context edges at launch |
| `-w, --worktree [name]` | "Let Claude manage the worktree" option on branch nodes |
| `--model`, `--effort`, `--permission-mode` | Launch sheet fields |
| `--mcp-config <json-or-file>` | Inject the `switchboard` MCP server (HTTP, bearer header) |
| `--settings <file-or-json>` | Inject hooks for status (`Notification`, `Stop`, `SessionStart`, `SessionEnd`, …) |
| `--append-system-prompt <text>` | Node context (up to 6 lines) and, with cooperate peers, a peer block (Story 6.4) |
| `--bg` / `claude attach` / `claude logs` / `claude stop` | Optional background start; adopting externally started sessions |
| `-p --input-format stream-json --output-format stream-json` | Headless helper runs (titles, summaries) — the "SDK underneath" |
| `--max-budget-usd` | Cap on headless helper runs |
| `--desktop`, `--cloud`, `--remote-control` | Noted; out of v1 scope |

## Live sessions: `claude agents --json --all`

Works without a TTY. Output observed:

```json
[{ "pid": 37508, "cwd": "B:\\projects\\ide", "kind": "interactive",
   "startedAt": 1792160868400, "sessionId": "e1247462-…", "name": "ide-6e", "status": "busy" }, …]
```

- `status` values seen: `busy`, `idle`. Whether a "waiting on permission" state exists here is **verify** (Q1); hooks are the primary channel regardless.
- `kind`: `interactive` seen; background sessions presumably another value — **verify**.
- Names default to `<folder>-<2 hex>`; `--name` overrides.

## Session history on disk

- Root: `~/.claude/projects/<encoded-cwd>/`. Encoding observed: `B:\projects\ide` → `B--projects-ide`, `C:\Users\emils\Documents\Novels\AI` → `C--Users-emils-Documents-Novels-AI` (`:`, `\`, `/`, ` ` → `-`). Treat as heuristic; confirm by reading `cwd` from the transcript.
- Each session: `<sessionId>.jsonl`. Record `type`s seen in one transcript: `attachment`, `assistant`, `user`, `mode`, `atis-latch`, `permission-mode`, `ai-title`, `system`, `last-prompt`, `file-history-snapshot`, `file-history-delta`.
- First `user` record fields: `parentUuid`, `isSidechain`, `promptId`, `message{role,content}`, `uuid`, `timestamp`, `permissionMode`, `origin`, `promptSource`, `turnOrigin`, `turnPosition`, `userType`, `entrypoint`, `cwd`, `sessionId`, `version`, `gitBranch`.
- `ai-title` records carry a generated title — exact field name **verify** when implementing Story 3.1.
- `.session-aliases` in a project dir: newline list of other project dirs linked to it (observed for a project that used `--add-dir`-style multi-dir work).
- `memory/` subdir holds auto-memory for that project. Do not touch.
- Also present at `~/.claude/`: `sessions/`, `session-env/`, `agents/`, `history.jsonl`, `stats-cache.json` — potential richer sources; **verify** before depending on them.

## Hooks (status channel)

Claude Code hook events include `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PermissionRequest`, `PostToolUse`, `PostToolUseFailure`, `Notification`, `Elicitation`, `Stop`, `StopFailure`, `SubagentStop`, `SessionEnd`, `PreCompact`.

Facts used by Story 4.3 (hooks reference, read 2026-10-18):
- **`http` hooks** take `{ "type": "http", "url", "headers", "timeout" }` and POST the event JSON. A 2xx with an empty body is success and changes nothing; a non-2xx, a timeout or a connection error is non-blocking by default. Switchboard therefore uses `http` hooks (no `curl` command) and always answers with an empty 200.
- **`PermissionRequest`** fires as soon as a permission dialog is about to show, with `tool_name` and `tool_input`. The `Notification` with `notification_type: "permission_prompt"` fires only after about 6 s without input. Other wired notification types: `elicitation_dialog`, `elicitation_url_dialog`, `agent_needs_input` (the `Notification` matcher matches on `notification_type`).
- **`Stop`** carries `last_assistant_message`.
- **Common fields:** every event has `session_id`, `transcript_path`, `cwd` and `hook_event_name`.

**Verified with 2.1.302** (orchestrator's GUI pass, 2026-10-18, real `claude`, Emils' consent):
- `http` hooks given through `--settings <file>` fire and reach the localhost endpoint.
- `PermissionRequest` fires as soon as the permission dialog shows. An empty 200 leaves Claude's own dialog in place; Enter in the terminal then approves.
- `Stop` carries `last_assistant_message`.
- In `manual` permission mode a read-only Bash `echo` ran without any permission request (read-only commands are auto-allowed), so a test of the waiting path needs a command that writes or is otherwise not read-only.

Not covered by that pass: `StopFailure`, `Elicitation`, the `elicitation_*` / `agent_needs_input` notification types, and Linux.

## MCP

`--mcp-config` accepts a JSON string or file with `{"mcpServers": {"<name>": {"type": "http", "url": "...", "headers": {...}}}}`. Streamable HTTP is supported for remote servers. **verify** in Story 7.1 that CLI-supplied HTTP servers need no interactive trust prompt (expected: `--mcp-config` is trusted).

Rust MCP server crate: `rmcp` (official `modelcontextprotocol/rust-sdk`), streamable-HTTP transport feature. Confirm current version at implementation time.

## Native session-to-session messaging

Claude Code's `ListAgents` tool lists "other local Claude sessions on this machine" and `SendMessage` can address them by name. This is the preferred cooperation channel (Story 6.4); the `switchboard` inbox is the structured fallback (Epic 7). **verify** delivery semantics when the target is busy vs idle.

Story 6.4 relies on it: a session started from Switchboard (Resume; New has no edges yet; a fork inherits
none) gets its cooperate peers in `--append-system-prompt` (`Peer sessions (cooperate edges):`, then
`- "<name>" (<node path>): <purpose>` per peer, at most 5 and `- … and N more`, then `Prefer SendMessage
to a peer by its name to coordinate.`), and an idle live session is sent one line when it is linked:
`A new peer session "<name>" is linked to you (<purpose>). Use SendMessage to coordinate.` + Enter. That
line is a user prompt, so the session going busy within 3 s confirms it was taken. Until Epic 7 only
`SendMessage` is named, never the MCP `send`/`inbox`.

**Pending, by hand with the real `claude` (Emils):** session A sends `SendMessage` to B by name while B is
idle; record whether it is delivered. If it is not, Story 7.3's inbox nudge becomes the primary channel.

## Slash commands used by injection

- `/add-dir <path>` — injected by Story 6.3 into an idle Switchboard session for a context edge drawn from it:
  exactly one line, `/add-dir <path>` and Enter, never over an unsent draft and never with a control character
  in the path. It is a local command: no assistant turn, so busy/idle cycles say nothing. **Detection:** the
  transcript gets a `<local-command-stdout>` record (`Added <path> as a working directory…`, or `… already
  accessible …`), which Rust tails (read-only) for 10 s after the line; any other stdout is a failure, no record
  is `not confirmed` (a choice dialog included). **Verify** with the real `claude` (Emils): that the record
  appears as expected, and whether a choice dialog shows. **No `/remove-dir`:** deleting an edge cannot take a
  folder away from a running session; it stays until the session restarts. "Restart with flags" (stop, then
  `--resume <id> --add-dir …`) is the fallback.
- The peer line (Story 6.4) — not a slash command: one plain user prompt naming a newly linked peer, written
  under the same rules as `/add-dir` (idle, no draft, one injection per session at a time, control
  characters stripped from the name and the label, each cut to 120 characters). **Detection:** busy within
  3 s of the write (`notified`), else `failed (not confirmed)`.
- `/exit` — used by Stop (Story 4.4).

## Agent SDK note

`@anthropic-ai/claude-agent-sdk` 0.3.301 exists and tracks the CLI version. The architecture spawns `claude -p` from Rust instead of embedding the SDK (A3); if a Node sidecar is ever added, the SDK is the thing to use. Docs: https://code.claude.com/docs/en/agent-sdk

## Tooling present on the dev machine

Rust/cargo 1.94.0 · Node 25.8.0 · `@tauri-apps/cli` 2.12.3 (npm latest) · `electron` 44.8.0 (not used) · `curl.exe` (Windows 11 built-in) · BMAD v6.12.0 installed in `B:\projects\map-maker\_bmad` (reference for conventions).
