//! Binary detection: find `claude` / `git` on PATH (then extra dirs), run `<bin> --version`
//! with a timeout, and parse the version out of its output. The process runner is a trait so
//! tests use a fake.

use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

use super::{Banner, Binary, BinaryStatus};
pub use crate::process::RunError;

/// How long `<bin> --version` may take before it is killed.
pub const VERSION_TIMEOUT: Duration = Duration::from_secs(5);

// ---------------------------------------------------------------------------------------
// Locating
// ---------------------------------------------------------------------------------------

/// Where to look for binaries. Built from the environment in production and by hand in tests.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Search {
    /// PATH entries, in order.
    pub path_dirs: Vec<PathBuf>,
    /// Searched after PATH (`~/.local/bin` for `claude`).
    pub extra_dirs: Vec<PathBuf>,
    /// Executable extensions tried per directory (`PATHEXT` on Windows, empty elsewhere).
    pub extensions: Vec<String>,
}

/// Which list a binary was found in.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Source {
    Path,
    Extra,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Located {
    pub path: PathBuf,
    pub source: Source,
}

impl Search {
    /// A search with no directories at all: it locates nothing (the test default for detection).
    pub fn empty() -> Self {
        Self {
            path_dirs: Vec::new(),
            extra_dirs: Vec::new(),
            extensions: platform_extensions(),
        }
    }

    /// PATH from the environment plus the given extra dirs.
    pub fn from_env(extra_dirs: Vec<PathBuf>) -> Self {
        Self::from_path_var(std::env::var_os("PATH").as_deref(), extra_dirs)
    }

    /// A `PATH` value (absent: no dirs) plus the given extra dirs.
    pub fn from_path_var(path: Option<&OsStr>, extra_dirs: Vec<PathBuf>) -> Self {
        Self {
            path_dirs: path.map(split_path).unwrap_or_default(),
            extra_dirs,
            extensions: platform_extensions(),
        }
    }

    /// The same search without the extra dirs: what a shell spawned later will see.
    pub fn path_only(&self) -> Self {
        Self {
            path_dirs: self.path_dirs.clone(),
            extra_dirs: Vec::new(),
            extensions: self.extensions.clone(),
        }
    }

    /// First directory, PATH first then extras, containing an executable named `name`.
    pub fn locate(&self, name: &str) -> Option<Located> {
        self.locate_where(name, |_| true)
    }

    /// On Windows, [`Search::locate`] accepting only a native `.exe` / `.com`: the npm package
    /// installs `claude` as a `claude.cmd` shim, which Switchboard never runs (nor a `.ps1`
    /// and the like), so a native `claude.exe` later on PATH wins over it and a shim alone is
    /// not a hit. Elsewhere the same as [`Search::locate`].
    pub fn locate_native(&self, name: &str, windows: bool) -> Option<Located> {
        if windows {
            self.locate_where(name, is_native_windows)
        } else {
            self.locate(name)
        }
    }

    /// The first batch file (`.cmd` / `.bat`) that `name` resolves to, for the shim banner.
    pub fn locate_shim(&self, name: &str) -> Option<Located> {
        self.locate_where(name, is_batch)
    }

    fn locate_where(&self, name: &str, keep: impl Fn(&Path) -> bool) -> Option<Located> {
        let hit = |dirs: &[PathBuf], source: Source| {
            dirs.iter()
                .flat_map(|dir| candidates(dir, name, &self.extensions))
                .find(|p| keep(p) && is_executable_file(p))
                .map(|path| Located { path, source })
        };
        hit(&self.path_dirs, Source::Path).or_else(|| hit(&self.extra_dirs, Source::Extra))
    }

    /// Every directory searched, for the "not found" banner.
    pub fn searched(&self) -> Vec<String> {
        self.path_dirs
            .iter()
            .chain(self.extra_dirs.iter())
            .map(|d| d.display().to_string())
            .collect()
    }
}

/// Split a PATH value, keeping only absolute entries (a relative entry resolves against the
/// current directory and must never be pinned into `claude.path`).
pub fn split_path(value: &OsStr) -> Vec<PathBuf> {
    std::env::split_paths(value)
        .filter(|d| !d.as_os_str().is_empty() && d.is_absolute())
        .collect()
}

/// File names tried for `name` in one directory: `name` + each extension, and `name` itself
/// where that can be executable (no extensions on this platform, or it already has one).
fn candidates<'a>(dir: &'a Path, name: &'a str, extensions: &'a [String]) -> impl Iterator<Item = PathBuf> + 'a {
    let with_ext = extensions.iter().map(move |ext| dir.join(format!("{name}{ext}")));
    let bare = (extensions.is_empty() || name.contains('.')).then(|| dir.join(name));
    with_ext.chain(bare)
}

/// A `.cmd` / `.bat` file (any case): what `cmd.exe` runs, re-parsing its arguments.
pub fn is_batch(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| ext.eq_ignore_ascii_case("cmd") || ext.eq_ignore_ascii_case("bat"))
}

/// A `.exe` / `.com` file (any case): what Windows runs natively.
fn is_native_windows(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| ext.eq_ignore_ascii_case("exe") || ext.eq_ignore_ascii_case("com"))
}

/// A regular file that the OS would run: on Unix that needs an exec bit, so a stray
/// non-executable file named like the binary does not shadow the real one.
fn is_executable_file(path: &Path) -> bool {
    let Ok(meta) = std::fs::metadata(path) else {
        return false;
    };
    if !meta.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        meta.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        true
    }
}

/// Executable extensions for this platform: `PATHEXT` (lower-cased) on Windows, none elsewhere.
pub fn platform_extensions() -> Vec<String> {
    #[cfg(windows)]
    {
        let from_env = std::env::var("PATHEXT").ok().map(|v| {
            v.split(';')
                .filter(|e| !e.is_empty())
                .map(|e| e.to_ascii_lowercase())
                .collect::<Vec<_>>()
        });
        match from_env {
            Some(exts) if !exts.is_empty() => exts,
            _ => [".com", ".exe", ".bat", ".cmd"].iter().map(|s| s.to_string()).collect(),
        }
    }
    #[cfg(not(windows))]
    {
        Vec::new()
    }
}

/// `name` with the platform's primary executable extension (`.exe` on Windows); for tests
/// and fixtures that create fake binaries.
pub fn with_platform_ext(name: &str) -> String {
    if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.to_string()
    }
}

/// `~/x` → `<home>/x`; anything else unchanged.
pub(crate) fn expand_home(value: &str) -> String {
    let rest = value
        .strip_prefix("~/")
        .or_else(|| value.strip_prefix("~\\"));
    match (rest, dirs::home_dir()) {
        (Some(rest), Some(home)) => home.join(rest).display().to_string(),
        _ => value.to_string(),
    }
}

// ---------------------------------------------------------------------------------------
// Running `--version`
// ---------------------------------------------------------------------------------------

/// Runs `<bin> --version` and returns its stdout. Fakeable.
pub trait Runner: Send + Sync {
    fn version_output(&self, bin: &Path) -> Result<String, RunError>;
}

/// The real runner: spawns the process with no window, kills it after `timeout`.
#[derive(Debug, Clone)]
pub struct ProcessRunner {
    pub timeout: Duration,
}

impl Default for ProcessRunner {
    fn default() -> Self {
        Self {
            timeout: VERSION_TIMEOUT,
        }
    }
}

impl Runner for ProcessRunner {
    fn version_output(&self, bin: &Path) -> Result<String, RunError> {
        let mut cmd = Command::new(bin);
        cmd.arg("--version");
        crate::process::run(cmd, self.timeout)?
            .success()
            .map(|done| done.stdout)
    }
}

// ---------------------------------------------------------------------------------------
// Version parsing
// ---------------------------------------------------------------------------------------

/// Pull the version out of `--version` output: `2.1.301 (Claude Code)` -> `2.1.301`,
/// `git version 2.43.0.windows.1` -> `2.43.0.windows.1`. Unparseable output comes back as
/// the raw stdout, trimmed.
pub fn parse_version(name: &str, stdout: &str) -> String {
    let raw = stdout.trim();
    let first_line = raw.lines().next().unwrap_or("");
    let tokens: Vec<&str> = first_line.split_whitespace().collect();

    let by_name = match name {
        "git" => tokens
            .iter()
            .position(|t| *t == "version")
            .and_then(|i| tokens.get(i + 1))
            .copied()
            .filter(|t| looks_like_version(t)),
        _ => None,
    };
    by_name
        .or_else(|| tokens.iter().copied().find(|t| looks_like_version(t)))
        .map(|t| t.strip_prefix('v').filter(|r| starts_with_digit(r)).unwrap_or(t).to_string())
        .unwrap_or_else(|| raw.to_string())
}

fn looks_like_version(token: &str) -> bool {
    let body = token.strip_prefix('v').unwrap_or(token);
    starts_with_digit(body) && body.contains('.')
}

fn starts_with_digit(s: &str) -> bool {
    s.chars().next().is_some_and(|c| c.is_ascii_digit())
}

// ---------------------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------------------

/// Detect `name` by searching, then probing its version. Returns the binary record and the
/// banner to show, if any.
pub fn detect(name: &str, search: &Search, runner: &dyn Runner) -> (Binary, Option<Banner>) {
    resolve_for(name, None, search, runner, cfg!(windows))
}

/// The banner id for a `claude` that is only a batch file (Windows).
pub const SHIM_BANNER: &str = "claude.shim";

/// The binary whose batch files are reported rather than run (Windows only).
const SHIM_GUARDED: &str = "claude";

/// Shim rules apply: `name` is `claude` and this is Windows.
fn guarded(name: &str, windows: bool) -> bool {
    windows && name == SHIM_GUARDED
}

/// Search for `lookup` and report it as `name`.
fn detect_as(
    name: &str,
    lookup: &str,
    search: &Search,
    runner: &dyn Runner,
    configured: bool,
    windows: bool,
) -> (Binary, Option<Banner>) {
    // On Windows `claude` is never run through a batch file (see `claude::launch::refuse_batch`),
    // so a shim neither counts as found nor gets its `--version` run.
    let guarded = guarded(name, windows);
    let located = if guarded {
        search.locate_native(lookup, true)
    } else {
        search.locate(lookup)
    };
    if let Some(located) = located {
        return probe(name, located.path, configured, runner);
    }
    let path = configured.then(|| lookup.to_string());
    if let Some(shim) = guarded.then(|| search.locate_shim(lookup)).flatten() {
        return shim_result(name, &shim.path, path, configured, search);
    }
    let label = if lookup == name {
        name.to_string()
    } else {
        format!("{name} ({lookup})")
    };
    (
        missing(name, path, configured),
        Some(Banner::new(
            format!("{name}.missing"),
            format!("{label} not found — searched: {}", search.searched().join(", ")),
        )),
    )
}

fn missing(name: &str, path: Option<String>, configured: bool) -> Binary {
    Binary {
        name: name.to_string(),
        path,
        version: None,
        status: BinaryStatus::Missing,
        configured,
    }
}

/// `claude` resolved only to a batch file (Windows): reported as missing, never run. When
/// `claude.path` names it while a native `claude.exe` is on the search, the banner says to
/// clear the setting; otherwise to install the native binary.
fn shim_result(
    name: &str,
    batch: &Path,
    path: Option<String>,
    configured: bool,
    search: &Search,
) -> (Binary, Option<Banner>) {
    let kind = if is_npm_shim(name, batch) { "npm shim" } else { "a batch file" };
    let text = if configured && search.locate_native(name, true).is_some() {
        let kind = if kind == "npm shim" { "the npm shim" } else { kind };
        format!("{name}.path names {kind}; clear it to use {name}.exe")
    } else {
        format!("{} ({kind}) found — install the native {name}.exe", batch.display())
    };
    (missing(name, path, configured), Some(Banner::new(SHIM_BANNER, text)))
}

/// `claude.cmd` / `claude.bat` (any case): what the npm package installs.
fn is_npm_shim(name: &str, path: &Path) -> bool {
    is_batch(path)
        && path
            .file_stem()
            .and_then(|s| s.to_str())
            .is_some_and(|s| s.eq_ignore_ascii_case(name))
}

/// Use the value configured in `settings.json` instead of searching. A leading `~` is the
/// home dir; a bare name (single path component) is looked up on PATH like an unconfigured
/// binary; a path that points at nothing is reported as such, with a note that detection
/// was skipped because it is set. On Windows a configured `claude` that is a batch file is
/// reported (shim banner) and never run.
pub fn detect_configured(
    name: &str,
    configured: &str,
    search: &Search,
    runner: &dyn Runner,
) -> (Binary, Option<Banner>) {
    resolve_for(name, Some(configured), search, runner, cfg!(windows))
}

fn detect_configured_for(
    name: &str,
    configured: &str,
    search: &Search,
    runner: &dyn Runner,
    windows: bool,
) -> (Binary, Option<Banner>) {
    let expanded = expand_home(configured);
    let path = Path::new(&expanded);
    if !path.is_absolute() && path.components().count() == 1 {
        return detect_as(name, &expanded, search, runner, true, windows);
    }
    if is_executable_file(path) {
        if guarded(name, windows) && is_batch(path) {
            return shim_result(name, path, Some(configured.to_string()), true, search);
        }
        probe(name, path.to_path_buf(), true, runner)
    } else {
        (
            Binary {
                name: name.to_string(),
                path: Some(configured.to_string()),
                version: None,
                status: BinaryStatus::ConfiguredMissing,
                configured: true,
            },
            Some(Banner::new(
                format!("{name}.configured_missing"),
                format!(
                    "{name}: configured path {configured} does not exist — detection skipped because {name}.path is set in settings.json"
                ),
            )),
        )
    }
}

/// [`detect_configured`] when a path is set, [`detect`] otherwise.
pub fn resolve(
    name: &str,
    configured: Option<&str>,
    search: &Search,
    runner: &dyn Runner,
) -> (Binary, Option<Banner>) {
    resolve_for(name, configured, search, runner, cfg!(windows))
}

/// [`resolve`] with the platform explicit, so the Windows shim rules are tested everywhere.
pub(crate) fn resolve_for(
    name: &str,
    configured: Option<&str>,
    search: &Search,
    runner: &dyn Runner,
    windows: bool,
) -> (Binary, Option<Banner>) {
    match configured.map(str::trim).filter(|p| !p.is_empty()) {
        Some(path) => detect_configured_for(name, path, search, runner, windows),
        None => detect_as(name, name, search, runner, false, windows),
    }
}

fn probe(name: &str, path: PathBuf, configured: bool, runner: &dyn Runner) -> (Binary, Option<Banner>) {
    let display = path.display().to_string();
    match runner.version_output(&path) {
        Ok(stdout) => (
            Binary {
                name: name.to_string(),
                path: Some(display),
                version: Some(parse_version(name, &stdout)).filter(|v| !v.is_empty()),
                status: BinaryStatus::Found,
                configured,
            },
            None,
        ),
        Err(err) => (
            Binary {
                name: name.to_string(),
                path: Some(display.clone()),
                version: None,
                status: BinaryStatus::VersionFailed,
                configured,
            },
            Some(Banner::new(
                format!("{name}.version"),
                format!("could not read version of {display}: {err}"),
            )),
        ),
    }
}

/// Helpers shared by this module's tests and `settings::tests`.
#[cfg(test)]
pub(crate) mod fixtures {
    use std::path::{Path, PathBuf};

    /// An empty file named like an executable (`.exe` on Windows, exec bit on Unix).
    pub(crate) fn fake_binary(dir: &Path, name: &str) -> PathBuf {
        let path = dir.join(super::with_platform_ext(name));
        write_executable(&path, b"");
        path
    }

    pub(crate) use crate::process::fixtures::{script, write_executable};
}

#[cfg(test)]
mod tests {
    use super::fixtures::{fake_binary, script};
    use super::*;
    use std::collections::HashMap;
    use std::sync::Mutex;

    /// Fake runner: canned output per path, recording every call.
    #[derive(Default)]
    struct FakeRunner {
        outputs: HashMap<PathBuf, Result<String, RunError>>,
        calls: Mutex<Vec<PathBuf>>,
    }

    impl FakeRunner {
        fn with(mut self, path: &Path, out: Result<&str, RunError>) -> Self {
            self.outputs.insert(path.to_path_buf(), out.map(str::to_string));
            self
        }
    }

    impl Runner for FakeRunner {
        fn version_output(&self, bin: &Path) -> Result<String, RunError> {
            self.calls.lock().unwrap().push(bin.to_path_buf());
            self.outputs
                .get(bin)
                .cloned()
                .unwrap_or_else(|| Err(RunError::Spawn("no fixture".into())))
        }
    }

    fn search(path_dirs: Vec<PathBuf>, extra_dirs: Vec<PathBuf>) -> Search {
        Search {
            path_dirs,
            extra_dirs,
            extensions: platform_extensions(),
        }
    }

    /// An absolute path that exists on no machine, in this platform's syntax.
    fn nowhere() -> &'static str {
        if cfg!(windows) { "C:\\nope.exe" } else { "/nope/claude" }
    }

    // -- version parsing --------------------------------------------------------------

    #[test]
    fn parses_claude_version_line() {
        assert_eq!(parse_version("claude", "2.1.301 (Claude Code)\n"), "2.1.301");
    }

    #[test]
    fn parses_git_version_line_including_platform_suffix() {
        assert_eq!(parse_version("git", "git version 2.43.0.windows.1\n"), "2.43.0.windows.1");
        assert_eq!(parse_version("git", "git version 2.45.2"), "2.45.2");
    }

    #[test]
    fn strips_a_leading_v_and_uses_the_first_line_only() {
        assert_eq!(parse_version("x", "v1.2.3\nbuild abc"), "1.2.3");
        assert_eq!(parse_version("x", "tool 10.0 extra"), "10.0");
    }

    #[test]
    fn unparseable_output_is_returned_raw_and_trimmed() {
        assert_eq!(parse_version("claude", "  something odd  \n"), "something odd");
        assert_eq!(parse_version("git", ""), "");
    }

    // -- locating ---------------------------------------------------------------------

    #[test]
    fn path_dirs_are_searched_in_order_before_extra_dirs() {
        let a = tempfile::tempdir().unwrap();
        let b = tempfile::tempdir().unwrap();
        let extra = tempfile::tempdir().unwrap();
        let in_b = fake_binary(b.path(), "claude");
        let in_extra = fake_binary(extra.path(), "claude");

        let s = search(
            vec![a.path().to_path_buf(), b.path().to_path_buf()],
            vec![extra.path().to_path_buf()],
        );
        let hit = s.locate("claude").unwrap();
        assert_eq!(hit.path, in_b);
        assert_eq!(hit.source, Source::Path);

        let s = search(vec![a.path().to_path_buf()], vec![extra.path().to_path_buf()]);
        let hit = s.locate("claude").unwrap();
        assert_eq!(hit.path, in_extra);
        assert_eq!(hit.source, Source::Extra);
    }

    #[test]
    fn locate_returns_none_when_absent_and_searched_lists_every_dir() {
        let a = tempfile::tempdir().unwrap();
        let extra = tempfile::tempdir().unwrap();
        let s = search(vec![a.path().to_path_buf()], vec![extra.path().to_path_buf()]);
        assert_eq!(s.locate("claude"), None);
        assert_eq!(
            s.searched(),
            vec![a.path().display().to_string(), extra.path().display().to_string()]
        );
    }

    #[test]
    fn a_directory_named_like_the_binary_is_not_a_hit() {
        let a = tempfile::tempdir().unwrap();
        std::fs::create_dir(a.path().join(with_platform_ext("claude"))).unwrap();
        assert_eq!(search(vec![a.path().to_path_buf()], vec![]).locate("claude"), None);
    }

    #[cfg(unix)]
    #[test]
    fn unix_skips_a_file_without_an_exec_bit() {
        let a = tempfile::tempdir().unwrap();
        let b = tempfile::tempdir().unwrap();
        std::fs::write(a.path().join("claude"), b"").unwrap(); // mode 0644
        let real = fake_binary(b.path(), "claude");
        let s = search(vec![a.path().to_path_buf(), b.path().to_path_buf()], vec![]);
        assert_eq!(s.locate("claude").unwrap().path, real);
    }

    #[cfg(windows)]
    #[test]
    fn windows_tries_every_pathext_extension() {
        let a = tempfile::tempdir().unwrap();
        let cmd = a.path().join("code.cmd");
        std::fs::write(&cmd, b"").unwrap();
        let s = Search {
            path_dirs: vec![a.path().to_path_buf()],
            extra_dirs: vec![],
            extensions: vec![".exe".into(), ".cmd".into()],
        };
        assert_eq!(s.locate("code").unwrap().path, cmd);
        assert_eq!(s.locate("claude"), None);
        assert_eq!(s.locate("code.cmd").unwrap().path, cmd, "a name with its extension is tried bare");
    }

    #[test]
    fn split_path_drops_empty_and_relative_entries() {
        let joined = if cfg!(windows) {
            "C:\\abs;rel;;.\\also-rel;D:\\other"
        } else {
            "/abs:rel::./also-rel:/other"
        };
        let dirs = split_path(OsStr::new(joined));
        assert_eq!(dirs.len(), 2, "{dirs:?}");
        assert!(dirs.iter().all(|d| d.is_absolute()));
    }

    #[test]
    fn from_env_reads_path_and_keeps_extras() {
        let s = Search::from_env(vec![PathBuf::from("/extra")]);
        assert!(!s.path_dirs.is_empty(), "the test process has a PATH");
        assert!(s.path_dirs.iter().all(|d| d.is_absolute()));
        assert_eq!(s.extra_dirs, vec![PathBuf::from("/extra")]);
        assert!(s.path_only().extra_dirs.is_empty());
        #[cfg(windows)]
        assert!(s.extensions.iter().any(|e| e == ".exe"));
    }

    #[test]
    fn expand_home_replaces_a_leading_tilde_only() {
        let home = dirs::home_dir().expect("test machine has a home dir");
        assert_eq!(expand_home("~/bin/claude"), home.join("bin/claude").display().to_string());
        assert_eq!(expand_home("claude"), "claude");
        assert_eq!(expand_home("/x/~/y"), "/x/~/y");
    }

    // -- detection --------------------------------------------------------------------

    #[test]
    fn detect_found_records_path_and_parsed_version_without_banner() {
        let a = tempfile::tempdir().unwrap();
        let claude = fake_binary(a.path(), "claude");
        let runner = FakeRunner::default().with(&claude, Ok("2.1.301 (Claude Code)\n"));
        let (bin, banner) = detect("claude", &search(vec![a.path().to_path_buf()], vec![]), &runner);
        assert_eq!(banner, None);
        assert_eq!(bin.status, BinaryStatus::Found);
        assert_eq!(bin.path.as_deref(), Some(claude.display().to_string().as_str()));
        assert_eq!(bin.version.as_deref(), Some("2.1.301"));
        assert!(!bin.configured);
        assert_eq!(runner.calls.lock().unwrap().as_slice(), [claude]);
    }

    #[test]
    fn empty_version_output_is_found_with_no_version() {
        let a = tempfile::tempdir().unwrap();
        let claude = fake_binary(a.path(), "claude");
        let runner = FakeRunner::default().with(&claude, Ok("  \n"));
        let (bin, banner) = detect("claude", &search(vec![a.path().to_path_buf()], vec![]), &runner);
        assert_eq!(banner, None);
        assert_eq!(bin.status, BinaryStatus::Found);
        assert_eq!(bin.version, None);
    }

    #[test]
    fn detect_missing_lists_searched_locations_and_runs_nothing() {
        let a = tempfile::tempdir().unwrap();
        let extra = tempfile::tempdir().unwrap();
        let runner = FakeRunner::default();
        let (bin, banner) = detect(
            "claude",
            &search(vec![a.path().to_path_buf()], vec![extra.path().to_path_buf()]),
            &runner,
        );
        assert_eq!(bin.status, BinaryStatus::Missing);
        assert_eq!(bin.path, None);
        assert_eq!(bin.version, None);
        let banner = banner.unwrap();
        assert_eq!(banner.id, "claude.missing");
        assert!(banner.text.starts_with("claude not found — searched: "), "{}", banner.text);
        assert!(banner.text.contains(&a.path().display().to_string()));
        assert!(banner.text.contains(&extra.path().display().to_string()));
        assert!(runner.calls.lock().unwrap().is_empty());
    }

    /// A Windows-style search: PATHEXT order, `.exe` before `.bat` / `.cmd`. Explicit, and
    /// used with `resolve_for(.., windows: true)`, so the shim rules are tested everywhere.
    fn windows_search(path_dirs: Vec<PathBuf>, extra_dirs: Vec<PathBuf>) -> Search {
        Search {
            path_dirs,
            extra_dirs,
            extensions: [".com", ".exe", ".bat", ".cmd", ".ps1"].map(String::from).to_vec(),
        }
    }

    fn shim(dir: &Path, file: &str) -> PathBuf {
        let path = dir.join(file);
        super::fixtures::write_executable(&path, b"@echo off\r\n");
        path
    }

    fn native(dir: &Path) -> PathBuf {
        let path = dir.join("claude.exe");
        super::fixtures::write_executable(&path, b"");
        path
    }

    /// `detect` on Windows.
    fn detect_win(name: &str, s: &Search, runner: &FakeRunner) -> (Binary, Option<Banner>) {
        resolve_for(name, None, s, runner, true)
    }

    fn shim_banner(path: &Path, kind: &str) -> Option<Banner> {
        Some(Banner::new(
            SHIM_BANNER,
            format!("{} ({kind}) found — install the native claude.exe", path.display()),
        ))
    }

    #[test]
    fn is_batch_matches_cmd_and_bat_in_any_case_only() {
        assert!(is_batch(Path::new("C:\\npm\\claude.cmd")));
        assert!(is_batch(Path::new("C:\\npm\\claude.BAT")));
        assert!(!is_batch(Path::new("C:\\bin\\claude.exe")));
        assert!(!is_batch(Path::new("/usr/bin/claude")));
    }

    #[test]
    fn a_claude_shim_alone_gets_the_shim_banner_with_its_path_and_is_never_run() {
        let a = tempfile::tempdir().unwrap();
        let extra = tempfile::tempdir().unwrap();
        for file in ["claude.cmd", "claude.bat"] {
            let dir = tempfile::tempdir().unwrap();
            let path = shim(dir.path(), file);
            let runner = FakeRunner::default().with(&path, Ok("2.1.301 (Claude Code)"));
            let s = windows_search(
                vec![a.path().to_path_buf(), dir.path().to_path_buf()],
                vec![extra.path().to_path_buf()],
            );
            let (bin, banner) = detect_win("claude", &s, &runner);
            assert_eq!(bin.status, BinaryStatus::Missing);
            assert_eq!(bin.path, None);
            assert_eq!(bin.version, None);
            assert!(!bin.configured);
            assert_eq!(banner, shim_banner(&path, "npm shim"), "{file}");
            assert!(runner.calls.lock().unwrap().is_empty(), "the shim is not run");
        }
    }

    #[test]
    fn a_shim_in_the_extra_dirs_still_gets_the_shim_banner() {
        let a = tempfile::tempdir().unwrap();
        let extra = tempfile::tempdir().unwrap();
        let path = shim(extra.path(), "claude.cmd");
        let s = windows_search(vec![a.path().to_path_buf()], vec![extra.path().to_path_buf()]);
        let (_, banner) = detect_win("claude", &s, &FakeRunner::default());
        assert_eq!(banner, shim_banner(&path, "npm shim"));
    }

    #[test]
    fn a_ps1_is_not_native_claude() {
        let a = tempfile::tempdir().unwrap();
        super::fixtures::write_executable(&a.path().join("claude.ps1"), b"");
        let s = windows_search(vec![a.path().to_path_buf()], vec![]);
        assert_eq!(s.locate_native("claude", true), None);
        let runner = FakeRunner::default();
        let (bin, banner) = detect_win("claude", &s, &runner);
        assert_eq!(bin.status, BinaryStatus::Missing);
        assert_eq!(banner.unwrap().id, "claude.missing");
        assert!(runner.calls.lock().unwrap().is_empty());
    }

    #[test]
    fn a_native_claude_anywhere_in_the_search_wins_over_an_earlier_shim() {
        let npm = tempfile::tempdir().unwrap();
        let nat = tempfile::tempdir().unwrap();
        shim(npm.path(), "claude.cmd");
        let exe = native(nat.path());
        let runner = FakeRunner::default().with(&exe, Ok("2.1.301 (Claude Code)"));

        // Later on PATH.
        let s = windows_search(vec![npm.path().to_path_buf(), nat.path().to_path_buf()], vec![]);
        let (bin, banner) = detect_win("claude", &s, &runner);
        assert_eq!(banner, None);
        assert_eq!(bin.status, BinaryStatus::Found);
        assert_eq!(bin.path.as_deref(), Some(exe.display().to_string().as_str()));

        // Only in the extra dirs (`~/.local/bin`), with the shim on PATH.
        let s = windows_search(vec![npm.path().to_path_buf()], vec![nat.path().to_path_buf()]);
        let (bin, banner) = detect_win("claude", &s, &runner);
        assert_eq!(banner, None);
        assert_eq!(bin.path.as_deref(), Some(exe.display().to_string().as_str()));
        assert_eq!(runner.calls.lock().unwrap().as_slice(), [exe.clone(), exe]);
    }

    #[test]
    fn a_configured_bare_name_that_resolves_only_to_a_shim_gets_the_shim_banner() {
        let a = tempfile::tempdir().unwrap();
        let path = shim(a.path(), "claude.cmd");
        let s = windows_search(vec![a.path().to_path_buf()], vec![]);
        let runner = FakeRunner::default();
        for configured in ["claude", "claude.cmd"] {
            let (bin, banner) = resolve_for("claude", Some(configured), &s, &runner, true);
            assert_eq!(bin.status, BinaryStatus::Missing);
            assert!(bin.configured);
            assert_eq!(bin.path.as_deref(), Some(configured));
            assert_eq!(banner, shim_banner(&path, "npm shim"));
        }
        assert!(runner.calls.lock().unwrap().is_empty());
    }

    #[test]
    fn a_configured_absolute_batch_path_gets_the_shim_banner_and_is_never_run() {
        let npm = tempfile::tempdir().unwrap();
        let path = shim(npm.path(), "claude.cmd");
        let other = shim(npm.path(), "run-claude.bat");
        let empty = tempfile::tempdir().unwrap();
        let s = windows_search(vec![empty.path().to_path_buf()], vec![]);
        let runner = FakeRunner::default()
            .with(&path, Ok("2.1.301 (Claude Code)"))
            .with(&other, Ok("2.1.301 (Claude Code)"));

        let configured = path.display().to_string();
        let (bin, banner) = resolve_for("claude", Some(&configured), &s, &runner, true);
        assert_eq!(bin.status, BinaryStatus::Missing);
        assert!(bin.configured);
        assert_eq!(bin.path.as_deref(), Some(configured.as_str()));
        assert_eq!(banner, shim_banner(&path, "npm shim"));

        // Any other batch file is named as such.
        let (_, banner) = resolve_for("claude", Some(&other.display().to_string()), &s, &runner, true);
        assert_eq!(banner, shim_banner(&other, "a batch file"));
        assert!(runner.calls.lock().unwrap().is_empty());
    }

    #[test]
    fn claude_path_naming_the_shim_while_a_native_exe_exists_says_to_clear_it() {
        let npm = tempfile::tempdir().unwrap();
        let nat = tempfile::tempdir().unwrap();
        let path = shim(npm.path(), "claude.cmd");
        native(nat.path());
        let s = windows_search(vec![nat.path().to_path_buf()], vec![]);
        let runner = FakeRunner::default();
        let (bin, banner) = resolve_for("claude", Some(&path.display().to_string()), &s, &runner, true);
        assert_eq!(bin.status, BinaryStatus::Missing);
        assert_eq!(
            banner,
            Some(Banner::new(SHIM_BANNER, "claude.path names the npm shim; clear it to use claude.exe"))
        );
        assert!(runner.calls.lock().unwrap().is_empty());
    }

    #[test]
    fn shim_rules_apply_on_windows_only() {
        let a = tempfile::tempdir().unwrap();
        let path = shim(a.path(), "claude.cmd");
        let runner = FakeRunner::default().with(&path, Ok("2.1.301 (Claude Code)"));
        let s = windows_search(vec![a.path().to_path_buf()], vec![]);
        // Off Windows a `.cmd` is just a file: searched as before and configured as given.
        let (bin, banner) = resolve_for("claude", None, &s, &runner, false);
        assert_eq!((bin.status, banner), (BinaryStatus::Found, None));
        let (bin, banner) = resolve_for("claude", Some(&path.display().to_string()), &s, &runner, false);
        assert_eq!((bin.status, banner), (BinaryStatus::Found, None));
        assert_eq!(s.locate_native("claude", false).unwrap().path, path);
    }

    #[test]
    fn only_claude_is_shim_guarded() {
        let a = tempfile::tempdir().unwrap();
        let git = shim(a.path(), "git.cmd");
        let runner = FakeRunner::default().with(&git, Ok("git version 2.45.2"));
        let (bin, banner) = detect_win("git", &windows_search(vec![a.path().to_path_buf()], vec![]), &runner);
        assert_eq!(banner, None);
        assert_eq!(bin.status, BinaryStatus::Found);
    }

    #[test]
    fn version_failure_keeps_the_path_with_a_null_version_and_banner() {
        let a = tempfile::tempdir().unwrap();
        let git = fake_binary(a.path(), "git");
        for err in [
            RunError::Timeout(Duration::from_secs(5)),
            RunError::Failed {
                code: Some(1),
                stderr: "boom".into(),
            },
            RunError::Spawn("access denied".into()),
            RunError::Wait("interrupted".into()),
        ] {
            let runner = FakeRunner::default().with(&git, Err(err.clone()));
            let (bin, banner) = detect("git", &search(vec![a.path().to_path_buf()], vec![]), &runner);
            assert_eq!(bin.status, BinaryStatus::VersionFailed);
            assert_eq!(bin.path.as_deref(), Some(git.display().to_string().as_str()));
            assert_eq!(bin.version, None);
            let banner = banner.unwrap();
            assert_eq!(banner.id, "git.version");
            assert!(
                banner.text.starts_with(&format!("could not read version of {}", git.display())),
                "{}",
                banner.text
            );
            assert!(banner.text.contains(&err.to_string()), "{} / {err}", banner.text);
        }
    }

    #[test]
    fn configured_path_skips_the_search() {
        let a = tempfile::tempdir().unwrap();
        let on_path = fake_binary(a.path(), "claude");
        let elsewhere = tempfile::tempdir().unwrap();
        let configured = fake_binary(elsewhere.path(), "claude");
        let runner = FakeRunner::default()
            .with(&on_path, Ok("9.9.9 (wrong one)"))
            .with(&configured, Ok("2.1.301 (Claude Code)"));
        let (bin, banner) = resolve(
            "claude",
            Some(configured.to_str().unwrap()),
            &search(vec![a.path().to_path_buf()], vec![]),
            &runner,
        );
        assert_eq!(banner, None);
        assert!(bin.configured);
        assert_eq!(bin.status, BinaryStatus::Found);
        assert_eq!(bin.version.as_deref(), Some("2.1.301"));
        assert_eq!(runner.calls.lock().unwrap().as_slice(), [configured]);
    }

    #[test]
    fn configured_path_that_does_not_exist_names_the_path_and_says_detection_was_skipped() {
        let a = tempfile::tempdir().unwrap();
        fake_binary(a.path(), "claude");
        let runner = FakeRunner::default();
        let (bin, banner) = resolve("claude", Some(nowhere()), &search(vec![a.path().to_path_buf()], vec![]), &runner);
        assert_eq!(bin.status, BinaryStatus::ConfiguredMissing);
        assert_eq!(bin.path.as_deref(), Some(nowhere()));
        assert!(bin.configured);
        let banner = banner.unwrap();
        assert_eq!(banner.id, "claude.configured_missing");
        assert!(banner.text.contains(nowhere()), "{}", banner.text);
        assert!(banner.text.contains("detection skipped because claude.path is set"), "{}", banner.text);
        assert!(runner.calls.lock().unwrap().is_empty());
    }

    #[test]
    fn configured_bare_name_is_searched_on_path_and_stays_configured() {
        let a = tempfile::tempdir().unwrap();
        let beta = fake_binary(a.path(), "claude-beta");
        let runner = FakeRunner::default().with(&beta, Ok("2.2.0 (Claude Code)"));
        let s = search(vec![a.path().to_path_buf()], vec![]);

        let (bin, banner) = resolve("claude", Some("claude-beta"), &s, &runner);
        assert_eq!(banner, None);
        assert_eq!(bin.status, BinaryStatus::Found);
        assert!(bin.configured);
        assert_eq!(bin.path.as_deref(), Some(beta.display().to_string().as_str()));
        assert_eq!(bin.version.as_deref(), Some("2.2.0"));

        let (bin, banner) = resolve("claude", Some("claude-gamma"), &s, &runner);
        assert_eq!(bin.status, BinaryStatus::Missing);
        assert!(bin.configured);
        assert_eq!(bin.path.as_deref(), Some("claude-gamma"));
        let banner = banner.unwrap();
        assert_eq!(banner.id, "claude.missing");
        assert!(banner.text.starts_with("claude (claude-gamma) not found — searched: "), "{}", banner.text);
    }

    #[test]
    fn blank_configured_path_means_detect() {
        let a = tempfile::tempdir().unwrap();
        let claude = fake_binary(a.path(), "claude");
        let runner = FakeRunner::default().with(&claude, Ok("2.1.301 (Claude Code)"));
        let (bin, _) = resolve("claude", Some("  "), &search(vec![a.path().to_path_buf()], vec![]), &runner);
        assert_eq!(bin.status, BinaryStatus::Found);
        assert!(!bin.configured);
    }

    // -- the real runner --------------------------------------------------------------

    #[test]
    fn process_runner_reads_git_version_from_the_real_binary() {
        let Some(git) = Search::from_env(vec![]).locate("git") else {
            eprintln!("git not on PATH; skipping");
            return;
        };
        let out = ProcessRunner::default().version_output(&git.path).unwrap();
        assert!(out.starts_with("git version "), "{out}");
        assert!(starts_with_digit(&parse_version("git", &out)));
    }

    #[test]
    fn process_runner_reports_a_spawn_failure_for_a_missing_file() {
        let dir = tempfile::tempdir().unwrap();
        let err = ProcessRunner::default()
            .version_output(&dir.path().join(with_platform_ext("nope")))
            .unwrap_err();
        assert!(matches!(err, RunError::Spawn(_)), "{err:?}");
    }

    #[test]
    fn process_runner_reports_a_non_zero_exit_with_the_first_stderr_line() {
        let dir = tempfile::tempdir().unwrap();
        let fail = script(
            dir.path(),
            "fail",
            "@echo boom 1>&2\n@echo second 1>&2\n@exit /b 3\n",
            "echo boom >&2\necho second >&2\nexit 3\n",
        );
        let err = ProcessRunner::default().version_output(&fail).unwrap_err();
        assert_eq!(
            err,
            RunError::Failed {
                code: Some(3),
                stderr: "boom".into()
            }
        );
    }
}
