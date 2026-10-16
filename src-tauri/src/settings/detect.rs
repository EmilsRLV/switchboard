//! Binary detection: find `claude` / `git` on PATH (then extra dirs), run `<bin> --version`
//! with a timeout, and parse the version out of its output. The process runner is a trait so
//! tests use a fake.

use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use super::{Banner, Binary, BinaryStatus};

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
    /// PATH from the environment plus the given extra dirs.
    pub fn from_env(extra_dirs: Vec<PathBuf>) -> Self {
        let path_dirs = std::env::var_os("PATH")
            .map(|p| split_path(&p))
            .unwrap_or_default();
        Self {
            path_dirs,
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
        let hit = |dirs: &[PathBuf], source: Source| {
            dirs.iter()
                .flat_map(|dir| candidates(dir, name, &self.extensions))
                .find(|p| is_executable_file(p))
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

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum RunError {
    #[error("could not start it: {0}")]
    Spawn(String),
    #[error("could not wait for it: {0}")]
    Wait(String),
    #[error("timed out after {0:?}")]
    Timeout(Duration),
    #[error("exit code {}{}", code.map(|c| c.to_string()).unwrap_or_else(|| "?".into()), if stderr.is_empty() { String::new() } else { format!(": {stderr}") })]
    Failed { code: Option<i32>, stderr: String },
}

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
        cmd.arg("--version")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }
        let mut child = cmd.spawn().map_err(|e| RunError::Spawn(e.to_string()))?;

        // Drain both pipes on their own threads so a chatty child can never block on a
        // full pipe while we wait for it.
        let stdout = child.stdout.take().map(read_to_end_lossy);
        let stderr = child.stderr.take().map(read_to_end_lossy);

        let deadline = Instant::now() + self.timeout;
        let status = loop {
            match child.try_wait() {
                Ok(Some(status)) => break status,
                Ok(None) if Instant::now() >= deadline => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(RunError::Timeout(self.timeout));
                }
                Ok(None) => std::thread::sleep(Duration::from_millis(20)),
                Err(e) => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(RunError::Wait(e.to_string()));
                }
            }
        };
        let out = stdout.map(|h| h.join().unwrap_or_default()).unwrap_or_default();
        let err = stderr.map(|h| h.join().unwrap_or_default()).unwrap_or_default();
        if status.success() {
            Ok(out)
        } else {
            Err(RunError::Failed {
                code: status.code(),
                stderr: err.lines().next().unwrap_or("").trim().to_string(),
            })
        }
    }
}

fn read_to_end_lossy<R: std::io::Read + Send + 'static>(mut reader: R) -> std::thread::JoinHandle<String> {
    std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = reader.read_to_end(&mut buf);
        String::from_utf8_lossy(&buf).into_owned()
    })
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
    detect_as(name, name, search, runner, false)
}

/// Search for `lookup` and report it as `name`.
fn detect_as(
    name: &str,
    lookup: &str,
    search: &Search,
    runner: &dyn Runner,
    configured: bool,
) -> (Binary, Option<Banner>) {
    match search.locate(lookup) {
        Some(located) => probe(name, located.path, configured, runner),
        None => {
            let label = if lookup == name {
                name.to_string()
            } else {
                format!("{name} ({lookup})")
            };
            (
                Binary {
                    name: name.to_string(),
                    path: configured.then(|| lookup.to_string()),
                    version: None,
                    status: BinaryStatus::Missing,
                    configured,
                },
                Some(Banner::new(
                    format!("{name}.missing"),
                    format!("{label} not found — searched: {}", search.searched().join(", ")),
                )),
            )
        }
    }
}

/// Use the value configured in `settings.json` instead of searching. A leading `~` is the
/// home dir; a bare name (single path component) is looked up on PATH like an unconfigured
/// binary; a path that points at nothing is reported as such, with a note that detection
/// was skipped because it is set.
pub fn detect_configured(
    name: &str,
    configured: &str,
    search: &Search,
    runner: &dyn Runner,
) -> (Binary, Option<Banner>) {
    let expanded = expand_home(configured);
    let path = Path::new(&expanded);
    if !path.is_absolute() && path.components().count() == 1 {
        return detect_as(name, &expanded, search, runner, true);
    }
    if is_executable_file(path) {
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
    match configured.map(str::trim).filter(|p| !p.is_empty()) {
        Some(path) => detect_configured(name, path, search, runner),
        None => detect(name, search, runner),
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

    /// Write `content` and make it runnable.
    pub(crate) fn write_executable(path: &Path, content: &[u8]) {
        std::fs::write(path, content).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::fixtures::{fake_binary, write_executable};
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

    /// A script fixture runnable through `Command::new` on this platform.
    fn script(dir: &Path, name: &str, windows_body: &str, unix_body: &str) -> PathBuf {
        let (file, body) = if cfg!(windows) {
            (format!("{name}.cmd"), windows_body.replace('\n', "\r\n"))
        } else {
            (name.to_string(), format!("#!/bin/sh\n{unix_body}"))
        };
        let path = dir.join(file);
        write_executable(&path, body.as_bytes());
        path
    }

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
    fn process_runner_kills_a_hanging_binary_after_the_timeout() {
        let dir = tempfile::tempdir().unwrap();
        let hang = script(dir.path(), "hang", "@ping -n 60 127.0.0.1 >nul\n", "exec sleep 60\n");
        let timeout = Duration::from_millis(200);
        let started = Instant::now();
        let err = ProcessRunner { timeout }.version_output(&hang).unwrap_err();
        assert_eq!(err, RunError::Timeout(timeout));
        assert!(started.elapsed() < Duration::from_secs(2), "{:?}", started.elapsed());
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

    #[test]
    fn run_error_messages_read_well_in_a_banner() {
        assert_eq!(RunError::Timeout(Duration::from_secs(5)).to_string(), "timed out after 5s");
        assert_eq!(RunError::Wait("gone".into()).to_string(), "could not wait for it: gone");
        assert_eq!(
            RunError::Failed {
                code: Some(2),
                stderr: "bad".into()
            }
            .to_string(),
            "exit code 2: bad"
        );
        assert_eq!(
            RunError::Failed {
                code: None,
                stderr: String::new()
            }
            .to_string(),
            "exit code ?"
        );
    }
}
