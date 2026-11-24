# Epic 12 Context: Daily use

<!-- Compiled from planning artifacts. Edit freely. Regenerate with compile-epic-context if planning docs change. -->

## Goal

Using 0.2.0 day to day, the operator hit four problems: `/clear` left the old card behind and added a new one, so session lists grew with every clear; other coding agents (Kimi Code `kimi.exe`, Qwen Code `qwen.exe`) could only be run by hand in a plain terminal and were invisible on the canvas; on a busy canvas related projects could not be kept together and found at a glance; and when something odd happened there was no record to look back at. This epic fixes them in that order: a cleared session keeps its card, other agents get basic cards, projects can be grouped into named frames, and an opt-in local activity recorder captures what happened. Stories 12.1 and 12.2 have landed; the agent-card requirement (FR-SESS-12) and the narrowed out-of-scope line are already in the PRD. The other new requirements (FR-SESS-11 following `/clear`, FR-CANVAS-9 project groups, FR-SYS-7 activity recorder) are added to the PRD's lists by their stories; until then the epic text is the source.

## Stories

- Story 12.1: A cleared session keeps its card
- Story 12.2: Agent cards for other coding agents
- Story 12.3: Project groups
- Story 12.4: The activity recorder

## Requirements & Constraints

- **Every new action is a registry command**, in the palette and bindable, and passes the command audit. Visible controls (toolbar, menus) are added beside keybindings, never instead of them.
- **No network.** No telemetry; nothing beyond what `claude` makes and the localhost MCP/hooks endpoints. Switchboard never writes under `~/.claude`.
- **`workspace.json` compatibility.** New fields only with serde defaults (the `agentActions` pattern), no schema bump: older files load, and 0.2.0 reads a file from this build ignoring the new fields.
- **Design.** Every new look is described in DESIGN.md and passes the design lint (tokens only, no colour literals, the accent allow-list is not extended).
- **Docs are deliverables.** Each story updates its help page(s), the README sections it touches, ROADMAP where relevant, and `CHANGELOG.md` Unreleased (Canvas for 12.3, Settings for 12.4).
- **Agent support stays basic.** Other agents get process state only: no history, hooks, MCP, busy/idle/waiting, resume, fork or edges, and their runs are not restored after a restart. Full support for any agent would be its own epic.
- **Recorder privacy (12.4).** Off by default, with a visible `rec` mark whenever on. Event types must be unable to carry prompt text, the system prompt, env values, terminal output or file contents (a test asserts it); tokens are never recorded. Screenshots capture only Switchboard's own webview with every `.terminal` element masked. Exports strip `agents` env values and show home paths as `~`. Nothing leaves the machine unless the operator sends the export.

## Technical Decisions

- **Stack.** React 19 + `@xyflow/react` canvas with custom node components; Zustand state; Rust (Tauri 2) owns the workspace model and all writes to `workspace.json`.
- **Cleared sessions (12.1, landed).** No re-key: a card keeps its stable node id and `SessionRef.clearedInto` lists the later real ids; hooks, the poll, discovery, resume/fork and MCP map real ids to the node id (`graph::node_id`, `current_id`). The recorder logs clears.
- **Agents (12.2, landed).** `settings.agents: [{ name, command, args, env }]`; agents run in a `TermKind::Agent` terminal (`agent:<uuid>`) tracked by the in-memory `AgentRuns` registry (`src-tauri/src/agents.rs`) and shown as `ChildKind::Agent` cards (positions memory only). They count toward a project's `N live`, take the attention colour on an unseen exit (`AgentMeta.attention`), and cannot be edge ends. Not yet in the MCP listing or the palette per agent (deferred).
- **Groups (12.3).**
  - Data: `groups: [{ id, label, color|null, collapsed, position|null }]` and `Project.groupId: string|null`. A project is in at most one group; removing a project drops it from its group; an empty group is deleted.
  - Rust owns every change through IPCs (`group_create`, `group_rename`, `group_set_color`, `group_collapse`, `group_add`, `group_remove`), each validating ids and writing once, with tests per IPC and per refusal.
  - Moving a group moves all members in one `nodes_move` write. Group labels follow the edge-label rules (blank refused, control characters stripped, cut to 60 characters).
- **Recorder (12.4).**
  - Settings: `recorder { enabled, screenshots: off|on-error|interval, interval_s ≥15, keep_days 1–90, max_mb 20–2000 }`, out-of-range values clamped with a banner. Start/Stop recording writes `settings.json` (the only setting the app writes besides first-launch detection).
  - Files: JSON lines in `recordings/<YYYY-MM-DD>.jsonl` beside `state.json`, screenshots in `recordings/<date>/<time>.png`. Events cover app start/stop, session lifecycle and re-key, agent runs, live-state changes, hook/MCP refusals, edge and group changes, banners, notices, IPC and frontend errors.
  - Writer: one Rust task on a bounded channel; a slow disk drops (and counts) lines rather than blocking the UI or a launch.
  - Retention: at start and hourly, oldest whole days first, only inside `recordings/`.
  - Capture method (Tauri/WebView2 API vs DOM render) is decided in the spec; any new dependency needs a justification there. A failed capture is one recorded line, never a banner.
  - Export: one `.zip` with the window's lines, referenced screenshots and a `README.txt` (app version, OS, sanitised settings).

## UX & Interaction Patterns

- **Group frame (12.3).** A 1-px `--border` rectangle behind the members and their expanded children, with fixed padding; label in mono `--text-xs` top-left; optional colour shown only as a 2-px left rule from a fixed set of muted **group colours** (never the accent). Dragging the label moves the group; clicking it selects the group. Dragging a member out never changes membership; only **Remove from group** does.
- **Group card (12.3).** Collapsed, a group is one project-sized card: label, `N projects`, summed `N live`, and the attention glow when any member session needs the operator. Enter toggles collapse; arrow keys visit it like a project card; `ctrl+j` into a collapsed group expands it first; collapse survives a restart.
- **Group commands (12.3).** **Add to group…** (`g`, node menu, toolbar `⋯`, palette) turns the palette into a pick list of groups plus **New group…**; **Remove from group**; **Go to group: <label>**; **Rename group…**, **Set group colour…**, **Delete group** (members kept, no confirmation).
- **Recorder (12.4).** A `rec` mark at the canvas's top-right with tooltip `Recording · <folder>`. **Export recording…** opens a small sheet (last 15 min, last hour, today, from–to; screenshots toggle). **Open recordings folder**. With the recorder never on, both say so in a notice.

## Cross-Story Dependencies

- 12.3's group card reuses the attention rule over member sessions and the existing hidden-ends rule for edges; its `N live` sum includes agent cards from 12.2.
- 12.3 adds **Group** to the Terms page and the frame and group card to What you see, beside 12.2's agent-card entries; the `node-anatomy` figure is unchanged.
- 12.4 records clears (12.1), agent runs and exits (12.2) and group changes (12.3), so it lands last; its export must strip the `agents` env values introduced by 12.2.
