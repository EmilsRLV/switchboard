---
title: 'Story 12.2: Agent cards for other coding agents'
type: 'feature'
created: '2026-11-23'
status: 'done'
baseline_commit: '57803181908efd5354ff182f0b30b672236b3af9'
route: 'dispatch'
review_loop_iteration: 0
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-12-context.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The operator runs Kimi Code (`kimi.exe`) and Qwen Code (`qwen.exe`) by opening a plain terminal and typing the command. These agents don't appear on the canvas, so the operator can't tell at a glance which ones are still running.

**Approach:** `settings.json` gains a list of agents. **New session…** can start one of them in a Switchboard terminal under the project. It shows as an **agent card** with a state taken only from its process: `running` or `exited (<code>)`. The card has show terminal, Stop, Restart and Remove. Nothing else applies to it: no history, hooks, MCP config, resume, fork or edges.

## Boundaries & Constraints

**Always:**
- **Settings.** `settings.json` gains `agents: [{name, command, args, env}]`, defaulting to `[]`.
  - An entry is dropped, with banner `settings.agents` naming it and the reason, when its name is blank, duplicated or `claude`, or when an env name doesn't match `[A-Za-z_][A-Za-z0-9_]*` or is one of `PARENT_SESSION_VARS`.
  - Nothing is run at load.
- **Command lookup at start.** `command` is resolved like `locate_program`: a path, `~/…`, or a bare name looked up on PATH with `PATHEXT`. On Windows a `.cmd` or `.bat` is refused with `agent <name>: <path> is a batch file; point command at the .exe`.
- **Env values.** A value written `${env:NAME}` is read from Switchboard's own environment at start. When it is missing, the start is refused with `agent <name>: $NAME is not set`.
- **Spawn.** The agent runs as `<command> <args…>` with separate arguments, never as a shell string, in the project folder, in a PTY of the new `TermKind::Agent` with id `agent:<node uuid>`.
  - Environment, in order: the inherited one minus `PARENT_SESSION_VARS`, then `TERM` and `COLORTERM`, then the agent's `env`, then `SWITCHBOARD_NODE=<node uuid>`, which comes last and cannot be overridden.
  - No settings file, MCP config or system prompt is passed.
- **Card state.** Rust keeps the runs in memory: `{id, project_id, agent, name, started_at, exited: Option<i32>, attention}`. Children list them as `ChildKind::Agent` cards. A run counts toward the project's `N live` while it runs.
- **Attention on exit.** An exit that happens while the window is unfocused, or while the card isn't selected, sets `attention`. The card then shows the attention colour and the project glows. A toast follows the same rule as `finished`. Selecting the card acknowledges it.
- **Stop, Restart, Remove.**
  - **Stop:** Ctrl+C, a second Ctrl+C after 300 ms, then kill after 5 s, using `stop_writes(Interrupt)` with `STOP_KILL_AFTER`. A second Stop kills at once.
  - **Restart:** only when exited. It re-runs the same agent, args and env in the same tab and under the same node id.
  - **Remove:** only when exited. It drops the run and closes its terminal.
- **Remembered choice.** The launch sheet's Agent choice is remembered per project in `launchDefaults.agent`, a serde default that is left out when it is `claude`.

**Never:**
- Read an agent's history, wire hooks, or run `--version` on it.
- Persist agent runs or their card positions: positions live in memory only, and runs are gone after an app restart.
- Let an agent card be an edge end, a peer, an inbox target, a review source, or a target of resume, fork or attach.
- Use any id-keyed Claude state for agents: `LiveMap`, hooks tokens, `Launcher`, inbox, approvals.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected | Error handling |
|---|---|---|---|
| Start | Agent `kimi` (`command:"kimi"`), project P, Start | Tab `agent:<id>` running `kimi` in P's folder; `kimi-<4hex>` card `running`; `N live` +1 | — |
| Not found | `command:"nope"` | Sheet stays open, error under Start: `could not start nope: not found on PATH` | Nothing spawned |
| Batch | `command` resolves to `kimi.cmd` (Windows) | Refused with the batch message | Nothing spawned |
| Env ref | `env:{KEY:"${env:KIMI_KEY}"}`, var set / unset | Child gets the value / start refused `agent kimi: $KIMI_KEY is not set` | — |
| Bad entry | Two entries named `qwen`, one named `claude` | The duplicate and `claude` are dropped; one banner names both | Other entries kept |
| Exit unseen | Agent exits 0 while its card is unselected | Card `exited (0)` in attention colour, project glows, toast if unfocused | — |
| Exit seen | Exits while its card is selected and the window is focused | `exited (0)`, no attention | — |
| Stop | Stop on a running agent | Ctrl+C, then Ctrl+C at 300 ms, kill at 5 s if still running | — |
| Restart / Remove | Exited card | Restart: same id and tab, `running`. Remove: card and tab gone | Both refused while running |
| Edge | Link a project to an agent card | Refused (`unknown session`, via the existing node check) | — |
| App restart | Agents ran before quit | No agent cards | — |

</frozen-after-approval>

## Code Map

- `src-tauri/src/settings/mod.rs` :53 `Settings` (+`agents`), :224 `Banner`; `settings/store.rs` :49 `validate`. Copy the drop-with-banner pattern from `graph/store.rs` :25 (test :189).
- `src-tauri/src/ipc/mod.rs`:
  - :1114 `locate_program`, :1269 `shell_spec` (the "not found on PATH" text); `claude/launch.rs` :321 `pathext_target`, :335 `refuse_batch` (needs its own message).
  - :1660 `session_launch` → `new_launch` :1791. Add an `agent: Option<String>` branch on `LaunchRequest` (`claude/launch.rs` :97) that skips claim, hooks, settings and MCP files, add-dirs and the system prompt, and calls a new `start_agent`.
  - :1414 `term_restart`, :1437 `term_close`, :1920 `stop_session` filter by kind: add `Agent`.
- `src-tauri/src/pty/mod.rs`:
  - :80 `TermKind` (+`Agent`); :158 `SpawnSpec`/`command()` already gives the required env order.
  - `open_session` :1173: generalise it to take a kind.
  - `restart` :1227 refuses `Session` only; `close` :1257 accepts `Session`: add `Agent`.
  - `Term::finish` :637 runs the exit hook with the code.
- New `src-tauri/src/agents.rs` -- the `AgentRuns` registry (in `AppState`), `start`, `exited` (sets attention unless acknowledged-visible), `acknowledge`, `restart`, `remove`, `children()` → `ChildNode{kind: Agent, agent: Some(AgentMeta)}`. Run the exit toast through `notify::decide` (notify.rs :105) as `Finished`.
- `src-tauri/src/graph/mod.rs` -- :265 `ChildKind` (+`Agent`), :279 `ChildNode` (+`agent: Option<AgentMeta>`), :352–365 `NodeKind` (+`Agent`); merge agent children in `children_with_worktrees` :484. `move_node` :1283 keeps agent positions in memory, not in `SessionRef`. `edge_end_exists` :1744 then refuses agents unchanged.
- `src-tauri/src/mcp/mod.rs` -- unchanged: `sessions` :919 does not list agents, and send, link and review targets already refuse them.
- `src/ipc/index.ts` -- `Settings.agents`, `ChildKind` / `NodeKind` `"agent"`, `ChildNode.agent`, `TermInfo.kind` `"agent"`, `LaunchRequest.agent`, `LaunchPrefill.agent` and the `agents` list.
- `src/components/LaunchPane.tsx`; `src/commands/launch.ts` -- :35 `LaunchForm.agent`, :129 `formFromPrefill`, :160 `formErrors`, :222 `launchRequest`. Hide model, effort, mode, worktree, add-dirs and prompt when `agent !== "claude"`. Add an `audit.test.ts` :59 allow-list entry for the new select.
- `src/canvas/ChildNode.tsx` :50 (+`AgentCard`, its chip modelled on `.branch-node-worktree` :171); `Canvas.tsx` :76 `NODE_TYPES` (+`agent`); `nodes.ts` :529 `liveCount` and :533 attention include agent children; `nodes.css` and `docs/DESIGN.md` gain the **agent chip**.
- `src/commands/nodes.ts` :60 `TOOLBAR_KINDS.agent` = term, stop, restart, remove (all node-menu commands). New `agent.*` commands live in `src/commands/agents.ts`.
- `src/state/terminals.ts` :96 `terminalStateText` for agent tabs reads `exited (N)`; `ui.ts` `select` acknowledges agent attention.

## Tasks & Acceptance

**Execution:**
- [x] `src-tauri/src/settings/{mod,store}.rs` -- `AgentSetting`, `agents`, validation and banner; tests per refusal.
- [x] `src-tauri/src/pty/mod.rs`, `pty/tests.rs` -- `TermKind::Agent`; open, restart, close and stop by kind; a test that env order leaves `SWITCHBOARD_NODE` unoverridable.
- [x] `src-tauri/src/agents.rs`, `settings/mod.rs` (AppState) -- the registry, the `${env:}` resolution, command lookup with the batch refusal, the spawn, exit and attention, restart, remove and acknowledge; unit tests over the pure parts.
- [x] `src-tauri/src/graph/mod.rs`, `ipc/mod.rs`, `lib.rs` -- the kinds, the child merge, the launch branch, IPCs `agent_stop`, `agent_restart`, `agent_remove` and `agent_acknowledge`, the `launchDefaults.agent` field; a lib.rs fixture test that drives start → exit → attention → restart → remove and the refusals in the matrix.
- [x] `src/ipc/index.ts`, `src/commands/{launch,agents,nodes,builtins}.ts`, `src/components/LaunchPane.tsx`, `src/canvas/{ChildNode.tsx,Canvas.tsx,nodes.ts,nodes.css}`, `src/state/{terminals,ui}.ts` -- the UI, with vitest tests for the form rules, the toolbar set, live count and attention.
- [x] `docs/help/sessions.md`, help Terms and legend pages, `README.md` (Starting sessions, Settings), `docs/DESIGN.md`, `ROADMAP.md` (Not planned → "Full support for agents other than Claude Code (their history, state and resume); a basic card that runs them is in"), `CHANGELOG.md` (Unreleased › Sessions), and PRD §5 plus the epics overview to match.

**Acceptance Criteria:**
- Given `agents` with `kimi` and `qwen`, when the launch sheet opens, then its Agent select lists `claude`, `kimi` and `qwen` with `claude` first, and picking `kimi` hides model, effort, mode, worktree, add-dirs and prompt.
- Given no `agents`, when the launch sheet opens, then it looks exactly as it does in 0.2.0.
- Given a Claude session and an agent card under one project, when the MCP `sessions` tool lists that project, then only the Claude session is listed.

## Implementation Notes

- An agent start claims the sheet's proposed id like a Claude start (a stale sheet is refused; a failed start unclaims it).
- On Windows a bare `command` prefers a native `.exe` anywhere on PATH over an earlier `.cmd` shim; the batch refusal applies only when no native one exists.
- Help pages trimmed a few words in `sessions.md` and `terms.md` to stay under the 400-word limit.
- Manual check with real kimi/qwen not run here.

## Spec Change Log

## Review Triage Log

| # | Source | Finding | Verdict | Route | Evidence |
|---|---|---|---|---|---|
| 1 | blind, edge | `set_agents` inserted under `set_live_children`'s doc comment | low | patch | graph/mod.rs: the doc block now heads `set_agents`; `set_live_children` has none. |
| 2 | blind | Resolved env secrets kept in `AgentRun.spec`, printable via `Debug` | low | reject | No `{:?}` of a run anywhere; Claude spawn specs carry env the same way. |
| 3 | blind | Restart replays the first start's spec, not current settings | false | reject | Spec: Restart "re-runs the same agent, args and env". |
| 4 | blind | Batch refusal blocks npm-installed agents | false | reject | Operator confirmed Kimi and Qwen are separate exes; the refusal is in the frozen intent. |
| 5 | blind | Malformed `${env:…}` passes as a literal | low | reject | Typo only sends a wrong value to the agent; the fix adds a validation branch. |
| 6 | blind | Legend implies `ctrl+j` reaches agent cards | low | patch | legend.md says "selects the one that has waited longest" after "one of its nodes"; `goToNextAttention` is sessions only. |
| 7 | blind | Exit toast is the generic `finished` one | false | reject | Spec: "A toast follows the same rule as `finished`". |
| 8 | blind | `agents::stop` maps every error to "not running" | low | reject | `terms.stop` fails only when the terminal is gone or exited; fix adds a branch. |
| 9 | blind | Blank `command` not dropped at load | low | reject | Start refuses with `agent <name>: command is blank`; rare and visible. |
| 10 | blind | Duplicate check is case-sensitive | low | reject | `kimi` and `Kimi` both work as distinct agents; nothing breaks. |
| 11 | blind | terms.md Attention colour omits agent cards; unrelated rewording | low | patch | terms.md:20 lists sessions, edges, toasts only. Rewording was needed for the 400-word help limit, so only the entry is patched. |
| 12 | blind | Claude start wipes `launchDefaults.agent` | false | reject | Intended: the remembered choice is the last start's agent, and a Claude start is `claude`. |
| 13 | blind | Removing a project or quitting doesn't warn about running agents | false | reject | `project.remove` has no confirmation for anything (nodes.ts:188); agents match sessions. |
| 14 | blind | Stray `prompt:"…"` formatting in launch.test.ts | low | patch | Unrelated whitespace change in the diff. |
| 15 | edge | Concurrent starts with one id: loser's `take` drops the winner's run | low | reject | The sheet sends one start; needs two IPCs with one proposed id. |
| 16 | edge | Concurrent Restarts: loser's `restore` marks the new run exited | low | reject | Needs two Restarts within the spawn window; fix adds a CAS. |
| 17 | edge | `sync` reads `children()` outside the workspace lock; a stale list can win | medium | patch | agents.rs `sync` then `set_agents`: an exit and an acknowledge racing can leave a card reading `running` after it exited. |
| 18 | edge | A `.cmd` shim earlier on PATH refuses a later native `.exe` | medium | patch | `locate_program` uses `Search::locate`; `locate_native` exists for exactly this (detect.rs:86). |
| 19 | edge | Doc says an extensionless path resolves through PATHEXT; `locate_program` returns `Missing::File` | low | patch | ipc/mod.rs:1120; the doc comment and test claim behaviour the code lacks. Correct the doc and test. |
| 20 | edge | Agent start skips `launcher.claim` | medium | patch | ipc session_launch agent branch; the proposal stays unclaimed, so no stale-sheet guard and the id can be proposed again. |
| 21 | edge | Agent request with branch/worktree fields is accepted silently | low | reject | Only a crafted request; the branch sheet offers no Agent field. |
| 22 | edge | `term_close` on an agent terminal orphans the card | low | reject | `isClosableTerminal` allows session terminals only; needs a crafted IPC. |
| 23 | edge | `remove` drops the run when `close` fails | low | reject | `close` fails only for a running or plain terminal, both excluded above it. |
| 24 | edge | Secrets in `args` shown in Effective settings | low | reject | Env values exist for secrets; args are not meant to hold them. |
| 25 | verification | `revealAgent` toast click untested | medium | patch | No test references `revealAgent`. |
| 26 | verification, blind | `workspace_remove_project` forgetting agent runs untested | medium | patch | No remove-project test sets up a run. |
| 27 | verification | Re-layout's agent reset untested | medium | patch | Fixture drags but never re-lays out. |
| 28 | verification, blind | `with_agents` order and drop untested | medium | patch | No direct test. |
| 29 | verification | `startLaunch` selecting `{kind:"agent"}` untested | medium | patch | sessions.test.ts has no agent form case. |
| 30 | verification | `terminalOfTarget` agent branch untested | low | patch | ui.test.ts:503 covers session and project only. |

## Design Notes

Agent cards use their own `ChildKind` / `NodeKind` and their own runtime registry. They do not ride on `LiveMap`. As a session kind they would reach about 10 Claude-only paths (link source, review, fork, earlier, attach, inbox, the MCP facts, the poll's exit and eviction rules), and each would need an `isAgent` guard. With a separate kind the edge, peer and inbox checks refuse agents with no new code. Live count, glow and toasts are the three places that have to learn about agents explicitly.

Per-agent palette commands (**New kimi session**) and agent rows in the MCP `sessions` listing were split off to a follow-up (see deferred-work.md).

The epic said card positions are "stored keyed by node id". Because runs are never restored after a restart, a stored position could never be used again, so positions are kept in memory only.

## Verification

**Commands:**
- `cd src-tauri && cargo test` -- expected: passes, new tests included
- `npm test` -- expected: passes
- `npx tsc --noEmit` -- expected: no errors

**Manual checks:**
- Add `{"name":"kimi","command":"kimi","args":[]}` to `settings.json`, then press `n` on a project, pick `kimi` and Start. Kimi runs in a tab and the card reads `running`. Type `/exit` (or Ctrl+C) with the card unselected: the card turns the attention colour and the project glows.
