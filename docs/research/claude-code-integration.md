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
| `--append-system-prompt <text>` | ~10-line node/peer context |
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

Claude Code's `ListAgents` tool lists "other local Claude sessions on this machine" and `SendMessage` can address them by name. This is the preferred cooperation channel (Story 6.4); the `switchboard` inbox is the structured fallback. **verify** delivery semantics when the target is busy vs idle.

## Slash commands used by injection

- `/add-dir <path>` — expected to exist in interactive mode; **verify** in Story 6.3.
- `/exit` — used by Stop (Story 4.4).

## Agent SDK note

`@anthropic-ai/claude-agent-sdk` 0.3.301 exists and tracks the CLI version. The architecture spawns `claude -p` from Rust instead of embedding the SDK (A3); if a Node sidecar is ever added, the SDK is the thing to use. Docs: https://code.claude.com/docs/en/agent-sdk

## Tooling present on the dev machine

Rust/cargo 1.94.0 · Node 25.8.0 · `@tauri-apps/cli` 2.12.3 (npm latest) · `electron` 44.8.0 (not used) · `curl.exe` (Windows 11 built-in) · BMAD v6.12.0 installed in `B:\projects\map-maker\_bmad` (reference for conventions).
