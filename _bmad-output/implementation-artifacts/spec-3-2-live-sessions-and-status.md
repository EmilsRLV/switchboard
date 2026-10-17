---
title: 'Story 3.2: Live sessions and status'
type: 'feature'
created: '2026-10-18'
status: 'in-review'
route: 'dispatch'
review_loop_iteration: 0
baseline_commit: '23c52e0575c2a08cad9dc3b5bccc2deba860c8e6'
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-3-context.md'
  - '{project-root}/docs/DESIGN.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The canvas lists past sessions but cannot tell which ones are running right now, or whether they are working or waiting. It doesn't see sessions started from a plain terminal, or sessions in folders that aren't on the canvas. The live badge on project cards is still a constant 0.

**Approach:**
- **Poll.** Rust polls `claude agents --json --all` every `poll.agents_ms` (default 2 s) using the detected `claude` binary. It parses the rows tolerantly and keeps an in-memory **live map** keyed by session id.
- **Live state on cards.** Each row whose `cwd` matches a project is attached to that project's session child by `sessionId`. A live session with no transcript yet gets its own child, so it shows at once. The card shows its state (`busy` with a pulse, `idle`), and the project badge counts live sessions.
- **Elsewhere tray.** Rows whose `cwd` matches no project go to an **Elsewhere** tray on the canvas. Each row can be added as a project with one action.
- **Exited sessions.** A session that drops out of the poll turns **exited** and stays on the canvas as a historic node.
- **Attach.** Selecting a live session offers **Attach in terminal** in its context menu and the palette. The app started none of these sessions, so all are read-only. Attach is a stub until the terminal pane of Story 4.1.

**Decisions (recorded):**
- **Rows and polling:**
  - A row is `{ pid, cwd, kind, startedAt (epoch ms), sessionId, name, status }`, verified on Claude Code 2.1.302. Unknown fields are ignored. A row without a `sessionId` or `cwd` is skipped.
  - `status`: `busy` and `idle` map to those states. Any other string is kept verbatim as an unrecognised state and shown muted. It is never dropped; `--all` can include completed background sessions whose status is unverified.
  - The poll runs on a blocking thread through `process::run` with a 5 s timeout. The interval is re-read each tick, with a floor of 500 ms. It does not run while the claude binary is not `found`.
- **The session state type** is `SessionState { Busy, Idle, Waiting, Finished, Exited, Other(raw) }`, with its `source` (`poll`).
  - `Waiting` and `Finished` exist now but only hooks (Story 4.3) set them. The poll never produces them, so Epic 4 adds a source without reshaping the type.
  - A session is **exited** when it was in the live map earlier this run and is missing from a successful poll.
  - Exited sessions are remembered in memory until the app quits; nothing is persisted.
  - A session that reappears in the poll becomes live again.
- **Poll failure:** a spawn error, a non-zero exit, a timeout or unparsable output keeps the last live map, so no session flips to exited on one failed poll. After three failures in a row a `claude.agents` status banner reads "live session status unavailable: <cause>". It clears on the next success.
- **Matching:**
  - A row belongs to the project whose path equals its `cwd` (`graph::same_path`).
  - Inside a project, a row attaches to the discovered session with the same id. If there is none, it adds a **live-only child**, labelled with the row's `name` or "new session", with `startedAt` from the row. That child is replaced by the transcript summary once Story 3.1's pass finds one.
  - A row whose `cwd` is inside a project branch's `worktreePath` follows Story 3.1's worktree rule.
- **Order:** live sessions (busy, idle or unrecognised) come first, then pinned, then `startedAt` descending, as decided in 3.1. Exited sessions sort as historic.
- **Transport:**
  - A change to which sessions are live, or to which project they belong, changes the child list. It goes out as a workspace snapshot: new revision, `workspace://changed`, no file write.
  - A state-only change (busy ↔ idle) goes out as a separate `sessions://live` event carrying `{ sessions: { [id]: { state, pid, kind, name, project_id|null } }, elsewhere: [...] }`. A `live_sessions_get` command returns the same, and the frontend mirrors it into a new `live` store. A status flip therefore never bumps the workspace revision.
- **Badge:** a project's live badge counts its sessions in a live state (busy, idle, or unrecognised; not exited). It replaces `LIVE_SESSIONS = 0` and is hidden at 0, as before.
- **Session card:** the meta line starts with the state word when the session is live or exited, as in `busy · master · 12 msgs · now` and `exited · …`. The word is styled as follows:
  - `busy` is drawn in `--fg`, with a 1-px dot before it that pulses at 1.2 s, ease-in-out, opacity 1 → 0.35; the dot is static under reduced motion;
  - `idle`, `exited` and unrecognised states are drawn in `--fg-muted`;
  - historic sessions show no state word;
  - no accent anywhere.

  DESIGN.md adds the pulse to its motion list as a fourth motion.
- **Elsewhere tray:**
  - A chip at the bottom-left of the canvas reads `elsewhere N` and appears only when N > 0. Clicking it, or the `elsewhere.toggle` command, opens a list above it with one row per session: state word, name, shortened cwd, and an **Add folder** button.
  - Add folder runs the existing `workspace_add_projects` for that cwd at the view centre. The row then leaves the tray on the next poll.
  - Esc closes the list, with the same precedence as the menu.
  - Tokens only; the list is a `--bg-raised` box with a 1-px border.
- **Attach:**
  - `session.attach` ("Attach in terminal") is enabled when the selected node is a session in a live state. It appears in the palette and, through `menu: "node"` with `menuOrder: 10`, in the menu of a right-clicked live session child. Child cards get a context menu for this; the menu lists only enabled entries, so a historic session shows none.
  - Its run shows the notice "Attach arrives in Epic 4 (claude attach <id>)".

## Boundaries & Constraints

**Always:**
- Nothing is written under `~/.claude`; the poll only runs the CLI read-only.
- The poll never blocks the UI thread or the workspace lock during I/O.
- Live state is never persisted.
- Sessions are keyed by `sessionId`.
- Every action is a registry command with a `when` clause.
- Tokens only; the accent appears on nothing in this story; the design lint stays green.
- Both CI runners stay green, and the tests use a script fixture as the `claude` binary.

**Never:**
- Launching, resuming, attaching or killing a session (Epic 4).
- Hooks, `waiting`/`finished` from the poll, the status glow or OS toasts (Story 3.3).
- Process-table scanning as a status source.
- Persisting the Elsewhere list.
- Changing Story 3.1's transcript rules or the card size.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|---|---|---|---|
| Live on canvas | row `{cwd: B:\projects\ide, status: busy, sessionId: S}`, S has a transcript | S's card shows `busy` with the pulse, sorts first; `ide` badge `1 live` | — |
| Status flip | next poll S `idle` | card shows `idle` (muted), no pulse; no workspace revision bump | — |
| New session | row for `ide` whose id has no transcript yet | a live-only child appears at once labelled by `name`; later replaced by the transcript summary | — |
| Exit | S missing from a successful poll | card shows `exited`, badge drops, S stays as a historic child | — |
| Comes back | S reappears | live again | — |
| Elsewhere | row with cwd `C:\work\other` (no project) | chip `elsewhere 1`; list row with state, name, path, Add folder | — |
| Add from tray | Add folder | `C:\work\other` becomes a project node; next poll its session sits under it | add failure → existing `project add failed` banner |
| Poll fails once | CLI exits non-zero / prints garbage | last live map kept; nothing turns exited | — |
| Poll keeps failing | three failures in a row | `claude.agents` banner with the cause; clears on success | — |
| No claude | binary missing | no polling; badges 0; no Elsewhere chip | existing settings banner explains |
| Unknown status | row `status: "compacting"` | card shows `compacting` muted; counts as live | — |
| Attach | select a live session, palette / right-click | "Attach in terminal" listed; run → notice naming `claude attach <id>` | historic session → not listed |
| Esc order | tray open + menu open | Esc closes the menu, then the tray, then the palette, pane, selection | — |

</frozen-after-approval>

## Code Map

- **Poller pattern** (`src-tauri/src/git/poll.rs`): `start(app)` loop, `interval()` with a floor, `spawn_blocking`, store then emit only on change, and `refresh_lock`. Copy this into a new `src-tauri/src/claude/live.rs`, which holds:
  - `LiveRow` with tolerant serde;
  - `parse_rows(&str) -> Result<Vec<LiveRow>, String>`;
  - `SessionState` and `LiveSession { state, pid, kind, name, project_id }`;
  - `LiveMap { sessions, elsewhere, exited: HashSet, failures }`;
  - `poll_once`, and `start` with `refresh`.
- **Running the CLI:** `src-tauri/src/process.rs` `run(cmd, timeout)` gives `Completed { status, stdout, stderr }` and `RunError`. The `claude` path is `AppState.read().binaries.claude` (`Binary { path, status }`, found via `settings::detect`). Interval: `settings.poll.agents_ms` (`DEFAULT_AGENTS_POLL_MS = 2000`).
- **State:** `src-tauri/src/settings/mod.rs` `AppState` holds `live: RwLock<LiveState>` (git statuses). Add `sessions_live: RwLock<LiveMap>` and a pass lock. Status banners come from `status`/`Banner::new`; check how `src/state/status.ts` builds status-mirror banners. A `claude.agents` banner can be pushed in a `sessions://live` payload field `banner: Option<String>` and rendered by the live store's selector.
- **`src-tauri/src/graph/mod.rs`:**
  - `children(workspace, discovered, stubs)` becomes `children(workspace, discovered, live, stubs)`, where `live` is project-id-keyed live sessions as `(id, name, started_at_ms)` for live-only children and the live-id set for ordering.
  - `ChildNode.session: Option<SessionMeta>`: a live-only child gets `SessionMeta` with `startedAt` from the row, `lastActive` = `startedAt`, branch `None` and messages 0.
  - `set_discovered` is the pattern for a new `set_live_children(app, …)`: revision plus emit only when the derived child set changes.
  - `WorkspaceState` gains `live_children` (not persisted).
- **`src-tauri/src/claude/sessions.rs`:** Story 3.1's pass; unchanged except that `children()` now also reads live.
- **`src-tauri/src/ipc/mod.rs`, `lib.rs`:** add a `live_sessions_get` command; start `claude::live::start` in setup; add a wire test.
- **`src/ipc/index.ts`:** add `SessionState`, `LiveSession`, `LiveSnapshot { sessions, elsewhere, banner }`, `onLiveSessions` and `liveSessionsGet`. **`src/App.tsx`:** mirror it into a new `src/state/live.ts` store (pattern: `src/state/status.ts` + `src/ipc/mirror.ts`).
- **`src/canvas/nodes.ts`:**
  - `toFlowNodes` inputs gain `live` (session id → state). Project `childCount` stays; add `liveCount`.
  - `LIVE_SESSIONS` is replaced by `liveCount` in `ProjectNode.tsx`.
  - `sameNode`/`sameChild` must compare the session's state.
  - `sessionMetaLine(meta, now)` takes the state.
- **`src/canvas/ChildNode.tsx`, `nodes.css`:** the state word and pulse dot (`@keyframes`, with a `prefers-reduced-motion` override).
- **`src/canvas/Canvas.tsx`:** `onPointerUpCapture` / `rightClickTarget` currently open the menu only for project targets. Open it for session targets too; the menu lists only the enabled entries (`nodeMenuCommands`), and for an empty list it closes itself, as `ContextMenu.tsx` already does.
- **New `src/components/ElsewhereTray.tsx`:** rendered in `App.tsx` over the canvas, below panes in z-order, styled in `shell.css`.
- **`src/commands/builtins.ts` (+test):** add `session.attach` and `elsewhere.toggle`, plus `elsewhere.close` (Esc, hidden), placed in the Esc chain after `contextMenu.close`. Add-folder reuses `addProjectsAt` from `src/commands/projects.ts`.
- **`src/theme/design.test.ts`:** `@keyframes` blocks are linted like any rule; the pulse must use only opacity and tokens.
- **Docs:** `docs/DESIGN.md` (session state words, pulse motion, tray), `README.md` (live sessions, tray, attach stub, poll banner).

## Tasks & Acceptance

**Execution:**
- [x] `src-tauri/src/claude/live.rs` (+ `claude/mod.rs`) -- `LiveRow` tolerant parse; `SessionState`; `LiveMap` with exited tracking and the 3-failure banner; `poll_once(claude_bin, …)` via `process::run`; `start`/`refresh` timer (`poll.agents_ms`, floor 500 ms, skipped unless claude is `found`); emits `sessions://live` on change; tests with a script fixture as `claude` (busy→idle→missing→back; garbage output; non-zero exit; three failures → banner; unknown status kept) -- the poller
- [x] `src-tauri/src/graph/mod.rs` -- live-only children, live-first ordering, `set_live_children` (revision + emit only when the child set changes); tests -- children
- [x] `src-tauri/src/settings/mod.rs`, `src-tauri/src/ipc/mod.rs`, `src-tauri/src/lib.rs` -- state, `live_sessions_get`, start in setup; wire test -- wiring
- [x] `src/ipc/index.ts` (+test), `src/state/live.ts` (+test), `src/App.tsx` -- types, mirror, banner selector -- live store
- [x] `src/canvas/nodes.ts` (+test), `src/canvas/ChildNode.tsx`, `src/canvas/ProjectNode.tsx`, `src/canvas/nodes.css` -- state on cards, pulse, live badge -- cards
- [x] `src/components/ElsewhereTray.tsx`, `src/components/shell.css`, `src/App.tsx` -- chip, list, Add folder -- tray
- [x] `src/commands/builtins.ts` (+test), `src/commands/navigation.ts` or `nodes.ts` (+test), `src/canvas/Canvas.tsx` -- `session.attach`, `elsewhere.toggle`/`elsewhere.close`, Esc order, session context menu -- commands
- [x] `docs/DESIGN.md`, `README.md` -- state words, pulse, tray, attach stub, banner -- docs

**Acceptance Criteria:**
- Given a Claude session running in a project folder, when two polls pass, then its card shows `busy`/`idle` matching `claude agents --json`, it sorts first, and the project badge counts it; quitting the session turns the card `exited` within one poll and the badge drops.
- Given a session running in a folder not on the canvas, when the poll runs, then `elsewhere 1` appears and Add folder puts that folder on the canvas with the session under it.
- Given a live session selected, when I open the palette or right-click it, then "Attach in terminal" is offered and shows the Epic 4 notice; a historic session offers nothing.
- Given `cargo test`, `clippy -D warnings`, `npm test` (design lint included), `tsc --noEmit`, when run, then all pass on both platforms.

## Implementation Notes

- **Wire shapes.** `SessionState` is internally tagged like `ProjectStatus`: `{ "kind": "busy" }`, `{ "kind": "other", "raw": "compacting" }` (so a raw status that happens to read `waiting` can never pose as the hook state). `LiveSession` carries `{ state, source: "poll", pid, kind, name, project_id, cwd, started_at }` -- `cwd`/`started_at` are extra to the spec's list; `ElsewhereRow` is `{ session_id, state, name, cwd, started_at }`, newest first. `LiveSnapshot.sessions` includes exited sessions (state `exited`), so cards can show the word.
- **Parsing** is per field over `serde_json::Value`, not a derived struct: a field of the wrong type (say `pid: "x"`) is treated as absent rather than failing the whole poll. A missing `status` becomes `other`/`unknown`. Anything that is not a top-level array is a failed poll.
- **Matching** (`graph::project_for_cwd`): `same_path(project.path, cwd)`, else the project owning the deepest branch whose `worktreePath` holds `cwd`. Project ids are re-matched on every successful poll (exited ones too), so Add folder / remove take effect on the next poll.
- **Exited live-only sessions** stay as historic children (memory only, until quit): `LiveChild.live = false` keeps them in `WorkspaceState.live_children`, so a session that ended before its transcript was found does not vanish. A live-only child is skipped when its id is discovered under *any* project (one flow node per session id).
- **Child-set change** is `WorkspaceState.live_children` inequality: the list carries id, name, startedAt, cwd and the live flag but never the state word, so busy ↔ idle leaves it equal and only `sessions://live` fires. A live-only child's name change does bump the revision (its label changed).
- **Badge** counts every non-`exited` state (equivalent to the spec's "busy, idle or unrecognised" while the poll is the only source).
- **Busy dot**: read "1-px dot" as a small round mark in the 1-px-line spirit; drawn as a 4 × 4 px `currentColor` circle (`border-radius: 50%`). Change `width`/`height` in `nodes.css` if a different size was meant. Keyframes are exactly the spec's; a design-lint test checks the pulse animates `opacity` only and has the reduced-motion override.
- **Tray state** lives in the ui store (`elsewhereOpen`); `isElsewhereOpen()` also requires rows, so a tray whose last row left counts as closed for Esc. While it is open the arrows and Enter are inert (like the other surfaces), so Enter on a focused Add folder button is not swallowed by `selection.activate`.
- **Session menu**: the canvas opens the menu for session targets too; `ContextMenu` now renders nothing (not even one frame) when no entry is enabled and closes itself, so a historic session gets no menu.
- **Not run** (session constraints): `npm run tauri build`, the app itself, and the manual checks (no GUI in this session). The `claude agents` row shape was re-confirmed read-only with `claude agents --json --all` (five rows, `busy`/`idle`).

- **Review fixes (round 1):** the card meta renders from `sessionCardMeta` (only the branch shrinks); losing `claude` clears the live map on both channels; add/remove run a live poll; `project_for_cwd` canonicalises the row cwd; the badge counts a project's drawn session children by session id and live-first sorting is by session id across projects; live-only cards have an empty `lastActive` (no age) and hover times only when known; blank `status`/`name` are missing; a snapshot clears the live load error and an empty tray resets its flag; at most 200 exited sessions are kept (oldest exits dropped); `rightClickAction` decides menu vs select, so no empty menu opens; the tray closes on an outside press and labels each Add folder button.
- Orchestrator (2026-10-18, review + GUI): GUI pass run before the patch round and again after it (foreground-guarded, `ide` expanded). This session showed as a live child under `ide`: `busy` with the pulsing dot, sorted first, badge `1 live`. `elsewhere 4` listed four idle sessions in other folders with path and Add folder; Esc closed the list. Right-clicking the live card offered only "Attach in terminal", which showed the notice `Attach arrives in Epic 4 (claude attach <id>)`. `~/.claude/projects` (excluding this session's live dir) was byte-identical in size and mtime. The first pass found the meta line overflowing (`busy · HEAD · 455 msgs · n…`, GUI1); after the patch it reads in full. Exit and Add folder were not driven from the GUI (they would stop a session or add one of Emils' folders); unit tests cover them. Verification after patches: `cargo test` 256, vitest 312, clippy and `tsc` clean, debug build.

## Spec Change Log

## Review Triage Log

Pass 1 (2026-10-18, on Opus) — layers: blind-hunter (BH), edge-case-hunter (EC), verification-gap (VG); plus the orchestrator's GUI pass (GUI).

- GUI1 the meta line `busy · HEAD · 455 msgs · now` overflows the 208-px card and the age is cut to `n…` — **medium** (the age is the line's point): patch — the branch segment shrinks and ellipsizes first; the state word, count and age never do.
- BH1 / EC1 claude going from found to not found leaves the last live map: badges, states, chip and banner stay — **medium**: patch — on losing the binary, clear the map (no live sessions, no banner) and emit.
- BH4 adding or removing a project does not trigger a live poll, so the tray row (and its button) lingers for a full interval — **low**: patch — `live::refresh` after both, like the sessions pass.
- EC2 / EC3 / EC15 a row `cwd` that differs from the project path by separator, trailing separator or a symlink never matches, and after Add folder the row never leaves the tray — **medium**: patch — match the canonical form of the cwd (`dunce::canonicalize`, raw on failure).
- BH2 / EC9 the tray flag stays set when the last row leaves, so a later row pops the list open and disables the canvas keys — **low**: patch — reset `elsewhereOpen` when the rows drop to 0.
- BH3 the open tray disables canvas keys but no outside click closes it; every row's button is named just "Add folder" — **low**: patch — close on a pointer-down outside the tray (as the menu does); `aria-label` naming the session and folder.
- BH6 / EC5 / EC6 / EC18 a session whose transcript is under project A while its live `cwd` maps to B: the badge counts on B, the card under A neither sorts first nor shows its state consistently — **low**: patch — live-first sorting and the card's state by session id across all projects; the badge counts the drawn cards' live states.
- BH7 a live-only card's age is its start, and a row without `startedAt` renders `?` and blank hover times — **low**: patch — omit the age (and the hover times) when there is no start time.
- EC7 / EC8 an empty `status` or `name` string renders a blank word or name — **low**: patch — treat blank as missing (`unknown`, the session id).
- EC10 `live_sessions_get` failing once leaves its banner up while events keep working — **low**: patch — a received snapshot clears `loadError`.
- BH9 / EC11 exited sessions accumulate for the whole run in the map and every payload — **low**: patch — keep at most the 200 most recent exited sessions.
- BH8 the story that brings hooks is named differently in comments and docs (3.3 / 4.3 / Epic 4) — **low**: patch — Story 4.3 everywhere outside the frozen block.
- BH11 README omits that a removed project's live sessions go to Elsewhere and that a session in a project's subfolder lands in Elsewhere (Add folder then nests a project) — **low**: patch — two sentences.
- VG1 the card renders the state word itself while the tested `sessionMetaLine(…, state)` path is unused — **low** (pre-verified): patch — one pure `sessionCardMeta` helper (word, tone, dot, rest) the card renders from, tested.
- VG2 the right-click → menu decision for session targets is untested; VG-o a historic session's menu opens and immediately closes — **low** (pre-verified): patch — pure `rightClickAction(target, hasMenuItems)` returning menu or select, tested; no menu is opened when nothing is enabled.
- BH10 no tests for the tray component — **low**: patch through helpers where logic exists (reset rule, labels); rendering joins the component-test deferral.
- BH5 an unverified `--all` status for a finished background session counts as live — **maybe-false**: rejected — the frozen decision counts unrecognised states as live; no such status has been seen on this machine.
- EC4 Add folder clicked twice sends two adds — **low**: rejected — the second is the existing duplicate flash.
- EC12 the workspace can change between the clone and `set_live_children` — **low**: rejected — the next poll corrects it.
- EC13 lowering `poll.agents_ms` waits out the current sleep — **low**: rejected — at most one old interval.
- EC14 the busy dot is 4 px, not 1 px — **low**: rejected — a 1-px dot cannot be seen; recorded as the reading of "1-px".
- EC16 Esc closes the menu before the tray rather than "with the same precedence" — **false**: the frozen matrix row orders menu, then tray.
- EC17 `alternate` makes a full pulse 2.4 s — **low**: rejected — one direction per 1.2 s reads calm; within the rule's intent.
- BH9' exited sessions from an Elsewhere folder appear as exited children once that folder is added — **low**: rejected — they did run there; harmless and memory-only.

## Design Notes

- **Verified output** (2.1.302, five rows on this machine): `[{"pid":40284,"cwd":"…","kind":"interactive","startedAt":1791553254656,"sessionId":"…","name":"…","status":"idle"}, …]`, a top-level array; `status` was `idle` ×4 and `busy` ×1. A call takes ~190 ms.
- **Pulse:**
  ```css
  @keyframes session-pulse { from { opacity: 1 } to { opacity: 0.35 } }
  .session-state-busy .session-dot { animation: session-pulse 1.2s ease-in-out infinite alternate; }
  ```
  With a `prefers-reduced-motion: reduce` override to `animation: none`.

## Verification

**Commands:**
- `cd src-tauri; cargo test; cargo clippy --all-targets -- -D warnings` -- expected: pass, clean
- `npm test; npx tsc --noEmit` -- expected: pass, clean
- `npm run tauri build -- --debug --no-bundle` -- expected: builds

**Manual checks (if no CLI):**
- Orchestrator (foreground-guarded): plant `B:\projects\ide` expanded. This Claude Code session is a live row for it, so its card must show `busy` or `idle` and the badge `1 live` (or more).
- Other live sessions on this machine in folders not planted must show in the Elsewhere chip. Open the tray and screenshot it.
- Right-click the live session and screenshot the menu with "Attach in terminal"; run it and screenshot the notice.
- Exit and Add folder are left to unit tests and to Emils, since the orchestrator must not stop his sessions or add his folders.
