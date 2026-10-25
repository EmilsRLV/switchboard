//! The tray icon and close-to-tray (Story 9.2).
//!
//! The icon is created once in `setup` and shown for as long as the app runs: the app icon,
//! a tooltip `Switchboard — 2 busy · 1 waiting` (or `Switchboard — no live sessions`) and a menu
//! of **Show Switchboard**, a disabled line with the same counts, and **Quit** (which exits
//! exactly as `ctrl+q` does). A left click brings the main window back (`focus_main_window`);
//! Linux reports no tray clicks, so there the menu's Show does it.
//!
//! **Counts** come from the live map: busy is `busy` or `starting`, waiting is `waiting` or
//! `finished` (the Story 3.3 "needs you" states). They are recomputed on every `sessions://live`
//! emit ([`on_live`], called by `claude::live`) and pushed to the icon on the main thread, only
//! when they changed.
//!
//! **Closing the main window** ([`hide_on_close`]): with `close_to_tray` on (off by default) and
//! a tray icon present the window is hidden instead of closed (minimized on Linux, where an
//! indicator can load with no tray host to show it, so a hidden window might never come back),
//! and sessions, terminals and pop-out windows keep running. The first such close of each run
//! sends one toast, `Switchboard is still running in the tray` (when `notifications.tray` is on
//! and the OS allows it). Otherwise, or when hiding fails, the close goes ahead and the app quits
//! as before. Without a tray closing always quits, and the `tray.unavailable` banner says so. On
//! Linux the tray is not even tried without the appindicator library, whose absence can panic
//! inside the build.

use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, Runtime};

use crate::claude::live::{LiveSnapshot, SessionState};
use crate::settings::{AppState, Banner};

/// The tray icon's id.
pub const TRAY_ID: &str = "main";
/// The banner shown when the tray icon could not be created.
pub const BANNER_ID: &str = "tray.unavailable";
pub const BANNER_TEXT: &str = "tray unavailable: closing the window quits";
/// The one toast of the first hide in each run.
pub const HINT_TEXT: &str = "Switchboard is still running in the tray";
/// The menu's entries.
pub const MENU_SHOW: &str = "tray.show";
pub const MENU_COUNTS: &str = "tray.counts";
pub const MENU_QUIT: &str = "tray.quit";
pub const SHOW_TEXT: &str = "Show Switchboard";
pub const QUIT_TEXT: &str = "Quit";

/// Busy and waiting sessions, and how many sessions are live at all.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Counts {
    /// `busy` or `starting`.
    pub busy: usize,
    /// `waiting` or `finished`.
    pub waiting: usize,
    /// Every session not `exited`.
    pub live: usize,
}

/// Count the live map's sessions.
pub fn counts(snapshot: &LiveSnapshot) -> Counts {
    let mut c = Counts::default();
    for session in snapshot.sessions.values() {
        match session.state {
            SessionState::Busy | SessionState::Starting => c.busy += 1,
            SessionState::Waiting | SessionState::Finished => c.waiting += 1,
            _ => {}
        }
        if session.state.is_live() {
            c.live += 1;
        }
    }
    c
}

/// The menu's counts line: `2 busy · 1 waiting`, or `no live sessions`.
pub fn counts_text(c: Counts) -> String {
    if c.live == 0 {
        "no live sessions".to_string()
    } else {
        format!("{} busy · {} waiting", c.busy, c.waiting)
    }
}

/// The icon's tooltip: `Switchboard — <counts line>`.
pub fn tooltip(c: Counts) -> String {
    format!("Switchboard — {}", counts_text(c))
}

/// What closing the main window does.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CloseAction {
    /// Hide the window to the tray; everything keeps running.
    Hide,
    /// Linux: minimize the window to the taskbar; everything keeps running.
    Minimize,
    /// Let the close go ahead: the app quits.
    Quit,
}

/// Hide (minimize on Linux) only when the setting asks for it and there is a tray to come back
/// from.
pub fn close_action(close_to_tray: bool, tray_ok: bool, linux: bool) -> CloseAction {
    match (close_to_tray && tray_ok, linux) {
        (false, _) => CloseAction::Quit,
        (true, false) => CloseAction::Hide,
        (true, true) => CloseAction::Minimize,
    }
}

/// Whether `ldconfig -p` output lists an appindicator library the tray can load.
pub fn ldconfig_lists_appindicator(text: &str) -> bool {
    text.lines().any(|line| {
        let name = line.trim_start();
        name.starts_with("libayatana-appindicator3.so") || name.starts_with("libappindicator3.so")
    })
}

/// Whether `dir` holds an appindicator library file.
pub fn dir_has_appindicator(dir: &std::path::Path) -> bool {
    std::fs::read_dir(dir).is_ok_and(|entries| {
        entries.flatten().any(|e| {
            let name = e.file_name();
            let name = name.to_string_lossy();
            name.starts_with("libayatana-appindicator3.so") || name.starts_with("libappindicator3.so")
        })
    })
}

/// Linux: is an appindicator library present? `ldconfig -p` first, then `LD_LIBRARY_PATH` (an
/// AppImage bundles its own) and the usual library folders.
#[cfg(target_os = "linux")]
fn appindicator_available() -> bool {
    for ldconfig in ["ldconfig", "/sbin/ldconfig", "/usr/sbin/ldconfig"] {
        if let Ok(out) = std::process::Command::new(ldconfig).arg("-p").output()
            && out.status.success()
            && ldconfig_lists_appindicator(&String::from_utf8_lossy(&out.stdout))
        {
            return true;
        }
    }
    let from_env = std::env::var_os("LD_LIBRARY_PATH")
        .map(|v| std::env::split_paths(&v).collect::<Vec<_>>())
        .unwrap_or_default();
    let usual = ["/usr/lib", "/usr/lib64", "/usr/lib/x86_64-linux-gnu", "/lib/x86_64-linux-gnu", "/usr/local/lib"]
        .map(std::path::PathBuf::from);
    from_env.iter().chain(usual.iter()).any(|dir| dir_has_appindicator(dir))
}

/// The tray's runtime state in [`AppState`] (not generic over the runtime; the icon itself is
/// managed separately as [`TrayParts`]).
#[derive(Debug, Default)]
pub struct TrayState {
    /// The icon was created.
    pub ok: AtomicBool,
    /// This run has already sent the "still running in the tray" toast.
    pub hinted: AtomicBool,
    /// The counts last pushed to the icon.
    last: Mutex<Option<Counts>>,
}

/// The icon and its counts line, managed by the app once created.
pub struct TrayParts<R: Runtime> {
    pub tray: TrayIcon<R>,
    pub counts: MenuItem<R>,
}

/// Create the tray icon (from `setup`, before the first settings snapshot goes out). A failure
/// is logged and raises the `tray.unavailable` banner; closing then always quits.
pub fn setup<R: Runtime>(app: &AppHandle<R>) {
    record_setup(&app.state::<AppState>(), create(app));
}

/// Record how creating the tray went: `ok` and no banner, or the `tray.unavailable` banner.
pub fn record_setup(state: &AppState, result: Result<(), String>) {
    match result {
        Ok(()) => {
            state.tray.ok.store(true, Ordering::SeqCst);
            state.write().tray_banner = None;
        }
        Err(err) => {
            eprintln!("tray: cannot create the tray icon: {err}");
            state.tray.ok.store(false, Ordering::SeqCst);
            state.write().tray_banner = Some(Banner::new(BANNER_ID, BANNER_TEXT));
        }
    }
}

fn create<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    if !appindicator_available() {
        return Err("no libayatana-appindicator3 or libappindicator3 found".to_string());
    }
    build(app).map_err(|err| err.to_string())
}

fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let state = app.state::<AppState>();
    let c = counts(&state.read_sessions_live().snapshot());
    let show = MenuItem::with_id(app, MENU_SHOW, SHOW_TEXT, true, None::<&str>)?;
    let line = MenuItem::with_id(app, MENU_COUNTS, counts_text(c), false, None::<&str>)?;
    let quit = MenuItem::with_id(app, MENU_QUIT, QUIT_TEXT, true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(app, &[&show, &line, &separator, &quit])?;
    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .tooltip(tooltip(c))
        .on_menu_event(|app, event| match event.id().as_ref() {
            MENU_SHOW => crate::focus_main_window(app),
            // The same exit as `ctrl+q` (`ipc::app_quit`): `on_run_event` stops every session.
            MENU_QUIT => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                crate::focus_main_window(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    let tray = builder.build(app)?;
    *state.tray.last.lock().unwrap_or_else(|e| e.into_inner()) = Some(c);
    app.manage(TrayParts { tray, counts: line });
    Ok(())
}

/// The live map changed (`claude::live` calls this beside every `sessions://live` emit, under
/// the map's lock, so calls arrive in order). When the counts changed, the icon's tooltip and
/// counts line are updated on the main thread; this never blocks on it (the main thread may be
/// waiting for the map's lock).
pub fn on_live<R: Runtime>(app: &AppHandle<R>, snapshot: &LiveSnapshot) {
    let state = app.state::<AppState>();
    if !state.tray.ok.load(Ordering::SeqCst) {
        return;
    }
    let c = counts(snapshot);
    {
        let mut last = state.tray.last.lock().unwrap_or_else(|e| e.into_inner());
        if *last == Some(c) {
            return;
        }
        *last = Some(c);
    }
    let handle = app.clone();
    if let Err(err) = app.run_on_main_thread(move || apply(&handle, c)) {
        eprintln!("tray: cannot update the counts: {err}");
        forget(app);
    }
}

/// Forget the counts last pushed, so the next live emit pushes again.
fn forget<R: Runtime>(app: &AppHandle<R>) {
    *app.state::<AppState>().tray.last.lock().unwrap_or_else(|e| e.into_inner()) = None;
}

/// Push `c` to the icon (on the main thread). A failure forgets the counts, so the next live
/// emit tries again.
fn apply<R: Runtime>(app: &AppHandle<R>, c: Counts) {
    let Some(parts) = app.try_state::<TrayParts<R>>() else {
        return;
    };
    let tooltip = parts.tray.set_tooltip(Some(tooltip(c)));
    let line = parts.counts.set_text(counts_text(c));
    if let Err(err) = tooltip.and(line) {
        eprintln!("tray: cannot update the counts: {err}");
        forget(app);
    }
}

/// The main window was asked to close. Returns whether the close is to be prevented: with
/// [`CloseAction::Hide`] / [`CloseAction::Minimize`] the window is hidden / minimized and, only
/// when that worked, the close is prevented (and the run's first such close sends the one toast;
/// `hinted` is set once it was really sent). With [`CloseAction::Quit`], a missing window or a
/// failed hide, the close goes ahead.
pub fn hide_on_close<R: Runtime>(app: &AppHandle<R>) -> bool {
    let state = app.state::<AppState>();
    let close_to_tray = state.read().settings.close_to_tray;
    let action = close_action(close_to_tray, state.tray.ok.load(Ordering::SeqCst), cfg!(target_os = "linux"));
    if action == CloseAction::Quit {
        return false;
    }
    let Some(window) = app.get_webview_window(crate::MAIN_WINDOW) else {
        return false;
    };
    let done = if action == CloseAction::Hide { window.hide() } else { window.minimize() };
    if let Err(err) = done {
        eprintln!("tray: cannot {action:?} the window, closing instead: {err}");
        return false;
    }
    if !state.tray.hinted.load(Ordering::SeqCst) && crate::notify::on_hidden_to_tray(app) {
        state.tray.hinted.store(true, Ordering::SeqCst);
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::claude::live::{LiveSession, StateSource};
    use crate::notify::fixtures::Recorder;
    use std::sync::Arc;
    use tauri::test::{MockRuntime, mock_builder, mock_context, noop_assets};

    fn session(state: SessionState) -> LiveSession {
        LiveSession {
            state,
            source: StateSource::Poll,
            pid: None,
            kind: None,
            name: None,
            project_id: None,
            cwd: "/w".into(),
            started_at: None,
            attention_since: None,
            last_line: None,
            detail: None,
            status_text: None,
        }
    }

    fn snapshot(states: Vec<SessionState>) -> LiveSnapshot {
        LiveSnapshot {
            sessions: states.into_iter().enumerate().map(|(i, s)| (format!("s{i}"), session(s))).collect(),
            elsewhere: vec![],
            banner: None,
        }
    }

    #[test]
    fn busy_counts_busy_and_starting_and_waiting_counts_waiting_and_finished() {
        let c = counts(&snapshot(vec![
            SessionState::Busy,
            SessionState::Starting,
            SessionState::Waiting,
            SessionState::Finished,
            SessionState::Finished,
            SessionState::Idle,
            SessionState::Other { raw: "compacting".into() },
            SessionState::Exited,
        ]));
        assert_eq!(c, Counts { busy: 2, waiting: 3, live: 7 });
        assert_eq!(counts(&snapshot(vec![])), Counts::default());
    }

    #[test]
    fn the_texts_name_the_counts_or_no_live_sessions() {
        assert_eq!(tooltip(Counts { busy: 2, waiting: 1, live: 4 }), "Switchboard — 2 busy · 1 waiting");
        assert_eq!(tooltip(Counts { busy: 2, waiting: 0, live: 2 }), "Switchboard — 2 busy · 0 waiting");
        assert_eq!(counts_text(Counts { busy: 0, waiting: 0, live: 1 }), "0 busy · 0 waiting");
        assert_eq!(tooltip(Counts::default()), "Switchboard — no live sessions");
        // Only exited sessions: nothing is live.
        assert_eq!(counts_text(counts(&snapshot(vec![SessionState::Exited]))), "no live sessions");
    }

    #[test]
    fn closing_hides_only_with_the_setting_on_and_a_tray_and_minimizes_on_linux() {
        assert_eq!(close_action(true, true, false), CloseAction::Hide);
        assert_eq!(close_action(true, true, true), CloseAction::Minimize);
        for linux in [false, true] {
            assert_eq!(close_action(false, true, linux), CloseAction::Quit);
            assert_eq!(close_action(true, false, linux), CloseAction::Quit);
            assert_eq!(close_action(false, false, linux), CloseAction::Quit);
        }
    }

    #[test]
    fn the_appindicator_check_reads_ldconfig_and_folders() {
        let listed = "1234 libs found in cache `/etc/ld.so.cache'\n\tlibayatana-appindicator3.so.1 (libc6,x86-64) => /lib/x86_64-linux-gnu/libayatana-appindicator3.so.1\n";
        assert!(ldconfig_lists_appindicator(listed));
        assert!(ldconfig_lists_appindicator("\tlibappindicator3.so.1 (libc6,x86-64) => /usr/lib/libappindicator3.so.1"));
        assert!(!ldconfig_lists_appindicator("\tlibayatana-indicator3.so.7 (libc6,x86-64) => /x\n\tlibgtk-3.so.0 => /y"));
        let dir = tempfile::tempdir().unwrap();
        assert!(!dir_has_appindicator(dir.path()));
        std::fs::write(dir.path().join("libayatana-appindicator3.so.1"), b"").unwrap();
        assert!(dir_has_appindicator(dir.path()));
        assert!(!dir_has_appindicator(&dir.path().join("missing")));
    }

    #[test]
    fn record_setup_sets_ok_or_raises_the_banner() {
        let state = AppState::default();
        record_setup(&state, Err("no tray host".into()));
        assert!(!state.tray.ok.load(Ordering::SeqCst));
        assert_eq!(state.read().tray_banner, Some(Banner::new(BANNER_ID, BANNER_TEXT)));
        assert_eq!(state.read().snapshot().banners.last().unwrap().id, "tray.unavailable");
        record_setup(&state, Ok(()));
        assert!(state.tray.ok.load(Ordering::SeqCst));
        assert_eq!(state.read().tray_banner, None);
    }

    fn bare_app() -> tauri::App<MockRuntime> {
        crate::with_commands(mock_builder())
            .build(mock_context(noop_assets()))
            .expect("mock app should build")
    }

    fn mock_app() -> tauri::App<MockRuntime> {
        let app = bare_app();
        tauri::WebviewWindowBuilder::new(&app, crate::MAIN_WINDOW, Default::default())
            .build()
            .expect("mock webview should build");
        app
    }

    fn tray_on(app: &tauri::App<MockRuntime>) {
        let state = app.state::<AppState>();
        state.tray.ok.store(true, Ordering::SeqCst);
        state.write().settings.close_to_tray = true;
    }

    fn recorder(app: &tauri::App<MockRuntime>) -> Arc<Recorder> {
        let recorder = Arc::new(Recorder::default());
        *app.state::<AppState>().notifier.lock().unwrap() = Some(recorder.clone());
        recorder
    }

    #[test]
    fn with_a_tray_and_the_setting_on_the_close_is_prevented_and_the_toast_sent_once() {
        let app = mock_app();
        let recorder = recorder(&app);
        tray_on(&app);

        assert!(hide_on_close(app.handle()));
        assert!(hide_on_close(app.handle()), "every close hides");
        let sent = recorder.sent.lock().unwrap().clone();
        assert_eq!(sent.len(), 1, "one toast per run");
        assert_eq!(sent[0].0, HINT_TEXT);
        assert!(app.state::<AppState>().tray.hinted.load(Ordering::SeqCst));
    }

    #[test]
    fn a_hint_that_was_not_sent_is_tried_again_at_the_next_close() {
        let app = mock_app();
        tray_on(&app);
        let state = app.state::<AppState>();
        state.write().settings.notifications.tray = false;
        assert!(hide_on_close(app.handle()), "the window still hides");
        assert!(!state.tray.hinted.load(Ordering::SeqCst));
        state.write().settings.notifications.tray = true;
        let recorder = recorder(&app);
        assert!(hide_on_close(app.handle()));
        assert_eq!(recorder.sent.lock().unwrap().len(), 1);
        assert!(state.tray.hinted.load(Ordering::SeqCst));
    }

    #[test]
    fn with_the_setting_off_or_no_tray_or_no_window_the_close_goes_ahead() {
        let app = mock_app();
        let recorder = recorder(&app);
        let state = app.state::<AppState>();
        assert!(!state.read().settings.close_to_tray, "off by default");
        state.tray.ok.store(true, Ordering::SeqCst);
        assert!(!hide_on_close(app.handle()));
        // No tray (the mock app never created one): close quits even with the setting on.
        state.tray.ok.store(false, Ordering::SeqCst);
        state.write().settings.close_to_tray = true;
        assert!(!hide_on_close(app.handle()));
        assert!(recorder.sent.lock().unwrap().is_empty());

        // No main window to hide: never prevent the close, no hint.
        let bare = bare_app();
        let recorder = super::tests::recorder(&bare);
        tray_on(&bare);
        assert!(!hide_on_close(bare.handle()));
        assert!(recorder.sent.lock().unwrap().is_empty());
        assert!(!bare.state::<AppState>().tray.hinted.load(Ordering::SeqCst));
    }

    #[test]
    fn the_counts_follow_the_live_map_through_apply_and_emit() {
        let app = mock_app();
        app.state::<AppState>().tray.ok.store(true, Ordering::SeqCst);
        let row = |status: &str| crate::claude::live::LiveRow {
            session_id: "s1".into(),
            cwd: if cfg!(windows) { "C:\\work\\other".into() } else { "/work/other".into() },
            pid: None,
            kind: None,
            started_at: None,
            name: None,
            status: Some(status.into()),
        };
        let last = || *app.state::<AppState>().tray.last.lock().unwrap();
        crate::claude::live::apply_and_emit(app.handle(), Ok(vec![row("busy")]));
        assert_eq!(last(), Some(Counts { busy: 1, waiting: 0, live: 1 }));
        // busy -> idle is a finished turn: it needs you, so it counts as waiting.
        crate::claude::live::apply_and_emit(app.handle(), Ok(vec![row("idle")]));
        assert_eq!(last(), Some(Counts { busy: 0, waiting: 1, live: 1 }));
    }

    #[test]
    fn live_updates_without_a_tray_or_an_icon_do_nothing_and_never_panic() {
        let app = mock_app();
        let snap = snapshot(vec![SessionState::Busy]);
        on_live(app.handle(), &snap);
        assert_eq!(*app.state::<AppState>().tray.last.lock().unwrap(), None, "no tray: nothing tracked");
        app.state::<AppState>().tray.ok.store(true, Ordering::SeqCst);
        on_live(app.handle(), &snap);
        assert_eq!(*app.state::<AppState>().tray.last.lock().unwrap(), Some(Counts { busy: 1, waiting: 0, live: 1 }));
    }
}
