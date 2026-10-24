//! OS toasts for sessions that need the operator (Story 3.3). When the live poll sees a
//! session enter `Finished` or `Waiting` (from the poll, or from a hook: Story 4.3 feeds hook
//! transitions through the same [`on_transitions`]) while the main window is not
//! focused and that kind is on in `settings.notifications`, one toast names the project and
//! the session. The decision ([`decide`]) is pure; the sending goes through a [`Notifier`]:
//! the notification plugin in the app, a recorder in tests (injected into
//! `AppState::notifier`), so no test ever sends a real OS notification. A send failure is
//! logged, never shown.
//!
//! **Select on click:** each toast carries its session (and project) id in the plugin's
//! `extra` payload. A click on it (`tap`, reported by `Notification::on_action`; on Windows
//! only while the toast is on screen) focuses the main window and emits `notify://reveal`,
//! and the frontend reveals and selects that session as `ctrl+j` does.

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, Runtime};
use tauri_plugin_notification::ActionPerformed;

use crate::claude::live::{SessionState, Transition};
use crate::settings::{AppState, NotificationSettings};

/// Event name carrying a [`RevealRequest`] when a toast was clicked.
pub const REVEAL_EVENT: &str = "notify://reveal";

/// The `extra` keys a toast carries its session and project ids under.
pub const EXTRA_SESSION_ID: &str = "sessionId";
pub const EXTRA_PROJECT_ID: &str = "projectId";

/// One toast to send.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Toast {
    pub session_id: String,
    pub project_id: Option<String>,
    pub title: String,
    pub body: String,
}

/// What a click on a toast asks the frontend to reveal (`notify://reveal`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RevealRequest {
    pub session_id: String,
    /// The session's project; `None` for an Elsewhere session.
    pub project_id: Option<String>,
}

/// Something that shows an OS toast. The app uses the notification plugin
/// ([`PluginNotifier`]); tests inject a recorder.
pub trait Notifier: Send + Sync {
    fn send(&self, toast: &Toast) -> Result<(), String>;
}

/// The production sender: `tauri-plugin-notification`, called from Rust. The session and
/// project ids ride in the toast's `extra` payload, which the plugin hands back on a click.
pub struct PluginNotifier<R: Runtime> {
    app: AppHandle<R>,
}

impl<R: Runtime> Notifier for PluginNotifier<R> {
    fn send(&self, toast: &Toast) -> Result<(), String> {
        use tauri_plugin_notification::NotificationExt;
        let mut builder = self
            .app
            .notification()
            .builder()
            .title(&toast.title)
            .body(&toast.body)
            .extra(EXTRA_SESSION_ID, &toast.session_id);
        if let Some(project_id) = &toast.project_id {
            builder = builder.extra(EXTRA_PROJECT_ID, project_id);
        }
        builder.show().map_err(|err| err.to_string())
    }
}

/// The toasts a batch of transitions sends: none while the window is focused; otherwise one
/// per transition whose kind is on (`finished` / `waiting`). Title: `<project label> —
/// finished` (the cwd's folder name for an Elsewhere session); body: the session's title,
/// else its name, else `session <first 8 of id>`.
pub fn decide(transitions: &[Transition], settings: &NotificationSettings, focused: bool) -> Vec<Toast> {
    if focused {
        return Vec::new();
    }
    transitions
        .iter()
        .filter_map(|t| {
            let word = match t.state {
                SessionState::Finished if settings.finished => "finished",
                SessionState::Waiting if settings.waiting => "waiting",
                _ => return None,
            };
            Some(Toast {
                session_id: t.session_id.clone(),
                project_id: t.project_id.clone(),
                title: format!("{} — {word}", place_label(t)),
                body: session_label(t),
            })
        })
        .collect()
}

/// The project's label, or for an Elsewhere session (or a project with no label) the cwd's
/// folder name.
fn place_label(t: &Transition) -> String {
    match (&t.project_id, &t.project_label) {
        (Some(_), Some(label)) if !label.trim().is_empty() => label.clone(),
        _ => crate::graph::folder_label(&t.cwd),
    }
}

/// The session's title, else its name, else `session <first 8 of id>`.
fn session_label(t: &Transition) -> String {
    let present = |s: &Option<String>| s.as_ref().filter(|v| !v.trim().is_empty()).cloned();
    present(&t.title)
        .or_else(|| present(&t.name))
        .unwrap_or_else(|| format!("session {}", t.session_id.chars().take(8).collect::<String>()))
}

/// The sender in use: the injected one, else the plugin when it is registered, else none
/// (the mock app in tests has no plugin).
fn notifier<R: Runtime>(app: &AppHandle<R>) -> Option<std::sync::Arc<dyn Notifier>> {
    let state = app.state::<AppState>();
    if let Some(injected) = state.notifier.lock().unwrap_or_else(|e| e.into_inner()).clone() {
        return Some(injected);
    }
    app.try_state::<tauri_plugin_notification::Notification<R>>()
        .map(|_| std::sync::Arc::new(PluginNotifier { app: app.clone() }) as std::sync::Arc<dyn Notifier>)
}

/// Whether the main window has focus; no window, or a failed query, counts as unfocused.
fn main_window_focused<R: Runtime>(app: &AppHandle<R>) -> bool {
    app.get_webview_window("main")
        .map(|w| w.is_focused().unwrap_or(false))
        .unwrap_or(false)
}

/// Decide and send the toasts for `transitions` (called by the live poll). A send failure is
/// logged only.
pub fn on_transitions<R: Runtime>(app: &AppHandle<R>, transitions: &[Transition]) {
    let settings = app.state::<AppState>().read().settings.notifications.clone();
    let toasts = decide(transitions, &settings, main_window_focused(app));
    if toasts.is_empty() {
        return;
    }
    let Some(sender) = notifier(app) else {
        eprintln!("notifications: no sender registered; {} toast(s) dropped", toasts.len());
        return;
    };
    for toast in toasts {
        if let Err(err) = sender.send(&toast) {
            eprintln!("notifications: could not show \"{}\": {err}", toast.title);
        }
    }
}

/// The body of an agent request's toast (Story 7.2).
pub const APPROVAL_BODY: &str = "Allow or deny it in Switchboard";

/// Story 7.2: an agent's act tool is waiting on the operator. While the main window is not
/// focused and `notifications.waiting` is on, one toast says `<caller> wants to <action>`; it
/// carries the caller's session id, so a click brings the app forward (and reveals the caller)
/// as a 3.3 toast does. A send failure is logged only.
pub fn on_approval<R: Runtime>(app: &AppHandle<R>, caller: &str, title: &str) {
    let state = app.state::<AppState>();
    if !state.read().settings.notifications.waiting || main_window_focused(app) {
        return;
    }
    let project_id = state.read_sessions_live().sessions.get(caller).and_then(|s| s.project_id.clone());
    let Some(sender) = notifier(app) else {
        eprintln!("notifications: no sender registered; the agent request toast is dropped");
        return;
    };
    let toast = Toast {
        session_id: caller.to_string(),
        project_id,
        title: title.to_string(),
        body: APPROVAL_BODY.to_string(),
    };
    if let Err(err) = sender.send(&toast) {
        eprintln!("notifications: could not show \"{}\": {err}", toast.title);
    }
}

/// What a toast action asks for: a click on the toast itself (`tap`) whose `extra` names a
/// session reveals it; anything else (another action, a toast of no session) nothing.
pub fn reveal_for_action(action: &ActionPerformed) -> Option<RevealRequest> {
    if action.action_id() != "tap" {
        return None;
    }
    let extra = action.notification()?.extra();
    let text = |key: &str| extra.get(key).and_then(|v| v.as_str()).filter(|s| !s.is_empty()).map(str::to_string);
    Some(RevealRequest {
        session_id: text(EXTRA_SESSION_ID)?,
        project_id: text(EXTRA_PROJECT_ID),
    })
}

/// Handle one toast action: on a click on a session's toast, bring the main window forward
/// and emit `notify://reveal` for the frontend.
pub fn handle_action<R: Runtime>(app: &AppHandle<R>, action: &ActionPerformed) {
    let Some(request) = reveal_for_action(action) else {
        return;
    };
    crate::focus_main_window(app);
    if let Err(err) = app.emit(REVEAL_EVENT, &request) {
        eprintln!("notifications: emit failed: {err}");
    }
}

/// Register the click handler with the plugin (called once from `setup`); nothing without
/// the plugin.
pub fn listen_for_clicks<R: Runtime>(app: &AppHandle<R>) {
    let Some(plugin) = app.try_state::<tauri_plugin_notification::Notification<R>>() else {
        return;
    };
    let handle = app.clone();
    if let Err(err) = plugin.on_action(move |action| handle_action(&handle, action)) {
        eprintln!("notifications: cannot listen for clicks: {err}");
    }
}

#[cfg(test)]
pub mod fixtures {
    use super::{Notifier, Toast};
    use std::sync::Mutex;

    /// A [`Notifier`] that records what it was asked to show (title, body), or fails every send.
    #[derive(Default)]
    pub struct Recorder {
        pub sent: Mutex<Vec<(String, String)>>,
        pub fail: bool,
    }

    impl Notifier for Recorder {
        fn send(&self, toast: &Toast) -> Result<(), String> {
            if self.fail {
                return Err("toast server unavailable".into());
            }
            self.sent.lock().unwrap().push((toast.title.clone(), toast.body.clone()));
            Ok(())
        }
    }

    /// A plugin action as the plugin reports it: `action_id` on a toast whose `extra` is `extra`.
    pub fn action(action_id: &str, extra: serde_json::Value) -> tauri_plugin_notification::ActionPerformed {
        serde_json::from_value(serde_json::json!({
            "actionId": action_id,
            "inputValue": null,
            "notification": { "id": 7, "title": "ide — finished", "extra": extra },
        }))
        .expect("an action payload")
    }
}

#[cfg(test)]
mod tests {
    use super::fixtures::{Recorder, action};
    use super::*;
    use std::sync::Arc;
    use std::sync::mpsc;
    use tauri::Listener;
    use tauri::test::{MockRuntime, mock_builder, mock_context, noop_assets};

    fn transition(id: &str, state: SessionState, project: Option<(&str, &str)>) -> Transition {
        Transition {
            session_id: id.into(),
            state,
            project_id: project.map(|(id, _)| id.to_string()),
            cwd: if cfg!(windows) { "C:\\work\\other".into() } else { "/work/other".into() },
            name: Some(format!("name-{id}")),
            project_label: project.map(|(_, label)| label.to_string()),
            title: None,
        }
    }

    fn on() -> NotificationSettings {
        NotificationSettings::default()
    }

    #[test]
    fn focused_sends_nothing() {
        let t = [transition("s1", SessionState::Finished, Some(("ide", "ide")))];
        assert!(decide(&t, &on(), true).is_empty());
        assert_eq!(decide(&t, &on(), false).len(), 1);
    }

    #[test]
    fn a_kind_turned_off_sends_nothing_for_that_kind() {
        let t = [
            transition("s1", SessionState::Finished, Some(("ide", "ide"))),
            transition("s2", SessionState::Waiting, Some(("ide", "ide"))),
        ];
        let off = NotificationSettings { finished: false, waiting: true };
        let toasts = decide(&t, &off, false);
        assert_eq!(toasts.len(), 1);
        assert_eq!(toasts[0].title, "ide — waiting");
        let none = NotificationSettings { finished: false, waiting: false };
        assert!(decide(&t, &none, false).is_empty());
    }

    #[test]
    fn one_toast_per_transition_and_never_for_other_states() {
        let t = [
            transition("s1", SessionState::Finished, Some(("ide", "ide"))),
            transition("s2", SessionState::Finished, Some(("ide", "ide"))),
            transition("s3", SessionState::Idle, Some(("ide", "ide"))),
        ];
        let ids: Vec<String> = decide(&t, &on(), false).into_iter().map(|t| t.session_id).collect();
        assert_eq!(ids, ["s1", "s2"]);
    }

    #[test]
    fn titles_name_the_project_or_the_elsewhere_folder_and_bodies_the_session() {
        let mut t = transition("0b7c1234abcd", SessionState::Finished, Some(("p1", "ide")));
        t.title = Some("Fix the login bug".into());
        let toast = &decide(std::slice::from_ref(&t), &on(), false)[0];
        assert_eq!((toast.title.as_str(), toast.body.as_str()), ("ide — finished", "Fix the login bug"));
        assert_eq!(toast.project_id.as_deref(), Some("p1"));

        t.title = None;
        assert_eq!(decide(std::slice::from_ref(&t), &on(), false)[0].body, "name-0b7c1234abcd");
        t.name = Some("  ".into());
        assert_eq!(decide(std::slice::from_ref(&t), &on(), false)[0].body, "session 0b7c1234");

        let elsewhere = transition("s9", SessionState::Waiting, None);
        let toast = &decide(&[elsewhere], &on(), false)[0];
        assert_eq!(toast.title, "other — waiting");
        assert_eq!(toast.project_id, None);
    }

    #[test]
    fn a_tap_on_a_sessions_toast_asks_for_its_reveal_and_nothing_else_does() {
        let tap = action("tap", serde_json::json!({ "sessionId": "s1", "projectId": "ide" }));
        assert_eq!(
            reveal_for_action(&tap),
            Some(RevealRequest { session_id: "s1".into(), project_id: Some("ide".into()) })
        );
        let elsewhere = action("tap", serde_json::json!({ "sessionId": "e1" }));
        assert_eq!(reveal_for_action(&elsewhere), Some(RevealRequest { session_id: "e1".into(), project_id: None }));
        assert_eq!(reveal_for_action(&action("snooze", serde_json::json!({ "sessionId": "s1" }))), None);
        assert_eq!(reveal_for_action(&action("tap", serde_json::json!({}))), None, "not one of ours");
        let unreadable: ActionPerformed =
            serde_json::from_value(serde_json::json!({ "actionId": "tap", "inputValue": null, "notification": { "id": "x" } })).unwrap();
        assert_eq!(reveal_for_action(&unreadable), None);
    }

    fn mock_app() -> tauri::App<MockRuntime> {
        crate::with_commands(mock_builder())
            .build(mock_context(noop_assets()))
            .expect("mock app should build")
    }

    fn inject(app: &tauri::App<MockRuntime>, recorder: Arc<Recorder>) {
        *app.state::<AppState>().notifier.lock().unwrap() = Some(recorder);
    }

    #[test]
    fn a_tap_focuses_the_window_and_emits_the_reveal() {
        let app = mock_app();
        let _webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .expect("mock webview should build");
        let (tx, rx) = mpsc::channel();
        app.listen_any(REVEAL_EVENT, move |event| {
            let _ = tx.send(serde_json::from_str::<RevealRequest>(event.payload()).unwrap());
        });
        handle_action(app.handle(), &action("snooze", serde_json::json!({ "sessionId": "s1" })));
        assert!(rx.try_recv().is_err());
        handle_action(app.handle(), &action("tap", serde_json::json!({ "sessionId": "s1", "projectId": "ide" })));
        assert_eq!(rx.try_recv().unwrap(), RevealRequest { session_id: "s1".into(), project_id: Some("ide".into()) });
        // Without the plugin there is nothing to listen to; this must not panic.
        listen_for_clicks(app.handle());
    }

    #[test]
    fn toasts_go_through_the_injected_notifier() {
        let app = mock_app();
        let recorder = Arc::new(Recorder::default());
        inject(&app, recorder.clone());
        on_transitions(
            app.handle(),
            &[
                transition("s1", SessionState::Finished, Some(("ide", "ide"))),
                transition("s2", SessionState::Finished, None),
            ],
        );
        assert_eq!(
            *recorder.sent.lock().unwrap(),
            [("ide — finished".to_string(), "name-s1".to_string()), ("other — finished".to_string(), "name-s2".to_string())]
        );
    }

    #[test]
    fn a_send_failure_is_only_logged() {
        let app = mock_app();
        inject(&app, Arc::new(Recorder { fail: true, ..Recorder::default() }));
        on_transitions(app.handle(), &[transition("s1", SessionState::Finished, Some(("ide", "ide")))]);
        assert!(app.state::<AppState>().read().snapshot().banners.is_empty(), "never a banner");
    }

    #[test]
    fn without_a_sender_nothing_is_sent_and_nothing_panics() {
        // The mock app has no notification plugin and nothing is injected.
        let app = mock_app();
        on_transitions(app.handle(), &[transition("s1", SessionState::Finished, Some(("ide", "ide")))]);
    }

    #[test]
    fn a_kind_turned_off_in_settings_sends_nothing() {
        let app = mock_app();
        let recorder = Arc::new(Recorder::default());
        inject(&app, recorder.clone());
        app.state::<AppState>().write().settings.notifications.finished = false;
        on_transitions(app.handle(), &[transition("s1", SessionState::Finished, Some(("ide", "ide")))]);
        assert!(recorder.sent.lock().unwrap().is_empty());
    }
}
