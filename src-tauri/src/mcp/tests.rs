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
        assert_eq!(tool["annotations"]["readOnlyHint"], true);
    }
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
fn the_config_names_the_endpoint_and_the_bearer_and_every_read_tool_is_allowed() {
    assert_eq!(
        config_json(4242, "t0k"),
        json!({ "mcpServers": { "switchboard": { "type": "http", "url": "http://127.0.0.1:4242/mcp", "headers": { "Authorization": "Bearer t0k" } } } })
    );
    assert_eq!(
        allowed_tools(),
        ["mcp__switchboard__my_node", "mcp__switchboard__workspace", "mcp__switchboard__node", "mcp__switchboard__peers", "mcp__switchboard__sessions"]
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
        json!({ "nodeId": "old", "name": "Fix the login bug", "status": "historic", "lastLine": null, "project": { "id": "api", "label": "api", "path": "/w/api" }, "branch": "main" })
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
