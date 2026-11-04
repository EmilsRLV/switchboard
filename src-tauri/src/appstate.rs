//! `state.json` (Story 10.3): the app's own small state beside `settings.json` -- for now the
//! Getting started checklist (whether its card was shown, dismissed, and the steps done). Like
//! `workspace.json` it is app-written: never watched, never meant to be hand-edited, and deleting
//! it resets only what it holds. Schema-versioned the same way (`graph::store`): an older version
//! upgrades silently, a newer one is read for what this build understands and never written.
//! Story 10.5 adds the last version seen beside `checklist` (schema 2): a version-1 file loads with
//! it `null`, and an older build reads a version-2 file as newer and never overwrites it.
//! Story 11.3 adds `hints` (schema 3): whether the canvas's inline hints are hidden (`true`), shown
//! even without the checklist card (`false`) or follow the card (`null`, the default). A version-2
//! file loads with `null` and is written as version 3 on the next write.
//! Story 11.6 adds `tour` to schema 3, beside `hints`: whether the first-run tour was taken
//! (finished or skipped). A version-2 file, or a version-3 file from before this story, loads with
//! `done: false`; the tour still starts on its own only on a fresh profile (`first_run`).

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Runtime};

use crate::persist::{self, LoadError};
use crate::settings::{AppState, paths};

/// Schema version written to `state.json`.
pub const SCHEMA_VERSION: u32 = 3;

/// The checklist's steps, in order; mirrored by `src/help/checklist.ts`.
pub const STEP_IDS: [&str; 6] = ["palette", "project", "session", "terminal", "edge", "review"];

/// The file. Every field has a default, unknown keys are ignored, so older and newer files load.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct AppStateFile {
    pub version: u32,
    pub checklist: Checklist,
    /// The app version whose changes the operator has seen (Story 10.5): recorded on a fresh
    /// profile and when the Changelog is opened. `None` in a file from before this story.
    pub last_seen_version: Option<String>,
    /// The canvas's inline hints (Story 11.3).
    pub hints: Hints,
    /// The first-run tour (Story 11.6).
    pub tour: Tour,
}

impl Default for AppStateFile {
    fn default() -> Self {
        Self {
            version: SCHEMA_VERSION,
            checklist: Checklist::default(),
            last_seen_version: None,
            hints: Hints::default(),
            tour: Tour::default(),
        }
    }
}

/// The first-run tour (Story 11.6): `done` once it was finished or skipped (`tour_set`). A re-run
/// from the palette writes nothing new.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Tour {
    pub done: bool,
}

/// The canvas's inline hints (Story 11.3): `hidden` is `None` to follow the Getting started card
/// (shown while it shows), `Some(false)` to show them anyway (`hints.show`) and `Some(true)` to
/// hide them (`hints.hide`).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Hints {
    pub hidden: Option<bool>,
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
    /// The running app version (Story 10.5).
    pub version: String,
    /// The version last seen, `None` when never recorded.
    pub last_seen_version: Option<String>,
    /// The inline hints setting (Story 11.3).
    pub hints: Hints,
    /// The first-run tour's state (Story 11.6).
    pub tour: Tour,
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
    /// The running app version, passed in by the caller (`CARGO_PKG_VERSION` in the app).
    pub version: String,
}

impl AppStateStore {
    pub fn snapshot(&self) -> StateSnapshot {
        StateSnapshot {
            first_run: self.first_run,
            checklist: self.file.checklist.clone(),
            version: self.version.clone(),
            last_seen_version: self.file.last_seen_version.clone(),
            hints: self.file.hints.clone(),
            tour: self.file.tour.clone(),
        }
    }

    /// Record `version` as seen (the Changelog was opened) and write the file -- only when it
    /// changed, and not when read-only (it is still kept in memory for this run).
    pub fn mark_version_seen(&mut self, version: &str) -> StateSnapshot {
        if self.file.last_seen_version.as_deref() != Some(version) {
            self.file.last_seen_version = Some(version.to_string());
            self.save();
        }
        self.snapshot()
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

    /// Store the inline hints setting and write the file (not when read-only: it is still kept in
    /// memory for this run, as [`Self::set_checklist`] does). Nothing to refuse: every value is valid.
    pub fn set_hints(&mut self, hidden: Option<bool>) -> Result<StateSnapshot, String> {
        self.file.hints = Hints { hidden };
        self.save();
        Ok(self.snapshot())
    }

    /// Store the tour's state and write the file (not when read-only: it is still kept in memory
    /// for this run, as [`Self::set_hints`] does), only when it changed.
    pub fn set_tour(&mut self, done: bool) -> Result<StateSnapshot, String> {
        if self.file.tour.done != done {
            self.file.tour = Tour { done };
            self.save();
        }
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
/// launch) a checklist never shown is marked shown and the running `version` is recorded as seen
/// (so a fresh profile never gets the what's-new chip), in one write. An unparsable file leaves the
/// defaults in memory (logged once) and is replaced by the next write; an unreadable or newer one
/// is never written this session.
pub fn load(path: Option<PathBuf>, first_run: bool, version: &str) -> AppStateStore {
    let mut store =
        AppStateStore { path: path.clone(), first_run, version: version.to_string(), ..AppStateStore::default() };
    match path.as_deref() {
        None => eprintln!("state: no platform config directory; the checklist is not kept"),
        Some(path) => load_into(&mut store, path),
    }
    if first_run {
        let mut changed = false;
        if !store.file.checklist.shown {
            store.file.checklist.shown = true;
            changed = true;
        }
        if store.file.last_seen_version.as_deref() != Some(version) {
            store.file.last_seen_version = Some(version.to_string());
            changed = true;
        }
        if changed {
            store.save();
        }
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
    *state.write_state_file() = load(path, first_run, env!("CARGO_PKG_VERSION"));
}

#[cfg(test)]
mod tests {
    use super::*;

    const V: &str = "0.2.0";

    fn read(path: &Path) -> serde_json::Value {
        serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
    }

    fn steps(ids: &[&str]) -> Vec<String> {
        ids.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn defaults_are_version_3_with_an_empty_checklist_no_version_seen_hints_following_the_card_and_no_tour() {
        let text = persist::to_json(&AppStateFile::default()).unwrap();
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&text).unwrap(),
            serde_json::json!({
                "version": 3,
                "checklist": { "shown": false, "dismissed": false, "done": [] },
                "lastSeenVersion": null,
                "hints": { "hidden": null },
                "tour": { "done": false }
            })
        );
        assert_eq!(persist::parse_json::<AppStateFile>("{}").unwrap(), AppStateFile::default());
    }

    #[test]
    fn fresh_profile_creates_the_file_marked_shown() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("switchboard").join("state.json");
        let store = load(Some(path.clone()), true, V);
        assert!(store.file.checklist.shown);
        assert!(store.snapshot().first_run);
        assert_eq!(read(&path)["checklist"]["shown"], true);
        assert_eq!(read(&path)["lastSeenVersion"], V, "a fresh profile records the version silently");
        assert_eq!(store.snapshot().last_seen_version.as_deref(), Some(V));
        assert_eq!(store.snapshot().version, V);
    }

    #[test]
    fn existing_profile_without_the_file_creates_it_not_shown() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("state.json");
        let store = load(Some(path.clone()), false, V);
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
        let store = load(Some(path.clone()), false, V);
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
        let mut store = load(Some(path.clone()), true, V);
        let snap = store
            .set_checklist(Checklist { shown: true, dismissed: true, done: steps(&["review", "palette", "review"]) })
            .unwrap();
        assert_eq!(snap.checklist.done, steps(&["palette", "review"]));
        let again = load(Some(path.clone()), false, V);
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
        let mut store = load(Some(path.clone()), true, V);
        store.set_checklist(Checklist { shown: true, dismissed: false, done: steps(&["edge", "palette"]) }).unwrap();
        let snap = store.set_checklist(Checklist { shown: true, dismissed: true, done: steps(&["review"]) }).unwrap();
        assert_eq!(snap.checklist.done, steps(&["palette", "edge", "review"]));
        assert!(snap.checklist.dismissed);
        assert_eq!(read(&path)["checklist"]["done"], serde_json::json!(["palette", "edge", "review"]));
    }

    #[test]
    fn the_six_step_ids_match_the_frontend_in_order() {
        let mut store = load(None, false, V);
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
        let store = load(Some(blocker.join("state.json")), false, V);
        assert_eq!(store.read_only, Some("unwritable"));
    }

    #[test]
    fn set_checklist_refuses_an_unknown_step_and_changes_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("state.json");
        let mut store = load(Some(path.clone()), false, V);
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
        let mut store = load(Some(path.clone()), false, V);
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
        let store = load(Some(path.clone()), true, V);
        assert!(store.file.checklist.shown);
        assert_eq!(read(&path)["checklist"]["shown"], true);
    }

    #[test]
    fn a_newer_schema_is_read_for_what_is_understood_and_never_written() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("state.json");
        let original = r#"{ "version": 4, "checklist": { "shown": false, "done": ["palette", "later"] }, "lastSeenVersion": "0.1.0", "hints": { "hidden": true }, "other": 1 }"#;
        std::fs::write(&path, original).unwrap();
        let mut store = load(Some(path.clone()), true, V);
        assert_eq!(store.read_only, Some("newer schema version"));
        assert_eq!(store.file.version, 4);
        assert_eq!(store.file.checklist.done, steps(&["palette"]));
        assert_eq!(store.snapshot().hints.hidden, Some(true), "the hints setting is read");
        assert!(store.file.checklist.shown, "first run still shows the card, in memory");
        let snap = store.set_checklist(Checklist { shown: true, dismissed: true, done: steps(&["palette"]) }).unwrap();
        assert!(snap.checklist.dismissed, "kept in memory");
        let snap = store.mark_version_seen("0.3.0");
        assert_eq!(snap.last_seen_version.as_deref(), Some("0.3.0"), "kept in memory");
        let snap = store.set_hints(Some(false)).unwrap();
        assert_eq!(snap.hints.hidden, Some(false), "kept in memory");
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
        let mut store = load(Some(path.clone()), true, V);
        assert_eq!(store.read_only, Some("unreadable file"));
        store.set_checklist(Checklist { shown: true, dismissed: false, done: vec![] }).unwrap();
        assert!(path.is_dir());
    }

    #[test]
    fn no_path_keeps_the_checklist_in_memory() {
        let mut store = load(None, true, V);
        assert!(store.file.checklist.shown);
        assert!(store.set_checklist(Checklist { shown: true, dismissed: true, done: vec![] }).unwrap().checklist.dismissed);
    }

    // -- Story 10.5: the last version seen -----------------------------------------------------

    #[test]
    fn a_version_1_file_loads_with_no_version_seen_and_is_not_rewritten_on_load() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("state.json");
        let original = r#"{ "version": 1, "checklist": { "shown": true, "dismissed": true, "done": ["palette"] } }"#;
        std::fs::write(&path, original).unwrap();
        let store = load(Some(path.clone()), false, V);
        assert_eq!(store.read_only, None);
        assert_eq!(store.file.version, SCHEMA_VERSION);
        assert_eq!(store.snapshot().last_seen_version, None);
        assert_eq!(store.snapshot().version, V);
        assert!(store.file.checklist.dismissed);
        assert_eq!(std::fs::read_to_string(&path).unwrap(), original);
    }

    #[test]
    fn an_existing_profile_without_the_file_has_no_version_seen() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("state.json");
        let store = load(Some(path.clone()), false, V);
        assert_eq!(store.snapshot().last_seen_version, None);
        assert_eq!(read(&path)["lastSeenVersion"], serde_json::Value::Null);
    }

    #[test]
    fn the_stored_version_survives_a_load_of_another_version() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("state.json");
        let original = r#"{ "version": 2, "checklist": { "shown": true }, "lastSeenVersion": "0.1.0" }"#;
        std::fs::write(&path, original).unwrap();
        let store = load(Some(path.clone()), false, V);
        assert_eq!(store.snapshot().last_seen_version.as_deref(), Some("0.1.0"));
        assert_eq!(store.snapshot().version, V);
        assert_eq!(std::fs::read_to_string(&path).unwrap(), original, "loading never records it");
    }

    #[test]
    fn mark_version_seen_writes_once_and_survives_a_restart() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("state.json");
        std::fs::write(&path, r#"{ "version": 2, "checklist": { "shown": true, "done": ["edge"] }, "lastSeenVersion": "0.1.0" }"#)
            .unwrap();
        let mut store = load(Some(path.clone()), false, V);
        let snap = store.mark_version_seen(V);
        assert_eq!(snap.last_seen_version.as_deref(), Some(V));
        assert_eq!(read(&path)["lastSeenVersion"], V);
        assert_eq!(read(&path)["checklist"]["done"], serde_json::json!(["edge"]), "the checklist is kept");
        // Unchanged: no write (a marker added to the file stays).
        let mut value = read(&path);
        value["marker"] = serde_json::json!(1);
        std::fs::write(&path, value.to_string()).unwrap();
        store.mark_version_seen(V);
        assert_eq!(read(&path)["marker"], 1);
        let again = load(Some(path.clone()), false, V);
        assert_eq!(again.snapshot().last_seen_version.as_deref(), Some(V));
    }

    #[test]
    fn a_fresh_profile_with_a_bad_file_records_the_version() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("state.json");
        std::fs::write(&path, "[1, 2").unwrap();
        load(Some(path.clone()), true, V);
        assert_eq!(read(&path)["lastSeenVersion"], V);
    }

    #[test]
    fn a_first_run_with_an_older_version_on_file_records_the_running_one() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("state.json");
        std::fs::write(&path, r#"{ "version": 2, "checklist": { "shown": true, "done": ["palette"] }, "lastSeenVersion": "0.1.0" }"#)
            .unwrap();
        let store = load(Some(path.clone()), true, V);
        assert_eq!(store.snapshot().last_seen_version.as_deref(), Some(V));
        assert_eq!(read(&path)["lastSeenVersion"], V);
        assert_eq!(read(&path)["checklist"]["done"], serde_json::json!(["palette"]), "the checklist is kept");
    }

    #[test]
    fn mark_version_seen_on_an_unreadable_file_writes_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("state.json");
        std::fs::create_dir(&path).unwrap();
        let mut store = load(Some(path.clone()), false, V);
        assert_eq!(store.mark_version_seen(V).last_seen_version.as_deref(), Some(V));
        assert!(path.is_dir());
    }

    // -- Story 11.3: the inline hints setting -------------------------------------------------

    #[test]
    fn a_version_2_file_loads_with_hints_following_the_card_and_is_written_as_version_3() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("state.json");
        let original = r#"{ "version": 2, "checklist": { "shown": true, "done": ["palette"] }, "lastSeenVersion": "0.1.0" }"#;
        std::fs::write(&path, original).unwrap();
        let mut store = load(Some(path.clone()), false, V);
        assert_eq!(store.read_only, None);
        assert_eq!(store.snapshot().hints, Hints { hidden: None });
        assert_eq!(std::fs::read_to_string(&path).unwrap(), original, "not rewritten on load");
        store.set_checklist(Checklist { shown: true, dismissed: false, done: steps(&["project"]) }).unwrap();
        let file = read(&path);
        assert_eq!(file["version"], 3);
        assert_eq!(file["hints"], serde_json::json!({ "hidden": null }));
        assert_eq!(file["lastSeenVersion"], "0.1.0");
        assert_eq!(file["checklist"]["done"], serde_json::json!(["palette", "project"]));
    }

    #[test]
    fn set_hints_round_trips_every_value_through_a_restart() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("state.json");
        let mut store = load(Some(path.clone()), true, V);
        store.set_checklist(Checklist { shown: true, dismissed: true, done: steps(&["edge"]) }).unwrap();
        for hidden in [Some(true), Some(false), None] {
            let snap = store.set_hints(hidden).unwrap();
            assert_eq!(snap.hints.hidden, hidden);
            assert_eq!(read(&path)["hints"]["hidden"], serde_json::to_value(hidden).unwrap());
            let again = load(Some(path.clone()), false, V);
            assert_eq!(again.snapshot().hints.hidden, hidden);
            assert!(again.file.checklist.dismissed, "the checklist is kept");
            assert_eq!(again.file.checklist.done, steps(&["edge"]));
        }
        let names: Vec<_> = std::fs::read_dir(dir.path()).unwrap().map(|e| e.unwrap().file_name()).collect();
        assert_eq!(names, ["state.json"]);
    }

    #[test]
    fn set_hints_on_an_unreadable_file_writes_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("state.json");
        std::fs::create_dir(&path).unwrap();
        let mut store = load(Some(path.clone()), false, V);
        assert_eq!(store.set_hints(Some(true)).unwrap().hints.hidden, Some(true));
        assert!(path.is_dir());
    }
    // -- Story 11.6: the first-run tour -------------------------------------------------------

    #[test]
    fn a_version_2_file_and_an_early_version_3_file_load_with_the_tour_not_done() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("state.json");
        for original in [
            r#"{ "version": 2, "checklist": { "shown": true, "done": ["palette"] }, "lastSeenVersion": "0.1.0" }"#,
            r#"{ "version": 3, "checklist": { "shown": true }, "lastSeenVersion": "0.1.0", "hints": { "hidden": true } }"#,
        ] {
            std::fs::write(&path, original).unwrap();
            let store = load(Some(path.clone()), false, V);
            assert_eq!(store.read_only, None);
            assert_eq!(store.snapshot().tour, Tour { done: false });
            assert_eq!(std::fs::read_to_string(&path).unwrap(), original, "not rewritten on load");
        }
    }

    #[test]
    fn set_tour_round_trips_through_a_restart_and_keeps_the_rest() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("state.json");
        let mut store = load(Some(path.clone()), true, V);
        store.set_hints(Some(true)).unwrap();
        store.set_checklist(Checklist { shown: true, dismissed: false, done: steps(&["palette"]) }).unwrap();
        let snap = store.set_tour(true).unwrap();
        assert!(snap.tour.done);
        let file = read(&path);
        assert_eq!(file["version"], 3);
        assert_eq!(file["tour"], serde_json::json!({ "done": true }));
        assert_eq!(file["hints"], serde_json::json!({ "hidden": true }), "the hints are kept");
        let again = load(Some(path.clone()), false, V);
        assert!(again.snapshot().tour.done);
        assert_eq!(again.file.checklist.done, steps(&["palette"]));
        // Unchanged: no write (a marker added to the file stays).
        let mut value = read(&path);
        value["marker"] = serde_json::json!(1);
        std::fs::write(&path, value.to_string()).unwrap();
        store.set_tour(true).unwrap();
        assert_eq!(read(&path)["marker"], 1);
        let names: Vec<_> = std::fs::read_dir(dir.path()).unwrap().map(|e| e.unwrap().file_name()).collect();
        assert_eq!(names, ["state.json"]);
    }

    #[test]
    fn set_tour_on_a_newer_or_unreadable_file_keeps_it_in_memory_and_writes_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("state.json");
        let original = r#"{ "version": 4, "checklist": { "shown": true }, "tour": { "done": false }, "other": 1 }"#;
        std::fs::write(&path, original).unwrap();
        let mut store = load(Some(path.clone()), true, V);
        assert_eq!(store.read_only, Some("newer schema version"));
        assert!(!store.snapshot().tour.done);
        assert!(store.set_tour(true).unwrap().tour.done, "kept in memory");
        assert_eq!(std::fs::read_to_string(&path).unwrap(), original);

        let unreadable = dir.path().join("dir-state.json");
        std::fs::create_dir(&unreadable).unwrap();
        let mut store = load(Some(unreadable.clone()), true, V);
        assert!(store.set_tour(true).unwrap().tour.done);
        assert!(unreadable.is_dir());
    }
}
