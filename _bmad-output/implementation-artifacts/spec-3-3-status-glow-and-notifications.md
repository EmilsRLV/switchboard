---
title: 'Story 3.3: Status glow and notifications'
type: 'feature'
created: '2026-10-18'
status: 'done'
route: 'dispatch'
review_loop_iteration: 0
baseline_commit: 'd0cf81f6cfe58b78fac2ba8fdde233133261d33f'
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-3-context.md'
  - '{project-root}/docs/DESIGN.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The canvas shows which sessions are busy or idle, but not which ones need the operator. A session that just finished its turn looks the same as one that has been idle for an hour. Nothing happens when the operator is in another window, so they still have to check terminals.

**Approach:**
- **A session needs you.** It is in `finished` or `waiting`. In this story `finished` comes from the poll: Rust sees a session go busy → idle between two polls. `waiting` stays reserved for hooks (Story 4.3).
- **The session card** goes into the accent state: an accent border, an accent state word and a pulsing accent dot.
- **The project card glows.** Its accent outline pulses whether it is collapsed or expanded, as long as any of its sessions needs you.
- **Selecting the session clears it.** Rust records the acknowledgement, so the session reads `idle` until it is busy again.
- **OS toasts.** While the Switchboard window is unfocused, a session entering `finished` (or `waiting`) sends a toast naming the project and the session, if that kind is turned on in settings.
- **Select on click** (amended by Emils, 2026-10-18). A click on a toast focuses the window and reveals and selects its session; window focus alone moves nothing.
- **A registered command.** "Go to session that needs you" does the same from the palette or a key.

**Decisions (recorded):**
- **Owner decisions (2026-10-18):**
  - `finished` is derived from busy → idle until hooks exist.
  - A toast's click selects its session (amended; see Select on click).
- **The `finished` rule** (Rust, `claude::live`):
  - A session whose previous poll state was `busy` and whose current poll status is `idle` becomes `Finished`. It stays `Finished` while the poll keeps reporting `idle`.
  - It becomes `Busy` on the next `busy`, `Exited` when it drops out, and `Idle` when acknowledged.
  - A session first seen as `idle` (already idle at startup) is `Idle`, never `Finished`.
  - `Other` statuses never become `Finished`.
  - `Waiting` comes only from hooks (Story 4.3). The poll leaves it alone.
- **Acknowledgement:**
  - New command `session_acknowledge(session_id)`. It turns `Finished` or `Waiting` into `Idle` (source `ack`) until the next `busy` or hook event, and emits `sessions://live`. Any other state is a no-op.
  - The frontend calls it whenever a session node becomes the selection: click, arrows, the focus reveal or the command.
  - Selecting a project does not acknowledge its sessions.
- **Attention set:** a session needs you when its state is `Finished` or `Waiting`. A project glows when any of its sessions (drawn or hidden, the project collapsed or not) needs you.
- **Visuals** (the accent allow-list in the design lint and DESIGN.md grows by exactly these selectors):
  - **Session card in attention:** a 1-px accent border; the state word (`finished` / `waiting`) in accent; the 4-px dot in accent, pulsing like `busy`'s.
  - **Project glow:** a 1-px accent `outline` at 2-px offset, its opacity pulsing between 1 and 0.4 over 1.2 s, in `alternate` mode. No shadow, gradient or filter.
  - Under reduced motion, both are static (outline at full opacity).
  - A selected project in the glow state keeps the glow; the selection outline sits inside the glow.
  - DESIGN.md adds the glow to the motion table and the attention states to the accent section.
- **Toasts:**
  - **Plugin and settings:** `tauri-plugin-notification` 2.7.0, called from Rust. New settings keys are `notifications.finished` and `notifications.waiting`, both default `true`; they parse tolerantly, and a missing key takes the default.
  - **When one is sent:** only on a transition into `Finished` or `Waiting`, only while the main window is not focused, and only when that kind is on. One toast per transition; no toast for acknowledgement, startup or a session already in that state.
  - **Text:** title `<project label> — finished` (or `— waiting`; `<folder name>` for an Elsewhere session); body is the session title, else its name, else `session <first 8 of id>`.
  - **A failure** to send is logged and never shown as a banner.
- **Select on click** (amended 2026-10-18 by Emils, replacing "select on next focus", which rested on the wrong belief that the plugin reports no desktop clicks; 2.7.0 does, via `Notification::on_action`, on Windows only while the toast is on screen):
  - A click on a toast (`tap`) focuses the main window (unminimise, show, focus) and reveals and selects that toast's session, with the same reveal as `ctrl+j`.
  - Window focus alone moves nothing; there is no pending toast and no 10-minute window. A toast clicked from the Action Center may report nothing; `ctrl+j` reaches the session then.
- **Command:** `attention.next`, "Go to session that needs you", key `ctrl+j`. It is enabled when any session on a canvas project needs you, and it does the same reveal and select for the session that has needed attention longest (oldest transition first).

## Boundaries & Constraints

**Always:**
- Rust owns session state and acknowledgement. The frontend only asks.
- Nothing is written under `~/.claude`; nothing in live state is persisted.
- The accent appears only on the states listed in Decisions, and the design lint enforces the widened allow-list.
- Every action is a registry command with a `when` clause.
- Both CI runners stay green, and tests never send a real OS notification (the sender is injectable).

**Never:**
- Hooks or a `waiting` source (Story 4.3).
- Sounds, a badge on the taskbar or tray icon, a notification centre, or a toast history.
- Toast action buttons.
- Native toast activation (COM or D-Bus).
- Glow for review requests (Epic 7).
- A settings UI for the toggles; settings stay a file (Epic 9).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|---|---|---|---|
| Turn ends | poll: S busy, next poll S idle | S `finished`: accent border/word/dot pulse; its project card glows | — |
| Already idle | S first seen idle | `idle`, no glow, no toast | — |
| Acknowledge | click S (or arrow onto it) | S `idle`, glow gone (if no other session needs you), no toast | — |
| Busy again | S finished, next poll busy | `busy`, glow gone | — |
| Collapsed parent | S finished, project collapsed | project glows; badge unchanged | — |
| Toast | S finishes while Switchboard unfocused, `notifications.finished` on | one OS toast "ide — finished" / session title | send failure → logged only |
| Focused | S finishes while Switchboard focused | glow, no toast | — |
| Toggle off | `notifications.finished: false` | glow, no toast | — |
| Toast click | toast sent, then clicked | window focused; S's project expands if collapsed, S selected and revealed, acknowledged | S no longer needs you → window focused only |
| Elsewhere | Elsewhere session finishes, unfocused | toast titled by folder; on focus the tray opens | — |
| Command | two sessions finished, `ctrl+j` | the longer-waiting one is revealed and selected; again → the other | none → command disabled |
| Exit | finished S drops out | `exited`, glow gone | — |
| Reduced motion | OS setting on | glow and dots static | — |

</frozen-after-approval>

## Code Map

- **`src-tauri/src/claude/live.rs`:**
  - `SessionState { Busy, Idle, Waiting, Finished, Exited, Other{raw} }` and `StateSource { Poll }`. Add `Ack`.
  - `LiveMap::apply(polled, workspace)` folds rows. Add the busy → idle → `Finished` rule there, keeping the previous state.
  - Add `acknowledge(id) -> bool`.
  - Track transitions into attention as `attention_since: HashMap<id, i64>` (for `attention.next`, oldest first).
  - Return the list of new transitions from `apply`, so `apply_and_emit` can decide on toasts.
  - Existing patterns to keep: `LiveSnapshot` (sent on `sessions://live`, so add `attention_since` per session) and the `MAX_EXITED` cap.
- **`src-tauri/src/notify.rs` (new):**
  - `Notifier` trait (`send(title, body) -> Result<(), String>`); the production impl uses `tauri_plugin_notification::NotificationExt` (`app.notification().builder().title().body().show()`), and tests swap in a recorder.
  - `decide(transitions, settings, focused) -> Vec<Toast>` is pure.
  - Pending-toast state lives in `AppState` and goes out on `notify://pending`.
  - Window focus comes from `app.get_webview_window("main").map(|w| w.is_focused())`.
- **`src-tauri/src/settings/mod.rs`:** the `Settings` schema (`#[serde(default)]`, `PollSettings` pattern). Add `NotificationSettings { finished: bool, waiting: bool }` defaulting to true; update the defaults test and README's settings table.
- **`src-tauri/src/ipc/mod.rs`, `lib.rs`:**
  - New commands: `session_acknowledge(sessionId)` and `notify_take_pending() -> Option<PendingToast>`.
  - Plugin `tauri_plugin_notification::init()` in `builder()`; `Cargo.toml` gets `tauri-plugin-notification = "2"`.
  - The capability file `src-tauri/capabilities/default.json` gets no JS permissions, since everything is called from Rust.
  - Wire tests.
- **`src/ipc/index.ts`:** `SessionState` gains the `ack` source; add `sessionAcknowledge`, `notifyTakePending`, `onNotifyPending` and `onWindowFocus` (via `getCurrentWindow().onFocusChanged`).
- **`src/state/live.ts`:**
  - Already has the live store, `stateWord`, `sessionStateTone` and `isLiveState`.
  - Add `needsAttention(state)` and `projectAttention(projectId)` over the snapshot. Attention is keyed by the child's project via `children`; reuse the Story 3.2 rule of looking sessions up by id.
- **`src/canvas/nodes.ts`:**
  - `toFlowNodes` inputs already carry `live`. Add `attention` to the project data and the session data, and compare both in `sameNode`.
  - `sessionCardMeta` already returns tone and dot. Add an `attention` tone.
- **Cards:** `src/canvas/ChildNode.tsx` and `ProjectNode.tsx` take the classes `is-attention` and `is-glowing`. **`src/canvas/nodes.css`:** the accent border, word and dot, and the glow `@keyframes`, with the reduced-motion override.
- **Selection hook:** `src/state/ui.ts` `select()` is the single path, called from `clickNode`, `moveSelection` and `openContextMenuFor`. Acknowledgement fires from a store subscription (when the selection becomes a session in attention, call `sessionAcknowledge`), not from each caller.
- **Focus reveal:** `src/App.tsx` subscribes to window focus and runs `revealPendingToast()` in a new `src/commands/attention.ts`. It reuses `moveSelection`'s reveal (`revealRect` in `navigation.ts`; export a `revealTarget(target)`), `setExpanded` from `commands/nodes.ts`, and the tray flag in `ui.ts`.
- **Command:** `src/commands/builtins.ts` (+test) gets `attention.next` (`ctrl+j`).
- **Lint:** `src/theme/design.test.ts` widens `ACCENT_ALLOW_LIST` with the new selectors (by first class: `.child-node.is-attention…` needs an allow-listed subject class such as `.attention-*`). Prefer dedicated classes (`.session-attention`, `.project-glow`) so the subject-class rule from Story 2.5 stays simple. Mirror the list in DESIGN.md.
- **Docs:** `docs/DESIGN.md` (attention states, glow motion, allow-list) and `README.md` (finished rule, glow, acknowledgement, toasts, settings keys, `ctrl+j`, focus reveal).

## Tasks & Acceptance

**Execution:**
- [x] `src-tauri/src/claude/live.rs` -- busy→idle `Finished` rule, `Ack` source, `acknowledge`, `attention_since`, transitions out of `apply`; tests: the matrix's state rows (turn ends, already idle, busy again, exit, other status, ack, ack of a non-attention state) -- state machine
- [x] `src-tauri/src/notify.rs`, `src-tauri/src/settings/mod.rs`, `Cargo.toml` -- `NotificationSettings`, pure `decide`, injectable `Notifier`, plugin sender, pending toast + `notify://pending`; tests: focused → none, toggle off → none, one toast per transition, titles for project and Elsewhere, failure only logged -- toasts
- [x] `src-tauri/src/ipc/mod.rs`, `src-tauri/src/lib.rs` -- `session_acknowledge`, `notify_take_pending`, plugin registration, wiring of `apply_and_emit` → `decide`; wire tests -- wiring
- [x] `src/ipc/index.ts` (+test), `src/state/live.ts` (+test) -- types, wrappers, `needsAttention`, project attention -- live store
- [x] `src/canvas/nodes.ts` (+test), `src/canvas/ChildNode.tsx`, `src/canvas/ProjectNode.tsx`, `src/canvas/nodes.css` -- attention card, glow, reduced motion -- visuals
- [x] `src/state/ui.ts` (+test), `src/commands/attention.ts` (+test), `src/commands/navigation.ts`, `src/App.tsx`, `src/commands/builtins.ts` (+test) -- ack on selection, focus reveal, `attention.next` -- behaviour
- [x] `src/theme/design.test.ts`, `docs/DESIGN.md`, `README.md` -- allow-list, motion table, docs -- rules and docs

**Acceptance Criteria:**
- Given a session that the poll sees go busy → idle, when the next poll lands, then its card shows the accent `finished` state and its project glows (collapsed or not); selecting it clears both, and it reads `idle` until busy again.
- Given Switchboard unfocused and `notifications.finished` on, when a session finishes, then one OS toast names the project and session; focusing the window reveals and selects that session.
- Given two finished sessions, when I press `ctrl+j` twice, then each is revealed and selected in the order they finished.
- Given `cargo test`, `clippy -D warnings`, `npm test` (design lint with the widened allow-list), `tsc --noEmit`, when run, then all pass on both platforms, and no test sends a real notification.

## Implementation Notes

- **Review round 1 (select on click):** the pending toast, `notify_take_pending`, `notify://pending` and the focus reveal are gone. Each toast carries `sessionId` / `projectId` in the plugin's `extra`; `notify::listen_for_clicks` (setup) registers `Notification::on_action`; a `tap` focuses the main window (`focus_main_window`) and emits `notify://reveal { session_id, project_id }`, which `App.tsx` hands to `revealToastSession` (same reveal as `ctrl+j`; Elsewhere opens the tray). `reveal_for_action` is the pure mapping; `handle_action` is tested with a deserialised `ActionPerformed`.
- **Acknowledgement hardening:** `session_acknowledge(sessionId, attentionSince)` is a no-op unless `attentionSince` matches the stored one, and replies with the live snapshot (or `null`); the frontend applies only that session from the reply, and only while the store still shows the acknowledged turn, so a lost `sessions://live` emit cannot leave the accent on and a stale reply cannot roll back a newer event. Opening the Elsewhere tray acknowledges every Elsewhere session it lists that needs attention.
- **Finished rule, refined:** a per-session "busy seen since the last idle" mark (`LiveMap::busy_seen`) survives `Other` statuses, so busy → `compacting` → idle is `Finished`; an `Other` status leaves an unacknowledged `Finished`/`Waiting` (and its time) in place; a session listed twice in one poll counts once (first row wins). A `(untitled)` transcript title is skipped for the toast body (the name is used).
- **Known limits:** a turn shorter than one poll interval is never seen busy, so never finishes (until hooks); a session that finishes while already selected keeps the accent until clicked or reached with `ctrl+j`; development builds show toasts under PowerShell's identity and their clicks may not reach the app (installed builds show Switchboard); a toast clicked from the Action Center may report nothing — `ctrl+j` reaches the session then.
- **`attention_since`** lives on `LiveSession` (so it rides `sessions://live` per session, as the Code Map asks) rather than in a separate `HashMap`; it is set on entering `Finished`/`Waiting` and cleared on every other state. `LiveMap::apply` now returns `Vec<Transition>`; `apply_at(.., now)` takes the clock for tests.
- **`Waiting` vs the poll:** an `idle` poll keeps `Waiting` (with its time); a `busy` poll turns it `Busy` (same as `Finished`). An acknowledged session keeps source `ack` while the poll keeps reporting `idle`.
- **Notifier injection:** `AppState::notifier` (`Mutex<Option<Arc<dyn Notifier>>>`) overrides the plugin; with neither (the mock app) nothing is sent. Tests inject `notify::fixtures::Recorder`. `graph::folder_label` became `pub` for the Elsewhere title.
- **Linux deps:** `tauri-plugin-notification` 2.7.0 uses `notify-rust` 4.18 with its default `z` feature (pure-Rust `zbus`), so no apt package is needed; `ci.yml` is unchanged.
- **Accent classes:** dedicated classes carry the accent (`.session-attention` on the card — written `.session-attention.child-node` to beat `.child-node`'s border —, `.session-attention-word` on the state word, `.project-glow` on the project card); The glow is a `::after` box with the accent outline whose **opacity** pulses 1 → 0.4 (keyframes may not name the accent under the lint, and this matches "opacity pulsing" exactly). When the project is selected too, the glow moves out to 4 px so the 2-px selection outline sits inside it.
- **Acknowledgement path:** `state/ui.ts` subscribes to selection changes and calls `acknowledgeIfNeeded`. Because an unchanged selection fires no subscription, `clickNode` and `revealSession` also call it directly when the target was already selected (a session that finished while selected; `ctrl+j` onto it). A per-id "acknowledging" set in `state/live.ts` (cleared when a snapshot shows the session settled, or on failure) keeps a quick second `ctrl+j` from revisiting the same session.
- **Reveal:** `revealSession` also turns on `show all` for the project when the session sits past the ten-child cut, so it is drawn before it is selected and panned to.
- Not run here (owner's constraints): `npm run tauri build`, the GUI/manual checks and the toast check.
- Orchestrator (2026-10-18, review + GUI): GUI pass with a fake `claude` (a scratchpad `.cmd` answering `--version` and printing one row whose status the script flips), run before and after the patch round. Each time, after busy → idle, the collapsed `ide` card showed the accent glow; `ctrl+j` expanded `ide`, selected the fake session and acknowledged it (`idle · 0 msgs`). Emils' real sessions were not involved. The toast and its click were not driven: that needs Switchboard unfocused, which the guarded script refuses; left to Emils by hand (installed build for the Switchboard identity). Verification after patches: `cargo test` 280, vitest 333, clippy and `tsc` clean, debug build.
- Orchestrator (2026-10-18, close): committed `eea61b9`, pushed; CI run 39078612318 green on ubuntu-24.04 and windows-latest at the first attempt (first Linux build with the notification plugin). Deferred: one new `deferred-work.md` entry (focused-window check through the mock runtime); component render tests join the existing entries. Epic 3 complete. Left to Emils: a real toast and its click (installed build).

## Spec Change Log

- 2026-10-18 (BH1, human decision): the frozen "Select on focus" decision and matrix row were amended by Emils to "Select on click": the plugin does report desktop toast clicks. KEEP: the finished rule, acknowledgement, glow, toasts and `ctrl+j`, all verified in the GUI pass.

## Review Triage Log

Pass 1 (2026-10-18, on Opus) — layers: blind-hunter (BH), edge-case-hunter (EC), verification-gap (VG); plus a GUI pass with a fake `claude` (glow on a collapsed project, `ctrl+j` expanding it and acknowledging the session: both as specified).

- BH1 the plugin's desktop click reporting exists (2.7.0 `Notification::on_action`, verified in its source); the select-on-focus design rested on my wrong statement — **high**, intent: resolved by Emils (toast click selects; focus reveal dropped; frozen decision amended).
- BH5 / EC5 a failed `sessions://live` emit after an acknowledgement leaves the card in the accent state for good (the next poll sees no change) — **medium**: patch — `session_acknowledge` returns the live snapshot and the frontend applies it.
- BH6 / EC1 / EC2 a turn going busy → `Other` (e.g. `compacting`) → idle never finishes, and a finished session that reports an `Other` status loses its attention unacknowledged — **medium**: patch — remember "busy seen since the last idle" through `Other` states; an `Other` status leaves `Finished`/`Waiting` in place.
- EC7 revealing a hidden session toggles show-all and turns it off when it was already on — **medium**: patch — only turn show-all on.
- EC3 a session listed twice in one poll gives two transitions and two toasts — **low**: patch — first row wins.
- EC4 an acknowledgement sent for an older `Finished` can clear a newer one — **low**: patch — `session_acknowledge` carries the `attention_since` it saw; a mismatch is a no-op.
- EC6 a second `ctrl+j` during the first one's expand targets the same session — **low**: patch — mark the target before awaiting.
- EC8 a session or project removed during the awaited expand is still selected — **low**: patch — re-check after the await.
- EC9 an Elsewhere session that finishes can never be acknowledged — **low**: patch — opening the tray acknowledges the Elsewhere sessions it lists; a toast click on one opens the tray.
- BH4 `notify://pending` and the `is-attention`/`is-glowing` classes are unused — **low**: patch — removed with the focus reveal.
- BH10 the glow has no accessible cue — **low**: patch — "needs you" in the project card's and session card's accessible name and tooltip.
- BH12 `attention.next` fails silently when the expand fails — **low**: patch — a notice.
- BH7 a turn shorter than one poll interval is never seen as busy, so it never finishes — **low**: patch — say so in README and the matrix notes (Implementation Notes).
- BH3 development builds show toasts under PowerShell's identity (the plugin sets the app id only outside `target\debug|release`) — **low**: patch — README note.
- VG1 the toast body's title lookup from discovered transcripts is untested; a `(untitled)` title is used instead of the name — **low** (pre-verified): patch — wiring test; skip the untitled placeholder.
- BH2 `show()` dispatches asynchronously, so a delivery failure is not seen — **low**: rejected — the plugin only reports preparation errors; logged as such; the docs say so.
- BH8 a session that finishes while already selected keeps the accent until clicked — **low**: rejected — the accent is the signal; a click acknowledges; documented.
- BH9 the spec's Design Notes and Code Map describe a different glow technique and data shape — **low**: rejected — the fix is a spec edit; the Implementation Notes record the real ones.
- BH12' `ctrl+j` might open WebView2's downloads — **false**: the GUI pass pressed `ctrl+j` in the built app and the session was revealed, no downloads view.
- EC10 a slow `show()` would stall the poll — **false**: `show()` spawns the delivery and returns.
- VG2 the focused-window check is untested through the mock runtime — **low** (pre-verified, filed defer): defer — needs an injectable focus query.
- VG3 the attention classes and the focus subscription are not render-tested — **low** (pre-verified, filed defer): defer — joins the component-test entry; the GUI pass covers the glow.

## Design Notes

- **Deterministic GUI check without touching Emils' sessions:** the GUI script plants a `settings.json` whose `claude.path` points at a fixture `.cmd` in the scratchpad.
  - On `--version` the fixture prints `2.1.302 (Claude Code)`.
  - On `agents --json --all` it prints the contents of a JSON file the script edits, with one row for a fake session id whose cwd is `B:\projects\ide`.
  - The script writes `busy`, waits two polls, then writes `idle`, which produces the `finished` transition with no real Claude involved.
- **Glow CSS** (shape only):
  ```css
  .project-glow { outline: var(--line) solid var(--accent); outline-offset: 2px; animation: glow 1.2s ease-in-out infinite alternate; }
  @keyframes glow { from { outline-color: var(--accent); } to { outline-color: transparent; } }
  ```
  The `to` keyframe fades the accent outline towards transparent to approximate opacity 0.4. Tune the stop so the outline never fully disappears.

## Verification

**Commands:**
- `cd src-tauri; cargo test; cargo clippy --all-targets -- -D warnings` -- expected: pass, clean
- `npm test; npx tsc --noEmit` -- expected: pass, clean
- `npm run tauri build -- --debug --no-bundle` -- expected: builds

**Manual checks (if no CLI):**
- Orchestrator (foreground-guarded): with the fixture `claude` above and `ide` planted and collapsed, write `busy`, wait 5 s, then write `idle` and wait 5 s.
  - Screenshot the glowing collapsed `ide` card.
  - Press `ctrl+j`, then screenshot: `ide` should be expanded, the fake session selected, the accent gone and the state reading `idle`.
- Toast check, run by hand by Emils: focus another window, flip the fixture to `busy` then `idle`, see the toast, then click it or alt-tab back and watch the session selected.
