use super::*;
use crate::claude::hooks::tests::{http, raw};
use crate::claude::live::StateSource;
use crate::graph::{Edge, EdgeKind, KnownWorktree, NodeRef, NodeType};
use tauri::Manager;

fn stub_tools() -> Tools {
    Arc::new(|session, tool, args| match tool {
        "my_node" => Ok(json!({ "nodeId": session })),
        "node" => Err(format!("unknown node: {}", args["id"].as_str().unwrap_or(""))),
        _ => Ok(json!({ "tool": tool })),
    })
}

fn rpc(tools: &Tools, message: Value) -> Reply {
    dispatch(tools, "s1", message.to_string().as_bytes())
}

fn ok_body(reply: Reply) -> Value {
    match reply {
        Reply::Json(StatusCode::OK, body) => body,
        other => panic!("not a 200 JSON reply: {other:?}"),
    }
}

/// The text of a `tools/call` result and whether it is an error.
fn tool_text(body: &Value) -> (String, bool) {
    let result = &body["result"];
    let content = result["content"].as_array().expect("content");
    assert_eq!(content.len(), 1, "a single content item");
    assert_eq!(content[0]["type"], "text");
    (content[0]["text"].as_str().unwrap().to_string(), result["isError"].as_bool().unwrap())
}

#[test]
fn initialize_ping_and_tools_list() {
    let tools = stub_tools();
    let body = ok_body(rpc(&tools, json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": { "protocolVersion": "2025-03-26", "capabilities": {}, "clientInfo": { "name": "claude-code", "version": "2" } } })));
    assert_eq!(body["id"], 1);
    assert_eq!(body["result"]["serverInfo"]["name"], "switchboard");
    assert_eq!(body["result"]["protocolVersion"], "2025-03-26", "the client's version when spoken");
    assert!(body["result"]["capabilities"]["tools"].is_object());
    let body = ok_body(rpc(&tools, json!({ "jsonrpc": "2.0", "id": "a", "method": "initialize", "params": { "protocolVersion": "1999-01-01" } })));
    assert_eq!(body["result"]["protocolVersion"], PROTOCOL_VERSIONS[0]);
    assert_eq!(PROTOCOL_VERSIONS, ["2025-06-18", "2025-03-26"], "only what the handler meets, newest first");
    let body = ok_body(rpc(&tools, json!({ "jsonrpc": "2.0", "id": "b", "method": "initialize", "params": { "protocolVersion": "2024-11-05" } })));
    assert_eq!(body["result"]["protocolVersion"], "2025-06-18", "the old HTTP+SSE version is not offered");

    assert_eq!(ok_body(rpc(&tools, json!({ "jsonrpc": "2.0", "id": 2, "method": "ping" })))["result"], json!({}));

    let body = ok_body(rpc(&tools, json!({ "jsonrpc": "2.0", "id": 3, "method": "tools/list" })));
    let listed = body["result"]["tools"].as_array().unwrap();
    let names: Vec<&str> = listed.iter().map(|t| t["name"].as_str().unwrap()).collect();
    assert_eq!(names, TOOLS);
    for tool in listed {
        assert_eq!(tool["inputSchema"]["type"], "object", "{tool}");
        let read = READ_TOOLS.contains(&tool["name"].as_str().unwrap());
        assert_eq!(tool["annotations"]["readOnlyHint"], read, "{tool}");
    }
    // Story 7.2: the act tools follow the read tools (Story 7.4: request_review last of them).
    assert_eq!(&names[5..10], ACT_TOOLS);
    // Story 7.3: then the peer tools.
    assert_eq!(&names[10..], PEER_TOOLS);
    // request_review and the peer tools change something but never destroy anything.
    for tool in &listed[9..] {
        assert_eq!(tool["annotations"]["readOnlyHint"], false, "{tool}");
        assert_eq!(tool["annotations"]["destructiveHint"], false, "{tool}");
    }
    assert_eq!(listed[9]["inputSchema"]["required"], json!(["summary"]));
    assert_eq!(listed[9]["inputSchema"]["properties"]["paths"]["maxItems"], 50);
    assert_eq!(listed[10]["inputSchema"]["required"], json!(["peer", "text"]));
    assert_eq!(listed[11]["inputSchema"]["properties"], json!({}), "inbox takes no argument");
    assert_eq!(listed[6]["inputSchema"]["required"], json!(["from", "to", "kind"]));
    assert_eq!(listed[7]["inputSchema"]["required"], json!(["edgeId"]));
    assert_eq!(listed[7]["annotations"]["destructiveHint"], true);
    assert_eq!(listed[8]["inputSchema"]["required"], json!(["text"]));
    let start = &listed[5]["inputSchema"]["properties"];
    for key in ["project", "branch", "prompt", "name", "model", "effort", "permissionMode", "addDirs", "cooperateWithMe"] {
        assert!(start.get(key).is_some(), "start_session takes {key}");
    }
    assert!(!start["permissionMode"]["enum"].as_array().unwrap().contains(&json!("bypassPermissions")));
    assert_eq!(listed[0]["inputSchema"]["properties"], json!({}), "my_node takes no argument");
    assert_eq!(listed[2]["inputSchema"]["required"], json!(["id"]));
    assert_eq!(listed[4]["inputSchema"]["required"], json!(["project"]));
}

#[test]
fn notifications_and_responses_are_accepted_and_the_rest_is_an_error() {
    let tools = stub_tools();
    assert_eq!(rpc(&tools, json!({ "jsonrpc": "2.0", "method": "notifications/initialized" })), Reply::Accepted);
    assert_eq!(rpc(&tools, json!({ "jsonrpc": "2.0", "method": "notifications/cancelled", "params": { "requestId": 1 } })), Reply::Accepted);
    assert_eq!(rpc(&tools, json!({ "jsonrpc": "2.0", "id": 9, "result": {} })), Reply::Accepted);

    let body = ok_body(rpc(&tools, json!({ "jsonrpc": "2.0", "id": 4, "method": "resources/list" })));
    assert_eq!(body["error"]["code"], -32601);
    assert_eq!(body["id"], 4);

    let Reply::Json(status, body) = dispatch(&tools, "s1", b"not json") else { panic!() };
    assert_eq!((status, body["error"]["code"].clone()), (StatusCode::BAD_REQUEST, json!(-32700)));
    let Reply::Json(status, body) = rpc(&tools, json!([{ "jsonrpc": "2.0", "id": 1, "method": "ping" }])) else { panic!() };
    assert_eq!((status, body["error"]["code"].clone()), (StatusCode::BAD_REQUEST, json!(-32600)), "no batches");

    let body = ok_body(rpc(&tools, json!({ "jsonrpc": "2.0", "id": 5, "method": "tools/call", "params": {} })));
    assert_eq!(body["error"]["code"], -32602);
}

#[test]
fn tool_calls_reply_with_one_text_item_or_an_error() {
    let tools = stub_tools();
    let body = ok_body(rpc(&tools, json!({ "jsonrpc": "2.0", "id": 6, "method": "tools/call", "params": { "name": "my_node", "arguments": {} } })));
    let (text, error) = tool_text(&body);
    assert!(!error);
    assert_eq!(serde_json::from_str::<Value>(&text).unwrap(), json!({ "nodeId": "s1" }), "the caller is the token's session");
    // No `arguments` at all is an empty object.
    let body = ok_body(rpc(&tools, json!({ "jsonrpc": "2.0", "id": 7, "method": "tools/call", "params": { "name": "workspace" } })));
    assert_eq!(tool_text(&body), (r#"{"tool":"workspace"}"#.to_string(), false));
    // A tool's error, and an unknown tool: `isError` with a plain message.
    let body = ok_body(rpc(&tools, json!({ "jsonrpc": "2.0", "id": 8, "method": "tools/call", "params": { "name": "node", "arguments": { "id": "x" } } })));
    assert_eq!(tool_text(&body), ("unknown node: x".to_string(), true));
    let body = ok_body(rpc(&tools, json!({ "jsonrpc": "2.0", "id": 9, "method": "tools/call", "params": { "name": "nope", "arguments": {} } })));
    assert_eq!(tool_text(&body), ("unknown tool: nope".to_string(), true));
}

#[test]
fn a_panicking_tool_is_an_internal_error_with_the_request_id() {
    let tools: Tools = Arc::new(|_, _, _| panic!("a tool bug"));
    let body = ok_body(rpc(&tools, json!({ "jsonrpc": "2.0", "id": 42, "method": "tools/call", "params": { "name": "workspace" } })));
    assert_eq!(body["id"], 42);
    assert_eq!(body["error"]["code"], -32603);
}

#[test]
fn the_config_names_the_endpoint_and_the_bearer_and_the_read_peer_and_review_tools_are_allowed() {
    assert_eq!(
        config_json(4242, "t0k"),
        json!({ "mcpServers": { "switchboard": { "type": "http", "url": "http://127.0.0.1:4242/mcp", "headers": { "Authorization": "Bearer t0k" } } } })
    );
    assert_eq!(
        allowed_tools(),
        [
            "mcp__switchboard__my_node",
            "mcp__switchboard__workspace",
            "mcp__switchboard__node",
            "mcp__switchboard__peers",
            "mcp__switchboard__sessions",
            "mcp__switchboard__send",
            "mcp__switchboard__inbox",
            "mcp__switchboard__request_review"
        ]
    );
}

/// The real router on an ephemeral port with `tools`; the task is aborted on drop.
struct Server {
    port: u16,
    hooks: hooks::Hooks,
    task: Option<tauri::async_runtime::JoinHandle<()>>,
}

impl Drop for Server {
    fn drop(&mut self) {
        if let Some(task) = self.task.take() {
            task.abort();
        }
    }
}

fn server(tools: Tools) -> Server {
    let hooks = hooks::Hooks::default();
    let listener = hooks::bind().unwrap();
    let port = listener.local_addr().unwrap().port();
    let router = hooks::router(hooks.clone(), Arc::new(|_, _| {}), tools);
    let task = tauri::async_runtime::spawn(async move {
        let _ = hooks::serve(listener, router).await;
    });
    Server { port, hooks, task: Some(task) }
}

#[test]
fn the_endpoint_answers_known_tokens_and_refuses_the_rest_without_keeping_them() {
    let s = server(stub_tools());
    let token = s.hooks.register("s1");
    let call = json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": { "name": "my_node" } }).to_string();
    let post = |token: Option<&str>, body: &str| http(s.port, "POST", "/mcp", token, body.as_bytes());

    let (status, body) = post(Some(&token), &call);
    assert_eq!(status, 200);
    let reply: Value = serde_json::from_str(&body).unwrap();
    assert_eq!(tool_text(&reply), (r#"{"nodeId":"s1"}"#.to_string(), false));
    let head = format!("POST /mcp HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer {token}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", call.len());
    let (_, head, _) = raw(s.port, &head, call.as_bytes());
    assert!(head.to_ascii_lowercase().contains("content-type: application/json"), "{head}");
    // A notification: 202, no body.
    assert_eq!(post(Some(&token), r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#), (202, String::new()));
    // Authenticated but not POST: 405 (no SSE stream here), `Allow: POST`, the connection closed.
    let (status, head, _) = raw(s.port, &format!("GET /mcp HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer {token}\r\n\r\n"), b"");
    assert_eq!(status, 405);
    let head = head.to_ascii_lowercase();
    assert!(head.contains("allow: post") && head.contains("connection: close"), "{head}");
    // A body declared past the drain cap: refused at once, nothing read.
    let huge = format!("PUT /mcp HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer {token}\r\nContent-Length: {}\r\n\r\n", 64 * 1024 * 1024);
    assert_eq!(raw(s.port, &huge, b"").0, 405);
    // Authenticated, but the body is over 1 MiB: 413, an MCP refusal (not a hooks one).
    let big = vec![b' '; 2 * 1024 * 1024];
    assert_eq!(http(s.port, "POST", "/mcp", Some(&token), &big).0, 413);
    let d = s.hooks.diagnostics(0);
    assert_eq!((d.mcp_refused, d.refused), (1, 0));
    assert_eq!(d.mcp_refusals[0].reason, hooks::BODY_TOO_LARGE);

    // Refusals: no header, a wrong token, an expired one; 401 with no body.
    assert_eq!(post(None, &call), (401, String::new()));
    let wrong = "nope-not-a-token";
    assert_eq!(post(Some(wrong), &call), (401, String::new()));
    s.hooks.drop_session("s1");
    assert_eq!(post(Some(&token), &call), (401, String::new()));
    assert_eq!(http(s.port, "GET", "/mcp", None, b"").0, 401, "auth comes first");

    let d = s.hooks.diagnostics(0);
    assert_eq!(d.mcp_refused, 5);
    assert_eq!(d.refused, 0, "the hooks counter is the hooks'");
    let reasons: Vec<(&str, &str)> = d.mcp_refusals.iter().map(|r| (r.path.as_str(), r.reason.as_str())).collect();
    assert_eq!(
        reasons,
        [
            ("/mcp", MISSING_TOKEN),
            ("/mcp", UNKNOWN_TOKEN),
            ("/mcp", UNKNOWN_TOKEN),
            ("/mcp", MISSING_TOKEN),
            ("/mcp", hooks::BODY_TOO_LARGE)
        ],
        "newest first"
    );
    let wire = serde_json::to_string(&d).unwrap();
    assert!(!wire.contains(&token) && !wire.contains(wrong), "no token in the diagnostics: {wire}");
    assert!(d.mcp_refusals.iter().all(|r| r.at > 0));
}

#[test]
fn the_refusal_ring_keeps_the_last_twenty() {
    let hooks = hooks::Hooks::default();
    for i in 0..25 {
        hooks.note_mcp_refusal(&format!("/mcp{i}"), UNKNOWN_TOKEN);
    }
    let d = hooks.diagnostics(0);
    assert_eq!(d.mcp_refused, 25);
    assert_eq!(d.mcp_refusals.len(), hooks::MCP_REFUSAL_RING);
    assert_eq!(d.mcp_refusals[0].path, "/mcp24");
    assert_eq!(d.mcp_refusals[19].path, "/mcp5");
}

// ---------------------------------------------------------------------------------------
// The tools against app state
// ---------------------------------------------------------------------------------------

fn project(id: &str, label: &str, path: &str) -> Project {
    Project {
        id: id.into(),
        label: label.into(),
        path: path.into(),
        ..Project::default()
    }
}

fn live(project: &str, cwd: &str, name: &str, state: SessionState, last_line: Option<&str>) -> LiveSession {
    LiveSession {
        state,
        source: StateSource::App,
        pid: None,
        kind: None,
        name: Some(name.into()),
        project_id: Some(project.into()),
        cwd: cwd.into(),
        started_at: Some(1_792_000_000_000),
        attention_since: None,
        last_line: last_line.map(str::to_string),
        detail: None,
        status_text: None,
    }
}

fn edge(id: &str, kind: EdgeKind, from: (NodeType, &str), to: (NodeType, &str), label: Option<&str>) -> Edge {
    Edge {
        id: id.into(),
        from: NodeRef { kind: from.0, id: from.1.into() },
        to: NodeRef { kind: to.0, id: to.1.into() },
        kind,
        label: label.map(str::to_string),
        created_at: "2026-10-24T10:00:00.000Z".into(),
        agent_allowed: false,
    }
}

fn summary(id: &str, title: &str, last_active: &str) -> crate::claude::SessionSummary {
    crate::claude::SessionSummary {
        id: id.into(),
        title: title.into(),
        started_at: "2026-10-20T10:00:00.000Z".into(),
        last_active: last_active.into(),
        branch: Some("main".into()),
        messages: 3,
        cwd: Some("/w/api".into()),
    }
}

/// `api` (on `main`, with a linked worktree for `feat`) and `ui`; session `s1` live in the
/// `feat` worktree, cooperating with `s2` (live in `ui`), with a context edge to `ui` it was
/// launched with and one to `/w/docs` applied live; `old` historic in `api`.
fn fixture() -> tauri::App<tauri::test::MockRuntime> {
    let app = tauri::test::mock_builder()
        .manage(AppState::default())
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    let state = app.state::<AppState>();
    {
        let mut ws = state.write_workspace();
        ws.workspace.projects = vec![project("api", "api", "/w/api"), project("ui", "ui", "/w/ui")];
        ws.worktrees.insert("api".into(), vec![KnownWorktree { path: "/w/api-feat".into(), branch: Some("feat".into()) }]);
        ws.workspace.edges = vec![
            edge("e-coop", EdgeKind::Cooperate, (NodeType::Session, "s1"), (NodeType::Session, "s2"), Some("API shape for auth refresh")),
            edge("e-ctx", EdgeKind::Context, (NodeType::Session, "s1"), (NodeType::Project, "ui"), None),
            edge("e-docs", EdgeKind::Context, (NodeType::Session, "s1"), (NodeType::Folder, "/w/docs"), None),
        ];
        ws.discovered.insert("api".into(), vec![summary("old", "Fix the login bug", "2026-10-21T09:00:00.000Z")]);
    }
    {
        let mut map = state.write_sessions_live();
        map.sessions.insert("s1".into(), live("api", "/w/api-feat", "api-1", SessionState::Busy, None));
        map.sessions.insert("s2".into(), live("ui", "/w/ui", "ui-2", SessionState::Finished, Some(&format!("Done. {}", "x".repeat(300)))));
    }
    state.write_live().statuses.insert(
        "api".into(),
        crate::git::ProjectStatus::Repo(crate::git::RepoStatus { branch: "main".into(), detached: false, dirty: 0, ahead: 0, behind: 0 }),
    );
    state.launcher.record_add_dirs("s1", vec![graph::EdgeDir { path: "/w/ui".into(), via: crate::claude::launch::via_edge("ui") }]);
    crate::claude::live_edges::mark(app.handle(), "e-docs", "s1", EdgeState::Applied, None, Some("/w/docs".into()));
    // Applied to the session's own folder: not an add-dir.
    crate::claude::live_edges::mark(app.handle(), "e-own", "s1", EdgeState::Applied, Some(OWN_FOLDER), Some("/w/api-feat".into()));
    app
}

#[test]
fn my_node_names_the_caller_its_place_its_peers_and_its_folders() {
    let app = fixture();
    let state = app.state::<AppState>();
    let me = call(&state, "s1", "my_node", &json!({})).unwrap();
    assert_eq!(
        me,
        json!({
            "nodeId": "s1",
            "name": "api-1",
            "path": "api:feat / api-1",
            "project": { "id": "api", "label": "api", "path": "/w/api" },
            "branch": "feat",
            "worktree": "/w/api-feat",
            "cwd": "/w/api-feat",
            "statusText": null,
            "peers": [{ "nodeId": "s2", "name": "ui-2", "path": "ui / ui-2", "purpose": "API shape for auth refresh" }],
            "addDirs": [{ "path": "/w/ui", "via": "edge → ui" }, { "path": "/w/docs", "via": "/add-dir" }],
        })
    );
    assert_eq!(call(&state, "s1", "peers", &json!({})).unwrap(), me["peers"]);
    // The other side sees s1 as its peer; it has no worktree and no add-dirs.
    let other = call(&state, "s2", "my_node", &json!({})).unwrap();
    assert_eq!(other["peers"][0]["nodeId"], "s1");
    assert_eq!(other["worktree"], Value::Null);
    assert_eq!(other["addDirs"], json!([]));
    // The session ref's branch wins over the cwd's.
    state.write_workspace().workspace.sessions.push(graph::SessionRef {
        session_id: "s1".into(),
        project_id: "api".into(),
        branch_id: Some("api:release".into()),
        ..graph::SessionRef::default()
    });
    assert_eq!(call(&state, "s1", "my_node", &json!({})).unwrap()["branch"], "release");
    // In the project's own folder: the branch checked out there, no worktree.
    state.write_sessions_live().sessions.insert("s3".into(), live("api", "/w/api", "api-3", SessionState::Idle, None));
    let s3 = call(&state, "s3", "my_node", &json!({})).unwrap();
    assert_eq!((s3["branch"].clone(), s3["worktree"].clone()), (json!("main"), Value::Null));
    assert_eq!(s3["path"], "api:main / api-3");
}

#[test]
fn node_and_sessions_answer_by_id_and_refuse_the_unknown() {
    let app = fixture();
    let state = app.state::<AppState>();
    assert_eq!(call(&state, "s1", "node", &json!({ "id": "api" })).unwrap(), json!({ "id": "api", "label": "api", "path": "/w/api", "branch": "main" }));
    let s2 = call(&state, "s1", "node", &json!({ "id": "s2" })).unwrap();
    assert_eq!(s2["status"], "finished");
    assert_eq!(s2["project"]["id"], "ui");
    let line = s2["lastLine"].as_str().unwrap();
    assert_eq!(line.chars().count(), LAST_LINE_MAX + 1, "cut to 120 then …");
    assert!(line.starts_with("Done. ") && line.ends_with('…'));
    let old = call(&state, "s1", "node", &json!({ "id": "old" })).unwrap();
    assert_eq!(
        old,
        json!({ "nodeId": "old", "name": "Fix the login bug", "status": "historic", "lastLine": null, "project": { "id": "api", "label": "api", "path": "/w/api" }, "branch": "main", "statusText": null })
    );
    assert_eq!(call(&state, "s1", "node", &json!({ "id": "nope" })), Err("unknown node: nope".to_string()));
    assert_eq!(call(&state, "s1", "node", &json!({})), Err("id is required".to_string()));

    let listed = call(&state, "s1", "sessions", &json!({ "project": "api" })).unwrap();
    assert_eq!(listed["project"]["id"], "api");
    let rows: Vec<(&str, &str)> = listed["sessions"].as_array().unwrap().iter().map(|s| (s["nodeId"].as_str().unwrap(), s["status"].as_str().unwrap())).collect();
    assert_eq!(rows, [("s1", "busy"), ("old", "historic")], "live first");
    assert_eq!(listed["sessions"][1]["lastActive"], "2026-10-21T09:00:00.000Z");
    assert!(listed["sessions"][0]["lastActive"].as_str().unwrap().starts_with("20"), "a live-only session: its start");
    // By label (case aside), and unknown.
    assert_eq!(call(&state, "s1", "sessions", &json!({ "project": "UI" })).unwrap()["sessions"][0]["nodeId"], "s2");
    assert_eq!(call(&state, "s1", "sessions", &json!({ "project": "web" })), Err("unknown project: web".to_string()));
    assert_eq!(call(&state, "s1", "nope", &json!({})), Err("unknown tool: nope".to_string()));
}

#[test]
fn workspace_lists_projects_live_sessions_and_edges_only() {
    let app = fixture();
    let state = app.state::<AppState>();
    state.write_sessions_live().sessions.insert("gone".into(), live("api", "/w/api", "api-9", SessionState::Exited, None));
    let ws = call(&state, "s1", "workspace", &json!({})).unwrap();
    assert_eq!(ws.as_object().unwrap().keys().collect::<Vec<_>>(), ["edges", "projects"], "no positions, no viewport");
    assert_eq!(
        ws["projects"][0],
        json!({ "id": "api", "label": "api", "path": "/w/api", "sessions": [{ "nodeId": "s1", "name": "api-1", "status": "busy", "lastLine": null }] }),
        "no exited or historic session"
    );
    assert_eq!(ws["projects"][1]["sessions"][0]["lastLine"].as_str().unwrap().chars().count(), LAST_LINE_MAX + 1);
    assert_eq!(
        ws["edges"][0],
        json!({ "id": "e-coop", "kind": "cooperate", "from": "session:s1", "to": "session:s2", "label": "API shape for auth refresh" })
    );
    assert_eq!(ws["edges"][2]["to"], "folder:/w/docs");
    // Reading changed nothing.
    assert_eq!(state.read_sessions_live().sessions.len(), 3);
}

/// 10 projects × 3 live sessions and 10 edges, with ids, names and paths as long as real ones:
/// under 8 KB, with every project path, session and edge in it.
#[test]
fn a_ten_project_workspace_stays_under_eight_kilobytes() {
    let app = tauri::test::mock_builder()
        .manage(AppState::default())
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    let state = app.state::<AppState>();
    let uuid = || uuid::Uuid::new_v4().to_string();
    let mut sessions = Vec::new();
    {
        let mut ws = state.write_workspace();
        let mut map = state.write_sessions_live();
        for p in 0..10 {
            let (id, label) = (uuid(), format!("project-{p:02}"));
            let path = format!("/home/operator/work/clients/{label}");
            for (s, status) in [SessionState::Finished, SessionState::Busy, SessionState::Waiting].into_iter().enumerate() {
                let sid = uuid();
                let last = (status == SessionState::Finished).then(|| format!("Refactored the token refresh flow and updated the tests in module {s}; {}", "details ".repeat(40)));
                map.sessions.insert(sid.clone(), live(&id, &path, &format!("{label}-{}", &sid[..4]), status, last.as_deref()));
                sessions.push(sid);
            }
            ws.workspace.projects.push(project(&id, &label, &path));
        }
        for e in 0..10 {
            let (from, to) = (&sessions[e * 3], &sessions[(e * 3 + 4) % 30]);
            ws.workspace.edges.push(edge(&uuid(), if e % 2 == 0 { EdgeKind::Cooperate } else { EdgeKind::Context }, (NodeType::Session, from), (NodeType::Session, to), Some("shared API contract")));
        }
    }
    let text = call(&state, "s1", "workspace", &json!({})).unwrap().to_string();
    println!("workspace(): {} bytes", text.len());
    assert!(text.len() < 8192, "{} bytes", text.len());
    let ws: Value = serde_json::from_str(&text).unwrap();
    assert_eq!(ws["projects"].as_array().unwrap().len(), 10);
    assert!(ws["projects"].as_array().unwrap().iter().all(|p| p["path"].as_str().unwrap().starts_with("/home/operator/") && p["sessions"].as_array().unwrap().len() == 3));
    assert_eq!(ws["edges"].as_array().unwrap().len(), 10);
    let lines = ws["projects"].as_array().unwrap().iter().flat_map(|p| p["sessions"].as_array().unwrap().clone()).filter(|s| s["lastLine"].as_str().is_some_and(|l| l.starts_with("Refactored"))).count();
    assert_eq!(lines, 10, "every finished session's last line");
    assert!(ws.get("lastLinesCut").is_none(), "nothing cut shorter");

    // Every session finished with a long last line: the lines are cut shorter to stay in budget.
    for session in state.write_sessions_live().sessions.values_mut() {
        session.state = SessionState::Finished;
        session.last_line = Some(format!("Finished: {}", "a long account of the work ".repeat(20)));
    }
    let text = call(&state, "s1", "workspace", &json!({})).unwrap().to_string();
    assert!(text.len() <= WORKSPACE_BUDGET, "{} bytes", text.len());
    let ws: Value = serde_json::from_str(&text).unwrap();
    assert_eq!(ws["lastLinesCut"], 40);
    let line = ws["projects"][3]["sessions"][1]["lastLine"].as_str().unwrap();
    assert_eq!(line.chars().count(), 41);
    assert!(line.starts_with("Finished: ") && line.ends_with('…'));
}

#[test]
fn node_takes_the_edge_ends_workspace_lists() {
    let app = fixture();
    let state = app.state::<AppState>();
    assert_eq!(call(&state, "s1", "node", &json!({ "id": "project:api" })).unwrap()["id"], "api");
    assert_eq!(call(&state, "s1", "node", &json!({ "id": "session:s2" })).unwrap()["nodeId"], "s2");
    assert_eq!(call(&state, "s1", "node", &json!({ "id": "folder:/w/docs" })), Err("not a project or session node: folder:/w/docs".to_string()));
    assert_eq!(call(&state, "s1", "node", &json!({ "id": "branch:api:feat" })), Err("not a project or session node: branch:api:feat".to_string()));
    assert_eq!(call(&state, "s1", "node", &json!({ "id": "session:nope" })), Err("unknown node: nope".to_string()));
}

#[test]
fn sessions_order_by_parsed_time_prefer_live_activity_and_refuse_a_shared_label() {
    let app = fixture();
    let state = app.state::<AppState>();
    {
        let mut ws = state.write_workspace();
        let list = ws.discovered.get_mut("api").unwrap();
        // 08:30Z, though it sorts after 09:00Z as a string.
        list.push(summary("b", "Earlier", "2026-10-21T10:30:00+02:00"));
        // A stale transcript of the live session.
        list.push(summary("s1", "api-1", "2020-01-01T00:00:00.000Z"));
        ws.workspace.projects.push(project("w1", "web", "/w/web1"));
        ws.workspace.projects.push(project("w2", "web", "/w/web2"));
    }
    state.write_sessions_live().sessions.insert("gone".into(), live("api", "/w/api", "api-9", SessionState::Exited, None));
    let listed = call(&state, "s1", "sessions", &json!({ "project": "api" })).unwrap();
    let rows: Vec<(&str, &str, &str)> = listed["sessions"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| (s["nodeId"].as_str().unwrap(), s["status"].as_str().unwrap(), s["lastActive"].as_str().unwrap()))
        .collect();
    let started = crate::claude::transcript::format_iso_ms(1_792_000_000_000);
    assert_eq!(
        rows,
        [
            ("s1", "busy", started.as_str()),
            ("old", "historic", "2026-10-21T09:00:00.000Z"),
            ("b", "historic", "2026-10-21T08:30:00.000Z"),
            ("gone", "exited", started.as_str()),
        ]
    );
    assert_eq!(call(&state, "s1", "sessions", &json!({ "project": "web" })), Err("ambiguous project label web: w1, w2; give the id".to_string()));
    assert_eq!(call(&state, "s1", "sessions", &json!({ "project": "w2" })).unwrap()["project"]["path"], "/w/web2");
}

fn branch_info(name: &str, chip: Option<(&str, bool)>) -> crate::git::BranchInfo {
    crate::git::BranchInfo {
        name: name.into(),
        head: false,
        upstream: None,
        ahead: 0,
        behind: 0,
        gone: false,
        committed_at: 0,
        worktree: chip.map(|(path, missing)| crate::git::WorktreeChip { path: path.into(), missing }),
    }
}

#[test]
fn my_node_finds_the_worktree_from_branch_chips_then_stored_branch_nodes() {
    let app = fixture();
    let state = app.state::<AppState>();
    let place = || {
        let me = call(&state, "s1", "my_node", &json!({})).unwrap();
        (me["branch"].clone(), me["worktree"].clone())
    };
    // No status-poll worktrees: the branch list's chip.
    state.write_workspace().worktrees.clear();
    state.write_workspace().branches.insert("api".into(), vec![branch_info("feat", Some(("/w/api-feat", false)))]);
    assert_eq!(place(), (json!("feat"), json!("/w/api-feat")));
    // A chip marked missing is skipped: nothing else knows the folder.
    state.write_workspace().branches.insert("api".into(), vec![branch_info("feat", Some(("/w/api-feat", true)))]);
    assert_eq!(place(), (Value::Null, Value::Null));
    // A stored branch node's worktree path.
    state.write_workspace().workspace.branches.push(graph::BranchNode {
        id: "api:feat-2".into(),
        project_id: "api".into(),
        name: "feat-2".into(),
        worktree_path: Some("/w/api-feat".into()),
        position: None,
    });
    assert_eq!(place(), (json!("feat-2"), json!("/w/api-feat")));
}

#[test]
fn workspace_cleans_and_caps_names_and_labels_and_degrades_to_fit() {
    let app = fixture();
    let state = app.state::<AppState>();
    state.write_sessions_live().sessions.get_mut("s1").unwrap().name = Some(format!("evil\nname\u{1b}[31m {}", "n".repeat(500)));
    state.write_workspace().workspace.projects[1].label = format!("ui\r\n{}", "l".repeat(500));
    state.write_workspace().workspace.edges[0].label = Some(format!("say \"hi\"\n{}", "e".repeat(500)));
    let ws = workspace(&state);
    let name = ws["projects"][0]["sessions"][0]["name"].as_str().unwrap();
    assert!(name.starts_with("evilname[31m") && name.chars().count() == 121 && !name.chars().any(char::is_control), "{name}");
    let label = ws["projects"][1]["label"].as_str().unwrap();
    assert!(label.starts_with("uil") && label.chars().count() == 121, "{label}");
    let edge_label = ws["edges"][0]["label"].as_str().unwrap();
    assert!(edge_label.starts_with("say 'hi'e") && edge_label.chars().count() == 121, "{edge_label}");

    // Many sessions with long last lines: cut to 40, then left out.
    {
        let mut map = state.write_sessions_live();
        for i in 0..70 {
            map.sessions.insert(format!("bulk-{i:03}"), live("api", "/w/api", "b", SessionState::Finished, Some(&"z".repeat(300))));
        }
    }
    let ws = workspace(&state);
    assert_eq!(ws["lastLinesCut"], "omitted");
    assert!(ws.get("truncated").is_none());
    assert!(ws["projects"][0]["sessions"].as_array().unwrap().iter().all(|s| s["lastLine"].is_null()));
    assert_eq!(ws["edges"][0]["label"].as_str().unwrap().chars().count(), 121, "edge labels kept");

    // Still over without last lines (many long edge labels): the labels go and it says so.
    state.write_sessions_live().sessions.retain(|id, _| !id.starts_with("bulk-"));
    {
        let mut ws = state.write_workspace();
        for i in 0..80 {
            ws.workspace.edges.push(edge(&format!("x{i}"), EdgeKind::Context, (NodeType::Project, "api"), (NodeType::Project, "ui"), Some(&"q".repeat(300))));
        }
    }
    let ws = workspace(&state);
    assert_eq!((ws["lastLinesCut"].clone(), ws["truncated"].clone()), (json!("omitted"), json!(true)));
    assert!(ws["edges"].as_array().unwrap().iter().all(|e| e["label"].is_null()));
    assert_eq!(ws["edges"].as_array().unwrap().len(), 83, "every edge still listed");
}

// ---------------------------------------------------------------------------------------
// The act tools (Story 7.2): link, unlink and set_status against app state
// ---------------------------------------------------------------------------------------

/// [`fixture`] with its live sessions drawn as children, as the live poll draws them (an edge
/// may end on them).
fn act_fixture() -> tauri::App<tauri::test::MockRuntime> {
    let app = fixture();
    let children = app.state::<AppState>().read_sessions_live().live_children();
    graph::set_live_children(app.handle(), children);
    app
}

/// Run act tool `tool` for `session` on a thread (it may wait for the operator).
fn act_on_thread(app: &tauri::App<tauri::test::MockRuntime>, session: &str, tool: &str, args: Value) -> std::thread::JoinHandle<Result<Value, String>> {
    let handle = app.handle().clone();
    let (session, tool) = (session.to_string(), tool.to_string());
    std::thread::spawn(move || call_app(&handle, &session, &tool, &args))
}

/// The pending requests once there are `count` of them.
fn pending(app: &tauri::App<tauri::test::MockRuntime>, count: usize) -> Vec<crate::approvals::PendingRequest> {
    let state = app.state::<AppState>();
    let started = std::time::Instant::now();
    loop {
        let list = state.approvals.list();
        if list.len() == count {
            return list;
        }
        assert!(started.elapsed() < std::time::Duration::from_secs(10), "timed out waiting for {count} pending: {list:?}");
        std::thread::sleep(std::time::Duration::from_millis(5));
    }
}

fn notices(app: &tauri::App<tauri::test::MockRuntime>) -> Arc<std::sync::Mutex<Vec<String>>> {
    use tauri::Listener;
    let seen: Arc<std::sync::Mutex<Vec<String>>> = Arc::default();
    let record = seen.clone();
    app.listen_any(crate::approvals::NOTICE_EVENT, move |event| {
        record.lock().unwrap().push(serde_json::from_str(event.payload()).unwrap());
    });
    seen
}

#[test]
fn set_status_is_cleaned_shown_by_the_read_tools_and_cleared_by_a_state_change() {
    let app = act_fixture();
    let state = app.state::<AppState>();
    let reply = call_app(app.handle(), "s1", "set_status", &json!({ "text": "  waiting on ui's endpoint\u{2028}\n " })).unwrap();
    assert_eq!(reply, json!({ "statusText": "waiting on ui's endpoint" }));
    assert!(state.approvals.list().is_empty(), "set_status never asks");
    assert_eq!(state.read_sessions_live().sessions["s1"].status_text.as_deref(), Some("waiting on ui's endpoint"));
    assert_eq!(call(&state, "s2", "node", &json!({ "id": "s1" })).unwrap()["statusText"], "waiting on ui's endpoint");
    assert_eq!(call(&state, "s1", "my_node", &json!({})).unwrap()["statusText"], "waiting on ui's endpoint");
    assert_eq!(call(&state, "s1", "sessions", &json!({ "project": "api" })).unwrap()["sessions"][0]["statusText"], "waiting on ui's endpoint");
    // Cut to 120 characters like a peer value.
    let long = call_app(app.handle(), "s1", "set_status", &json!({ "text": "x".repeat(300) })).unwrap();
    assert_eq!(long["statusText"].as_str().unwrap().chars().count(), crate::claude::launch::MAX_PEER_VALUE_CHARS + 1);
    // The same state again keeps it (a tool finishing while busy); a state change clears it.
    call_app(app.handle(), "s1", "set_status", &json!({ "text": "on it" })).unwrap();
    state.write_sessions_live().apply_hook("s1", &crate::claude::hooks::HookSignal::ToolDone, 1);
    assert_eq!(state.read_sessions_live().sessions["s1"].status_text.as_deref(), Some("on it"));
    state.write_sessions_live().apply_hook("s1", &crate::claude::hooks::HookSignal::Finished { last_line: None }, 2);
    assert_eq!(state.read_sessions_live().sessions["s1"].status_text, None);
    // An empty text clears it.
    call_app(app.handle(), "s1", "set_status", &json!({ "text": "again" })).unwrap();
    assert_eq!(call_app(app.handle(), "s1", "set_status", &json!({ "text": "" })).unwrap(), json!({ "statusText": null }));
    assert_eq!(state.read_sessions_live().sessions["s1"].status_text, None);
    // Not a running session.
    assert_eq!(call_app(app.handle(), "nope", "set_status", &json!({ "text": "x" })), Err(act::NOT_RUNNING.to_string()));
}

#[test]
fn a_bad_link_is_refused_with_the_reason_and_no_toast() {
    let app = act_fixture();
    let state = app.state::<AppState>();
    let link = |args: Value| call_app(app.handle(), "s1", "link", &args);
    assert_eq!(
        link(json!({ "from": "self", "to": "session:s2", "kind": "context" })),
        Err("kind context does not match: the app links these as cooperate".to_string())
    );
    assert_eq!(link(json!({ "from": "project:api", "to": "self", "kind": "context" })), Err(graph::REFUSE_PROJECT_TO_SESSION.to_string()));
    assert_eq!(link(json!({ "from": "self", "to": "project:ui", "kind": "context" })), Err(graph::REFUSE_DUPLICATE.to_string()));
    assert_eq!(link(json!({ "from": "self", "to": "project:nope", "kind": "context" })), Err("unknown project".to_string()));
    assert!(link(json!({ "from": "api", "to": "self", "kind": "context" })).unwrap_err().starts_with("unknown end api"));
    assert_eq!(link(json!({ "from": "self", "to": "project:api", "kind": "sideways" })), Err("unknown kind sideways: context or cooperate".to_string()));
    assert_eq!(call_app(app.handle(), "s1", "unlink", &json!({ "edgeId": "nope" })), Err("unknown edge".to_string()));
    assert!(state.approvals.list().is_empty(), "no toast for a refusal");
    assert_eq!(state.read_workspace().workspace.edges.len(), 3, "nothing stored");
}

#[test]
fn link_and_unlink_wait_for_the_operator_and_always_covers_the_edge_until_revoked() {
    let app = act_fixture();
    let state = app.state::<AppState>();
    let seen = notices(&app);
    // No edge joins s1 and api: Allow / Deny only.
    let call = act_on_thread(&app, "s1", "link", json!({ "from": "self", "to": "project:api", "kind": "context", "label": "shared\nschema" }));
    let request = pending(&app, 1).remove(0);
    assert_eq!((request.caller.as_str(), request.caller_name.as_str(), request.tool.as_str()), ("s1", "api-1", "link"));
    assert_eq!(request.action, "link api-1 → api (context) \"shared schema\"");
    assert_eq!(request.detail, "session:s1 → project:api (context)");
    assert!(!request.always);
    crate::approvals::answer(app.handle(), &request.id, crate::approvals::Answer::Deny).unwrap();
    assert_eq!(call.join().unwrap(), Err("the operator denied: link api-1 → api (context) \"shared schema\"".to_string()));
    assert_eq!(state.read_workspace().workspace.edges.len(), 3);

    let call = act_on_thread(&app, "s1", "link", json!({ "from": "self", "to": "project:api", "kind": "context", "label": "shared\nschema" }));
    let request = pending(&app, 1).remove(0);
    crate::approvals::answer(app.handle(), &request.id, crate::approvals::Answer::Allow).unwrap();
    let edge_id = call.join().unwrap().unwrap()["edgeId"].as_str().unwrap().to_string();
    let stored = state.read_workspace().workspace.edges.iter().find(|e| e.id == edge_id).cloned().unwrap();
    assert_eq!((stored.kind, stored.label.as_deref(), stored.agent_allowed), (EdgeKind::Context, Some("shared schema"), false));
    assert!(seen.lock().unwrap().is_empty(), "asked: no notice");

    // s2 and api are joined by an edge (stored directly): Always is offered.
    state.write_workspace().workspace.edges.push(edge("e-x", EdgeKind::Context, (NodeType::Project, "api"), (NodeType::Session, "s2"), None));
    let call = act_on_thread(&app, "s2", "link", json!({ "from": "self", "to": "project:api", "kind": "context" }));
    let request = pending(&app, 1).remove(0);
    assert!(request.always);
    crate::approvals::answer(app.handle(), &request.id, crate::approvals::Answer::Always).unwrap();
    let linked = call.join().unwrap().unwrap()["edgeId"].as_str().unwrap().to_string();
    let allowed = |id: &str| state.read_workspace().workspace.edges.iter().find(|e| e.id == id).map(|e| e.agent_allowed);
    assert_eq!(allowed("e-x"), Some(true), "Always is stored on the joining edge");
    // The next act of s2 on api runs without a toast, with a notice.
    let reply = call_app(app.handle(), "s2", "unlink", &json!({ "edgeId": linked })).unwrap();
    assert_eq!(reply["edgeId"], linked.as_str());
    assert!(allowed(&linked).is_none(), "deleted");
    assert_eq!(*seen.lock().unwrap(), ["ui-2 unlinked ui-2 → api (context)".to_string()]);
    // Revoke: the next act asks again.
    graph::set_edge_agent_allowed(app.handle(), "e-x", false).unwrap();
    let call = act_on_thread(&app, "s2", "link", json!({ "from": "self", "to": "project:api", "kind": "context" }));
    let request = pending(&app, 1).remove(0);
    assert!(request.always);
    crate::approvals::answer(app.handle(), &request.id, crate::approvals::Answer::Deny).unwrap();
    assert!(call.join().unwrap().unwrap_err().starts_with(act::DENIED));

    // Allow all: no toast at all, a notice each time; the edge's policy goes with the edge.
    graph::set_agent_actions(app.handle(), graph::AgentActions::AllowAll);
    let reply = call_app(app.handle(), "s1", "unlink", &json!({ "edgeId": edge_id })).unwrap();
    assert_eq!(reply["edgeId"], edge_id.as_str());
    assert_eq!(seen.lock().unwrap().last().unwrap(), "api-1 unlinked api-1 → api (context) \"shared schema\"");
    graph::set_edge_agent_allowed(app.handle(), "e-x", true).unwrap();
    call_app(app.handle(), "s1", "unlink", &json!({ "edgeId": "e-x" })).unwrap();
    assert!(state.read_workspace().workspace.edges.iter().all(|e| e.id != "e-x"));
    assert!(state.approvals.list().is_empty());
}

#[test]
fn an_unanswered_link_is_denied_after_the_timeout() {
    let app = act_fixture();
    let state = app.state::<AppState>();
    state.approvals.set_timeout(std::time::Duration::from_millis(300));
    assert_eq!(
        call_app(app.handle(), "s1", "link", &json!({ "from": "self", "to": "project:api", "kind": "context" })),
        Err(crate::approvals::NO_ANSWER.to_string())
    );
    assert!(state.approvals.list().is_empty(), "the toast went");
    assert_eq!(state.read_workspace().workspace.edges.len(), 3);
}

#[test]
fn the_tool_list_is_the_read_tools_then_the_act_tools_then_the_peer_tools() {
    assert_eq!(TOOLS.to_vec(), [READ_TOOLS.as_slice(), ACT_TOOLS.as_slice(), PEER_TOOLS.as_slice()].concat());
}

#[test]
fn always_on_an_unlink_lands_on_the_surviving_edge_and_is_not_offered_for_the_deleted_one() {
    let app = act_fixture();
    let state = app.state::<AppState>();
    let allowed = |id: &str| state.read_workspace().workspace.edges.iter().find(|e| e.id == id).map(|e| e.agent_allowed);
    // e-ctx is the only edge joining s1 and ui: unlinking it offers no Always.
    let call = act_on_thread(&app, "s1", "unlink", json!({ "edgeId": "e-ctx" }));
    let request = pending(&app, 1).remove(0);
    assert!(!request.always, "the deleted edge is never the one offered");
    crate::approvals::answer(app.handle(), &request.id, crate::approvals::Answer::Deny).unwrap();
    assert!(call.join().unwrap().is_err());
    // A second edge joins them (stored directly): Always is offered and lands on it, after the unlink.
    state.write_workspace().workspace.edges.push(edge("e-back", EdgeKind::Context, (NodeType::Project, "ui"), (NodeType::Session, "s1"), None));
    let call = act_on_thread(&app, "s1", "unlink", json!({ "edgeId": "e-ctx" }));
    let request = pending(&app, 1).remove(0);
    assert!(request.always);
    assert_eq!(request.target.as_deref(), Some("ui"));
    crate::approvals::answer(app.handle(), &request.id, crate::approvals::Answer::Always).unwrap();
    let reply = call.join().unwrap().unwrap();
    assert!(reply.get("policyError").is_none(), "{reply}");
    assert_eq!(allowed("e-ctx"), None, "deleted");
    assert_eq!(allowed("e-back"), Some(true));
}

#[test]
fn always_is_stored_only_when_the_act_succeeds_and_a_failed_store_is_reported() {
    let app = act_fixture();
    let state = app.state::<AppState>();
    state.write_workspace().workspace.edges.push(edge("e-x", EdgeKind::Context, (NodeType::Project, "api"), (NodeType::Session, "s2"), None));
    // The act fails after Always (the link became a duplicate meanwhile): no policy is stored.
    let call = act_on_thread(&app, "s2", "link", json!({ "from": "self", "to": "project:api", "kind": "context" }));
    let request = pending(&app, 1).remove(0);
    state.write_workspace().workspace.edges.push(edge("dup", EdgeKind::Context, (NodeType::Session, "s2"), (NodeType::Project, "api"), None));
    crate::approvals::answer(app.handle(), &request.id, crate::approvals::Answer::Always).unwrap();
    assert_eq!(call.join().unwrap(), Err(graph::REFUSE_DUPLICATE.to_string()));
    assert!(state.read_workspace().workspace.edges.iter().all(|e| !e.agent_allowed));
    // The act succeeds but the edge went meanwhile: the result says the policy was not stored.
    state.write_workspace().workspace.edges.retain(|e| e.id != "dup");
    let call = act_on_thread(&app, "s2", "link", json!({ "from": "self", "to": "project:api", "kind": "context", "label": "x".repeat(150) }));
    let request = pending(&app, 1).remove(0);
    assert_eq!(request.action, format!("link ui-2 → api (context) \"{}\"", "x".repeat(150)), "the label as stored, not cut at 120");
    state.write_workspace().workspace.edges.retain(|e| e.id != "e-x");
    crate::approvals::answer(app.handle(), &request.id, crate::approvals::Answer::Always).unwrap();
    let reply = call.join().unwrap().unwrap();
    assert!(reply["policyError"].as_str().unwrap().contains("unknown edge"), "{reply}");
    let id = reply["edgeId"].as_str().unwrap();
    let stored = state.read_workspace().workspace.edges.iter().find(|e| e.id == id).cloned().unwrap();
    assert_eq!(stored.label, Some("x".repeat(150)), "stored with its label");
}

#[test]
fn a_long_prompt_and_a_caller_off_the_canvas_are_refused_before_asking() {
    let app = act_fixture();
    let state = app.state::<AppState>();
    assert_eq!(
        call_app(app.handle(), "s1", "start_session", &json!({ "project": "ui", "prompt": "p".repeat(act::MAX_PROMPT_CHARS + 1) })),
        Err(format!("prompt is over {} characters", act::MAX_PROMPT_CHARS))
    );
    // A live session the canvas does not draw (no project): cooperateWithMe is refused at once.
    state.write_sessions_live().sessions.insert("lost".into(), live("nowhere", "/x", "lost", SessionState::Busy, None));
    *state.launcher.program.lock().unwrap() = Some((std::path::PathBuf::from("prog"), Vec::new()));
    state.launcher.set_dir(std::env::temp_dir());
    assert_eq!(
        call_app(app.handle(), "lost", "start_session", &json!({ "project": "ui", "cooperateWithMe": true })),
        Err(crate::ipc::NOT_AN_EDGE_END.to_string())
    );
    assert!(state.approvals.list().is_empty());
}

/// Story 7.3: `send` reaches a cooperate peer (by id, `session:<id>` or name, exact then ignoring
/// case) and nobody else; `inbox()` returns each message once, in arrival order, and clears the
/// count; the text keeps its line breaks and loses other control characters; a blank or too long
/// text is refused; an inbox holds at most 100; a peer not running is told `running: false` and
/// no nudge waits for it.
#[test]
fn send_reaches_only_cooperate_peers_and_inbox_returns_each_message_once() {
    use crate::inbox::{self, MAX_TEXT_CHARS, MAX_UNREAD, NOT_A_PEER};
    let app = fixture();
    let state = app.state::<AppState>();
    let send = |from: &str, peer: &str, text: &str| call_app(app.handle(), from, "send", &json!({ "peer": peer, "text": text }));
    let read = |who: &str| call_app(app.handle(), who, "inbox", &json!({})).unwrap();

    let text = "endpoint is POST /auth/refresh, returns {token, expiresAt}";
    assert_eq!(send("s1", "ui-2", text), Ok(json!({ "delivered": true, "to": "ui-2", "unread": 1, "running": false })));
    assert_eq!(state.inbox.count("s2"), 1);
    assert_eq!(state.inbox.unread(), std::collections::BTreeMap::from([("s2".to_string(), 1)]));
    assert!(!state.inbox.nudge_pending("s2"), "a peer not running is not nudged now");
    let first = read("s2");
    let list = first.as_array().unwrap();
    assert_eq!(list.len(), 1);
    assert_eq!(list[0]["from"], "api-1");
    assert_eq!(list[0]["fromNodeId"], "s1");
    assert_eq!(list[0]["text"], text);
    assert!(list[0]["at"].as_str().unwrap().ends_with('Z'));
    assert_eq!(read("s2"), json!([]), "each message once");
    assert!(state.inbox.unread().is_empty(), "the badge clears");

    // By id, by edge-end id, ignoring case; the other way round too.
    send("s1", "s2", "one").unwrap();
    send("s1", "session:s2", "two").unwrap();
    assert_eq!(send("s1", "UI-2", "three").unwrap()["unread"], 3);
    send("s2", "api-1", "back").unwrap();
    let texts: Vec<Value> = read("s2").as_array().unwrap().iter().map(|m| m["text"].clone()).collect();
    assert_eq!(texts, [json!("one"), json!("two"), json!("three")], "arrival order");
    assert_eq!(read("s1")[0]["from"], "ui-2");

    // Not a peer: a session with no cooperate edge to the caller, an unknown name, the caller.
    {
        let mut map = state.write_sessions_live();
        map.sessions.insert("s3".into(), live("ui", "/w/ui", "ui-3", SessionState::Idle, None));
    }
    for peer in ["s3", "ui-3", "nobody", "s1", "api-1"] {
        let err = send("s1", peer, "hi").unwrap_err();
        assert!(err.starts_with(NOT_A_PEER), "{peer}: {err}");
    }
    assert_eq!(state.inbox.count("s3"), 0);

    // The text: line breaks kept, other control characters gone; blank or too long refused.
    send("s1", "ui-2", "line one\r\nline\ttwo\x1b[2J\rthree\n").unwrap();
    assert_eq!(read("s2")[0]["text"], "line one\nlinetwo[2J\nthree");
    assert_eq!(send("s1", "ui-2", "   \x07\n "), Err("text is empty".to_string()));
    assert!(call_app(app.handle(), "s1", "send", &json!({ "peer": "ui-2" })).is_err());
    assert!(call_app(app.handle(), "s1", "send", &json!({ "text": "x" })).is_err());
    assert_eq!(send("s1", "ui-2", &"x".repeat(MAX_TEXT_CHARS + 1)), Err(format!("text is over {MAX_TEXT_CHARS} characters")));
    assert_eq!(send("s1", "ui-2", &"x".repeat(MAX_TEXT_CHARS)).unwrap()["unread"], 1);
    read("s2");
    // The limit counts the cleaned text.
    assert_eq!(send("s1", "ui-2", &format!("{}\x07\x07", "x".repeat(MAX_TEXT_CHARS))).unwrap()["unread"], 1);
    read("s2");
    // Bidi embeddings, overrides and isolates go; U+2028 / U+2029 are line breaks.
    send("s1", "ui-2", "a\u{202E}b\u{2066}c\u{2069}\u{202A}d\u{2028}e\u{2029}f").unwrap();
    assert_eq!(read("s2")[0]["text"], "abcd\ne\nf");

    // At most 100: the oldest go first.
    for i in 0..MAX_UNREAD {
        assert!(send("s1", "ui-2", &format!("m{i}")).unwrap().get("dropped").is_none());
    }
    for i in MAX_UNREAD..MAX_UNREAD + 5 {
        assert_eq!(send("s1", "ui-2", &format!("m{i}")).unwrap()["dropped"], 1, "this send pushed one out");
    }
    assert_eq!(state.inbox.count("s2"), MAX_UNREAD + 1, "the messages and the dropped notice");
    let all = read("s2");
    assert_eq!(all.as_array().unwrap().len(), MAX_UNREAD + 1);
    assert_eq!(all[0]["from"], "switchboard");
    assert_eq!(all[0]["text"], "5 older messages were dropped");
    assert_eq!(all[1]["text"], "m5");
    assert_eq!(inbox::dropped_text(1), "1 older message was dropped");

    // Two peers sharing a name: the error names both node ids.
    {
        let mut map = state.write_sessions_live();
        map.sessions.insert("s4".into(), live("ui", "/w/ui", "ui-1", SessionState::Idle, None));
        map.sessions.insert("s5".into(), live("ui", "/w/ui", "ui-1", SessionState::Idle, None));
        let mut ws = state.write_workspace();
        ws.workspace.edges.push(edge("e-4", EdgeKind::Cooperate, (NodeType::Session, "s1"), (NodeType::Session, "s4"), None));
        ws.workspace.edges.push(edge("e-5", EdgeKind::Cooperate, (NodeType::Session, "s5"), (NodeType::Session, "s1"), None));
    }
    let err = send("s1", "ui-1", "hi").unwrap_err();
    assert!(err.contains("s4") && err.contains("s5") && err.contains("ambiguous"), "{err}");
    assert_eq!(send("s1", "s5", "hi").unwrap()["to"], "ui-1", "the id still reaches one of them");
    assert_eq!(inbox::find_peer(&state, "s1", "UI-2"), Ok(("s2".to_string(), "ui-2".to_string())));

    // An exact name wins over a match ignoring case; two loose matches are ambiguous.
    {
        state.write_sessions_live().sessions.insert("s6".into(), live("ui", "/w/ui", "UI-2", SessionState::Idle, None));
        let mut ws = state.write_workspace();
        ws.workspace.edges.push(edge("e-6", EdgeKind::Cooperate, (NodeType::Session, "s1"), (NodeType::Session, "s6"), None));
    }
    assert_eq!(inbox::find_peer(&state, "s1", "UI-2"), Ok(("s6".to_string(), "UI-2".to_string())));
    assert_eq!(inbox::find_peer(&state, "s1", "ui-2"), Ok(("s2".to_string(), "ui-2".to_string())));
    assert!(inbox::find_peer(&state, "s1", "Ui-2").unwrap_err().contains("ambiguous"));
}

/// Story 7.3: an arrival is nudged only once its line is written (a failed write leaves it owed);
/// the loop guard stops the nudges past its limit with one notice, and lets them through again
/// once its window has passed; removing a session's project drops its inbox.
#[test]
fn a_failed_nudge_stays_owed_the_loop_guard_pauses_and_a_removed_session_loses_its_inbox() {
    use crate::inbox::{self, Nudge, NudgeLimit, nudge_once};
    use tauri::Listener;
    let app = fixture();
    let state = app.state::<AppState>();
    let send = |text: &str| call_app(app.handle(), "s1", "send", &json!({ "peer": "ui-2", "text": text })).unwrap();
    let one = "You have 1 message from \"api-1\". Call switchboard.inbox.\r";

    send("a");
    assert!(state.inbox.nudge_owed("s2"));
    assert_eq!(nudge_once(app.handle(), "s2", |_| Err("pty gone".to_string())), Nudge::Failed("pty gone".to_string()));
    assert!(state.inbox.nudge_owed("s2"), "a failed write is retried later");
    let written = std::sync::Mutex::new(Vec::new());
    let write = |line: &str| {
        written.lock().unwrap().push(line.to_string());
        Ok(())
    };
    assert_eq!(nudge_once(app.handle(), "s2", write), Nudge::Written);
    assert!(!state.inbox.nudge_owed("s2"));
    assert_eq!(nudge_once(app.handle(), "s2", write), Nudge::Nothing, "once per arrival");
    assert_eq!(*written.lock().unwrap(), [one]);
    call_app(app.handle(), "s2", "inbox", &json!({})).unwrap();

    // The loop guard, at 2 a window.
    let notices = std::sync::Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
    let seen = notices.clone();
    app.listen_any(crate::approvals::NOTICE_EVENT, move |event| {
        seen.lock().unwrap().push(serde_json::from_str::<String>(event.payload()).unwrap());
    });
    *state.inbox.limit.lock().unwrap() = NudgeLimit { max: 2, window: std::time::Duration::from_millis(400) };
    send("b");
    assert_eq!(nudge_once(app.handle(), "s2", write), Nudge::Written);
    send("c");
    assert_eq!(nudge_once(app.handle(), "s2", write), Nudge::Paused, "two in the window already");
    assert!(!state.inbox.nudge_owed("s2"), "a held-back arrival is not owed later");
    send("d");
    assert_eq!(nudge_once(app.handle(), "s2", write), Nudge::Paused);
    assert_eq!(*notices.lock().unwrap(), [inbox::paused_text("ui-2", 2)], "one notice per pause");
    assert_eq!(inbox::paused_text("ui-2", 20), "nudges paused for ui-2: 20 in the last hour");
    assert_eq!(state.inbox.count("s2"), 3, "the messages and the badge go on");
    std::thread::sleep(std::time::Duration::from_millis(450));
    send("e");
    assert_eq!(nudge_once(app.handle(), "s2", write), Nudge::Written, "the window passed");
    assert_eq!(written.lock().unwrap().len(), 3);

    // Removing the project of s2 (its session ref goes with it) drops its inbox.
    state.write_workspace().workspace.sessions.push(crate::graph::SessionRef {
        session_id: "s2".into(),
        project_id: "ui".into(),
        ..Default::default()
    });
    assert!(state.inbox.has_box("s2"));
    crate::graph::remove_project(app.handle(), "ui").unwrap();
    assert!(!state.inbox.has_box("s2"));
    assert!(state.inbox.unread().is_empty());
}

/// Story 7.3: the nudge names one sender in quotes and the count, or the number of peers; the
/// link notice never counts; a name cannot break the line.
#[test]
fn the_nudge_line_counts_messages_and_senders() {
    use crate::inbox::{Message, SWITCHBOARD, notice_text, nudge_line};
    let message = |from: &str, id: Option<&str>| Message {
        from: from.into(),
        from_node_id: id.map(str::to_string),
        text: "x".into(),
        at: "2026-10-24T10:00:00.000Z".into(),
    };
    let a = message("A", Some("a"));
    let b = message("B", Some("b"));
    let notice = message(SWITCHBOARD, None);
    assert_eq!(nudge_line([&a]).as_deref(), Some("You have 1 message from \"A\". Call switchboard.inbox.\r"));
    assert_eq!(nudge_line([&notice, &a, &a]).as_deref(), Some("You have 2 messages from \"A\". Call switchboard.inbox.\r"));
    assert_eq!(nudge_line([&a, &b, &a]).as_deref(), Some("You have 3 messages from 2 peers. Call switchboard.inbox.\r"));
    assert_eq!(nudge_line([&notice]), None, "a notice alone never nudges");
    assert_eq!(nudge_line([]), None);
    let evil = message("x\"\n/exit", Some("e"));
    let line = nudge_line([&evil]).unwrap();
    assert_eq!(line.chars().filter(|c| c.is_control()).collect::<String>(), "\r");
    assert_eq!(notice_text("ui-2", "API shape"), "Linked to \"ui-2\" (API shape).");
}

/// Story 7.4: `request_review` never asks; it flags the caller's node (the read tools say
/// `reviewRequested: true`), lists the paths relative to the cwd with `missing` marks, emits the
/// map and sends the OS toast (unfocused, `notifications.review` on). A second request replaces
/// the first; opening lowers the flag and keeps the request; Clear lowers it; a path outside the
/// session's folders refuses the whole call and flags nothing; a removed session loses its request.
#[test]
fn request_review_flags_the_node_lists_the_paths_and_refuses_outside_ones() {
    use crate::review::{self, MAX_PATHS, OUTSIDE};
    use tauri::Listener;
    let app = fixture();
    let state = app.state::<AppState>();
    let dir = tempfile::tempdir().unwrap();
    let root = dunce::canonicalize(dir.path()).unwrap();
    let cwd = root.join("web");
    std::fs::create_dir_all(cwd.join("src")).unwrap();
    std::fs::write(cwd.join("src").join("present.ts"), "x").unwrap();
    let cwd_text = cwd.display().to_string();
    let docs = root.join("docs");
    std::fs::create_dir_all(&docs).unwrap();
    state.write_workspace().workspace.projects.push(project("web", "web", &cwd_text));
    state.write_sessions_live().sessions.insert("r1".into(), live("web", &cwd_text, "web-1", SessionState::Busy, None));
    state.write_sessions_live().sessions.insert("r2".into(), live("web", &cwd_text, "web-2", SessionState::Idle, None));
    state.launcher.record_add_dirs("r1", vec![graph::EdgeDir { path: docs.display().to_string(), via: "sheet".into() }]);
    let recorder = Arc::new(crate::notify::fixtures::Recorder::default());
    *state.notifier.lock().unwrap() = Some(recorder.clone());
    let events = Arc::new(std::sync::Mutex::new(0usize));
    let seen = events.clone();
    app.listen_any(review::EVENT, move |_| *seen.lock().unwrap() += 1);
    let request = |who: &str, args: Value| call_app(app.handle(), who, "request_review", &args);

    // The spec's request: one path, inside the cwd, not on disk.
    let reply = request("r1", json!({ "summary": "token refresh done", "paths": ["src/auth/refresh.ts"] })).unwrap();
    assert_eq!(reply, json!({ "flagged": true, "paths": 1 }));
    assert!(state.approvals.list().is_empty(), "never asks");
    assert!(state.review.flagged("r1"));
    let stored = state.review.get("r1").unwrap();
    assert_eq!((stored.name.as_str(), stored.summary.as_str(), stored.root.as_str()), ("web-1", "token refresh done", cwd_text.as_str()));
    assert_eq!(stored.paths.len(), 1);
    assert_eq!(stored.paths[0].display, "src/auth/refresh.ts");
    assert!(stored.paths[0].missing);
    assert_eq!(*events.lock().unwrap(), 1);
    let toasts = recorder.toasts.lock().unwrap().clone();
    assert_eq!(toasts.len(), 1, "unfocused (the mock app has no window): one OS toast");
    assert_eq!((toasts[0].title.as_str(), toasts[0].body.as_str(), toasts[0].review), ("web-1 asks for review", "token refresh done", true));
    assert_eq!(toasts[0].session_id, "r1");
    // The read tools say so while it is flagged.
    assert_eq!(call(&state, "r1", "my_node", &json!({})).unwrap()["reviewRequested"], true);
    assert_eq!(call(&state, "s1", "node", &json!({ "id": "r1" })).unwrap()["reviewRequested"], true);
    let listed = call(&state, "s1", "sessions", &json!({ "project": "web" })).unwrap();
    let flags: Vec<(String, Value)> = listed["sessions"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| (s["nodeId"].as_str().unwrap().to_string(), s.get("reviewRequested").cloned().unwrap_or(Value::Null)))
        .collect();
    assert!(flags.contains(&("r1".to_string(), json!(true))) && flags.contains(&("r2".to_string(), Value::Null)), "{flags:?}");

    // A second request replaces the summary and the paths: an existing file, an add-dir's file,
    // an absolute path in the cwd and a path listed twice.
    let present = cwd.join("src").join("present.ts").display().to_string();
    let notes = docs.join("notes.md").display().to_string();
    let reply = request("r1", json!({ "summary": "  second\u{2028} pass\n", "paths": ["src/present.ts", notes, present, "./src/../src/present.ts"] })).unwrap();
    assert_eq!(reply, json!({ "flagged": true, "paths": 2 }));
    let replaced = state.review.get("r1").unwrap();
    assert_eq!(replaced.summary, "second pass");
    assert!(replaced.seq > stored.seq);
    assert_eq!(replaced.paths[0].display, "src/present.ts");
    assert!(!replaced.paths[0].missing);
    assert_eq!(replaced.paths[1].display, notes, "outside the cwd: the absolute path");
    assert!(replaced.paths[1].missing);
    assert_eq!(state.review.snapshot().len(), 1, "one request per session");

    // Open: the flag goes, the request stays (the pane lists it); a file made since is no longer missing.
    std::fs::write(docs.join("notes.md"), "n").unwrap();
    // A stale seq (a replacement the operator never saw) changes nothing.
    assert_eq!(review::open(app.handle(), "r1", stored.seq), Err(review::REPLACED.to_string()));
    review::clear(app.handle(), "r1", stored.seq).unwrap();
    assert!(state.review.flagged("r1"), "a stale clear keeps the flag");
    let opened = review::open(app.handle(), "r1", replaced.seq).unwrap();
    assert!(!opened.flagged && !opened.paths[1].missing);
    assert!(!state.review.flagged("r1"));
    assert!(call(&state, "r1", "my_node", &json!({})).unwrap().get("reviewRequested").is_none());
    assert_eq!(state.review.get("r1").unwrap().summary, "second pass");
    // Clear: the flag goes without opening.
    request("r1", json!({ "summary": "third" })).unwrap();
    assert!(state.review.flagged("r1"));
    let third = state.review.get("r1").unwrap().seq;
    review::clear(app.handle(), "r1", third).unwrap();
    assert!(!state.review.flagged("r1"));
    assert_eq!(review::clear(app.handle(), "r2", 1), Err(review::NO_REQUEST.to_string()));
    assert!(review::open(app.handle(), "r2", 1).is_err());

    // Outside paths refuse the whole call; nothing is flagged.
    let outside = root.join("elsewhere.txt").display().to_string();
    let err = request("r2", json!({ "summary": "x", "paths": ["src/a.ts", outside, "../../up.txt"] })).unwrap_err();
    assert_eq!(err, format!("{OUTSIDE}: {outside}, ../../up.txt"));
    assert!(state.review.get("r2").is_none());
    // r2 has no add-dir: the docs folder is outside for it.
    assert!(request("r2", json!({ "summary": "x", "paths": [docs.display().to_string()] })).unwrap_err().starts_with(OUTSIDE));
    // Bad arguments.
    assert_eq!(request("r2", json!({ "paths": [] })), Err("summary is required".to_string()));
    assert_eq!(request("r2", json!({ "summary": " \n " })), Err("summary is required".to_string()));
    assert_eq!(request("r2", json!({ "summary": "x", "paths": "a.ts" })), Err("paths must be an array of strings".to_string()));
    assert_eq!(request("r2", json!({ "summary": "x", "paths": [1] })), Err("paths must be non-empty strings".to_string()));
    let many: Vec<String> = (0..=MAX_PATHS).map(|i| format!("f{i}.ts")).collect();
    assert_eq!(request("r2", json!({ "summary": "x", "paths": many })), Err(format!("at most {MAX_PATHS} paths")));
    assert!(request("nope", json!({ "summary": "x" })).is_err(), "a session the app does not know");
    // A summary-only request needs no folder: a session whose cwd is unknown can make one.
    state.write_sessions_live().sessions.insert("r3".into(), live("web", "", "web-3", SessionState::Busy, None));
    assert_eq!(request("r3", json!({ "summary": "done" })).unwrap(), json!({ "flagged": true, "paths": 0 }));
    assert!(request("r3", json!({ "summary": "done", "paths": ["a.ts"] })).unwrap_err().contains("not known"));
    assert!(state.review.get("r2").is_none());
    // Exactly 50 is fine; a summary is cut to 500.
    let fifty: Vec<String> = (0..MAX_PATHS).map(|i| format!("f{i}.ts")).collect();
    assert_eq!(request("r2", json!({ "summary": "y".repeat(800), "paths": fifty })).unwrap()["paths"], 50);
    assert_eq!(state.review.get("r2").unwrap().summary.chars().count(), review::MAX_SUMMARY_CHARS + 1);

    // notifications.review off: no toast.
    state.write().settings.notifications.review = false;
    let before = recorder.toasts.lock().unwrap().len();
    request("r1", json!({ "summary": "quiet" })).unwrap();
    assert_eq!(recorder.toasts.lock().unwrap().len(), before);

    // Removing the project drops its sessions' requests.
    for id in ["r1", "r2", "r3"] {
        state.write_workspace().workspace.sessions.push(graph::SessionRef { session_id: id.into(), project_id: "web".into(), ..Default::default() });
    }
    graph::remove_project(app.handle(), "web").unwrap();
    assert!(state.review.snapshot().is_empty());
}
