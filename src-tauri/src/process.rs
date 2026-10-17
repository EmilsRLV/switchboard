//! Running a child process to completion with a timeout and no console window. Shared by
//! binary detection (`<bin> --version`) and `git/` (`git status`): spawn with piped stdio,
//! drain both pipes on their own threads, poll for exit and kill at the deadline.

use std::process::{Command, ExitStatus, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

/// Why a child process produced no usable output.
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

/// A finished child: its exit status and both streams, decoded lossily.
#[derive(Debug, Clone)]
pub struct Completed {
    pub status: ExitStatus,
    pub stdout: String,
    pub stderr: String,
}

impl Completed {
    /// The first non-empty line of stderr, trimmed: what a banner or error message quotes.
    pub fn stderr_summary(&self) -> String {
        self.stderr
            .lines()
            .map(str::trim)
            .find(|l| !l.is_empty())
            .unwrap_or("")
            .to_string()
    }

    /// `Ok(self)` on a zero exit, otherwise [`RunError::Failed`] with the stderr summary.
    pub fn success(self) -> Result<Completed, RunError> {
        if self.status.success() {
            Ok(self)
        } else {
            Err(RunError::Failed {
                code: self.status.code(),
                stderr: self.stderr_summary(),
            })
        }
    }
}

/// Run `cmd` to completion. Stdin is closed, stdout/stderr are captured, no console window is
/// opened on Windows, and a child still running at `timeout` is killed. A non-zero exit is
/// *not* an error here: the caller reads `status` (git uses exit codes to mean things).
pub fn run(mut cmd: Command, timeout: Duration) -> Result<Completed, RunError> {
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = cmd.spawn().map_err(|e| RunError::Spawn(e.to_string()))?;

    // Drain both pipes on their own threads so a chatty child can never block on a full pipe
    // while we wait for it.
    let stdout = child.stdout.take().map(read_to_end_lossy);
    let stderr = child.stderr.take().map(read_to_end_lossy);

    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(RunError::Timeout(timeout));
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(20)),
            Err(e) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(RunError::Wait(e.to_string()));
            }
        }
    };
    // The child has exited, but a grandchild it left behind (git's fsmonitor daemon is a real
    // case) may still hold the pipes open; the readers then never see EOF. Wait for them only
    // until the remaining budget plus a grace period, and return what arrived.
    let readers_deadline = deadline.max(Instant::now()) + READER_GRACE;
    let (stdout, stdout_cut) = collect(stdout, readers_deadline);
    let (stderr, stderr_cut) = collect(stderr, readers_deadline);
    let mut stderr = stderr;
    if stdout_cut || stderr_cut {
        if !stderr.is_empty() && !stderr.ends_with('\n') {
            stderr.push('\n');
        }
        stderr.push_str(PIPES_HELD_NOTE);
    }
    Ok(Completed { status, stdout, stderr })
}

/// How long after the timeout the pipe readers may still deliver before we stop waiting.
const READER_GRACE: Duration = Duration::from_millis(200);
/// Appended to `stderr` when a reader was abandoned (its output may be incomplete).
const PIPES_HELD_NOTE: &str = "[switchboard: output cut short; a process kept the pipes open]";

/// What a reader delivered by `deadline`: `(text, cut_short)`.
fn collect(reader: Option<mpsc::Receiver<String>>, deadline: Instant) -> (String, bool) {
    let Some(rx) = reader else {
        return (String::new(), false);
    };
    match rx.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
        Ok(text) => (text, false),
        // Disconnected: the reader thread died without sending; nothing to show.
        Err(mpsc::RecvTimeoutError::Disconnected) => (String::new(), false),
        Err(mpsc::RecvTimeoutError::Timeout) => (String::new(), true),
    }
}

/// Drain `reader` to EOF on its own thread and hand the text over a channel, so the caller
/// can stop waiting for it (a thread `join` cannot be given a deadline).
fn read_to_end_lossy<R: std::io::Read + Send + 'static>(mut reader: R) -> mpsc::Receiver<String> {
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = reader.read_to_end(&mut buf);
        let _ = tx.send(String::from_utf8_lossy(&buf).into_owned());
    });
    rx
}

/// Helpers shared by the tests of this module, `settings::detect` and `git`.
#[cfg(test)]
pub(crate) mod fixtures {
    use std::path::{Path, PathBuf};

    /// Write `content` and make it runnable.
    pub(crate) fn write_executable(path: &Path, content: &[u8]) {
        std::fs::write(path, content).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
    }

    /// A script fixture runnable through `Command::new` on this platform.
    pub(crate) fn script(dir: &Path, name: &str, windows_body: &str, unix_body: &str) -> PathBuf {
        let (file, body) = if cfg!(windows) {
            (format!("{name}.cmd"), windows_body.replace('\n', "\r\n"))
        } else {
            (name.to_string(), format!("#!/bin/sh\n{unix_body}"))
        };
        let path = dir.join(file);
        write_executable(&path, body.as_bytes());
        path
    }
}

#[cfg(test)]
mod tests {
    use super::fixtures::script;
    use super::*;

    #[test]
    fn run_captures_stdout_and_a_zero_exit() {
        let dir = tempfile::tempdir().unwrap();
        let ok = script(dir.path(), "ok", "@echo hello\n", "echo hello\n");
        let done = run(Command::new(&ok), Duration::from_secs(5)).unwrap();
        assert!(done.status.success());
        assert_eq!(done.stdout.trim(), "hello");
        assert!(done.success().is_ok());
    }

    #[test]
    fn run_reports_a_non_zero_exit_through_success_with_the_first_stderr_line() {
        let dir = tempfile::tempdir().unwrap();
        let fail = script(
            dir.path(),
            "fail",
            "@echo boom 1>&2\n@echo second 1>&2\n@exit /b 3\n",
            "echo boom >&2\necho second >&2\nexit 3\n",
        );
        let done = run(Command::new(&fail), Duration::from_secs(5)).unwrap();
        assert_eq!(done.status.code(), Some(3), "a non-zero exit is data, not an error");
        assert_eq!(done.stderr_summary(), "boom");
        assert_eq!(
            done.success().unwrap_err(),
            RunError::Failed {
                code: Some(3),
                stderr: "boom".into()
            }
        );
    }

    #[test]
    fn run_kills_a_hanging_child_after_the_timeout() {
        let dir = tempfile::tempdir().unwrap();
        let hang = script(dir.path(), "hang", "@ping -n 60 127.0.0.1 >nul\n", "exec sleep 60\n");
        let timeout = Duration::from_millis(200);
        let started = Instant::now();
        let err = run(Command::new(&hang), timeout).unwrap_err();
        assert_eq!(err, RunError::Timeout(timeout));
        assert!(started.elapsed() < Duration::from_secs(2), "{:?}", started.elapsed());
    }

    #[test]
    fn run_reports_a_spawn_failure_for_a_missing_file() {
        let dir = tempfile::tempdir().unwrap();
        let err = run(Command::new(dir.path().join("nope.exe")), Duration::from_secs(5)).unwrap_err();
        assert!(matches!(err, RunError::Spawn(_)), "{err:?}");
    }

    #[test]
    fn stderr_summary_skips_blank_lines() {
        let dir = tempfile::tempdir().unwrap();
        let ok = script(dir.path(), "ok", "@echo hello\n", "echo hello\n");
        let done = Completed {
            stderr: "\n   \nfatal: not a git repository\nmore".into(),
            ..run(Command::new(&ok), Duration::from_secs(5)).unwrap()
        };
        assert_eq!(done.stderr_summary(), "fatal: not a git repository");
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
