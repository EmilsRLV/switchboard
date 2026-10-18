# Epic 4 Context: Running Claude in a node

<!-- Compiled from planning artifacts. Edit freely. Regenerate with compile-epic-context if planning docs change. -->

## Goal

Make the canvas able to start, resume, fork and stop Claude sessions, each running the real `claude` TUI in a PTY-backed terminal pane. The app becomes a launcher and not only an observer. Sessions it starts get an app-assigned id, so the node exists before the transcript does. Per-session Claude Code hooks become the main status channel, which makes `waiting` and `finished` accurate within a second and gives the Epic 3 glow real meaning. With this epic, Epics 1–4 form a usable "start and watch Claude sessions on a canvas" tool on Windows and Linux.

## Stories

- Story 4.1: PTY terminal pane
- Story 4.2: New session launch sheet
- Story 4.3: Hook-driven status
- Story 4.4: Resume, fork, stop
- Story 4.5: Terminal tabs and pop-out

## Requirements & Constraints

- **Terminal fidelity:** the real TUI runs unchanged. It needs 256-colour and truecolour, cursor, mouse where Claude uses it, multi-line paste (images go through Claude's own paste handling) and resize that follows the pane. Scrollback is at least 5 000 lines. A hidden terminal keeps running and loses no output. Typing latency must match a native terminal (< 16 ms added), including on webkit2gtk without WebGL.
- **Plain terminal** on any project node runs `pwsh` if present, else `powershell` (Windows), or `$SHELL` (Linux). The `shell` setting already exists.
- **Launch sheet** (`n` on a project node) has these fields: name, model (fable/opus/sonnet/haiku/custom), effort, permission mode, extra add-dirs, optional first prompt and a start-in-background toggle. Defaults come from settings `defaults { model, effort, permission_mode }`, then the project's last choices, which are remembered per project. Enter starts. `--dangerously-skip-permissions` is never chosen by the app. If offered, it is an explicit, highlighted operator choice.
- **On start**, a node appears immediately in `starting`, the terminal opens on it, and it reaches `idle` within 2 s. When the transcript later appears, discovery matches it to the same node by session id, with no duplicate.
- **Status:** a hook change shows within 1 s of the hook firing. If no hook arrives for two polls while `agents --json` says busy, the poll wins and a debug counter increments (shown in settings → diagnostics). `finished` shows the last assistant line, truncated.
- **Resume** runs `--resume <id>` in the project (or worktree) cwd with the standard app flags, and the same node becomes live. **Fork** runs `--resume <id> --fork-session --session-id <new>`; a new node appears with a thin "forked from" line to the original. **Stop** sends `/exit` + Enter if idle, otherwise Ctrl+C twice, then kills after 5 s. The node turns `exited` and stays as a historic node.
- **Tabs and pop-out:** several terminals open as tabs in one pane, switching is instant, and no tab loses output. "Pop out" moves a terminal into its own OS window, and closing that window returns the tab to the pane.
- **Never write under `~/.claude`.** Per-session `--settings` / `--mcp-config` files go in the OS temp dir and are deleted on session exit. The app's own hooks must not touch the user's hooks (settings layers merge).
- **No network calls** except localhost endpoints, which bind to 127.0.0.1 only. Each session has its own bearer token, which dies with the session.
- Budgets still apply: idle RSS < 150 MB with 3 live sessions and their terminals open, and cold start < 1 s. Both CI runners must stay green: Windows, and Linux on ubuntu-24.04 with webkit2gtk.

## Technical Decisions

- **Rust `pty/` module on `portable-pty`** (ConPTY on Windows, openpty on Linux). It spawns with cwd/env, resizes, writes, and runs a read loop that sends Tauri events `pty://<id>/data`. Output is chunked and coalesced to limit backpressure. Scrollback lives in the frontend. Each PTY sets the env `TERM=xterm-256color` and `COLORTERM=truecolor`.
- **Frontend `terminal/`:** one xterm `Terminal` per PTY, kept mounted (`display:none` when hidden). Resizes are debounced and sent through `pty_resize`. Every new action (new session, plain terminal, resume, fork, stop, pop out, tab switch) is a command registry entry with a `when` clause, dispatched through the single keydown dispatcher. Replace the existing stubs `project.newSession` ("New session…"), `project.terminal` ("Plain terminal…") and `session.attach` (a new PTY running `claude attach <id>`) with real behaviour.
- **Launch recipe (`claude/launch.rs`):** `claude --session-id <uuid v4> [--resume <id> [--fork-session]] --name <label> --model --effort --permission-mode [--add-dir …] --mcp-config <tmp>/<id>.mcp.json --settings <tmp>/<id>.settings.json --append-system-prompt "<~10 lines of node context>" [<prompt>]`, plus env `SWITCHBOARD_NODE` and `SWITCHBOARD_PORT`. `--session-id` is left out when resuming. The binary comes from settings `claude.path`. The MCP server itself arrives in Epic 7, so decide whether 4.2 writes a placeholder or leaves out `--mcp-config` until then.
- **Hooks (`claude/hooks.rs`):** an `axum` router on the app's localhost port, `POST /hooks/<token>/<event>`. Each hook command is `curl -s -X POST -H 'Content-Type: application/json' --data-binary @- <url>`, using `curl.exe` on Windows 11 and `curl` on Linux. Wire only the events the app consumes: `SessionStart`, `UserPromptSubmit`, `Notification`, `PostToolUse`, `Stop`, `SessionEnd`. Things to verify in 4.3: which `Notification` payload fields mark a permission prompt or elicitation, and whether a dedicated `PermissionRequest` event exists in 2.1.x. Q1 is still open: so far `agents --json` has only been seen reporting busy/idle.
- **State machine:** `starting → idle` (on SessionStart or first PTY output); `idle → busy` (on UserPromptSubmit or Enter typed in the PTY); `busy → waiting` (on a permission/elicitation Notification); `waiting → busy` (on PostToolUse or any busy signal); `busy → finished` (on Stop; sticky until the next input); any state `→ exited` when the process exits. Extend `claude/live.rs`: it has `SessionState { Busy, Idle, Waiting, Finished, Exited, Other }` and `StateSource { Poll, Ack }`. Add a hook source and a `Starting` state. Today `finished` is derived from a busy→idle poll transition; keep that only for sessions without hooks. Sessions stay keyed by `sessionId`. Live-only children (live sessions with no transcript yet) already exist, so an app-launched node can use that path until its transcript appears.
- **Process control:** `process.rs` has `run` and `spawn_detached` (with an ETXTBSY retry) for one-shot commands. Session processes belong to the PTY layer instead. Stop writes to the PTY, then kills the child.
- **New crates/features:** add `portable-pty` and `axum`. Tokio currently has only `time` and `sync`, so the HTTP server needs `net` and `rt`/`macros` as required. `uuid` with the v4 feature is already a dependency. Pop-out needs a second Tauri webview window and a matching capability entry.
- **Dependency versions checked 2026-10-18** (all stable, all older than two weeks): Rust `portable-pty` 0.9.0, `axum` 0.8.9. npm `@xterm/xterm` 6.0.0, `@xterm/addon-fit` 0.11.0, `@xterm/addon-webgl` 0.19.0, `@xterm/addon-search` 0.16.0, `@xterm/addon-web-links` 0.12.0, `@xterm/addon-unicode11` 0.9.0, `@xterm/addon-clipboard` 0.2.0. **`@xterm/addon-canvas` is stuck at 0.7.0 with a peer dependency on xterm ^5, so it cannot be used with xterm 6.** On 6.x the fallback when WebGL is missing or its context is lost is xterm's built-in DOM renderer. The planning docs say "canvas renderer". Either read that as the DOM fallback or pin xterm 5.5 to keep the canvas addon, and measure latency on Linux before deciding.

## UX & Interaction Patterns

- The terminal pane is a `pane` in `src/state/ui.ts`. It slides in from the right over the canvas and Esc closes it. Decide whether Esc inside a focused terminal goes to the TUI (Claude uses Esc) or closes the pane. Esc should reach Claude when the terminal has focus. Selecting a live session node opens its terminal.
- Terminal is the chat: style around it, never over it. Use `--bg-raised` and a 1-px left border, with no chrome inside the terminal area. Use mono font tokens. The xterm theme comes from the CSS tokens and is dark only.
- `starting` is a new state word in the status colour table; give it a muted treatment. The accent stays limited to `waiting`/`finished`; new terminal or tab CSS must pass the design lint's accent allow-list. Panes appear without animation, and any new motion must be added to DESIGN.md's motion table with a reduced-motion variant.
- The "forked from" link is a thin, muted line, not an accent and not an edge kind.

## Cross-Story Dependencies

- 4.1 (PTY and pane) underlies everything else. 4.2, 4.4, 4.5 and the existing `session.attach` stub all open terminals through it.
- 4.3's hooks endpoint needs 4.2's per-session `--settings` file. 4.4's Stop uses idle/busy from 4.3, falling back to the poll.
- Resume/fork depend on Epic 3 discovery for historic nodes. Running in a worktree cwd depends on Epic 5. `--add-dir` from context edges comes in Epic 6. The `--mcp-config` server comes in Epic 7, so in this epic only the launch-sheet add-dirs apply.
- 4.5 builds on 4.1's always-mounted terminals. Pop-out must hand off the same PTY stream without a restart.
