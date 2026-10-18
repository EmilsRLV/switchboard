//! Pop-out terminal windows (Story 4.5). Rust owns them: `term_pop_out` builds a
//! `WebviewWindow` labelled `term-<n>` that loads the app at `index.html?terminal=<id>`, and
//! [`PopOuts`] records which terminal each one hosts. Every change is emitted as
//! `term://popped { id, label | null }`. A pop-out never spawns anything: it reads the same
//! PTY stream (`term://data` goes to every webview) and writes through `term_write`.
//!
//! A terminal is in at most one pop-out. The record goes when the window is destroyed by any
//! means (its close button, `term_return`, the app quitting), and `on_run_event` hands every
//! destroyed `term-*` window to [`window_destroyed`].

use std::collections::{HashMap, HashSet};
use std::sync::{Mutex, MutexGuard};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, Runtime, WebviewUrl, WebviewWindowBuilder};

use crate::settings::AppState;

/// Emitted with a [`PoppedPayload`] whenever a terminal pops out or returns.
pub const POPPED_EVENT: &str = "term://popped";

/// Every pop-out window's label starts with this (the capability matches `term-*`).
pub const LABEL_PREFIX: &str = "term-";

/// A pop-out's first size, in logical pixels.
pub const WIDTH: f64 = 900.0;
pub const HEIGHT: f64 = 600.0;
/// The smallest a pop-out can be made, in logical pixels.
pub const MIN_WIDTH: f64 = 480.0;
pub const MIN_HEIGHT: f64 = 320.0;

/// A pop-out's native background (shown before the page paints): `--bg-raised` from
/// `src/theme/tokens.css` (a test keeps the two equal).
pub const BACKGROUND: (u8, u8, u8) = (0x16, 0x19, 0x20);

/// What follows the terminal's title in its window's title.
pub const TITLE_SUFFIX: &str = "Switchboard terminal";

/// `term://popped`: terminal `id` is now in window `label`, or back in the pane (`None`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PoppedPayload {
    pub id: String,
    pub label: Option<String>,
}

/// What [`PopOuts::claim`] found for a terminal.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Claim {
    /// It already has a window: this one.
    Existing(String),
    /// It had none: this fresh label is now reserved for it.
    New(String),
}

#[derive(Debug, Default)]
struct Inner {
    /// The last label number handed out; labels are never reused within a run.
    next: u64,
    /// Terminal id → the label of the window hosting it.
    popped: HashMap<String, String>,
    /// Labels claimed whose window is still being built: a second pop-out of the same terminal
    /// meanwhile answers with that label and builds nothing.
    building: HashSet<String>,
}

/// Which terminal is popped out into which window. Memory only, never persisted.
#[derive(Debug, Default)]
pub struct PopOuts {
    inner: Mutex<Inner>,
}

fn lock(mutex: &Mutex<Inner>) -> MutexGuard<'_, Inner> {
    mutex.lock().unwrap_or_else(|e| e.into_inner())
}

impl PopOuts {
    /// The window of `id` when it has one, else a fresh `term-<n>` label reserved for it (so a
    /// second pop-out of the same terminal never builds a second window).
    pub fn claim(&self, id: &str) -> Claim {
        let mut inner = lock(&self.inner);
        if let Some(label) = inner.popped.get(id) {
            return Claim::Existing(label.clone());
        }
        inner.next += 1;
        let label = format!("{LABEL_PREFIX}{}", inner.next);
        inner.popped.insert(id.to_string(), label.clone());
        inner.building.insert(label.clone());
        Claim::New(label)
    }

    /// True while window `label` is being built.
    pub fn is_building(&self, label: &str) -> bool {
        lock(&self.inner).building.contains(label)
    }

    /// Window `label` was built (or failed to be).
    pub fn finish_build(&self, label: &str) {
        lock(&self.inner).building.remove(label);
    }

    /// The label of the window hosting `id`, if any.
    pub fn label(&self, id: &str) -> Option<String> {
        lock(&self.inner).popped.get(id).cloned()
    }

    /// Forget `id`'s window only while the record still names `label`. Whether it did.
    pub fn release(&self, id: &str, label: &str) -> bool {
        let mut inner = lock(&self.inner);
        if inner.popped.get(id).map(String::as_str) != Some(label) {
            return false;
        }
        inner.popped.remove(id);
        true
    }

    /// Window `label` is gone: forget it, and say which terminal it hosted (`None` when the
    /// record had already moved on).
    pub fn release_window(&self, label: &str) -> Option<String> {
        let mut inner = lock(&self.inner);
        let id = inner.popped.iter().find(|(_, l)| l.as_str() == label).map(|(id, _)| id.clone())?;
        inner.popped.remove(&id);
        Some(id)
    }

    /// Forget `id`'s window, returning its label.
    pub fn take(&self, id: &str) -> Option<String> {
        lock(&self.inner).popped.remove(id)
    }

    /// Forget every window, returning `(id, label)` pairs sorted by id.
    pub fn take_all(&self) -> Vec<(String, String)> {
        let mut all: Vec<(String, String)> = lock(&self.inner).popped.drain().collect();
        all.sort();
        all
    }

    /// Every popped-out terminal, sorted by id (`term_popped`, for a reloaded main window).
    pub fn list(&self) -> Vec<PoppedPayload> {
        let mut all: Vec<PoppedPayload> = lock(&self.inner)
            .popped
            .iter()
            .map(|(id, label)| PoppedPayload { id: id.clone(), label: Some(label.clone()) })
            .collect();
        all.sort_by(|a, b| a.id.cmp(&b.id));
        all
    }
}

/// True for a pop-out window's label.
pub fn is_popout_label(label: &str) -> bool {
    label.strip_prefix(LABEL_PREFIX).is_some_and(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()))
}

/// The app URL a pop-out of `id` loads: `index.html?terminal=<id>`, the id percent-encoded
/// (a session terminal's id has a `:`).
pub fn url_for(id: &str) -> String {
    let mut encoded = String::with_capacity(id.len());
    for byte in id.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') {
            encoded.push(byte as char);
        } else {
            encoded.push_str(&format!("%{byte:02X}"));
        }
    }
    format!("index.html?terminal={encoded}")
}

/// A pop-out's title: `<terminal title> — Switchboard terminal`.
pub fn window_title(title: &str) -> String {
    let title = title.trim();
    if title.is_empty() {
        TITLE_SUFFIX.to_string()
    } else {
        format!("{title} — {TITLE_SUFFIX}")
    }
}

fn emit<R: Runtime>(app: &AppHandle<R>, id: &str, label: Option<String>) {
    let _ = app.emit(POPPED_EVENT, PoppedPayload { id: id.to_string(), label });
}

fn focus<R: Runtime>(window: &tauri::WebviewWindow<R>) {
    if window.is_minimized().unwrap_or(true) {
        let _ = window.unminimize();
    }
    let _ = window.show();
    let _ = window.set_focus();
}

/// Pop terminal `id` out into its own window, or focus the window it is already in. Replies
/// with the window's label. An unknown terminal, or a window the OS would not create, is an
/// `Err` (and nothing is recorded).
pub fn pop_out<R: Runtime>(app: &AppHandle<R>, id: &str) -> Result<String, String> {
    let state = app.state::<AppState>();
    let term = state.terms.get(id).ok_or_else(|| "unknown terminal".to_string())?;
    let label = match state.popouts.claim(id) {
        Claim::Existing(label) => {
            // Its window is still being built (another pop-out of it is under way): that one is it.
            // Checked before looking the window up: a build that finishes in between has
            // registered the window already.
            if state.popouts.is_building(&label) {
                return Ok(label);
            }
            if let Some(window) = app.get_webview_window(&label) {
                focus(&window);
                return Ok(label);
            }
            // The record outlived its window: start afresh.
            if state.popouts.release(id, &label) {
                emit(app, id, None);
            }
            match state.popouts.claim(id) {
                Claim::New(label) => label,
                // Another pop-out of the same terminal got in between: that one is it.
                Claim::Existing(label) => return Ok(label),
            }
        }
        Claim::New(label) => label,
    };
    let built = WebviewWindowBuilder::new(app, &label, WebviewUrl::App(url_for(id).into()))
        .title(window_title(&term.info().title))
        .inner_size(WIDTH, HEIGHT)
        .min_inner_size(MIN_WIDTH, MIN_HEIGHT)
        .resizable(true)
        .theme(Some(tauri::Theme::Dark))
        .background_color(tauri::window::Color(BACKGROUND.0, BACKGROUND.1, BACKGROUND.2, 0xff))
        .build();
    state.popouts.finish_build(&label);
    match built {
        Ok(_) => {
            emit(app, id, Some(label.clone()));
            Ok(label)
        }
        Err(err) => {
            state.popouts.release(id, &label);
            Err(format!("could not open the terminal window: {err}"))
        }
    }
}

/// Terminal `id`'s title changed (a restart, a resume): its pop-out's native title follows.
pub fn retitle<R: Runtime>(app: &AppHandle<R>, id: &str, title: &str) {
    if let Some(label) = app.state::<AppState>().popouts.label(id)
        && let Some(window) = app.get_webview_window(&label)
    {
        let _ = window.set_title(&window_title(title));
    }
}

/// Return terminal `id` to the pane: forget its window, tell every webview, close the window.
/// A terminal that is not popped out is left alone.
pub fn return_to_pane<R: Runtime>(app: &AppHandle<R>, id: &str) {
    let Some(label) = app.state::<AppState>().popouts.take(id) else {
        return;
    };
    emit(app, id, None);
    if let Some(window) = app.get_webview_window(&label) {
        let _ = window.destroy();
    }
}

/// A `term-*` window was destroyed (closed by any means): its terminal returns to the pane.
pub fn window_destroyed<R: Runtime>(app: &AppHandle<R>, label: &str) {
    if let Some(id) = app.state::<AppState>().popouts.release_window(label) {
        emit(app, &id, None);
    }
}

/// Close every pop-out (the app is quitting, or its main window went).
pub fn close_all<R: Runtime>(app: &AppHandle<R>) {
    for (id, label) in app.state::<AppState>().popouts.take_all() {
        emit(app, &id, None);
        if let Some(window) = app.get_webview_window(&label) {
            let _ = window.destroy();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn claim_hands_out_counted_labels_and_one_window_per_terminal() {
        let pops = PopOuts::default();
        assert_eq!(pops.claim("plain-a"), Claim::New("term-1".into()));
        assert_eq!(pops.claim("plain-a"), Claim::Existing("term-1".into()));
        assert_eq!(pops.claim("session:b"), Claim::New("term-2".into()));
        assert_eq!(pops.label("plain-a").as_deref(), Some("term-1"));
        // Released, then popped again: a new label, never a reused one.
        assert!(pops.release("plain-a", "term-1"));
        assert_eq!(pops.label("plain-a"), None);
        assert_eq!(pops.claim("plain-a"), Claim::New("term-3".into()));
    }

    #[test]
    fn a_label_is_building_from_its_claim_until_its_build_ends() {
        let pops = PopOuts::default();
        assert_eq!(pops.claim("plain-a"), Claim::New("term-1".into()));
        assert!(pops.is_building("term-1"));
        // A second pop-out meanwhile finds the same label, still building.
        assert_eq!(pops.claim("plain-a"), Claim::Existing("term-1".into()));
        assert!(pops.is_building("term-1"));
        pops.finish_build("term-1");
        assert!(!pops.is_building("term-1"));
        assert_eq!(pops.label("plain-a").as_deref(), Some("term-1"));
    }

    #[test]
    fn the_background_is_the_bg_raised_token() {
        let tokens = std::fs::read_to_string(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../src/theme/tokens.css")).unwrap();
        let line = tokens.lines().find(|l| l.trim_start().starts_with("--bg-raised:")).expect("--bg-raised in tokens.css");
        let hex = line.split(':').nth(1).unwrap().trim().trim_start_matches('#');
        let hex: String = hex.chars().take_while(|c| c.is_ascii_hexdigit()).collect();
        assert_eq!(hex.len(), 6, "{line}");
        let byte = |i: usize| u8::from_str_radix(&hex[i..i + 2], 16).unwrap();
        assert_eq!((byte(0), byte(2), byte(4)), BACKGROUND);
    }

    #[test]
    fn release_only_drops_the_record_that_still_names_the_label() {
        let pops = PopOuts::default();
        pops.claim("plain-a");
        assert!(!pops.release("plain-a", "term-9"));
        assert_eq!(pops.release_window("term-9"), None);
        assert_eq!(pops.release_window("term-1").as_deref(), Some("plain-a"));
        assert_eq!(pops.release_window("term-1"), None);
        assert!(!pops.release("plain-a", "term-1"));
    }

    #[test]
    fn list_and_take_all_are_sorted_by_id() {
        let pops = PopOuts::default();
        pops.claim("plain-z");
        pops.claim("plain-a");
        assert_eq!(
            pops.list(),
            vec![
                PoppedPayload { id: "plain-a".into(), label: Some("term-2".into()) },
                PoppedPayload { id: "plain-z".into(), label: Some("term-1".into()) },
            ]
        );
        assert_eq!(pops.take_all(), vec![("plain-a".into(), "term-2".into()), ("plain-z".into(), "term-1".into())]);
        assert!(pops.list().is_empty());
        assert_eq!(pops.take("plain-a"), None);
    }

    #[test]
    fn labels_urls_and_titles() {
        assert!(is_popout_label("term-1"));
        assert!(is_popout_label("term-42"));
        assert!(!is_popout_label("term-"));
        assert!(!is_popout_label("term-x"));
        assert!(!is_popout_label("main"));
        assert_eq!(url_for("plain-ide"), "index.html?terminal=plain-ide");
        assert_eq!(url_for("session:3f2a-9c"), "index.html?terminal=session%3A3f2a-9c");
        assert_eq!(url_for("a b&c"), "index.html?terminal=a%20b%26c");
        assert_eq!(window_title("ide"), "ide — Switchboard terminal");
        assert_eq!(window_title("  "), "Switchboard terminal");
    }
}
