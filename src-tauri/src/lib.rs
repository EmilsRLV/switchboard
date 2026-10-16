//! Switchboard core. Rust is the source of truth; the webview talks to it only
//! through the thin commands in [`ipc`].

pub mod ipc;
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
            ipc::app_quit,
        ])
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
        .plugin(tauri_plugin_opener::init());
    with_commands(builder)
        .setup(|app| {
            settings::initialise(app.handle());
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
                body: InvokeBody::default(),
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
