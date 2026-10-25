//! Switchboard core. Rust is the source of truth; the webview talks to it only
//! through the thin commands in [`ipc`].

pub mod approvals;
pub mod claude;
pub mod git;
pub mod graph;
pub mod inbox;
pub mod ipc;
pub mod mcp;
pub mod notify;
pub mod persist;
pub mod process;
pub mod pty;
pub mod review;
pub mod settings;
pub mod windows;

use settings::AppState;

/// Attach the app's managed state and invoke handler to any builder. Generic over the
/// runtime so the production `Wry` builder and the test `MockRuntime` register the same
/// commands against the same state.
fn with_commands<R: tauri::Runtime>(builder: tauri::Builder<R>) -> tauri::Builder<R> {
    builder
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            ipc::app_info,
            ipc::settings_get,
            ipc::settings_reveal,
            ipc::binaries_redetect,
            ipc::workspace_get,
            ipc::workspace_set_viewport,
            ipc::project_pick_folder,
            ipc::workspace_add_projects,
            ipc::workspace_set_expanded,
            ipc::project_set_show_branches,
            ipc::worktree_preview,
            ipc::worktree_add,
            ipc::worktree_remove_preview,
            ipc::worktree_remove,
            ipc::workspace_move_node,
            ipc::workspace_relayout_children,
            ipc::edge_add,
            ipc::edge_set_label,
            ipc::edge_remove,
            ipc::edges_live_get,
            ipc::inbox_unread_get,
            ipc::review_requests_get,
            ipc::review_open,
            ipc::review_clear,
            ipc::review_list,
            ipc::review_file,
            ipc::edge_live_retry,
            ipc::edge_restart_with_flags,
            ipc::claude_projects_list,
            ipc::projects_status_get,
            ipc::live_sessions_get,
            ipc::session_acknowledge,
            ipc::workspace_remove_project,
            ipc::project_open_editor,
            ipc::project_open_folder,
            ipc::project_reveal_claude_dir,
            ipc::app_quit,
            ipc::term_open,
            ipc::term_write,
            ipc::term_resize,
            ipc::term_buffer,
            ipc::term_restart,
            ipc::term_kill,
            ipc::term_list,
            ipc::term_close,
            ipc::term_pop_out,
            ipc::term_return,
            ipc::term_popped,
            ipc::launch_defaults,
            ipc::session_launch,
            ipc::session_resume,
            ipc::session_fork,
            ipc::session_stop,
            ipc::diagnostics_get,
            ipc::approvals_get,
            ipc::approval_answer,
            ipc::edge_set_agent_allowed,
            ipc::workspace_set_agent_actions,
        ])
}

/// What the app does on its way out: every pop-out window closes, every terminal's child is
/// killed and its PTY closed, so no shell or session outlives Switchboard, and every
/// per-session settings file is deleted. Idempotent (both `ExitRequested` and `Exit` call it).
///
/// A destroyed pop-out window returns its terminal to the pane (Story 4.5). The main window
/// going closes every pop-out too, so closing it quits the app as it always did (the last
/// window closed).
pub(crate) fn on_run_event<R: tauri::Runtime>(app: &tauri::AppHandle<R>, event: &tauri::RunEvent) {
    use tauri::Manager;
    match event {
        tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit => {
            if matches!(event, tauri::RunEvent::ExitRequested { .. }) {
                windows::close_all(app);
            }
            let state = app.state::<AppState>();
            state.terms.kill_all();
            state.launcher.remove_all();
        }
        tauri::RunEvent::WindowEvent { label, event: tauri::WindowEvent::Destroyed, .. } => on_window_destroyed(app, label),
        _ => {}
    }
}

/// Window `label` was destroyed: a pop-out returns its terminal; the main window takes every
/// pop-out with it.
pub(crate) fn on_window_destroyed<R: tauri::Runtime>(app: &tauri::AppHandle<R>, label: &str) {
    if label == MAIN_WINDOW {
        windows::close_all(app);
    } else if windows::is_popout_label(label) {
        windows::window_destroyed(app, label);
    }
}

/// The label of the app's main window (`tauri.conf.json`).
pub const MAIN_WINDOW: &str = "main";

/// Name of the environment variable asking for stub session children per project.
pub const STUB_CHILDREN_ENV: &str = "SWITCHBOARD_STUB_CHILDREN";

/// The stub-children count a `SWITCHBOARD_STUB_CHILDREN` value asks for: a non-negative
/// integer clamped to [`graph::MAX_STUB_CHILDREN`]; unset, blank or unparsable means 0.
pub fn stub_children_from_env(value: Option<&str>) -> usize {
    value
        .and_then(|v| v.trim().parse::<usize>().ok())
        .unwrap_or(0)
        .min(graph::MAX_STUB_CHILDREN)
}

/// The fully configured Tauri builder (state, commands, plugins, setup), not yet built.
///
/// Plugin order matters: `single-instance` must be registered first (its docs require it) so a
/// second launch is turned away before anything else initialises. The second instance's argv
/// and cwd are ignored (printed to stderr, which only debug builds have on Windows) until
/// Epic 2 adds "open project from CLI".
pub fn builder() -> tauri::Builder<tauri::Wry> {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, argv, cwd| {
            eprintln!("second instance ignored: argv={argv:?} cwd={cwd}");
            focus_main_window(app);
        }))
        .plugin(
            // Pop-out terminal windows (Story 4.5) open at their own size every time.
            tauri_plugin_window_state::Builder::new()
                .with_filter(|label| !windows::is_popout_label(label))
                .build(),
        )
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        // Toasts are sent from Rust only (`notify`); no JS permission is granted.
        .plugin(tauri_plugin_notification::init());
    with_commands(builder)
        .setup(|app| {
            use tauri::Manager;
            // The hooks endpoint (Story 4.3) on 127.0.0.1:<ephemeral>, before the first settings
            // snapshot goes out, so a failed bind's banner is in it.
            let _ = claude::hooks::start(app.handle());
            settings::initialise(app.handle());
            // Read once, before the workspace loads and copies it; off by default.
            let stubs = stub_children_from_env(std::env::var(STUB_CHILDREN_ENV).ok().as_deref());
            let _ = app.state::<AppState>().stub_children.set(stubs);
            graph::initialise(app.handle());
            if let Some(home) = claude::claude_home() {
                let _ = app.state::<AppState>().claude_home.set(home);
            }
            // Per-session settings files go to the OS temp dir; leftovers older than a day
            // (a crash) are swept off the startup path.
            let dir = claude::launch::default_dir();
            app.state::<AppState>().launcher.set_dir(dir.clone());
            std::thread::spawn(move || {
                claude::launch::sweep(&dir, &Default::default(), claude::launch::SWEEP_AGE, std::time::SystemTime::now());
            });
            git::poll::start(app.handle().clone());
            claude::sessions::start(app.handle().clone());
            claude::live::start(app.handle().clone());
            // A click on a toast reveals its session (Story 3.3).
            notify::listen_for_clicks(app.handle());
            Ok(())
        })
}

/// Bring the `main` window to the front: un-minimise, show, focus. Each step is best effort;
/// a window the OS refuses to focus is not an error worth surfacing.
pub(crate) fn focus_main_window<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    use tauri::Manager;
    let Some(window) = app.get_webview_window(MAIN_WINDOW) else {
        return;
    };
    // Unminimising a normal window is harmless, so when the query fails, do it anyway.
    if window.is_minimized().unwrap_or(true) {
        let _ = window.unminimize();
    }
    let _ = window.show();
    let _ = window.set_focus();
}

/// Build and run the Tauri application.
pub fn run() {
    builder()
        .build(tauri::generate_context!())
        .expect("error while building Switchboard")
        .run(|app, event| on_run_event(app, &event));
}

#[cfg(test)]
mod tests {
    use tauri::Manager;
    use tauri::ipc::{CallbackFn, InvokeBody};
    use tauri::test::{INVOKE_KEY, get_ipc_response, mock_builder, mock_context, noop_assets};
    use tauri::webview::InvokeRequest;

    fn mock_app() -> tauri::App<tauri::test::MockRuntime> {
        super::with_commands(mock_builder())
            .build(mock_context(noop_assets()))
            .expect("mock app should build")
    }

    fn invoke(
        webview: &tauri::WebviewWindow<tauri::test::MockRuntime>,
        cmd: &str,
    ) -> Result<tauri::ipc::InvokeResponseBody, serde_json::Value> {
        invoke_with(webview, cmd, InvokeBody::default())
    }

    /// Invoke `cmd` with named arguments, as `invoke(cmd, { arg: … })` sends them from JS.
    fn invoke_with(
        webview: &tauri::WebviewWindow<tauri::test::MockRuntime>,
        cmd: &str,
        body: InvokeBody,
    ) -> Result<tauri::ipc::InvokeResponseBody, serde_json::Value> {
        // Tauri's local webview origin differs per platform; a non-local origin is treated as a
        // remote request and the command is rejected before it runs.
        #[cfg(windows)]
        let origin = "http://tauri.localhost";
        #[cfg(not(windows))]
        let origin = "tauri://localhost";

        get_ipc_response(
            webview,
            InvokeRequest {
                cmd: cmd.into(),
                callback: CallbackFn(0),
                error: CallbackFn(1),
                url: origin.parse().unwrap(),
                body,
                headers: Default::default(),
                invoke_key: INVOKE_KEY.to_string(),
            },
        )
    }

    #[test]
    fn app_info_is_registered_under_its_wire_name() {
        let app = mock_app();
        let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .expect("mock webview should build");

        let body = invoke(&webview, "app_info").expect("app_info should be registered and succeed");
        let value: serde_json::Value = body.deserialize().unwrap();
        assert_eq!(
            value,
            serde_json::json!({ "name": "switchboard", "version": env!("CARGO_PKG_VERSION") })
        );
    }

    #[test]
    fn settings_get_is_registered_and_reads_the_managed_state() {
        let app = mock_app();
        let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .expect("mock webview should build");

        let body = invoke(&webview, "settings_get").expect("settings_get should be registered and succeed");
        let value: serde_json::Value = body.deserialize().unwrap();
        // Nothing ran `settings::initialise`, so this is the pristine managed state.
        assert_eq!(value["path"], serde_json::Value::Null);
        assert_eq!(value["settings"]["version"], 1);
        assert_eq!(value["settings"]["theme"], "dark");
        assert_eq!(value["binaries"]["claude"]["status"], "pending");
        assert_eq!(value["binaries"]["git"]["status"], "pending");
        assert_eq!(value["banners"], serde_json::json!([]));
    }

    #[test]
    fn settings_reveal_is_registered_and_fails_cleanly_without_a_path() {
        let app = mock_app();
        let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .expect("mock webview should build");

        let err = invoke(&webview, "settings_reveal").expect_err("pristine state has no settings path");
        assert_eq!(err, serde_json::json!("settings file location is unknown"));
    }

    #[test]
    fn binaries_redetect_is_registered_and_resolves_both_binaries() {
        let app = mock_app();
        let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .expect("mock webview should build");

        let body = invoke(&webview, "binaries_redetect").expect("binaries_redetect should be registered and succeed");
        let value: serde_json::Value = body.deserialize().unwrap();
        for name in ["claude", "git"] {
            let status = value["binaries"][name]["status"].as_str().unwrap();
            assert_ne!(status, "pending", "{name} should have been detected one way or the other");
            assert!(
                ["found", "missing", "version_failed"].contains(&status),
                "{name}: {status}"
            );
        }
        // The managed state now holds the same result.
        let state = app.state::<super::AppState>();
        assert_ne!(state.read().binaries.git.status, super::settings::BinaryStatus::Pending);
    }

    #[test]
    fn workspace_get_is_registered_and_reads_the_managed_state() {
        let app = mock_app();
        let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .expect("mock webview should build");

        let body = invoke(&webview, "workspace_get").expect("workspace_get should be registered and succeed");
        let value: serde_json::Value = body.deserialize().unwrap();
        // Nothing ran `graph::initialise`, so this is the pristine managed state.
        assert_eq!(value["path"], serde_json::Value::Null);
        assert_eq!(value["workspace"]["version"], 1);
        assert_eq!(value["workspace"]["viewport"], serde_json::json!({ "x": 0.0, "y": 0.0, "zoom": 1.0 }));
        assert_eq!(value["workspace"]["projects"], serde_json::json!([]));
        assert_eq!(value["banners"], serde_json::json!([]));
    }

    #[test]
    fn workspace_set_viewport_is_registered_takes_the_viewport_argument_and_replies_with_the_snapshot() {
        let app = mock_app();
        let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .expect("mock webview should build");
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("workspace.json");
        super::graph::initialise_at(app.handle(), Some(path.clone()));

        let args = serde_json::json!({ "viewport": { "x": -120, "y": 40, "zoom": 1.5 } });
        let body = invoke_with(&webview, "workspace_set_viewport", InvokeBody::Json(args))
            .expect("workspace_set_viewport should be registered and succeed");
        let value: serde_json::Value = body.deserialize().unwrap();
        assert_eq!(value["workspace"]["viewport"], serde_json::json!({ "x": -120.0, "y": 40.0, "zoom": 1.5 }));
        assert_eq!(value["banners"], serde_json::json!([]));
        let on_disk: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(on_disk["viewport"]["zoom"], 1.5);

        // A missing or malformed argument is rejected before the handler runs.
        invoke_with(&webview, "workspace_set_viewport", InvokeBody::Json(serde_json::json!({})))
            .expect_err("viewport is required");
    }

    #[test]
    fn project_pick_folder_is_registered_and_replies_none_under_test() {
        let app = mock_app();
        let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .expect("mock webview should build");

        let body = invoke(&webview, "project_pick_folder").expect("project_pick_folder should be registered");
        let value: serde_json::Value = body.deserialize().unwrap();
        assert_eq!(value, serde_json::Value::Null, "cfg(test): no dialog, no folder");
    }

    #[test]
    fn workspace_add_projects_is_registered_takes_paths_and_position_and_replies_with_the_result() {
        let app = mock_app();
        let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .expect("mock webview should build");
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("workspace.json");
        super::graph::initialise_at(app.handle(), Some(path.clone()));
        // A git that does not exist: the post-add status pass then lands deterministically.
        app.state::<super::AppState>().write().binaries.git.path = Some(dir.path().join("no-git.exe").display().to_string());
        let folder = tempfile::tempdir().unwrap();

        let args = serde_json::json!({ "paths": [folder.path().display().to_string()], "position": { "x": 10, "y": 20 } });
        let body = invoke_with(&webview, "workspace_add_projects", InvokeBody::Json(args))
            .expect("workspace_add_projects should be registered and succeed");
        let value: serde_json::Value = body.deserialize().unwrap();
        assert_eq!(value["added"].as_array().unwrap().len(), 1);
        assert_eq!(value["existing"], serde_json::json!([]));
        assert_eq!(value["skipped"], serde_json::json!([]));
        assert_eq!(value["snapshot"]["revision"], 1);
        let project = &value["snapshot"]["workspace"]["projects"][0];
        assert_eq!(project["position"], serde_json::json!({ "x": 10.0, "y": 20.0 }));
        assert_eq!(project["label"], folder.path().file_name().unwrap().to_str().unwrap());
        let on_disk: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(on_disk["projects"].as_array().unwrap().len(), 1);

        // The add kicked off a status pass for the new id; wait (bounded) for it to land.
        let id = value["added"][0].as_str().unwrap().to_string();
        let started = std::time::Instant::now();
        let status = loop {
            if let Some(status) = app.state::<super::AppState>().read_live().statuses.get(&id).cloned() {
                break status;
            }
            assert!(started.elapsed() < std::time::Duration::from_secs(2), "no status for the added project within 2 s");
            std::thread::sleep(std::time::Duration::from_millis(20));
        };
        assert_eq!(status, super::git::ProjectStatus::GitUnavailable);

        // A lone non-directory adds nothing and is reported as skipped (no error).
        let file = folder.path().join("f.txt");
        std::fs::write(&file, "x").unwrap();
        let args = serde_json::json!({ "paths": [file.display().to_string()], "position": { "x": 0, "y": 0 } });
        let body = invoke_with(&webview, "workspace_add_projects", InvokeBody::Json(args)).expect("a file is skipped, not an error");
        let value: serde_json::Value = body.deserialize().unwrap();
        assert_eq!(value["added"], serde_json::json!([]));
        assert_eq!(value["skipped"], serde_json::json!([file.display().to_string()]));
        assert_eq!(value["snapshot"]["revision"], 1, "no mutation");

        // Missing arguments are rejected before the handler runs.
        invoke_with(&webview, "workspace_add_projects", InvokeBody::Json(serde_json::json!({ "paths": [] })))
            .expect_err("position is required");
    }

    #[test]
    fn stub_children_from_env_parses_and_clamps() {
        assert_eq!(super::stub_children_from_env(None), 0);
        assert_eq!(super::stub_children_from_env(Some("")), 0);
        assert_eq!(super::stub_children_from_env(Some("abc")), 0);
        assert_eq!(super::stub_children_from_env(Some("-1")), 0);
        assert_eq!(super::stub_children_from_env(Some("3")), 3);
        assert_eq!(super::stub_children_from_env(Some(" 10 ")), 10);
        assert_eq!(super::stub_children_from_env(Some("50")), 50);
        assert_eq!(super::stub_children_from_env(Some("51")), 50);
        assert_eq!(super::stub_children_from_env(Some("99999")), 50);
        assert_eq!(super::STUB_CHILDREN_ENV, "SWITCHBOARD_STUB_CHILDREN");
    }

    /// A webview over a workspace with three stub children per project and one project
    /// `ide`, as the 2.3 commands need.
    fn app_with_ide() -> (tauri::App<tauri::test::MockRuntime>, tauri::WebviewWindow<tauri::test::MockRuntime>, tempfile::TempDir) {
        let app = mock_app();
        let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .expect("mock webview should build");
        let dir = tempfile::tempdir().unwrap();
        app.state::<super::AppState>().stub_children.set(3).unwrap();
        super::graph::initialise_at(app.handle(), Some(dir.path().join("workspace.json")));
        app.state::<super::AppState>().write_workspace().workspace.projects.push(super::graph::Project {
            id: "ide".into(),
            path: "/p/ide".into(),
            label: "ide".into(),
            ..super::graph::Project::default()
        });
        (app, webview, dir)
    }

    #[test]
    fn workspace_set_expanded_is_registered_takes_project_id_and_expanded_and_replies_with_the_snapshot() {
        let (_app, webview, dir) = app_with_ide();

        let args = serde_json::json!({ "projectId": "ide", "expanded": true });
        let body = invoke_with(&webview, "workspace_set_expanded", InvokeBody::Json(args))
            .expect("workspace_set_expanded should be registered and succeed");
        let value: serde_json::Value = body.deserialize().unwrap();
        assert_eq!(value["workspace"]["projects"][0]["expanded"], true);
        assert_eq!(value["revision"], 1);
        assert_eq!(value["children"].as_array().unwrap().len(), 3);
        assert_eq!(value["children"][0]["id"], "stub-1-ide");
        assert_eq!(value["children"][0]["kind"], "session");
        assert_eq!(value["children"][0]["position"], serde_json::Value::Null);
        let on_disk: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(dir.path().join("workspace.json")).unwrap()).unwrap();
        assert_eq!(on_disk["projects"][0]["expanded"], true);

        // A validation failure is the command's `Err` string.
        let args = serde_json::json!({ "projectId": "nope", "expanded": true });
        let err = invoke_with(&webview, "workspace_set_expanded", InvokeBody::Json(args)).expect_err("unknown id");
        assert_eq!(err, serde_json::json!("unknown project"));
        // A missing argument is rejected before the handler runs.
        invoke_with(&webview, "workspace_set_expanded", InvokeBody::Json(serde_json::json!({ "projectId": "ide" })))
            .expect_err("expanded is required");
    }

    #[test]
    fn workspace_move_node_is_registered_takes_target_and_position_and_replies_with_the_snapshot() {
        let (_app, webview, dir) = app_with_ide();

        let args = serde_json::json!({ "target": { "kind": "session", "id": "stub-2-ide" }, "position": { "x": 260, "y": 40 } });
        let body = invoke_with(&webview, "workspace_move_node", InvokeBody::Json(args))
            .expect("workspace_move_node should be registered and succeed");
        let value: serde_json::Value = body.deserialize().unwrap();
        assert_eq!(value["children"][1]["position"], serde_json::json!({ "x": 260.0, "y": 40.0 }));
        assert_eq!(value["workspace"]["sessions"][0]["sessionId"], "stub-2-ide");
        let on_disk: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(dir.path().join("workspace.json")).unwrap()).unwrap();
        assert_eq!(on_disk["sessions"][0]["position"], serde_json::json!({ "x": 260.0, "y": 40.0 }));

        let args = serde_json::json!({ "target": { "kind": "project", "id": "ide" }, "position": { "x": 120, "y": 0 } });
        let body = invoke_with(&webview, "workspace_move_node", InvokeBody::Json(args)).unwrap();
        let value: serde_json::Value = body.deserialize().unwrap();
        assert_eq!(value["workspace"]["projects"][0]["position"], serde_json::json!({ "x": 120.0, "y": 0.0 }));
        assert_eq!(value["revision"], 2);

        let args = serde_json::json!({ "target": { "kind": "branch", "id": "nope" }, "position": { "x": 0, "y": 0 } });
        let err = invoke_with(&webview, "workspace_move_node", InvokeBody::Json(args)).expect_err("unknown branch");
        assert_eq!(err, serde_json::json!("unknown branch"));
        let args = serde_json::json!({ "target": { "kind": "folder", "id": "x" }, "position": { "x": 0, "y": 0 } });
        invoke_with(&webview, "workspace_move_node", InvokeBody::Json(args)).expect_err("not a node kind");
    }

    #[test]
    fn the_agent_policy_commands_are_registered() {
        use serde_json::json;
        let (app, webview, _dir) = app_with_ide();
        let call = |cmd: &str, args: serde_json::Value| -> Result<serde_json::Value, serde_json::Value> {
            invoke_with(&webview, cmd, InvokeBody::Json(args)).map(|body| body.deserialize().unwrap())
        };
        assert_eq!(call("approvals_get", json!({})).unwrap(), json!([]));
        assert_eq!(call("approval_answer", json!({ "id": "a1", "answer": "allow" })), Err(json!(super::approvals::NOT_PENDING)));
        let snapshot = call("workspace_set_agent_actions", json!({ "mode": "allowAll" })).unwrap();
        assert_eq!(snapshot["workspace"]["agentActions"], "allowAll");
        assert_eq!(app.state::<super::AppState>().read_workspace().workspace.agent_actions, super::graph::AgentActions::AllowAll);
        let snapshot = call("workspace_set_agent_actions", json!({ "mode": "ask" })).unwrap();
        assert!(snapshot["workspace"].get("agentActions").is_none(), "ask is the default, left out");
        assert_eq!(call("edge_set_agent_allowed", json!({ "id": "nope", "allowed": false })), Err(json!("unknown edge")));
    }

    #[test]
    fn the_edge_commands_are_registered_take_camel_case_arguments_and_persist() {
        let (_app, webview, dir) = app_with_ide();

        let args = serde_json::json!({ "from": { "type": "session", "id": "stub-1-ide" }, "to": { "type": "session", "id": "stub-2-ide" } });
        let body = invoke_with(&webview, "edge_add", InvokeBody::Json(args)).expect("edge_add should be registered and succeed");
        let edge: serde_json::Value = body.deserialize().unwrap();
        assert_eq!(edge["kind"], "cooperate");
        assert_eq!(edge["label"], serde_json::Value::Null);
        assert!(edge["createdAt"].is_string());
        let id = edge["id"].as_str().unwrap().to_string();

        // A refusal is the command's `Err` string, the notice the UI shows.
        let args = serde_json::json!({ "from": { "type": "project", "id": "ide" }, "to": { "type": "session", "id": "stub-1-ide" } });
        let err = invoke_with(&webview, "edge_add", InvokeBody::Json(args)).expect_err("project → session");
        assert_eq!(err, serde_json::json!("can't link a project to a session"));
        let args = serde_json::json!({ "from": { "type": "session", "id": "stub-2-ide" }, "to": { "type": "session", "id": "stub-1-ide" } });
        let err = invoke_with(&webview, "edge_add", InvokeBody::Json(args)).expect_err("duplicate");
        assert_eq!(err, serde_json::json!("already linked"));

        let args = serde_json::json!({ "id": id, "label": " API shape " });
        let body = invoke_with(&webview, "edge_set_label", InvokeBody::Json(args)).expect("edge_set_label");
        let value: serde_json::Value = body.deserialize().unwrap();
        assert_eq!(value["workspace"]["edges"][0]["label"], "API shape");
        let on_disk: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(dir.path().join("workspace.json")).unwrap()).unwrap();
        assert_eq!(on_disk["edges"][0]["label"], "API shape");
        let args = serde_json::json!({ "id": id, "label": null });
        let body = invoke_with(&webview, "edge_set_label", InvokeBody::Json(args)).expect("null clears");
        let value: serde_json::Value = body.deserialize().unwrap();
        assert_eq!(value["workspace"]["edges"][0]["label"], serde_json::Value::Null);

        let args = serde_json::json!({ "id": id });
        let body = invoke_with(&webview, "edge_remove", InvokeBody::Json(args.clone())).expect("edge_remove");
        let value: serde_json::Value = body.deserialize().unwrap();
        assert_eq!(value["workspace"]["edges"], serde_json::json!([]));
        let err = invoke_with(&webview, "edge_remove", InvokeBody::Json(args)).expect_err("gone");
        assert_eq!(err, serde_json::json!("unknown edge"));
    }

    #[test]
    fn workspace_relayout_children_is_registered_takes_project_id_and_replies_with_the_snapshot() {
        let (app, webview, dir) = app_with_ide();
        let target = super::graph::NodeTarget {
            kind: super::graph::NodeKind::Session,
            id: "stub-1-ide".into(),
        };
        super::graph::move_node(app.handle(), &target, super::graph::Position { x: 1.0, y: 2.0 }).unwrap();

        let args = serde_json::json!({ "projectId": "ide" });
        let body = invoke_with(&webview, "workspace_relayout_children", InvokeBody::Json(args))
            .expect("workspace_relayout_children should be registered and succeed");
        let value: serde_json::Value = body.deserialize().unwrap();
        assert_eq!(value["children"][0]["position"], serde_json::Value::Null);
        assert_eq!(value["workspace"]["sessions"], serde_json::json!([]));
        assert_eq!(value["revision"], 2);
        let on_disk: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(dir.path().join("workspace.json")).unwrap()).unwrap();
        assert_eq!(on_disk["sessions"], serde_json::json!([]));

        let err = invoke_with(&webview, "workspace_relayout_children", InvokeBody::Json(serde_json::json!({ "projectId": "nope" })))
            .expect_err("unknown id");
        assert_eq!(err, serde_json::json!("unknown project"));
    }

    #[test]
    fn workspace_remove_project_is_registered_drops_the_project_and_its_live_status() {
        let (app, webview, dir) = app_with_ide();
        {
            let state = app.state::<super::AppState>();
            state.write_workspace().workspace.projects[0].expanded = true;
            let mut live = state.write_live();
            live.statuses.insert("ide".into(), super::git::ProjectStatus::NotRepo);
            live.statuses.insert("other".into(), super::git::ProjectStatus::Missing);
        }
        let target = super::graph::NodeTarget {
            kind: super::graph::NodeKind::Session,
            id: "stub-2-ide".into(),
        };
        super::graph::move_node(app.handle(), &target, super::graph::Position { x: 260.0, y: 40.0 }).unwrap();
        let (tx, rx) = std::sync::mpsc::channel();
        {
            use tauri::Listener;
            app.listen_any(super::git::poll::STATUS_EVENT, move |event| {
                let _ = tx.send(event.payload().to_string());
            });
        }

        let body = invoke_with(&webview, "workspace_remove_project", InvokeBody::Json(serde_json::json!({ "projectId": "ide" })))
            .expect("workspace_remove_project should be registered and succeed");
        let value: serde_json::Value = body.deserialize().unwrap();
        assert_eq!(value["workspace"]["projects"], serde_json::json!([]));
        assert_eq!(value["workspace"]["sessions"], serde_json::json!([]));
        assert_eq!(value["children"], serde_json::json!([]));
        assert_eq!(value["revision"], 2);
        let on_disk: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(dir.path().join("workspace.json")).unwrap()).unwrap();
        assert_eq!(on_disk["projects"], serde_json::json!([]));
        assert_eq!(on_disk["sessions"], serde_json::json!([]));

        let live = app.state::<super::AppState>().read_live().statuses.clone();
        assert_eq!(live.keys().collect::<Vec<_>>(), ["other"], "its status is forgotten, the other's kept");
        let emitted: serde_json::Value = serde_json::from_str(&rx.try_recv().expect("projects://status emitted")).unwrap();
        assert_eq!(emitted, serde_json::json!({ "other": { "kind": "missing" } }));

        let err = invoke_with(&webview, "workspace_remove_project", InvokeBody::Json(serde_json::json!({ "projectId": "ide" })))
            .expect_err("already gone");
        assert_eq!(err, serde_json::json!("unknown project"));
        invoke_with(&webview, "workspace_remove_project", InvokeBody::Json(serde_json::json!({})))
            .expect_err("projectId is required");
    }

    #[test]
    fn project_open_editor_is_registered_and_launches_the_templates_program_with_the_folder() {
        let (app, webview, dir) = app_with_ide();
        let folder = tempfile::tempdir().unwrap();
        let folder_path = folder.path().display().to_string();
        app.state::<super::AppState>().write_workspace().workspace.projects[0].path = folder_path.clone();

        // Unset editor: the notice text, exactly.
        let err = invoke_with(&webview, "project_open_editor", InvokeBody::Json(serde_json::json!({ "projectId": "ide" })))
            .expect_err("no editor configured");
        assert_eq!(err, serde_json::json!(super::ipc::NO_EDITOR));
        app.state::<super::AppState>().write().settings.external_editor = Some("   ".into());
        let err = invoke_with(&webview, "project_open_editor", InvokeBody::Json(serde_json::json!({ "projectId": "ide" })))
            .expect_err("a blank template is unset");
        assert_eq!(err, serde_json::json!(super::ipc::NO_EDITOR));

        // A script fixture in place of the editor: the template's first token names it, the
        // rest (`-g {file}:{line}`) is ignored; the folder arrives as its one argument.
        let out = dir.path().join("argv.txt");
        let recorder = super::process::fixtures::argv_recorder(dir.path(), "editor", &out);
        app.state::<super::AppState>().write().settings.external_editor = Some(format!("{} -g {{file}}:{{line}}", recorder.display()));
        let body = invoke_with(&webview, "project_open_editor", InvokeBody::Json(serde_json::json!({ "projectId": "ide" })))
            .expect("project_open_editor should be registered and succeed");
        let value: serde_json::Value = body.deserialize().unwrap();
        assert_eq!(value, serde_json::Value::Null);
        assert_eq!(
            super::process::fixtures::wait_for_file(&out, std::time::Duration::from_secs(5)),
            folder_path,
            "the folder is the only argument"
        );

        // A program that does not exist, and an unknown project, are notices too.
        let gone = dir.path().join("no-editor.exe");
        app.state::<super::AppState>().write().settings.external_editor = Some(gone.display().to_string());
        let err = invoke_with(&webview, "project_open_editor", InvokeBody::Json(serde_json::json!({ "projectId": "ide" })))
            .expect_err("missing program");
        assert_eq!(err, serde_json::json!(format!("external editor {} does not exist", gone.display())));
        let err = invoke_with(&webview, "project_open_editor", InvokeBody::Json(serde_json::json!({ "projectId": "nope" })))
            .expect_err("unknown project");
        assert_eq!(err, serde_json::json!("unknown project"));
    }

    #[test]
    fn project_open_folder_is_registered_and_fails_cleanly_without_the_opener_or_the_project() {
        let (_app, webview, _dir) = app_with_ide();
        // The mock app has no opener plugin, so a known project gets as far as the opener and
        // stops there (no file manager ever opens under test); an unknown id stops earlier.
        let err = invoke_with(&webview, "project_open_folder", InvokeBody::Json(serde_json::json!({ "projectId": "ide" })))
            .expect_err("no opener under test");
        assert_eq!(err, serde_json::json!("could not open folder: opener plugin not registered"));
        let err = invoke_with(&webview, "project_open_folder", InvokeBody::Json(serde_json::json!({ "projectId": "nope" })))
            .expect_err("unknown project");
        assert_eq!(err, serde_json::json!("unknown project"));
    }

    #[test]
    fn project_reveal_claude_dir_is_registered_and_finds_the_dir_for_the_folder() {
        let (app, webview, _dir) = app_with_ide();
        // No Claude home (the mock app never set one): the notice text.
        let err = invoke_with(&webview, "project_reveal_claude_dir", InvokeBody::Json(serde_json::json!({ "projectId": "ide" })))
            .expect_err("no claude home");
        assert_eq!(err, serde_json::json!(super::ipc::NO_CLAUDE_DIR));

        let home = tempfile::tempdir().unwrap();
        let folder = tempfile::tempdir().unwrap();
        let project_dir = home.path().join("projects").join("X--ide");
        std::fs::create_dir_all(&project_dir).unwrap();
        std::fs::write(
            project_dir.join("s.jsonl"),
            format!("{{\"type\":\"user\",\"cwd\":{}}}\n", serde_json::to_string(&folder.path().display().to_string()).unwrap()),
        )
        .unwrap();
        app.state::<super::AppState>().claude_home.set(home.path().to_path_buf()).unwrap();

        // The project's folder is not one Claude knows: the notice.
        let err = invoke_with(&webview, "project_reveal_claude_dir", InvokeBody::Json(serde_json::json!({ "projectId": "ide" })))
            .expect_err("folder unknown to Claude");
        assert_eq!(err, serde_json::json!(super::ipc::NO_CLAUDE_DIR));

        // Point the project at that folder: the dir is found and handed to the opener, which
        // the mock app does not have (so no file manager opens under test).
        app.state::<super::AppState>().write_workspace().workspace.projects[0].path =
            dunce::canonicalize(folder.path()).unwrap().display().to_string();
        let err = invoke_with(&webview, "project_reveal_claude_dir", InvokeBody::Json(serde_json::json!({ "projectId": "ide" })))
            .expect_err("no opener under test");
        assert_eq!(err, serde_json::json!("could not open Claude project directory: opener plugin not registered"));
        assert!(!home.path().join("projects").join("X--ide").join("written").exists(), "nothing written under the home");

        let err = invoke_with(&webview, "project_reveal_claude_dir", InvokeBody::Json(serde_json::json!({ "projectId": "nope" })))
            .expect_err("unknown project");
        assert_eq!(err, serde_json::json!("unknown project"));
    }

    #[test]
    fn claude_projects_list_is_registered_and_lists_nothing_without_a_claude_home() {
        let app = mock_app();
        let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .expect("mock webview should build");

        // The mock app never had `claude_home` set, so the real `~/.claude` is not read.
        let body = invoke(&webview, "claude_projects_list").expect("claude_projects_list should be registered");
        let value: serde_json::Value = body.deserialize().unwrap();
        assert_eq!(value, serde_json::json!([]));
    }

    #[test]
    fn claude_projects_list_reads_the_injected_home() {
        let app = mock_app();
        let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .expect("mock webview should build");
        let home = tempfile::tempdir().unwrap();
        let real = tempfile::tempdir().unwrap();
        let placed = tempfile::tempdir().unwrap();
        for (name, cwd) in [("X--one", real.path()), ("X--two", placed.path())] {
            let dir = home.path().join("projects").join(name);
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(
                dir.join("s.jsonl"),
                format!("{{\"type\":\"user\",\"cwd\":{}}}\n", serde_json::to_string(&cwd.display().to_string()).unwrap()),
            )
            .unwrap();
        }
        app.state::<super::AppState>().claude_home.set(home.path().to_path_buf()).unwrap();
        // `placed` is already on the canvas (spelled with a trailing separator, to prove the
        // comparison is on canonical paths).
        let cfg = tempfile::tempdir().unwrap();
        super::graph::initialise_at(app.handle(), Some(cfg.path().join("workspace.json")));
        let spelled = format!("{}{}", placed.path().display(), std::path::MAIN_SEPARATOR);
        super::graph::add_projects(app.handle(), &[spelled], super::graph::Position::default()).unwrap();

        let body = invoke(&webview, "claude_projects_list").unwrap();
        let value: serde_json::Value = body.deserialize().unwrap();
        let mut rows: Vec<&serde_json::Value> = value.as_array().unwrap().iter().collect();
        rows.sort_by_key(|row| row["dir"].as_str().unwrap().to_string());
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0]["dir"], "X--one");
        assert_eq!(rows[0]["exists"], true);
        assert_eq!(rows[0]["sessions"], 1);
        assert_eq!(rows[0]["cwd"], dunce::canonicalize(real.path()).unwrap().display().to_string());
        assert_eq!(rows[0]["on_canvas"], false);
        assert_eq!(rows[1]["dir"], "X--two");
        assert_eq!(rows[1]["on_canvas"], true);
    }

    #[test]
    fn a_sessions_pass_fills_in_the_projects_children_from_the_injected_home_and_is_quiet_when_unchanged() {
        let (app, _webview, dir) = app_with_ide();
        app.state::<super::AppState>().write_workspace().stub_children = 0;
        let home = tempfile::tempdir().unwrap();
        let cwd = "/p/ide";
        let claude_dir = home.path().join("projects").join("-p-ide");
        std::fs::create_dir_all(&claude_dir).unwrap();
        for (id, ts) in [("s-old", "2026-10-15T10:00:00.000Z"), ("s-new", "2026-10-16T10:00:00.000Z")] {
            let line = serde_json::json!({ "type": "user", "cwd": cwd, "timestamp": ts, "gitBranch": "main", "message": { "content": format!("prompt {id}") } });
            std::fs::write(claude_dir.join(format!("{id}.jsonl")), format!("{line}\n")).unwrap();
        }
        let before = std::fs::read_to_string(dir.path().join("workspace.json")).ok();

        // No Claude home yet: a pass reads nothing and changes nothing.
        tauri::async_runtime::block_on(super::claude::sessions::refresh(app.handle()));
        assert!(app.state::<super::AppState>().read_workspace().snapshot().children.is_empty());

        app.state::<super::AppState>().claude_home.set(home.path().to_path_buf()).unwrap();
        let (tx, rx) = std::sync::mpsc::channel();
        {
            use tauri::Listener;
            app.listen_any(super::graph::CHANGED_EVENT, move |event| {
                let _ = tx.send(event.payload().to_string());
            });
        }
        tauri::async_runtime::block_on(super::claude::sessions::refresh(app.handle()));
        let snapshot = app.state::<super::AppState>().read_workspace().snapshot();
        let ids: Vec<&str> = snapshot.children.iter().map(|c| c.id.as_str()).collect();
        assert_eq!(ids, ["s-new", "s-old"], "newest first");
        assert_eq!(snapshot.children[0].label, "prompt s-new");
        assert_eq!(snapshot.children[0].session.as_ref().unwrap().branch.as_deref(), Some("main"));
        assert_eq!(snapshot.revision, 1);
        let emitted: serde_json::Value = serde_json::from_str(&rx.try_recv().expect("workspace://changed")).unwrap();
        assert_eq!(emitted["children"][0]["session"]["messages"], 1);
        assert_eq!(std::fs::read_to_string(dir.path().join("workspace.json")).ok(), before, "not written");

        tauri::async_runtime::block_on(super::claude::sessions::refresh(app.handle()));
        assert!(rx.try_recv().is_err(), "unchanged: no event");
        assert_eq!(app.state::<super::AppState>().read_workspace().revision, 1);
        assert_eq!(app.state::<super::AppState>().sessions.lock().unwrap().parses, 2, "cache hits");
    }

    #[test]
    fn projects_status_get_is_registered_and_reads_the_live_state() {
        let app = mock_app();
        let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .expect("mock webview should build");

        let body = invoke(&webview, "projects_status_get").expect("projects_status_get should be registered");
        let value: serde_json::Value = body.deserialize().unwrap();
        assert_eq!(value, serde_json::json!({}));

        app.state::<super::AppState>()
            .write_live()
            .statuses
            .insert("p1".into(), super::git::ProjectStatus::NotRepo);
        let body = invoke(&webview, "projects_status_get").unwrap();
        let value: serde_json::Value = body.deserialize().unwrap();
        assert_eq!(value, serde_json::json!({ "p1": { "kind": "not_repo" } }));
    }

    #[test]
    fn live_sessions_get_is_registered_and_reads_the_live_map() {
        let app = mock_app();
        let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .expect("mock webview should build");

        let body = invoke(&webview, "live_sessions_get").expect("live_sessions_get should be registered");
        let value: serde_json::Value = body.deserialize().unwrap();
        assert_eq!(value, serde_json::json!({ "sessions": {}, "elsewhere": [], "banner": null }));

        let rows = super::claude::live::parse_rows(
            r#"[{"pid":7,"cwd":"/nowhere","kind":"interactive","startedAt":1791553254656,"sessionId":"s1","name":"n","status":"busy"}]"#,
        );
        super::claude::live::apply_and_emit(app.handle(), rows);
        let body = invoke(&webview, "live_sessions_get").unwrap();
        let value: serde_json::Value = body.deserialize().unwrap();
        assert_eq!(
            value,
            serde_json::json!({
                "sessions": { "s1": {
                    "state": { "kind": "busy" }, "source": "poll", "pid": 7, "kind": "interactive", "name": "n",
                    "project_id": null, "cwd": "/nowhere", "started_at": 1791553254656_i64,
                    "attention_since": null, "last_line": null, "detail": null, "status_text": null
                } },
                "elsewhere": [{ "session_id": "s1", "state": { "kind": "busy" }, "name": "n", "cwd": "/nowhere", "started_at": 1791553254656_i64 }],
                "banner": null
            })
        );
    }

    /// One poll row for `apply_and_emit`.
    fn live_rows(cwd: &str, id: &str, status: &str) -> Result<Vec<super::claude::live::LiveRow>, String> {
        let row = serde_json::json!([{ "cwd": cwd, "sessionId": id, "name": "fixer", "status": status }]);
        super::claude::live::parse_rows(&row.to_string())
    }

    #[test]
    fn session_acknowledge_is_registered_and_clears_a_finished_session() {
        let app = mock_app();
        let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .expect("mock webview should build");
        let (tx, rx) = std::sync::mpsc::channel();
        {
            use tauri::Listener;
            app.listen_any(super::claude::live::LIVE_EVENT, move |event| {
                let _ = tx.send(serde_json::from_str::<serde_json::Value>(event.payload()).unwrap());
            });
        }
        super::claude::live::apply_and_emit(app.handle(), live_rows("/nowhere", "s1", "busy"));
        super::claude::live::apply_and_emit(app.handle(), live_rows("/nowhere", "s1", "idle"));
        while rx.try_recv().is_ok() {}
        let since = {
            let state = app.state::<super::AppState>();
            let map = state.read_sessions_live();
            assert_eq!(map.sessions["s1"].state, super::claude::live::SessionState::Finished);
            map.sessions["s1"].attention_since.expect("stamped")
        };

        // An older turn than the one stored: a no-op.
        let stale = serde_json::json!({ "sessionId": "s1", "attentionSince": since - 1 });
        let body = invoke_with(&webview, "session_acknowledge", InvokeBody::Json(stale)).expect("registered");
        assert_eq!(body.deserialize::<serde_json::Value>().unwrap(), serde_json::Value::Null);
        assert!(rx.try_recv().is_err());

        let args = serde_json::json!({ "sessionId": "s1", "attentionSince": since });
        let body = invoke_with(&webview, "session_acknowledge", InvokeBody::Json(args.clone()))
            .expect("session_acknowledge should be registered and succeed");
        let replied: serde_json::Value = body.deserialize().unwrap();
        assert_eq!(replied["sessions"]["s1"]["state"], serde_json::json!({ "kind": "idle" }));
        assert_eq!(replied["sessions"]["s1"]["source"], "ack");
        let emitted = rx.try_recv().expect("sessions://live emitted");
        assert_eq!(emitted, replied, "the reply is the emitted snapshot");

        // Already idle, or unknown: a no-op, nothing emitted.
        let body = invoke_with(&webview, "session_acknowledge", InvokeBody::Json(args)).unwrap();
        assert_eq!(body.deserialize::<serde_json::Value>().unwrap(), serde_json::Value::Null);
        let body = invoke_with(
            &webview,
            "session_acknowledge",
            InvokeBody::Json(serde_json::json!({ "sessionId": "nope", "attentionSince": null })),
        )
        .unwrap();
        assert_eq!(body.deserialize::<serde_json::Value>().unwrap(), serde_json::Value::Null);
        assert!(rx.try_recv().is_err());
        invoke_with(&webview, "session_acknowledge", InvokeBody::Json(serde_json::json!({}))).expect_err("sessionId is required");
    }

    #[test]
    fn a_session_that_finishes_while_unfocused_sends_one_toast_through_the_injected_notifier() {
        let app = mock_app();
        // The mock window reports itself unfocused.
        let _webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .expect("mock webview should build");
        let recorder = std::sync::Arc::new(super::notify::fixtures::Recorder::default());
        *app.state::<super::AppState>().notifier.lock().unwrap() = Some(recorder.clone());
        let cfg = tempfile::tempdir().unwrap();
        super::graph::initialise_at(app.handle(), Some(cfg.path().join("workspace.json")));
        let ide = if cfg!(windows) { "B:\\projects\\ide" } else { "/projects/ide" };
        app.state::<super::AppState>().write_workspace().workspace.projects.push(super::graph::Project {
            id: "p1".into(),
            path: ide.into(),
            label: "ide".into(),
            ..super::graph::Project::default()
        });
        let id = "0b7c1234abcd";
        // Already idle at startup, then busy: no toast.
        super::claude::live::apply_and_emit(app.handle(), live_rows(ide, id, "idle"));
        super::claude::live::apply_and_emit(app.handle(), live_rows(ide, id, "busy"));
        assert!(recorder.sent.lock().unwrap().is_empty());
        // Busy -> idle: one toast, however long it stays idle.
        super::claude::live::apply_and_emit(app.handle(), live_rows(ide, id, "idle"));
        super::claude::live::apply_and_emit(app.handle(), live_rows(ide, id, "idle"));
        assert_eq!(*recorder.sent.lock().unwrap(), [("ide — finished".to_string(), "fixer".to_string())]);

        // Acknowledged, then idle again: no new toast.
        let since = app.state::<super::AppState>().read_sessions_live().sessions[id].attention_since;
        assert!(super::claude::live::acknowledge(app.handle(), id, since).is_some());
        super::claude::live::apply_and_emit(app.handle(), live_rows(ide, id, "idle"));
        assert_eq!(recorder.sent.lock().unwrap().len(), 1);
    }

    #[test]
    fn a_toast_body_is_the_discovered_transcript_title_and_never_the_untitled_placeholder() {
        let app = mock_app();
        let recorder = std::sync::Arc::new(super::notify::fixtures::Recorder::default());
        *app.state::<super::AppState>().notifier.lock().unwrap() = Some(recorder.clone());
        let cfg = tempfile::tempdir().unwrap();
        super::graph::initialise_at(app.handle(), Some(cfg.path().join("workspace.json")));
        let ide = if cfg!(windows) { r"B:\projects\ide" } else { "/projects/ide" };
        app.state::<super::AppState>().write_workspace().workspace.projects.push(super::graph::Project {
            id: "p1".into(),
            path: ide.into(),
            label: "ide".into(),
            ..super::graph::Project::default()
        });
        let summary = |id: &str, title: &str| super::claude::SessionSummary {
            id: id.into(),
            title: title.into(),
            started_at: "2026-10-18T10:00:00.000Z".into(),
            last_active: "2026-10-18T10:05:00.000Z".into(),
            branch: None,
            messages: 2,
            cwd: Some(ide.into()),
        };
        let discovered = std::collections::HashMap::from([(
            "p1".to_string(),
            vec![summary("titled", "Fix the login bug"), summary("untitled", super::claude::transcript::UNTITLED)],
        )]);
        super::graph::set_discovered(app.handle(), discovered);
        for id in ["titled", "untitled"] {
            super::claude::live::apply_and_emit(app.handle(), live_rows(ide, id, "busy"));
            super::claude::live::apply_and_emit(app.handle(), live_rows(ide, id, "idle"));
        }
        assert_eq!(
            *recorder.sent.lock().unwrap(),
            [
                ("ide — finished".to_string(), "Fix the login bug".to_string()),
                ("ide — finished".to_string(), "fixer".to_string()),
            ]
        );
    }

    #[test]
    fn app_quit_is_registered_under_its_wire_name() {
        let app = mock_app();
        let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .expect("mock webview should build");

        // Under `cfg(test)` the command returns instead of calling `app.exit(0)`, so reaching
        // this assertion at all proves the wire name resolves and the handler ran.
        let body = invoke(&webview, "app_quit").expect("app_quit should be registered and succeed");
        let value: serde_json::Value = body.deserialize().unwrap();
        assert_eq!(value, serde_json::Value::Null);
    }

    #[test]
    fn focus_main_window_without_a_main_window_is_a_no_op() {
        let app = mock_app();
        // No webview was built, so there is no "main" window to focus; this must not panic.
        super::focus_main_window(app.handle());
    }

    #[test]
    fn the_term_commands_are_registered_and_drive_a_fixture_shell() {
        use serde_json::json;
        let (app, webview, _dir) = app_with_ide();
        let folder = tempfile::tempdir().unwrap();
        let state = app.state::<super::AppState>();
        state.write_workspace().workspace.projects[0].path = folder.path().display().to_string();
        // Never the user's shell: `cmd /d` (no AutoRun) or `/bin/sh`.
        state.write().settings.shell = Some(if cfg!(windows) { "cmd.exe /d" } else { "/bin/sh" }.to_string());
        let call = |cmd: &str, args: serde_json::Value| -> Result<serde_json::Value, serde_json::Value> {
            invoke_with(&webview, cmd, InvokeBody::Json(args)).map(|body| body.deserialize().unwrap())
        };

        let info = call("term_open", json!({ "kind": "plain", "projectId": "ide", "cols": 90, "rows": 20 })).expect("term_open");
        assert_eq!(info["id"], "plain-ide");
        assert_eq!(info["project_id"], "ide");
        assert_eq!(info["title"], "ide");
        assert_eq!(info["cwd"], folder.path().display().to_string());
        assert_eq!(info["exited"], serde_json::Value::Null);
        assert_eq!(info["error"], serde_json::Value::Null);
        let term = state.terms.get("plain-ide").unwrap();
        assert_eq!(term.size(), (90, 20));
        let pid = term.pid().expect("the shell runs");
        // The same project again: the same terminal.
        let again = call("term_open", json!({ "kind": "plain", "projectId": "ide" })).unwrap();
        assert_eq!(again["id"], "plain-ide");
        assert_eq!(state.terms.get("plain-ide").unwrap().pid(), Some(pid));
        assert_eq!(call("term_list", json!({})).unwrap().as_array().unwrap().len(), 1);

        call("term_resize", json!({ "id": "plain-ide", "cols": 100, "rows": 30 })).expect("term_resize");
        assert_eq!(term.size(), (100, 30));
        call("term_write", json!({ "id": "plain-ide", "data": "\r" })).expect("term_write");
        let buffer = call("term_buffer", json!({ "id": "plain-ide" })).unwrap();
        assert!(buffer["data"].is_string());
        assert!(buffer["offset"].is_u64());
        assert_eq!(info["cols"], 90);
        assert_eq!(info["rows"], 20);

        // Kill: exited, buffer kept; restart respawns in place.
        call("term_kill", json!({ "id": "plain-ide" })).expect("term_kill");
        let started = std::time::Instant::now();
        while term.is_running() {
            assert!(started.elapsed() < std::time::Duration::from_secs(20), "kill did not end the shell");
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        assert!(call("term_list", json!({})).unwrap()[0]["exited"].is_i64());
        let restarted = call("term_restart", json!({ "id": "plain-ide" })).expect("term_restart");
        assert_eq!(restarted["exited"], serde_json::Value::Null);
        assert!(term.pid().is_some());

        // Errors are strings the UI can show.
        assert_eq!(call("term_write", json!({ "id": "nope", "data": "x" })), Err(json!("unknown terminal")));
        assert_eq!(
            call("term_open", json!({ "kind": "plain", "projectId": "nope" })),
            Err(json!("unknown project"))
        );
        call("term_open", json!({ "kind": "claude", "projectId": "ide" })).expect_err("only plain terminals in 4.1");

        // App exit kills every child: the restarted shell is gone.
        let restarted_pid = term.pid().expect("the restarted shell runs");
        super::on_run_event(app.handle(), &tauri::RunEvent::Exit);
        assert!(term.pid().is_none(), "the PTY is closed on exit");
        super::pty::tests::wait_dead(restarted_pid);
        super::pty::tests::wait_dead(pid);
    }

    #[test]
    fn pop_out_windows_are_counted_tracked_focused_returned_and_closed_on_quit() {
        use serde_json::json;
        use std::sync::{Arc, Mutex};
        use tauri::Listener;
        let (app, webview, _dir) = app_with_ide();
        let folder = tempfile::tempdir().unwrap();
        let state = app.state::<super::AppState>();
        state.write_workspace().workspace.projects[0].path = folder.path().display().to_string();
        state.write().settings.shell = Some(if cfg!(windows) { "cmd.exe /d" } else { "/bin/sh" }.to_string());
        let events: Arc<Mutex<Vec<serde_json::Value>>> = Arc::default();
        let sink = events.clone();
        app.listen(super::windows::POPPED_EVENT, move |event| {
            sink.lock().unwrap().push(serde_json::from_str(event.payload()).unwrap());
        });
        let take = || std::mem::take(&mut *events.lock().unwrap());
        let call = |cmd: &str, args: serde_json::Value| -> Result<serde_json::Value, serde_json::Value> {
            invoke_with(&webview, cmd, InvokeBody::Json(args)).map(|body| body.deserialize().unwrap())
        };

        assert_eq!(call("term_pop_out", json!({ "id": "plain-ide" })), Err(json!("unknown terminal")));
        assert!(app.get_webview_window("term-1").is_none(), "nothing is built for an unknown terminal");
        call("term_open", json!({ "kind": "plain", "projectId": "ide", "cols": 90, "rows": 20 })).expect("term_open");
        let pid = state.terms.get("plain-ide").unwrap().pid().expect("the shell runs");

        // Pop out: a `term-1` window, recorded and announced; the PTY is the same one.
        assert_eq!(call("term_pop_out", json!({ "id": "plain-ide" })), Ok(json!("term-1")));
        let window = app.get_webview_window("term-1").expect("the pop-out window exists");
        // (The mock runtime keeps no title; `windows::window_title` is tested on its own.)
        assert_eq!(window.url().unwrap().query(), Some("terminal=plain-ide"));
        assert_eq!(take(), vec![json!({ "id": "plain-ide", "label": "term-1" })]);
        assert_eq!(call("term_popped", json!({})), Ok(json!([{ "id": "plain-ide", "label": "term-1" }])));
        assert_eq!(state.terms.get("plain-ide").unwrap().pid(), Some(pid), "a pop-out spawns nothing");

        // Again: the same window (focused), no second one, no event.
        assert_eq!(call("term_pop_out", json!({ "id": "plain-ide" })), Ok(json!("term-1")));
        assert!(app.get_webview_window("term-2").is_none());
        assert!(take().is_empty());

        // The window closed by any means: back in the pane.
        super::on_window_destroyed(app.handle(), "term-1");
        assert_eq!(take(), vec![json!({ "id": "plain-ide", "label": null })]);
        assert_eq!(call("term_popped", json!({})), Ok(json!([])));
        // A late second report of the same window changes nothing.
        super::on_window_destroyed(app.handle(), "term-1");
        assert!(take().is_empty());

        // Popped again: a fresh label. Return to pane forgets it at once.
        assert_eq!(call("term_pop_out", json!({ "id": "plain-ide" })), Ok(json!("term-2")));
        take();
        call("term_return", json!({ "id": "plain-ide" })).expect("term_return");
        assert_eq!(take(), vec![json!({ "id": "plain-ide", "label": null })]);
        call("term_return", json!({ "id": "plain-ide" })).expect("returning twice is fine");
        assert!(take().is_empty());

        // The main window going takes the pop-outs with it; so does quitting.
        assert_eq!(call("term_pop_out", json!({ "id": "plain-ide" })), Ok(json!("term-3")));
        take();
        super::on_window_destroyed(app.handle(), super::MAIN_WINDOW);
        assert_eq!(take(), vec![json!({ "id": "plain-ide", "label": null })]);
        assert_eq!(call("term_pop_out", json!({ "id": "plain-ide" })), Ok(json!("term-4")));
        take();
        super::windows::close_all(app.handle());
        assert_eq!(take(), vec![json!({ "id": "plain-ide", "label": null })]);
        assert!(state.popouts.list().is_empty());

        super::on_run_event(app.handle(), &tauri::RunEvent::Exit);
        super::pty::tests::wait_dead(pid);
    }

    /// Collect the payloads of `event` emitted on `app`.
    fn record(app: &tauri::App<tauri::test::MockRuntime>, event: &str) -> std::sync::Arc<std::sync::Mutex<Vec<serde_json::Value>>> {
        use tauri::Listener;
        let events: std::sync::Arc<std::sync::Mutex<Vec<serde_json::Value>>> = Default::default();
        let sink = events.clone();
        app.listen(event.to_string(), move |e| sink.lock().unwrap().push(serde_json::from_str(e.payload()).unwrap()));
        events
    }

    fn drain(events: &std::sync::Mutex<Vec<serde_json::Value>>) -> Vec<serde_json::Value> {
        std::mem::take(&mut *events.lock().unwrap())
    }

    #[test]
    fn pop_out_edges_failed_builds_stale_records_restart_close_and_project_removal() {
        use serde_json::json;
        let (app, webview, _dir) = app_with_ide();
        let folder = tempfile::tempdir().unwrap();
        let state = app.state::<super::AppState>();
        state.write_workspace().workspace.projects[0].path = folder.path().display().to_string();
        state.write().settings.shell = Some(if cfg!(windows) { "cmd.exe /d" } else { "/bin/sh" }.to_string());
        let popped = record(&app, super::windows::POPPED_EVENT);
        let infos = record(&app, super::pty::INFO_EVENT);
        let closed = record(&app, super::pty::CLOSED_EVENT);
        let call = |cmd: &str, args: serde_json::Value| -> Result<serde_json::Value, serde_json::Value> {
            invoke_with(&webview, cmd, InvokeBody::Json(args)).map(|body| body.deserialize().unwrap())
        };
        call("term_open", json!({ "kind": "plain", "projectId": "ide" })).expect("term_open");
        let term = state.terms.get("plain-ide").unwrap();
        let first_pid = term.pid().expect("the shell runs");

        // A pop-out whose window is still being built: a second one answers with its label and
        // builds nothing.
        let super::windows::Claim::New(building) = state.popouts.claim("plain-ide") else { panic!("fresh claim") };
        assert_eq!(call("term_pop_out", json!({ "id": "plain-ide" })), Ok(json!(building.clone())));
        assert!(app.get_webview_window(&building).is_none());
        state.popouts.finish_build(&building);
        assert!(state.popouts.release("plain-ide", &building));

        // A window the OS (here: a taken label) will not make: an error, nothing recorded.
        tauri::WebviewWindowBuilder::new(&app, "term-2", Default::default()).build().unwrap();
        let err = call("term_pop_out", json!({ "id": "plain-ide" })).expect_err("the label is taken");
        assert!(err.as_str().unwrap().starts_with("could not open the terminal window: "), "{err}");
        assert!(state.popouts.list().is_empty());
        assert!(drain(&popped).is_empty());

        // A record whose window is gone: forgotten, and a new window built.
        let super::windows::Claim::New(stale) = state.popouts.claim("plain-ide") else { panic!("fresh claim") };
        state.popouts.finish_build(&stale);
        assert_eq!(stale, "term-3");
        assert_eq!(call("term_pop_out", json!({ "id": "plain-ide" })), Ok(json!("term-4")));
        assert_eq!(
            drain(&popped),
            vec![json!({ "id": "plain-ide", "label": null }), json!({ "id": "plain-ide", "label": "term-4" })]
        );
        assert!(app.get_webview_window("term-4").is_some());

        // A restart (of the popped terminal) tells every window its new info.
        call("term_kill", json!({ "id": "plain-ide" })).expect("term_kill");
        let started = std::time::Instant::now();
        while term.is_running() {
            assert!(started.elapsed() < std::time::Duration::from_secs(20), "kill did not end the shell");
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        let restarted = call("term_restart", json!({ "id": "plain-ide" })).expect("term_restart");
        assert_eq!(drain(&infos), vec![restarted]);
        let second_pid = term.pid().expect("the restarted shell runs");

        // The project leaving the canvas closes its terminals' pop-outs.
        call("workspace_remove_project", json!({ "projectId": "ide" })).expect("remove");
        assert_eq!(drain(&popped), vec![json!({ "id": "plain-ide", "label": null })]);
        assert!(state.popouts.list().is_empty());
        super::pty::tests::wait_dead(second_pid);
        super::pty::tests::wait_dead(first_pid);

        // Closing a popped-out exited session terminal: closed, popped null, the record gone.
        #[cfg(windows)]
        let (program, args) = ("cmd.exe", vec!["/d".to_string(), "/c".to_string(), "exit 0".to_string()]);
        #[cfg(not(windows))]
        let (program, args) = ("/bin/sh", vec!["-c".to_string(), "exit 0".to_string()]);
        let hooks = super::pty::SessionHooks { first_output: Box::new(|| {}), exit: Box::new(|_| {}) };
        let spec = super::pty::SpawnSpec::new(program, args, folder.path());
        let sink = std::sync::Arc::new(super::pty::EventSink(app.handle().clone()));
        state
            .terms
            .open_session("session:s1", "ide", "ide-s1", &folder.path().display().to_string(), (80, 24), spec, sink, hooks)
            .expect("open_session");
        let session = state.terms.get("session:s1").unwrap();
        // (On Windows conhost holds the fixture until its cursor query is answered: kill it.)
        state.terms.kill("session:s1").expect("kill");
        let started = std::time::Instant::now();
        while session.is_running() {
            assert!(started.elapsed() < std::time::Duration::from_secs(30), "the fixture did not exit");
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        assert_eq!(call("term_pop_out", json!({ "id": "session:s1" })), Ok(json!("term-5")));
        drain(&popped);
        call("term_close", json!({ "id": "session:s1" })).expect("term_close");
        assert_eq!(drain(&popped), vec![json!({ "id": "session:s1", "label": null })]);
        assert_eq!(drain(&closed), vec![json!({ "id": "session:s1" })]);
        assert!(state.popouts.list().is_empty());
        assert!(state.terms.get("session:s1").is_none());

        super::on_run_event(app.handle(), &tauri::RunEvent::Exit);
    }

    /// An `ide` project in a real folder, a session folder in a temp dir, and the launcher's
    /// program replaced by a fixture: `sh` / `cmd` that waits for one line of input, then prints
    /// `node=<SWITCHBOARD_NODE>` and the argv it received (never the real `claude`).
    fn launch_fixture() -> (
        tauri::App<tauri::test::MockRuntime>,
        tauri::WebviewWindow<tauri::test::MockRuntime>,
        tempfile::TempDir,
        tempfile::TempDir,
        std::path::PathBuf,
    ) {
        let (app, webview, dir) = app_with_ide();
        app.state::<super::AppState>().write_workspace().stub_children = 0;
        let folder = tempfile::tempdir().unwrap();
        let canonical = dunce::canonicalize(folder.path()).unwrap().display().to_string();
        app.state::<super::AppState>().write_workspace().workspace.projects[0].path = canonical;
        let sessions = dir.path().join("switchboard").join("sessions");
        let state = app.state::<super::AppState>();
        state.launcher.set_dir(sessions.clone());
        #[cfg(windows)]
        let program = (
            std::path::PathBuf::from("cmd.exe"),
            ["/d", "/c", "set", "/p", "x=", "&", "echo", "node=%SWITCHBOARD_NODE%", "port=%SWITCHBOARD_PORT%", "&", "echo"]
                .map(String::from)
                .to_vec(),
        );
        #[cfg(not(windows))]
        let program = (
            std::path::PathBuf::from("/bin/sh"),
            ["-c", "read x; printf 'node=%s port=%s\\n' \"$SWITCHBOARD_NODE\" \"$SWITCHBOARD_PORT\"; printf '[%s]\\n' \"$@\"", "sh"]
                .map(String::from)
                .to_vec(),
        );
        *state.launcher.program.lock().unwrap() = Some(program);
        (app, webview, dir, folder, sessions)
    }

    /// The cursor queries answered so far, per terminal (each run of a session is a terminal of
    /// its own), across every `wait_until` call: a query is answered once. Answering it again
    /// types `ESC[1;1R` into the program, which a Windows console reads as F3 (recall the last
    /// line).
    static ANSWERED: std::sync::Mutex<Vec<(std::sync::Weak<super::pty::Term>, usize)>> = std::sync::Mutex::new(Vec::new());

    /// Wait (bounded) for `pred`, answering ConPTY's cursor query (`ESC[6n`) the way a view does:
    /// each query once.
    fn wait_until(app: &tauri::App<tauri::test::MockRuntime>, term: &str, what: &str, pred: impl Fn() -> bool) {
        let state = app.state::<super::AppState>();
        let started = std::time::Instant::now();
        loop {
            if pred() {
                return;
            }
            if let (Some(handle), Ok(buffer)) = (state.terms.get(term), state.terms.buffer(term)) {
                let seen = buffer.data.matches("\u{1b}[6n").count();
                let me = std::sync::Arc::downgrade(&handle);
                let mut answered = ANSWERED.lock().unwrap_or_else(|e| e.into_inner());
                answered.retain(|(w, _)| w.strong_count() > 0);
                let at = match answered.iter().position(|(w, _)| w.ptr_eq(&me)) {
                    Some(at) => at,
                    None => {
                        answered.push((me, 0));
                        answered.len() - 1
                    }
                };
                while answered[at].1 < seen {
                    let _ = state.terms.write(term, b"\x1b[1;1R");
                    answered[at].1 += 1;
                }
            }
            assert!(started.elapsed() < std::time::Duration::from_secs(20), "timed out waiting for {what}");
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
    }

    #[test]
    fn session_launch_runs_the_recipe_in_a_session_terminal_and_follows_starting_idle_exited() {
        use serde_json::json;
        use super::claude::live::SessionState;
        let (app, webview, _dir, folder, sessions) = launch_fixture();
        let state = app.state::<super::AppState>();
        let call = |cmd: &str, args: serde_json::Value| -> Result<serde_json::Value, serde_json::Value> {
            invoke_with(&webview, cmd, InvokeBody::Json(args)).map(|body| body.deserialize().unwrap())
        };
        let (tx, rx) = std::sync::mpsc::channel();
        {
            use tauri::Listener;
            app.listen_any(super::claude::live::LIVE_EVENT, move |event| {
                let _ = tx.send(serde_json::from_str::<serde_json::Value>(event.payload()).unwrap());
            });
        }

        let prefill = call("launch_defaults", json!({ "projectId": "ide" })).expect("launch_defaults");
        assert_eq!(prefill["model"], "default");
        assert_eq!(prefill["permissionMode"], "default");
        let name = prefill["name"].as_str().unwrap().to_string();
        assert!(name.starts_with("ide-") && name.len() == 8, "{name}");

        let proposed = prefill["sessionId"].as_str().unwrap().to_string();
        let extra = tempfile::tempdir().unwrap();
        let request = json!({
            "projectId": "ide", "sessionId": proposed, "name": name, "model": "opus", "effort": "high", "permissionMode": "plan",
            "addDirs": [extra.path().display().to_string()], "prompt": "hi", "background": false
        });
        let reply = call("session_launch", json!({ "request": request, "cols": 1000, "rows": 40 })).expect("session_launch");
        let id = reply["session_id"].as_str().unwrap().to_string();
        assert_eq!(id, proposed, "the id the sheet showed");
        assert_eq!(uuid::Uuid::parse_str(&id).unwrap().get_version_num(), 4);
        // The same sheet again (a double Start): the id is claimed once.
        assert_eq!(
            call("session_launch", json!({ "request": request })),
            Err(json!(super::claude::launch::STALE_SHEET))
        );
        assert_eq!(super::claude::launch::default_name("ide", &id), name, "the proposed id is the one used");
        let term_id = format!("session:{id}");
        assert_eq!(reply["term"]["id"], term_id.as_str());
        assert_eq!(reply["term"]["kind"], "session");
        assert_eq!(reply["term"]["title"], name.as_str());
        assert_eq!(reply["term"]["cwd"], dunce::canonicalize(folder.path()).unwrap().display().to_string());
        let settings_file = sessions.join(format!("{id}.settings.json"));
        assert_eq!(std::fs::read_to_string(&settings_file).unwrap(), "{}");

        // A live-only child at once, `starting` until the first printable output: the fixture
        // waits for a line, and ConPTY's start-up cursor query and screen setup do not count.
        let started = std::time::Instant::now();
        wait_until(&app, &term_id, "half a second of start-up", || started.elapsed() > std::time::Duration::from_millis(500));
        {
            let map = state.read_sessions_live();
            let session = &map.sessions[&id];
            assert_eq!(session.project_id.as_deref(), Some("ide"));
            assert_eq!(session.name.as_deref(), Some(name.as_str()));
            assert_eq!(session.state, SessionState::Starting);
        }
        let children = state.read_workspace().snapshot().children;
        assert_eq!(children.iter().filter(|c| c.id == id).count(), 1, "one node for the session");
        assert_eq!(children.iter().find(|c| c.id == id).unwrap().label, name);
        let remembered = state.read_workspace().workspace.projects[0].launch_defaults.clone().unwrap();
        assert_eq!(
            (remembered.model.as_deref(), remembered.effort.as_deref(), remembered.permission_mode.as_deref()),
            (Some("opus"), Some("high"), Some("plan"))
        );
        let again = call("launch_defaults", json!({ "projectId": "ide" })).unwrap();
        assert_eq!((again["model"].clone(), again["effort"].clone(), again["permissionMode"].clone()), (json!("opus"), json!("high"), json!("plan")));
        assert_eq!(call("term_restart", json!({ "id": term_id })), Err(json!("a session terminal cannot be restarted")));
        let pid = state.terms.get(&term_id).unwrap().pid().expect("the fixture runs");

        // Let it print: idle on the first output, then the argv, then the exit.
        state.terms.write(&term_id, b"go\r").unwrap();
        let output = || super::pty::tests::strip_escapes(&state.terms.buffer(&term_id).unwrap().data);
        wait_until(&app, &term_id, "the fixture's output", || output().contains(&format!("node={id}")));
        wait_until(&app, &term_id, "the exit", || {
            state.read_sessions_live().sessions[&id].state == SessionState::Exited
        });
        wait_until(&app, &term_id, "the settings file to go", || !settings_file.exists());
        super::pty::tests::wait_dead(pid);
        let text = output();
        let extra_dir = dunce::canonicalize(extra.path()).unwrap().display().to_string();
        let settings_arg = settings_file.display().to_string();
        if cfg!(windows) {
            let flat = text.replace(['\r', '\n'], "");
            for part in [
                format!("--session-id {id} --name {name} --model opus --effort high --permission-mode plan --add-dir"),
                extra_dir,
                format!("--settings {settings_arg} --append-system-prompt"),
            ] {
                assert!(flat.contains(&part), "{part:?} missing from {flat:?}");
            }
        } else {
            let expected: Vec<String> = [
                "--session-id",
                &id,
                "--name",
                &name,
                "--model",
                "opus",
                "--effort",
                "high",
                "--permission-mode",
                "plan",
                "--add-dir",
                &extra_dir,
                "--settings",
                &settings_arg,
                "--append-system-prompt",
            ]
            .iter()
            .map(|a| format!("[{a}]"))
            .collect();
            assert!(text.contains(&expected.join("\r\n")), "argv not as built:\n{text}");
            assert!(text.contains(&format!("Switchboard node id: {id}]")), "{text}");
            assert!(text.contains("[hi]"), "the prompt is the last argument: {text}");
        }
        assert!(!text.contains("--mcp-config") && !text.contains("dangerously"));
        let events: Vec<serde_json::Value> = rx.try_iter().collect();
        let kinds: Vec<&str> = events.iter().filter_map(|e| e["sessions"][&id]["state"]["kind"].as_str()).collect();
        // Every step went out. (Tauri hands an event that arrives while another thread is
        // dispatching to its pending queue, so Rust-side listeners may see them reordered; the
        // map itself was checked above.)
        for kind in ["starting", "idle", "exited"] {
            assert!(kinds.contains(&kind), "{kind} not emitted: {kinds:?}");
        }
        assert!(state.read_workspace().snapshot().children.iter().any(|c| c.id == id), "stays as a historic node");

        // App exit deletes every settings file still kept (a session still running then).
        let leftover = state.launcher.write_settings("leftover").unwrap();
        super::on_run_event(app.handle(), &tauri::RunEvent::Exit);
        assert!(!leftover.exists(), "app exit deletes the settings files");
    }

    #[test]
    fn session_launch_refusals_start_nothing() {
        use serde_json::json;
        let (app, webview, dir, _folder, sessions) = launch_fixture();
        let state = app.state::<super::AppState>();
        let call = |request: serde_json::Value| -> Result<serde_json::Value, serde_json::Value> {
            invoke_with(&webview, "session_launch", InvokeBody::Json(json!({ "request": request }))).map(|body| body.deserialize().unwrap())
        };
        let base = || json!({ "projectId": "ide", "sessionId": "not-proposed", "name": "ide-0000" });
        let nothing_started = || {
            assert!(state.terms.list().is_empty(), "no terminal");
            assert!(state.read_sessions_live().sessions.is_empty(), "no child");
            assert!(std::fs::read_dir(&sessions).map(|d| d.count()).unwrap_or(0) == 0, "no settings file");
        };

        let mut bypass = base();
        bypass["permissionMode"] = json!("bypassPermissions");
        assert_eq!(call(bypass), Err(json!(super::claude::launch::BYPASS_REFUSED)));
        let mut blank = base();
        blank["name"] = json!("   ");
        assert_eq!(call(blank), Err(json!("name must not be blank")));
        let gone = dir.path().join("gone").display().to_string();
        let mut missing_dir = base();
        missing_dir["addDirs"] = json!([gone.clone()]);
        assert_eq!(call(missing_dir), Err(json!(format!("{}{gone}", super::claude::launch::ADD_DIR_MISSING))));
        let mut unknown = base();
        unknown["projectId"] = json!("nope");
        assert_eq!(call(unknown), Err(json!("unknown project")));
        nothing_started();

        // An id the sheet was not given: refused before anything is touched.
        assert_eq!(call(base()), Err(json!(super::claude::launch::STALE_SHEET)));
        nothing_started();

        // With no project choices, the prefill falls back to settings.defaults.
        state.write().settings.defaults = super::settings::LaunchDefaults {
            model: Some("sonnet".into()),
            effort: Some("low".into()),
            permission_mode: Some("acceptEdits".into()),
        };
        let prefill: serde_json::Value = invoke_with(&webview, "launch_defaults", InvokeBody::Json(json!({ "projectId": "ide" })))
            .unwrap()
            .deserialize()
            .unwrap();
        assert_eq!((prefill["model"].clone(), prefill["effort"].clone(), prefill["permissionMode"].clone()), (json!("sonnet"), json!("low"), json!("acceptEdits")));
        let proposed = prefill["sessionId"].as_str().unwrap().to_string();
        let mut good = base();
        good["sessionId"] = json!(proposed);

        // A program that cannot start: the error, nothing left behind, and the id given back so
        // the same sheet can retry.
        let absent = dir.path().join("no-claude.exe");
        *state.launcher.program.lock().unwrap() = Some((absent.clone(), Vec::new()));
        for _ in 0..2 {
            let err = call(good.clone()).expect_err("spawn fails");
            assert!(err.as_str().unwrap().starts_with(&format!("could not start {}", absent.display())), "{err}");
            nothing_started();
        }

        // An id something else already uses (a session the poll saw): refused, and the other
        // session is left alone.
        state.write_sessions_live().launched(&proposed, None, "/elsewhere", "theirs", 1);
        assert_eq!(call(good.clone()), Err(json!(super::claude::launch::ID_IN_USE)));
        assert_eq!(state.read_sessions_live().sessions[&proposed].name.as_deref(), Some("theirs"));
        assert!(state.terms.list().is_empty());
        state.write_sessions_live().forget(&proposed);

        // A settings file already there (planted): refused, and not deleted.
        std::fs::create_dir_all(&sessions).unwrap();
        let planted = sessions.join(format!("{proposed}.settings.json"));
        std::fs::write(&planted, "planted").unwrap();
        *state.launcher.program.lock().unwrap() = None;
        state.write().binaries.claude = super::settings::Binary {
            name: "claude".into(),
            path: Some(dir.path().join("no-claude.exe").display().to_string()),
            version: Some("2.1.302".into()),
            status: super::settings::BinaryStatus::Found,
            configured: true,
        };
        let err = call(good.clone()).expect_err("the file exists");
        assert!(err.as_str().unwrap().starts_with("could not write session settings"), "{err}");
        assert_eq!(std::fs::read_to_string(&planted).unwrap(), "planted");
        assert!(state.terms.list().is_empty() && state.read_sessions_live().sessions.is_empty());
        std::fs::remove_file(&planted).unwrap();
        state.write().binaries.claude = super::settings::Binary::pending("claude");

        // `term_open` cannot open a session terminal.
        let err = invoke_with(&webview, "term_open", InvokeBody::Json(json!({ "kind": "session", "projectId": "ide" }))).expect_err("refused");
        assert_eq!(err, json!("a session terminal is opened by session_launch"));
        nothing_started();

        // No fixture and no claude found: the sheet's message.
        *state.launcher.program.lock().unwrap() = None;
        assert_eq!(call(base()), Err(json!(super::claude::launch::NO_CLAUDE)));
        // A batch-file claude (Windows only refuses it), spelled out or reached through PATHEXT.
        std::fs::write(dir.path().join("claude.cmd"), "@echo off").unwrap();
        for spelled in [dir.path().join("claude.cmd"), dir.path().join("claude")] {
            state.write().binaries.claude = super::settings::Binary {
                name: "claude".into(),
                path: Some(spelled.display().to_string()),
                version: Some("2.1.302".into()),
                status: super::settings::BinaryStatus::Found,
                configured: true,
            };
            if cfg!(windows) {
                assert_eq!(call(good.clone()), Err(json!(super::claude::launch::BATCH_FILE)), "{}", spelled.display());
            }
        }
        nothing_started();
    }

    /// Windows: the command line ConPTY gets is split back into exactly the argv Rust built, a
    /// multi-line system prompt and a prompt with quotes and spaces included. The fixture is
    /// PowerShell printing `[Environment]::GetCommandLineArgs()` one per line (newlines shown
    /// as `\n`), never `claude`.
    #[cfg(windows)]
    #[test]
    fn session_launch_argv_round_trips_through_the_windows_command_line() {
        use serde_json::json;
        let (app, webview, dir, _folder, sessions) = launch_fixture();
        let state = app.state::<super::AppState>();
        let script = dir.path().join("argv.ps1");
        std::fs::write(
            &script,
            "[Environment]::GetCommandLineArgs() | Select-Object -Skip 7 | ForEach-Object { '[' + ($_ -replace \"`r\", '\\r' -replace \"`n\", '\\n') + ']' }\r\n",
        )
        .unwrap();
        *state.launcher.program.lock().unwrap() = Some((
            std::path::PathBuf::from("powershell.exe"),
            ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File"]
                .map(String::from)
                .into_iter()
                .chain([script.display().to_string()])
                .collect(),
        ));
        let call = |cmd: &str, args: serde_json::Value| -> Result<serde_json::Value, serde_json::Value> {
            invoke_with(&webview, cmd, InvokeBody::Json(args)).map(|body| body.deserialize().unwrap())
        };
        let prefill = call("launch_defaults", json!({ "projectId": "ide" })).unwrap();
        let prompt = "say \"hi there\" to C:\\dir with space\\ now";
        let request = json!({
            "projectId": "ide", "sessionId": prefill["sessionId"], "name": prefill["name"], "prompt": prompt
        });
        let reply = call("session_launch", json!({ "request": request, "cols": 2000, "rows": 50 })).expect("session_launch");
        let id = reply["session_id"].as_str().unwrap().to_string();
        let term_id = format!("session:{id}");
        let settings_file = sessions.join(format!("{id}.settings.json"));
        wait_until(&app, &term_id, "the fixture to exit", || !state.terms.get(&term_id).unwrap().is_running());
        let text = super::pty::tests::strip_escapes(&state.terms.buffer(&term_id).unwrap().data);
        let printed: Vec<String> = text
            .lines()
            .map(str::trim_end)
            .filter(|l| l.starts_with('[') && l.ends_with(']'))
            .map(|l| l[1..l.len() - 1].to_string())
            .collect();
        let path = state.read_workspace().workspace.projects[0].path.clone();
        let name = prefill["name"].as_str().unwrap();
        let context = super::claude::launch::system_prompt("ide", &path, None, name, &id, &[]).replace('\n', "\\n");
        let expected: Vec<String> = [
            "--session-id",
            &id,
            "--name",
            name,
            "--settings",
            &settings_file.display().to_string(),
            "--append-system-prompt",
            &context,
            prompt,
        ]
        .map(String::from)
        .to_vec();
        assert_eq!(printed, expected, "output:\n{text}");
        super::on_run_event(app.handle(), &tauri::RunEvent::Exit);
    }

    /// Story 4.3: with the endpoint up, a launch writes the hooks block, passes the port, and
    /// raw-HTTP hook POSTs drive the session (waiting → answered in the terminal → finished),
    /// emitting at once and toasting through the injected recorder; the token dies with the
    /// session. The fixture program stands in for `claude`.
    #[test]
    fn hook_posts_drive_a_launched_session_and_its_token_dies_with_it() {
        use super::claude::hooks::{self, tests::{eventually, http}};
        use super::claude::live::{SessionState, StateSource};
        use serde_json::json;
        let (app, webview, _dir, _folder, sessions) = launch_fixture();
        let state = app.state::<super::AppState>();
        let recorder = std::sync::Arc::new(super::notify::fixtures::Recorder::default());
        *state.notifier.lock().unwrap() = Some(recorder.clone());
        let server = hooks::start_on(app.handle(), hooks::bind()).expect("the endpoint starts");
        let port = state.hooks.port().expect("up");
        let call = |cmd: &str, args: serde_json::Value| -> Result<serde_json::Value, serde_json::Value> {
            invoke_with(&webview, cmd, InvokeBody::Json(args)).map(|body| body.deserialize().unwrap())
        };
        let (tx, rx) = std::sync::mpsc::channel();
        {
            use tauri::Listener;
            app.listen_any(super::claude::live::LIVE_EVENT, move |event| {
                let _ = tx.send(serde_json::from_str::<serde_json::Value>(event.payload()).unwrap());
            });
        }

        let prefill = call("launch_defaults", json!({ "projectId": "ide" })).unwrap();
        let request = json!({ "projectId": "ide", "sessionId": prefill["sessionId"], "name": prefill["name"] });
        let reply = call("session_launch", json!({ "request": request, "cols": 200, "rows": 30 })).expect("session_launch");
        let id = reply["session_id"].as_str().unwrap().to_string();
        let term_id = format!("session:{id}");

        // The settings file holds the hooks block with this session's token.
        let settings: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(sessions.join(format!("{id}.settings.json"))).unwrap()).unwrap();
        let auth = settings["hooks"]["Stop"][0]["hooks"][0]["headers"]["Authorization"].as_str().unwrap().to_string();
        let token = auth.strip_prefix("Bearer ").unwrap().to_string();
        assert_eq!(settings, hooks::settings_json(port, &token));
        assert!(!state.read_sessions_live().hooked.contains_key(&id), "hooked only from its first hook event");
        let post = |event: &str, body: serde_json::Value| http(port, "POST", &format!("/hooks/{event}"), Some(&token), body.to_string().as_bytes());
        let live = |id: &str| state.read_sessions_live().sessions[id].clone();
        // Hook events are applied just after the reply.
        let becomes = |what: &str, want: SessionState| eventually(what, || live(&id).state == want);

        assert_eq!(post("SessionStart", json!({ "session_id": id })), (200, String::new()));
        becomes("idle from SessionStart", SessionState::Idle);
        assert_eq!(live(&id).source, StateSource::Hook);
        assert!(state.read_sessions_live().hooked.contains_key(&id));
        while rx.try_recv().is_ok() {}

        // Permission: waiting, emitted, with a toast.
        assert_eq!(post("PermissionRequest", json!({ "session_id": id, "tool_name": "Bash" })).0, 200);
        becomes("waiting", SessionState::Waiting);
        assert_eq!(live(&id).detail.as_deref(), Some("permission: Bash"));
        eventually("the waiting emit", || {
            rx.try_iter().any(|e| e["sessions"][&id]["state"]["kind"] == "waiting")
        });
        eventually("the waiting toast", || !recorder.sent.lock().unwrap().is_empty());
        assert_eq!(recorder.sent.lock().unwrap()[0].0, "ide — waiting");

        // A pasted line does not answer it; a single "1" does (no Enter: the fixture keeps
        // waiting for its line).
        call("term_write", json!({ "id": term_id, "data": "pasted 1" })).expect("term_write");
        assert_eq!(live(&id).state, SessionState::Waiting);
        call("term_write", json!({ "id": term_id, "data": "1" })).expect("term_write");
        assert_eq!((live(&id).state, live(&id).source), (SessionState::Busy, StateSource::Hook));

        // The ~6 s permission Notification for the prompt just answered: ignored (late notice).
        assert_eq!(
            post("Notification", json!({ "session_id": id, "notification_type": "permission_prompt", "message": "Claude needs your permission" })).0,
            200
        );
        eventually("the notification counted", || state.hooks.diagnostics(0).hook_events == 3);
        std::thread::sleep(std::time::Duration::from_millis(50));
        assert_eq!(live(&id).state, SessionState::Busy);
        // The turn ends.
        assert_eq!(post("Stop", json!({ "session_id": id, "last_assistant_message": "Done.\nDetails…" })).0, 200);
        becomes("finished", SessionState::Finished);
        assert_eq!(live(&id).last_line.as_deref(), Some("Done."));
        eventually("the finished toast", || recorder.sent.lock().unwrap().len() == 2);

        // A new prompt, then a turn that fails.
        assert_eq!(post("UserPromptSubmit", json!({ "session_id": id })).0, 200);
        becomes("busy again", SessionState::Busy);
        assert_eq!(post("StopFailure", json!({ "session_id": id, "error": "rate_limit" })).0, 200);
        becomes("finished (failed)", SessionState::Finished);
        assert_eq!(live(&id).last_line.as_deref(), Some("turn failed"));

        // A bad token changes nothing.
        assert_eq!(http(port, "POST", "/hooks/UserPromptSubmit", Some("nope"), b"{}").0, 401);
        std::thread::sleep(std::time::Duration::from_millis(50));
        assert_eq!(live(&id).state, SessionState::Finished);

        // Let the fixture print and exit: the port was in its env; the token is dropped.
        state.terms.write(&term_id, b"\r").unwrap();
        let output = || super::pty::tests::strip_escapes(&state.terms.buffer(&term_id).unwrap().data);
        wait_until(&app, &term_id, "the fixture's output", || output().contains(&format!("port={port}")));
        wait_until(&app, &term_id, "the exit", || live(&id).state == SessionState::Exited);
        assert!(!state.hooks.has_token(&id));
        assert!(!state.read_sessions_live().hooked.contains_key(&id));
        assert_eq!(post("UserPromptSubmit", json!({})).0, 401);
        assert_eq!(live(&id).state, SessionState::Exited);

        let diagnostics = call("diagnostics_get", json!({})).expect("diagnostics_get");
        assert_eq!(diagnostics["endpoint"], format!("127.0.0.1:{port}"));
        assert_eq!(diagnostics["endpoint_error"], serde_json::Value::Null);
        assert_eq!(diagnostics["hook_events"], 6);
        assert_eq!(diagnostics["refused"], 2);
        assert_eq!(diagnostics["session_mismatches"], 0);
        assert_eq!(diagnostics["poll_overrides"], 0);
        server.abort();
        super::on_run_event(app.handle(), &tauri::RunEvent::Exit);
    }

    /// Story 7.1: with the endpoint up, a launch writes `<id>.mcp.json` beside its settings file
    /// and passes `--mcp-config`; `/mcp` answers `my_node` on the session's token, refuses a bad
    /// one into the diagnostics, and refuses the token once the session exits (the file goes).
    /// The fixture program stands in for `claude`.
    #[test]
    fn a_launched_session_reaches_the_mcp_endpoint_on_its_token_until_it_exits() {
        use super::claude::hooks::{self, tests::http};
        use super::claude::live::SessionState;
        use serde_json::json;
        let (app, webview, _dir, folder, sessions) = launch_fixture();
        let state = app.state::<super::AppState>();
        let server = hooks::start_on(app.handle(), hooks::bind()).expect("the endpoint starts");
        let port = state.hooks.port().expect("up");
        let call = |cmd: &str, args: serde_json::Value| -> Result<serde_json::Value, serde_json::Value> {
            invoke_with(&webview, cmd, InvokeBody::Json(args)).map(|body| body.deserialize().unwrap())
        };
        let extra = tempfile::tempdir().unwrap();
        let prefill = call("launch_defaults", json!({ "projectId": "ide" })).unwrap();
        let request = json!({
            "projectId": "ide", "sessionId": prefill["sessionId"], "name": prefill["name"],
            "addDirs": [extra.path().display().to_string()]
        });
        let reply = call("session_launch", json!({ "request": request, "cols": 1000, "rows": 30 })).expect("session_launch");
        let id = reply["session_id"].as_str().unwrap().to_string();
        let term_id = format!("session:{id}");

        // The token is in the settings file; the MCP config carries the same one.
        let settings_file = sessions.join(format!("{id}.settings.json"));
        let mcp_file = sessions.join(format!("{id}.mcp.json"));
        let settings: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&settings_file).unwrap()).unwrap();
        let auth = settings["hooks"]["Stop"][0]["hooks"][0]["headers"]["Authorization"].as_str().unwrap().to_string();
        let token = auth.strip_prefix("Bearer ").unwrap().to_string();
        let config: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&mcp_file).unwrap()).unwrap();
        assert_eq!(config, super::mcp::config_json(port, &token));
        assert_eq!(settings["permissions"]["allow"], json!(super::mcp::allowed_tools()));

        let rpc = |token: Option<&str>, body: serde_json::Value| http(port, "POST", "/mcp", token, body.to_string().as_bytes());
        let (status, body) = rpc(Some(&token), json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": { "protocolVersion": "2025-06-18" } }));
        assert_eq!(status, 200);
        assert_eq!(serde_json::from_str::<serde_json::Value>(&body).unwrap()["result"]["serverInfo"]["name"], "switchboard");
        let my_node = |token: &str| rpc(Some(token), json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": { "name": "my_node", "arguments": {} } }));
        let (status, body) = my_node(&token);
        assert_eq!(status, 200);
        let reply: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert_eq!(reply["result"]["isError"], false);
        let me: serde_json::Value = serde_json::from_str(reply["result"]["content"][0]["text"].as_str().unwrap()).unwrap();
        let project_path = dunce::canonicalize(folder.path()).unwrap().display().to_string();
        let extra_dir = dunce::canonicalize(extra.path()).unwrap().display().to_string();
        assert_eq!(me["nodeId"], id.as_str());
        assert_eq!(me["name"], prefill["name"]);
        assert_eq!(me["project"], json!({ "id": "ide", "label": "ide", "path": project_path }));
        assert_eq!(me["cwd"], project_path.as_str());
        assert_eq!(me["worktree"], serde_json::Value::Null);
        assert_eq!(me["peers"], json!([]));
        assert_eq!(me["addDirs"], json!([{ "path": extra_dir, "via": "sheet" }]));

        // A wrong token: 401, counted, the ring names the reason and never the token.
        assert_eq!(my_node("nope"), (401, String::new()));
        let diagnostics = call("diagnostics_get", json!({})).expect("diagnostics_get");
        assert_eq!(diagnostics["mcp_refused"], 1);
        assert_eq!(diagnostics["mcp_refusals"][0]["reason"], "unknown token");
        assert_eq!(diagnostics["mcp_refusals"][0]["path"], "/mcp");
        assert!(!diagnostics.to_string().contains(&token));

        // Let the fixture print its argv and exit.
        state.terms.write(&term_id, b"\r").unwrap();
        let output = || super::pty::tests::strip_escapes(&state.terms.buffer(&term_id).unwrap().data);
        wait_until(&app, &term_id, "the exit", || state.read_sessions_live().sessions[&id].state == SessionState::Exited);
        wait_until(&app, &term_id, "the files to go", || !settings_file.exists() && !mcp_file.exists());
        let text = output();
        let (settings_arg, mcp_arg) = (settings_file.display().to_string(), mcp_file.display().to_string());
        if cfg!(windows) {
            let flat = text.replace(['\r', '\n'], "");
            let part = format!("--settings {settings_arg} --mcp-config {mcp_arg} --append-system-prompt");
            assert!(flat.contains(&part), "{part:?} missing from {flat:?}");
        } else {
            let part = ["--settings", &settings_arg, "--mcp-config", &mcp_arg, "--append-system-prompt"].map(|a| format!("[{a}]")).join("\r\n");
            assert!(text.contains(&part), "argv not as built:\n{text}");
        }
        assert!(!text.contains("--strict-mcp-config"));

        // The token died with the session: refused as unknown; the add-dirs record is gone.
        assert_eq!(my_node(&token).0, 401);
        assert!(state.launcher.add_dirs_of(&id).is_empty());
        let diagnostics = call("diagnostics_get", json!({})).expect("diagnostics_get");
        assert_eq!(diagnostics["mcp_refused"], 2);
        assert_eq!(diagnostics["mcp_refusals"][0]["reason"], "unknown token");
        server.abort();
        super::on_run_event(app.handle(), &tauri::RunEvent::Exit);
    }

    /// Story 7.2: session A (the fixture program, never `claude`) calls `start_session` over
    /// `/mcp`. The toast's request carries the exact argv; Deny is a readable error; Allow starts the
    /// session in `ui` with exactly that argv, a cooperate edge A ↔ new stored before its prompt
    /// was built (the prompt names A), and returns `{nodeId, name}`. With an edge A → ui, Always is
    /// offered; once chosen the next start runs without a toast (a notice says so) until Revoke.
    /// `set_status` never asks; a branch without a worktree and `bypassPermissions` are refused with
    /// no toast; A's exit drops its pending request.
    #[test]
    fn start_session_waits_for_the_operator_and_runs_the_argv_it_showed() {
        use super::claude::hooks::{self, tests::http};
        use serde_json::json;
        use tauri::Listener;
        let (app, webview, _dir, _folder, _sessions) = launch_fixture();
        let state = app.state::<super::AppState>();
        let server = hooks::start_on(app.handle(), hooks::bind()).expect("the endpoint starts");
        let port = state.hooks.port().unwrap();
        state.approvals.set_timeout(std::time::Duration::from_secs(30));
        let call = |cmd: &str, args: serde_json::Value| -> Result<serde_json::Value, serde_json::Value> {
            invoke_with(&webview, cmd, InvokeBody::Json(args)).map(|body| body.deserialize().unwrap())
        };
        let ui_folder = tempfile::tempdir().unwrap();
        let ui_path = dunce::canonicalize(ui_folder.path()).unwrap().display().to_string();
        state.write_workspace().workspace.projects.push(super::graph::Project {
            id: "ui".into(),
            path: ui_path.clone(),
            label: "ui".into(),
            ..super::graph::Project::default()
        });
        let toasts = std::sync::Arc::new(std::sync::Mutex::new(0usize));
        let notices = std::sync::Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
        {
            let toasts = toasts.clone();
            app.listen_any(super::approvals::EVENT, move |event| {
                let list: serde_json::Value = serde_json::from_str(event.payload()).unwrap();
                if !list.as_array().unwrap().is_empty() {
                    *toasts.lock().unwrap() += 1;
                }
            });
            let notices = notices.clone();
            app.listen_any(super::approvals::NOTICE_EVENT, move |event| {
                notices.lock().unwrap().push(serde_json::from_str(event.payload()).unwrap());
            });
        }

        // Session A on `ide`.
        let prefill = call("launch_defaults", json!({ "projectId": "ide" })).unwrap();
        let request = json!({ "projectId": "ide", "sessionId": prefill["sessionId"], "name": prefill["name"] });
        let a = call("session_launch", json!({ "request": request, "cols": 1000, "rows": 30 })).unwrap()["session_id"].as_str().unwrap().to_string();
        let a_name = prefill["name"].as_str().unwrap().to_string();
        let a_term = format!("session:{a}");
        let settings: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(_sessions.join(format!("{a}.settings.json"))).unwrap()).unwrap();
        let token = settings["hooks"]["Stop"][0]["hooks"][0]["headers"]["Authorization"].as_str().unwrap().strip_prefix("Bearer ").unwrap().to_string();
        assert!(!settings["permissions"]["allow"].to_string().contains("start_session"), "act tools are not pre-allowed");
        // One tool call over `/mcp` on A's token: the result's text and whether it is an error.
        let tool = {
            let token = token.clone();
            move |name: &str, args: serde_json::Value| -> (String, bool) {
                let body = json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": { "name": name, "arguments": args } });
                let (status, reply) = http(port, "POST", "/mcp", Some(&token), body.to_string().as_bytes());
                assert_eq!(status, 200, "{reply}");
                let reply: serde_json::Value = serde_json::from_str(&reply).unwrap();
                (reply["result"]["content"][0]["text"].as_str().unwrap().to_string(), reply["result"]["isError"].as_bool().unwrap())
            }
        };
        let on_thread = |name: &'static str, args: serde_json::Value| {
            let tool = tool.clone();
            std::thread::spawn(move || tool(name, args))
        };
        let pending = |count: usize| -> Vec<serde_json::Value> {
            let started = std::time::Instant::now();
            loop {
                let list = call("approvals_get", json!({})).unwrap();
                if list.as_array().unwrap().len() == count {
                    return list.as_array().unwrap().clone();
                }
                assert!(started.elapsed() < std::time::Duration::from_secs(20), "timed out waiting for {count} pending: {list}");
                std::thread::sleep(std::time::Duration::from_millis(20));
            }
        };
        let after = |argv: &[serde_json::Value], flag: &str| -> String {
            let at = argv.iter().position(|a| a == flag).unwrap_or_else(|| panic!("{flag} missing"));
            argv[at + 1].as_str().unwrap().to_string()
        };

        // Deny: a readable error, nothing started.
        let asking = on_thread("start_session", json!({ "project": "ui", "prompt": "hello" }));
        let request = pending(1).remove(0);
        assert_eq!((request["caller"].as_str(), request["callerName"].as_str()), (Some(a.as_str()), Some(a_name.as_str())));
        assert_eq!((request["tool"].as_str(), request["action"].as_str()), (Some("start_session"), Some("start a session on ui")));
        assert_eq!(request["always"], false, "no edge joins A and ui");
        call("approval_answer", json!({ "id": request["id"], "answer": "deny" })).unwrap();
        assert_eq!(asking.join().unwrap(), ("the operator denied: start a session on ui".to_string(), true));
        assert_eq!(state.terms.list().len(), 1, "nothing started");

        // Allow, cooperating: the argv shown is the argv run.
        let asking = on_thread("start_session", json!({ "project": "ui", "prompt": "hello", "cooperateWithMe": true }));
        let request = pending(1).remove(0);
        let argv = request["argv"].as_array().unwrap().clone();
        let program = state.launcher.program.lock().unwrap().clone().unwrap();
        assert_eq!(argv[0], program.0.display().to_string());
        let strings: Vec<String> = argv.iter().map(|a| a.as_str().unwrap().to_string()).collect();
        assert_eq!(request["detail"], super::approvals::argv_line(&strings));
        let (new_id, new_name) = (after(&argv, "--session-id"), after(&argv, "--name"));
        assert!(new_name.starts_with("ui-") && new_name.len() == 7, "{new_name}");
        let mcp_file = _sessions.join(format!("{new_id}.mcp.json")).display().to_string();
        assert_eq!(after(&argv, "--mcp-config"), mcp_file);
        assert_eq!(argv.last().unwrap(), "hello", "the prompt last");
        let prompt = after(&argv, "--append-system-prompt");
        assert!(prompt.contains(super::claude::launch::PEERS_HEADING) && prompt.contains(&format!("\"{a_name}\"")), "{prompt}");
        assert!(!strings.iter().any(|a| a.contains("bypassPermissions") || a == "--dangerously-skip-permissions"));
        call("approval_answer", json!({ "id": request["id"], "answer": "allow" })).unwrap();
        let (text, error) = asking.join().unwrap();
        assert!(!error, "{text}");
        assert_eq!(serde_json::from_str::<serde_json::Value>(&text).unwrap(), json!({ "nodeId": new_id, "name": new_name }));
        let new_term = format!("session:{new_id}");
        let info = state.terms.get(&new_term).expect("the new session runs").info();
        assert_eq!((info.project_id.as_str(), info.cwd.as_str()), ("ui", ui_path.as_str()));
        let joined = |x: &str, y: &str| {
            state.read_workspace().workspace.edges.iter().any(|e| {
                e.kind == super::graph::EdgeKind::Cooperate && ((e.from.id == x && e.to.id == y) || (e.from.id == y && e.to.id == x))
            })
        };
        assert!(joined(&a, &new_id), "a cooperate edge A <-> new");
        state.terms.write(&new_term, b"\r").unwrap();
        let output = || super::pty::tests::strip_escapes(&state.terms.buffer(&new_term).unwrap().data);
        // (cmd's `echo` stops at the system prompt's first newline; the rest of the argv is checked above.)
        wait_until(&app, &new_term, "the new session's argv", || output().contains(&format!("node={new_id}")) && output().contains("--append-system-prompt"));
        let printed = output();
        if cfg!(windows) {
            let flat = printed.replace(['\r', '\n'], "");
            for part in [format!("--name {new_name}"), format!("--mcp-config {mcp_file}"), format!("--session-id {new_id}")] {
                assert!(flat.contains(&part), "{part:?} missing from {flat:?}");
            }
        } else {
            for part in [format!("[--name]\r\n[{new_name}]"), format!("[--mcp-config]\r\n[{mcp_file}]"), format!("[--session-id]\r\n[{new_id}]")] {
                assert!(printed.contains(&part), "{part:?} missing from {printed}");
            }
        }
        assert!(notices.lock().unwrap().is_empty(), "asked: no notice");

        // An edge A -> ui: Always is offered; chosen, the next start runs without a toast.
        let edge_id = "a-ui".to_string();
        state.write_workspace().workspace.edges.push(super::graph::Edge {
            id: edge_id.clone(),
            from: super::graph::NodeRef { kind: super::graph::NodeType::Session, id: a.clone() },
            to: super::graph::NodeRef { kind: super::graph::NodeType::Project, id: "ui".into() },
            kind: super::graph::EdgeKind::Context,
            ..super::graph::Edge::default()
        });
        let asking = on_thread("start_session", json!({ "project": "ui" }));
        let request = pending(1).remove(0);
        assert_eq!(request["always"], true);
        call("approval_answer", json!({ "id": request["id"], "answer": "always" })).unwrap();
        assert!(!asking.join().unwrap().1);
        let allowed = || state.read_workspace().workspace.edges.iter().find(|e| e.id == edge_id).map(|e| e.agent_allowed);
        assert_eq!(allowed(), Some(true));
        let snapshot = call("workspace_get", json!({})).unwrap();
        let stored = snapshot["workspace"]["edges"].as_array().unwrap().iter().find(|e| e["id"] == edge_id.as_str()).unwrap().clone();
        assert_eq!(stored["agentAllowed"], true);
        let toasts_before = *toasts.lock().unwrap();
        let (text, error) = tool("start_session", json!({ "project": "ui", "name": "helper" }));
        assert!(!error, "{text}");
        assert_eq!(*toasts.lock().unwrap(), toasts_before, "no toast");
        assert_eq!(*notices.lock().unwrap(), [format!("{a_name} started helper on ui")]);
        // Revoke: asks again.
        call("edge_set_agent_allowed", json!({ "id": edge_id, "allowed": false })).unwrap();
        assert_eq!(allowed(), Some(false));
        let asking = on_thread("start_session", json!({ "project": "ui" }));
        let request = pending(1).remove(0);
        call("approval_answer", json!({ "id": request["id"], "answer": "deny" })).unwrap();
        assert!(asking.join().unwrap().1);

        // set_status: no toast, on the card until the state changes.
        let toasts_before = *toasts.lock().unwrap();
        let (text, error) = tool("set_status", json!({ "text": "waiting on ui's endpoint" }));
        assert!(!error, "{text}");
        assert_eq!(state.read_sessions_live().sessions[&a].status_text.as_deref(), Some("waiting on ui's endpoint"));
        assert_eq!(*toasts.lock().unwrap(), toasts_before);

        // Refused before any toast: a branch without a worktree, bypassPermissions.
        state.write_workspace().branches.insert(
            "ide".into(),
            vec![super::git::BranchInfo {
                name: "old".into(),
                head: false,
                upstream: None,
                ahead: 0,
                behind: 0,
                gone: false,
                committed_at: 0,
                worktree: None,
            }],
        );
        assert_eq!(tool("start_session", json!({ "branch": "ide:old" })), (super::claude::launch::NO_WORKTREE.to_string(), true));
        assert_eq!(
            tool("start_session", json!({ "project": "ui", "permissionMode": "bypassPermissions" })),
            (super::claude::launch::BYPASS_REFUSED.to_string(), true)
        );
        assert_eq!(*toasts.lock().unwrap(), toasts_before, "no toast for a refusal");

        // The launch changed while the toast waited (A was renamed, so its peer line would differ):
        // nothing starts, and the cooperate edge and the new session's ref are taken back.
        let asking = on_thread("start_session", json!({ "project": "ui", "cooperateWithMe": true }));
        let request = pending(1).remove(0);
        let changed_id = after(request["argv"].as_array().unwrap(), "--session-id");
        state.write_sessions_live().sessions.get_mut(&a).unwrap().name = Some("renamed".into());
        call("approval_answer", json!({ "id": request["id"], "answer": "allow" })).unwrap();
        assert_eq!(asking.join().unwrap(), (super::ipc::LAUNCH_CHANGED.to_string(), true));
        assert!(!joined(&a, &changed_id), "the edge was taken back");
        assert!(state.read_workspace().workspace.sessions.iter().all(|s| s.session_id != changed_id), "the ref was taken back");
        assert!(state.terms.get(&format!("session:{changed_id}")).is_none());
        state.write_sessions_live().sessions.get_mut(&a).unwrap().name = Some(a_name.clone());

        // A branch with a worktree, with a model and an add-dir: runs in the worktree with those
        // flags; an edge from A to the branch node offers Always.
        let worktree = tempfile::tempdir().unwrap();
        let worktree_path = dunce::canonicalize(worktree.path()).unwrap().display().to_string();
        let extra = tempfile::tempdir().unwrap();
        let extra_path = dunce::canonicalize(extra.path()).unwrap().display().to_string();
        state.write_workspace().branches.insert(
            "ui".into(),
            vec![super::git::BranchInfo {
                name: "feat".into(),
                head: false,
                upstream: None,
                ahead: 0,
                behind: 0,
                gone: false,
                committed_at: 0,
                worktree: Some(super::git::WorktreeChip { path: worktree_path.clone(), missing: false }),
            }],
        );
        state.write_workspace().workspace.edges.push(super::graph::Edge {
            id: "a-feat".into(),
            from: super::graph::NodeRef { kind: super::graph::NodeType::Session, id: a.clone() },
            to: super::graph::NodeRef { kind: super::graph::NodeType::Branch, id: "ui:feat".into() },
            kind: super::graph::EdgeKind::Context,
            ..super::graph::Edge::default()
        });
        let asking = on_thread("start_session", json!({ "branch": "ui:feat", "model": "opus", "addDirs": [extra_path.clone()] }));
        let request = pending(1).remove(0);
        assert_eq!(request["action"], "start a session on ui:feat");
        assert_eq!((request["always"].clone(), request["target"].clone()), (json!(true), json!("ui:feat")));
        let argv = request["argv"].as_array().unwrap().clone();
        assert_eq!(after(&argv, "--model"), "opus");
        assert_eq!(after(&argv, "--add-dir"), extra_path);
        call("approval_answer", json!({ "id": request["id"], "answer": "allow" })).unwrap();
        let (text, error) = asking.join().unwrap();
        assert!(!error, "{text}");
        let branch_id = serde_json::from_str::<serde_json::Value>(&text).unwrap()["nodeId"].as_str().unwrap().to_string();
        let info = state.terms.get(&format!("session:{branch_id}")).unwrap().info();
        assert_eq!(info.cwd, worktree_path, "runs in the branch's worktree");

        // Allow all: no toast, a notice.
        call("workspace_set_agent_actions", json!({ "mode": "allowAll" })).unwrap();
        let toasts_before = *toasts.lock().unwrap();
        let (text, error) = tool("start_session", json!({ "project": "ui", "name": "quiet" }));
        assert!(!error, "{text}");
        assert_eq!(*toasts.lock().unwrap(), toasts_before, "no toast under allow all");
        assert_eq!(notices.lock().unwrap().last().unwrap(), &format!("{a_name} started quiet on ui"));
        call("workspace_set_agent_actions", json!({ "mode": "ask" })).unwrap();

        // The client goes away while its request waits: the request is withdrawn, the toast goes,
        // and a late answer finds nothing.
        {
            use std::io::Write;
            let body = json!({ "jsonrpc": "2.0", "id": 9, "method": "tools/call", "params": { "name": "start_session", "arguments": { "project": "ui" } } }).to_string();
            let mut stream = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
            let head = format!(
                "POST /mcp HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer {token}\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n",
                body.len()
            );
            stream.write_all(head.as_bytes()).unwrap();
            stream.write_all(body.as_bytes()).unwrap();
            let request = pending(1).remove(0);
            drop(stream);
            pending(0);
            assert_eq!(call("approval_answer", json!({ "id": request["id"], "answer": "allow" })), Err(json!(super::approvals::NOT_PENDING)));
        }

        // A exits with a request pending: the toast goes.
        let asking = on_thread("start_session", json!({ "project": "ui" }));
        pending(1);
        state.terms.write(&a_term, b"\r").unwrap();
        wait_until(&app, &a_term, "A's exit", || state.approvals.list().is_empty());
        let (text, error) = asking.join().unwrap();
        assert!(error && text == super::approvals::CALLER_EXITED, "{text}");
        server.abort();
        super::on_run_event(app.handle(), &tauri::RunEvent::Exit);
    }

    /// Story 7.1: a Resume with the endpoint up and an `<id>.mcp.json` left by an earlier run (a
    /// crash) starts, writes a fresh config on its new token and passes it after `--settings`.
    #[test]
    fn a_resume_replaces_a_leftover_mcp_config() {
        use super::claude::hooks;
        use serde_json::json;
        let (app, webview, _dir, folder, sessions) = launch_fixture();
        let state = app.state::<super::AppState>();
        let server = hooks::start_on(app.handle(), hooks::bind()).expect("up");
        let port = state.hooks.port().unwrap();
        *state.launcher.program.lock().unwrap() = Some(echo_program());
        let orig = "7b3e1e3f-5b7d-4e8f-9a0b-1c2d3e4f5a6b";
        let ide = dunce::canonicalize(folder.path()).unwrap().display().to_string();
        discover(&app, orig, "ide-7b3e", &ide);
        std::fs::create_dir_all(&sessions).unwrap();
        let (settings_file, mcp_file) = (sessions.join(format!("{orig}.settings.json")), sessions.join(format!("{orig}.mcp.json")));
        std::fs::write(&settings_file, "stale").unwrap();
        std::fs::write(&mcp_file, "stale").unwrap();
        invoke_with(&webview, "session_resume", InvokeBody::Json(json!({ "projectId": "ide", "sessionId": orig, "cols": 1000, "rows": 40 })))
            .expect("session_resume");
        let settings: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&settings_file).unwrap()).unwrap();
        let token = settings["hooks"]["Stop"][0]["hooks"][0]["headers"]["Authorization"].as_str().unwrap().strip_prefix("Bearer ").unwrap().to_string();
        let config: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&mcp_file).unwrap()).unwrap();
        assert_eq!(config, super::mcp::config_json(port, &token));
        let term_id = format!("session:{orig}");
        state.terms.write(&term_id, b"go\r").unwrap();
        let output = || super::pty::tests::strip_escapes(&state.terms.buffer(&term_id).unwrap().data);
        wait_until(&app, &term_id, "the resume's exit", || !mcp_file.exists() && output().contains("got=go"));
        let text = output();
        let (s, m) = (settings_file.display().to_string(), mcp_file.display().to_string());
        if cfg!(windows) {
            let flat = text.replace(['\r', '\n'], "");
            assert!(flat.contains(&format!("--settings {s} --mcp-config {m}")), "{flat}");
        } else {
            assert!(text.contains(&format!("[--settings]\r\n[{s}]\r\n[--mcp-config]\r\n[{m}]")), "{text}");
        }
        server.abort();
        super::on_run_event(app.handle(), &tauri::RunEvent::Exit);
    }

    /// With the endpoint up, a launch that fails after its token was issued (the settings file
    /// cannot be written, or the program cannot start) leaves no token and no hooked mark.
    #[test]
    fn a_failed_launch_with_the_endpoint_up_leaves_no_token() {
        use serde_json::json;
        let (app, webview, dir, _folder, sessions) = launch_fixture();
        let state = app.state::<super::AppState>();
        let server = super::claude::hooks::start_on(app.handle(), super::claude::hooks::bind()).expect("up");
        let call = |cmd: &str, args: serde_json::Value| -> Result<serde_json::Value, serde_json::Value> {
            invoke_with(&webview, cmd, InvokeBody::Json(args)).map(|body| body.deserialize().unwrap())
        };
        let prefill = call("launch_defaults", json!({ "projectId": "ide" })).unwrap();
        let request = json!({ "projectId": "ide", "sessionId": prefill["sessionId"], "name": prefill["name"] });
        let id = prefill["sessionId"].as_str().unwrap().to_string();

        // The settings file is already there (planted): refused.
        std::fs::create_dir_all(&sessions).unwrap();
        let planted = sessions.join(format!("{id}.settings.json"));
        std::fs::write(&planted, "planted").unwrap();
        let err = call("session_launch", json!({ "request": request })).expect_err("the file exists");
        assert!(err.as_str().unwrap().starts_with("could not write session settings"), "{err}");
        assert_eq!(state.hooks.token_count(), 0);
        assert!(state.read_sessions_live().hooked.is_empty());
        std::fs::remove_file(&planted).unwrap();

        // Story 7.1: the MCP config is already there (planted): refused; the settings file this
        // launch wrote goes, the planted config stays.
        let planted = sessions.join(format!("{id}.mcp.json"));
        std::fs::write(&planted, "planted").unwrap();
        let err = call("session_launch", json!({ "request": request })).expect_err("the config exists");
        assert!(err.as_str().unwrap().starts_with("could not write session MCP config"), "{err}");
        assert_eq!(state.hooks.token_count(), 0);
        assert!(!sessions.join(format!("{id}.settings.json")).exists());
        assert_eq!(std::fs::read_to_string(&planted).unwrap(), "planted");
        assert!(state.launcher.add_dirs_of(&id).is_empty());
        assert!(state.terms.list().is_empty());
        std::fs::remove_file(&planted).unwrap();

        // The program cannot start: refused (the id was given back, so the same sheet retries).
        *state.launcher.program.lock().unwrap() = Some((dir.path().join("no-claude.exe"), Vec::new()));
        call("session_launch", json!({ "request": request })).expect_err("spawn fails");
        assert_eq!(state.hooks.token_count(), 0);
        assert!(state.read_sessions_live().hooked.is_empty());
        assert!(state.terms.list().is_empty());
        server.abort();
    }

    #[test]
    fn a_failed_bind_leaves_launches_without_hooks_and_raises_the_banner() {
        use serde_json::json;
        let (app, webview, ..) = app_with_ide();
        let state = app.state::<super::AppState>();
        // A session that was hooked while the endpoint was up (the serve task failing later
        // takes the same path).
        state.hooks.register("s1");
        state.write_sessions_live().hooked.insert("s1".into(), 0);
        assert!(super::claude::hooks::start_on(app.handle(), Err(std::io::Error::other("address in use"))).is_none());
        assert_eq!(state.hooks.token_count(), 0, "every token dropped");
        assert!(state.read_sessions_live().hooked.is_empty(), "back on the poll's 3.3 rules");
        assert_eq!(state.hooks.port(), None, "no port: the settings file is `{{}}` and no SWITCHBOARD_PORT");
        let banners = state.read().snapshot().banners;
        assert_eq!(banners.len(), 1);
        assert_eq!(banners[0].id, super::claude::hooks::BANNER_ID);
        assert_eq!(banners[0].text, "hooks endpoint unavailable: address in use");
        let diagnostics: serde_json::Value = invoke_with(&webview, "diagnostics_get", InvokeBody::Json(json!({}))).unwrap().deserialize().unwrap();
        assert_eq!(diagnostics["endpoint"], serde_json::Value::Null);
        assert_eq!(diagnostics["endpoint_error"], "address in use");
    }

    /// A discovered transcript for session `id` under `ide`, titled `title`, recorded in `cwd`.
    fn discover(app: &tauri::App<tauri::test::MockRuntime>, id: &str, title: &str, cwd: &str) {
        let summary = super::claude::SessionSummary {
            id: id.into(),
            title: title.into(),
            started_at: "2026-10-18T10:00:00.000Z".into(),
            last_active: "2026-10-18T10:05:00.000Z".into(),
            branch: None,
            messages: 4,
            cwd: Some(cwd.into()),
        };
        super::graph::set_discovered(app.handle(), std::collections::HashMap::from([("ide".to_string(), vec![summary])]));
    }

    /// The program Resume / Fork run in these tests (never `claude`): waits for one line, then
    /// prints `node=<SWITCHBOARD_NODE> got=<the line>`, its working folder, and its argv.
    fn echo_program() -> (std::path::PathBuf, Vec<String>) {
        #[cfg(windows)]
        let program = (
            std::path::PathBuf::from("cmd.exe"),
            ["/d", "/v:on", "/c", "set", "/p", "x=", "&", "echo", "node=!SWITCHBOARD_NODE!", "got=!x!", "&", "cd", "&", "echo"]
                .map(String::from)
                .to_vec(),
        );
        #[cfg(not(windows))]
        let program = (
            std::path::PathBuf::from("/bin/sh"),
            ["-c", "read x; printf 'node=%s got=%s\\n' \"$SWITCHBOARD_NODE\" \"$x\"; pwd; printf '[%s]\\n' \"$@\"", "sh"]
                .map(String::from)
                .to_vec(),
        );
        program
    }

    /// A program that ignores Ctrl+C and typed input and runs for a minute (Stop must kill it).
    fn stubborn_program(dir: &std::path::Path) -> (std::path::PathBuf, Vec<String>) {
        #[cfg(windows)]
        {
            let script = dir.join("stubborn.ps1");
            // The marker is printed only once Ctrl+C is ignored; the test waits for it (on a
            // loaded runner PowerShell can take well over a second to get this far).
            std::fs::write(&script, "[Console]::TreatControlCAsInput = $true\r\nWrite-Output 'stubborn-ready'\r\nStart-Sleep -Seconds 60\r\n").unwrap();
            (
                std::path::PathBuf::from("powershell.exe"),
                ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File"]
                    .map(String::from)
                    .into_iter()
                    .chain([script.display().to_string()])
                    .collect(),
            )
        }
        #[cfg(not(windows))]
        {
            let _ = dir;
            (
                std::path::PathBuf::from("/bin/sh"),
                ["-c", "trap '' INT; echo stubborn-ready; sleep 60", "sh"].map(String::from).to_vec(),
            )
        }
    }

    /// Story 4.4: Resume runs `--resume <id>` in the transcript's folder with the standard app
    /// flags, under the same node and terminal id; while it runs it is not resumed again; Stop
    /// on the `starting` session types `/exit` + Enter, which ends it; a second resume reuses
    /// the exited terminal's id. Fork runs `--resume <id> --fork-session --session-id <new>
    /// --name <original>-fork-<4 hex>` as a new node with `forkedFrom` recorded.
    #[test]
    fn resume_fork_and_an_idle_stop_run_their_recipes() {
        use super::claude::live::SessionState;
        use serde_json::json;
        let (app, webview, _dir, folder, sessions) = launch_fixture();
        let state = app.state::<super::AppState>();
        *state.launcher.program.lock().unwrap() = Some(echo_program());
        let call = |cmd: &str, args: serde_json::Value| -> Result<serde_json::Value, serde_json::Value> {
            invoke_with(&webview, cmd, InvokeBody::Json(args)).map(|body| body.deserialize().unwrap())
        };
        state.write_workspace().workspace.projects[0].launch_defaults = Some(super::graph::LaunchDefaults {
            model: Some("opus".into()),
            effort: Some("default".into()),
            permission_mode: Some("plan".into()),
        });
        let orig = "59cd1e3f-5b7d-4e8f-9a0b-1c2d3e4f5a6b";
        let recorded = tempfile::tempdir().unwrap();
        let cwd = dunce::canonicalize(recorded.path()).unwrap().display().to_string();
        assert_eq!(call("session_resume", json!({ "projectId": "ide", "sessionId": orig })), Err(json!(super::ipc::NO_TRANSCRIPT)));
        discover(&app, orig, "ide-59cd", &cwd);
        assert_eq!(
            call("session_resume", json!({ "projectId": "gone", "sessionId": orig })),
            Err(json!("unknown project")),
            "the card's project is gone"
        );

        // Resume: the same node, in the transcript's folder.
        let reply = call("session_resume", json!({ "projectId": "ide", "sessionId": orig, "cols": 1000, "rows": 40 })).expect("session_resume");
        assert_eq!(reply["session_id"], orig);
        let term_id = format!("session:{orig}");
        assert_eq!(reply["term"]["id"], term_id.as_str());
        assert_eq!(reply["term"]["cwd"], cwd.as_str());
        assert_eq!(reply["term"]["title"], "ide-59cd");
        assert_eq!(reply["term"]["stopping"], false);
        assert_eq!(state.read_sessions_live().sessions[orig].state, SessionState::Starting);
        assert_eq!(state.read_sessions_live().sessions[orig].project_id.as_deref(), Some("ide"));
        assert_eq!(call("session_resume", json!({ "projectId": "ide", "sessionId": orig })), Err(json!(super::ipc::SESSION_RUNNING)));
        let settings_file = sessions.join(format!("{orig}.settings.json"));
        assert!(settings_file.exists());

        state.terms.write(&term_id, b"go\r").unwrap();
        let output = |id: &str| super::pty::tests::strip_escapes(&state.terms.buffer(id).unwrap().data);
        wait_until(&app, &term_id, "the resumed fixture's exit", || {
            state.read_sessions_live().sessions[orig].state == SessionState::Exited
        });
        assert!(!settings_file.exists(), "deleted before the node shows exited");
        let text = output(&term_id);
        assert!(text.contains(&format!("node={orig} got=go")), "{text}");
        assert!(text.contains(&cwd), "runs in the transcript's folder: {text}");
        let settings_arg = settings_file.display().to_string();
        if cfg!(windows) {
            let flat = text.replace(['\r', '\n'], "");
            let part = format!("--resume {orig} --model opus --permission-mode plan --settings {settings_arg} --append-system-prompt");
            assert!(flat.contains(&part), "{part:?} missing from {flat:?}");
        } else {
            let expected: Vec<String> = ["--resume", orig, "--model", "opus", "--permission-mode", "plan", "--settings", &settings_arg, "--append-system-prompt"]
                .iter()
                .map(|a| format!("[{a}]"))
                .collect();
            assert!(text.contains(&expected.join("\r\n")), "argv not as built:\n{text}");
        }
        assert!(!text.contains("--session-id") && !text.contains("--name") && !text.contains("--effort"), "{text}");

        // A failed resume leaves the exited session exactly as it was: a spawn that fails, and
        // a settings file that cannot be written.
        let before = state.read_sessions_live().clone();
        *state.launcher.program.lock().unwrap() = Some((folder.path().join("no-claude.exe"), Vec::new()));
        call("session_resume", json!({ "projectId": "ide", "sessionId": orig })).expect_err("spawn fails");
        assert_eq!(*state.read_sessions_live(), before, "live state restored after a spawn failure");
        *state.launcher.program.lock().unwrap() = Some(echo_program());
        let blocker = folder.path().join("not-a-folder");
        std::fs::write(&blocker, "x").unwrap();
        state.launcher.set_dir(blocker.clone());
        let err = call("session_resume", json!({ "projectId": "ide", "sessionId": orig })).expect_err("settings write fails");
        assert!(err.as_str().unwrap().starts_with("could not write session settings"), "{err}");
        assert_eq!(*state.read_sessions_live(), before, "live state restored after a settings failure");
        state.launcher.set_dir(sessions.clone());
        assert_eq!(state.terms.get(&term_id).unwrap().info().exited, Some(0), "the old terminal is still there");

        // A stale settings file of this id (an app that crashed) does not block a resume.
        std::fs::write(&settings_file, "stale").unwrap();

        // Resume again: the exited terminal is replaced under the same id. Stop once it is
        // `idle` clears the line (Ctrl+U), types `/exit` + Enter, and the fixture ends on that line.
        let reply = call("session_resume", json!({ "projectId": "ide", "sessionId": orig })).expect("a second resume");
        assert_eq!(reply["term"]["id"], term_id.as_str());
        assert_eq!(reply["term"]["exited"], serde_json::Value::Null);
        assert_eq!(reply["choices"], json!({ "model": "opus", "effort": "default", "permission_mode": "plan" }));
        assert_eq!(std::fs::read_to_string(&settings_file).unwrap(), "{}", "the stale file was replaced");
        assert_eq!(state.terms.list().iter().filter(|t| t.id == term_id).count(), 1);
        assert!(!output(&term_id).contains("got=go"), "a fresh buffer");
        state.write_sessions_live().sessions.get_mut(orig).unwrap().state = SessionState::Idle;
        let stopped_at = std::time::Instant::now();
        let stop = call("session_stop", json!({ "sessionId": orig })).expect("session_stop");
        assert_eq!(stop["stopping"], true);
        wait_until(&app, &term_id, "the stop's exit", || {
            state.read_sessions_live().sessions[orig].state == SessionState::Exited
        });
        assert!(stopped_at.elapsed() < super::claude::launch::STOP_KILL_AFTER, "ended by /exit, not the kill");
        // (On Unix the tty's line discipline drops the Ctrl+U itself; `cmd`'s `set /p` keeps it
        // as a character, so on Windows only the `/exit` that follows is checked.)
        let line = output(&term_id);
        if cfg!(windows) {
            assert!(line.contains("got=") && line.contains("/exit"), "{line}");
        } else {
            assert!(line.contains("got=/exit"), "{line}");
        }
        assert_eq!(state.terms.get(&term_id).unwrap().info().exited, Some(0));
        assert!(!state.terms.get(&term_id).unwrap().info().stopping);
        assert_eq!(call("session_stop", json!({ "sessionId": orig })), Err(json!(super::ipc::NOT_STOPPABLE)));

        // Fork: a new id and node, named after the original, linked to it.
        let reply = call("session_fork", json!({ "projectId": "ide", "sessionId": orig })).expect("session_fork");
        let fork = reply["session_id"].as_str().unwrap().to_string();
        assert_ne!(fork, orig);
        assert_eq!(uuid::Uuid::parse_str(&fork).unwrap().get_version_num(), 4);
        let name = super::claude::launch::fork_name("ide-59cd", &fork);
        assert!(name.starts_with("ide-59cd-fork-") && name.len() == "ide-59cd-fork-".len() + 4, "{name}");
        let fork_term = format!("session:{fork}");
        assert_eq!(reply["term"]["title"], name.as_str());
        assert_eq!(reply["term"]["cwd"], cwd.as_str());
        let snapshot = state.read_workspace().snapshot();
        let child = snapshot.children.iter().find(|c| c.id == fork).expect("a new node");
        assert_eq!(child.forked_from.as_deref(), Some(orig));
        assert!(snapshot.workspace.sessions.iter().any(|s| s.session_id == fork && s.forked_from.as_deref() == Some(orig)));
        state.terms.write(&fork_term, b"go\r").unwrap();
        wait_until(&app, &fork_term, "the fork's exit", || {
            state.read_sessions_live().sessions[&fork].state == SessionState::Exited
        });
        let text = output(&fork_term);
        assert!(text.contains(&format!("node={fork} got=go")), "{text}");
        let fork_settings = sessions.join(format!("{fork}.settings.json")).display().to_string();
        if cfg!(windows) {
            let flat = text.replace(['\r', '\n'], "");
            let part = format!(
                "--resume {orig} --fork-session --session-id {fork} --name {name} --model opus --permission-mode plan --settings {fork_settings} --append-system-prompt"
            );
            assert!(flat.contains(&part), "{part:?} missing from {flat:?}");
        } else {
            let expected: Vec<String> = [
                "--resume",
                orig,
                "--fork-session",
                "--session-id",
                &fork,
                "--name",
                &name,
                "--model",
                "opus",
                "--permission-mode",
                "plan",
                "--settings",
                &fork_settings,
                "--append-system-prompt",
            ]
            .iter()
            .map(|a| format!("[{a}]"))
            .collect();
            assert!(text.contains(&expected.join("\r\n")), "argv not as built:\n{text}");
        }

        // A fork whose spawn fails takes its link back: no ref but the first fork's.
        *state.launcher.program.lock().unwrap() = Some((folder.path().join("no-claude.exe"), Vec::new()));
        call("session_fork", json!({ "projectId": "ide", "sessionId": orig })).expect_err("spawn fails");
        let refs: Vec<String> = state.read_workspace().workspace.sessions.iter().map(|s| s.session_id.clone()).collect();
        assert_eq!(refs, std::slice::from_ref(&fork), "the failed fork left no ref");
        assert!(state.launcher.pending_forks().is_empty());
        *state.launcher.program.lock().unwrap() = Some(echo_program());

        // A session live elsewhere (the poll sees it, no Switchboard terminal): Resume is
        // refused, no terminal is made and its live entry is untouched.
        let elsewhere = "e1sewhe7-5b7d-4e8f-9a0b-1c2d3e4f5a6b";
        let summary = super::claude::SessionSummary {
            id: elsewhere.into(),
            title: "theirs".into(),
            started_at: "2026-10-18T10:00:00.000Z".into(),
            last_active: "2026-10-18T10:05:00.000Z".into(),
            branch: None,
            messages: 2,
            cwd: Some(cwd.clone()),
        };
        let mut found = state.read_workspace().discovered.clone();
        found.get_mut("ide").unwrap().push(summary);
        super::graph::set_discovered(app.handle(), found);
        super::claude::live::apply_and_emit(app.handle(), live_rows(&cwd, elsewhere, "busy"));
        let live_before = state.read_sessions_live().sessions[elsewhere].clone();
        let terms_before = state.terms.list().len();
        assert_eq!(
            call("session_resume", json!({ "projectId": "ide", "sessionId": elsewhere })),
            Err(json!(super::ipc::SESSION_RUNNING))
        );
        assert_eq!(state.terms.list().len(), terms_before);
        assert!(state.terms.get(&format!("session:{elsewhere}")).is_none());
        assert_eq!(state.read_sessions_live().sessions[elsewhere], live_before);

        // Neither folder there: refused, nothing started.
        drop(recorded);
        state.write_workspace().workspace.projects[0].path = folder.path().join("gone").display().to_string();
        let err = call("session_fork", json!({ "projectId": "ide", "sessionId": orig })).expect_err("no folder");
        assert_eq!(err, json!(format!("{}{cwd}", super::claude::launch::FOLDER_NOT_FOUND)));
        super::on_run_event(app.handle(), &tauri::RunEvent::Exit);
    }

    /// The argv a fixture printed contains `--add-dir <path>` for each of `paths` (on Windows
    /// `cmd`'s echo prints the argv on one line; elsewhere one `[arg]` per line).
    fn assert_add_dirs(text: &str, paths: &[&str]) {
        for path in paths {
            if cfg!(windows) {
                let flat = text.replace(['\r', '\n'], "");
                assert!(flat.contains(&format!("--add-dir {path}")), "--add-dir {path} missing from {flat:?}");
            } else {
                assert!(text.contains(&format!("[--add-dir]\r\n[{path}]")), "--add-dir {path} missing from:\n{text}");
            }
        }
    }

    /// Story 6.2: a project's context edges prefill the launch sheet's add-dirs (with the target's
    /// label) and note the unusable ones; the Start passes them as `--add-dir`. Resume and Fork
    /// pass the session's own edges plus its project's, and name the skipped ones.
    #[test]
    fn context_edges_become_add_dirs_on_the_sheet_and_on_resume_and_fork() {
        use super::claude::live::SessionState;
        use super::graph::{Edge, EdgeKind, NodeRef, NodeType, Project};
        use serde_json::json;
        let (app, webview, _dir, folder, _sessions) = launch_fixture();
        let state = app.state::<super::AppState>();
        // The endpoint up, so each launch records its add-dirs for `my_node()` (Story 7.1).
        let server = super::claude::hooks::start_on(app.handle(), super::claude::hooks::bind()).expect("up");
        let recorded = |id: &str| -> Vec<(String, String)> { state.launcher.add_dirs_of(id).into_iter().map(|d| (d.path, d.via)).collect() };
        let call = |cmd: &str, args: serde_json::Value| -> Result<serde_json::Value, serde_json::Value> {
            invoke_with(&webview, cmd, InvokeBody::Json(args)).map(|body| body.deserialize().unwrap())
        };
        let others = tempfile::tempdir().unwrap();
        let mk = |name: &str| {
            let path = others.path().join(name);
            std::fs::create_dir_all(&path).unwrap();
            dunce::canonicalize(&path).unwrap().display().to_string()
        };
        let (ui, docs) = (mk("ui"), mk("docs"));
        let gone = others.path().join("gone").display().to_string();
        let ide = dunce::canonicalize(folder.path()).unwrap().display().to_string();
        let end = |kind: NodeType, id: &str| NodeRef { kind, id: id.into() };
        let context = |from: NodeRef, to: NodeRef| Edge {
            id: uuid::Uuid::new_v4().to_string(),
            from,
            to,
            kind: EdgeKind::Context,
            ..Edge::default()
        };
        {
            let mut ws = state.write_workspace();
            for (id, path) in [("ui", ui.as_str()), ("docs", docs.as_str()), ("lost", gone.as_str())] {
                ws.workspace.projects.push(Project {
                    id: id.into(),
                    path: path.into(),
                    label: id.into(),
                    ..Project::default()
                });
            }
            ws.workspace.edges = vec![
                context(end(NodeType::Project, "ide"), end(NodeType::Project, "ui")),
                context(end(NodeType::Project, "ide"), end(NodeType::Project, "lost")),
            ];
        }

        // The sheet: prefilled with ui (via edge → ui), lost noted; the edge-derived add-dirs
        // are not remembered as launch defaults.
        let prefill = call("launch_defaults", json!({ "projectId": "ide" })).expect("launch_defaults");
        assert_eq!(prefill["addDirs"], json!([{ "path": ui, "via": "ui" }]));
        assert_eq!(prefill["skipped"], json!([{ "label": "lost", "reason": "folder missing" }]));
        let request = json!({
            "projectId": "ide", "sessionId": prefill["sessionId"], "name": prefill["name"],
            "addDirs": [ui], "background": true
        });
        let reply = call("session_launch", json!({ "request": request, "cols": 1000, "rows": 40 })).expect("session_launch");
        assert_eq!(reply["skipped"], json!([]));
        let id = reply["session_id"].as_str().unwrap().to_string();
        let term_id = format!("session:{id}");
        assert_eq!(recorded(&id), [(ui.clone(), "edge → ui".to_string())]);
        state.terms.write(&term_id, b"go\r").unwrap();
        let output = |term: &str| super::pty::tests::strip_escapes(&state.terms.buffer(term).unwrap().data);
        wait_until(&app, &term_id, "the launch's exit", || {
            state.read_sessions_live().sessions[&id].state == SessionState::Exited
        });
        assert_add_dirs(&output(&term_id), &[&ui]);
        let remembered = serde_json::to_value(state.read_workspace().workspace.projects[0].launch_defaults.clone()).unwrap();
        assert!(remembered.get("addDirs").is_none(), "{remembered}");

        // Resume: the session's own edge (docs) plus its project's (ui); one to its own folder
        // is dropped; the unusable one is named.
        *state.launcher.program.lock().unwrap() = Some(echo_program());
        let orig = "6a2e1e3f-5b7d-4e8f-9a0b-1c2d3e4f5a6b";
        discover(&app, orig, "ide-6a2e", &ide);
        state.write_workspace().workspace.edges.extend([
            context(end(NodeType::Session, orig), end(NodeType::Project, "docs")),
            context(end(NodeType::Session, orig), end(NodeType::Project, "ide")),
        ]);
        let reply = call("session_resume", json!({ "projectId": "ide", "sessionId": orig, "cols": 1000, "rows": 40 })).expect("session_resume");
        assert_eq!(reply["skipped"], json!([{ "label": "lost", "reason": "folder missing" }]));
        let term_id = format!("session:{orig}");
        let edge_dirs = [(docs.clone(), "edge → docs".to_string()), (ui.clone(), "edge → ui".to_string())];
        assert_eq!(recorded(orig), edge_dirs);
        state.terms.write(&term_id, b"go\r").unwrap();
        wait_until(&app, &term_id, "the resume's exit", || {
            state.read_sessions_live().sessions[orig].state == SessionState::Exited
        });
        let text = output(&term_id);
        assert_add_dirs(&text, &[&docs, &ui]);
        let flat = text.replace(['\r', '\n'], "");
        assert!(!flat.contains(&format!("--add-dir {ide}")) && !flat.contains(&format!("[--add-dir][{ide}]")), "{flat}");

        // Fork: the same add-dirs.
        let reply = call("session_fork", json!({ "projectId": "ide", "sessionId": orig, "cols": 1000, "rows": 40 })).expect("session_fork");
        assert_eq!(reply["skipped"], json!([{ "label": "lost", "reason": "folder missing" }]));
        let fork = reply["session_id"].as_str().unwrap().to_string();
        let fork_term = format!("session:{fork}");
        assert_eq!(recorded(&fork), edge_dirs, "the original's edges, labelled");
        state.terms.write(&fork_term, b"go\r").unwrap();
        wait_until(&app, &fork_term, "the fork's exit", || {
            state.read_sessions_live().sessions[&fork].state == SessionState::Exited
        });
        assert_add_dirs(&output(&fork_term), &[&docs, &ui]);
        assert!(recorded(&fork).is_empty(), "forgotten at exit");

        // Branches off (no list): an edge to the branch checked out in a project's folder (from
        // the status poll) grants that folder; a detached HEAD checks out no branch.
        let repo = |detached: bool| {
            super::git::ProjectStatus::Repo(super::git::RepoStatus {
                branch: "main".into(),
                detached,
                ..Default::default()
            })
        };
        state.write_workspace().workspace.edges = vec![context(end(NodeType::Project, "ide"), end(NodeType::Branch, "ui:main"))];
        state.write_live().statuses.insert("ui".into(), repo(false));
        let prefill = call("launch_defaults", json!({ "projectId": "ide" })).unwrap();
        assert_eq!(prefill["addDirs"], json!([{ "path": ui, "via": "ui:main" }]));
        assert_eq!(prefill["skipped"], json!([]));
        state.write_live().statuses.insert("ui".into(), repo(true));
        let prefill = call("launch_defaults", json!({ "projectId": "ide" })).unwrap();
        assert_eq!(prefill["addDirs"], json!([]));
        assert_eq!(prefill["skipped"], json!([{ "label": "ui:main", "reason": "no worktree" }]));

        // A branch sheet on a linked worktree W: an edge to that branch is W itself (dropped);
        // one to the checked-out branch keeps the project's folder.
        let wt = mk("ide-feat");
        let listed = |name: &str, head: bool, worktree: Option<&str>| super::git::BranchInfo {
            name: name.into(),
            head,
            upstream: None,
            ahead: 0,
            behind: 0,
            gone: false,
            committed_at: 0,
            worktree: worktree.map(|path| super::git::WorktreeChip { path: path.into(), missing: false }),
        };
        state
            .write_workspace()
            .branches
            .insert("ide".into(), vec![listed("main", true, None), listed("feat", false, Some(&wt))]);
        state.write_workspace().workspace.edges = vec![
            context(end(NodeType::Project, "ide"), end(NodeType::Branch, "ide:feat")),
            context(end(NodeType::Project, "ide"), end(NodeType::Branch, "ide:main")),
        ];
        let prefill = call("launch_defaults", json!({ "projectId": "ide", "branch": "feat" })).unwrap();
        assert_eq!(prefill["targetPath"], json!(wt));
        assert_eq!(prefill["addDirs"], json!([{ "path": ide, "via": "ide:main" }]));
        assert_eq!(prefill["skipped"], json!([]));

        server.abort();
        super::on_run_event(app.handle(), &tauri::RunEvent::Exit);
    }

    /// Story 4.4: Stop on a busy session sends Ctrl+C twice; a session that ignores them is
    /// killed 5 s after the Stop and turns `exited`. A second Stop kills at once.
    #[test]
    fn a_busy_stop_interrupts_then_kills_at_five_seconds_and_a_second_stop_kills_at_once() {
        use super::claude::live::SessionState;
        use serde_json::json;
        let (app, webview, dir, _folder, _sessions) = launch_fixture();
        let state = app.state::<super::AppState>();
        *state.launcher.program.lock().unwrap() = Some(stubborn_program(dir.path()));
        let call = |cmd: &str, args: serde_json::Value| -> Result<serde_json::Value, serde_json::Value> {
            invoke_with(&webview, cmd, InvokeBody::Json(args)).map(|body| body.deserialize().unwrap())
        };
        let id = "0b7c1e3f-5b7d-4e8f-9a0b-1c2d3e4f5a6b";
        let path = state.read_workspace().workspace.projects[0].path.clone();
        discover(&app, id, "busy one", &path);
        let term_id = format!("session:{id}");
        let busy = || {
            state.write_sessions_live().sessions.get_mut(id).unwrap().state = SessionState::Busy;
        };

        // Ready means the fixture ignores Ctrl+C now: its marker is in the terminal's output.
        let ready = || {
            state.terms.buffer(&term_id).map(|b| b.data.contains("stubborn-ready")).unwrap_or(false)
        };

        call("session_resume", json!({ "projectId": "ide", "sessionId": id })).expect("session_resume");
        let pid = state.terms.get(&term_id).unwrap().pid().expect("runs");
        // Let it start (and answer ConPTY's cursor query) and ignore Ctrl+C before interrupting it.
        wait_until(&app, &term_id, "start-up", ready);
        busy();
        let stopped_at = std::time::Instant::now();
        let stop = call("session_stop", json!({ "sessionId": id })).expect("session_stop");
        assert_eq!(stop["stopping"], true);
        assert_eq!(call("term_list", json!({})).unwrap()[0]["stopping"], true);
        wait_until(&app, &term_id, "the kill", || {
            state.read_sessions_live().sessions[id].state == SessionState::Exited
        });
        let took = stopped_at.elapsed();
        assert!(took >= std::time::Duration::from_millis(4500), "killed at 5 s, not before: {took:?}");
        assert!(!state.terms.get(&term_id).unwrap().info().stopping);
        super::pty::tests::wait_dead(pid);

        // Again, and Stop twice: the second kills at once.
        call("session_resume", json!({ "projectId": "ide", "sessionId": id })).expect("resume again");
        let pid = state.terms.get(&term_id).unwrap().pid().expect("runs");
        wait_until(&app, &term_id, "start-up", ready);
        busy();
        let stopped_at = std::time::Instant::now();
        call("session_stop", json!({ "sessionId": id })).expect("first stop");
        call("session_stop", json!({ "sessionId": id })).expect("second stop");
        wait_until(&app, &term_id, "the immediate kill", || {
            state.read_sessions_live().sessions[id].state == SessionState::Exited
        });
        assert!(stopped_at.elapsed() < std::time::Duration::from_millis(4000), "{:?}", stopped_at.elapsed());
        super::pty::tests::wait_dead(pid);

        // A session started elsewhere (no Switchboard terminal) is never stopped.
        state.write_sessions_live().sessions.get_mut(id).unwrap().state = SessionState::Busy;
        assert_eq!(call("session_stop", json!({ "sessionId": "elsewhere" })), Err(json!(super::ipc::NOT_STOPPABLE)));
        super::on_run_event(app.handle(), &tauri::RunEvent::Exit);
    }

    /// The Story 6.3 stub session (never `claude`): prints its argv, then echoes every line it
    /// reads as `got=<line>` and keeps running, until a line ending in `/exit`.
    fn line_echo_program(dir: &std::path::Path) -> (std::path::PathBuf, Vec<String>) {
        #[cfg(windows)]
        {
            let script = dir.join("echo-lines.ps1");
            std::fs::write(
                &script,
                "Write-Output ('argv=' + ($args -join ' '))\r\nwhile ($true) {\r\n  $l = [Console]::In.ReadLine()\r\n  if ($null -eq $l) { break }\r\n  Write-Output ('got=' + $l)\r\n  if ($l.EndsWith('/exit')) { break }\r\n}\r\n",
            )
            .unwrap();
            (
                std::path::PathBuf::from("powershell.exe"),
                ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File"]
                    .map(String::from)
                    .into_iter()
                    .chain([script.display().to_string()])
                    .collect(),
            )
        }
        #[cfg(not(windows))]
        {
            let _ = dir;
            (
                std::path::PathBuf::from("/bin/sh"),
                [
                    "-c",
                    "echo argv=; printf '[%s]\\n' \"$@\"; while IFS= read -r x; do printf 'got=%s\\n' \"$x\"; case \"$x\" in */exit) exit 0;; esac; done",
                    "sh",
                ]
                .map(String::from)
                .to_vec(),
            )
        }
    }

    /// Story 6.3: a context edge drawn from a running session is injected as one `/add-dir` line
    /// once the session is idle and applied on the transcript's answer; a busy session times out
    /// with nothing written; no answer is `not confirmed`; a draft holds the line back; an unusable
    /// target fails at once; Restart with flags stops the session and resumes the same id with the
    /// edge's `--add-dir`; an edge from a session that is not running has no live state.
    #[test]
    fn context_edges_on_a_live_session_are_injected_confirmed_and_restarted() {
        use super::claude::live::SessionState;
        use super::claude::live_edges::{self, EdgeState};
        use super::graph::{BranchNode, Project, SessionRef};
        use serde_json::json;
        let (app, webview, dir, folder, _sessions) = launch_fixture();
        let state = app.state::<super::AppState>();
        *state.launcher.program.lock().unwrap() = Some(line_echo_program(dir.path()));
        let home = tempfile::tempdir().unwrap();
        state.claude_home.set(home.path().to_path_buf()).unwrap();
        *state.live_edges.timeouts.lock().unwrap() = live_edges::Timeouts {
            busy: std::time::Duration::from_millis(1500),
            confirm: std::time::Duration::from_millis(1500),
            notify: std::time::Duration::from_millis(1500),
            tick: std::time::Duration::from_millis(50),
        };
        let call = |cmd: &str, args: serde_json::Value| -> Result<serde_json::Value, serde_json::Value> {
            invoke_with(&webview, cmd, InvokeBody::Json(args)).map(|body| body.deserialize().unwrap())
        };
        let others = tempfile::tempdir().unwrap();
        let mk = |name: &str| {
            let path = others.path().join(name);
            std::fs::create_dir_all(&path).unwrap();
            dunce::canonicalize(&path).unwrap().display().to_string()
        };
        let (ui, docs, api) = (mk("ui"), mk("docs"), mk("api"));
        {
            let mut ws = state.write_workspace();
            for (id, path) in [("ui", ui.as_str()), ("docs", docs.as_str()), ("api", api.as_str())] {
                ws.workspace.projects.push(Project {
                    id: id.into(),
                    path: path.into(),
                    label: id.into(),
                    ..Project::default()
                });
            }
            ws.workspace.branches.push(BranchNode {
                id: "ui:feat".into(),
                project_id: "ui".into(),
                name: "feat".into(),
                ..BranchNode::default()
            });
        }
        let ide = dunce::canonicalize(folder.path()).unwrap().display().to_string();
        let orig = "7c3e1e3f-5b7d-4e8f-9a0b-1c2d3e4f5a6b";
        discover(&app, orig, "ide-7c3e", &ide);
        let transcripts = home.path().join("projects").join("X--ide");
        std::fs::create_dir_all(&transcripts).unwrap();
        let transcript = transcripts.join(format!("{orig}.jsonl"));
        let record = |text: &str| {
            let at = super::claude::transcript::format_iso_ms(super::claude::live::now_ms());
            format!(
                "{}\n",
                json!({ "type": "user", "timestamp": at, "message": { "role": "user", "content": format!("<local-command-stdout>{text}</local-command-stdout>") } })
            )
        };
        std::fs::write(&transcript, record("Added an older folder as a working directory")).unwrap();
        let append = |line: String| {
            use std::io::Write;
            std::fs::OpenOptions::new().append(true).open(&transcript).unwrap().write_all(line.as_bytes()).unwrap();
        };
        let link = |to: serde_json::Value| -> String {
            let edge = call("edge_add", json!({ "from": { "type": "session", "id": orig }, "to": to })).expect("edge_add");
            edge["id"].as_str().unwrap().to_string()
        };
        let live_of = |edge: &str| state.live_edges.snapshot().get(edge).cloned();
        let is = |edge: &str, want: EdgeState, detail: Option<&str>| {
            live_of(edge).is_some_and(|e| e.state == want && (detail.is_none() || e.detail.as_deref() == detail))
        };
        let set_state = |s: SessionState| state.write_sessions_live().sessions.get_mut(orig).unwrap().state = s;
        let term_id = format!("session:{orig}");
        let output = || super::pty::tests::strip_escapes(&state.terms.buffer(&term_id).map(|b| b.data).unwrap_or_default());
        let got = || -> Vec<String> { output().lines().filter(|l| l.starts_with("got=")).map(|l| l.trim_end().to_string()).collect() };

        // A historic session (not running): the edge is a launch default only, no live state.
        let historic = link(json!({ "type": "project", "id": "docs" }));
        std::thread::sleep(std::time::Duration::from_millis(200));
        assert!(state.live_edges.snapshot().is_empty());
        call("edge_remove", json!({ "id": historic })).unwrap();

        call("session_resume", json!({ "projectId": "ide", "sessionId": orig, "cols": 1000, "rows": 40 })).expect("session_resume");
        wait_until(&app, &term_id, "the stub's start", || output().contains("argv="));
        set_state(SessionState::Idle);
        let (tx, rx) = std::sync::mpsc::channel();
        {
            use tauri::Listener;
            app.listen_any(live_edges::EVENT, move |event| {
                let _ = tx.send(serde_json::from_str::<serde_json::Value>(event.payload()).unwrap());
            });
        }

        // Idle: exactly one `/add-dir <canonical path>` line, pending until the transcript answers.
        let to_ui = link(json!({ "type": "project", "id": "ui" }));
        wait_until(&app, &term_id, "the injected line", || output().contains(&format!("got=/add-dir {ui}")));
        assert!(is(&to_ui, EdgeState::Pending, Some(live_edges::CONFIRMING)), "{:?}", live_of(&to_ui));
        assert_eq!(got(), [format!("got=/add-dir {ui}")], "{}", output());
        append(record(&format!("Added {ui} as a working directory for this session")));
        wait_until(&app, &term_id, "applied", || is(&to_ui, EdgeState::Applied, None));
        let events: Vec<serde_json::Value> = rx.try_iter().collect();
        assert!(events.iter().any(|e| e[&to_ui]["state"] == "pending"), "{events:?}");
        assert!(events.iter().any(|e| e[&to_ui]["state"] == "applied" && e[&to_ui]["sessionId"] == orig), "{events:?}");
        assert_eq!(call("edges_live_get", json!({})).unwrap()[&to_ui]["path"], json!(ui));

        // Busy: waiting for idle, then failed after the (shortened) 60 s with nothing written.
        set_state(SessionState::Busy);
        let to_docs = link(json!({ "type": "project", "id": "docs" }));
        wait_until(&app, &term_id, "waiting for idle", || is(&to_docs, EdgeState::Pending, Some(live_edges::WAITING_FOR_IDLE)));
        wait_until(&app, &term_id, "stayed busy", || is(&to_docs, EdgeState::Failed, Some(live_edges::STAYED_BUSY)));
        assert!(!output().contains(&docs), "nothing written while busy");

        // Retry once idle: injected, but no answer in time.
        set_state(SessionState::Idle);
        call("edge_live_retry", json!({ "edgeId": to_docs })).expect("edge_live_retry");
        // (PowerShell's console may hand the stub the earlier line again in front of it; what was
        // written is still the one line.)
        wait_until(&app, &term_id, "the retried line", || got().iter().any(|l| l.ends_with(&format!("/add-dir {docs}"))));
        wait_until(&app, &term_id, "not confirmed", || is(&to_docs, EdgeState::Failed, Some(live_edges::NOT_CONFIRMED)));

        // A draft in the prompt: nothing is injected over it. The UI matches this wording.
        assert_eq!(live_edges::TYPING, "you're typing — Retry when done");
        call("term_write", json!({ "id": term_id, "data": "draft" })).unwrap();
        let to_api = link(json!({ "type": "project", "id": "api" }));
        wait_until(&app, &term_id, "you're typing", || is(&to_api, EdgeState::Pending, Some(live_edges::TYPING)));
        std::thread::sleep(std::time::Duration::from_millis(200));
        assert!(!output().contains(&api), "the draft is never written over");
        // Retry: the operator says the prompt is clear; the line goes and the edge leaves TYPING.
        call("edge_live_retry", json!({ "edgeId": to_api })).expect("retry the draft-held edge");
        wait_until(&app, &term_id, "the line after Retry", || got().iter().any(|l| l.ends_with(&format!("/add-dir {api}"))));
        wait_until(&app, &term_id, "TYPING left", || live_of(&to_api).is_some_and(|e| e.detail.as_deref() != Some(live_edges::TYPING)));
        // Deleting the edge drops its state.
        call("edge_remove", json!({ "id": to_api })).unwrap();
        assert_eq!(live_of(&to_api), None);

        // An unusable target fails at once, nothing written.
        let to_feat = link(json!({ "type": "branch", "id": "ui:feat" }));
        wait_until(&app, &term_id, "no worktree", || is(&to_feat, EdgeState::Failed, Some("no worktree")));
        std::thread::sleep(std::time::Duration::from_millis(200));
        let lines = got();
        assert!(
            lines.iter().all(|l| [&ui, &docs, &api].iter().any(|p| l.ends_with(&format!("/add-dir {p}")))),
            "only the three /add-dir lines were written: {}",
            output()
        );

        // Keys pressed while the session is waiting answer a dialog: no draft.
        set_state(SessionState::Waiting);
        call("term_write", json!({ "id": term_id, "data": "1" })).unwrap();
        assert!(!state.live_edges.has_draft(orig));
        set_state(SessionState::Idle);

        // Restart with flags needs a transcript: an edge from a session without one stops nothing.
        let bare = "8d4f1e3f-5b7d-4e8f-9a0b-1c2d3e4f5a6b";
        state.write_workspace().workspace.sessions.push(SessionRef {
            session_id: bare.into(),
            project_id: "ide".into(),
            ..SessionRef::default()
        });
        let edge = call("edge_add", json!({ "from": { "type": "session", "id": bare }, "to": { "type": "project", "id": "ui" } })).unwrap();
        assert_eq!(
            call("edge_restart_with_flags", json!({ "edgeId": edge["id"] })),
            Err(json!(super::ipc::NO_TRANSCRIPT))
        );
        assert!(state.terms.get(&term_id).unwrap().is_running(), "nothing stopped");

        // One restart per session at a time.
        let held = live_edges::begin_restart(&state, orig).unwrap();
        assert_eq!(
            call("edge_restart_with_flags", json!({ "edgeId": to_docs })),
            Err(json!(live_edges::ALREADY_RESTARTING))
        );
        assert!(state.terms.get(&term_id).unwrap().is_running(), "nothing stopped");
        drop(held);

        // Restart with flags on the failed `no worktree` edge: stopped, resumed under the same id
        // with the session's edges as `--add-dir`; every edge of the session says what it did.
        let reply = call("edge_restart_with_flags", json!({ "edgeId": to_feat })).expect("edge_restart_with_flags");
        assert_eq!(reply["session_id"], orig);
        assert!(is(&to_feat, EdgeState::Failed, Some("no worktree")), "{:?}", live_of(&to_feat));
        assert!(is(&to_docs, EdgeState::Applied, Some(live_edges::RESTARTED)), "{:?}", live_of(&to_docs));
        assert!(is(&to_ui, EdgeState::Applied, Some(live_edges::RESTARTED)), "{:?}", live_of(&to_ui));
        wait_until(&app, &term_id, "the resumed stub's argv", || output().contains("argv=") && output().contains(&docs));
        let text = output();
        if cfg!(windows) {
            assert!(text.replace(['\r', '\n'], "").contains(&format!("--resume {orig}")), "{text}");
        } else {
            assert!(text.contains(&format!("[--resume]\r\n[{orig}]")), "{text}");
        }
        assert_add_dirs(&text, &[&ui, &docs]);

        // The session exits while an edge is pending: its state is dropped.
        wait_until(&app, &term_id, "the resumed stub to settle", || {
            state.read_sessions_live().sessions[orig].state != SessionState::Starting
        });
        set_state(SessionState::Busy);
        let again = link(json!({ "type": "project", "id": "api" }));
        wait_until(&app, &term_id, "pending again", || is(&again, EdgeState::Pending, Some(live_edges::WAITING_FOR_IDLE)));
        state.terms.write(&term_id, b"/exit\r").unwrap();
        wait_until(&app, &term_id, "the exit", || state.read_sessions_live().sessions[orig].state == SessionState::Exited);
        wait_until(&app, &term_id, "the pending entry to go", || live_of(&again).is_none());
        assert_eq!(
            call("edge_live_retry", json!({ "edgeId": again })),
            Err(json!(live_edges::NOT_LIVE))
        );
        super::on_run_event(app.handle(), &tauri::RunEvent::Exit);
    }

    /// Story 6.4: a resumed session's appended system prompt lists its cooperate peers (a fork's
    /// does not); linking two live idle sessions sends each exactly one line naming the other,
    /// and a side is `notified` once its session goes busy, else `failed (not confirmed)`; Retry
    /// sends a side's line again; an end that is not live gets nothing; deleting the edge drops
    /// both sides.
    #[test]
    fn cooperate_edges_name_peers_at_resume_and_reach_live_sessions() {
        use super::claude::launch::{PEERS_HEADING, PEERS_INSTRUCTION};
        use super::claude::live::SessionState;
        use super::claude::live_edges::{self, EdgeState};
        use super::graph::Project;
        use serde_json::json;
        let (app, webview, dir, folder, _sessions) = launch_fixture();
        let state = app.state::<super::AppState>();
        *state.launcher.program.lock().unwrap() = Some(line_echo_program(dir.path()));
        *state.live_edges.timeouts.lock().unwrap() = live_edges::Timeouts {
            busy: std::time::Duration::from_millis(1500),
            confirm: std::time::Duration::from_millis(1500),
            notify: std::time::Duration::from_millis(1500),
            tick: std::time::Duration::from_millis(50),
        };
        let call = |cmd: &str, args: serde_json::Value| -> Result<serde_json::Value, serde_json::Value> {
            invoke_with(&webview, cmd, InvokeBody::Json(args)).map(|body| body.deserialize().unwrap())
        };
        let ui_dir = tempfile::tempdir().unwrap();
        let ui = dunce::canonicalize(ui_dir.path()).unwrap().display().to_string();
        state.write_workspace().workspace.projects.push(Project {
            id: "ui".into(),
            path: ui.clone(),
            label: "ui".into(),
            ..Project::default()
        });
        let ide = dunce::canonicalize(folder.path()).unwrap().display().to_string();
        let (api, web, docs) = (
            "a1a1a1a1-5b7d-4e8f-9a0b-1c2d3e4f5a6b",
            "b2b2b2b2-5b7d-4e8f-9a0b-1c2d3e4f5a6b",
            "c3c3c3c3-5b7d-4e8f-9a0b-1c2d3e4f5a6b",
        );
        let summary = |id: &str, title: &str, cwd: &str| super::claude::SessionSummary {
            id: id.into(),
            title: title.into(),
            started_at: "2026-10-18T10:00:00.000Z".into(),
            last_active: "2026-10-18T10:05:00.000Z".into(),
            branch: None,
            messages: 4,
            cwd: Some(cwd.into()),
        };
        super::graph::set_discovered(
            app.handle(),
            std::collections::HashMap::from([
                ("ide".to_string(), vec![summary(api, "api-1", &ide)]),
                ("ui".to_string(), vec![summary(web, "ui-2", &ui), summary(docs, "docs-3", &ui)]),
            ]),
        );
        let link = |a: &str, b: &str| -> String {
            let edge = call("edge_add", json!({ "from": { "type": "session", "id": a }, "to": { "type": "session", "id": b } })).expect("edge_add");
            edge["id"].as_str().unwrap().to_string()
        };
        let term = |id: &str| format!("session:{id}");
        let output = |id: &str| super::pty::tests::strip_escapes(&state.terms.buffer(&term(id)).map(|b| b.data).unwrap_or_default());
        let peer_lines = |id: &str| -> Vec<String> {
            output(id)
                .lines()
                .filter(|l| l.starts_with("got=") && l.contains("peer session"))
                .map(|l| l.trim_end().to_string())
                .collect()
        };
        let set_state = |id: &str, s: SessionState| state.write_sessions_live().sessions.get_mut(id).unwrap().state = s;
        let live_of = |key: &str| state.live_edges.snapshot().get(key).cloned();
        let is = |key: &str, want: EdgeState, detail: Option<&str>| live_of(key).is_some_and(|e| e.state == want && e.detail.as_deref() == detail);

        // Two historic sessions linked with a purpose: no live state.
        let first = link(api, web);
        call("edge_set_label", json!({ "id": first, "label": "API shape for auth refresh" })).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(200));
        assert!(state.live_edges.snapshot().is_empty());

        // Resumed, each prompt names the other with its node path and the edge's label.
        call("session_resume", json!({ "projectId": "ide", "sessionId": api, "cols": 1000, "rows": 40 })).expect("resume api");
        wait_until(&app, &term(api), "api's prompt", || output(api).contains(PEERS_INSTRUCTION));
        let text = output(api);
        assert!(text.contains(PEERS_HEADING), "{text}");
        assert!(text.contains("- \"ui-2\" (ui / ui-2): API shape for auth refresh"), "{text}");
        call("session_resume", json!({ "projectId": "ui", "sessionId": web, "cols": 1000, "rows": 40 })).expect("resume web");
        wait_until(&app, &term(web), "web's prompt", || output(web).contains(PEERS_INSTRUCTION));
        assert!(output(web).contains("- \"api-1\" (ide / api-1): API shape for auth refresh"), "{}", output(web));

        // A fork does not inherit the original's peers.
        let fork = call("session_fork", json!({ "projectId": "ide", "sessionId": api, "cols": 1000, "rows": 40 })).expect("fork");
        let fork = fork["session_id"].as_str().unwrap().to_string();
        wait_until(&app, &term(&fork), "the fork's prompt", || output(&fork).contains(&format!("Switchboard node id: {fork}")));
        assert!(!output(&fork).contains(PEERS_HEADING), "{}", output(&fork));
        assert!(!output(&fork).contains("SendMessage"), "{}", output(&fork));
        state.terms.write(&term(&fork), b"/exit\r").unwrap();

        // Both live and idle: linking sends each exactly one line naming the other.
        call("edge_remove", json!({ "id": first })).unwrap();
        set_state(api, SessionState::Idle);
        set_state(web, SessionState::Idle);
        let live = link(api, web);
        let (api_side, web_side) = (live_edges::side_key(&live, api), live_edges::side_key(&live, web));
        wait_until(&app, &term(api), "api's line", || !peer_lines(api).is_empty());
        set_state(api, SessionState::Busy);
        wait_until(&app, &term(web), "web's line", || !peer_lines(web).is_empty());
        assert_eq!(
            peer_lines(api),
            ["got=A new peer session \"ui-2\" is linked to you (no stated purpose). Use SendMessage or switchboard.inbox to coordinate."],
            "{}",
            output(api)
        );
        assert_eq!(
            peer_lines(web),
            ["got=A new peer session \"api-1\" is linked to you (no stated purpose). Use SendMessage or switchboard.inbox to coordinate."],
            "{}",
            output(web)
        );
        // Busy within the window: notified. Never busy: failed (not confirmed).
        wait_until(&app, &term(api), "api notified", || is(&api_side, EdgeState::Notified, None));
        wait_until(&app, &term(web), "web not confirmed", || is(&web_side, EdgeState::Failed, Some(live_edges::NOT_CONFIRMED)));
        let wire = call("edges_live_get", json!({})).unwrap();
        assert_eq!(wire[&api_side]["state"], "notified");
        assert_eq!(wire[&api_side]["edgeId"], json!(live));
        assert_eq!(wire[&web_side]["sessionId"], web);

        // Retry names a side; that side's line goes again and it is notified on busy.
        assert_eq!(call("edge_live_retry", json!({ "edgeId": live })), Err(json!(live_edges::NOT_A_SIDE)));
        assert_eq!(
            call("edge_live_retry", json!({ "edgeId": live, "sessionId": docs })),
            Err(json!(live_edges::NOT_A_SIDE))
        );
        call("edge_live_retry", json!({ "edgeId": live, "sessionId": web })).expect("retry web");
        wait_until(&app, &term(web), "web's second line", || peer_lines(web).len() >= 2);
        set_state(web, SessionState::Busy);
        wait_until(&app, &term(web), "web notified", || is(&web_side, EdgeState::Notified, None));

        // One live end: only it gets the line; the historic end has no entry.
        set_state(web, SessionState::Idle);
        let half = link(web, docs);
        wait_until(&app, &term(web), "the line naming docs", || {
            peer_lines(web).iter().any(|l| l.contains("\"docs-3\""))
        });
        std::thread::sleep(std::time::Duration::from_millis(200));
        assert!(live_of(&live_edges::side_key(&half, web)).is_some());
        assert!(live_of(&live_edges::side_key(&half, docs)).is_none());
        assert_eq!(
            call("edge_live_retry", json!({ "edgeId": half, "sessionId": docs })),
            Err(json!(live_edges::NOT_LIVE))
        );

        // Removing an unrelated project keeps both sides.
        state.write_workspace().workspace.projects.push(Project {
            id: "other".into(),
            path: ui.clone(),
            label: "other".into(),
            ..Project::default()
        });
        call("workspace_remove_project", json!({ "projectId": "other" })).expect("remove other");
        assert!(live_of(&api_side).is_some() && live_of(&web_side).is_some());

        // A Restart with flags that fails retires the session's side jobs (one with no entry
        // yet too) and fails its pending sides with the error, so Retry is offered.
        set_state(web, SessionState::Busy);
        let to_fork = link(web, &fork);
        let fork_side = live_edges::side_key(&to_fork, web);
        wait_until(&app, &term(web), "waiting for idle", || {
            is(&fork_side, EdgeState::Pending, Some(live_edges::WAITING_FOR_IDLE))
        });
        let context = call("edge_add", json!({ "from": { "type": "session", "id": web }, "to": { "type": "project", "id": "ide" } })).unwrap();
        let context = context["id"].as_str().unwrap().to_string();
        live_edges::cancel_session(app.handle(), web);
        live_edges::fail_session(app.handle(), web, &context, "boom");
        set_state(web, SessionState::Idle);
        std::thread::sleep(std::time::Duration::from_millis(400));
        assert!(is(&fork_side, EdgeState::Failed, Some("boom")), "{:?}", live_of(&fork_side));
        assert!(is(&web_side, EdgeState::Notified, None), "a notified side stays: {:?}", live_of(&web_side));
        assert!(!peer_lines(web).iter().any(|l| l.contains("-fork-")), "no line after the jobs were retired");
        // Retry refuses a side that is not failed or held back; a failed side is retried.
        assert_eq!(
            call("edge_live_retry", json!({ "edgeId": live, "sessionId": web })),
            Err(json!(live_edges::SIDE_NOT_RETRYABLE))
        );
        call("edge_live_retry", json!({ "edgeId": to_fork, "sessionId": web })).expect("retry the failed side");
        // (The stub's console cannot echo many long lines reliably on Windows, so the line is
        // seen through the state: written, then not confirmed because the stub never goes busy.)
        wait_until(&app, &term(web), "the retried side to be sent", || {
            is(&fork_side, EdgeState::Pending, Some(live_edges::SENT_PEER_LINE)) || is(&fork_side, EdgeState::Failed, Some(live_edges::NOT_CONFIRMED))
        });

        // Deleting the edge drops both sides.
        call("edge_remove", json!({ "id": live })).unwrap();
        assert!(live_of(&api_side).is_none() && live_of(&web_side).is_none());
        super::on_run_event(app.handle(), &tauri::RunEvent::Exit);
    }

    /// Story 7.3: `send` between two linked stub sessions lands in the peer's inbox and nudges it
    /// with exactly one line once it is idle; a busy peer is nudged once at its next idle with the
    /// count of what is unread then; a draft holds the nudge back; nothing is written once the
    /// messages were read or with the nudge off; a peer that exited keeps its inbox and is nudged
    /// after its resume; linking two running sessions leaves each a notice that does not nudge.
    #[test]
    fn peer_messages_land_in_the_inbox_and_nudge_an_idle_peer_once() {
        use super::claude::live::SessionState;
        use super::claude::live_edges;
        use super::graph::Project;
        use serde_json::json;
        let (app, webview, dir, folder, _sessions) = launch_fixture();
        let state = app.state::<super::AppState>();
        *state.launcher.program.lock().unwrap() = Some(line_echo_program(dir.path()));
        *state.live_edges.timeouts.lock().unwrap() = live_edges::Timeouts {
            busy: std::time::Duration::from_millis(1500),
            confirm: std::time::Duration::from_millis(1500),
            notify: std::time::Duration::from_millis(600),
            tick: std::time::Duration::from_millis(50),
        };
        let call = |cmd: &str, args: serde_json::Value| -> Result<serde_json::Value, serde_json::Value> {
            invoke_with(&webview, cmd, InvokeBody::Json(args)).map(|body| body.deserialize().unwrap())
        };
        let ui_dir = tempfile::tempdir().unwrap();
        let ui = dunce::canonicalize(ui_dir.path()).unwrap().display().to_string();
        state.write_workspace().workspace.projects.push(Project {
            id: "ui".into(),
            path: ui.clone(),
            label: "ui".into(),
            ..Project::default()
        });
        let ide = dunce::canonicalize(folder.path()).unwrap().display().to_string();
        let (api, web) = ("a1a1a1a1-5b7d-4e8f-9a0b-1c2d3e4f5a6b", "b2b2b2b2-5b7d-4e8f-9a0b-1c2d3e4f5a6b");
        let summary = |id: &str, title: &str, cwd: &str| super::claude::SessionSummary {
            id: id.into(),
            title: title.into(),
            started_at: "2026-10-18T10:00:00.000Z".into(),
            last_active: "2026-10-18T10:05:00.000Z".into(),
            branch: None,
            messages: 4,
            cwd: Some(cwd.into()),
        };
        super::graph::set_discovered(
            app.handle(),
            std::collections::HashMap::from([
                ("ide".to_string(), vec![summary(api, "api-1", &ide)]),
                ("ui".to_string(), vec![summary(web, "ui-2", &ui)]),
            ]),
        );
        let term = |id: &str| format!("session:{id}");
        let output = |id: &str| super::pty::tests::strip_escapes(&state.terms.buffer(&term(id)).map(|b| b.data).unwrap_or_default());
        let nudges = |id: &str| -> Vec<String> {
            output(id)
                .lines()
                .filter(|l| l.starts_with("got=You have"))
                .map(|l| l.trim_end().to_string())
                .collect()
        };
        let set_state = |id: &str, s: SessionState| state.write_sessions_live().sessions.get_mut(id).unwrap().state = s;
        let send = |from: &str, peer: &str, text: &str| super::mcp::call_app(app.handle(), from, "send", &json!({ "peer": peer, "text": text }));
        let read = |who: &str| super::mcp::call_app(app.handle(), who, "inbox", &json!({})).unwrap();
        let settle = || std::thread::sleep(std::time::Duration::from_millis(400));

        // Linked while neither runs, then both resumed.
        let edge = call("edge_add", json!({ "from": { "type": "session", "id": api }, "to": { "type": "session", "id": web } })).expect("edge_add");
        let edge = edge["id"].as_str().unwrap().to_string();
        for (project, id) in [("ide", api), ("ui", web)] {
            call("session_resume", json!({ "projectId": project, "sessionId": id, "cols": 1000, "rows": 40 })).expect("resume");
            wait_until(&app, &term(id), "the prompt", || output(id).contains("Switchboard node id"));
        }
        assert!(state.inbox.unread().is_empty(), "no notice for a link made before they ran");

        // Idle: one line, exactly.
        set_state(api, SessionState::Busy);
        set_state(web, SessionState::Idle);
        let sent = send(api, "ui-2", "endpoint is POST /auth/refresh, returns {token, expiresAt}").unwrap();
        assert_eq!(sent, json!({ "delivered": true, "to": "ui-2", "unread": 1 }));
        assert_eq!(call("inbox_unread_get", json!({})).unwrap(), json!({ web: 1 }));
        wait_until(&app, &term(web), "the nudge", || !nudges(web).is_empty());
        set_state(web, SessionState::Busy);
        wait_until(&app, &term(web), "the nudge job to end", || !state.inbox.nudge_pending(web));
        assert_eq!(nudges(web), ["got=You have 1 message from \"api-1\". Call switchboard.inbox."], "{}", output(web));
        assert_eq!(read(web)[0]["text"], "endpoint is POST /auth/refresh, returns {token, expiresAt}");
        assert_eq!(read(web), json!([]));
        assert_eq!(call("inbox_unread_get", json!({})).unwrap(), json!({}));

        // Busy: two messages, one nudge at the next idle, and not again at a later idle.
        send(api, "ui-2", "a").unwrap();
        send(api, web, "b").unwrap();
        settle();
        assert_eq!(nudges(web).len(), 1, "nothing while busy");
        set_state(web, SessionState::Idle);
        wait_until(&app, &term(web), "the second nudge", || nudges(web).len() == 2);
        set_state(web, SessionState::Busy);
        wait_until(&app, &term(web), "the nudge job to end", || !state.inbox.nudge_pending(web));
        assert_eq!(nudges(web)[1], "got=You have 2 messages from \"api-1\". Call switchboard.inbox.", "{}", output(web));
        set_state(web, SessionState::Idle);
        settle();
        assert_eq!(nudges(web).len(), 2, "the same unread messages do not nudge again");
        assert!(!state.inbox.nudge_owed(web) && !state.inbox.nudge_pending(web), "nothing owed, no job");
        read(web);

        // Read before the idle: nothing is written.
        set_state(web, SessionState::Busy);
        send(api, "ui-2", "c").unwrap();
        read(web);
        set_state(web, SessionState::Idle);
        settle();
        assert_eq!(nudges(web).len(), 2, "already read");
        assert!(!state.inbox.nudge_owed(web) && !state.inbox.nudge_pending(web), "nothing owed, no job");

        // A draft holds it back until an idle with no draft.
        live_edges::note_input(&state, web, "half a thought");
        send(api, "ui-2", "d").unwrap();
        settle();
        assert_eq!(nudges(web).len(), 2, "not over a draft");
        assert!(state.inbox.nudge_owed(web) && state.inbox.nudge_pending(web), "held back, still owed");
        live_edges::note_input(&state, web, "\x15");
        wait_until(&app, &term(web), "the nudge after the draft", || nudges(web).len() == 3);
        set_state(web, SessionState::Busy);
        wait_until(&app, &term(web), "the nudge job to end", || !state.inbox.nudge_pending(web));
        read(web);

        // The nudge off: the badge only. Turned on again, the owed arrival is nudged.
        state.write().settings.peers.nudge = false;
        set_state(web, SessionState::Idle);
        assert_eq!(send(api, "ui-2", "e").unwrap()["unread"], 1);
        settle();
        assert_eq!(nudges(web).len(), 3, "no injection with the nudge off");
        assert!(state.inbox.nudge_owed(web) && !state.inbox.nudge_pending(web), "owed, no job");
        assert_eq!(state.inbox.count(web), 1);
        state.write().settings.peers.nudge = true;
        // What `settings::reload` calls when the file turns the nudge on.
        super::inbox::nudge_turned_on(app.handle());
        wait_until(&app, &term(web), "the nudge once it is on", || nudges(web).len() == 4);
        set_state(web, SessionState::Busy);
        wait_until(&app, &term(web), "the nudge job to end", || !state.inbox.nudge_pending(web));
        assert_eq!(nudges(web)[3], "got=You have 1 message from \"api-1\". Call switchboard.inbox.");
        read(web);

        // Not a peer: refused, and nothing lands.
        call("edge_remove", json!({ "id": edge })).unwrap();
        assert!(send(api, "ui-2", "f").unwrap_err().starts_with(super::inbox::NOT_A_PEER));
        assert!(state.inbox.unread().is_empty());

        // Linked while both run, by an agent's labelled `link` (the workspace allows all): a
        // notice with the purpose in each inbox, and no nudge for it.
        set_state(api, SessionState::Busy);
        set_state(web, SessionState::Busy);
        state.write_workspace().workspace.agent_actions = super::graph::AgentActions::AllowAll;
        let linked = super::mcp::call_app(
            app.handle(),
            api,
            "link",
            &json!({ "from": "self", "to": format!("session:{web}"), "kind": "cooperate", "label": "API shape" }),
        );
        assert!(linked.is_ok(), "{linked:?}");
        assert_eq!(call("inbox_unread_get", json!({})).unwrap(), json!({ api: 1, web: 1 }));
        let notice = read(web);
        assert_eq!(notice[0]["from"], "switchboard");
        assert_eq!(notice[0]["fromNodeId"], json!(null));
        assert_eq!(notice[0]["text"], "Linked to \"api-1\" (API shape).");
        assert_eq!(read(api)[0]["text"], "Linked to \"ui-2\" (API shape).");
        assert!(!state.inbox.nudge_pending(api) && !state.inbox.nudge_pending(web), "a notice never nudges");

        // A peer that exited keeps its inbox and is nudged once its resume is idle.
        state.terms.write(&term(api), b"/exit\r").unwrap();
        wait_until(&app, &term(api), "api to exit", || live_edges::running_session(&state, api).is_none());
        let queued = send(web, "api-1", "while you were out").unwrap();
        assert_eq!(queued, json!({ "delivered": true, "to": "api-1", "unread": 1, "running": false }));
        call("session_resume", json!({ "projectId": "ide", "sessionId": api, "cols": 1000, "rows": 40 })).expect("resume api again");
        wait_until(&app, &term(api), "api to run again", || live_edges::running_session(&state, api).is_some());
        assert_eq!(state.inbox.count(api), 1, "the inbox outlived the exit");
        set_state(api, SessionState::Idle);
        wait_until(&app, &term(api), "api's nudge", || {
            nudges(api).iter().any(|l| l == "got=You have 1 message from \"ui-2\". Call switchboard.inbox.")
        });
        set_state(api, SessionState::Busy);
        assert_eq!(read(api)[0]["text"], "while you were out");
        super::on_run_event(app.handle(), &tauri::RunEvent::Exit);
    }

    #[test]
    fn a_misspelt_command_is_rejected() {
        let app = mock_app();
        let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .expect("mock webview should build");

        invoke(&webview, "app_quitt").expect_err("unknown wire names must not resolve");
    }

    /// Wait (bounded) until `check` holds on the workspace state; panics with `what` after `limit`.
    fn wait_for_workspace(
        app: &tauri::App<tauri::test::MockRuntime>,
        limit: std::time::Duration,
        what: &str,
        check: impl Fn(&super::graph::WorkspaceState) -> bool,
    ) -> std::time::Duration {
        let started = std::time::Instant::now();
        loop {
            if check(&app.state::<super::AppState>().read_workspace()) {
                return started.elapsed();
            }
            assert!(started.elapsed() < limit, "{what} not within {limit:?}");
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
    }

    #[test]
    fn project_set_show_branches_lists_watches_and_refreshes_a_real_repo_then_stops() {
        let Some(git) = super::git::branches::tests::real_git() else {
            eprintln!("git not on PATH; skipping");
            return;
        };
        let app = mock_app();
        let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .expect("mock webview should build");
        let cfg = tempfile::tempdir().unwrap();
        super::graph::initialise_at(app.handle(), Some(cfg.path().join("workspace.json")));
        app.state::<super::AppState>().write().binaries.git.path = Some(git.display().to_string());
        let repo = super::git::branches::tests::temp_repo(&git);
        super::git::branches::tests::git_ok(&git, repo.path(), &["branch", "feat"]);
        let added = super::graph::add_projects(app.handle(), &[repo.path().display().to_string()], Default::default()).unwrap();
        let id = added.added[0].clone();
        let has = |name: &str| {
            let child = format!("{id}:{name}");
            move |st: &super::graph::WorkspaceState| st.children().iter().any(|c| c.id == child)
        };

        let args = serde_json::json!({ "projectId": id, "show": true });
        let body = invoke_with(&webview, "project_set_show_branches", InvokeBody::Json(args))
            .expect("project_set_show_branches should be registered and succeed");
        let value: serde_json::Value = body.deserialize().unwrap();
        assert_eq!(value["workspace"]["projects"][0]["showBranches"], true);
        assert_eq!(value["workspace"]["projects"][0]["expanded"], true, "pressing it collapsed expands the card");

        wait_for_workspace(&app, std::time::Duration::from_secs(5), "the branch list", has("feat"));
        let children = app.state::<super::AppState>().read_workspace().children();
        let names: Vec<&str> = children.iter().map(|c| c.label.as_str()).collect();
        assert_eq!(names, ["main", "feat"], "checked-out branch first");
        assert!(children[0].branch.as_ref().unwrap().head);
        let started = std::time::Instant::now();
        while app.state::<super::AppState>().branch_watches.ids() != [id.clone()] {
            assert!(started.elapsed() < std::time::Duration::from_secs(5), "the watch did not start");
            std::thread::sleep(std::time::Duration::from_millis(20));
        }

        // A branch made in a terminal shows within 2 s (`SEEN_WITHIN`, 3 s, for a loaded runner).
        std::thread::sleep(std::time::Duration::from_millis(150));
        super::git::branches::tests::git_ok(&git, repo.path(), &["branch", "fresh"]);
        let took = wait_for_workspace(&app, super::git::watch::tests::SEEN_WITHIN, "the new branch", has("fresh"));
        eprintln!("new branch seen after {took:?}");

        // Off: no branch children, the watch stops.
        let args = serde_json::json!({ "projectId": id, "show": false });
        invoke_with(&webview, "project_set_show_branches", InvokeBody::Json(args)).expect("off");
        assert!(app.state::<super::AppState>().read_workspace().children().is_empty());
        let started = std::time::Instant::now();
        while !app.state::<super::AppState>().branch_watches.ids().is_empty() {
            assert!(started.elapsed() < std::time::Duration::from_secs(5), "the watch did not stop");
            std::thread::sleep(std::time::Duration::from_millis(20));
        }

        // Unknown id and a missing argument are rejected.
        let err = invoke_with(&webview, "project_set_show_branches", InvokeBody::Json(serde_json::json!({ "projectId": "nope", "show": true })))
            .expect_err("unknown id");
        assert_eq!(err, serde_json::json!("unknown project"));
        invoke_with(&webview, "project_set_show_branches", InvokeBody::Json(serde_json::json!({ "projectId": id })))
            .expect_err("show is required");

        // On again, then the project is removed: its watch stops.
        invoke_with(&webview, "project_set_show_branches", InvokeBody::Json(serde_json::json!({ "projectId": id, "show": true }))).expect("on");
        let started = std::time::Instant::now();
        while app.state::<super::AppState>().branch_watches.ids().is_empty() {
            assert!(started.elapsed() < std::time::Duration::from_secs(5), "the watch did not start again");
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        invoke_with(&webview, "workspace_remove_project", InvokeBody::Json(serde_json::json!({ "projectId": id }))).expect("removed");
        assert!(app.state::<super::AppState>().branch_watches.ids().is_empty(), "removing the project stops its watch");
        app.state::<super::AppState>().branch_watches.clear();
    }

    #[test]
    fn worktree_preview_and_add_create_a_selected_branch_card_on_a_temp_repo() {
        let Some(git) = super::git::branches::tests::real_git() else {
            eprintln!("git not on PATH; skipping");
            return;
        };
        let app = mock_app();
        let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .expect("mock webview should build");
        let cfg = tempfile::tempdir().unwrap();
        let ws_path = cfg.path().join("workspace.json");
        super::graph::initialise_at(app.handle(), Some(ws_path.clone()));
        app.state::<super::AppState>().write().binaries.git.path = Some(git.display().to_string());
        let repo = super::git::branches::tests::temp_repo(&git);
        let top = dunce::canonicalize(repo.path()).unwrap();
        let added = super::graph::add_projects(app.handle(), &[repo.path().display().to_string()], Default::default()).unwrap();
        let id = added.added[0].clone();
        let expected = top.join(".worktrees").join("auth-refresh");

        // The preview: options and the exact command.
        let request = serde_json::json!({ "mode": "new", "branch": "auth-refresh", "base": "main" });
        let body = invoke_with(&webview, "worktree_preview", InvokeBody::Json(serde_json::json!({ "projectId": id, "request": request })))
            .expect("worktree_preview should be registered and succeed");
        let preview: serde_json::Value = body.deserialize().unwrap();
        assert_eq!(preview["branches"], serde_json::json!(["main"]));
        assert_eq!(preview["available"], serde_json::json!([]), "main is checked out");
        assert_eq!(preview["defaultBase"], "main");
        assert_eq!(preview["command"], format!("git worktree add -b auth-refresh {} main", expected.display()));
        assert_eq!(preview["path"], expected.display().to_string());
        assert_eq!(preview["error"], serde_json::Value::Null);
        assert!(!expected.exists(), "a preview runs nothing");

        // A refusal: nothing runs, the reason is the error.
        let taken = serde_json::json!({ "projectId": id, "request": { "mode": "new", "branch": "main" } });
        let err = invoke_with(&webview, "worktree_add", InvokeBody::Json(taken)).expect_err("main exists");
        assert_eq!(err, serde_json::json!("branch already exists: main"));

        // Branches off: the add turns them on, expands the card and lists the new branch with
        // its chip; the branch is stored with its worktree path.
        let args = serde_json::json!({ "projectId": id, "request": request });
        let body = invoke_with(&webview, "worktree_add", InvokeBody::Json(args)).expect("worktree_add should succeed");
        let value: serde_json::Value = body.deserialize().unwrap();
        let branch_id = format!("{id}:auth-refresh");
        assert_eq!(value["branchId"], branch_id);
        assert_eq!(value["snapshot"]["workspace"]["projects"][0]["showBranches"], true);
        assert_eq!(value["snapshot"]["workspace"]["projects"][0]["expanded"], true);
        let children = value["snapshot"]["children"].as_array().unwrap();
        let card = children.iter().find(|c| c["id"] == branch_id).expect("the new branch card");
        assert_eq!(card["branch"]["worktree"]["path"], expected.display().to_string());
        assert_eq!(card["branch"]["worktree"]["missing"], false);
        let stored = &value["snapshot"]["workspace"]["branches"][0];
        assert_eq!(stored["id"], branch_id);
        assert_eq!(stored["worktreePath"], expected.display().to_string());
        let on_disk: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&ws_path).unwrap()).unwrap();
        assert_eq!(on_disk["branches"][0]["worktreePath"], expected.display().to_string());
        assert!(expected.join("a.txt").is_file());

        // The dirty count leaves the worktree out.
        let map = tauri::async_runtime::block_on(super::git::poll::refresh_ids(app.handle(), std::slice::from_ref(&id)));
        match &map[&id] {
            super::git::ProjectStatus::Repo(status) => assert_eq!(status.dirty, 0),
            other => panic!("expected a repo, got {other:?}"),
        }

        // Branches already on, card collapsed: the add expands it and lists the new card.
        super::graph::set_expanded(app.handle(), &id, false).unwrap();
        let second = serde_json::json!({ "projectId": id, "request": { "mode": "new", "branch": "second", "base": "main" } });
        let body = invoke_with(&webview, "worktree_add", InvokeBody::Json(second)).expect("second worktree_add");
        let value: serde_json::Value = body.deserialize().unwrap();
        assert_eq!(value["branchId"], format!("{id}:second"));
        assert_eq!(value["snapshot"]["workspace"]["projects"][0]["showBranches"], true);
        assert_eq!(value["snapshot"]["workspace"]["projects"][0]["expanded"], true, "a collapsed card is expanded");
        let card = value["snapshot"]["children"].as_array().unwrap().iter().find(|c| c["id"] == format!("{id}:second")).cloned();
        assert_eq!(card.expect("the second card")["branch"]["worktree"]["path"], top.join(".worktrees").join("second").display().to_string());

        // The same again: the folder (and the branch) now exist.
        let again = serde_json::json!({ "projectId": id, "request": { "mode": "existing", "branch": "auth-refresh" } });
        let err = invoke_with(&webview, "worktree_add", InvokeBody::Json(again)).expect_err("checked out already");
        assert!(err.as_str().unwrap().contains("already checked out"), "{err}");
        let unknown = serde_json::json!({ "projectId": "nope", "request": request });
        assert_eq!(invoke_with(&webview, "worktree_preview", InvokeBody::Json(unknown)).unwrap_err(), serde_json::json!("unknown project"));
        app.state::<super::AppState>().branch_watches.clear();
    }

    /// Story 8.1: `review_list` / `review_file` on a project and on a branch with a worktree; the
    /// checked-out branch and a branch without a worktree are refused. Temp repo; read-only.
    #[test]
    fn review_list_and_file_read_a_project_and_a_branch_worktree() {
        use serde_json::json;
        let Some(git) = super::git::branches::tests::real_git() else {
            eprintln!("git not on PATH; skipping");
            return;
        };
        let app = mock_app();
        let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .expect("mock webview should build");
        let cfg = tempfile::tempdir().unwrap();
        super::graph::initialise_at(app.handle(), Some(cfg.path().join("workspace.json")));
        app.state::<super::AppState>().write().binaries.git.path = Some(git.display().to_string());
        let repo = super::git::branches::tests::temp_repo(&git);
        let top = dunce::canonicalize(repo.path()).unwrap();
        let added = super::graph::add_projects(app.handle(), &[repo.path().display().to_string()], Default::default()).unwrap();
        let id = added.added[0].clone();
        std::fs::write(top.join("a.txt"), "a\nb\n").unwrap();

        let project = json!({ "kind": "project", "projectId": id });
        let body = invoke_with(&webview, "review_list", InvokeBody::Json(json!({ "target": project, "filter": "all" }))).expect("review_list");
        let list: serde_json::Value = body.deserialize().unwrap();
        assert_eq!(list["root"], top.display().to_string());
        assert_eq!(
            list["files"],
            json!([{ "path": "a.txt", "oldPath": null, "status": "modified", "added": 2, "removed": 1, "binary": false,
                "submodule": false, "unreadableName": false, "tooLarge": false, "onDisk": false }])
        );
        assert_eq!((list["more"].clone(), list["requested"].clone()), (json!(0), json!([])));

        // A session is reviewed in its cwd; one whose folder is not known is refused.
        app.state::<super::AppState>().write_sessions_live().launched("s-live", Some(id.clone()), &top.display().to_string(), "live", 1);
        let session = json!({ "kind": "session", "sessionId": "s-live" });
        let body = invoke_with(&webview, "review_list", InvokeBody::Json(json!({ "target": session, "filter": "all" }))).expect("session list");
        assert_eq!(body.deserialize::<serde_json::Value>().unwrap()["root"], top.display().to_string());
        let unknown = json!({ "kind": "session", "sessionId": "nobody" });
        let err = invoke_with(&webview, "review_list", InvokeBody::Json(json!({ "target": unknown, "filter": "all" }))).unwrap_err();
        assert_eq!(err, json!(super::review::NO_FOLDER));
        app.state::<super::AppState>().write_sessions_live().forget("s-live");
        let body = invoke_with(&webview, "review_file", InvokeBody::Json(json!({ "target": project, "path": "a.txt", "filter": "all" }))).expect("review_file");
        let file: serde_json::Value = body.deserialize().unwrap();
        assert_eq!(file["content"], json!({ "kind": "text", "old": "a", "new": "a\nb\n", "notUtf8": false }));
        let staged = invoke_with(&webview, "review_list", InvokeBody::Json(json!({ "target": project, "filter": "staged" }))).unwrap();
        assert_eq!(staged.deserialize::<serde_json::Value>().unwrap()["files"], json!([]));
        let refused = invoke_with(&webview, "review_file", InvokeBody::Json(json!({ "target": project, "path": "../x", "filter": "all" })));
        assert_eq!(refused.unwrap_err(), json!("unchanged"));

        // A branch with a worktree is reviewed there; the checked-out one and a bare one are refused.
        let request = json!({ "mode": "new", "branch": "feat", "base": "main" });
        invoke_with(&webview, "worktree_add", InvokeBody::Json(json!({ "projectId": id, "request": request }))).expect("worktree_add");
        let wt = top.join(".worktrees").join("feat");
        std::fs::write(wt.join("f.txt"), "f\n").unwrap();
        let branch = json!({ "kind": "branch", "projectId": id, "branch": "feat" });
        let body = invoke_with(&webview, "review_list", InvokeBody::Json(json!({ "target": branch, "filter": "all" }))).expect("branch list");
        let list: serde_json::Value = body.deserialize().unwrap();
        assert_eq!(list["root"], wt.display().to_string());
        assert_eq!(list["files"].as_array().unwrap().iter().map(|f| f["path"].clone()).collect::<Vec<_>>(), [json!("f.txt")]);
        let main = json!({ "kind": "branch", "projectId": id, "branch": "main" });
        let err = invoke_with(&webview, "review_list", InvokeBody::Json(json!({ "target": main, "filter": "all" }))).unwrap_err();
        assert_eq!(err, json!(super::review::CHECKED_OUT));
        super::git::branches::tests::git_ok(&git, &top, &["branch", "bare"]);
        let _ = tauri::async_runtime::block_on(super::git::poll::refresh_ids(app.handle(), std::slice::from_ref(&id)));
        let bare = json!({ "kind": "branch", "projectId": id, "branch": "bare" });
        let err = invoke_with(&webview, "review_list", InvokeBody::Json(json!({ "target": bare, "filter": "all" }))).unwrap_err();
        assert!(err == json!(super::review::NO_WORKTREE) || err == json!(super::claude::launch::BRANCH_NOT_FOUND), "{err}");
        let gone = json!({ "kind": "project", "projectId": "nope" });
        assert_eq!(invoke_with(&webview, "review_list", InvokeBody::Json(json!({ "target": gone, "filter": "all" }))).unwrap_err(), json!("unknown project"));
        app.state::<super::AppState>().branch_watches.clear();
    }

    /// Story 5.4: sessions in worktrees (the app's and Claude's own) are discovered under their
    /// branch, keep their place after the worktree is removed and after a restart; the remove
    /// sheet's checks and commands; force; "Also delete branch". Temp repo, temp Claude home.
    #[test]
    fn sessions_follow_worktrees_and_remove_worktree_runs_from_the_sheet() {
        use serde_json::json;
        let Some(git) = super::git::branches::tests::real_git() else {
            eprintln!("git not on PATH; skipping");
            return;
        };
        let app = mock_app();
        let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .expect("mock webview should build");
        let cfg = tempfile::tempdir().unwrap();
        let ws_path = cfg.path().join("workspace.json");
        super::graph::initialise_at(app.handle(), Some(ws_path.clone()));
        let state = app.state::<super::AppState>();
        state.write().binaries.git.path = Some(git.display().to_string());
        let home = tempfile::tempdir().unwrap();
        state.claude_home.set(home.path().to_path_buf()).unwrap();
        let repo = super::git::branches::tests::temp_repo(&git);
        let top = dunce::canonicalize(repo.path()).unwrap();
        let git_ok = |args: &[&str]| super::git::branches::tests::git_ok(&git, repo.path(), args);
        let added = super::graph::add_projects(app.handle(), &[top.display().to_string()], Default::default()).unwrap();
        let id = added.added[0].clone();
        // Worktrees made outside the app: one in `.worktrees/`, one where `claude --worktree` puts it.
        let feat = top.join(".worktrees").join("feat");
        let keep = top.join(".worktrees").join("keep");
        let claude_wt = top.join(".claude").join("worktrees").join("x");
        git_ok(&["worktree", "add", "-q", "-b", "feat", &feat.display().to_string(), "main"]);
        git_ok(&["worktree", "add", "-q", "-b", "keep", &keep.display().to_string(), "main"]);
        git_ok(&["worktree", "add", "-q", "-b", "worktree-x", &claude_wt.display().to_string(), "main"]);
        let plant = |dir: &str, session: &str, cwd: &std::path::Path| {
            let folder = home.path().join("projects").join(dir);
            std::fs::create_dir_all(&folder).unwrap();
            let line = json!({ "type": "user", "cwd": cwd.display().to_string(), "timestamp": "2026-10-16T10:00:00.000Z", "message": { "content": format!("prompt {session}") } });
            std::fs::write(folder.join(format!("{session}.jsonl")), format!("{line}\n")).unwrap();
        };
        plant("feat", "s-feat-1", &feat);
        plant("feat", "s-feat-2", &feat);
        plant("keep", "s-keep-1", &keep);
        plant("keep", "s-keep-2", &keep);
        plant("claude", "s-x", &claude_wt);
        let call = |cmd: &str, args: serde_json::Value| -> Result<serde_json::Value, serde_json::Value> {
            invoke_with(&webview, cmd, InvokeBody::Json(args)).map(|body| body.deserialize().unwrap())
        };
        let pass = || {
            tauri::async_runtime::block_on(super::git::poll::refresh_ids(app.handle(), std::slice::from_ref(&id)));
            tauri::async_runtime::block_on(super::claude::sessions::refresh(app.handle()));
        };
        let branch_of = |session: &str| {
            let ws = state.read_workspace();
            let child = ws.children().into_iter().find(|c| c.id == session);
            child.map(|c| (c.project_id, c.branch_id))
        };
        let under = |name: &str| Some((id.clone(), Some(format!("{id}:{name}"))));

        // The full status pass stores the repo's linked worktrees for the project.
        tauri::async_runtime::block_on(super::git::poll::refresh(app.handle()));
        {
            let ws = state.read_workspace();
            let known = ws.worktrees.get(&id).expect("listed by the status pass");
            assert!(known.iter().any(|w| w.path == feat.display().to_string() && w.branch.as_deref() == Some("feat")), "{known:?}");
        }
        // Branches off: the status poll alone knows the worktrees; each session sits under its
        // branch (the canvas shows them in the session group while branches are off).
        pass();
        assert_eq!(branch_of("s-feat-1"), under("feat"));
        assert_eq!(branch_of("s-feat-2"), under("feat"));
        assert_eq!(branch_of("s-x"), under("worktree-x"), "Claude's own worktree");
        // The production live path: a row in a worktree only git lists is the project's.
        let rows = super::claude::live::parse_rows(
            &json!([{ "sessionId": "live-x", "cwd": claude_wt.display().to_string(), "status": "busy", "name": "x" }]).to_string(),
        );
        let live = super::claude::live::apply_and_emit(app.handle(), rows);
        assert_eq!(live.sessions["live-x"].project_id.as_deref(), Some(id.as_str()));
        assert!(live.elsewhere.is_empty(), "not Elsewhere");
        state.write_sessions_live().sessions.remove("live-x");
        super::graph::set_show_branches(app.handle(), &id, true).unwrap();
        tauri::async_runtime::block_on(super::git::poll::refresh_branches(app.handle(), None));

        // The sheet's preview: clean, the exact commands.
        let feat_s = feat.display().to_string();
        let preview = call("worktree_remove_preview", json!({ "projectId": id, "branch": "feat" })).expect("worktree_remove_preview is registered");
        assert_eq!(preview["path"], feat_s.as_str());
        assert_eq!(preview["dirty"], 0);
        assert_eq!(preview["command"], format!("git worktree remove {feat_s}"));
        assert_eq!(preview["forceCommand"], serde_json::Value::Null);
        assert_eq!(preview["deleteCommand"], "git branch -d feat");
        assert_eq!(preview["refusal"], serde_json::Value::Null);
        assert_eq!(call("worktree_remove_preview", json!({ "projectId": id, "branch": "main" })), Err(json!(super::git::worktree::NO_WORKTREE)));
        assert_eq!(call("worktree_remove_preview", json!({ "projectId": "nope", "branch": "feat" })), Err(json!("unknown project")));

        // A live session in it: refused, named.
        state.write_sessions_live().launched("live-1", Some(id.clone()), &feat.join("src").display().to_string(), "spike", 1);
        let preview = call("worktree_remove_preview", json!({ "projectId": id, "branch": "feat" })).unwrap();
        assert_eq!(preview["refusal"], "a session is running in this worktree: spike");
        assert_eq!(call("worktree_remove", json!({ "projectId": id, "branch": "feat", "force": true })), Err(json!("a session is running in this worktree: spike")));
        state.write_sessions_live().sessions.remove("live-1");

        // Dirty: the count, Remove refused, the force command.
        std::fs::write(feat.join("new.txt"), "x").unwrap();
        let preview = call("worktree_remove_preview", json!({ "projectId": id, "branch": "feat" })).unwrap();
        assert_eq!(preview["dirty"], 1);
        assert_eq!(preview["forceCommand"], format!("git worktree remove --force {feat_s}"));
        assert_eq!(call("worktree_remove", json!({ "projectId": id, "branch": "feat", "force": false })), Err(json!(super::git::worktree::dirty_line(1))));
        // A force confirmed for another count than the one there now: refused, nothing runs.
        assert_eq!(
            call("worktree_remove", json!({ "projectId": id, "branch": "feat", "force": true, "dirty": 2 })),
            Err(json!(super::git::worktree::dirty_line(1)))
        );
        assert_eq!(call("worktree_remove", json!({ "projectId": id, "branch": "feat", "force": true })), Err(json!(super::git::worktree::dirty_line(1))));
        assert!(feat.join("new.txt").is_file(), "nothing ran");

        // Force and "Also delete branch" (merged): the worktree and the branch go; the stored
        // node keeps the path, so the sessions stay discovered, now in the session group.
        let reply = call("worktree_remove", json!({ "projectId": id, "branch": "feat", "force": true, "dirty": 1, "deleteBranch": true })).expect("removed");
        assert_eq!(reply["branchDeleted"], true);
        assert_eq!(reply["deleteError"], serde_json::Value::Null);
        assert!(!feat.exists());
        let children = reply["snapshot"]["children"].as_array().unwrap();
        assert!(!children.iter().any(|c| c["id"] == format!("{id}:feat")), "the card went with the branch");
        let stored = reply["snapshot"]["workspace"]["branches"].as_array().unwrap();
        assert!(stored.iter().any(|b| b["name"] == "feat" && b["worktreePath"] == feat_s.as_str()), "{stored:?}");
        pass();
        assert_eq!(branch_of("s-feat-1"), under("feat"), "no card: the canvas puts it in the session group");

        // An app terminal started in the worktree: refused, named; nothing runs.
        let keep_s = keep.display().to_string();
        let shell = if cfg!(windows) { ("cmd.exe", vec!["/d".to_string()]) } else { ("/bin/sh", Vec::new()) };
        let (shell_bin, shell_args) = shell.clone();
        let spec_cwd = keep_s.clone();
        let info = state.terms.open(
            "plain-wt",
            &id,
            "wt-shell",
            &keep_s,
            (80, 24),
            move || Ok(super::pty::SpawnSpec::new(shell_bin, shell_args, spec_cwd)),
            std::sync::Arc::new(super::pty::EventSink(app.handle().clone())),
        );
        assert_eq!(info.exited, None, "{info:?}");
        let preview = call("worktree_remove_preview", json!({ "projectId": id, "branch": "keep" })).unwrap();
        assert_eq!(preview["refusal"], "a session is running in this worktree: wt-shell");
        assert_eq!(call("worktree_remove", json!({ "projectId": id, "branch": "keep", "force": false })), Err(json!("a session is running in this worktree: wt-shell")));
        state.terms.kill("plain-wt").unwrap();
        let started = std::time::Instant::now();
        while state.terms.list().iter().any(|t| t.id == "plain-wt" && t.exited.is_none()) {
            assert!(started.elapsed() < std::time::Duration::from_secs(10), "the shell did not exit");
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        assert!(keep.is_dir());

        // git fails the remove: its message is the error and nothing is stored.
        let real_git = git.display().to_string();
        let failing = super::process::fixtures::script(
            cfg.path(),
            "failing-git",
            &format!("@if not \"%~1\"==\"worktree\" goto run
@if \"%~2\"==\"remove\" (echo fatal: simulated failure 1>&2 & exit /b 1)
:run
@\"{real_git}\" %*
"),
            &format!("if [ \"$1 $2\" = \"worktree remove\" ]; then echo 'fatal: simulated failure' >&2; exit 1; fi
exec '{real_git}' \"$@\"
"),
        );
        state.write().binaries.git.path = Some(failing.display().to_string());
        let stored_before = state.read_workspace().workspace.branches.clone();
        assert_eq!(call("worktree_remove", json!({ "projectId": id, "branch": "keep", "force": false })), Err(json!("fatal: simulated failure")));
        assert_eq!(state.read_workspace().workspace.branches, stored_before, "no history path for a failed remove");
        assert!(keep.is_dir());
        state.write().binaries.git.path = Some(real_git.clone());

        // Clean remove, branch kept: the card stays without its chip; a branch -d refusal shows.
        std::fs::write(keep.join("b.txt"), "b").unwrap();
        super::git::branches::tests::git_ok(&git, &keep, &["add", "b.txt"]);
        super::git::branches::tests::git_ok(&git, &keep, &["commit", "-q", "-m", "unmerged"]);
        let reply = call("worktree_remove", json!({ "projectId": id, "branch": "keep", "force": false, "deleteBranch": true })).expect("removed");
        assert_eq!(reply["branchDeleted"], false);
        assert!(reply["deleteError"].as_str().unwrap().contains("not fully merged"), "{reply}");
        assert!(!keep.exists(), "the worktree stays removed");
        let card = reply["snapshot"]["children"].as_array().unwrap().iter().find(|c| c["id"] == format!("{id}:keep")).cloned().expect("the card stays");
        assert_eq!(card["branch"]["worktree"], serde_json::Value::Null, "chip gone");
        pass();
        assert_eq!(branch_of("s-keep-1"), under("keep"));
        assert_eq!(branch_of("s-keep-2"), under("keep"));

        // After a restart: the stored paths still place both sessions; the removed worktree
        // is not a known worktree any more.
        super::graph::initialise_at(app.handle(), Some(ws_path.clone()));
        pass();
        assert_eq!(branch_of("s-keep-1"), under("keep"));
        assert_eq!(branch_of("s-feat-2"), under("feat"));
        assert_eq!(branch_of("s-x"), under("worktree-x"));
        let known = state.read_workspace().worktrees.get(&id).cloned().unwrap_or_default();
        assert!(!known.iter().any(|w| w.path == keep_s), "{known:?}");

        // A missing folder: `git worktree remove <path>` clears that record.
        std::fs::remove_dir_all(&claude_wt).unwrap();
        let preview = call("worktree_remove_preview", json!({ "projectId": id, "branch": "worktree-x" })).unwrap();
        assert_eq!(preview["missing"], true);
        assert_eq!(preview["command"], format!("git worktree remove {}", preview["path"].as_str().unwrap()));
        call("worktree_remove", json!({ "projectId": id, "branch": "worktree-x", "force": false })).expect("cleared");
        assert!(!git_ok(&["worktree", "list", "--porcelain"]).contains("worktrees/x"));
        app.state::<super::AppState>().branch_watches.clear();
    }

    /// Story 5.3: `n` on a branch card. A temp repo is the `ide` project with branches on; the
    /// launcher runs the echo fixture (never `claude`), which prints its working folder and argv.
    #[test]
    fn a_session_on_a_branch_runs_in_its_folder_and_is_drawn_under_it() {
        use super::claude::launch;
        use serde_json::json;
        let Some(git) = super::git::branches::tests::real_git() else {
            eprintln!("git not on PATH; skipping");
            return;
        };
        let (app, webview, _dir, _folder, _sessions) = launch_fixture();
        let state = app.state::<super::AppState>();
        *state.launcher.program.lock().unwrap() = Some(echo_program());
        state.write().binaries.git.path = Some(git.display().to_string());
        let repo = super::git::branches::tests::temp_repo(&git);
        let top = dunce::canonicalize(repo.path()).unwrap();
        let top_s = top.display().to_string();
        state.write_workspace().workspace.projects[0].path = top_s.clone();
        let git_ok = |args: &[&str]| super::git::branches::tests::git_ok(&git, repo.path(), args);
        // A worktree made in a terminal, not by the app, and two free branches.
        let outside = tempfile::tempdir().unwrap();
        let feat_dir = dunce::canonicalize(outside.path()).unwrap().join("feat-wt");
        git_ok(&["worktree", "add", "-q", "-b", "feat", &feat_dir.display().to_string(), "main"]);
        git_ok(&["branch", "free"]);
        git_ok(&["branch", "busy"]);
        super::graph::set_show_branches(app.handle(), "ide", true).unwrap();
        tauri::async_runtime::block_on(super::git::poll::refresh_branches(app.handle(), None));
        tauri::async_runtime::block_on(super::git::poll::refresh_ids(app.handle(), &["ide".to_string()]));
        let call = |cmd: &str, args: serde_json::Value| -> Result<serde_json::Value, serde_json::Value> {
            invoke_with(&webview, cmd, InvokeBody::Json(args)).map(|body| body.deserialize().unwrap())
        };
        let output = |id: &str| super::pty::tests::strip_escapes(&state.terms.buffer(id).unwrap().data);
        // Open the sheet on `branch` (or the project), start it with `extra`, let the fixture
        // print and exit; returns the reply and what it printed.
        let start = |branch: Option<&str>, extra: serde_json::Value| -> Result<(serde_json::Value, serde_json::Value, String), serde_json::Value> {
            let prefill = call("launch_defaults", json!({ "projectId": "ide", "branch": branch }))?;
            let mut request = json!({ "projectId": "ide", "sessionId": prefill["sessionId"], "name": prefill["name"], "branch": branch });
            for (k, v) in extra.as_object().unwrap() {
                request[k] = v.clone();
            }
            let reply = call("session_launch", json!({ "request": request, "cols": 1000, "rows": 40 }))?;
            let id = reply["session_id"].as_str().unwrap().to_string();
            let term_id = format!("session:{id}");
            state.terms.write(&term_id, b"go\r").unwrap();
            wait_until(&app, &term_id, "the fixture's exit", || {
                state.read_sessions_live().sessions[&id].state == super::claude::live::SessionState::Exited
            });
            Ok((prefill, reply, output(&term_id)))
        };
        let flat = |text: &str| text.replace(['\r', '\n'], "");

        // A worktree branch (pre-existing): the sheet targets the worktree, the session runs in
        // it, the branch gains its worktreePath and the session ref its branchId.
        let (prefill, reply, text) = start(Some("feat"), json!({})).expect("feat");
        let feat = feat_dir.display().to_string();
        assert_eq!(prefill["branch"], "feat");
        assert_eq!(prefill["targetPath"], feat.as_str());
        assert_eq!(prefill["worktreePlan"], serde_json::Value::Null);
        assert_eq!(reply["term"]["cwd"], feat.as_str());
        assert!(text.contains(&feat), "runs in the worktree: {text}");
        if !cfg!(windows) {
            assert!(text.contains("Branch: feat"), "the system prompt names the branch: {text}");
        }
        let id = reply["session_id"].as_str().unwrap().to_string();
        {
            let ws = state.read_workspace();
            let stored = ws.workspace.branches.iter().find(|b| b.name == "feat").expect("feat recorded");
            assert_eq!(stored.worktree_path.as_deref(), Some(feat.as_str()));
            let session_ref = ws.workspace.sessions.iter().find(|s| s.session_id == id).expect("a ref");
            assert_eq!(session_ref.branch_id.as_deref(), Some("ide:feat"));
            let child = ws.children().into_iter().find(|c| c.id == id).expect("the session card");
            assert_eq!(child.branch_id.as_deref(), Some("ide:feat"), "drawn under feat");
        }
        assert_eq!(super::graph::project_for_cwd(&state.read_workspace().workspace, &feat).as_deref(), Some("ide"), "the live cwd maps to the project");

        // The checked-out branch: the project folder, under `main`.
        let (prefill, reply, _) = start(Some("main"), json!({})).expect("main");
        assert_eq!(prefill["targetPath"], top_s.as_str());
        assert_eq!(reply["term"]["cwd"], top_s.as_str());
        let id = reply["session_id"].as_str().unwrap().to_string();
        let child = state.read_workspace().children().into_iter().find(|c| c.id == id).unwrap();
        assert_eq!(child.branch_id.as_deref(), Some("ide:main"));

        // Refusals: nothing starts.
        let terms = state.terms.list().len();
        assert_eq!(call("launch_defaults", json!({ "projectId": "ide", "branch": "nope" })), Err(json!(launch::BRANCH_NOT_FOUND)));
        let prefill = call("launch_defaults", json!({ "projectId": "ide", "branch": "free" })).unwrap();
        let free_dir = top.join(".worktrees").join("free");
        assert_eq!(prefill["worktreePlan"]["command"], format!("git worktree add {} free", free_dir.display()));
        assert_eq!(prefill["targetPath"], free_dir.display().to_string());
        let base = json!({ "projectId": "ide", "sessionId": prefill["sessionId"], "name": prefill["name"] });
        let with = |extra: serde_json::Value| {
            let mut r = base.clone();
            for (k, v) in extra.as_object().unwrap() {
                r[k] = v.clone();
            }
            json!({ "request": r })
        };
        assert_eq!(call("session_launch", with(json!({ "branch": "free" }))), Err(json!(launch::NO_WORKTREE)));
        assert_eq!(call("session_launch", with(json!({ "branch": "gone-branch" }))), Err(json!(launch::BRANCH_NOT_FOUND)));
        assert_eq!(
            call("session_launch", with(json!({ "branch": "main", "worktreeName": "x" }))),
            Err(json!(launch::WORKTREE_FLAG_ON_BRANCH))
        );
        // The add refused (its folder is taken): nothing starts, the id is given back.
        std::fs::create_dir_all(&free_dir).unwrap();
        let err = call("session_launch", with(json!({ "branch": "free", "createWorktree": true }))).expect_err("folder taken");
        assert!(err.as_str().unwrap().starts_with(super::git::worktree::FOLDER_EXISTS), "{err}");
        std::fs::remove_dir(&free_dir).unwrap();
        assert_eq!(state.terms.list().len(), terms, "nothing started");
        assert!(!state.read_workspace().workspace.branches.iter().any(|b| b.name == "free"));

        // Create worktree here, and the start then fails: the worktree stays with its chip and
        // its stored path, no session ref is left, and the same id can be retried.
        let no_claude = (_folder.path().join("no-claude.exe"), Vec::new());
        *state.launcher.program.lock().unwrap() = Some(no_claude.clone());
        call("session_launch", with(json!({ "branch": "free", "createWorktree": true }))).expect_err("the start fails");
        let free = free_dir.display().to_string();
        assert!(free_dir.join("a.txt").is_file(), "the worktree stays");
        {
            let ws = state.read_workspace();
            let card = ws.children().into_iter().find(|c| c.id == "ide:free").expect("the branch card");
            assert_eq!(card.branch.unwrap().worktree.unwrap().path, free, "the card has its chip");
            let stored = ws.workspace.branches.iter().find(|b| b.name == "free").expect("free recorded");
            assert_eq!(stored.worktree_path.as_deref(), Some(free.as_str()));
            assert!(!ws.workspace.sessions.iter().any(|s| s.session_id == prefill["sessionId"]), "no ref");
        }
        *state.launcher.program.lock().unwrap() = Some(echo_program());

        // The retry (same id): the worktree is there now, so it simply starts in it.
        let mut created = with(json!({ "branch": "free", "createWorktree": true }));
        created["cols"] = json!(1000);
        let reply = call("session_launch", created).expect("created and started");
        assert_eq!(reply["session_id"], prefill["sessionId"], "the same id");
        assert_eq!(reply["term"]["cwd"], free.as_str());
        assert!(free_dir.join("a.txt").is_file(), "checked out");
        let id = reply["session_id"].as_str().unwrap().to_string();
        let term_id = format!("session:{id}");
        state.terms.write(&term_id, b"go\r").unwrap();
        wait_until(&app, &term_id, "the created worktree's session", || output(&term_id).contains(&free));
        {
            let ws = state.read_workspace();
            let card = ws.children().into_iter().find(|c| c.id == "ide:free").expect("the branch card");
            assert_eq!(card.branch.unwrap().worktree.unwrap().path, free, "the card has its chip");
            assert_eq!(ws.children().into_iter().find(|c| c.id == id).unwrap().branch_id.as_deref(), Some("ide:free"));
        }

        // A missing worktree folder (raced: the card still had its chip).
        let gone = top.join(".worktrees").join("busy");
        git_ok(&["worktree", "add", "-q", &gone.display().to_string(), "busy"]);
        tauri::async_runtime::block_on(super::git::poll::refresh_branches(app.handle(), None));
        let prefill = call("launch_defaults", json!({ "projectId": "ide", "branch": "busy" })).unwrap();
        std::fs::remove_dir_all(&gone).unwrap();
        let request = json!({ "projectId": "ide", "sessionId": prefill["sessionId"], "name": prefill["name"], "branch": "busy" });
        assert_eq!(call("session_launch", json!({ "request": request })), Err(json!(launch::WORKTREE_MISSING)));
        tauri::async_runtime::block_on(super::git::poll::refresh_branches(app.handle(), None));
        assert_eq!(call("launch_defaults", json!({ "projectId": "ide", "branch": "busy" })), Err(json!(launch::WORKTREE_MISSING)));

        // `--worktree` from the project's sheet: the repo's top level, `--worktree spike` in the
        // argv, `worktree-spike` recorded with Claude's folder, the session ref pointing at it.
        let (prefill, reply, text) = start(None, json!({ "worktreeName": "spike" })).expect("--worktree");
        assert_eq!(prefill["repoTop"], top_s.as_str());
        assert_eq!(prefill["targetPath"], top_s.as_str());
        assert_eq!(reply["term"]["cwd"], top_s.as_str());
        assert!(flat(&text).contains("--worktree spike --settings") || text.contains("[--worktree]\r\n[spike]\r\n[--settings]"), "{text}");
        let id = reply["session_id"].as_str().unwrap().to_string();
        {
            let ws = state.read_workspace();
            let stored = ws.workspace.branches.iter().find(|b| b.name == "worktree-spike").expect("recorded");
            let claude_dir = top.join(".claude").join("worktrees").join("spike").display().to_string();
            assert_eq!(stored.worktree_path.as_deref(), Some(claude_dir.as_str()));
            let session_ref = ws.workspace.sessions.iter().find(|s| s.session_id == id).unwrap();
            assert_eq!(session_ref.branch_id.as_deref(), Some("ide:worktree-spike"));
            assert_eq!(super::graph::project_for_cwd(&ws.workspace, &claude_dir).as_deref(), Some("ide"));
        }
        // Git does not list the branch (the fixture made none): the ref keeps the node.
        tauri::async_runtime::block_on(super::git::poll::refresh_branches(app.handle(), None));
        assert!(state.read_workspace().workspace.branches.iter().any(|b| b.name == "worktree-spike"));
        // A bad name: refused before anything starts.
        let prefill = call("launch_defaults", json!({ "projectId": "ide" })).unwrap();
        let request = json!({ "projectId": "ide", "sessionId": prefill["sessionId"], "name": prefill["name"], "worktreeName": "a..b" });
        let err = call("session_launch", json!({ "request": request })).expect_err("bad name");
        assert!(err.as_str().unwrap().contains("a..b"), "{err}");
        let request = json!({ "projectId": "ide", "sessionId": prefill["sessionId"], "name": prefill["name"], "worktreeName": "-x" });
        assert!(call("session_launch", json!({ "request": request })).is_err());

        // A start that fails after the mapping (on `main`, and with `--worktree`) leaves no
        // session ref and no new branch node, and the same id can be retried.
        for extra in [json!({ "branch": "main" }), json!({ "worktreeName": "spike2" })] {
            let prefill = call("launch_defaults", json!({ "projectId": "ide" })).unwrap();
            let id = prefill["sessionId"].as_str().unwrap().to_string();
            let mut request = json!({ "projectId": "ide", "sessionId": id, "name": prefill["name"] });
            for (k, v) in extra.as_object().unwrap() {
                request[k] = v.clone();
            }
            let branches_before = state.read_workspace().workspace.branches.clone();
            *state.launcher.program.lock().unwrap() = Some(no_claude.clone());
            call("session_launch", json!({ "request": request })).expect_err("the spawn fails");
            {
                let ws = state.read_workspace();
                assert!(!ws.workspace.sessions.iter().any(|s| s.session_id == id), "no ref: {extra}");
                assert_eq!(ws.workspace.branches, branches_before, "no new branch node: {extra}");
            }
            *state.launcher.program.lock().unwrap() = Some(echo_program());
            let reply = call("session_launch", json!({ "request": request, "cols": 1000, "rows": 40 })).expect("the retry starts");
            assert_eq!(reply["session_id"], id.as_str());
            let term_id = format!("session:{id}");
            state.terms.write(&term_id, b"go\r").unwrap();
            wait_until(&app, &term_id, "the retried session's exit", || {
                state.read_sessions_live().sessions[&id].state == super::claude::live::SessionState::Exited
            });
        }
        assert!(state.read_workspace().workspace.branches.iter().any(|b| b.name == "worktree-spike2"), "kept once started");
        state.branch_watches.clear();
    }

    #[test]
    fn a_failing_branch_read_keeps_the_last_list_and_reports_the_cause() {
        let Some(git) = super::git::branches::tests::real_git() else {
            eprintln!("git not on PATH; skipping");
            return;
        };
        let app = mock_app();
        let cfg = tempfile::tempdir().unwrap();
        super::graph::initialise_at(app.handle(), Some(cfg.path().join("workspace.json")));
        app.state::<super::AppState>().write().binaries.git.path = Some(git.display().to_string());
        let repo = super::git::branches::tests::temp_repo(&git);
        let added = super::graph::add_projects(app.handle(), &[repo.path().display().to_string()], Default::default()).unwrap();
        let id = added.added[0].clone();
        super::graph::set_show_branches(app.handle(), &id, true).unwrap();
        assert_eq!(tauri::async_runtime::block_on(super::git::poll::refresh_branches(app.handle(), None)), 1);
        assert_eq!(app.state::<super::AppState>().read_workspace().children().len(), 1);

        // A "git" that fails: the list stays, the cause is in the snapshot.
        let fail = super::process::fixtures::script(
            cfg.path(),
            "fail",
            "@echo fatal: broken refs 1>&2\n@exit /b 128\n",
            "echo 'fatal: broken refs' >&2\nexit 128\n",
        );
        app.state::<super::AppState>().write().binaries.git.path = Some(fail.display().to_string());
        tauri::async_runtime::block_on(super::git::poll::refresh_branches(app.handle(), Some(std::slice::from_ref(&id))));
        let snapshot = app.state::<super::AppState>().read_workspace().snapshot();
        assert_eq!(snapshot.children.len(), 1, "last list kept");
        assert_eq!(snapshot.branch_errors.get(&id).map(String::as_str), Some("fatal: broken refs"));

        // The folder stops being a repository: `branches unavailable`, not a silent empty group.
        app.state::<super::AppState>().write().binaries.git.path = Some(git.display().to_string());
        std::fs::remove_dir_all(repo.path().join(".git")).unwrap();
        if !super::git::status::tests::inside_work_tree(&git, repo.path()) {
            tauri::async_runtime::block_on(super::git::poll::refresh_branches(app.handle(), None));
            let snapshot = app.state::<super::AppState>().read_workspace().snapshot();
            assert_eq!(snapshot.branch_errors.get(&id).map(String::as_str), Some(super::git::poll::NOT_A_REPO));
            assert_eq!(snapshot.children.len(), 1, "last list kept");
        }
    }
}
