# Epic 7 Context: The app as a tool for Claude

<!-- Compiled from planning artifacts. Edit freely. Regenerate with compile-epic-context if planning docs change. -->

## Goal

Make Switchboard something Claude itself can use. Every session the app launches gets a `switchboard` MCP server that points back at the app. Through it a session can see where it sits in the workspace, read the graph, start sibling sessions, link nodes, post a status line, message its peers and ask the operator for review. Every action that changes something still goes through the operator's approval. Without this, an agent knows only its own cwd and add-dirs and has no picture of the other work going on around it. This epic also finishes the cooperation story from Epic 6. That epic deferred the MCP `send`/`inbox` fallback and the inbox link notice to this one.

## Stories

- Story 7.1: MCP server with read tools
- Story 7.2: Act tools with approval
- Story 7.3: Peer inbox and nudge
- Story 7.4: Request review

## Requirements & Constraints

- **Server.** An MCP server runs inside the app over HTTP, bound to 127.0.0.1 only. Every app-launched session gets it through `--mcp-config` under the name `switchboard`. Each session has its own bearer token, and the token dies with the session. A wrong or expired token gets a 401 and is logged in diagnostics.
- **Read tools** (never prompt): `workspace()`, `node(id)`, `my_node()`, `peers()` and `sessions(project)`.
  - `my_node()` returns the node id, path, project, branch/worktree, peers with their labels, and add-dirs.
  - `workspace()` returns every project with its path, a summary of each live session (name, status, last line) and the edges. It must stay under 8 KB for a 10-project workspace.
- **Act tools:**
  - `start_session({project|branch, prompt, name, model, effort, permissionMode, addDirs, cooperateWithMe})`
  - `link(from,to,kind,label)` and `unlink`
  - `set_status(text)`
  - `request_review({summary, paths?})`
- **Approval.** Every act tool except `set_status` is gated by the app. The policy is `ask`, `allow for edge` or `allow all`, and it can be set per workspace to auto-allow.
  - Under `ask`, a toast shows exactly what will run (the argv) with Allow / Deny / Always-for-this-edge.
  - Deny returns an error the agent can read.
  - An "always" policy shows in the edge inspector, where the operator can revoke it.
  - `start_session` with `cooperateWithMe` creates a cooperate edge to the caller and returns the new node id.
- **Status line.** `set_status` text appears under the node's name until the next status change or the next `set_status`.
- **Peer messaging.**
  - `send(peer, text)` works only between sessions joined by a cooperate edge. Anyone else is refused with "not a peer".
  - `inbox()` returns each message once and clears it.
  - An unread badge appears on the receiving node.
  - The nudge is on by default. When a message lands for an `idle` session, the app injects `You have 1 message from "<peer>". Call switchboard.inbox.` + Enter, and the session goes `busy`.
- **Native messaging first.** Sessions are told to prefer native `SendMessage` to peers by name, with the inbox as the structured fallback. If the pending native check shows `SendMessage` does not deliver, the inbox nudge becomes the primary channel.
- **Review request.** `request_review` puts a review flag on the node and shows a toast. Clicking either one opens the review pane for that node with the listed paths selected. Until Epic 8 exists, it opens only the file list.
- **Should-haves:**
  - `open_in_review(path|diff spec)`
  - resources `switchboard://workspace` (the graph as JSON) and `switchboard://node/<id>/notes` (shared scratch notes per node)
- **Unchanged constraints:**
  - No network calls beyond localhost.
  - Nothing is written under `~/.claude`, and the app never reads credentials.
  - The app never adds `--dangerously-skip-permissions` on its own.
  - Everything shown to the human has a JSON twin available through MCP.
  - The Windows and Linux CI runners stay green.

## Technical Decisions

- **One MCP server for all sessions, inside the app.** It uses `rmcp` over streamable HTTP in the Rust `mcp/` module. There is no stdio bridge process per session. Tool calls land directly in the app's state. The token maps to the session's node, so `my_node()` and `peers()` take no identity argument.
- **Per-session config.** `claude/launch.rs` writes `<tmp>/<id>.mcp.json`:
  `{"mcpServers":{"switchboard":{"type":"http","url":"http://127.0.0.1:PORT/mcp","headers":{"Authorization":"Bearer <tok>"}}}}`
  It is passed as `--mcp-config`, sits beside the existing `--settings` hooks file, and is deleted when the session exits. The MCP server and the hooks router share the app port and token scheme. The env already carries `SWITCHBOARD_NODE` and `SWITCHBOARD_PORT`.
- **Approvals module.** The Rust `approvals/` module holds pending agent requests and the policy. It emits UI events and resolves a oneshot future per request, so an act tool awaits the operator's decision. The per-edge "always" policy needs a home: the edge or the workspace. Live approvals and inbox counts belong to runtime `live` state, which is never persisted.
- **Injection rules (reused from Epics 4 and 6).** Wait for `idle`, write a single plain line plus `\r`, and expect `busy` within 3 s. Never write multi-line text. Reuse Epic 6's per-session injection slot and its rule against injecting over an operator's draft.
- **Appended system prompt.** Epic 6 widened it with a peer block that ends `Prefer SendMessage to a peer by its name to coordinate.` and capped its values: control characters stripped, 120 characters per value, at most 5 peers. This epic adds the `switchboard` MCP fallback wording (`send`/`inbox`, plus `start_session`/`request_review`). The cooperate live-link injected line becomes `… Use SendMessage or switchboard.inbox to coordinate.`
- **Peer identity.** A peer's name is its live `--name`, else its transcript title, else its project label. Epic 6's open question still stands: is that the name `SendMessage` reaches for a resumed session (a resume passes no `--name`)? `send(peer, …)` resolution should use the same name rule.

## UX & Interaction Patterns

- Status stays ambient: colour and pulse, never a modal. The one exception is an approval toast with inline buttons.
- Use plain text for status lines, badges and flags. An unread badge and a review flag sit on the node. The `set_status` text sits under the node name.
- Approval toasts show the exact argv. Read tools never prompt, to avoid approval fatigue. The per-edge "always" lets the operator trust a link without allowing everything.
- Every new action (revoke policy, open review, clear flag) is registered in the command palette first.

## Cross-Story Dependencies

- 7.1 (server, tokens, `--mcp-config`) underlies 7.2–7.4.
- 7.2 builds `approvals/`, which 7.3's `send` and 7.4 may reuse. Its "Always for this edge" and `cooperateWithMe` reuse Epic 6's cooperate edges and edge inspector.
- 7.3 completes the cooperation work Epic 6 deferred: the inbox link notice for live links, plus the MCP fallback wording in the system prompt and in the injected line. Its nudge reuses Epic 6's injection slot and Epic 4's status machine. The native `SendMessage` check from Story 6.4 was still not done when Epic 6 closed. Its result decides whether the inbox is the fallback or the primary channel.
- 7.4's click target is Epic 8's review pane. Until Epic 8 exists, 7.4 falls back to a file list.
