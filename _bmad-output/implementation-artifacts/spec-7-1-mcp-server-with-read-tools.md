---
title: 'Story 7.1: MCP server with read tools'
type: 'feature'
created: '2026-10-24'
status: 'in-review'
route: 'dispatch'
review_loop_iteration: 0
baseline_commit: '8b1bd69fd8e355fdcb9dc1d4692560000a93e794'
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-7-context.md'
  - '{project-root}/docs/research/claude-code-integration.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** A session the app launches cannot see the graph it sits in. It cannot see its node, branch, peers, the folders it was granted, or the other projects and sessions. So it cannot plan work across repos without the operator explaining the layout.

**Approach:** The app serves a `switchboard` MCP endpoint at `POST /mcp` on its existing localhost hooks server. Each app-launched session gets it through `--mcp-config`, with the session's existing bearer token. The token identifies the caller, so the read tools take no identity argument. The tools answer from the app's live state.

**Decisions:**
- **Transport.** The endpoint is streamable HTTP in stateless JSON mode:
  - Each POST carries one JSON-RPC message and gets one `application/json` reply.
  - There is no SSE stream and no session id, so the hooks server's 10 s idle close and 64-connection cap are fine.
  - Supported calls: `initialize`, `notifications/*` (202, no body), `tools/list`, `tools/call` and `ping`.
  - Anything else gets a JSON-RPC "method not found" error.
- **Auth.**
  - The endpoint uses the same per-session token as the hooks, and the token dies with the session.
  - A missing, wrong or expired token gets a 401 with no body.
  - The refusal is counted in a new `mcpRefused` diagnostics counter, and kept in a ring of the last 20 refusals.
  - Each ring entry records the time, the path and the reason (`missing token` / `unknown token`). It never records any part of the token.
  - The Settings diagnostics show the counter and the last refusals.
- **Launch.**
  - When the endpoint is up, every launch (New, Resume, Fork) writes `<session dir>/<id>.mcp.json`: `{"mcpServers":{"switchboard":{"type":"http","url":"http://127.0.0.1:<port>/mcp","headers":{"Authorization":"Bearer <token>"}}}}`.
  - The file is written beside `<id>.settings.json` with the same exclusive 0600 creation, and is removed at the same points.
  - The launch passes `--mcp-config <file>`.
  - When the endpoint is down, there is no file and no flag.
  - `--strict-mcp-config` is not used, so the operator's own MCP servers stay available.
- **No permission prompts for read tools.** The per-session settings file gains `"permissions":{"allow":["mcp__switchboard__<tool>", …]}` for exactly the read tools, so they never ask.
- **Tools:**
  - `my_node()` returns:
    - `{nodeId, name, path, project{id,label,path}, branch, worktree, cwd, peers[{nodeId,name,path,purpose}], addDirs[{path, via}]}`
    - `branch` is the session ref's branch, else the branch of the live cwd.
    - `worktree` is the cwd when it is a linked worktree, else `null`.
    - `addDirs` are the add-dirs this launch was given, recorded at launch, plus context edges applied live (6.3), each with `via` (`sheet`, `edge → <target>` or `/add-dir`).
  - `workspace()` returns:
    - `{projects[{id,label,path,sessions[{nodeId,name,status,lastLine}]}], edges[{id,kind,from,to,label}]}`
    - Only live sessions are listed under their projects. `lastLine` is cut to 120 characters.
    - There are no positions, viewport or historic sessions.
    - A 10-project workspace with 3 live sessions each and 10 edges stays under 8 KB.
  - Every tool result is a single `text` content item holding compact JSON. An error is `isError: true` with a plain message.
- **Hand-rolled MCP, not `rmcp` (Emils' decision; replaces architecture A4's crate choice).** A small JSON-RPC handler in a new `mcp/` module on the existing axum router. No new crate.
- **All five read tools (Emils' decision).** The tools are `my_node()`, `workspace()`, `node(id)`, `peers()` and `sessions(project)`:
  - `node(id)` returns a project node's `{id,label,path,branch}` or a session node's `{nodeId,name,status,lastLine,project,branch}`, and an `isError` result for an unknown id.
  - `peers()` is `my_node().peers`.
  - `sessions(project)` lists that project's live and historic sessions (`nodeId`, `name`, `status`, last activity). The project is given by id or label; an unknown project gives `isError`.
  - All five are in `permissions.allow`.
- **Hidden from the operator's other sessions.** Only app-launched sessions get the config. Nothing is written under `~/.claude`.

## Boundaries & Constraints

**Always:**
- Bind to 127.0.0.1 only. Rust state is the source.
- Read tools never change state.
- No `~/.claude` writes. Tests never run the real `claude`, and they call the endpoint over a real ephemeral port, as the hooks tests do.
- Both CI runners stay green (once Actions resumes).

**Never:**
- Act tools, approvals, `send`/`inbox`, `request_review` and resources (Stories 7.2–7.4).
- Changing the 6.4 prompt wording.
- `--dangerously-skip-permissions`.
- Logging token values.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|---|---|---|---|
| my_node | live session on branch `feat` worktree, one cooperate peer, one context edge | nodeId, project, branch `feat`, worktree path, peer with label, addDir `via edge → ui` | — |
| workspace | 10 projects × 3 live sessions, 10 edges | every project with path, sessions with name/status/lastLine, edges; < 8 KB | — |
| Wrong token | `Authorization: Bearer nope` | 401, `mcpRefused` +1, ring entry `unknown token` | no body |
| Expired token | token of an exited session | 401, entry `unknown token` | — |
| No header | POST /mcp without auth | 401, entry `missing token` | — |
| initialize | client sends `initialize` | serverInfo `switchboard`, tools capability | — |
| Unknown tool | `tools/call` `nope` | `isError: true`, "unknown tool" | — |
| Endpoint down | bind failed | no `.mcp.json`, no `--mcp-config` | launch still works |

</frozen-after-approval>

## Code Map

**Rust (`src-tauri/src/`):**
- `claude/hooks.rs`:
  - `router()` (:394-408): add `.route("/mcp", post(mcp::handle))` before the fallback.
  - Auth: reuse `bearer()` (:411) and `Hooks::session_for` (:331).
  - `refuse()` (:495) shows the 401 path. Add the `mcp_refused` counter and the refusal ring to `Inner` and `DiagnosticsSnapshot` (:233-247, `diagnostics` :348).
  - `Ctx` needs read access to app state, for example an `AppHandle` or a reader closure like `Apply`.
  - Body reading is manual (`read_body` :464), since there is no json extractor.
  - `settings_json` (:183-199) gains the `permissions.allow` list.
- New `mcp/mod.rs`: JSON-RPC dispatch, the tool list with input schemas (empty objects), and the tool functions.
  - Data sources:
    - `graph::session_peers` (graph :1870) and `cooperate_peers` (:1800);
    - `LiveMap.sessions` (live.rs:231, with `name`/`state`/`last_line`/`project_id`/`cwd`);
    - `Workspace` projects and edges (graph :54, :174);
    - branch via `ref_branch` (ipc :1507) and `branch_for_cwd` (graph :630);
    - worktrees: `WorkspaceState.worktrees`;
    - live-applied dirs from `LiveEdges::snapshot` (live_edges.rs :160, `EdgeLive.path`).
- `claude/launch.rs`:
  - `--mcp-config` beside `--settings` (`build_args` :444-483).
  - Remove the "stays out until Epic 7" note (:14) and flip the absence test (:925).
  - The `mcp_path` file goes beside `settings_path` (:704), with the same creation (:715-728) and removal (:832, :842).
- `ipc/mod.rs` `run_launch` (:1616):
  - write the MCP file next to the settings file (:1663-1679);
  - record the launch's add-dirs per session in a new runtime map (removed at exit, :1756-1766);
  - forget on failure (:1653).
- `ipc/mod.rs` `diagnostics_get` (:914).

**Frontend:** `src/ipc/index.ts` (:356 type), `src/components/diagnostics.ts` (:22 rows) and `SettingsPane.tsx`: the `mcpRefused` row and the last refusals.

**Tests:**
- hooks.rs helpers `http()` (:721) and `server_with()` (:758); the model is the 401 test at :913.
- lib.rs `hook_posts_drive_a_launched_session_and_its_token_dies_with_it` (:1624) shows how to read the token from the settings file and how to check 401 after exit.

## Tasks & Acceptance

**Execution:**
- [x] `mcp/mod.rs`, `claude/hooks.rs`, `lib.rs` (+tests): JSON-RPC over `/mcp`, auth, the refusal counter and ring, and the tools.
- [x] `claude/launch.rs`, `ipc/mod.rs` (+tests): the `.mcp.json` file and `--mcp-config`, `permissions.allow`, and the per-session launch add-dirs record.
- [x] `src/ipc/index.ts`, `src/components/diagnostics.ts`, `SettingsPane.tsx` (+vitest): diagnostics rows.
- [x] `README.md`, `docs/research/claude-code-integration.md`, `docs/DESIGN.md` if the UI changes: tools, auth, files, and the pending trust-prompt check.

**Acceptance Criteria:**
- Given an app-launched session (stub) and its token, when `tools/call my_node` is POSTed to `/mcp`, then the reply holds its node id, path, project, branch/worktree, peers with labels and add-dirs.
- Given a 10-project workspace with 3 live sessions per project and 10 edges, when `workspace()` is called, then the JSON lists every project path, the live session summaries and the edges, in under 8192 bytes.
- Given a wrong or expired token, when it posts to `/mcp`, then the reply is 401 and the diagnostics show the counter and a ring entry without the token.
- Given `cargo test`, `clippy -D warnings`, `npm test` and `tsc --noEmit`, when they run, then all pass.

## Implementation Notes

- **Wire names.** The diagnostics fields follow the existing snake_case `DiagnosticsSnapshot`: `mcp_refused` and `mcp_refusals[{at, path, reason}]` (newest first). The ring entry never holds the token.
- **Edge ends** in `workspace()` are compact strings `<type>:<id>` (`session:<id>`, `project:<id>`, `branch:<pid>:<name>`, `folder:<path>`). With `{type,id}` objects, a realistic 10×3×10 workspace was already about 8.1 KB.
- **8 KB guarantee.** `workspace()` cleans session names, project labels and edge labels and caps them at 120 characters (`launch::peer_value`). It builds the payload once, under one pass of locks, then shortens it in place while it is over 8000 bytes, in three steps:
  1. last lines cut to 40 (`lastLinesCut: 40`);
  2. last lines left out (`lastLinesCut: "omitted"`);
  3. edge labels left out (`truncated: true`).

  The realistic fixture (a third of the sessions finished, long paths, uuids) is 7794 bytes with no cut.
- **Refusals.** 413 and 408 on `/mcp` count as MCP refusals (`body too large`, `read timeout`), not in the hooks `refused` counter.
- **Errors.** A panicking tool gives JSON-RPC -32603 with the request id.
- **Protocol versions.** Only `2025-06-18` and `2025-03-26` are offered.
- **`node(id)`** accepts `project:` and `session:` prefixes.
- **`sessions(project)`** orders by parsed time; a label two projects share is an error.
- **`--mcp-config` placement.** It goes right after `--settings <file>`, through `launch::with_mcp_config`, added in `run_launch` only when the endpoint port is up and the file was written. `build_args` is unchanged.
- **`via`.** A launch add-dir that one of the context edges the launch draws on grants is `edge → <target label>`: the project's edges for New, and the session's own (or the original's) plus the project's for Resume and Fork. Any other add-dir is `sheet`. A context edge applied live (6.3) is `/add-dir`. An entry applied to the session's own folder is skipped.
- **Non-POST** on `/mcp`, once authenticated, is 405 with `Allow: POST`. This lets a client that probes for an SSE stream with GET get the answer the MCP spec allows. Auth is checked first, so an unauthenticated GET is still 401.
- **`sessions(project)`** returns `{project{id,label,path}, sessions[…]}`, live first, then by `lastActive` descending. A live-only session's `lastActive` is its start time.

- 2026-10-24 GUI pass (orchestrator, scratch projects `alpha`/`beta`, stub `claude`). A background session on `alpha` wrote `<id>.settings.json`, whose `permissions.allow` lists the five `mcp__switchboard__*` tools, and `<id>.mcp.json`; the stub's command line carried `--settings <file> --mcp-config <file>`. Calls with curl on 127.0.0.1 using the file's token:
  - `initialize` returned serverInfo `switchboard` and protocol `2025-06-18`;
  - `tools/list` returned the five read-only tools;
  - `my_node` returned nodeId, name `alpha-60d6`, path `alpha:master / alpha-60d6`, project, branch `master`, worktree null, no peers and no addDirs;
  - `workspace` returned both projects with paths and the live session (`idle`).
  A bad token and a missing header each got 401. Settings → Diagnostics showed `MCP refused requests 2` with `17:30:19 /mcp — missing token` and `… unknown token`, and no token text. The driver force-kills the app, so the session's two files stayed behind (the startup sweep covers that); the orchestrator deleted them.

- 2026-10-24 GUI re-run after the patch round (orchestrator, same setup):
  - `initialize` offered `2025-06-18`;
  - `my_node` returned the session (`alpha:master / alpha-9e3c`);
  - `sessions({project:"alpha"})` listed the live session `idle` with `lastActive`;
  - an authenticated GET got 405 and a bad token 401.
  Diagnostics showed `MCP refused requests 1`, with the hooks `refused requests` still 0, under the visible caption `RECENT MCP REFUSALS` and `17:43:02 /mcp — unknown token`. The orchestrator deleted the leftover session files after the forced kill.

## Spec Change Log

## Review Triage Log

Round 1 (blind-hunter B, edge-case-hunter E, verification-gap V):

**Patch:**
- P1 (medium; B, E) The 8 KB limit holds only for fixture-sized values. Session names, project labels and edge labels are unbounded and keep control characters. Clean and cap them to 120 characters as `launch::peer_value` does. If the result is still over budget after last lines are dropped, also drop edge labels and set `truncated: true`. Build the payload once under the locks and shorten it in place, not with three rebuilds.
- P2 (low; B, E) `lastLinesCut: 0` for "dropped entirely" reads like a zero cut. Use `"omitted"`. Test the drop-entirely branch.
- P3 (low; B, E, V) A 413 or 408 on `/mcp` is counted in the hooks `refused` counter. Count it in `mcp_refused` and the ring (`body too large` / `read timeout`). Test it.
- P4 (low; E) An authenticated non-POST with a large declared body is drained up to the cap and kept alive. Skip draining past `DRAIN_CAP` and reply `Connection: close` on the 405. Test the `Allow: POST` header.
- P5 (low; B) `node(id)` refuses the `session:<id>` and `project:<id>` ends that `workspace()` lists. Accept and strip that prefix. Branch and folder ends get a clear "not a project or session node" error.
- P6 (low; B, E) `sessions(project)`:
  - Order by parsed time, not by comparing strings.
  - Document the `exited` status alongside `historic`.
  - Prefer live activity over a stale transcript time for a live session.
  - An ambiguous label (two projects with the same label) is an error that names the ids.
- P7 (low; E) A panic in a tool returns a bare 500. Return a JSON-RPC `-32603` error with the request id.
- P8 (low; B) `PROTOCOL_VERSIONS` claims `2025-11-25` and is out of order. List only the versions the handler meets, newest first. Reply with the client's version when it is listed, else the newest.
- P9 (low; B) Docs:
  - The README's "Limits worth knowing" now says the session token also grants read access to the whole graph (paths, other sessions' names and last lines).
  - Record that `Origin`, `Accept` and `MCP-Protocol-Version` are not checked (non-browser clients, bearer token required), and that an unknown tool is an `isError` result by design.
  - `docs/DESIGN.md` describes the diagnostics refusal list. The list gets a visible caption ("Recent MCP refusals").
- P10 (low; B) `launch_add_dirs` checks folders on disk even when the endpoint is down. Skip it when there is no port.
- P11 (medium; V) Tests:
  - the 6.2 launch/resume/fork test asserts `launcher.add_dirs_of` gives `via: edge → <label>` for edge-granted folders;
  - an endpoint-up Resume after a leftover `<id>.mcp.json` succeeds, rewrites the file and passes `--settings … --mcp-config …`;
  - `my_node` worktree fallbacks: chips only, stored `worktree_path` only, and a `missing` chip skipped.
- P12 (low; orchestrator, after the patch round) The release profile has `panic = "abort"`, so P7's `catch_unwind` only works in debug builds. The module doc and the README now say so (orchestrator edit).

**Defer:**
- (low; B) No render test for the Settings diagnostics list (there is no DOM test environment). The GUI pass showed it.

**Reject:**
- (E) Duplicate peers: false. `add_edge` refuses a second edge between the same pair (`is_duplicate_edge`).
- (E) Context edges changing between `prepare_launch` and `run_launch`: a millisecond window, and the label is informational.
- (E) `worktree` is the worktree root, not the cwd, when the cwd is a subfolder: the root is what identifies the worktree. The cwd is returned separately as `cwd`.
- (B) `additionalProperties: false` is not enforced: extra arguments are harmless for read tools.

## Verification

**Commands:**
- `cd src-tauri; cargo test; cargo clippy --all-targets -- -D warnings` -- expected: pass, clean
- `npx vitest run; npx tsc --noEmit` -- expected: pass, clean
- `npm run tauri build -- --debug --no-bundle` -- expected: builds

**Manual checks:**
- **Orchestrator, foreground-guarded, stub `claude`:** start a session. The stub prints its argv, which should contain `--mcp-config <file>`. Then POST `tools/call my_node` with the token from that file via `curl` to 127.0.0.1, and POST a bad token to see the diagnostics row.
- **Emils, real `claude`:**
  - `/mcp` lists `switchboard` as connected with no trust prompt.
  - Asking Claude to call `my_node` and `workspace` gives no permission prompt and the right data.
