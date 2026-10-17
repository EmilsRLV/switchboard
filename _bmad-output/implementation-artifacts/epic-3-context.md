# Epic 3 Context: Seeing Claude's sessions

<!-- Compiled from planning artifacts. Edit freely. Regenerate with compile-epic-context if planning docs change. -->

## Goal

Fill the project nodes built in Epic 2 with real session children drawn from Claude's own records: past sessions read from the transcript store, live sessions (including ones started from a plain terminal) found by polling `claude agents --json --all`, and an ambient attention signal (accent state, parent glow, optional OS toast) when a session is `waiting` or `finished`. This makes the canvas a true overview before the app can launch anything itself (Epic 4). The stub children and the constant-0 live badge from Epic 2 are replaced here.

## Stories

- Story 3.1: Historic sessions from transcripts
- Story 3.2: Live sessions and status
- Story 3.3: Status glow and notifications

## Requirements & Constraints

- Historic sessions per project show title, last-active time, `gitBranch` and message count. Only the ten most recent show by default; "show all" reveals the rest. Title comes from the title record, otherwise the first prompt cut to 60 chars.
- Session states are `starting`, `busy`, `idle`, `waiting`, `finished`, `exited`. In this epic only `agents --json` is available, and it has only been seen reporting `busy`/`idle`. Check whether it ever reports waiting (open question Q1). Hooks become the main source in Epic 4.
- A status change must be visible within one poll interval (default 2 s, `poll.agents_ms` in settings).
- A live row whose `cwd` matches a project node marks that session busy/idle and adds to the project's live badge. A row with an unknown cwd goes to an "Elsewhere" tray and is never dropped. When a row disappears, its node turns `exited` and stays as a historic node.
- A live session the app did not start is read-only: selecting it offers "Attach in terminal" (`claude attach <id>` in a new PTY), not a terminal.
- `waiting`/`finished` puts the session node in the accent state, and a collapsed parent glows. Selecting the node clears the glow. OS notifications for `waiting` (and `finished`) can be turned on or off per kind. Clicking one focuses the window and selects the node.
- **Never write anything under `~/.claude`.** Read transcripts only. Do not read credentials or settings files that hold secrets, and do not touch `memory/`.
- Degrade gracefully. Skip unknown transcript record types, and the session still appears. If `agents --json` fails to parse, fall back to process-level status. Show a CLI version mismatch as a message; it must not stop the app.
- Budgets still apply: cold start < 1 s, idle RSS < 150 MB. No network calls.

## Technical Decisions

- **Discovery lives in `src-tauri/src/claude/discover.rs`.** It already lists project dirs read-only and reads the first `user` record's `cwd`. Extend it to parse the whole transcript. The first `user` record holds `cwd`, `gitBranch`, `sessionId`, `timestamp` and `version`. `ai-title`/custom-title records give labels; the exact field name has not been checked yet. Read `.session-aliases`, a list of linked project dirs. Cache by mtime and refresh on fs events (`notify`) or timers. Keep parsing tolerant and test it against fixture files.
- **Project-dir encoding is a heuristic** (`:`, `\`, `/`, space → `-`). Always confirm the match against the transcript's `cwd`.
- **Live rows** have the shape `{pid, cwd, kind, startedAt, sessionId, name, status}`. `kind: interactive` has been seen; background sessions probably use a different value, which has not been checked. Run the poll from Rust with `tokio::process`, using the `claude` binary from settings.
- **Live state is never persisted.** Discovery results and statuses stay in memory. Push them to the frontend as `live://session/<id>` events, mirrored into a separate `live` Zustand store next to `workspace` and `ui`.
- **Schema:** `SessionRef { sessionId, projectId, branchId, label, pinned, position }` is already in the v1 workspace schema. It stores only what the operator chose (pins, labels, positions); discovery supplies the rest. No migration is needed.
- **Children:** `graph::children` builds a child list that does not depend on node type and is carried on the workspace snapshot. Replace the `SWITCHBOARD_STUB_CHILDREN` stubs with real sessions there. Children are ordered live first, then pinned, then most recent.
- **Status machine** (full form arrives with hooks in Epic 4): `busy`/`idle` from the poll, `exited` when the row disappears. Later hook signals take priority over the poll, and the poll wins if no hook has been seen for more than 2 polls. Design the state type so Epic 4 can add hook inputs without rewriting it.
- **Worktree sessions:** a transcript whose `cwd` is under a worktree path the project has belongs under that branch node (`branchId`), not the project root. Full behaviour comes in Story 5.4.
- **OS toasts need a notification plugin.** None is registered yet. Notification toggles are new settings keys. Settings parsing is tolerant, so missing keys fall back to defaults.
- **Tests:** keep `cargo test`, `clippy -D warnings`, `tsc --noEmit`, the design lint and both CI runners (Windows and Linux) green. Paths in fixtures must work on both.

## UX & Interaction Patterns

- Session nodes use the existing 208 × 40 child card: the label (title) on the left, the detail on the right (mono, `--fg-muted`, e.g. time, branch or message count).
- Session state colours are already set: `busy` is `--fg` with a 1-px pulse; `idle` and `exited` are `--fg-muted`; `waiting` and `finished` use `--accent`. The accent allow-list (and the design lint) must be widened to cover `waiting`/`finished` selectors. Nothing else on the canvas may use the accent.
- The project card's `N live` badge appears only when the count is above 0, styled like the count badge.
- The busy pulse and parent glow are new motions. Add them to the motion table in `docs/DESIGN.md`, and make both instant or static under `prefers-reduced-motion`.
- Status is ambient: colour and pulse, never a modal. A selected node keeps its `--focus` outline, not the accent.
- "Show all", "Attach in terminal" and the toast's select-node action are registered commands (palette + menu) with `when` clauses.

## Cross-Story Dependencies

- 3.1 replaces Epic 2's stub children and is the base for 3.2: live rows attach to discovered session nodes by `sessionId`, and live sessions with no transcript yet still need a node.
- 3.2 makes the live badge real and feeds the states that 3.3 reacts to. 3.3 is only partly testable until hooks (Story 4.3) produce real `waiting`/`finished`.
- "Attach in terminal" needs the PTY pane from Story 4.1. Until then, show it as a stub action (a notice).
- Epic 4 will match app-launched sessions to discovered transcripts by app-assigned session id, with no duplicate nodes. Keep node identity keyed by `sessionId`.
- Branch placement (3.1, third criterion) depends on branch nodes from Epic 5.
