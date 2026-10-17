//! Switchboard core. Rust is the source of truth; the webview talks to it only
//! through the thin commands in [`ipc`].

pub mod claude;
pub mod git;
pub mod graph;
pub mod ipc;
pub mod persist;
pub mod process;
pub mod settings;

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
            ipc::workspace_move_node,
            ipc::workspace_relayout_children,
            ipc::claude_projects_list,
            ipc::projects_status_get,
            ipc::workspace_remove_project,
            ipc::project_open_editor,
            ipc::project_open_folder,
            ipc::project_reveal_claude_dir,
            ipc::app_quit,
        ])
}

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
        .plugin(tauri_plugin_window_state::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init());
    with_commands(builder)
        .setup(|app| {
            use tauri::Manager;
            settings::initialise(app.handle());
            // Read once, before the workspace loads and copies it; off by default.
            let stubs = stub_children_from_env(std::env::var(STUB_CHILDREN_ENV).ok().as_deref());
            let _ = app.state::<AppState>().stub_children.set(stubs);
            graph::initialise(app.handle());
            if let Some(home) = claude::claude_home() {
                let _ = app.state::<AppState>().claude_home.set(home);
            }
            git::poll::start(app.handle().clone());
            claude::sessions::start(app.handle().clone());
            Ok(())
        })
}

/// Bring the `main` window to the front: un-minimise, show, focus. Each step is best effort;
/// a window the OS refuses to focus is not an error worth surfacing.
fn focus_main_window<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    use tauri::Manager;
    let Some(window) = app.get_webview_window("main") else {
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
        .run(tauri::generate_context!())
        .expect("error while running Switchboard");
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
    fn a_misspelt_command_is_rejected() {
        let app = mock_app();
        let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .expect("mock webview should build");

        invoke(&webview, "app_quitt").expect_err("unknown wire names must not resolve");
    }
}
