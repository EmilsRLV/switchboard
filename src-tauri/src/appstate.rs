//! `state.json` (Story 10.3): the app's own small state beside `settings.json` -- for now the
//! Getting started checklist (whether its card was shown, dismissed, and the steps done). Like
//! `workspace.json` it is app-written: never watched, never meant to be hand-edited, and deleting
//! it resets only what it holds. Schema-versioned the same way (`graph::store`): an older version
//! upgrades silently, a newer one is read for what this build understands and never written.
//! Story 10.5 adds the last version seen beside `checklist`.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Runtime};

use crate::persist::{self, LoadError};
use crate::settings::{AppState, paths};

/// Schema version written to `state.json`.
pub const SCHEMA_VERSION: u32 = 1;

/// The checklist's steps, in order; mirrored by `src/help/checklist.ts`.
pub const STEP_IDS: [&str; 6] = ["palette", "project", "session", "terminal", "edge", "review"];

/// The file. Every field has a default, unknown keys are ignored, so older and newer files load.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct AppStateFile {
    pub version: u32,
    pub checklist: Checklist,
}

impl Default for AppStateFile {
    fn default() -> Self {
        Self { version: SCHEMA_VERSION, checklist: Checklist::default() }
    }
}

/// The Getting started checklist: whether its card was ever shown (a fresh profile, or
/// "Show getting started"), whether it was dismissed, and the steps done (latched: never removed).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Checklist {
    pub shown: bool,
    pub dismissed: bool,
    pub done: Vec<String>,
}

/// What `state_get` and `checklist_set` return.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StateSnapshot {
    /// The workspace file was created on this launch (a fresh profile).
    pub first_run: bool,
    pub checklist: Checklist,
}

/// The loaded file and where it goes, held in [`AppState`].
#[derive(Debug, Default)]
pub struct AppStateStore {
    pub path: Option<PathBuf>,
    pub file: AppStateFile,
    /// Why the file must not be written this session (unreadable, or a newer schema); `None` to write.
    pub read_only: Option<&'static str>,
    /// See [`StateSnapshot::first_run`].
    pub first_run: bool,
}

impl AppStateStore {
    pub fn snapshot(&self) -> StateSnapshot {
        StateSnapshot { first_run: self.first_run, checklist: self.file.checklist.clone() }
    }

    /// Store a new checklist and write the file (not when read-only). An unknown step id is refused
    /// and changes nothing. Steps latch: `done` is the union of the stored and the incoming steps,
    /// once each, in checklist order, so a stale write never un-ticks one.
    pub fn set_checklist(&mut self, mut checklist: Checklist) -> Result<StateSnapshot, String> {
        if let Some(bad) = checklist.done.iter().find(|id| !STEP_IDS.contains(&id.as_str())) {
            return Err(format!("unknown checklist step: {bad}"));
        }
        let mut union = self.file.checklist.done.clone();
        union.extend(checklist.done);
        checklist.done = normalise_steps(&union);
        self.file.checklist = checklist;
        self.save();
        Ok(self.snapshot())
    }

    /// Write the file atomically, unless there is no path or it is read-only. A failure is logged.
    fn save(&self) {
        let (Some(path), None) = (&self.path, self.read_only) else {
            return;
        };
        if let Err(err) = persist::write_atomic_json(path, &self.file) {
            eprintln!("state: cannot write {}: {err}", path.display());
        }
    }
}

/// The known steps of `done`, once each, in checklist order.
fn normalise_steps(done: &[String]) -> Vec<String> {
    STEP_IDS.iter().filter(|id| done.iter().any(|d| d == *id)).map(|id| id.to_string()).collect()
}

/// Soft checks on a loaded file: an older version upgrades silently; unknown step ids (a newer
/// build's) are left out of memory. Returns whether the file is from a newer schema.
pub fn validate(file: &mut AppStateFile) -> bool {
    if file.version < SCHEMA_VERSION {
        file.version = SCHEMA_VERSION;
    }
    file.checklist.done = normalise_steps(&file.checklist.done);
    file.version > SCHEMA_VERSION
}

/// Read (or create) `state.json` at `path`. On the first run (the workspace was created on this
/// launch) a checklist never shown is marked shown and written. An unparsable file leaves the
/// defaults in memory (logged once) and is replaced by the next write; an unreadable or newer one
/// is never written this session.
pub fn load(path: Option<PathBuf>, first_run: bool) -> AppStateStore {
    let mut store = AppStateStore { path: path.clone(), first_run, ..AppStateStore::default() };
    match path.as_deref() {
        None => eprintln!("state: no platform config directory; the checklist is not kept"),
        Some(path) => load_into(&mut store, path),
    }
    if first_run && !store.file.checklist.shown {
        store.file.checklist.shown = true;
        store.save();
    }
    store
}

fn load_into(store: &mut AppStateStore, path: &Path) {
    // A crash between writing the temp file and renaming it leaves `.state.json-*.tmp` behind.
    if let Err(err) = persist::sweep_temp_files(path) {
        eprintln!("state: cannot sweep temp files beside {}: {err}", path.display());
    }
    match persist::load_or_init(path, &AppStateFile::default()) {
        Ok(loaded) => {
            let mut file = loaded.into_inner();
            if validate(&mut file) {
                eprintln!(
                    "state: {} is version {}; this build understands {SCHEMA_VERSION}; it is not written",
                    paths::STATE_FILE_NAME,
                    file.version
                );
                store.read_only = Some("newer schema version");
            }
            store.file = file;
        }
        Err(LoadError::Parse(err)) => {
            eprintln!("state: {}:{err}; using the defaults (the next write replaces it)", paths::STATE_FILE_NAME);
        }
        Err(LoadError::Read(err)) => {
            eprintln!("state: cannot read {}: {err}; it is not written", path.display());
            store.read_only = Some("unreadable file");
        }
        Err(LoadError::Write(err)) => {
            eprintln!("state: cannot write {}: {err}; it is not written this session", path.display());
            store.read_only = Some("unwritable");
        }
    }
}

/// Load `state.json` into the managed state. Called once from `setup`, after `graph::initialise`
/// (which knows whether this is the first run).
pub fn initialise<R: Runtime>(app: &AppHandle<R>) {
    initialise_at(app, paths::state_path());
}

/// [`initialise`] for an explicit path (tests use a temp dir).
pub fn initialise_at<R: Runtime>(app: &AppHandle<R>, path: Option<PathBuf>) {
    let state = app.state::<AppState>();
    let first_run = state.read_workspace().first_run;
    *state.write_state_file() = load(path, first_run);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn read(path: &Path) -> serde_json::Value {
        serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
    }

    fn steps(ids: &[&str]) -> Vec<String> {
        ids.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn defaults_are_version_1_with_an_empty_checklist() {
        let text = persist::to_json(&AppStateFile::default()).unwrap();
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&text).unwrap(),
            serde_json::json!({ "version": 1, "checklist": { "shown": false, "dismissed": false, "done": [] } })
        );
        assert_eq!(persist::parse_json::<AppStateFile>("{}").unwrap(), AppStateFile::default());
    }

    #[test]
    fn fresh_profile_creates_the_file_marked_shown() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("switchboard").join("state.json");
        let store = load(Some(path.clone()), true);
        assert!(store.file.checklist.shown);
        assert!(store.snapshot().first_run);
        assert_eq!(read(&path)["checklist"]["shown"], true);
    }

    #[test]
    fn existing_profile_without_the_file_creates_it_not_shown() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("state.json");
        let store = load(Some(path.clone()), false);
        assert!(!store.file.checklist.shown);
        assert!(!store.first_run);
        assert_eq!(read(&path), serde_json::to_value(AppStateFile::default()).unwrap());
    }

    #[test]
    fn restart_keeps_progress_and_never_rewrites_on_load() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("state.json");
        let original = r#"{ "version": 1, "checklist": { "shown": true, "dismissed": false, "done": ["edge", "palette"] }, "future": 1 }"#;
        std::fs::write(&path, original).unwrap();
        let store = load(Some(path.clone()), false);
        assert_eq!(
            store.file.checklist,
            Checklist { shown: true, dismissed: false, done: steps(&["palette", "edge"]) }
        );
        assert_eq!(std::fs::read_to_string(&path).unwrap(), original);
    }

    #[test]
    fn set_checklist_writes_atomically_and_dismissal_survives_a_restart() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("state.json");
        let mut store = load(Some(path.clone()), true);
        let snap = store
            .set_checklist(Checklist { shown: true, dismissed: true, done: steps(&["review", "palette", "review"]) })
            .unwrap();
        assert_eq!(snap.checklist.done, steps(&["palette", "review"]));
        let again = load(Some(path.clone()), false);
        assert!(again.file.checklist.dismissed);
        assert_eq!(again.file.checklist.done, steps(&["palette", "review"]));
        // Only the file itself: no temp file left over.
        let names: Vec<_> = std::fs::read_dir(dir.path()).unwrap().map(|e| e.unwrap().file_name()).collect();
        assert_eq!(names, ["state.json"]);
    }

    #[test]
    fn set_checklist_keeps_the_stored_steps_a_stale_write_never_unticks() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("state.json");
        let mut store = load(Some(path.clone()), true);
        store.set_checklist(Checklist { shown: true, dismissed: false, done: steps(&["edge", "palette"]) }).unwrap();
        let snap = store.set_checklist(Checklist { shown: true, dismissed: true, done: steps(&["review"]) }).unwrap();
        assert_eq!(snap.checklist.done, steps(&["palette", "edge", "review"]));
        assert!(snap.checklist.dismissed);
        assert_eq!(read(&path)["checklist"]["done"], serde_json::json!(["palette", "edge", "review"]));
    }

    #[test]
    fn the_six_step_ids_match_the_frontend_in_order() {
        let mut store = load(None, false);
        let six = ["palette", "project", "session", "terminal", "edge", "review"];
        let reversed: Vec<String> = six.iter().rev().map(|s| s.to_string()).collect();
        let snap = store.set_checklist(Checklist { shown: true, dismissed: false, done: reversed }).unwrap();
        assert_eq!(snap.checklist.done, steps(&six));
    }

    #[test]
    fn an_unwritable_location_goes_read_only() {
        let dir = tempfile::tempdir().unwrap();
        // A file where the config dir should be: creating the state file there fails.
        let blocker = dir.path().join("switchboard");
        std::fs::write(&blocker, "").unwrap();
        let store = load(Some(blocker.join("state.json")), false);
        assert_eq!(store.read_only, Some("unwritable"));
    }

    #[test]
    fn set_checklist_refuses_an_unknown_step_and_changes_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("state.json");
        let mut store = load(Some(path.clone()), false);
        let before = std::fs::read_to_string(&path).unwrap();
        let err = store.set_checklist(Checklist { shown: true, dismissed: false, done: steps(&["palette", "nope"]) }).unwrap_err();
        assert_eq!(err, "unknown checklist step: nope");
        assert_eq!(store.file.checklist, Checklist::default());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), before);
    }

    #[test]
    fn a_bad_file_runs_with_the_defaults_and_the_next_write_replaces_it() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("state.json");
        std::fs::write(&path, "{ not json").unwrap();
        let mut store = load(Some(path.clone()), false);
        assert_eq!(store.file, AppStateFile::default());
        assert_eq!(store.read_only, None);
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "{ not json", "not rewritten on load");
        store.set_checklist(Checklist { shown: false, dismissed: false, done: steps(&["project"]) }).unwrap();
        assert_eq!(read(&path)["checklist"]["done"], serde_json::json!(["project"]));
    }

    #[test]
    fn a_bad_file_on_a_fresh_profile_is_replaced_with_the_card_shown() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("state.json");
        std::fs::write(&path, "[1, 2").unwrap();
        let store = load(Some(path.clone()), true);
        assert!(store.file.checklist.shown);
        assert_eq!(read(&path)["checklist"]["shown"], true);
    }

    #[test]
    fn a_newer_schema_is_read_for_what_is_understood_and_never_written() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("state.json");
        let original = r#"{ "version": 2, "checklist": { "shown": false, "done": ["palette", "later"] }, "seenVersion": "9.9.9" }"#;
        std::fs::write(&path, original).unwrap();
        let mut store = load(Some(path.clone()), true);
        assert_eq!(store.read_only, Some("newer schema version"));
        assert_eq!(store.file.version, 2);
        assert_eq!(store.file.checklist.done, steps(&["palette"]));
        assert!(store.file.checklist.shown, "first run still shows the card, in memory");
        let snap = store.set_checklist(Checklist { shown: true, dismissed: true, done: steps(&["palette"]) }).unwrap();
        assert!(snap.checklist.dismissed, "kept in memory");
        assert_eq!(std::fs::read_to_string(&path).unwrap(), original);
    }

    #[test]
    fn an_older_version_upgrades_silently() {
        let mut file: AppStateFile = persist::parse_json(r#"{ "version": 0, "checklist": { "shown": true } }"#).unwrap();
        assert!(!validate(&mut file));
        assert_eq!(file.version, SCHEMA_VERSION);
        assert!(file.checklist.shown);
    }

    #[test]
    fn an_unreadable_file_is_never_written() {
        let dir = tempfile::tempdir().unwrap();
        // A directory where the file should be: reading it fails (not NotFound).
        let path = dir.path().join("state.json");
        std::fs::create_dir(&path).unwrap();
        let mut store = load(Some(path.clone()), true);
        assert_eq!(store.read_only, Some("unreadable file"));
        store.set_checklist(Checklist { shown: true, dismissed: false, done: vec![] }).unwrap();
        assert!(path.is_dir());
    }

    #[test]
    fn no_path_keeps_the_checklist_in_memory() {
        let mut store = load(None, true);
        assert!(store.file.checklist.shown);
        assert!(store.set_checklist(Checklist { shown: true, dismissed: true, done: vec![] }).unwrap().checklist.dismissed);
    }
}
