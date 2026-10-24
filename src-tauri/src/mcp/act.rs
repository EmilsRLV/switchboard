//! The act tools of the `switchboard` MCP server (Story 7.2): `start_session`, `link`, `unlink`
//! and `set_status`. Each is checked in full before the operator is asked (a refusal is an
//! `isError` with the reason and no toast); `start_session`, `link` and `unlink` then wait on the
//! approval toast (`crate::approvals`) unless the workspace's `agentActions` is `allowAll` or a
//! stored edge joining the caller and the target carries `agentAllowed` ("Always for this
//! edge"). An act run without a toast shows a one-line notice. `set_status` never asks.
//!
//! The pair "Always" is about is the caller session and the request's target: for
//! `start_session` the project node (the branch node for a branch target); for `link` the end
//! that is not the caller; for `unlink` the deleted edge's end that is not the caller. A link or
//! unlink with neither end the caller has no pair: it always asks and offers no Always.

use serde_json::{Value, json};
use tauri::{AppHandle, Emitter, Manager, Runtime};

use super::session_facts;
use crate::approvals::{self, Answer, Ask};
use crate::claude::live_edges;
use crate::graph::{self, AgentActions, EdgeKind, NodeRef, NodeType};
use crate::settings::AppState;

/// What an act tool that the operator denied returns, before the action in words.
pub const DENIED: &str = "the operator denied: ";

/// Why `set_status` is refused: the caller is not a running session the app knows.
pub const NOT_RUNNING: &str = "this session is not running";

/// The longest first prompt `start_session` takes, in characters.
pub const MAX_PROMPT_CHARS: usize = 8000;

/// An optional string argument, trimmed; blank is absent. A value of another type is an error.
fn opt_text(args: &Value, key: &str) -> Result<Option<String>, String> {
    match args.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(text)) => Ok(Some(text.trim().to_string()).filter(|t| !t.is_empty())),
        Some(_) => Err(format!("{key} must be a string")),
    }
}

/// A required, non-blank string argument.
fn text(args: &Value, key: &str) -> Result<String, String> {
    opt_text(args, key)?.ok_or_else(|| format!("{key} is required"))
}

/// The caller's name as the peers see it (`my_node().name`), else its id.
fn caller_name(state: &AppState, caller: &str) -> String {
    session_facts(state, caller).map_or_else(|| caller.to_string(), |f| f.name)
}

fn session_ref(id: &str) -> NodeRef {
    NodeRef {
        kind: NodeType::Session,
        id: id.to_string(),
    }
}

/// An end as the operator reads it: a project's label, a session's name, a branch as
/// `<project label>:<name>`, a folder's path.
fn end_name(state: &AppState, end: &NodeRef) -> String {
    match end.kind {
        NodeType::Session => caller_name(state, &end.id),
        NodeType::Project => state
            .read_workspace()
            .workspace
            .projects
            .iter()
            .find(|p| p.id == end.id)
            .map_or_else(|| end.id.clone(), |p| p.label.clone()),
        NodeType::Branch => {
            let ws = state.read_workspace();
            ws.workspace
                .projects
                .iter()
                .filter_map(|p| end.id.strip_prefix(p.id.as_str()).and_then(|rest| rest.strip_prefix(':')).map(|name| (p, name)))
                .filter(|(_, name)| !name.is_empty())
                .max_by_key(|(p, _)| p.id.len())
                .map_or_else(|| end.id.clone(), |(p, name)| format!("{}:{name}", p.label))
        }
        NodeType::Folder => end.id.clone(),
    }
}

/// An end as `workspace()` lists it: `<type>:<id>`.
fn end_ref(end: &NodeRef) -> String {
    let kind = match end.kind {
        NodeType::Project => "project",
        NodeType::Branch => "branch",
        NodeType::Session => "session",
        NodeType::Folder => "folder",
    };
    format!("{kind}:{}", end.id)
}

/// How an act was approved.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Gate {
    /// The operator allowed it on the toast: Allow, or Always with the edge to mark once the act
    /// succeeded.
    Asked { always: Option<String> },
    /// It ran without a toast (allow all, or the edge's Always): a notice says so afterwards.
    Silent,
}

impl Gate {
    fn silent(&self) -> bool {
        *self == Gate::Silent
    }

    /// After the act succeeded: store the operator's Always on its edge; when it could not be
    /// stored, the result's `policyError` says why.
    fn finish<R: Runtime>(&self, app: &AppHandle<R>, result: &mut Value) {
        let Gate::Asked { always: Some(edge) } = self else {
            return;
        };
        if let Err(err) = graph::set_edge_agent_allowed(app, edge, true) {
            result["policyError"] = json!(format!("Always could not be stored on edge {edge}: {err}"));
        }
    }
}

/// What one act asks.
struct Request<'a> {
    caller: &'a str,
    tool: &'a str,
    /// What will happen, in words (the toast's action and the denial's text).
    action: String,
    detail: String,
    argv: Option<Vec<String>>,
    /// The other node of the pair "Always" is about; `None` when there is none.
    target: Option<NodeRef>,
    /// That node as the operator reads it (the Always button's title).
    target_name: Option<String>,
    /// An edge not to mark Always when another joins the pair too (the edge an unlink deletes).
    deleting: Option<&'a str>,
}

/// Decide an act (Story 7.2): run without a toast under allow all or an edge's Always; else ask
/// the operator, offering Always when a stored edge other than the one the act deletes joins the
/// caller and the target. A denial is `Err("the operator denied: <action>")`; no answer in time is
/// `Err(NO_ANSWER)`. Always is stored on that edge only once the act succeeded ([`Gate::finish`]).
fn gate<R: Runtime>(app: &AppHandle<R>, request: Request<'_>) -> Result<Gate, String> {
    let state = app.state::<AppState>();
    let caller = session_ref(request.caller);
    let (allow_all, joined) = {
        let ws = state.read_workspace();
        let joined: Vec<graph::Edge> = match &request.target {
            Some(target) => ws.workspace.edges.iter().filter(|e| graph::edge_joins(e, &caller, target)).cloned().collect(),
            None => Vec::new(),
        };
        (ws.workspace.agent_actions == AgentActions::AllowAll, joined)
    };
    if allow_all || joined.iter().any(|e| e.agent_allowed) {
        return Ok(Gate::Silent);
    }
    // An edge the act deletes would take an Always with it: it is never the one offered.
    let offered: Vec<&graph::Edge> = joined.iter().filter(|e| Some(e.id.as_str()) != request.deleting).collect();
    let answer = approvals::ask(
        app,
        Ask {
            caller: request.caller.to_string(),
            caller_name: caller_name(&state, request.caller),
            tool: request.tool.to_string(),
            action: request.action.clone(),
            detail: request.detail,
            argv: request.argv,
            always: !offered.is_empty(),
            target: request.target_name,
        },
    )?;
    match answer {
        Answer::Deny => Err(format!("{DENIED}{}", request.action)),
        Answer::Allow => Ok(Gate::Asked { always: None }),
        Answer::Always => Ok(Gate::Asked {
            always: offered.first().map(|e| e.id.clone()),
        }),
    }
}

// --- start_session ---------------------------------------------------------------------------

/// `start_session({project|branch, prompt?, name?, model?, effort?, permissionMode?, addDirs?,
/// cooperateWithMe?})`: build the launch through the launch sheet's path (`ipc::plan_agent_launch`;
/// a refusal -- an unknown or ambiguous project, a branch without a worktree, `bypassPermissions`,
/// a missing add-dir -- is the error, with no toast), ask with the exact argv, then start it in the
/// background. Returns `{nodeId, name}`.
pub fn start_session<R: Runtime>(app: &AppHandle<R>, caller: &str, args: &Value) -> Result<Value, String> {
    let state = app.state::<AppState>();
    let project_arg = opt_text(args, "project")?;
    let branch_arg = opt_text(args, "branch")?;
    let (wanted, branch) = match (project_arg, branch_arg) {
        (Some(_), Some(_)) => return Err("give project or branch, not both".to_string()),
        (None, None) => return Err("project or branch is required".to_string()),
        (Some(project), None) => (project, None),
        (None, Some(spec)) => {
            // Branch names cannot hold `:`; a label may.
            let (project, name) = spec
                .rsplit_once(':')
                .map(|(p, b)| (p.trim().to_string(), b.trim().to_string()))
                .filter(|(p, b)| !p.is_empty() && !b.is_empty())
                .ok_or_else(|| "branch is <project id or label>:<branch>".to_string())?;
            (project, Some(name))
        }
    };
    let (project_id, label) = {
        let ws = state.read_workspace();
        let project = super::find_project(&ws.workspace.projects, &wanted)?;
        (project.id.clone(), project.label.clone())
    };
    let add_dirs = match args.get("addDirs") {
        None | Some(Value::Null) => Vec::new(),
        Some(Value::Array(items)) => items
            .iter()
            .map(|v| v.as_str().map(str::to_string).ok_or_else(|| "addDirs must be strings".to_string()))
            .collect::<Result<Vec<_>, _>>()?,
        Some(_) => return Err("addDirs must be a list of folders".to_string()),
    };
    if let Some(Value::String(prompt)) = args.get("prompt")
        && prompt.chars().count() > MAX_PROMPT_CHARS
    {
        return Err(format!("prompt is over {MAX_PROMPT_CHARS} characters"));
    }
    let cooperate = match args.get("cooperateWithMe") {
        None | Some(Value::Null) => false,
        Some(Value::Bool(on)) => *on,
        Some(_) => return Err("cooperateWithMe must be true or false".to_string()),
    };
    let start = crate::ipc::AgentStart {
        project_id: project_id.clone(),
        branch: branch.clone(),
        prompt: match args.get("prompt") {
            None | Some(Value::Null) => None,
            Some(Value::String(prompt)) => Some(prompt.clone()),
            Some(_) => return Err("prompt must be a string".to_string()),
        },
        name: opt_text(args, "name")?,
        model: opt_text(args, "model")?,
        effort: opt_text(args, "effort")?,
        permission_mode: opt_text(args, "permissionMode")?,
        add_dirs,
        cooperate_with: cooperate.then(|| caller.to_string()),
    };
    let plan = crate::ipc::plan_agent_launch(&state, start)?;
    let (target, place) = match &branch {
        Some(name) => (
            NodeRef {
                kind: NodeType::Branch,
                id: graph::branch_child_id(&project_id, name),
            },
            format!("{label}:{name}"),
        ),
        None => (
            NodeRef {
                kind: NodeType::Project,
                id: project_id.clone(),
            },
            label.clone(),
        ),
    };
    let gate = gate(
        app,
        Request {
            caller,
            tool: "start_session",
            action: format!("start a session on {place}"),
            detail: approvals::argv_line(plan.argv()),
            argv: Some(plan.argv().to_vec()),
            target: Some(target),
            target_name: Some(place.clone()),
            deleting: None,
        },
    )?;
    let (node_id, name) = (plan.session_id().to_string(), plan.name().to_string());
    let started = crate::ipc::start_agent_launch(app, plan, (crate::pty::DEFAULT_COLS, crate::pty::DEFAULT_ROWS))?;
    // The UI learns the terminal without focusing it: the session starts in the background.
    let _ = app.emit(approvals::STARTED_EVENT, &started.term);
    if gate.silent() {
        approvals::notice(app, &format!("{} started {name} on {place}", caller_name(&state, caller)));
    }
    let mut result = json!({ "nodeId": node_id, "name": name });
    gate.finish(app, &mut result);
    Ok(result)
}

// --- link / unlink -----------------------------------------------------------------------------

/// An end as `workspace()` lists it (`project:<id>`, `session:<id>`, `branch:<projectId>:<name>`),
/// or `self` (the caller).
fn parse_end(raw: &str, caller: &str) -> Result<NodeRef, String> {
    if raw == "self" {
        return Ok(session_ref(caller));
    }
    let (kind, id) = raw
        .split_once(':')
        .filter(|(_, id)| !id.is_empty())
        .ok_or_else(|| format!("unknown end {raw}: write it as workspace() lists it (project:<id>, session:<id>, branch:<projectId>:<name>) or self"))?;
    let kind = match kind {
        "project" => NodeType::Project,
        "session" => NodeType::Session,
        "branch" => NodeType::Branch,
        "folder" => NodeType::Folder,
        _ => return Err(format!("unknown end {raw}: write it as workspace() lists it (project:<id>, session:<id>, branch:<projectId>:<name>) or self")),
    };
    Ok(NodeRef { kind, id: id.to_string() })
}

fn kind_word(kind: EdgeKind) -> &'static str {
    match kind {
        EdgeKind::Context => "context",
        EdgeKind::Cooperate => "cooperate",
    }
}

/// The end of a pair that is not the caller, when one end is the caller.
fn other_end(from: &NodeRef, to: &NodeRef, caller: &str) -> Option<NodeRef> {
    let me = session_ref(caller);
    if *from == me {
        Some(to.clone())
    } else if *to == me {
        Some(from.clone())
    } else {
        None
    }
}

/// `link <from> → <to> (<kind>) "<label>"`, the ends as the operator reads them.
fn describe(state: &AppState, verb: &str, from: &NodeRef, to: &NodeRef, kind: EdgeKind, label: Option<&str>) -> String {
    let base = format!("{verb} {} → {} ({})", end_name(state, from), end_name(state, to), kind_word(kind));
    match label {
        // The label exactly as it is (or will be) stored.
        Some(label) => format!("{base} \"{label}\""),
        None => base,
    }
}

/// `link({from, to, kind, label?})`: the edge as `edge_add` would store it (6.1's checks and
/// refusals, and `kind` must be the derived one), asked for, then stored with the 6.1–6.4 effects
/// (label, live `/add-dir`, peer lines). Returns `{edgeId}`.
pub fn link<R: Runtime>(app: &AppHandle<R>, caller: &str, args: &Value) -> Result<Value, String> {
    let state = app.state::<AppState>();
    let from = parse_end(&text(args, "from")?, caller)?;
    let to = parse_end(&text(args, "to")?, caller)?;
    let kind = match text(args, "kind")?.as_str() {
        "context" => EdgeKind::Context,
        "cooperate" => EdgeKind::Cooperate,
        other => return Err(format!("unknown kind {other}: context or cooperate")),
    };
    let label = graph::normalise_edge_label(opt_text(args, "label")?.as_deref());
    // The kind first (a mismatch says what the pair is), then 6.1's checks against the workspace.
    if let Ok(derived) = graph::edge_kind(&from, &to)
        && derived != kind
    {
        return Err(format!("kind {} does not match: the app links these as {}", kind_word(kind), kind_word(derived)));
    }
    let (_, from, to) = graph::check_edge(&state.read_workspace(), &from, &to)?;
    let action = describe(&state, "link", &from, &to, kind, label.as_deref());
    let target = other_end(&from, &to, caller);
    let gate = gate(
        app,
        Request {
            caller,
            tool: "link",
            detail: format!("{} → {} ({})", end_ref(&from), end_ref(&to), kind_word(kind)),
            action: action.clone(),
            argv: None,
            target_name: target.as_ref().map(|t| end_name(&state, t)),
            target,
            deleting: None,
        },
    )?;
    // Stored with its label in one step.
    let edge = graph::add_edge_labelled(app, &from, &to, label.as_deref())?;
    live_edges::edge_added(app, &edge);
    if gate.silent() {
        approvals::notice(app, &format!("{} {}", caller_name(&state, caller), action.replacen("link", "linked", 1)));
    }
    let mut result = json!({ "edgeId": edge.id });
    gate.finish(app, &mut result);
    Ok(result)
}

/// `unlink({edgeId})`: the stored edge (an unknown one is an error), described and asked for,
/// then deleted as Delete does (its live state goes too). Returns `{edgeId}`.
pub fn unlink<R: Runtime>(app: &AppHandle<R>, caller: &str, args: &Value) -> Result<Value, String> {
    let state = app.state::<AppState>();
    let id = text(args, "edgeId")?;
    let edge = live_edges::stored_edge(&state, &id).ok_or_else(|| live_edges::UNKNOWN_EDGE.to_string())?;
    let action = describe(&state, "unlink", &edge.from, &edge.to, edge.kind, edge.label.as_deref());
    let gate = gate(
        app,
        Request {
            caller,
            tool: "unlink",
            detail: format!("{} {} → {} ({})", edge.id, end_ref(&edge.from), end_ref(&edge.to), kind_word(edge.kind)),
            action: action.clone(),
            argv: None,
            target_name: other_end(&edge.from, &edge.to, caller).map(|t| end_name(&state, &t)),
            target: other_end(&edge.from, &edge.to, caller),
            deleting: Some(&edge.id),
        },
    )?;
    graph::remove_edge(app, &edge.id)?;
    live_edges::forget_edge(app, &edge.id);
    if gate.silent() {
        approvals::notice(app, &format!("{} {}", caller_name(&state, caller), action.replacen("unlink", "unlinked", 1)));
    }
    let mut result = json!({ "edgeId": edge.id });
    gate.finish(app, &mut result);
    Ok(result)
}

// --- set_status --------------------------------------------------------------------------------

/// A status text as the card shows it: cleaned like a peer value (control characters and U+2028 /
/// U+2029 stripped, trimmed, cut to 120 characters); `None` when nothing is left.
pub fn status_value(text: &str) -> Option<String> {
    Some(crate::claude::launch::peer_value(text)).filter(|t| !t.is_empty())
}

/// `set_status({text})`: no approval. The caller's card shows the text on its second line until
/// its state changes or the next `set_status`; an empty text clears it. Runtime only. Returns
/// `{statusText}`.
pub fn set_status<R: Runtime>(app: &AppHandle<R>, caller: &str, args: &Value) -> Result<Value, String> {
    let raw = match args.get("text") {
        Some(Value::String(text)) => text.clone(),
        None | Some(Value::Null) => String::new(),
        Some(_) => return Err("text must be a string".to_string()),
    };
    let value = status_value(&raw);
    let running = app
        .state::<AppState>()
        .read_sessions_live()
        .sessions
        .get(caller)
        .is_some_and(|s| s.state.is_live());
    if !running {
        return Err(NOT_RUNNING.to_string());
    }
    let stored = value.clone();
    crate::claude::live::update_and_emit(app, move |map| map.set_status_text(caller, stored));
    Ok(json!({ "statusText": value }))
}
