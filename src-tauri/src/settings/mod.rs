//! Settings: the one human-editable `settings.json` in the platform config dir, binary
//! detection for `claude` and `git`, and the live-reload watcher. Everything the UI sees
//! about settings is a [`Snapshot`], pushed as the `settings://changed` event.

pub mod detect;
pub mod paths;
pub mod store;
pub mod watch;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock, RwLock, RwLockReadGuard, RwLockWriteGuard};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, Runtime};

use crate::claude::SessionCache;
use crate::claude::live::LiveMap;
use crate::git::ProjectStatus;
use crate::graph::WorkspaceState;
use detect::{ProcessRunner, Runner, Search};

/// Event name carrying a [`Snapshot`] to the webview whenever settings, detection or
/// banners change.
pub const CHANGED_EVENT: &str = "settings://changed";

/// Schema version written to `settings.json`.
pub const SCHEMA_VERSION: u32 = 1;

/// Poll interval for `claude agents --json` (NFR-4: status within one poll, default 2 s).
pub const DEFAULT_AGENTS_POLL_MS: u64 = 2_000;
/// Poll interval for git status refreshes.
pub const DEFAULT_GIT_POLL_MS: u64 = 5_000;
/// External editor command used when `code` is on PATH (FR-REVIEW-4).
pub const CODE_EDITOR_COMMAND: &str = "code -g {file}:{line}";

/// Attempts and spacing for reading the file after a change: editors save in several steps
/// and may hold the file briefly (sharing violation / `PermissionDenied`).
const READ_ATTEMPTS: u32 = 3;
const READ_RETRY_DELAY: Duration = Duration::from_millis(100);

// ---------------------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------------------

/// The settings file. Every field has a default so missing keys are filled in, and serde
/// ignores unknown keys, so hand edits and older/newer files both load.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct Settings {
    pub version: u32,
    pub claude: BinarySetting,
    pub git: BinarySetting,
    pub defaults: LaunchDefaults,
    /// Root for app-managed worktrees; `null` means `<repo>/.worktrees/` (FR-BRANCH-2).
    pub worktrees_root: Option<String>,
    /// Command template with `{file}` and `{line}` placeholders; `null` means not configured.
    pub external_editor: Option<String>,
    /// Shell for plain terminals; `null` means decide at launch time.
    pub shell: Option<String>,
    pub theme: String,
    pub poll: PollSettings,
    /// Which attention states send an OS toast while the window is unfocused (Story 3.3).
    pub notifications: NotificationSettings,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            version: SCHEMA_VERSION,
            claude: BinarySetting::default(),
            git: BinarySetting::default(),
            defaults: LaunchDefaults::default(),
            worktrees_root: None,
            external_editor: None,
            shell: None,
            theme: "dark".to_string(),
            poll: PollSettings::default(),
            notifications: NotificationSettings::default(),
        }
    }
}

/// Where a binary lives. `None` means "detect it".
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct BinarySetting {
    pub path: Option<String>,
}

/// Defaults for the launch sheet (Epic 4). `None` leaves the choice to `claude`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct LaunchDefaults {
    pub model: Option<String>,
    pub effort: Option<String>,
    pub permission_mode: Option<String>,
}

impl Default for LaunchDefaults {
    fn default() -> Self {
        Self {
            model: None,
            effort: None,
            permission_mode: Some("default".to_string()),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct PollSettings {
    pub agents_ms: u64,
    pub git_ms: u64,
}

impl Default for PollSettings {
    fn default() -> Self {
        Self {
            agents_ms: DEFAULT_AGENTS_POLL_MS,
            git_ms: DEFAULT_GIT_POLL_MS,
        }
    }
}

/// The OS toast toggles, one per attention state; both on by default. A missing key takes its
/// default like every other settings key.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct NotificationSettings {
    /// A session finished its turn (busy → idle).
    pub finished: bool,
    /// A session waits for input (hooks, Story 4.3).
    pub waiting: bool,
}

impl Default for NotificationSettings {
    fn default() -> Self {
        Self {
            finished: true,
            waiting: true,
        }
    }
}

impl Settings {
    /// Static defaults plus what this machine suggests: the detected `claude`, the shell
    /// (`pwsh` then `powershell` on Windows, `$SHELL` elsewhere) and `code` as the editor
    /// when it is on PATH. This is what the first launch writes to disk.
    pub fn for_machine(search: &Search) -> Self {
        let mut settings = Self::default();
        settings.claude.path = search
            .locate("claude")
            .map(|located| located.path.display().to_string());
        settings.shell = default_shell(search);
        // The editor command is run by a shell later, which sees PATH only -- not the
        // extra dirs `claude` is also searched in.
        settings.external_editor = search
            .path_only()
            .locate("code")
            .map(|_| CODE_EDITOR_COMMAND.to_string());
        settings
    }

    /// The configured binary paths, in the order detection runs them.
    fn binary_config(&self) -> (Option<String>, Option<String>) {
        (self.claude.path.clone(), self.git.path.clone())
    }
}

#[cfg(windows)]
fn default_shell(search: &Search) -> Option<String> {
    if search.locate("pwsh").is_some() {
        Some("pwsh".to_string())
    } else {
        Some("powershell".to_string())
    }
}

#[cfg(not(windows))]
fn default_shell(_search: &Search) -> Option<String> {
    std::env::var("SHELL").ok().filter(|s| !s.is_empty())
}

// ---------------------------------------------------------------------------------------
// Snapshot: what the UI sees
// ---------------------------------------------------------------------------------------

/// An ambient, non-blocking notice. Banners are derived from state and disappear when the
/// condition clears; there is no manual dismissal.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Banner {
    pub id: String,
    pub text: String,
}

impl Banner {
    pub fn new(id: impl Into<String>, text: impl Into<String>) -> Self {
        Self {
            id: id.into(),
            text: text.into(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BinaryStatus {
    /// Detection has not finished yet.
    Pending,
    /// Binary located; `version` is `None` when `--version` printed nothing usable.
    Found,
    /// Not on PATH nor in the extra dirs.
    Missing,
    /// `<bin>.path` is set in settings but points at nothing.
    ConfiguredMissing,
    /// Binary exists but `--version` failed, timed out or exited non-zero.
    VersionFailed,
}

/// Detection result for one binary.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Binary {
    pub name: String,
    pub path: Option<String>,
    pub version: Option<String>,
    pub status: BinaryStatus,
    /// True when the path came from `settings.json` rather than detection.
    pub configured: bool,
}

impl Binary {
    pub fn pending(name: &str) -> Self {
        Self {
            name: name.to_string(),
            path: None,
            version: None,
            status: BinaryStatus::Pending,
            configured: false,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Binaries {
    pub claude: Binary,
    pub git: Binary,
}

impl Default for Binaries {
    fn default() -> Self {
        Self {
            claude: Binary::pending("claude"),
            git: Binary::pending("git"),
        }
    }
}

/// Everything the UI needs about settings, sent on request and on every change.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Snapshot {
    /// Absolute path of `settings.json`; `None` when the config dir could not be determined.
    pub path: Option<String>,
    pub settings: Settings,
    pub binaries: Binaries,
    pub banners: Vec<Banner>,
}

// ---------------------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------------------

/// Long-lived settings state. `settings` is always the last good parse; a broken file on
/// disk only adds `file_banner`.
#[derive(Debug, Default)]
pub struct SettingsState {
    pub path: Option<PathBuf>,
    pub settings: Settings,
    pub binaries: Binaries,
    /// Parse, read or write error for the file itself, if any.
    pub file_banner: Option<Banner>,
    /// Soft problems in the last good settings (`store::validate`).
    pub validation_banners: Vec<Banner>,
    /// Set when the fs watcher could not be started: edits need a restart.
    pub watch_banner: Option<Banner>,
    /// Banners produced by binary detection (missing, wrong path, version failure).
    pub binary_banners: Vec<Banner>,
}

impl SettingsState {
    pub fn snapshot(&self) -> Snapshot {
        Snapshot {
            path: self.path.as_ref().map(|p| p.display().to_string()),
            settings: self.settings.clone(),
            binaries: self.binaries.clone(),
            banners: self
                .file_banner
                .iter()
                .chain(self.validation_banners.iter())
                .chain(self.watch_banner.iter())
                .chain(self.binary_banners.iter())
                .cloned()
                .collect(),
        }
    }

    /// Replace the settings with a freshly parsed, validated set.
    fn accept(&mut self, mut settings: Settings) {
        self.validation_banners = store::validate(&mut settings);
        self.settings = settings;
        self.file_banner = None;
    }
}

/// Live, never persisted state about the projects on the canvas: what the git poller found.
/// Cached in memory, refreshed on a timer and after every add (`crate::git::poll`).
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct LiveState {
    /// Git status per project id; a project is absent until the first poll reaches it.
    pub statuses: HashMap<String, ProjectStatus>,
}

/// Tauri-managed application state: settings, the workspace (`crate::graph`) and the live
/// state. The watcher lives here only to stay alive for the app's lifetime; dropping it stops
/// the fs watch.
#[derive(Default)]
pub struct AppState {
    pub settings: RwLock<SettingsState>,
    pub workspace: RwLock<WorkspaceState>,
    pub live: RwLock<LiveState>,
    pub watcher: Mutex<Option<notify::RecommendedWatcher>>,
    /// Bumped per detection run; a run stores its result only if it is still the latest,
    /// so overlapping runs (startup, reload, Re-detect) cannot finish out of order.
    pub detect_generation: AtomicU64,
    /// Serialises git status refreshes (the timer's and the one after an add), so an older,
    /// slower pass can never overwrite a newer result.
    pub refresh_lock: tauri::async_runtime::Mutex<()>,
    /// Claude Code's home (`~/.claude`), set once in `setup`. Unset (as in tests) means
    /// discovery has nothing to read and lists nothing.
    pub claude_home: OnceLock<PathBuf>,
    /// Stub session children per project (`SWITCHBOARD_STUB_CHILDREN`, Story 2.3), set once
    /// in `setup` before `graph::initialise` copies it into the workspace state. Unset means 0.
    pub stub_children: OnceLock<usize>,
    /// Transcript summaries cached by `(len, mtime)` (`crate::claude::sessions`). Memory only;
    /// locked only while no file is being read.
    pub sessions: Mutex<SessionCache>,
    /// Serialises session discovery passes (the timer's and the ones after an add or remove),
    /// so an older pass can never overwrite a newer result.
    pub sessions_lock: tauri::async_runtime::Mutex<()>,
    /// What the `claude agents --json --all` poll last saw (`crate::claude::live`, Story 3.2):
    /// live and exited sessions, the Elsewhere rows, the failure count. Memory only.
    pub sessions_live: RwLock<LiveMap>,
    /// Serialises live-session polls, so an older, slower poll never overwrites a newer one.
    pub live_lock: tauri::async_runtime::Mutex<()>,
    /// A toast sender that replaces the notification plugin (tests inject a recorder, so no
    /// test ever sends a real OS notification). `None` means the plugin, when registered.
    pub notifier: Mutex<Option<std::sync::Arc<dyn crate::notify::Notifier>>>,
    /// Every terminal's PTY and child (`crate::pty`, Story 4.1). Each terminal has its own
    /// locks; none is held across PTY I/O.
    pub terms: crate::pty::TermManager,
    /// The session launcher (`crate::claude::launch`, Story 4.2): the temp folder for
    /// per-session settings files, the files it wrote, the ids proposed to open sheets.
    pub launcher: crate::claude::launch::Launcher,
}

impl AppState {
    /// Read the settings state; a poisoned lock is recovered rather than propagated.
    pub fn read(&self) -> RwLockReadGuard<'_, SettingsState> {
        self.settings.read().unwrap_or_else(|e| e.into_inner())
    }

    pub fn write(&self) -> RwLockWriteGuard<'_, SettingsState> {
        self.settings.write().unwrap_or_else(|e| e.into_inner())
    }

    /// Read the workspace state; a poisoned lock is recovered rather than propagated.
    pub fn read_workspace(&self) -> RwLockReadGuard<'_, WorkspaceState> {
        self.workspace.read().unwrap_or_else(|e| e.into_inner())
    }

    pub fn write_workspace(&self) -> RwLockWriteGuard<'_, WorkspaceState> {
        self.workspace.write().unwrap_or_else(|e| e.into_inner())
    }

    /// Read the live state; a poisoned lock is recovered rather than propagated.
    pub fn read_live(&self) -> RwLockReadGuard<'_, LiveState> {
        self.live.read().unwrap_or_else(|e| e.into_inner())
    }

    pub fn write_live(&self) -> RwLockWriteGuard<'_, LiveState> {
        self.live.write().unwrap_or_else(|e| e.into_inner())
    }

    /// Read the live-session map; a poisoned lock is recovered rather than propagated.
    pub fn read_sessions_live(&self) -> RwLockReadGuard<'_, LiveMap> {
        self.sessions_live.read().unwrap_or_else(|e| e.into_inner())
    }

    pub fn write_sessions_live(&self) -> RwLockWriteGuard<'_, LiveMap> {
        self.sessions_live.write().unwrap_or_else(|e| e.into_inner())
    }
}

// ---------------------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------------------

/// Load (or create) the settings file, start the watcher and kick off binary detection.
/// Called once from Tauri's `setup`. Only fast filesystem work happens here; running
/// `--version` is deferred to the async runtime.
pub fn initialise<R: Runtime>(app: &AppHandle<R>) {
    let search = Search::from_env(paths::extra_bin_dirs());
    initialise_at(app, paths::settings_path(), &search);
    start_watcher(app);
    emit(app, &app.state::<AppState>().read().snapshot());
    tauri::async_runtime::spawn(redetect(app.clone()));
}

/// The loading half of [`initialise`]: read `path` (or create it with this machine's
/// first-launch defaults) into the managed state. In-memory settings start from the static
/// defaults, so a file that cannot be read never makes detected paths look configured.
pub fn initialise_at<R: Runtime>(app: &AppHandle<R>, path: Option<PathBuf>, search: &Search) {
    let state = app.state::<AppState>();
    let mut st = state.write();
    st.settings = Settings::default();
    st.file_banner = None;
    st.validation_banners.clear();
    st.path = path.clone();

    let Some(path) = path else {
        st.file_banner = Some(Banner::new(
            "settings.write",
            "cannot write settings: no platform config directory",
        ));
        return;
    };
    // A crash mid-write leaves `.settings.json-*.tmp` behind; nothing else cleans those up.
    if let Err(err) = crate::persist::sweep_temp_files(&path) {
        eprintln!("settings: cannot sweep temp files beside {}: {err}", path.display());
    }
    match store::load_or_init(&path, &Settings::for_machine(search)) {
        Ok(loaded) => st.accept(loaded.into_settings()),
        Err(store::LoadError::Parse(err)) => st.file_banner = Some(parse_banner(&path, &err)),
        Err(err @ store::LoadError::Read(_)) => {
            st.file_banner = Some(Banner::new("settings.read", err.to_string()));
        }
        Err(err) => st.file_banner = Some(Banner::new("settings.write", err.to_string())),
    }
}

fn start_watcher<R: Runtime>(app: &AppHandle<R>) {
    let state = app.state::<AppState>();
    let Some(path) = state.read().path.clone() else {
        return;
    };
    let dir = path.parent().unwrap_or(Path::new("."));
    let outcome = if dir.is_dir() {
        let handle = app.clone();
        watch::start(dir, paths::FILE_NAME.as_ref(), move || {
            if reload(&handle) {
                tauri::async_runtime::spawn(redetect(handle.clone()));
            }
        })
        .map_err(|err| err.to_string())
    } else {
        Err("config directory does not exist".to_string())
    };
    match outcome {
        Ok(watcher) => {
            *state.watcher.lock().unwrap_or_else(|e| e.into_inner()) = Some(watcher);
            state.write().watch_banner = None;
        }
        Err(err) => {
            eprintln!("settings: cannot watch {}: {err}", dir.display());
            state.write().watch_banner = Some(Banner::new(
                "settings.watch",
                format!("live reload unavailable: {err}; restart to apply edits"),
            ));
        }
    }
}

/// Re-read the file after a change on disk. A good parse replaces the settings and clears
/// the parse banner; a bad one keeps the last good settings and shows where it broke.
/// Returns whether a configured binary path changed (the caller re-runs detection then).
pub fn reload<R: Runtime>(app: &AppHandle<R>) -> bool {
    let state = app.state::<AppState>();
    let Some(path) = state.read().path.clone() else {
        return false;
    };
    let text = match read_with_retry(&path) {
        Ok(Some(text)) => text,
        // Editors replace files in several steps; a vanished file is not an error state.
        Ok(None) => return false,
        Err(err) => {
            let mut st = state.write();
            st.file_banner = Some(Banner::new(
                "settings.read",
                format!("cannot read settings: {err}"),
            ));
            emit(app, &st.snapshot());
            return false;
        }
    };

    let (snapshot, binaries_changed) = {
        let mut st = state.write();
        let changed = match store::parse(&text) {
            Ok(settings) => {
                let changed = st.settings.binary_config() != settings.binary_config();
                st.accept(settings);
                changed
            }
            Err(err) => {
                st.file_banner = Some(parse_banner(&path, &err));
                false
            }
        };
        (st.snapshot(), changed)
    };
    emit(app, &snapshot);
    binaries_changed
}

/// Read the file, retrying transient errors a few times. `Ok(None)` means it does not exist.
fn read_with_retry(path: &Path) -> std::io::Result<Option<String>> {
    let mut attempt = 1;
    loop {
        match std::fs::read_to_string(path) {
            Ok(text) => return Ok(Some(text)),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(_) if attempt < READ_ATTEMPTS => {
                attempt += 1;
                std::thread::sleep(READ_RETRY_DELAY);
            }
            Err(err) => return Err(err),
        }
    }
}

/// Run binary detection off the main thread, store the result (if no newer run has started
/// since), emit and return the resulting snapshot.
pub async fn redetect<R: Runtime>(app: AppHandle<R>) -> Snapshot {
    let state = app.state::<AppState>();
    let generation = state.detect_generation.fetch_add(1, Ordering::SeqCst) + 1;
    let (claude_cfg, git_cfg) = state.read().settings.binary_config();
    let detected = tauri::async_runtime::spawn_blocking({
        let (claude_cfg, git_cfg) = (claude_cfg.clone(), git_cfg.clone());
        move || {
            let runner = ProcessRunner::default();
            detect_all(claude_cfg.as_deref(), git_cfg.as_deref(), &runner)
        }
    })
    .await;

    let snapshot = {
        let mut st = state.write();
        if state.detect_generation.load(Ordering::SeqCst) == generation {
            match detected {
                Ok((binaries, banners)) => {
                    st.binaries = binaries;
                    st.binary_banners = banners;
                }
                Err(err) => {
                    st.binaries = Binaries {
                        claude: detection_failed("claude", claude_cfg),
                        git: detection_failed("git", git_cfg),
                    };
                    st.binary_banners = vec![Banner::new(
                        "detect.failed",
                        format!("binary detection failed: {err}"),
                    )];
                }
            }
        }
        st.snapshot()
    };
    emit(&app, &snapshot);
    snapshot
}

fn detection_failed(name: &str, configured: Option<String>) -> Binary {
    Binary {
        name: name.to_string(),
        configured: configured.is_some(),
        path: configured,
        version: None,
        status: BinaryStatus::VersionFailed,
    }
}

/// Detect both binaries: `claude` on PATH then `~/.local/bin`, `git` on PATH.
pub fn detect_all(
    claude_cfg: Option<&str>,
    git_cfg: Option<&str>,
    runner: &dyn Runner,
) -> (Binaries, Vec<Banner>) {
    let claude_search = Search::from_env(paths::extra_bin_dirs());
    let git_search = Search::from_env(Vec::new());
    let (claude, claude_banner) = detect::resolve("claude", claude_cfg, &claude_search, runner);
    let (git, git_banner) = detect::resolve("git", git_cfg, &git_search, runner);
    let banners = claude_banner.into_iter().chain(git_banner).collect();
    (Binaries { claude, git }, banners)
}

fn parse_banner(path: &Path, err: &store::ParseError) -> Banner {
    let file = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| paths::FILE_NAME.to_string());
    Banner::new("settings.parse", format!("{file}:{err}"))
}

fn emit<R: Runtime>(app: &AppHandle<R>, snapshot: &Snapshot) {
    if let Err(err) = app.emit(CHANGED_EVENT, snapshot.clone()) {
        eprintln!("settings: emit failed: {err}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use detect::fixtures::fake_binary;
    use tauri::test::{MockRuntime, mock_builder, mock_context, noop_assets};

    fn mock_app() -> tauri::App<MockRuntime> {
        crate::with_commands(mock_builder())
            .build(mock_context(noop_assets()))
            .expect("mock app should build")
    }

    fn search_in(dir: &Path) -> Search {
        Search {
            path_dirs: vec![dir.to_path_buf()],
            extra_dirs: vec![],
            extensions: detect::platform_extensions(),
        }
    }

    const BROKEN: &str = "{\n  \"version\": 1,\n  \"theme\": }\n";

    #[test]
    fn defaults_match_the_recorded_decisions() {
        let s = Settings::default();
        assert_eq!(s.version, 1);
        assert_eq!(s.claude.path, None);
        assert_eq!(s.git.path, None);
        assert_eq!(s.defaults.model, None);
        assert_eq!(s.defaults.effort, None);
        assert_eq!(s.defaults.permission_mode.as_deref(), Some("default"));
        assert_eq!(s.worktrees_root, None);
        assert_eq!(s.external_editor, None);
        assert_eq!(s.shell, None);
        assert_eq!(s.theme, "dark");
        assert_eq!(s.poll.agents_ms, 2_000);
        assert_eq!(s.poll.git_ms, 5_000);
        assert!(s.notifications.finished);
        assert!(s.notifications.waiting);
    }

    #[test]
    fn notification_toggles_parse_tolerantly_and_default_on() {
        let s = store::parse(r#"{ "notifications": { "finished": false } }"#).unwrap();
        assert_eq!(s.notifications, NotificationSettings { finished: false, waiting: true });
        let s = store::parse(r#"{ "notifications": { "waiting": false, "sound": true } }"#).unwrap();
        assert_eq!(s.notifications, NotificationSettings { finished: true, waiting: false });
        assert_eq!(store::parse("{}").unwrap().notifications, NotificationSettings::default());
    }

    #[test]
    fn snapshot_concatenates_banners_in_file_validation_watch_binary_order() {
        let mut st = SettingsState::default();
        assert!(st.snapshot().banners.is_empty());
        assert_eq!(st.snapshot().binaries.claude.status, BinaryStatus::Pending);
        st.binary_banners = vec![Banner::new("claude.missing", "claude not found")];
        st.watch_banner = Some(Banner::new("settings.watch", "live reload unavailable"));
        st.validation_banners = vec![Banner::new("settings.version", "newer")];
        st.file_banner = Some(Banner::new("settings.parse", "settings.json:3:12 expected value"));
        let snapshot = st.snapshot();
        let ids: Vec<&str> = snapshot.banners.iter().map(|b| b.id.as_str()).collect();
        assert_eq!(
            ids,
            ["settings.parse", "settings.version", "settings.watch", "claude.missing"]
        );
    }

    #[test]
    fn snapshot_serialises_with_the_four_keys_the_ui_reads() {
        let json = serde_json::to_value(SettingsState::default().snapshot()).unwrap();
        let keys: Vec<&String> = json.as_object().unwrap().keys().collect();
        assert_eq!(keys, ["banners", "binaries", "path", "settings"]);

        // Every status string and field name the frontend types (`src/ipc/index.ts`) rely on.
        let one_per_status: Vec<Binary> = [
            BinaryStatus::Pending,
            BinaryStatus::Found,
            BinaryStatus::Missing,
            BinaryStatus::ConfiguredMissing,
            BinaryStatus::VersionFailed,
        ]
        .into_iter()
        .map(|status| Binary {
            name: "x".into(),
            path: None,
            version: None,
            status,
            configured: false,
        })
        .collect();
        let statuses: Vec<_> = serde_json::to_value(&one_per_status)
            .unwrap()
            .as_array()
            .unwrap()
            .iter()
            .map(|b| b["status"].clone())
            .collect();
        assert_eq!(
            statuses,
            ["pending", "found", "missing", "configured_missing", "version_failed"]
        );

        let st = SettingsState {
            path: Some(PathBuf::from("C:/cfg/switchboard/settings.json")),
            settings: Settings::default(),
            binaries: Binaries {
                claude: Binary {
                    name: "claude".into(),
                    path: Some("C:/bin/claude.exe".into()),
                    version: Some("2.1.301".into()),
                    status: BinaryStatus::Found,
                    configured: true,
                },
                git: Binary {
                    name: "git".into(),
                    path: Some("C:/nope.exe".into()),
                    version: None,
                    status: BinaryStatus::ConfiguredMissing,
                    configured: true,
                },
            },
            file_banner: None,
            validation_banners: vec![],
            watch_banner: None,
            binary_banners: vec![Banner::new("git.configured_missing", "git: configured path …")],
        };
        assert_eq!(
            serde_json::to_value(st.snapshot()).unwrap(),
            serde_json::json!({
                "path": "C:/cfg/switchboard/settings.json",
                "settings": {
                    "version": 1,
                    "claude": { "path": null },
                    "git": { "path": null },
                    "defaults": { "model": null, "effort": null, "permission_mode": "default" },
                    "worktrees_root": null,
                    "external_editor": null,
                    "shell": null,
                    "theme": "dark",
                    "poll": { "agents_ms": 2000, "git_ms": 5000 },
                    "notifications": { "finished": true, "waiting": true }
                },
                "binaries": {
                    "claude": {
                        "name": "claude",
                        "path": "C:/bin/claude.exe",
                        "version": "2.1.301",
                        "status": "found",
                        "configured": true
                    },
                    "git": {
                        "name": "git",
                        "path": "C:/nope.exe",
                        "version": null,
                        "status": "configured_missing",
                        "configured": true
                    }
                },
                "banners": [
                    { "id": "git.configured_missing", "text": "git: configured path …" }
                ]
            })
        );
    }

    #[test]
    fn parse_banner_names_file_line_and_column() {
        let err = store::ParseError {
            line: 3,
            col: 12,
            msg: "expected value".into(),
        };
        let banner = parse_banner(Path::new("C:/x/switchboard/settings.json"), &err);
        assert_eq!(banner.id, "settings.parse");
        assert_eq!(banner.text, "settings.json:3:12 expected value");
    }

    #[test]
    fn for_machine_fills_claude_and_editor_from_the_search() {
        let dir = tempfile::tempdir().unwrap();
        let claude = fake_binary(dir.path(), "claude");
        fake_binary(dir.path(), "code");
        let s = Settings::for_machine(&search_in(dir.path()));
        assert_eq!(s.claude.path.as_deref(), Some(claude.display().to_string().as_str()));
        assert_eq!(s.external_editor.as_deref(), Some(CODE_EDITOR_COMMAND));
        assert_eq!(s.git.path, None, "git is detected on every launch, not pinned");
        #[cfg(windows)]
        assert_eq!(s.shell.as_deref(), Some("powershell"), "no pwsh in the search dir");
    }

    #[test]
    fn for_machine_leaves_claude_and_editor_unset_when_absent() {
        let dir = tempfile::tempdir().unwrap();
        let s = Settings::for_machine(&search_in(dir.path()));
        assert_eq!(s.claude.path, None);
        assert_eq!(s.external_editor, None);
    }

    #[test]
    fn for_machine_ignores_code_that_lives_only_in_an_extra_dir() {
        let path_dir = tempfile::tempdir().unwrap();
        let extra = tempfile::tempdir().unwrap();
        fake_binary(extra.path(), "code");
        fake_binary(extra.path(), "claude");
        let search = Search {
            path_dirs: vec![path_dir.path().to_path_buf()],
            extra_dirs: vec![extra.path().to_path_buf()],
            extensions: detect::platform_extensions(),
        };
        let s = Settings::for_machine(&search);
        assert!(s.claude.path.is_some(), "claude may come from ~/.local/bin");
        assert_eq!(s.external_editor, None, "a shell would not find code there");
    }

    // -- initialise_at ----------------------------------------------------------------

    #[test]
    fn initialise_at_applies_an_existing_file() {
        let app = mock_app();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        std::fs::write(&path, r#"{ "theme": "light" }"#).unwrap();

        initialise_at(app.handle(), Some(path.clone()), &search_in(dir.path()));

        let st = app.state::<AppState>();
        let st = st.read();
        assert_eq!(st.path.as_deref(), Some(path.as_path()));
        assert_eq!(st.settings.theme, "light");
        assert_eq!(st.settings.claude.path, None, "nothing detected is treated as configured");
        assert_eq!(st.file_banner, None);
        assert!(st.validation_banners.is_empty());
    }

    #[test]
    fn initialise_at_sweeps_orphaned_temp_files_but_not_the_file() {
        let app = mock_app();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        std::fs::write(&path, r#"{ "theme": "light" }"#).unwrap();
        std::fs::write(dir.path().join(".settings.json-abc123.tmp"), "half").unwrap();

        initialise_at(app.handle(), Some(path.clone()), &search_in(dir.path()));

        let names: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        assert_eq!(names, ["settings.json"]);
        assert_eq!(app.state::<AppState>().read().settings.theme, "light");
    }

    #[test]
    fn initialise_at_creates_the_file_with_machine_defaults_on_first_launch() {
        let app = mock_app();
        let dir = tempfile::tempdir().unwrap();
        let claude = fake_binary(dir.path(), "claude");
        let path = dir.path().join("switchboard").join("settings.json");

        initialise_at(app.handle(), Some(path.clone()), &search_in(dir.path()));

        assert!(path.is_file());
        let st = app.state::<AppState>();
        let st = st.read();
        assert_eq!(st.settings.claude.path.as_deref(), Some(claude.display().to_string().as_str()));
        assert_eq!(st.file_banner, None);
        assert_eq!(store::parse(&std::fs::read_to_string(&path).unwrap()).unwrap(), st.settings);
    }

    #[test]
    fn initialise_at_with_a_broken_file_keeps_static_defaults_and_shows_the_parse_banner() {
        let app = mock_app();
        let dir = tempfile::tempdir().unwrap();
        fake_binary(dir.path(), "claude");
        let path = dir.path().join("settings.json");
        std::fs::write(&path, BROKEN).unwrap();

        initialise_at(app.handle(), Some(path), &search_in(dir.path()));

        let st = app.state::<AppState>();
        let st = st.read();
        assert_eq!(st.settings, Settings::default(), "not for_machine(): no detected path pinned");
        let banner = st.file_banner.clone().unwrap();
        assert_eq!(banner.id, "settings.parse");
        assert_eq!(banner.text, "settings.json:3:12 expected value");
    }

    #[test]
    fn initialise_at_with_an_unwritable_dir_shows_the_write_banner() {
        let app = mock_app();
        let dir = tempfile::tempdir().unwrap();
        let blocker = dir.path().join("switchboard");
        std::fs::write(&blocker, b"not a directory").unwrap();

        initialise_at(app.handle(), Some(blocker.join("settings.json")), &search_in(dir.path()));

        let st = app.state::<AppState>();
        let st = st.read();
        assert_eq!(st.settings, Settings::default());
        let banner = st.file_banner.clone().unwrap();
        assert_eq!(banner.id, "settings.write");
        assert!(banner.text.starts_with("cannot write settings: "), "{}", banner.text);
    }

    #[test]
    fn initialise_at_without_a_config_dir_shows_the_write_banner() {
        let app = mock_app();
        let dir = tempfile::tempdir().unwrap();
        initialise_at(app.handle(), None, &search_in(dir.path()));
        let st = app.state::<AppState>();
        let st = st.read();
        assert_eq!(st.path, None);
        assert_eq!(
            st.file_banner.clone().unwrap(),
            Banner::new("settings.write", "cannot write settings: no platform config directory")
        );
    }

    #[test]
    fn initialise_at_validates_what_it_loads() {
        let app = mock_app();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        std::fs::write(&path, r#"{ "version": 2, "poll": { "agents_ms": 0 } }"#).unwrap();
        initialise_at(app.handle(), Some(path), &search_in(dir.path()));
        let st = app.state::<AppState>();
        let st = st.read();
        assert_eq!(st.settings.poll.agents_ms, DEFAULT_AGENTS_POLL_MS);
        let ids: Vec<&str> = st.validation_banners.iter().map(|b| b.id.as_str()).collect();
        assert_eq!(ids, ["settings.version", "settings.poll"]);
    }

    // -- reload -----------------------------------------------------------------------

    #[test]
    fn reload_with_broken_json_keeps_the_previous_settings_and_sets_the_banner() {
        let app = mock_app();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        std::fs::write(&path, r#"{ "theme": "light" }"#).unwrap();
        initialise_at(app.handle(), Some(path.clone()), &search_in(dir.path()));

        std::fs::write(&path, BROKEN).unwrap();
        assert!(!reload(app.handle()));

        let st = app.state::<AppState>();
        let st = st.read();
        assert_eq!(st.settings.theme, "light");
        assert_eq!(
            st.file_banner.clone().unwrap(),
            Banner::new("settings.parse", "settings.json:3:12 expected value")
        );
    }

    #[test]
    fn reload_with_valid_json_clears_the_banner_and_applies_the_values() {
        let app = mock_app();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        std::fs::write(&path, BROKEN).unwrap();
        initialise_at(app.handle(), Some(path.clone()), &search_in(dir.path()));
        let state = app.state::<AppState>();
        assert!(state.read().file_banner.is_some());

        std::fs::write(&path, r#"{ "theme": "solar", "poll": { "git_ms": 0 } }"#).unwrap();
        assert!(!reload(app.handle()), "no binary path changed");

        let st = state.read();
        assert_eq!(st.file_banner, None);
        assert_eq!(st.settings.theme, "solar");
        assert_eq!(st.settings.poll.git_ms, DEFAULT_GIT_POLL_MS, "validated on reload too");
        assert_eq!(st.validation_banners.len(), 1);
        assert_eq!(st.validation_banners[0].id, "settings.poll");
    }

    #[test]
    fn reload_reports_a_change_only_when_a_binary_path_changed() {
        let app = mock_app();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        std::fs::write(&path, "{}").unwrap();
        initialise_at(app.handle(), Some(path.clone()), &search_in(dir.path()));

        std::fs::write(&path, r#"{ "theme": "light" }"#).unwrap();
        assert!(!reload(app.handle()));
        std::fs::write(&path, r#"{ "theme": "light", "claude": { "path": "C:\\nope.exe" } }"#).unwrap();
        assert!(reload(app.handle()));
        std::fs::write(&path, r#"{ "theme": "dark", "claude": { "path": "C:\\nope.exe" } }"#).unwrap();
        assert!(!reload(app.handle()), "same binary config, other key changed");
        std::fs::write(&path, r#"{ "git": { "path": "/usr/bin/git" } }"#).unwrap();
        assert!(reload(app.handle()), "claude cleared and git set");
        let state = app.state::<AppState>();
        let st = state.read();
        assert_eq!(st.settings.git.path.as_deref(), Some("/usr/bin/git"));
    }

    #[test]
    fn reload_ignores_a_vanished_file() {
        let app = mock_app();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        std::fs::write(&path, r#"{ "theme": "light" }"#).unwrap();
        initialise_at(app.handle(), Some(path.clone()), &search_in(dir.path()));
        std::fs::remove_file(&path).unwrap();
        assert!(!reload(app.handle()));
        let st = app.state::<AppState>();
        let st = st.read();
        assert_eq!(st.settings.theme, "light");
        assert_eq!(st.file_banner, None);
    }
}
