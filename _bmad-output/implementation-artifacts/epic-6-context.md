# Epic 6 Context: Edges: context and cooperation

<!-- Compiled from planning artifacts. Edit freely. Regenerate with compile-epic-context if planning docs change. -->

## Goal

Let the operator connect nodes on the canvas and make every connection actually do something for the sessions involved. A **context** edge means "you may also work in there" and becomes directory access: `--add-dir` at launch, or `/add-dir` injected into a live session, with an honest "restart with flags" fallback. A **cooperate** edge between two sessions tells each one that the other exists, what the link is for, and how to reach it, so that parallel work across repos can be coordinated without the human passing messages along. Edges must never be decorative: the operator can always see whether an edge's effect is applied, pending or failed.

## Stories

- Story 6.1: Draw and persist edges
- Story 6.2: Context edges at launch
- Story 6.3: Context edges on live sessions
- Story 6.4: Cooperation edges

## Requirements & Constraints

- **Two edge kinds, drawn differently.** Context edges are dashed and run from a session or a project to a project, branch or folder. Cooperate edges are a solid double line between two sessions. Invalid pairs (for example project→session) are refused with a hint. Project→project is a valid context edge (open decision 1, resolved).
- **Create, label, delete.** Edges are created by dragging from a node handle or through the palette ("link to…"), and `e` starts an edge from the keyboard. Selecting an edge lets the operator set a free-text label and delete it with Del. Kind, label and deletion all persist in the workspace file. The label is the link's stated purpose and is shown to both sessions.
- **Context at launch.** A context edge on a session that has not started yet becomes `--add-dir <path>`. A context edge on a project node is the default `--add-dir` for every future session started on that project. The launch sheet's add-dirs field is prefilled from these edges, and resuming a historic session that has a context edge applies the same `--add-dir`.
- **Context on a live session (experimental):** wait until the session is `idle`, then inject `/add-dir <path>` followed by Enter, and show the edge as "pending". Mark it "applied" once acceptance is detected (from the hook or transcript record, or a busy→idle cycle within 3 s). If injection fails, or the session stays `busy` for more than 60 s, the edge inspector offers "Restart with flags": stop the session and `--resume` the same id with the new `--add-dir`. Ship both paths. Restart is always offered.
- **Edge inspector:** shows what the edge currently means: flags applied, pending, or failed.
- **Cooperation, sessions not yet started:** each session's appended system prompt names the peer (its `--name`), the peer's node path and the edge label, and tells the session to prefer `SendMessage` to that peer, with `switchboard` MCP `send`/`inbox` as the fallback. Both session tokens are allowed to `send` to each other.
- **Cooperation, live sessions:** linking puts a link notice in both inboxes. Each `idle` session is also sent one injected line: `A new peer session "<name>" is linked to you (<purpose>). Use SendMessage or switchboard.inbox to coordinate.`
- **Native messaging check:** verify by hand that `SendMessage` by name reaches an idle peer. If it does not, record that, and the inbox nudge (Story 7.3) becomes the primary channel.
- **Injection safety:** PTY injection only ever writes `/add-dir <path>` or a single plain-text line to an idle session, never multi-line scripts.
- **Unchanged constraints:** nothing is written under `~/.claude`. No network calls beyond localhost. Rust owns workspace state and broadcasts changes. Everything is reachable from the palette. The Windows and Linux CI runners stay green.

## Technical Decisions

- **Data model (already in the workspace schema):** `Edge { id, from: NodeRef, to: NodeRef, kind: context|cooperate, label?, createdAt }` and `NodeRef { type: project|branch|session|folder, id }`. `folder` is an ad-hoc path target that is not a node. Edges are persisted. Live edge state (pending/applied/failed) is runtime only and is never persisted.
- **Edge semantics resolver** lives in the Rust `graph/` module and maps edges to launch flags or live actions. Launch (`claude/launch.rs`) builds argv from node, edges and launch sheet. `--add-dir` takes one or more paths, which are passed as-is because Claude normalises them.
- **Current launch builder:** only a New launch passes `--add-dir`. Resume and Fork pass none, so Story 6.2 (resume) and 6.3 (restart with flags) must extend that. The appended system prompt is currently "at most six lines, no instructions". The plan expects about 10 lines with peers and their purpose and a SendMessage/MCP hint, so 6.4 has to widen it. Control characters must still be stripped from every value.
- **Injection mechanics:** wait for `idle`, write the text plus `\r`, and expect `busy` within 3 s. Otherwise mark the edge action failed and offer the restart path. This depends on the status state machine (hooks plus the `agents --json` fallback) from Epic 4.
- **Frontend:** `@xyflow/react` custom edges `ContextEdge` (dashed) and `CooperateEdge` (solid double line). Handles are visible only on hover or keyboard focus. The existing "forked from" line is a derived visual and not an edge kind, so it must not be confused with stored edges. All mutations go through Tauri commands.
- **MCP:** the `switchboard` MCP server and `--mcp-config` are not built yet (Epic 7). Per-session bearer tokens and the `send` permission between peers belong to it.

## UX & Interaction Patterns

- Low chrome: 1-px lines, monochrome, one accent reserved for attention. The edge style (dashed or double) carries the kind, not colour.
- The edge inspector slides in from the right like other panes and closes with Esc. It states plainly what the edge does now, and offers "Restart with flags" when injection failed or timed out.
- A refused edge drop shows a brief inline hint, never a modal.

## Cross-Story Dependencies

- 6.1 (the edge model, drawing and persistence) underlies 6.2–6.4.
- 6.2 uses Epic 4's launch sheet and resume path. 6.3 uses Epic 4's PTY, hook-driven status and stop/resume. Branch targets come from Epic 5's branch nodes.
- 6.4's MCP `send`/`inbox` fallback and the inbox link notice depend on Epic 7 (the MCP server in 7.1, the inbox in 7.3). Before then, only the system-prompt peer info, the injected one-liner and native `SendMessage` can work. 7.2 later reuses cooperate edges for `cooperateWithMe` and the "Always for this edge" approval policy.

## Open decisions

1. ~~**Project→project context edges.**~~ **Resolved in Story 6.1 (Emils' decision):** project→project is a valid context edge, overriding the story's "project→project refused" example. Folder targets come with Story 6.2.
2. ~~**"Applied" detection for `/add-dir`.**~~ **Resolved in Story 6.3 (Emils' decision):** the transcript's `<local-command-stdout>` record (`Added … as a working directory` / `already accessible`) within 10 s; busy/idle cycles are not used because `/add-dir` is a local command. Original note: The plan describes it as a busy→idle cycle within 3 s, while the injection rule says `busy` within 3 s. Pick one signal, and check which hook or transcript record (if any) confirms an accepted directory.
3. **Live-session inbox notice before Epic 7.** Decide whether 6.4 builds a minimal inbox or defers the notice until 7.3.
