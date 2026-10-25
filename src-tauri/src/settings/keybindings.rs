//! `keybindings.json` (Story 9.4): the operator's overrides of the default keybindings, in the
//! config directory beside `settings.json`. Rust only reads and watches the file and sends its
//! raw text; the frontend owns the commands, so it parses the JSON, checks the ids and keys and
//! applies them over the defaults. A missing file is not an error: the defaults apply.

use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, Runtime};

use super::{AppState, paths, read_with_retry, watch};

/// Event carrying a fresh [`KeybindingsFile`] whenever the file changes on disk.
pub const CHANGED_EVENT: &str = "keybindings://changed";

/// What `keybindings_get` returns and `keybindings://changed` carries: the file's path, its raw
/// text (`None` when it does not exist), why it could not be read, and why it is not watched.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeybindingsFile {
    /// Absolute path of `keybindings.json`; `None` when no config dir could be determined.
    pub path: Option<String>,
    /// The file's text, unparsed; `None` when the file does not exist (or cannot be read).
    pub text: Option<String>,
    /// Why the file could not be read; `None` when it was read or does not exist.
    pub error: Option<String>,
    /// Why the file is not watched (edits need a restart); `None` while it is.
    pub watch_error: Option<String>,
}

/// `keybindings.json` beside the settings file the app uses (its config dir); `None` without one.
pub fn path_of(state: &AppState) -> Option<PathBuf> {
    let settings = state.read().path.clone()?;
    settings.parent().map(paths::keybindings_path_in)
}

/// Read the file at `path` now: its text, nothing when it is missing, or the read error.
pub fn read_at(path: Option<&Path>) -> KeybindingsFile {
    let Some(path) = path else {
        return KeybindingsFile { path: None, text: None, error: None, watch_error: None };
    };
    let shown = Some(path.display().to_string());
    match read_with_retry(path) {
        Ok(text) => KeybindingsFile { path: shown, text, error: None, watch_error: None },
        Err(err) => KeybindingsFile {
            path: shown,
            text: None,
            error: Some(format!("cannot read {}: {err}", paths::KEYBINDINGS_FILE_NAME)),
            watch_error: None,
        },
    }
}

/// The file as it is on disk now, for the app's config dir, with the watcher's error if any.
pub fn current_of(state: &AppState) -> KeybindingsFile {
    let mut file = read_at(path_of(state).as_deref());
    file.watch_error = state.keybindings_watch_error.lock().unwrap_or_else(|e| e.into_inner()).clone();
    file
}

/// [`current_of`] the app's state.
pub fn current<R: Runtime>(app: &AppHandle<R>) -> KeybindingsFile {
    current_of(&app.state::<AppState>())
}

/// Watch the config dir for changes to `keybindings.json` (the settings watcher's pattern: the
/// directory, debounced) and emit the re-read file on each. When the watch cannot start, edits
/// need a restart: the reason rides in every [`KeybindingsFile`] (Diagnostics says `live reload
/// unavailable: …`) and is emitted at once.
pub fn start_watcher<R: Runtime>(app: &AppHandle<R>) {
    let state = app.state::<AppState>();
    let Some(path) = path_of(&state) else {
        return;
    };
    let dir = path.parent().unwrap_or(Path::new("."));
    let outcome = if dir.is_dir() {
        let handle = app.clone();
        watch::start(dir, paths::KEYBINDINGS_FILE_NAME.as_ref(), move || emit(&handle, &current(&handle))).map_err(|err| err.to_string())
    } else {
        Err("config directory does not exist".to_string())
    };
    let error = match outcome {
        Ok(watcher) => {
            *state.keybindings_watcher.lock().unwrap_or_else(|e| e.into_inner()) = Some(watcher);
            None
        }
        Err(err) => {
            eprintln!("keybindings: cannot watch {}: {err}", dir.display());
            Some(err)
        }
    };
    let failed = error.is_some();
    *state.keybindings_watch_error.lock().unwrap_or_else(|e| e.into_inner()) = error;
    if failed {
        emit(app, &current(app));
    }
}

pub(crate) fn emit<R: Runtime>(app: &AppHandle<R>, file: &KeybindingsFile) {
    if let Err(err) = app.emit(CHANGED_EVENT, file.clone()) {
        eprintln!("keybindings: emit failed: {err}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_missing_file_is_no_text_and_no_error() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("keybindings.json");
        let file = read_at(Some(&path));
        assert_eq!(file.path, Some(path.display().to_string()));
        assert_eq!(file.text, None);
        assert_eq!(file.error, None);
    }

    #[test]
    fn the_text_is_sent_raw_even_when_it_is_not_json() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("keybindings.json");
        std::fs::write(&path, "{ \"review.refresh\": \"ctrl+shift+r\" }").unwrap();
        assert_eq!(read_at(Some(&path)).text.as_deref(), Some("{ \"review.refresh\": \"ctrl+shift+r\" }"));
        // Rust never parses it: invalid JSON is the frontend's error to report.
        std::fs::write(&path, "{ not json").unwrap();
        let file = read_at(Some(&path));
        assert_eq!(file.text.as_deref(), Some("{ not json"));
        assert_eq!(file.error, None);
    }

    #[test]
    fn an_unreadable_file_is_an_error_and_no_path_is_nothing() {
        let dir = tempfile::tempdir().unwrap();
        // A directory where the file should be: reading it fails (not NotFound).
        let path = dir.path().join("keybindings.json");
        std::fs::create_dir(&path).unwrap();
        let file = read_at(Some(&path));
        assert_eq!(file.text, None);
        assert!(file.error.as_deref().is_some_and(|e| e.starts_with("cannot read keybindings.json: ")), "{file:?}");
        assert_eq!(read_at(None), KeybindingsFile { path: None, text: None, error: None, watch_error: None });
    }

    #[test]
    fn a_watch_that_cannot_start_is_reported_in_the_file() {
        let state = AppState::default();
        let dir = tempfile::tempdir().unwrap();
        state.write().path = Some(dir.path().join("gone").join("settings.json"));
        *state.keybindings_watch_error.lock().unwrap() = Some("config directory does not exist".into());
        let file = current_of(&state);
        assert_eq!(file.watch_error.as_deref(), Some("config directory does not exist"));
        assert_eq!(file.text, None);
        let json = serde_json::to_value(&file).unwrap();
        assert_eq!(json["watchError"], "config directory does not exist");
    }

    #[test]
    fn the_file_sits_beside_settings_json() {
        let state = AppState::default();
        assert_eq!(path_of(&state), None);
        let dir = Path::new("/base").join("switchboard");
        state.write().path = Some(dir.join("settings.json"));
        assert_eq!(path_of(&state), Some(dir.join("keybindings.json")));
    }
}
