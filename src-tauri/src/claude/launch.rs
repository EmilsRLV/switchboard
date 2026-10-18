//! Starting Claude sessions (Story 4.2). Rust owns the launch: it assigns the session id,
//! writes the per-session settings file in the OS temp dir, builds the argv (every argument
//! its own entry, never a shell string) and runs `claude` in a session terminal (`crate::pty`).
//! This module holds the pure parts: the request and its validation, the argv builder, the
//! appended system prompt, the launch-sheet prefill, and the temp settings files' lifecycle
//! (write, delete, sweep). The wiring lives in `crate::ipc::session_launch`.
//!
//! Nothing here writes under `~/.claude`: the settings file is `{}` (Story 4.3 adds hooks) and
//! goes to `<session dir>/<sessionId>.settings.json` ([`default_dir`]: `%TEMP%` on Windows,
//! `$XDG_RUNTIME_DIR` else the cache dir on Linux; on Unix the folder is 0700 and must be the
//! user's own, and each file is created exclusively), deleted when the session's process exits
//! and on app exit; at startup the folder is swept of files older than 24 h whose session is not
//! running. `--mcp-config` stays out until the MCP server ships (Epic 7), and
//! `bypassPermissions` / `--dangerously-skip-permissions` are never produced.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, SystemTime};

use serde::{Deserialize, Serialize};

use crate::graph;
use crate::settings;

/// The choice that leaves a flag out (`claude`'s own default applies).
pub const DEFAULT_CHOICE: &str = "default";

/// The models the sheet offers by name; any other non-blank text is a custom model.
pub const MODELS: [&str; 5] = [DEFAULT_CHOICE, "fable", "opus", "sonnet", "haiku"];

/// The efforts the sheet offers.
pub const EFFORTS: [&str; 6] = [DEFAULT_CHOICE, "low", "medium", "high", "xhigh", "max"];

/// The permission modes the sheet offers. `bypassPermissions` is not one of them.
pub const PERMISSION_MODES: [&str; 6] = [DEFAULT_CHOICE, "manual", "acceptEdits", "plan", "auto", "dontAsk"];

/// The permission mode Switchboard never launches with.
pub const BYPASS_PERMISSIONS: &str = "bypassPermissions";

/// Why a launch with `bypassPermissions` is refused.
pub const BYPASS_REFUSED: &str = "bypassPermissions is not offered: Switchboard never skips permission prompts";

/// Why a launch is refused when `claude.path` is a `.cmd` / `.bat` (Windows): `cmd.exe` would
/// re-parse the prompt.
pub const BATCH_FILE: &str = "claude.path points to a batch file; set it to the native claude.exe";

/// Why a launch is refused while no usable `claude` is known.
pub const NO_CLAUDE: &str = "claude not found; set claude.path in settings";

/// The start of the error for add-dirs that are not existing folders; the paths follow, one
/// per line.
pub const ADD_DIR_MISSING: &str = "add-dir does not exist: ";

/// Why a launch is refused when its session id is not the one proposed to the sheet.
pub const STALE_SHEET: &str = "this launch sheet is out of date; open it again";

/// Why a launch is refused when its session id already names a session or terminal.
pub const ID_IN_USE: &str = "that session id is already in use; open the sheet again";

/// The settings file's name after the session id.
pub const SETTINGS_SUFFIX: &str = ".settings.json";

/// What the per-session settings file holds in this story (Story 4.3 adds the hooks).
pub const SETTINGS_CONTENT: &str = "{}";

/// Files older than this, whose session is not running, are swept at startup.
pub const SWEEP_AGE: Duration = Duration::from_secs(24 * 60 * 60);

/// The environment variable that names the session's node.
pub const NODE_ENV: &str = "SWITCHBOARD_NODE";

/// What the launch sheet sends (`session_launch`). `model`, `effort` and `permission_mode`
/// are the sheet's choices: `default` (or blank, or absent) leaves the flag out.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct LaunchRequest {
    pub project_id: String,
    /// The session id the sheet showed (its default name was made from it): the one
    /// `launch_defaults` proposed to this project. A launch with any other id is refused.
    pub session_id: String,
    pub name: String,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub permission_mode: Option<String>,
    pub add_dirs: Vec<String>,
    pub prompt: Option<String>,
    /// Start in background: the frontend's concern (the pane stays shut); Rust ignores it.
    pub background: bool,
}

/// What `launch_defaults` returns: the sheet's prefill for a project.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LaunchPrefill {
    /// The fresh session id proposed for this sheet; the launch sends it back.
    pub session_id: String,
    /// `<project label>-<first 4 hex of the session id the launch will use>`.
    pub name: String,
    /// A named model, `default`, or custom text.
    pub model: String,
    pub effort: String,
    pub permission_mode: String,
}

/// A trimmed, non-blank choice other than `default`: the value a flag carries.
fn flag_value(choice: Option<&str>) -> Option<&str> {
    choice.map(str::trim).filter(|c| !c.is_empty() && *c != DEFAULT_CHOICE)
}

/// The session name to launch with: trimmed, not blank, not starting with `-` (it would read
/// as a flag), no control characters.
pub fn validate_name(name: &str) -> Result<String, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("name must not be blank".to_string());
    }
    if name.starts_with('-') {
        return Err("name must not start with -".to_string());
    }
    if name.chars().any(char::is_control) {
        return Err("name must not contain control characters".to_string());
    }
    Ok(name.to_string())
}

/// `text` without control characters (a newline in a folder name must not add a line to the
/// system prompt).
fn without_controls(text: &str) -> String {
    text.chars().filter(|c| !c.is_control()).collect()
}

/// The permission mode flag value: `None` for `default` (2.1.302 has no such choice) or blank;
/// `bypassPermissions` and anything not offered are refused.
pub fn permission_mode_flag(mode: Option<&str>) -> Result<Option<&str>, String> {
    let Some(mode) = flag_value(mode) else {
        return Ok(None);
    };
    if mode == BYPASS_PERMISSIONS {
        return Err(BYPASS_REFUSED.to_string());
    }
    if PERMISSION_MODES.contains(&mode) {
        Ok(Some(mode))
    } else {
        Err(format!("unknown permission mode {mode}"))
    }
}

/// The effort flag value: `None` for `default` or blank; anything not offered is refused.
pub fn effort_flag(effort: Option<&str>) -> Result<Option<&str>, String> {
    match flag_value(effort) {
        None => Ok(None),
        Some(effort) if EFFORTS.contains(&effort) => Ok(Some(effort)),
        Some(effort) => Err(format!("unknown effort {effort}")),
    }
}

/// The model flag value: `None` for `default` or blank; a named model or custom text, which
/// must not start with `-`.
pub fn model_flag(model: Option<&str>) -> Result<Option<&str>, String> {
    match flag_value(model) {
        Some(model) if model.starts_with('-') => Err("model must not start with -".to_string()),
        other => Ok(other),
    }
}

/// The file Windows runs for `program`: itself when it has an extension or is a file, else the
/// first `program<ext>` that is a file, in `PATHEXT` order (`extensions`, e.g. `.exe`, `.cmd`).
pub fn pathext_target(program: &Path, extensions: &[String]) -> PathBuf {
    if program.extension().is_some() || program.is_file() {
        return program.to_path_buf();
    }
    extensions
        .iter()
        .map(|ext| PathBuf::from(format!("{}{ext}", program.display())))
        .find(|candidate| candidate.is_file())
        .unwrap_or_else(|| program.to_path_buf())
}

/// `claude.path` names a batch file (`.cmd` / `.bat`, any case) and this is Windows: refused,
/// so `cmd.exe` never re-parses the prompt. Pass the path [`pathext_target`] resolved, so an
/// extensionless `claude.path` that resolves to a batch file is refused too.
pub fn refuse_batch(program: &Path, windows: bool) -> Result<(), String> {
    let batch = program
        .extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| ext.eq_ignore_ascii_case("cmd") || ext.eq_ignore_ascii_case("bat"));
    if windows && batch { Err(BATCH_FILE.to_string()) } else { Ok(()) }
}

/// The add-dirs as `--add-dir` gets them: each trimmed and canonicalised; blanks, duplicates
/// and the project's own folder dropped. Paths that are not existing folders are an `Err`
/// naming all of them: [`ADD_DIR_MISSING`] + the paths as given, one per line.
pub fn normalise_add_dirs(dirs: &[String], project_path: &str) -> Result<Vec<String>, String> {
    let mut out: Vec<String> = Vec::new();
    let mut missing: Vec<&str> = Vec::new();
    for raw in dirs {
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Some(canonical) = dunce::canonicalize(trimmed)
            .ok()
            .filter(|path| path.is_dir())
            .map(|path| path.display().to_string())
        else {
            missing.push(trimmed);
            continue;
        };
        if graph::same_path(&canonical, project_path) || out.iter().any(|known| graph::same_path(known, &canonical)) {
            continue;
        }
        out.push(canonical);
    }
    if missing.is_empty() { Ok(out) } else { Err(format!("{ADD_DIR_MISSING}{}", missing.join("\n"))) }
}

/// The `--append-system-prompt` text: at most six short lines of node context and no
/// instructions. The branch line only when the branch is known. Control characters are
/// stripped from every value, so none of them can add a line.
pub fn system_prompt(label: &str, path: &str, branch: Option<&str>, name: &str, session_id: &str) -> String {
    let mut lines = vec![
        "This Claude Code session runs inside Switchboard, a canvas app that starts and watches sessions.".to_string(),
        format!("Project: {}", without_controls(label)),
        format!("Project folder: {}", without_controls(path)),
    ];
    if let Some(branch) = branch.map(without_controls).map(|b| b.trim().to_string()).filter(|b| !b.is_empty()) {
        lines.push(format!("Branch: {branch}"));
    }
    lines.push(format!("Session name: {}", without_controls(name)));
    lines.push(format!("Switchboard node id: {}", without_controls(session_id)));
    lines.join("\n")
}

/// The argv after the program, as the Decisions recipe spells it:
/// `--session-id <id> --name <name> [--model <m>] [--effort <e>] [--permission-mode <p>]
/// [--add-dir <d>]… --settings <path> --append-system-prompt <context> [<prompt>]`. A choice
/// left at `default` is omitted; the prompt is the last argument, only when not blank (after
/// a `--` when it starts with `-`, so it is never read as a flag). `req.add_dirs` are taken
/// as given (see [`normalise_add_dirs`]). Validation failures are `Err`: a blank name,
/// `bypassPermissions`, an effort or mode not offered.
pub fn build_args(req: &LaunchRequest, session_id: &str, settings_path: &Path, system_prompt: &str) -> Result<Vec<String>, String> {
    let name = validate_name(&req.name)?;
    let model = model_flag(req.model.as_deref())?;
    let effort = effort_flag(req.effort.as_deref())?;
    let mode = permission_mode_flag(req.permission_mode.as_deref())?;
    let mut args: Vec<String> = vec!["--session-id".into(), session_id.into(), "--name".into(), name];
    for (flag, value) in [("--model", model), ("--effort", effort), ("--permission-mode", mode)] {
        if let Some(value) = value {
            args.push(flag.into());
            args.push(value.into());
        }
    }
    for dir in &req.add_dirs {
        args.push("--add-dir".into());
        args.push(dir.clone());
    }
    args.push("--settings".into());
    args.push(settings_path.display().to_string());
    args.push("--append-system-prompt".into());
    args.push(system_prompt.into());
    if let Some(prompt) = req.prompt.as_deref().filter(|p| !p.trim().is_empty()) {
        if prompt.starts_with('-') {
            args.push("--".into());
        }
        args.push(prompt.into());
    }
    Ok(args)
}

/// The default session name: `<label>-<first 4 hex of the session id>`. The label loses its
/// control characters and any leading `-` and whitespace (the name must not read as a flag);
/// nothing left is `session`.
pub fn default_name(label: &str, session_id: &str) -> String {
    let hex: String = session_id.chars().filter(char::is_ascii_hexdigit).take(4).collect();
    let clean = without_controls(label);
    let label = clean.trim_start_matches(|c: char| c == '-' || c.is_whitespace()).trim_end();
    let label = if label.is_empty() { "session" } else { label };
    format!("{label}-{hex}")
}

/// The sheet's prefill: each choice from the project's last choices, else `settings.defaults`,
/// else `default`. An effort or permission mode the sheet does not offer (a hand-edited file,
/// `bypassPermissions`) reads as `default`.
pub fn prefill(project: Option<&graph::LaunchDefaults>, settings: &settings::LaunchDefaults, session_id: String, name: String) -> LaunchPrefill {
    let pick = |project: Option<&Option<String>>, settings: &Option<String>| -> String {
        project
            .and_then(|v| v.as_deref())
            .map(str::trim)
            .filter(|v| !v.is_empty())
            .or_else(|| settings.as_deref().map(str::trim).filter(|v| !v.is_empty()))
            .unwrap_or(DEFAULT_CHOICE)
            .to_string()
    };
    let offered = |value: String, list: &[&str]| if list.contains(&value.as_str()) { value } else { DEFAULT_CHOICE.to_string() };
    LaunchPrefill {
        session_id,
        name,
        model: pick(project.map(|p| &p.model), &settings.model),
        effort: offered(pick(project.map(|p| &p.effort), &settings.effort), &EFFORTS),
        permission_mode: offered(
            pick(project.map(|p| &p.permission_mode), &settings.permission_mode),
            &PERMISSION_MODES,
        ),
    }
}

/// What a start remembers for the project (`Project.launchDefaults`): the three choices as
/// made, `default` included; add-dirs, prompt, name and background are not remembered.
pub fn remembered(req: &LaunchRequest) -> graph::LaunchDefaults {
    let choice = |value: Option<&str>| Some(value.map(str::trim).filter(|v| !v.is_empty()).unwrap_or(DEFAULT_CHOICE).to_string());
    graph::LaunchDefaults {
        model: choice(req.model.as_deref()),
        effort: choice(req.effort.as_deref()),
        permission_mode: choice(req.permission_mode.as_deref()),
    }
}

// ---------------------------------------------------------------------------------------
// Session settings files
// ---------------------------------------------------------------------------------------

/// Where the per-session settings files go: `<root>/switchboard/sessions` in a per-user root
/// ([`session_root`]).
pub fn default_dir() -> PathBuf {
    session_root(
        cfg!(windows),
        std::env::var_os("XDG_RUNTIME_DIR"),
        dirs::cache_dir(),
        std::env::temp_dir(),
    )
    .join("switchboard")
    .join("sessions")
}

/// The per-user root of the session dir: on Windows the OS temp dir (`%TEMP%` is per-user);
/// elsewhere `$XDG_RUNTIME_DIR` when set to an absolute path, else the user's cache dir, else
/// the temp dir (the folder checks of [`prepare_dir`] still apply there).
pub fn session_root(windows: bool, runtime: Option<std::ffi::OsString>, cache: Option<PathBuf>, temp: PathBuf) -> PathBuf {
    if windows {
        return temp;
    }
    runtime
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .filter(|p| p.is_absolute())
        .or(cache)
        .unwrap_or(temp)
}

/// Create the session dir if needed and make sure it is safe to write to. On Unix the folder
/// and its parent are created 0700, must be real folders (not symlinks) owned by this user, and
/// are narrowed to 0700 when wider; anything else is an `Err` and nothing is written.
pub fn prepare_dir(dir: &Path) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        std::fs::DirBuilder::new().recursive(true).mode(0o700).create(dir)?;
        // SAFETY: `geteuid` has no preconditions.
        let uid = unsafe { libc::geteuid() };
        if let Some(parent) = dir.parent().filter(|p| p.file_name().is_some_and(|n| n == "switchboard")) {
            check_owned_dir(parent, uid)?;
        }
        check_owned_dir(dir, uid)
    }
    #[cfg(not(unix))]
    {
        std::fs::create_dir_all(dir)
    }
}

/// `dir` is a real folder (not a symlink) owned by `uid`; a mode wider than 0700 is narrowed.
#[cfg(unix)]
pub fn check_owned_dir(dir: &Path, uid: u32) -> std::io::Result<()> {
    use std::os::unix::fs::{MetadataExt, PermissionsExt};
    let refuse = |why: &str| std::io::Error::other(format!("{} {why}", dir.display()));
    let meta = std::fs::symlink_metadata(dir)?;
    if meta.file_type().is_symlink() || !meta.is_dir() {
        return Err(refuse("is not a folder"));
    }
    if meta.uid() != uid {
        return Err(refuse("is owned by another user"));
    }
    if meta.mode() & 0o077 != 0 {
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

/// `<dir>/<session_id>.settings.json`.
pub fn settings_path(dir: &Path, session_id: &str) -> PathBuf {
    dir.join(format!("{session_id}{SETTINGS_SUFFIX}"))
}

/// Write `{}` to a new settings file for the session ([`prepare_dir`] first). The file is
/// created exclusively (0600 on Unix): one already there is an `Err`, never overwritten.
pub fn write_settings_file(dir: &Path, session_id: &str) -> std::io::Result<PathBuf> {
    use std::io::Write;
    prepare_dir(dir)?;
    let path = settings_path(dir, session_id);
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(&path)?.write_all(SETTINGS_CONTENT.as_bytes())?;
    Ok(path)
}

/// Delete every `*.settings.json` in `dir` last modified more than `max_age` before `now` whose
/// session id is not in `running`. Returns what was deleted. A missing folder is nothing to do.
pub fn sweep(dir: &Path, running: &HashSet<String>, max_age: Duration, now: SystemTime) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut removed = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(id) = path.file_name().and_then(|n| n.to_str()).and_then(|n| n.strip_suffix(SETTINGS_SUFFIX)) else {
            continue;
        };
        if running.contains(id) {
            continue;
        }
        let old = entry
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|modified| now.duration_since(modified).ok())
            .is_some_and(|age| age > max_age);
        if old && entry.file_type().is_ok_and(|t| t.is_file()) && std::fs::remove_file(&path).is_ok() {
            removed.push(path);
        }
    }
    removed
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|e| e.into_inner())
}

/// The launcher's state (in `AppState`): where settings files go, which ones it wrote, and the
/// session id proposed to each project's open sheet.
#[derive(Default)]
pub struct Launcher {
    /// Set in `setup` to [`default_dir`]; tests set their own. `None`: no launch possible.
    dir: Mutex<Option<PathBuf>>,
    /// Session ids whose settings file this run wrote and has not deleted.
    files: Mutex<HashSet<String>>,
    /// Project id → the session id its sheet's default name was made from.
    proposed: Mutex<HashMap<String, String>>,
    /// Tests only: the program (and leading arguments) run instead of `claude`.
    #[cfg(test)]
    pub program: Mutex<Option<(PathBuf, Vec<String>)>>,
}

impl Launcher {
    pub fn set_dir(&self, dir: PathBuf) {
        *lock(&self.dir) = Some(dir);
    }

    pub fn dir(&self) -> Option<PathBuf> {
        lock(&self.dir).clone()
    }

    /// A fresh v4 session id for `project_id`'s sheet, remembered for its launch.
    pub fn propose(&self, project_id: &str) -> String {
        let id = uuid::Uuid::new_v4().to_string();
        lock(&self.proposed).insert(project_id.to_string(), id.clone());
        id
    }

    /// Take `session_id` out of `project_id`'s proposal, atomically: only the id the sheet was
    /// given, and only once, so two starts racing from one sheet cannot both have it. `Err`
    /// when it is not the proposed one (a stale sheet, or a start already under way).
    pub fn claim(&self, project_id: &str, session_id: &str) -> Result<(), String> {
        let mut proposed = lock(&self.proposed);
        if proposed.get(project_id).is_some_and(|id| id == session_id) {
            proposed.remove(project_id);
            Ok(())
        } else {
            Err(STALE_SHEET.to_string())
        }
    }

    /// A claimed id whose launch failed before anything ran: proposed again, so a retry from
    /// the same sheet keeps the name's 4 hex matching its id (unless a newer sheet has a
    /// proposal by now).
    pub fn unclaim(&self, project_id: &str, session_id: &str) {
        lock(&self.proposed).entry(project_id.to_string()).or_insert_with(|| session_id.to_string());
    }

    /// Write the session's settings file and remember it for deletion.
    pub fn write_settings(&self, session_id: &str) -> Result<PathBuf, String> {
        let dir = self.dir().ok_or_else(|| "no folder for session settings files".to_string())?;
        let path = write_settings_file(&dir, session_id).map_err(|err| format!("could not write session settings: {err}"))?;
        lock(&self.files).insert(session_id.to_string());
        Ok(path)
    }

    /// Delete the session's settings file (its process exited, or never started), only when
    /// this run wrote it.
    pub fn remove_settings(&self, session_id: &str) {
        if !lock(&self.files).remove(session_id) {
            return;
        }
        if let Some(dir) = self.dir() {
            let _ = std::fs::remove_file(settings_path(&dir, session_id));
        }
    }

    /// Delete every settings file this run wrote (app exit).
    pub fn remove_all(&self) {
        let ids: Vec<String> = lock(&self.files).drain().collect();
        if let Some(dir) = self.dir() {
            for id in ids {
                let _ = std::fs::remove_file(settings_path(&dir, &id));
            }
        }
    }

    /// Session ids whose settings file is still kept.
    pub fn kept(&self) -> HashSet<String> {
        lock(&self.files).clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request() -> LaunchRequest {
        LaunchRequest {
            project_id: "ide".into(),
            name: " ide-3f2a ".into(),
            ..LaunchRequest::default()
        }
    }

    const ID: &str = "3f2a9c1e-5b7d-4e8f-9a0b-1c2d3e4f5a6b";

    #[test]
    fn defaults_build_the_minimal_recipe() {
        let req = LaunchRequest {
            model: Some("default".into()),
            effort: Some("".into()),
            permission_mode: Some("default".into()),
            prompt: Some("   ".into()),
            ..request()
        };
        let args = build_args(&req, ID, Path::new("/tmp/s/x.settings.json"), "ctx").unwrap();
        assert_eq!(
            args,
            [
                "--session-id",
                ID,
                "--name",
                "ide-3f2a",
                "--settings",
                &Path::new("/tmp/s/x.settings.json").display().to_string(),
                "--append-system-prompt",
                "ctx"
            ]
        );
        assert!(!args.iter().any(|a| a == "--mcp-config" || a == "--dangerously-skip-permissions"));
    }

    #[test]
    fn chosen_flags_add_dirs_and_the_prompt_come_in_recipe_order() {
        let req = LaunchRequest {
            model: Some("opus".into()),
            effort: Some("high".into()),
            permission_mode: Some("plan".into()),
            add_dirs: vec!["/work/a".into(), "/work/b c".into()],
            prompt: Some("hi there".into()),
            ..request()
        };
        let args = build_args(&req, ID, Path::new("s.json"), "line 1\nline 2").unwrap();
        assert_eq!(
            args,
            [
                "--session-id",
                ID,
                "--name",
                "ide-3f2a",
                "--model",
                "opus",
                "--effort",
                "high",
                "--permission-mode",
                "plan",
                "--add-dir",
                "/work/a",
                "--add-dir",
                "/work/b c",
                "--settings",
                "s.json",
                "--append-system-prompt",
                "line 1\nline 2",
                "hi there"
            ]
        );
        // A custom model goes verbatim; a prompt that looks like a flag follows `--`.
        let req = LaunchRequest {
            model: Some(" claude-opus-4-1 ".into()),
            prompt: Some("-v please".into()),
            ..request()
        };
        let args = build_args(&req, ID, Path::new("s.json"), "ctx").unwrap();
        assert_eq!(&args[4..6], ["--model", "claude-opus-4-1"]);
        assert_eq!(&args[args.len() - 2..], ["--", "-v please"]);
    }

    #[test]
    fn invalid_requests_are_refused() {
        let with = |f: fn(&mut LaunchRequest)| {
            let mut req = request();
            f(&mut req);
            build_args(&req, ID, Path::new("s.json"), "ctx")
        };
        assert_eq!(with(|r| r.name = "  ".into()), Err("name must not be blank".to_string()));
        assert_eq!(with(|r| r.name = "-x".into()), Err("name must not start with -".to_string()));
        assert_eq!(with(|r| r.permission_mode = Some("bypassPermissions".into())), Err(BYPASS_REFUSED.to_string()));
        assert_eq!(with(|r| r.permission_mode = Some("yolo".into())), Err("unknown permission mode yolo".to_string()));
        assert_eq!(with(|r| r.effort = Some("ultra".into())), Err("unknown effort ultra".to_string()));
        assert_eq!(with(|r| r.model = Some("--evil".into())), Err("model must not start with -".to_string()));
        for mode in PERMISSION_MODES {
            assert!(with_mode(mode).is_ok(), "{mode}");
        }
        for effort in EFFORTS {
            let req = LaunchRequest {
                effort: Some(effort.into()),
                ..request()
            };
            assert!(build_args(&req, ID, Path::new("s.json"), "ctx").is_ok(), "{effort}");
        }
    }

    fn with_mode(mode: &str) -> Result<Vec<String>, String> {
        let req = LaunchRequest {
            permission_mode: Some(mode.into()),
            ..request()
        };
        build_args(&req, ID, Path::new("s.json"), "ctx")
    }


    #[test]
    fn a_batch_claude_is_refused_on_windows_only() {
        assert_eq!(refuse_batch(Path::new("C:\\tools\\claude.cmd"), true), Err(BATCH_FILE.to_string()));
        assert_eq!(refuse_batch(Path::new("C:\\tools\\claude.BAT"), true), Err(BATCH_FILE.to_string()));
        assert_eq!(refuse_batch(Path::new("C:\\tools\\claude.exe"), true), Ok(()));
        assert_eq!(refuse_batch(Path::new("/usr/bin/claude"), true), Ok(()));
        assert_eq!(refuse_batch(Path::new("/opt/claude.cmd"), false), Ok(()));
    }

    #[test]
    fn an_extensionless_claude_path_is_checked_as_pathext_resolves_it() {
        let dir = tempfile::tempdir().unwrap();
        let exts: Vec<String> = [".com", ".exe", ".bat", ".cmd"].map(String::from).to_vec();
        let bare = dir.path().join("claude");
        // Only the npm shim: resolves to claude.cmd, refused.
        std::fs::write(dir.path().join("claude.cmd"), "@echo off").unwrap();
        let target = pathext_target(&bare, &exts);
        assert_eq!(target, dir.path().join("claude.cmd"));
        assert_eq!(refuse_batch(&target, true), Err(BATCH_FILE.to_string()));
        // The native binary next to it comes first in PATHEXT order.
        std::fs::write(dir.path().join("claude.exe"), "").unwrap();
        assert_eq!(pathext_target(&bare, &exts), dir.path().join("claude.exe"));
        // A path with an extension, or an existing extensionless file, stands as given.
        assert_eq!(pathext_target(&dir.path().join("x.cmd"), &exts), dir.path().join("x.cmd"));
        std::fs::write(&bare, "").unwrap();
        assert_eq!(pathext_target(&bare, &exts), bare);
        assert_eq!(pathext_target(&dir.path().join("none"), &exts), dir.path().join("none"));
    }

    #[test]
    fn add_dirs_are_canonical_without_duplicates_or_the_project_and_must_all_exist() {
        let project = tempfile::tempdir().unwrap();
        let other = tempfile::tempdir().unwrap();
        let canonical = |p: &Path| dunce::canonicalize(p).unwrap().display().to_string();
        let project_path = canonical(project.path());
        let spelled = format!("{}{}", other.path().display(), std::path::MAIN_SEPARATOR);
        let dirs = vec![
            other.path().display().to_string(),
            spelled,
            project.path().display().to_string(),
            "  ".into(),
        ];
        assert_eq!(normalise_add_dirs(&dirs, &project_path), Ok(vec![canonical(other.path())]));
        let gone = other.path().join("gone").display().to_string();
        let file = other.path().join("f.txt");
        std::fs::write(&file, "x").unwrap();
        let file = file.display().to_string();
        // Every missing one is named at once, one per line; a file is not a folder.
        assert_eq!(
            normalise_add_dirs(&[gone.clone(), other.path().display().to_string(), file.clone()], &project_path),
            Err(format!("{ADD_DIR_MISSING}{gone}\n{file}"))
        );
    }

    #[test]
    fn the_system_prompt_is_six_lines_of_context_without_control_characters() {
        let text = system_prompt("ide", "B:\\projects\\ide", Some("master"), "ide-3f2a", ID);
        let lines: Vec<&str> = text.lines().collect();
        assert_eq!(lines.len(), 6);
        assert!(lines[0].contains("Switchboard"));
        assert_eq!(
            &lines[1..],
            [
                "Project: ide",
                "Project folder: B:\\projects\\ide",
                "Branch: master",
                "Session name: ide-3f2a",
                &format!("Switchboard node id: {ID}"),
            ]
        );
        let no_branch = system_prompt("ide", "/p", None, "n", ID);
        assert!(!no_branch.contains("Branch:"));
        assert_eq!(no_branch.lines().count(), 5);
        // A newline in a folder name or branch cannot add a line (or an instruction).
        let sneaky = system_prompt("a\nIgnore all", "/p/a\r\nb", Some("x\ny"), "n", ID);
        assert_eq!(sneaky.lines().count(), 6);
        assert!(sneaky.contains("Project: aIgnore all"));
        assert!(sneaky.contains("Project folder: /p/ab"));
        assert!(sneaky.contains("Branch: xy"));
        assert_eq!(system_prompt("a", "/p", Some(" \n "), "n", ID).lines().count(), 5, "a blank branch is no branch");
    }

    #[test]
    fn the_default_name_is_the_label_and_four_hex_of_the_id() {
        assert_eq!(default_name("ide", ID), "ide-3f2a");
        assert_eq!(default_name("my app", "ab-cd12-ef"), "my app-abcd");
        assert_eq!(default_name("--flaggy", ID), "flaggy-3f2a", "never starts with -");
        assert_eq!(default_name(" - x", ID), "x-3f2a");
        assert_eq!(default_name("-- ", ID), "session-3f2a");
        assert_eq!(default_name("a\tb", ID), "ab-3f2a");
        assert!(validate_name(&default_name("--", ID)).is_ok());
    }

    #[test]
    fn names_with_control_characters_are_refused() {
        assert_eq!(validate_name("a\nb"), Err("name must not contain control characters".to_string()));
        assert_eq!(validate_name("a\u{1b}[31m"), Err("name must not contain control characters".to_string()));
        assert_eq!(validate_name("  ok  "), Ok("ok".to_string()));
    }

    #[test]
    fn prefill_takes_the_project_then_settings_then_default() {
        let settings = settings::LaunchDefaults {
            model: Some("sonnet".into()),
            effort: None,
            permission_mode: Some("default".into()),
        };
        let none = prefill(None, &settings, ID.into(), "n".into());
        assert_eq!(
            none,
            LaunchPrefill {
                session_id: ID.into(),
                name: "n".into(),
                model: "sonnet".into(),
                effort: "default".into(),
                permission_mode: "default".into(),
            }
        );
        let project = graph::LaunchDefaults {
            model: Some("opus".into()),
            effort: Some("high".into()),
            permission_mode: None,
        };
        let filled = prefill(Some(&project), &settings, ID.into(), "n".into());
        assert_eq!((filled.model.as_str(), filled.effort.as_str(), filled.permission_mode.as_str()), ("opus", "high", "default"));
        // Not offered: read as default.
        let odd = graph::LaunchDefaults {
            model: Some("my-model".into()),
            effort: Some("ultra".into()),
            permission_mode: Some("bypassPermissions".into()),
        };
        let filled = prefill(Some(&odd), &settings, ID.into(), "n".into());
        assert_eq!((filled.model.as_str(), filled.effort.as_str(), filled.permission_mode.as_str()), ("my-model", "default", "default"));
        let wire = serde_json::to_value(&filled).unwrap();
        assert_eq!(wire["permissionMode"], "default");
        assert_eq!(wire["sessionId"], ID);
    }

    #[test]
    fn remembered_keeps_the_three_choices_with_default_spelled_out() {
        let req = LaunchRequest {
            model: Some("opus".into()),
            effort: None,
            permission_mode: Some("plan".into()),
            add_dirs: vec!["/x".into()],
            prompt: Some("hi".into()),
            ..request()
        };
        assert_eq!(
            remembered(&req),
            graph::LaunchDefaults {
                model: Some("opus".into()),
                effort: Some("default".into()),
                permission_mode: Some("plan".into()),
            }
        );
    }

    #[test]
    fn the_request_reads_camel_case_and_fills_in_what_is_missing() {
        let req: LaunchRequest = serde_json::from_value(serde_json::json!({
            "projectId": "ide", "sessionId": ID, "name": "n", "permissionMode": "plan", "addDirs": ["/a"], "background": true
        }))
        .unwrap();
        assert_eq!(req.project_id, "ide");
        assert_eq!(req.session_id, ID);
        assert_eq!(req.permission_mode.as_deref(), Some("plan"));
        assert_eq!(req.add_dirs, ["/a"]);
        assert!(req.background);
        assert_eq!(req.prompt, None);
    }

    #[test]
    fn the_session_root_is_per_user() {
        let temp = PathBuf::from("/tmp");
        let cache = Some(PathBuf::from("/home/u/.cache"));
        assert_eq!(session_root(true, Some("/run/user/1000".into()), cache.clone(), PathBuf::from("C:\\Users\\u\\Temp")), PathBuf::from("C:\\Users\\u\\Temp"));
        // An absolute runtime dir on this OS (`/run/user/1000` is not absolute on Windows).
        let runtime = std::env::temp_dir().join("run-user-1000");
        assert_eq!(session_root(false, Some(runtime.clone().into_os_string()), cache.clone(), temp.clone()), runtime);
        assert_eq!(session_root(false, Some("".into()), cache.clone(), temp.clone()), PathBuf::from("/home/u/.cache"));
        assert_eq!(session_root(false, Some("relative".into()), cache.clone(), temp.clone()), PathBuf::from("/home/u/.cache"));
        assert_eq!(session_root(false, None, cache, temp.clone()), PathBuf::from("/home/u/.cache"));
        assert_eq!(session_root(false, None, None, temp.clone()), temp);
        assert!(default_dir().ends_with(Path::new("switchboard").join("sessions")));
    }

    #[test]
    fn a_settings_file_is_created_exclusively_and_never_overwritten() {
        let temp = tempfile::tempdir().unwrap();
        let dir = temp.path().join("switchboard").join("sessions");
        let path = write_settings_file(&dir, "a").unwrap();
        std::fs::write(&path, "planted").unwrap();
        let err = write_settings_file(&dir, "a").expect_err("exists");
        assert_eq!(err.kind(), std::io::ErrorKind::AlreadyExists);
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "planted", "not overwritten");
        // A failed write leaves the file alone: it was not ours.
        let launcher = Launcher::default();
        launcher.set_dir(dir.clone());
        assert!(launcher.write_settings("a").unwrap_err().starts_with("could not write session settings"));
        launcher.remove_settings("a");
        assert!(path.exists());
    }

    #[cfg(unix)]
    #[test]
    fn on_unix_the_session_dir_is_0700_owned_and_not_a_symlink() {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        let temp = tempfile::tempdir().unwrap();
        let dir = temp.path().join("switchboard").join("sessions");
        let file = write_settings_file(&dir, "a").unwrap();
        let mode = |p: &Path| std::fs::metadata(p).unwrap().mode() & 0o777;
        assert_eq!(mode(&dir), 0o700);
        assert_eq!(mode(dir.parent().unwrap()), 0o700);
        assert_eq!(mode(&file), 0o600);
        // A wider folder is narrowed.
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o755)).unwrap();
        prepare_dir(&dir).unwrap();
        assert_eq!(mode(&dir), 0o700);
        // Another owner: refused.
        let uid = std::fs::metadata(&dir).unwrap().uid();
        let err = check_owned_dir(&dir, uid.wrapping_add(1)).unwrap_err();
        assert!(err.to_string().ends_with("is owned by another user"), "{err}");
        // A symlink in its place: refused, and nothing is written through it.
        let target = temp.path().join("elsewhere");
        std::fs::create_dir(&target).unwrap();
        let linked = temp.path().join("linked").join("switchboard").join("sessions");
        std::fs::create_dir_all(linked.parent().unwrap()).unwrap();
        std::os::unix::fs::symlink(&target, &linked).unwrap();
        let err = write_settings_file(&linked, "b").unwrap_err();
        assert!(err.to_string().ends_with("is not a folder"), "{err}");
        assert!(std::fs::read_dir(&target).unwrap().next().is_none());
    }

    #[test]
    fn settings_files_are_written_deleted_and_swept_in_the_given_folder() {
        let temp = tempfile::tempdir().unwrap();
        let dir = temp.path().join("switchboard").join("sessions");
        let launcher = Launcher::default();
        assert!(launcher.write_settings("a").is_err(), "no folder set");
        launcher.set_dir(dir.clone());
        let a = launcher.write_settings("a").unwrap();
        assert_eq!(a, settings_path(&dir, "a"));
        assert_eq!(std::fs::read_to_string(&a).unwrap(), "{}");
        let b = launcher.write_settings("b").unwrap();
        assert_eq!(launcher.kept(), HashSet::from(["a".to_string(), "b".to_string()]));
        launcher.remove_settings("a");
        assert!(!a.exists());
        launcher.remove_all();
        assert!(!b.exists());
        assert!(launcher.kept().is_empty());

        // The sweep: only settings files older than the age, of sessions not running.
        let now = SystemTime::now();
        let age = |path: &Path, ago: Duration| {
            std::fs::File::options().write(true).open(path).unwrap().set_modified(now - ago).unwrap();
        };
        let old = write_settings_file(&dir, "old").unwrap();
        let running = write_settings_file(&dir, "running").unwrap();
        let young = write_settings_file(&dir, "young").unwrap();
        let other = dir.join("notes.txt");
        std::fs::write(&other, "x").unwrap();
        let day_and_more = SWEEP_AGE + Duration::from_secs(3600);
        age(&old, day_and_more);
        age(&running, day_and_more);
        age(&other, day_and_more);
        age(&young, SWEEP_AGE - Duration::from_secs(3600));
        let set = HashSet::from(["running".to_string()]);
        assert_eq!(sweep(&dir, &set, SWEEP_AGE, now), vec![old.clone()]);
        assert!(!old.exists());
        assert!(young.exists() && running.exists() && other.exists());
        assert!(sweep(&temp.path().join("missing"), &set, SWEEP_AGE, now).is_empty());
    }

    #[test]
    fn a_proposed_id_is_fresh_v4_and_claimed_once() {
        let launcher = Launcher::default();
        let id = launcher.propose("ide");
        assert_eq!(uuid::Uuid::parse_str(&id).unwrap().get_version_num(), 4);
        assert_eq!(launcher.claim("ide", "someone-else"), Err(STALE_SHEET.to_string()));
        assert_eq!(launcher.claim("other", &id), Err(STALE_SHEET.to_string()));
        assert_eq!(launcher.claim("ide", &id), Ok(()));
        assert_eq!(launcher.claim("ide", &id), Err(STALE_SHEET.to_string()), "a second start of the same sheet");
        // A launch that failed before anything ran gives it back for the retry.
        launcher.unclaim("ide", &id);
        assert_eq!(launcher.claim("ide", &id), Ok(()));
        // A newer sheet's proposal wins over a late give-back.
        let newer = launcher.propose("ide");
        assert_ne!(newer, id, "a reopened sheet proposes a fresh id");
        launcher.unclaim("ide", &id);
        assert_eq!(launcher.claim("ide", &id), Err(STALE_SHEET.to_string()));
        assert_eq!(launcher.claim("ide", &newer), Ok(()));
    }
}
