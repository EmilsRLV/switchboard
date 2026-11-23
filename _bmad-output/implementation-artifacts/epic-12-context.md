# Epic 12 Context: Daily use

<!-- Compiled from planning artifacts. Edit freely. Regenerate with compile-epic-context if planning docs change. -->

## Goal

Using 0.2.0 day to day, the operator ran into four problems. `/clear` leaves the old card behind and adds a new one, so session lists grow with every clear. Other coding agents (Kimi Code `kimi.exe`, Qwen Code `qwen.exe`) can only be run by hand in a plain terminal and do not appear on the canvas. On a busy canvas there is no way to keep related projects together. And when something odd happens there is no record to look back at. This epic fixes them in that order: a cleared session keeps its card, other agents get basic cards, projects can be grouped, and there is an opt-in local activity recorder. The new requirements (following `/clear`, agent cards, project groups, activity recorder) are not in the PRD yet. Each story adds its own requirement to the PRD's lists when it is picked up, and the epic text is the source until then.

## Stories

- Story 12.1: A cleared session keeps its card
- Story 12.2: Agent cards for other coding agents
- Story 12.3: Project groups
- Story 12.4: The activity recorder

## Requirements & Constraints

- **Rules from earlier epics still apply.** Every new action is a registry command (in the palette and bindable) and passes the Story 9.4 command audit. Nothing uses the network: no telemetry and no network calls beyond `claude` itself and the localhost MCP/hooks endpoints. Switchboard never writes under `~/.claude`. Each new look is described in DESIGN.md and passes the design lint (no colour literals, tokens only, and the accent allow-list is not extended).
- **`workspace.json` compatibility.** New fields are added only with serde defaults, following the `agentActions` pattern, and there is no schema bump. Older files load, and 0.2.0 reads a file from this build and ignores the new fields.
- **Scope reversal (12.2).** Agents other than Claude Code were Not planned. They now get **basic** support only: Switchboard starts the program in its own terminal and tracks the process. There is no history reading, no hooks or MCP for the agent, no busy/idle/waiting state, and no resume or fork. Full support for any one agent would be a separate epic. ROADMAP, PRD §5 and the epic overview's "Left out on purpose" must all be updated to say this.
- **Privacy (12.4).**
  - The recorder is off by default. A visible `rec` mark shows whenever it is on.
  - Event types must not be able to carry prompt text, the system prompt, env values, terminal output or file contents, and a test asserts this. Tokens are never recorded.
  - Screenshots capture only Switchboard's own webview, with every `.terminal` element masked.
  - Exports remove `agents` env values and show home paths as `~`.
  - Nothing leaves the machine unless the operator sends the export.
- **Agent env secrets (12.2).** The settings pane shows env **names**, never their values. `${env:NAME}` keeps a token out of the file. The docs say that literal values are stored in plain text.
- **Docs are deliverables.** Each story updates its help page(s), the README sections it touches, ROADMAP where relevant, and the `Unreleased` section of `CHANGELOG.md` (Sessions for 12.1 and 12.2, Canvas for 12.3, Settings for 12.4).

## Technical Decisions

- **Re-key on `/clear` (12.1).**
  - **Launched sessions (with a token).** A hook `SessionStart` with `source: "clear"` and a new `session_id` makes Rust move everything from the old id to the new one in one step: the token, live state, the terminal (the id stays `session:<old>` internally but resolves from both ids), the `sessions[]` entry and every edge end. This is one write and one snapshot broadcast. Any other `source` changes nothing. Today `Hooks::check_session_id` in `claude/hooks.rs` only records an alias.
  - **Pure function.** `rekey(workspace, old, new)` lives in `src-tauri/src/graph/`, with a test per field kind it touches and one for an id that appears nowhere.
  - **Unlaunched sessions (poll-only).** They are re-keyed from two `agents --json` polls with the same `pid` and `cwd` where the old id has disappeared. This is a pure function with tests. A row with no `pid` is never re-keyed.
  - **Clear chain.** It is stored as `previousIds: string[]` on the `sessions[]` entry, and discovery hides those transcripts. Resuming one takes it out of the chain. Sessions cleared before this build are not merged.
- **Agents (12.2).**
  - **Settings shape.** `settings.json` gets `agents: [{ name, command, args, env }]`, validated in `src-tauri/src/settings/`. A blank, duplicate or `claude` name drops that entry, as does a bad env name or one in `PARENT_SESSION_VARS`, and each drop shows a banner.
  - **Command resolution.** `command` resolves like `claude.path` (absolute path, `~/`, or PATH with PATHEXT). On Windows `.cmd`/`.bat` files are refused. Nothing runs at load.
  - **Spawning.** The program starts with separate arguments, never a shell string. It runs in the project folder under a new `TermKind::Agent` in `pty/mod.rs`. Its environment is the inherited one minus `PARENT_SESSION_VARS`, plus the agent's env, `TERM`, `COLORTERM` and `SWITCHBOARD_NODE`. It gets no settings file, MCP config or system prompt.
  - **Persistence.** Agent cards are not restored after a restart. `workspace.json` stores only a moved card's position, keyed by node id.
  - **MCP.** The MCP listing shows agent cards as `kind: "agent"`. `send` and the act tools refuse them with `not a Claude session`.
- **Groups (12.3).**
  - **Data.** `workspace.json` gets `groups: [{ id, label, color|null, collapsed, position|null }]` and `Project.groupId`. A project is in at most one group, and an empty group is deleted.
  - **Ownership.** Rust owns every change through IPCs (`group_create`, `group_rename`, `group_set_color`, `group_collapse`, `group_add`, `group_remove`). Each one validates ids and writes once, with tests per IPC and per refusal.
  - **Moving.** Dragging a group moves all its members in one `nodes_move` write. Labels follow the edge-label rules: blank is refused, control characters are stripped, and labels are cut to 60 characters.
- **Recorder (12.4).**
  - **Settings.** `settings.json` gets `recorder { enabled, screenshots: off|on-error|interval, interval_s ≥15, keep_days 1–90, max_mb 20–2000 }`. Out-of-range values are clamped with a banner. Start/Stop recording writes `settings.json`, and this is the only setting the app writes.
  - **Files.** Each event appends JSON lines to `recordings/<YYYY-MM-DD>.jsonl` beside `state.json`. Screenshots go to `recordings/<date>/<time>.png`.
  - **Writer.** It is one Rust task on a bounded channel. Lines are dropped and counted instead of blocking the UI or a launch.
  - **Retention.** It runs at start and then hourly, deleting the oldest whole days first and only inside `recordings/`.
  - **Screenshot capture.** The spec decides between a Tauri/WebView2 API and a DOM render, and any new dependency needs a justification there. A failed capture is recorded as one line, never shown as a banner.
  - **Export.** It writes a `.zip` with the lines in the chosen window, the screenshots they reference, and a `README.txt` (app version, OS, sanitised settings).

## UX & Interaction Patterns

- **Cleared session (12.1).** The card stays where it is and keeps its label and edges. Its tooltip and its row in Select session / `ctrl+j` say `cleared N times`. **Earlier transcripts…** (node menu and palette) lists the earlier transcripts newest first, and Resume on one uses the existing Resume.
- **Agent launch (12.2).** The launch sheet gains an **Agent** field first, shown only when agents exist. Choosing an agent hides the Claude-only fields and keeps Name (`<agent>-<4 hex>`) and Start in background. The project remembers its last agent in `launchDefaults`. Each agent also gets a **New <agent> session** palette command. A failed start keeps the sheet open with the reason.
- **Agent card (12.2).**
  - **Look and state.** It uses the session-card look plus a mono **agent chip** (new in DESIGN.md). Its state is `running` or `exited (<code>)`, and it counts toward `N live`.
  - **Attention.** An unseen exit gets the attention colour and glow, as `finished` does.
  - **Commands.** term, Stop (Ctrl+C, a second Ctrl+C after 300 ms, kill after 5 s), Restart (same tab), and Remove (exited cards only).
  - **No edges.** The card has no Link to… and cannot be an edge end.
- **Group frame (12.3).**
  - **Look.** A 1-px `--border` rectangle around the member cards and their children, with padding. The label is in mono `--text-xs` at the top-left.
  - **Colour.** Optional, shown only as a 2-px left rule, from a fixed set of muted **group colours** (new in DESIGN.md). It is never the accent.
  - **Interaction.** Clicking the label selects the group. Dragging a member out of the frame never changes membership.
- **Group card (12.3).** A collapsed group is drawn as a project-sized card showing the label, `N projects`, the total `N live`, and the attention glow when any member needs the operator. Enter toggles collapse, and the arrow keys visit the card. Jumping with `ctrl+j` into a collapsed group expands it first. The collapsed state survives a restart.
- **Group commands (12.3).** Add to group… (`g`), which shows a palette pick list plus New group…, and Remove from group. Go to group: <label>, Rename group…, Set group colour… and Delete group (no confirmation, members kept).
- **Recorder (12.4).** A `rec` mark sits at the canvas's top-right, with the tooltip `Recording · <folder>`. Export recording… opens a small sheet with presets (last 15 min, last hour, today, from–to) and a screenshots toggle. Open recordings folder opens the folder. If the recorder was never on, a notice says so.

## Cross-Story Dependencies

- 12.4 records re-key events from 12.1, agent names and exits from 12.2, and group changes from 12.3, so it lands last.
- 12.2 extends Story 4.2's launch sheet and `.cmd` refusal, Story 3.3's attention and glow rule, and Story 7.1's MCP listing.
- 12.3's group card reuses Story 3.3's attention rule over its members and the existing hidden-ends rule for edges. 12.2 and 12.3 both add entries to the Terms and What you see pages.
- 12.1 builds on Story 4.3's hooks token, Story 3.1's discovery, Story 3.2's live poll and Story 4.4's Resume.
