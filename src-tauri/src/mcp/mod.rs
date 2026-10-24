//! The `switchboard` MCP server (Story 7.1): what a session the app launched sees of the graph
//! it sits in. It is served at `POST /mcp` on the hooks endpoint (`crate::claude::hooks`), on
//! 127.0.0.1 only, and reached through the per-session `--mcp-config` file the launch writes
//! ([`config_json`]).
//!
//! **Transport.** Streamable HTTP in stateless JSON mode, hand-rolled (no MCP crate): each POST
//! carries one JSON-RPC message and gets one `application/json` reply; there is no SSE stream
//! and no session id. `initialize`, `ping`, `tools/list` and `tools/call` are answered; a
//! notification (or a client's response) is a 202 with no body; any other method is JSON-RPC
//! "method not found". A body that is not JSON is a 400 with a parse error; a batch (an array)
//! or anything else that is not one request object is a 400 with "invalid request". Any method
//! other than POST, once authenticated, is a 405 with `Allow: POST` (the client then knows there
//! is no SSE stream). `Origin`, `Accept` and `MCP-Protocol-Version` are not checked: the clients
//! are not browsers, and every request needs the bearer token. In debug builds a panic in a tool is a
//! JSON-RPC internal error (-32603) with the request's id; release builds abort on panic
//! (`panic = "abort"`), so the catch only guards development.
//!
//! **Auth.** The bearer token is the session's hooks token: it names the caller, so no tool
//! takes an identity argument, and it dies with the session. No token, or one no running
//! session holds, is a 401 with no body, counted in `mcp_refused` with a ring entry (time,
//! path, `missing token` / `unknown token`; never the token). An authenticated body over 1 MiB
//! (413, `body too large`) or one that does not arrive in time (408, `read timeout`) is counted
//! the same way. Every refusal closes the connection.
//!
//! **Read tools** (the settings file allows each, so none prompts): [`my_node`], [`workspace`],
//! [`node`], [`peers`] and [`sessions`]. They read Rust's live state (the workspace, the live map,
//! the status poll, the live edges, the launcher's record of add-dirs) and change nothing.
//!
//! **Act tools** (Story 7.2, [`act`]; not in `permissions.allow`, so Claude Code may ask its own
//! permission first): `start_session`, `link` and `unlink` wait on the operator's approval toast
//! (`crate::approvals`) unless the workspace allows all or the edge joining the caller and the
//! target is "Always"; `set_status` never asks.
//!
//! **Peer tools** (Story 7.3, `crate::inbox`): `send` and `inbox`, between sessions joined by a
//! cooperate edge only. They never ask (the edge is the permission) and are in `permissions.allow`.
//!
//! A result is a single `text` content item holding compact JSON; an error is `isError: true`
//! with a plain message. An unknown tool is such an error too, by design (the model reads it),
//! not a protocol error.

use std::collections::HashMap;
use std::sync::Arc;

use axum::extract::{Request, State};
use axum::http::{Method, StatusCode, header};
use axum::response::{IntoResponse, Response};
use serde_json::{Map, Value, json};

use crate::claude::hooks::{self, Ctx, MISSING_TOKEN, UNKNOWN_TOKEN, Unread};
use tauri::{AppHandle, Manager, Runtime};

pub mod act;
use crate::claude::live::{LiveSession, SessionState};
use crate::claude::live_edges::{EdgeState, OWN_FOLDER};
use crate::graph::{self, Project, WorkspaceState};
use crate::settings::AppState;

/// The server's name: in `serverInfo`, in the MCP config and in the tool permissions
/// (`mcp__switchboard__<tool>`).
pub const SERVER_NAME: &str = "switchboard";

/// The read tools, in the order `tools/list` gives them; they never prompt.
pub const READ_TOOLS: [&str; 5] = ["my_node", "workspace", "node", "peers", "sessions"];

/// The act tools (Story 7.2), listed after the read tools.
pub const ACT_TOOLS: [&str; 4] = ["start_session", "link", "unlink", "set_status"];

/// The peer tools (Story 7.3), listed last; they never prompt.
pub const PEER_TOOLS: [&str; 2] = ["send", "inbox"];

/// Every tool, in the order `tools/list` gives them.
pub const TOOLS: [&str; 11] = [
    "my_node",
    "workspace",
    "node",
    "peers",
    "sessions",
    "start_session",
    "link",
    "unlink",
    "set_status",
    "send",
    "inbox",
];

/// A session's `lastLine` in [`workspace`] and [`node`] is cut to this many characters (then `…`).
pub const LAST_LINE_MAX: usize = 120;

/// The MCP protocol versions whose streamable-HTTP transport this handler meets, newest first;
/// `initialize` echoes the client's when it is listed, else offers the newest. (2024-11-05 used
/// the older HTTP+SSE transport, which this server does not serve.)
pub const PROTOCOL_VERSIONS: [&str; 2] = ["2025-06-18", "2025-03-26"];

/// The status of a session that has a transcript but is not in the live map.
pub const HISTORIC: &str = "historic";

/// JSON-RPC error codes.
const PARSE_ERROR: i64 = -32700;
const INVALID_REQUEST: i64 = -32600;
const METHOD_NOT_FOUND: i64 = -32601;
const INVALID_PARAMS: i64 = -32602;
const INTERNAL_ERROR: i64 = -32603;

/// What answers a tool call: `(caller session id, tool, arguments)` → the result's JSON or a plain
/// error message. The app's is [`call`] on its `AppState`; tests may put a stub in its place.
pub type Tools = Arc<dyn Fn(&str, &str, &Value) -> Result<Value, String> + Send + Sync>;

/// Told the id of a `/mcp` call that went away before its reply (Story 7.2): the app withdraws
/// its pending approval (`crate::approvals::cancel_call`).
pub type Cancel = Arc<dyn Fn(u64) + Send + Sync>;

/// Ids for `/mcp` calls (see [`Cancel`]).
static NEXT_CALL: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

/// Withdraws its call's pending approval when the handler is dropped before the reply (the client
/// timed out or disconnected).
struct CallGuard {
    call: u64,
    cancel: Cancel,
    done: bool,
}

impl Drop for CallGuard {
    fn drop(&mut self) {
        if !self.done {
            (self.cancel)(self.call);
        }
    }
}

/// `permissions.allow` for the per-session settings file: `mcp__switchboard__<tool>` for exactly
/// the read tools and the peer tools of Story 7.3 (never the act tools of Story 7.2).
pub fn allowed_tools() -> Vec<String> {
    READ_TOOLS.iter().chain(PEER_TOOLS.iter()).map(|tool| format!("mcp__{SERVER_NAME}__{tool}")).collect()
}

/// The per-session `--mcp-config` content while the endpoint is up on `port`.
pub fn config_json(port: u16, token: &str) -> Value {
    json!({
        "mcpServers": {
            SERVER_NAME: {
                "type": "http",
                "url": format!("http://127.0.0.1:{port}/mcp"),
                "headers": { "Authorization": format!("Bearer {token}") },
            }
        }
    })
}

// ---------------------------------------------------------------------------------------
// The endpoint
// ---------------------------------------------------------------------------------------

/// `/mcp`: authenticate from the head (a refusal reads no body), then one JSON-RPC message.
pub(crate) async fn handle(State(ctx): State<Ctx>, request: Request) -> Response {
    let (parts, body) = request.into_parts();
    let declared = hooks::declared_length(&parts.headers);
    let path = parts.uri.path().to_string();
    // A body is drained (so the client reads the reply) only up to the hooks' drain cap.
    let drain = |body: axum::body::Body| async move {
        if declared.is_none_or(|len| len <= hooks::DRAIN_CAP as u64) {
            hooks::discard(body, 0).await;
        }
    };
    let token = hooks::bearer(&parts.headers).filter(|t| !t.is_empty());
    let session = match token {
        None => Err(MISSING_TOKEN),
        Some(token) => ctx.hooks.session_for(token).ok_or(UNKNOWN_TOKEN),
    };
    let session = match session {
        Ok(session) => session,
        Err(reason) => {
            ctx.hooks.note_mcp_refusal(&path, reason);
            drain(body).await;
            return (StatusCode::UNAUTHORIZED, [(header::CONNECTION, "close")]).into_response();
        }
    };
    if parts.method != Method::POST {
        drain(body).await;
        return (StatusCode::METHOD_NOT_ALLOWED, [(header::ALLOW, "POST"), (header::CONNECTION, "close")]).into_response();
    }
    let bytes = match hooks::read_body(body, declared).await {
        Ok(bytes) => bytes,
        Err(unread) => {
            let (status, reason) = match unread {
                Unread::TooLarge => (StatusCode::PAYLOAD_TOO_LARGE, hooks::BODY_TOO_LARGE),
                Unread::Failed => (StatusCode::REQUEST_TIMEOUT, hooks::READ_TIMED_OUT),
            };
            ctx.hooks.note_mcp_refusal(&path, reason);
            return (status, [(header::CONNECTION, "close")]).into_response();
        }
    };
    // Story 7.2: from here until the reply is out the connection waits for us (an act tool may
    // wait minutes for the operator), so its idle timer does not apply.
    let _pending = parts
        .extensions
        .get::<axum::extract::ConnectInfo<hooks::ConnInfo>>()
        .map(|info| info.0.hold.hold());
    // The tools take the app's locks: off the async workers. A panic in a tool is caught inside
    // `dispatch` (a JSON-RPC internal error with the request's id); this fallback has no id.
    let tools = ctx.tools.clone();
    let call = NEXT_CALL.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let mut guard = CallGuard { call, cancel: ctx.cancel.clone(), done: false };
    let reply = tauri::async_runtime::spawn_blocking(move || crate::approvals::within_call(call, || dispatch(&tools, &session, &bytes)))
        .await
        .unwrap_or_else(|_| Reply::Json(StatusCode::OK, error(Value::Null, INTERNAL_ERROR, "internal error")));
    guard.done = true;
    match reply {
        Reply::Accepted => StatusCode::ACCEPTED.into_response(),
        Reply::Json(status, value) => (status, [(header::CONTENT_TYPE, "application/json")], value.to_string()).into_response(),
    }
}

/// What one JSON-RPC message gets back.
#[derive(Debug, Clone, PartialEq)]
pub enum Reply {
    /// A notification or a response: 202, no body.
    Accepted,
    /// A JSON-RPC response (or error) with its HTTP status.
    Json(StatusCode, Value),
}

fn error(id: Value, code: i64, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

fn result(id: Value, result: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

/// Answer one JSON-RPC message from session `session`.
pub fn dispatch(tools: &Tools, session: &str, bytes: &[u8]) -> Reply {
    let Ok(message) = serde_json::from_slice::<Value>(bytes) else {
        return Reply::Json(StatusCode::BAD_REQUEST, error(Value::Null, PARSE_ERROR, "parse error"));
    };
    let Some(object) = message.as_object() else {
        return Reply::Json(StatusCode::BAD_REQUEST, error(Value::Null, INVALID_REQUEST, "invalid request: one JSON-RPC object per POST"));
    };
    let Some(method) = object.get("method").and_then(Value::as_str) else {
        // A response to a request of ours (there are none) or junk without a method: a
        // response carries `result` or `error`.
        if object.contains_key("result") || object.contains_key("error") {
            return Reply::Accepted;
        }
        let id = object.get("id").cloned().unwrap_or(Value::Null);
        return Reply::Json(StatusCode::BAD_REQUEST, error(id, INVALID_REQUEST, "invalid request"));
    };
    let Some(id) = object.get("id").cloned() else {
        // A notification (`notifications/initialized`, `notifications/cancelled`, …).
        return Reply::Accepted;
    };
    let params = object.get("params").cloned().unwrap_or(Value::Null);
    let body = match method {
        "initialize" => result(id, initialize(&params)),
        "ping" => result(id, json!({})),
        "tools/list" => result(id, json!({ "tools": tool_list() })),
        "tools/call" => {
            let Some(name) = params.get("name").and_then(Value::as_str) else {
                return Reply::Json(StatusCode::OK, error(id, INVALID_PARAMS, "tools/call needs a tool name"));
            };
            let arguments = params.get("arguments").cloned().filter(|a| !a.is_null()).unwrap_or_else(|| json!({}));
            // An unknown tool is a tool error (`isError`), not a protocol error: the model reads it.
            if !TOOLS.contains(&name) {
                return Reply::Json(StatusCode::OK, result(id, tool_result(Err(format!("unknown tool: {name}")))));
            }
            let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| tools(session, name, &arguments)));
            match outcome {
                Ok(outcome) => result(id, tool_result(outcome)),
                Err(_) => error(id, INTERNAL_ERROR, &format!("internal error in {name}")),
            }
        }
        _ => error(id, METHOD_NOT_FOUND, &format!("method not found: {method}")),
    };
    Reply::Json(StatusCode::OK, body)
}

/// The `initialize` result: the protocol version, the tools capability and `serverInfo`.
fn initialize(params: &Value) -> Value {
    let asked = params.get("protocolVersion").and_then(Value::as_str);
    let version = asked.filter(|v| PROTOCOL_VERSIONS.contains(v)).unwrap_or(PROTOCOL_VERSIONS[0]);
    json!({
        "protocolVersion": version,
        "capabilities": { "tools": { "listChanged": false } },
        "serverInfo": { "name": SERVER_NAME, "version": env!("CARGO_PKG_VERSION") },
        "instructions": "Switchboard's view of the workspace this session runs in: call my_node first, then workspace, node, peers or sessions (read-only, never prompt). To act: start_session, link and unlink wait for the operator's approval; set_status posts a short status line on your card. To reach a cooperate peer when SendMessage does not: send({peer, text}) and inbox() (never prompt).",
    })
}

/// A tool's result: one compact-JSON text item, or `isError` with the message.
fn tool_result(outcome: Result<Value, String>) -> Value {
    match outcome {
        Ok(value) => json!({ "content": [{ "type": "text", "text": value.to_string() }], "isError": false }),
        Err(message) => json!({ "content": [{ "type": "text", "text": message }], "isError": true }),
    }
}

/// `tools/list`: each read tool with its description and input schema.
pub fn tool_list() -> Vec<Value> {
    let none = || json!({ "type": "object", "properties": {}, "additionalProperties": false });
    let one = |key: &str, description: &str| {
        json!({
            "type": "object",
            "properties": { key: { "type": "string", "description": description } },
            "required": [key],
            "additionalProperties": false,
        })
    };
    let tool = |name: &str, description: &str, schema: Value| {
        json!({
            "name": name,
            "description": description,
            "inputSchema": schema,
            "annotations": { "readOnlyHint": true, "openWorldHint": false },
        })
    };
    let act = |name: &str, description: &str, schema: Value, destructive: bool| {
        json!({
            "name": name,
            "description": description,
            "inputSchema": schema,
            "annotations": { "readOnlyHint": false, "destructiveHint": destructive, "openWorldHint": false },
        })
    };
    let text = |description: &str| json!({ "type": "string", "description": description });
    vec![
        tool(
            "my_node",
            "This session's own node: id, name, node path, project, branch, worktree, cwd, cooperate peers and the folders it was granted (addDirs, each with where it came from).",
            none(),
        ),
        tool(
            "workspace",
            "Every project on the canvas with its path and its live sessions (name, status, last line), and every edge (its ends as <type>:<id>).",
            none(),
        ),
        tool("node", "One node by id: a project or a session.", one("id", "A project id or a session id (as workspace() lists them).")),
        tool("peers", "The sessions joined to this one by a cooperate edge: node id, name, node path, purpose.", none()),
        tool(
            "sessions",
            "A project's live and historic sessions (node id, name, status, last activity).",
            one("project", "The project's id or label."),
        ),
        act(
            "start_session",
            "Start a new Claude Code session in another project (or on a branch that has a worktree), in the background. The operator approves the exact command first. Returns {nodeId, name}.",
            json!({
                "type": "object",
                "properties": {
                    "project": text("The project's id or label (as workspace() lists them). Give this or branch."),
                    "branch": text("<project id or label>:<branch>: a branch with a worktree (or checked out in the project's folder). Give this or project."),
                    "prompt": text("The first prompt for the new session."),
                    "name": text("The session's name; default <label>-<4 hex>."),
                    "model": text("A model (opus, sonnet, haiku, fable, or a full name); default: the project's last choice."),
                    "effort": { "type": "string", "enum": ["default", "low", "medium", "high", "xhigh", "max"] },
                    "permissionMode": { "type": "string", "enum": ["default", "manual", "acceptEdits", "plan", "auto", "dontAsk"] },
                    "addDirs": { "type": "array", "items": { "type": "string" }, "description": "Extra folders for --add-dir (existing folders)." },
                    "cooperateWithMe": { "type": "boolean", "description": "Join the new session to this one by a cooperate edge, so each knows the other as a peer." },
                },
                "additionalProperties": false,
            }),
            false,
        ),
        act(
            "link",
            "Draw an edge between two nodes (after the operator approves). Ends as workspace() lists them (project:<id>, session:<id>, branch:<projectId>:<name>), or self. kind must be the one the app derives: cooperate between two sessions, context from a session or project to a project or branch. Returns {edgeId}.",
            json!({
                "type": "object",
                "properties": {
                    "from": text("The source end, or self."),
                    "to": text("The target end, or self."),
                    "kind": { "type": "string", "enum": ["context", "cooperate"] },
                    "label": text("What the link is for."),
                },
                "required": ["from", "to", "kind"],
                "additionalProperties": false,
            }),
            false,
        ),
        act(
            "unlink",
            "Delete an edge by id (after the operator approves).",
            one("edgeId", "The edge's id (as workspace() lists it)."),
            true,
        ),
        act(
            "set_status",
            "Post a short status line (at most 120 characters) on this session's card, until its state changes or the next set_status; an empty text clears it. Never asks the operator.",
            one("text", "The status line; empty clears it."),
            false,
        ),
        act(
            "send",
            "Send a message to a cooperate peer (a session joined to this one by a cooperate edge; see peers()). It lands in the peer's inbox and the peer is nudged to read it once idle; a peer not running in a Switchboard terminal gets it when resumed there. Never asks the operator. Returns {delivered, to, unread} (running: false when the peer is not running in a Switchboard terminal; dropped: N when older unread messages were pushed out).",
            json!({
                "type": "object",
                "properties": {
                    "peer": text("The peer's node id (or session:<id>) or its name, as peers() lists it."),
                    "text": text("The message, at most 4000 characters; line breaks are kept."),
                },
                "required": ["peer", "text"],
                "additionalProperties": false,
            }),
            false,
        ),
        act(
            "inbox",
            "This session's unread messages from its peers, oldest first, as [{from, fromNodeId, text, at}]. Each message is returned once: reading clears exactly the messages returned. Never asks the operator.",
            none(),
            false,
        ),
    ]
}

/// Run tool `tool` for session `session` against the running app: the act tools (Story 7.2,
/// [`act`]) need the app handle (launches, edges, approvals, emits); the read tools go to
/// [`call`]. Blocking: an act tool may wait minutes for the operator.
pub fn call_app<R: Runtime>(app: &AppHandle<R>, session: &str, tool: &str, args: &Value) -> Result<Value, String> {
    match tool {
        "start_session" => act::start_session(app, session, args),
        "link" => act::link(app, session, args),
        "unlink" => act::unlink(app, session, args),
        "set_status" => act::set_status(app, session, args),
        "send" => crate::inbox::send(app, session, args),
        "inbox" => crate::inbox::inbox(app, session),
        _ => call(&app.state::<AppState>(), session, tool, args),
    }
}

// ---------------------------------------------------------------------------------------
// The tools
// ---------------------------------------------------------------------------------------

/// Run tool `tool` for the session `session` (the token's) with `args`, against the app state.
pub fn call(state: &AppState, session: &str, tool: &str, args: &Value) -> Result<Value, String> {
    let text = |key: &str| {
        args.get(key)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|v| !v.is_empty())
            .ok_or_else(|| format!("{key} is required"))
    };
    match tool {
        "my_node" => my_node(state, session),
        "workspace" => Ok(workspace(state)),
        "node" => node(state, text("id")?),
        "peers" => Ok(peers(state, session)),
        "sessions" => sessions(state, text("project")?),
        other => Err(format!("unknown tool: {other}")),
    }
}

/// A session state as the tools spell it: `busy`, `idle`, …, or an unknown status verbatim.
pub fn status_text(state: &SessionState) -> String {
    match state {
        SessionState::Starting => "starting",
        SessionState::Busy => "busy",
        SessionState::Idle => "idle",
        SessionState::Waiting => "waiting",
        SessionState::Finished => "finished",
        SessionState::Exited => "exited",
        SessionState::Other { raw } => return raw.clone(),
    }
    .to_string()
}

fn usable(text: &str) -> Option<String> {
    let text = text.trim();
    (!text.is_empty()).then(|| text.to_string())
}

fn project_json(project: &Project) -> Value {
    json!({ "id": project.id, "label": project.label, "path": project.path })
}

/// Where a folder of `project` sits: the branch checked out there and, when it is in a linked
/// worktree, that worktree's folder. Linked worktrees first (the status poll's list, the branch
/// list's chips, the stored branch nodes), deepest match; then the project's own folder, whose
/// branch is the one the status poll saw checked out.
fn place_of(ws: &WorkspaceState, heads: &HashMap<String, String>, project: &Project, cwd: &str) -> (Option<String>, Option<String>) {
    let deepest = |candidates: Vec<(Option<String>, String)>| {
        candidates
            .into_iter()
            .filter(|(_, path)| graph::path_within(cwd, path))
            .max_by_key(|(_, path)| graph::path_depth(path))
            .map(|(branch, path)| (branch, Some(path)))
    };
    let known = ws.worktrees.get(&project.id).into_iter().flatten().map(|w| (w.branch.clone(), w.path.clone())).collect();
    if let Some(found) = deepest(known) {
        return found;
    }
    let chips = ws
        .branches
        .get(&project.id)
        .into_iter()
        .flatten()
        .filter_map(|b| b.worktree.as_ref().filter(|chip| !chip.missing).map(|chip| (Some(b.name.clone()), chip.path.clone())))
        .collect();
    if let Some(found) = deepest(chips) {
        return found;
    }
    let stored = ws
        .workspace
        .branches
        .iter()
        .filter(|b| b.project_id == project.id)
        .filter_map(|b| b.worktree_path.clone().map(|path| (Some(b.name.clone()), path)))
        .collect();
    if let Some(found) = deepest(stored) {
        return found;
    }
    if graph::path_within(cwd, &project.path) {
        return (heads.get(&project.id).cloned(), None);
    }
    (None, None)
}

/// What the tools know of one session.
#[derive(Debug, Clone, Default)]
pub(crate) struct SessionFacts {
    id: String,
    name: String,
    status: String,
    live: bool,
    last_line: Option<String>,
    project: Option<Project>,
    branch: Option<String>,
    worktree: Option<String>,
    cwd: Option<String>,
    /// Milliseconds since the epoch, for ordering.
    last_active_ms: Option<i64>,
    /// ISO 8601 UTC.
    last_active: Option<String>,
    /// Story 7.2: the `set_status` text while it lasts.
    status_text: Option<String>,
}

/// Session `id` as the live map (`live`), the workspace and the status poll's `heads` know it;
/// `None` when none of the live map, the session refs and the discovered transcripts has it.
/// The name follows the peers' rule: the live name, else the transcript title, else the
/// project's label, else the id. The branch is the session ref's, else the branch of the live
/// cwd (else of the transcript's), else the transcript's last `gitBranch`.
fn facts(ws: &WorkspaceState, heads: &HashMap<String, String>, id: &str, live: Option<&LiveSession>) -> Option<SessionFacts> {
    let session_ref = ws.workspace.sessions.iter().find(|s| s.session_id == id);
    let discovered = ws
        .discovered
        .iter()
        .find_map(|(pid, list)| list.iter().find(|s| s.id == id).map(|s| (pid.clone(), s)));
    if live.is_none() && session_ref.is_none() && discovered.is_none() {
        return None;
    }
    let project = live
        .and_then(|l| l.project_id.clone())
        .into_iter()
        .chain(session_ref.map(|r| r.project_id.clone()))
        .chain(discovered.as_ref().map(|(pid, _)| pid.clone()))
        .find_map(|pid| ws.workspace.projects.iter().find(|p| p.id == pid))
        .cloned();
    let title = discovered
        .as_ref()
        .map(|(_, s)| s.title.clone())
        .filter(|t| t != crate::claude::transcript::UNTITLED)
        .and_then(|t| usable(&t));
    let name = live
        .and_then(|l| l.name.as_deref())
        .and_then(usable)
        .or(title)
        .or_else(|| project.as_ref().and_then(|p| usable(&p.label)))
        .unwrap_or_else(|| id.to_string());
    let cwd = live.map(|l| l.cwd.clone()).filter(|c| !c.trim().is_empty()).or_else(|| discovered.as_ref().and_then(|(_, s)| s.cwd.clone()));
    let (cwd_branch, worktree) = match (&project, &cwd) {
        (Some(project), Some(cwd)) => place_of(ws, heads, project, cwd),
        _ => (None, None),
    };
    let ref_branch = session_ref.and_then(|r| {
        r.branch_id
            .as_deref()
            .and_then(|b| b.strip_prefix(&format!("{}:", r.project_id)))
            .filter(|b| !b.is_empty())
            .map(str::to_string)
    });
    let branch = ref_branch.or(cwd_branch).or_else(|| discovered.as_ref().and_then(|(_, s)| s.branch.clone()));
    // Last activity: the newer of the transcript's last record and what the live map saw (the
    // start, the last time it turned finished / waiting), so a live session is not dated by a
    // stale transcript.
    let transcript_raw = discovered.as_ref().map(|(_, s)| s.last_active.clone());
    let transcript_ms = transcript_raw.as_deref().and_then(crate::claude::transcript::parse_iso_ms);
    let live_ms = live.and_then(|l| l.attention_since.max(l.started_at));
    let last_active_ms = transcript_ms.max(live_ms);
    Some(SessionFacts {
        id: id.to_string(),
        name,
        status: live.map_or_else(|| HISTORIC.to_string(), |l| status_text(&l.state)),
        live: live.is_some_and(|l| l.state.is_live()),
        last_line: live.and_then(|l| l.last_line.clone()),
        project,
        branch,
        worktree,
        cwd,
        last_active_ms,
        last_active: last_active_ms.map(crate::claude::transcript::format_iso_ms).or(transcript_raw),
        status_text: live.and_then(|l| l.status_text.clone()),
    })
}

/// [`facts`] for session `id`, taking the locks one at a time.
pub(crate) fn session_facts(state: &AppState, id: &str) -> Option<SessionFacts> {
    let live = state.read_sessions_live().sessions.get(id).cloned();
    let heads = graph::checked_out_heads(state);
    let ws = state.read_workspace();
    facts(&ws, &heads, id, live.as_ref())
}

/// A node path as the system prompt's peer block writes it: `<project>[:<branch>] / <name>`.
pub(crate) fn node_path(facts: &SessionFacts) -> String {
    let node = match (&facts.project, &facts.branch) {
        (Some(project), Some(branch)) => format!("{}:{branch}", project.label),
        (Some(project), None) => project.label.clone(),
        (None, _) => "unknown project".to_string(),
    };
    format!("{node} / {}", facts.name)
}

/// `my_node()`: the caller's own node.
pub fn my_node(state: &AppState, session: &str) -> Result<Value, String> {
    let me = session_facts(state, session).ok_or_else(|| "this session is not on the canvas".to_string())?;
    Ok(json!({
        "nodeId": me.id,
        "name": me.name,
        "path": node_path(&me),
        "project": me.project.as_ref().map(project_json),
        "branch": me.branch,
        "worktree": me.worktree,
        "cwd": me.cwd,
        "statusText": me.status_text,
        "peers": peers(state, session),
        "addDirs": add_dirs(state, session),
    }))
}

/// `peers()`: the sessions at the other end of the caller's cooperate edges, named as the system
/// prompt names them (Story 6.4), in edge order.
pub fn peers(state: &AppState, session: &str) -> Value {
    let list = graph::cooperate_peers(&state.read_workspace(), session);
    let ids: Vec<String> = list.iter().map(|(id, _)| id.clone()).collect();
    let named = graph::name_peers(state, list);
    Value::Array(
        ids.into_iter()
            .zip(named)
            .map(|(id, peer)| json!({ "nodeId": id, "name": peer.name, "path": peer.path, "purpose": peer.purpose }))
            .collect(),
    )
}

/// The caller's add-dirs: those its launch was given (recorded at launch, `sheet` or
/// `edge → <target>`), then the context edges applied to it live (Story 6.3, `/add-dir`); a
/// folder listed once.
fn add_dirs(state: &AppState, session: &str) -> Value {
    let mut dirs = state.launcher.add_dirs_of(session);
    let applied: Vec<(String, String)> = state
        .live_edges
        .snapshot()
        .into_values()
        .filter(|e| e.session_id == session && e.state == EdgeState::Applied && e.detail.as_deref() != Some(OWN_FOLDER))
        .filter_map(|e| e.path.map(|p| (e.edge_id, p)))
        .collect();
    let context: Vec<String> = {
        let ws = state.read_workspace();
        applied
            .iter()
            .filter(|(edge, _)| ws.workspace.edges.iter().any(|e| e.id == *edge && e.kind == graph::EdgeKind::Context))
            .map(|(_, path)| path.clone())
            .collect()
    };
    for path in context {
        if !dirs.iter().any(|d| graph::same_path(&d.path, &path)) {
            dirs.push(graph::EdgeDir { path, via: "/add-dir".to_string() });
        }
    }
    Value::Array(dirs.into_iter().map(|d| json!({ "path": d.path, "via": d.via })).collect())
}

/// What [`workspace`] aims to stay under, in bytes of compact JSON.
pub const WORKSPACE_BUDGET: usize = 8000;

/// The shorter last-line cut [`workspace`] falls back to first while it is over
/// [`WORKSPACE_BUDGET`].
pub const SHORT_LAST_LINE: usize = 40;

/// A name, label or last line as [`workspace`] carries it: control characters stripped, `"`
/// turned into `'`, trimmed and cut to `max` characters (`launch::peer_value`'s rule).
fn clean(text: &str, max: usize) -> String {
    let value = crate::claude::launch::peer_value(text);
    if max >= crate::claude::launch::MAX_PEER_VALUE_CHARS {
        return value;
    }
    hooks::cut(value.trim_end_matches('…'), max)
}

/// `workspace()`: every project with its path and its live sessions (name, status, last line cut
/// to [`LAST_LINE_MAX`]), and every edge. No positions, viewport or historic sessions. Session
/// names, project labels and edge labels are cleaned and cut to 120 characters like the
/// system prompt's peer values. Built once; while the result is over [`WORKSPACE_BUDGET`], the
/// last lines are cut to [`SHORT_LAST_LINE`] (`lastLinesCut: 40`), then left out
/// (`lastLinesCut: "omitted"`), then the edge labels go too (`truncated: true`).
pub fn workspace(state: &AppState) -> Value {
    let live: Vec<(String, LiveSession)> = state
        .read_sessions_live()
        .sessions
        .iter()
        .filter(|(_, s)| s.state.is_live() && s.project_id.is_some())
        .map(|(id, s)| (id.clone(), s.clone()))
        .collect();
    let heads = graph::checked_out_heads(state);
    let ws = state.read_workspace();
    // Each session's raw last line, by (project index, session index), for the shorter cuts.
    let mut raw_lines: Vec<(usize, usize, String)> = Vec::new();
    let projects: Vec<Value> = ws
        .workspace
        .projects
        .iter()
        .enumerate()
        .map(|(p, project)| {
            let mut mine: Vec<&(String, LiveSession)> = live.iter().filter(|(_, s)| s.project_id.as_deref() == Some(project.id.as_str())).collect();
            mine.sort_by_key(|(id, s)| (s.started_at, id.clone()));
            let sessions: Vec<Value> = mine
                .into_iter()
                .filter_map(|(id, s)| facts(&ws, &heads, id, Some(s)))
                .enumerate()
                .map(|(i, f)| {
                    let line = f.last_line.as_deref().map(|l| clean(l, LAST_LINE_MAX)).filter(|l| !l.is_empty());
                    if let Some(raw) = &f.last_line {
                        raw_lines.push((p, i, raw.clone()));
                    }
                    json!({ "nodeId": f.id, "name": clean(&f.name, LAST_LINE_MAX), "status": f.status, "lastLine": line })
                })
                .collect();
            json!({ "id": project.id, "label": clean(&project.label, LAST_LINE_MAX), "path": project.path, "sessions": sessions })
        })
        .collect();
    let edges: Vec<Value> = ws.workspace.edges.iter().map(edge_json).collect();
    drop(ws);
    let mut value = json!({ "projects": projects, "edges": edges });
    let over = |value: &Value| value.to_string().len() > WORKSPACE_BUDGET;
    if over(&value) {
        for (p, i, raw) in &raw_lines {
            value["projects"][*p]["sessions"][*i]["lastLine"] = json!(clean(raw, SHORT_LAST_LINE));
        }
        value["lastLinesCut"] = json!(SHORT_LAST_LINE);
    }
    if over(&value) {
        for (p, i, _) in &raw_lines {
            value["projects"][*p]["sessions"][*i]["lastLine"] = Value::Null;
        }
        value["lastLinesCut"] = json!("omitted");
    }
    if over(&value) {
        if let Some(edges) = value["edges"].as_array_mut() {
            for edge in edges {
                edge["label"] = Value::Null;
            }
        }
        value["truncated"] = json!(true);
    }
    value
}

/// An edge, its ends as `<type>:<id>` (`session:<id>`, `project:<id>`, `branch:<projectId>:<name>`,
/// `folder:<path>`): the compact form keeps [`workspace`] small.
pub(crate) fn edge_json(edge: &graph::Edge) -> Value {
    let end = |node: &graph::NodeRef| {
        let kind = match node.kind {
            graph::NodeType::Project => "project",
            graph::NodeType::Branch => "branch",
            graph::NodeType::Session => "session",
            graph::NodeType::Folder => "folder",
        };
        format!("{kind}:{}", node.id)
    };
    json!({
        "id": edge.id,
        "kind": edge.kind,
        "from": end(&edge.from),
        "to": end(&edge.to),
        "label": edge.label.as_deref().map(|l| clean(l, LAST_LINE_MAX)),
    })
}

/// `node(id)`: a project's `{id,label,path,branch}` (the branch checked out in its folder), or a
/// session's `{nodeId,name,status,lastLine,project,branch}`; an unknown id is an error. An edge
/// end as [`workspace`] lists it (`project:<id>`, `session:<id>`) is taken too; a `branch:` or
/// `folder:` end is not a node this tool describes.
pub fn node(state: &AppState, id: &str) -> Result<Value, String> {
    if id.starts_with("branch:") || id.starts_with("folder:") {
        return Err(format!("not a project or session node: {id}"));
    }
    let id = id.strip_prefix("project:").or_else(|| id.strip_prefix("session:")).unwrap_or(id);
    let project = state.read_workspace().workspace.projects.iter().find(|p| p.id == id).cloned();
    if let Some(project) = project {
        let branch = graph::checked_out_heads(state).get(&project.id).cloned();
        return Ok(json!({ "id": project.id, "label": project.label, "path": project.path, "branch": branch }));
    }
    let facts = session_facts(state, id).ok_or_else(|| format!("unknown node: {id}"))?;
    Ok(json!({
        "nodeId": facts.id,
        "name": facts.name,
        "status": facts.status,
        "lastLine": facts.last_line.as_deref().map(|l| hooks::cut(l, LAST_LINE_MAX)),
        "project": facts.project.as_ref().map(project_json),
        "branch": facts.branch,
        "statusText": facts.status_text,
    }))
}

/// The project `wanted` names: by id, else by label (exact, else ignoring case). An unknown
/// project is an error, and so is a label two projects share (the error names their ids).
pub fn find_project<'a>(projects: &'a [Project], wanted: &str) -> Result<&'a Project, String> {
    if let Some(project) = projects.iter().find(|p| p.id == wanted) {
        return Ok(project);
    }
    let exact: Vec<&Project> = projects.iter().filter(|p| p.label == wanted).collect();
    let loose: Vec<&Project> = projects.iter().filter(|p| p.label.eq_ignore_ascii_case(wanted)).collect();
    let by_label = if exact.is_empty() { loose } else { exact };
    match by_label.as_slice() {
        [] => Err(format!("unknown project: {wanted}")),
        [project] => Ok(project),
        many => {
            let ids: Vec<&str> = many.iter().map(|p| p.id.as_str()).collect();
            Err(format!("ambiguous project label {wanted}: {}; give the id", ids.join(", ")))
        }
    }
}

/// `sessions(project)`: the project (by id, else by label; exact, else ignoring case) and its
/// live and historic sessions -- every session the live map places in it (exited ones too,
/// status `exited`) and every transcript discovered for it (status `historic` when the live map
/// does not know it) -- live ones first, then by last activity (parsed time), newest first. An
/// unknown project is an error, and so is a label two projects share (the error names their ids).
pub fn sessions(state: &AppState, wanted: &str) -> Result<Value, String> {
    let live = state.read_sessions_live().sessions.clone();
    let heads = graph::checked_out_heads(state);
    let ws = state.read_workspace();
    let project = find_project(&ws.workspace.projects, wanted)?;
    let mut ids: Vec<String> = live
        .iter()
        .filter(|(_, s)| s.project_id.as_deref() == Some(project.id.as_str()))
        .map(|(id, _)| id.clone())
        .collect();
    for summary in ws.discovered.get(&project.id).into_iter().flatten() {
        if !ids.contains(&summary.id) {
            ids.push(summary.id.clone());
        }
    }
    let mut list: Vec<SessionFacts> = ids.iter().filter_map(|id| facts(&ws, &heads, id, live.get(id))).collect();
    list.sort_by(|a, b| b.live.cmp(&a.live).then_with(|| b.last_active_ms.cmp(&a.last_active_ms)).then_with(|| a.id.cmp(&b.id)));
    let sessions: Vec<Value> = list
        .into_iter()
        .map(|f| json!({ "nodeId": f.id, "name": f.name, "status": f.status, "lastActive": f.last_active, "statusText": f.status_text }))
        .collect();
    let mut out = Map::new();
    out.insert("project".into(), project_json(project));
    out.insert("sessions".into(), Value::Array(sessions));
    Ok(Value::Object(out))
}

#[cfg(test)]
mod tests;
