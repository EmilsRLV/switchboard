//! PTY-backed terminals (Story 4.1). Rust owns every process: a terminal is a shell spawned
//! through `portable-pty` (ConPTY on Windows, a Unix PTY elsewhere), with four threads per
//! spawn and no app lock held across any blocking call:
//!
//! - the **reader** blocks on the PTY's output, appends each chunk to the terminal's 2 MiB
//!   [`Ring`] and to a pending queue, noting the ring's running byte count after it;
//! - the **emitter** drains the queue at most once per [`COALESCE`] (at most
//!   [`MAX_PAYLOAD`] bytes per event), decodes the longest valid UTF-8 prefix (a split
//!   multi-byte sequence is carried to the next chunk) and sends one `term://data` per drain
//!   with the byte offset its text ends at; after the reader's EOF and the final flush it
//!   sends `term://exit`, so no output of a spawn ever follows its exit;
//! - the **writer** owns the PTY's input and writes what `term_write` queued, in order;
//! - the **waiter** owns the child and blocks in `wait()`; on exit it drops the PTY (so the
//!   reader reaches EOF, which on Windows needs the pseudoconsole closed) and hands the code to
//!   the emitter, reporting the exit itself only when the output never ends (a grandchild
//!   still holding the PTY). The buffer is kept.
//!
//! On Windows each shell is put in a kill-on-close Job Object right after it spawns, so its
//! grandchildren die with it. Each terminal has its own locks; the manager's map lock is only
//! held to look a terminal up. Events go through a [`Sink`], so the tests record them without
//! a Tauri app.

use std::collections::{HashMap, VecDeque};
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use portable_pty::{ChildKiller, CommandBuilder, MasterPty, PtySize, native_pty_system};
use serde::{Deserialize, Serialize};

/// Event carrying [`DataPayload`]: coalesced output of one terminal.
pub const DATA_EVENT: &str = "term://data";
/// Event carrying [`ExitPayload`]: the terminal's child exited (or never started).
pub const EXIT_EVENT: &str = "term://exit";
/// Emitted with a [`TermInfo`] when a terminal is restarted, so every window showing it (the
/// pane, a pop-out; Story 4.5) learns it runs again.
pub const INFO_EVENT: &str = "term://info";
/// Emitted with a [`ClosedPayload`] when a terminal is closed (`term_close`), so every window
/// forgets it (Story 4.5).
pub const CLOSED_EVENT: &str = "term://closed";

/// Bytes of output each terminal keeps for a view created after output began.
pub const RING_CAPACITY: usize = 2 * 1024 * 1024;
/// At most one `term://data` per terminal per this interval.
pub const COALESCE: Duration = Duration::from_millis(8);
/// The most bytes one `term://data` carries; the rest goes in the next tick.
pub const MAX_PAYLOAD: usize = 256 * 1024;
/// The size a terminal starts at when the pane could not measure one.
pub const DEFAULT_COLS: u16 = 120;
pub const DEFAULT_ROWS: u16 = 30;
/// The smallest size a PTY is ever given.
pub const MIN_COLS: u16 = 2;
pub const MIN_ROWS: u16 = 1;
/// How long the waiter lets the output drain after the child exited before reporting the
/// exit itself (a grandchild still holding the PTY would otherwise delay it forever).
const FLUSH_GRACE: Duration = Duration::from_secs(1);
/// After a kill's first signal, how long before a child still running is killed hard (Unix).
#[cfg(unix)]
const KILL_GRACE: Duration = Duration::from_millis(300);

/// The exit code recorded when the shell could not be started at all.
pub const SPAWN_FAILED: i32 = -1;

/// Reset (RIS), put before a replay that cannot start at a line boundary.
const RESET: &str = "\x1bc";

// ---------------------------------------------------------------------------------------
// Wire types
// ---------------------------------------------------------------------------------------

/// What a terminal runs: a plain shell (Story 4.1) or a Claude session the app launched
/// (Story 4.2). A session terminal is never restarted; a resumed session (Story 4.4) opens a
/// new session terminal over the exited one with the same id.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TermKind {
    Plain,
    Session,
}

/// What the webview knows about a terminal (`term_open`, `term_list`, `term_restart`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct TermInfo {
    pub id: String,
    pub kind: TermKind,
    pub project_id: String,
    /// The project's label (plain), or the session's name (session).
    pub title: String,
    pub cwd: String,
    /// `None` while the child runs; its exit code after (`-1` when it never started).
    pub exited: Option<i32>,
    /// Why the shell could not be started (`could not start <shell>: <cause>`), or why it
    /// could not be waited for.
    pub error: Option<String>,
    /// The PTY's size: a view made while hidden is made at it.
    pub cols: u16,
    pub rows: u16,
    /// A Stop is under way (Story 4.4): true from the Stop until the child exits.
    pub stopping: bool,
}

/// `term://data`. `offset` (added to the spec's `{ id, data }`) is the terminal's output
/// byte count at the end of `data`, the same count `term_buffer` reports, so a view that
/// replayed the buffer drops what it already has.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct DataPayload {
    pub id: String,
    pub data: String,
    pub offset: u64,
}

/// `term://closed`: terminal `id` is gone (Story 4.5).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ClosedPayload {
    pub id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ExitPayload {
    pub id: String,
    pub code: Option<i32>,
}

/// `term_buffer`: the kept output as text and the byte count it ends at.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct TermBuffer {
    pub data: String,
    pub offset: u64,
}

/// Where terminal events go: the Tauri app in production, a recorder in tests.
pub trait Sink: Send + Sync + 'static {
    fn data(&self, id: &str, data: String, offset: u64);
    fn exit(&self, id: &str, code: Option<i32>);
}

/// The [`Sink`] that emits `term://data` / `term://exit` to every webview.
pub struct EventSink<R: tauri::Runtime>(pub tauri::AppHandle<R>);

impl<R: tauri::Runtime> Sink for EventSink<R> {
    fn data(&self, id: &str, data: String, offset: u64) {
        use tauri::Emitter;
        let _ = self.0.emit(DATA_EVENT, DataPayload { id: id.to_string(), data, offset });
    }

    fn exit(&self, id: &str, code: Option<i32>) {
        use tauri::Emitter;
        let _ = self.0.emit(EXIT_EVENT, ExitPayload { id: id.to_string(), code });
    }
}

/// What to run in a terminal.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SpawnSpec {
    pub program: PathBuf,
    pub args: Vec<String>,
    pub cwd: PathBuf,
    /// Variables removed from the inherited environment (tests drop `ENV` so `sh` reads no profile).
    pub env_remove: Vec<String>,
    /// Variables added to the inherited environment (after `TERM` / `COLORTERM`).
    pub env: Vec<(String, String)>,
}

impl SpawnSpec {
    pub fn new(program: impl Into<PathBuf>, args: Vec<String>, cwd: impl Into<PathBuf>) -> Self {
        Self {
            program: program.into(),
            args,
            cwd: cwd.into(),
            env_remove: Vec::new(),
            env: Vec::new(),
        }
    }

    /// The command as `portable-pty` spawns it: the inherited environment plus
    /// `TERM=xterm-256color`, `COLORTERM=truecolor` and `env`, in `cwd`. Every argument is its
    /// own argv entry; no shell string is ever built.
    pub(crate) fn command(&self) -> CommandBuilder {
        let mut cmd = CommandBuilder::new(&self.program);
        cmd.args(&self.args);
        cmd.cwd(&self.cwd);
        strip_parent_session(&mut cmd);
        for name in &self.env_remove {
            cmd.env_remove(name);
        }
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");
        for (name, value) in &self.env {
            cmd.env(name, value);
        }
        cmd
    }
}

/// Variables Claude Code sets for its own child processes. When Switchboard itself was
/// started from inside a Claude session they are inherited, and a `claude` run in one of
/// Switchboard's terminals would then think it is a child session (it turns transcript saving
/// off, so discovery would never find it). Every terminal is a top-level one, so they are
/// removed. User configuration (`ANTHROPIC_*`, `CLAUDE_CONFIG_DIR`, other `CLAUDE_CODE_*`
/// settings) is kept.
pub const PARENT_SESSION_VARS: &[&str] = &[
    "CLAUDECODE",
    "CLAUDE_CODE_CHILD_SESSION",
    "CLAUDE_CODE_ENTRYPOINT",
    "CLAUDE_CODE_EXECPATH",
    "CLAUDE_CODE_MESSAGING_SOCKET",
    "CLAUDE_CODE_MESSAGING_TOKEN",
    "CLAUDE_CODE_SESSION_ATTENDED",
    "CLAUDE_CODE_SESSION_ID",
    "CLAUDE_CODE_SSE_PORT",
    "CLAUDE_EFFORT",
    "CLAUDE_PID",
];

fn strip_parent_session(cmd: &mut CommandBuilder) {
    for name in PARENT_SESSION_VARS {
        cmd.env_remove(name);
    }
}

#[cfg(test)]
mod parent_session_tests {
    use super::*;

    #[test]
    fn parent_session_markers_are_removed_and_user_config_kept() {
        let mut cmd = CommandBuilder::new("x");
        cmd.env("CLAUDE_CODE_CHILD_SESSION", "1");
        cmd.env("CLAUDECODE", "1");
        cmd.env("CLAUDE_CODE_SESSION_ID", "abc");
        cmd.env("CLAUDE_CONFIG_DIR", "/cfg");
        cmd.env("ANTHROPIC_MODEL", "opus");
        strip_parent_session(&mut cmd);
        for name in PARENT_SESSION_VARS {
            assert!(cmd.get_env(name).is_none(), "{name} is removed");
        }
        assert!(cmd.get_env("CLAUDE_CONFIG_DIR").is_some());
        assert!(cmd.get_env("ANTHROPIC_MODEL").is_some());
    }
}

/// A requested size clamped to the minimum of 2 × 1.
pub fn clamp_size(cols: u16, rows: u16) -> (u16, u16) {
    (cols.max(MIN_COLS), rows.max(MIN_ROWS))
}

fn pty_size(cols: u16, rows: u16) -> PtySize {
    PtySize {
        rows,
        cols,
        pixel_width: 0,
        pixel_height: 0,
    }
}

/// Lock, recovering a poisoned mutex (a panicking thread never takes the terminal down with it).
fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|e| e.into_inner())
}

// ---------------------------------------------------------------------------------------
// Ring buffer and UTF-8 carry
// ---------------------------------------------------------------------------------------

/// A byte ring: keeps the last `capacity` bytes pushed, and counts every byte ever pushed.
#[derive(Debug)]
pub struct Ring {
    bytes: VecDeque<u8>,
    capacity: usize,
    /// Whether anything was ever dropped off the front.
    wrapped: bool,
    /// Bytes ever pushed: the offset the contents end at.
    total: u64,
}

impl Ring {
    pub fn new(capacity: usize) -> Self {
        Self {
            bytes: VecDeque::new(),
            capacity,
            wrapped: false,
            total: 0,
        }
    }

    pub fn push(&mut self, chunk: &[u8]) {
        self.total += chunk.len() as u64;
        if chunk.len() >= self.capacity {
            self.wrapped |= !self.bytes.is_empty() || chunk.len() > self.capacity;
            self.bytes.clear();
            self.bytes.extend(&chunk[chunk.len() - self.capacity..]);
            return;
        }
        let overflow = (self.bytes.len() + chunk.len()).saturating_sub(self.capacity);
        if overflow > 0 {
            self.bytes.drain(..overflow);
            self.wrapped = true;
        }
        self.bytes.extend(chunk);
    }

    pub fn len(&self) -> usize {
        self.bytes.len()
    }

    pub fn is_empty(&self) -> bool {
        self.bytes.is_empty()
    }

    /// Bytes ever pushed.
    pub fn total(&self) -> u64 {
        self.total
    }

    pub fn bytes(&self) -> Vec<u8> {
        self.bytes.iter().copied().collect()
    }

    /// The contents as text and the offset that text ends at. After a wrap the front may sit
    /// inside a line, an escape sequence or a character: the text then starts after the first
    /// newline, or with a reset (`ESC c`) when there is none. A character cut off at the end
    /// (still arriving) is left out, and the offset is moved back by its bytes.
    pub fn snapshot(&self) -> (String, u64) {
        let bytes = self.bytes();
        let mut prefix = "";
        let mut start = 0;
        if self.wrapped {
            match bytes.iter().position(|b| *b == b'\n') {
                Some(newline) => start = newline + 1,
                None => {
                    prefix = RESET;
                    start = bytes.iter().take(3).take_while(|b| (**b & 0xC0) == 0x80).count();
                }
            }
        }
        let mut carry = Vec::new();
        let text = decode_utf8(&mut carry, &bytes[start..]);
        (format!("{prefix}{text}"), self.total - carry.len() as u64)
    }

    /// The contents as text (see [`Ring::snapshot`]).
    pub fn text(&self) -> String {
        self.snapshot().0
    }
}

/// Append `bytes` to `carry` and return the longest decodable prefix as text. Invalid bytes
/// become U+FFFD; an incomplete sequence at the end (0–3 bytes) stays in `carry`.
pub fn decode_utf8(carry: &mut Vec<u8>, bytes: &[u8]) -> String {
    carry.extend_from_slice(bytes);
    let mut out = String::new();
    let mut rest: &[u8] = carry;
    loop {
        match std::str::from_utf8(rest) {
            Ok(text) => {
                out.push_str(text);
                rest = &[];
                break;
            }
            Err(err) => {
                let valid = err.valid_up_to();
                out.push_str(std::str::from_utf8(&rest[..valid]).unwrap_or_default());
                match err.error_len() {
                    Some(bad) => {
                        out.push('\u{FFFD}');
                        rest = &rest[valid + bad..];
                    }
                    None => {
                        rest = &rest[valid..];
                        break;
                    }
                }
            }
        }
    }
    let keep = rest.to_vec();
    *carry = keep;
    out
}

/// Whether `bytes` show anything: at least one character that is not inside an escape
/// sequence (CSI, OSC / DCS / APC / PM strings, two- and three-byte escapes), not a control
/// character and not whitespace. A sequence split across chunks may be misread; the cost is a
/// session turning `idle` one chunk early or late.
pub fn has_printable(bytes: &[u8]) -> bool {
    let text = String::from_utf8_lossy(bytes);
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\u{1b}' => match chars.next() {
                Some('[') => {
                    for c in chars.by_ref() {
                        if ('@'..='~').contains(&c) {
                            break;
                        }
                    }
                }
                Some(']' | 'P' | '_' | '^' | 'X') => {
                    while let Some(c) = chars.next() {
                        if c == '\u{7}' {
                            break;
                        }
                        if c == '\u{1b}' && chars.peek() == Some(&'\\') {
                            chars.next();
                            break;
                        }
                    }
                }
                Some('(' | ')' | '*' | '+' | '-' | '.' | '/' | '#' | '%' | ' ') => {
                    chars.next();
                }
                _ => {}
            },
            '\u{FFFD}' => {}
            c if c.is_control() || c.is_whitespace() => {}
            _ => return true,
        }
    }
    false
}

/// Windows: make sure the children see Ctrl+C. A process started with Ctrl+C ignored (by a
/// parent that ignored it, as some launchers and shells do) passes that on to every child, and
/// a terminal's child would then never be interrupted by the `\x03` the terminal sends (Stop's
/// interrupt included, Story 4.4). Restoring normal Ctrl+C processing in this process, once,
/// before the first spawn, gives every child the default. This also restores Switchboard's own
/// default Ctrl+C handling: a debug build run from a console now ends on Ctrl+C there, as any
/// console program does (a release build has no console). A failure is logged and the spawn
/// goes ahead. Elsewhere a no-op.
fn allow_ctrl_c() {
    #[cfg(windows)]
    {
        static ONCE: std::sync::Once = std::sync::Once::new();
        ONCE.call_once(|| {
            // SAFETY: a plain flag change; a null handler with FALSE only restores the default.
            let ok = unsafe { windows_sys::Win32::System::Console::SetConsoleCtrlHandler(None, 0) };
            if ok == 0 {
                eprintln!("pty: could not restore Ctrl+C handling for terminals: {}", std::io::Error::last_os_error());
            }
        });
    }
}

// ---------------------------------------------------------------------------------------
// Windows Job Object
// ---------------------------------------------------------------------------------------

/// A kill-on-close Job Object: closing it ends every process in it (the shell and whatever
/// it started), so no grandchild outlives a terminal.
#[cfg(windows)]
struct Job(windows_sys::Win32::Foundation::HANDLE);

// SAFETY: a job handle is a kernel handle, usable from any thread.
#[cfg(windows)]
unsafe impl Send for Job {}
#[cfg(windows)]
unsafe impl Sync for Job {}

#[cfg(windows)]
impl Job {
    /// A new job holding the process behind `process` (a raw process handle), or `None` when
    /// the job cannot be made or assigned (the shell then runs without one).
    fn for_process(process: std::os::windows::io::RawHandle) -> Option<Self> {
        use windows_sys::Win32::System::JobObjects::{
            AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
            JobObjectExtendedLimitInformation, SetInformationJobObject,
        };
        // SAFETY: plain Win32 calls on a handle we own; the struct is zeroed POD.
        unsafe {
            let handle = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if handle.is_null() {
                return None;
            }
            let job = Job(handle);
            let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let set = SetInformationJobObject(
                job.0,
                JobObjectExtendedLimitInformation,
                (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            );
            if set == 0 || AssignProcessToJobObject(job.0, process.cast()) == 0 {
                return None;
            }
            Some(job)
        }
    }
}

#[cfg(windows)]
impl Drop for Job {
    fn drop(&mut self) {
        // SAFETY: the handle is ours and closed once.
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(self.0);
        }
    }
}

// ---------------------------------------------------------------------------------------
// One terminal
// ---------------------------------------------------------------------------------------

/// The running half of a terminal: dropped (closing the PTY) when the child exits.
struct Live {
    master: Box<dyn MasterPty + Send>,
    /// Input for the writer thread; `term_write` only enqueues.
    input: Option<mpsc::Sender<Vec<u8>>>,
    writer: Option<JoinHandle<()>>,
    killer: Box<dyn ChildKiller + Send + Sync>,
    pid: Option<u32>,
    /// Set by the waiter as soon as `wait()` returned: the pid may be reused from then on.
    reaped: Arc<AtomicBool>,
    #[cfg(windows)]
    job: Option<Job>,
}

impl Live {
    /// Signal the child to end; on Windows, close its job, which ends its descendants too.
    fn signal(&mut self) {
        let _ = self.killer.kill();
        #[cfg(windows)]
        drop(self.job.take());
    }
}

/// Output on its way from the reader to the emitter of one spawn, and the spawn's end.
#[derive(Default)]
struct Pending {
    bytes: Vec<u8>,
    /// The ring's byte count after the last byte in `bytes`.
    end: u64,
    /// The reader reached EOF.
    eof: bool,
    /// The child's exit code, once the waiter has it.
    exit: Option<i32>,
    /// `term://exit` was sent: nothing more goes out for this spawn.
    done: bool,
}

#[derive(Default)]
struct Channel {
    pending: Mutex<Pending>,
    ready: Condvar,
}

/// Called once, on a session terminal's first output.
pub type OutputHook = Box<dyn FnOnce() + Send>;
/// Called once, with the exit code, when a session terminal's child has exited (after
/// `term://exit` went out).
pub type ExitHook = Box<dyn FnOnce(i32) + Send>;

/// What a session terminal tells its launcher (Story 4.2).
pub struct SessionHooks {
    pub first_output: OutputHook,
    pub exit: ExitHook,
}

pub struct Term {
    pub id: String,
    pub kind: TermKind,
    pub project_id: String,
    pub title: String,
    pub cwd: String,
    live: Mutex<Option<Live>>,
    buffer: Mutex<Ring>,
    /// `None` while running.
    exited: Mutex<Option<i32>>,
    error: Mutex<Option<String>>,
    size: Mutex<(u16, u16)>,
    /// Bumped per spawn; a reader of an older spawn stops feeding the buffer.
    generation: AtomicU64,
    /// Held while a spawn starts, and by whatever must not interleave with one (open of an
    /// existing terminal, restart, kill), so none of them sees a half-started terminal.
    starting: Mutex<()>,
    first_output: Mutex<Option<OutputHook>>,
    on_exit: Mutex<Option<ExitHook>>,
    /// A Stop of the current spawn is under way (cleared by the next spawn).
    stopping: AtomicBool,
}

impl Term {
    fn new(id: String, kind: TermKind, project_id: String, title: String, cwd: String, cols: u16, rows: u16) -> Self {
        Self {
            id,
            kind,
            project_id,
            title,
            cwd,
            live: Mutex::new(None),
            buffer: Mutex::new(Ring::new(RING_CAPACITY)),
            exited: Mutex::new(None),
            error: Mutex::new(None),
            size: Mutex::new(clamp_size(cols, rows)),
            generation: AtomicU64::new(0),
            starting: Mutex::new(()),
            first_output: Mutex::new(None),
            on_exit: Mutex::new(None),
            stopping: AtomicBool::new(false),
        }
    }

    pub fn info(&self) -> TermInfo {
        let (cols, rows) = self.size();
        let exited = *lock(&self.exited);
        TermInfo {
            stopping: exited.is_none() && self.stopping.load(Ordering::SeqCst),
            id: self.id.clone(),
            kind: self.kind,
            project_id: self.project_id.clone(),
            title: self.title.clone(),
            cwd: self.cwd.clone(),
            exited,
            error: lock(&self.error).clone(),
            cols,
            rows,
        }
    }

    pub fn is_running(&self) -> bool {
        lock(&self.exited).is_none()
    }

    /// The child's process id while it runs.
    pub fn pid(&self) -> Option<u32> {
        lock(&self.live).as_ref().and_then(|live| live.pid)
    }

    /// Record an exit and report it, unless a newer spawn has started since. Returns the exit
    /// hook (a session terminal's) with the code, for the caller to run once it holds no lock.
    #[must_use]
    fn finish(&self, generation: u64, code: i32, sink: &dyn Sink) -> Option<(ExitHook, i32)> {
        if self.generation.load(Ordering::SeqCst) != generation {
            return None;
        }
        *lock(&self.exited) = Some(code);
        sink.exit(&self.id, Some(code));
        lock(&self.on_exit).take().map(|hook| (hook, code))
    }

    /// Exited without a child: the reason goes to the buffer, the view and `error`.
    fn fail(&self, message: String, sink: &dyn Sink) {
        let line = format!("{message}\r\n");
        let offset = {
            let mut ring = lock(&self.buffer);
            ring.push(line.as_bytes());
            ring.total()
        };
        *lock(&self.error) = Some(message);
        *lock(&self.exited) = Some(SPAWN_FAILED);
        sink.data(&self.id, line, offset);
        sink.exit(&self.id, Some(SPAWN_FAILED));
    }

    /// Spawn `spec` in a fresh PTY (the caller holds `starting`). A failure is not an `Err`:
    /// the terminal is then exited with [`SPAWN_FAILED`] (see [`Term::fail`]).
    fn start(self: &Arc<Self>, spec: Result<SpawnSpec, String>, sink: Arc<dyn Sink>) {
        let spec = match spec {
            Ok(spec) => spec,
            Err(message) => {
                self.generation.fetch_add(1, Ordering::SeqCst);
                return self.fail(message, sink.as_ref());
            }
        };
        if let Err(message) = self.try_start(&spec, sink.clone()) {
            self.fail(message, sink.as_ref());
        }
    }

    /// Spawn `spec` in a fresh PTY (the caller holds `starting`). `Err` is the line
    /// `could not start <program>: <cause>`; nothing is recorded or reported then.
    fn try_start(self: &Arc<Self>, spec: &SpawnSpec, sink: Arc<dyn Sink>) -> Result<(), String> {
        let generation = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
        let (live, reader, child) = self
            .spawn(spec)
            .map_err(|cause| format!("could not start {}: {cause}", spec.program.display()))?;
        let reaped = live.reaped.clone();
        self.stopping.store(false, Ordering::SeqCst);
        *lock(&self.error) = None;
        *lock(&self.exited) = None;
        *lock(&self.live) = Some(live);
        let channel = Arc::new(Channel::default());
        self.spawn_reader(generation, reader, channel.clone());
        self.spawn_emitter(generation, channel.clone(), sink.clone());
        self.spawn_waiter(generation, child, reaped, channel, sink);
        Ok(())
    }

    #[allow(clippy::type_complexity)]
    fn spawn(
        &self,
        spec: &SpawnSpec,
    ) -> Result<(Live, Box<dyn Read + Send>, Box<dyn portable_pty::Child + Send + Sync>), String> {
        let (cols, rows) = *lock(&self.size);
        allow_ctrl_c();
        let pair = native_pty_system()
            .openpty(pty_size(cols, rows))
            .map_err(|err| err.to_string())?;
        let child = match pair.slave.spawn_command(spec.command()) {
            Ok(child) => child,
            Err(err) => {
                // The pseudoconsole host is already up and waiting for its cursor reply: answer
                // it now, then close the PTY off this thread, or the headless conhost lingers
                // for minutes (see `close_detached`).
                if cfg!(windows)
                    && let Ok(mut writer) = pair.master.take_writer()
                {
                    let _ = writer.write_all(b"\x1b[1;1R");
                    let _ = writer.flush();
                }
                std::thread::spawn(move || drop(pair));
                return Err(err.to_string());
            }
        };
        // Into the job before it can start anything of its own (well, almost: right after).
        #[cfg(windows)]
        let job = child.as_raw_handle().and_then(Job::for_process);
        // Only the child keeps the slave open, so the reader sees EOF when it is gone.
        drop(pair.slave);
        let reader = pair.master.try_clone_reader().map_err(|err| err.to_string())?;
        let mut writer = pair.master.take_writer().map_err(|err| err.to_string())?;
        let (input, queue) = mpsc::channel::<Vec<u8>>();
        let writer = std::thread::spawn(move || {
            for data in queue {
                if writer.write_all(&data).is_err() || writer.flush().is_err() {
                    break;
                }
            }
        });
        let live = Live {
            master: pair.master,
            input: Some(input),
            writer: Some(writer),
            killer: child.clone_killer(),
            pid: child.process_id(),
            reaped: Arc::new(AtomicBool::new(false)),
            #[cfg(windows)]
            job,
        };
        Ok((live, reader, child))
    }

    fn spawn_reader(self: &Arc<Self>, generation: u64, mut reader: Box<dyn Read + Send>, channel: Arc<Channel>) {
        let term = self.clone();
        std::thread::spawn(move || {
            let mut chunk = vec![0u8; 64 * 1024];
            loop {
                let n = match reader.read(&mut chunk) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => n,
                };
                if term.generation.load(Ordering::SeqCst) != generation {
                    break;
                }
                let end = {
                    let mut ring = lock(&term.buffer);
                    ring.push(&chunk[..n]);
                    ring.total()
                };
                let mut pending = lock(&channel.pending);
                pending.bytes.extend_from_slice(&chunk[..n]);
                pending.end = end;
                drop(pending);
                channel.ready.notify_all();
                // A session terminal's first printable output (no lock held while it runs):
                // ConPTY's start-up cursor query and screen setup do not count.
                let waiting = lock(&term.first_output).is_some();
                if waiting && has_printable(&chunk[..n]) {
                    let first = lock(&term.first_output).take();
                    if let Some(hook) = first {
                        hook();
                    }
                }
            }
            lock(&channel.pending).eof = true;
            channel.ready.notify_all();
        });
    }

    fn spawn_emitter(self: &Arc<Self>, generation: u64, channel: Arc<Channel>, sink: Arc<dyn Sink>) {
        let term = self.clone();
        std::thread::spawn(move || {
            let id = term.id.clone();
            let mut carry = Vec::new();
            let mut last: Option<Instant> = None;
            let wait = |pending| channel.ready.wait(pending).unwrap_or_else(|e| e.into_inner());
            loop {
                let mut pending = lock(&channel.pending);
                while pending.bytes.is_empty() && !pending.eof && !pending.done {
                    pending = wait(pending);
                }
                if pending.done {
                    return;
                }
                if !pending.bytes.is_empty() {
                    // Coalesce: wait out the rest of the interval since the last event.
                    if let Some(gap) = last.map(|at| COALESCE.saturating_sub(at.elapsed())).filter(|w| !w.is_zero()) {
                        drop(pending);
                        std::thread::sleep(gap);
                        pending = lock(&channel.pending);
                        if pending.done {
                            return;
                        }
                    }
                    let take = pending.bytes.len().min(MAX_PAYLOAD);
                    let bytes: Vec<u8> = pending.bytes.drain(..take).collect();
                    let end = pending.end - pending.bytes.len() as u64;
                    let text = decode_utf8(&mut carry, &bytes);
                    if !text.is_empty() {
                        // Sent under the lock, so the waiter's fallback exit cannot overtake it.
                        sink.data(&id, text, end - carry.len() as u64);
                    }
                    last = Some(Instant::now());
                    continue;
                }
                // EOF and nothing pending: flush a dangling partial sequence, then the exit.
                if !carry.is_empty() {
                    let end = pending.end;
                    sink.data(&id, String::from_utf8_lossy(&carry).into_owned(), end);
                    carry.clear();
                }
                while pending.exit.is_none() && !pending.done {
                    pending = wait(pending);
                }
                let mut hook = None;
                if let (Some(code), false) = (pending.exit, pending.done) {
                    pending.done = true;
                    hook = term.finish(generation, code, sink.as_ref());
                }
                drop(pending);
                channel.ready.notify_all();
                if let Some((hook, code)) = hook {
                    hook(code);
                }
                return;
            }
        });
    }

    fn spawn_waiter(
        self: &Arc<Self>,
        generation: u64,
        mut child: Box<dyn portable_pty::Child + Send + Sync>,
        reaped: Arc<AtomicBool>,
        channel: Arc<Channel>,
        sink: Arc<dyn Sink>,
    ) {
        let term = self.clone();
        std::thread::spawn(move || {
            let waited = child.wait();
            reaped.store(true, Ordering::SeqCst);
            let code = match waited {
                // NTSTATUS codes (0xC000013A, …) come out negative, as Windows tools show them.
                Ok(status) => status.exit_code() as i32,
                Err(err) => {
                    *lock(&term.error) = Some(format!("could not wait for the shell: {err}"));
                    SPAWN_FAILED
                }
            };
            lock(&channel.pending).exit = Some(code);
            channel.ready.notify_all();
            // Close the PTY (ConPTY delivers EOF to the reader only once it is closed).
            if term.generation.load(Ordering::SeqCst) == generation
                && let Some(live) = lock(&term.live).take()
            {
                close_detached(live);
            }
            let deadline = Instant::now() + FLUSH_GRACE;
            let mut pending = lock(&channel.pending);
            while !pending.done {
                let left = deadline.saturating_duration_since(Instant::now());
                if left.is_zero() {
                    break;
                }
                pending = channel.ready.wait_timeout(pending, left).unwrap_or_else(|e| e.into_inner()).0;
            }
            // The output never ended (something still holds the PTY): report the exit anyway;
            // the emitter sends nothing more for this spawn.
            let mut hook = None;
            if !pending.done {
                pending.done = true;
                hook = term.finish(generation, code, sink.as_ref());
            }
            drop(pending);
            channel.ready.notify_all();
            if let Some((hook, code)) = hook {
                hook(code);
            }
        });
    }

    /// Queue input for the writer thread; never blocks on the PTY.
    pub fn write(&self, data: &[u8]) -> Result<(), String> {
        let live = lock(&self.live);
        let input = live.as_ref().and_then(|live| live.input.as_ref()).ok_or_else(|| "terminal has exited".to_string())?;
        input.send(data.to_vec()).map_err(|_| "terminal has exited".to_string())
    }

    pub fn resize(&self, cols: u16, rows: u16) -> Result<(), String> {
        let (cols, rows) = clamp_size(cols, rows);
        *lock(&self.size) = (cols, rows);
        match lock(&self.live).as_ref() {
            Some(live) => live.master.resize(pty_size(cols, rows)).map_err(|err| err.to_string()),
            None => Ok(()),
        }
    }

    pub fn size(&self) -> (u16, u16) {
        *lock(&self.size)
    }

    pub fn buffer(&self) -> TermBuffer {
        let (data, offset) = lock(&self.buffer).snapshot();
        TermBuffer { data, offset }
    }

    /// Signal the child to end; the waiter then reports the exit. A no-op once exited. On
    /// Unix a child still running after [`KILL_GRACE`] (it ignored SIGHUP) is killed hard.
    pub fn kill(self: &Arc<Self>) {
        let _starting = lock(&self.starting);
        self.kill_locked();
    }

    /// [`Term::kill`], only while spawn `generation` is the current one (the caller of a
    /// delayed kill must never end a newer spawn).
    fn kill_if(self: &Arc<Self>, generation: u64) {
        let _starting = lock(&self.starting);
        if self.generation.load(Ordering::SeqCst) == generation {
            self.kill_locked();
        }
    }

    /// Stop the running child (Story 4.4): `writes` go to its input in order, each after its
    /// pause; then, [`kill_after`](Duration) from now, a child of this same spawn still running
    /// is killed ([`Term::kill`]) and the waiter reports the exit as usual. A Stop while one is
    /// under way kills at once. `Ok(true)` when it killed at once; `Err` once exited.
    pub fn stop(self: &Arc<Self>, writes: Vec<(Duration, Vec<u8>)>, kill_after: Duration) -> Result<bool, String> {
        let generation = {
            let _starting = lock(&self.starting);
            if !self.is_running() {
                return Err("terminal has exited".to_string());
            }
            if self.stopping.swap(true, Ordering::SeqCst) {
                self.kill_locked();
                return Ok(true);
            }
            self.generation.load(Ordering::SeqCst)
        };
        let term = self.clone();
        std::thread::spawn(move || {
            let started = Instant::now();
            let current = |t: &Term| t.generation.load(Ordering::SeqCst) == generation && t.is_running();
            for (pause, bytes) in writes {
                std::thread::sleep(pause);
                if !current(&term) {
                    return;
                }
                let _ = term.write(&bytes);
            }
            // Wait out the rest of the grace, ending early once the child is gone.
            loop {
                if !current(&term) {
                    return;
                }
                let left = kill_after.saturating_sub(started.elapsed());
                if left.is_zero() {
                    break;
                }
                std::thread::sleep(left.min(Duration::from_millis(50)));
            }
            term.kill_if(generation);
        });
        Ok(false)
    }

    /// The body of [`Term::kill`]; the caller holds `starting`.
    fn kill_locked(self: &Arc<Self>) {
        let Some((pid, reaped)) = lock(&self.live).as_mut().map(|live| {
            live.signal();
            (live.pid, live.reaped.clone())
        }) else {
            return;
        };
        #[cfg(unix)]
        if let Some(pid) = pid {
            std::thread::spawn(move || {
                std::thread::sleep(KILL_GRACE);
                if !reaped.load(Ordering::SeqCst) {
                    hard_kill(pid);
                }
            });
        }
        #[cfg(not(unix))]
        let _ = (pid, reaped);
    }
}

/// Signal every one of `terms` first, then (Unix) give them one shared grace and kill the
/// survivors hard, then close their PTYs, without waiting for the waiters.
fn kill_now(terms: &[Arc<Term>]) {
    let mut lives = Vec::new();
    for term in terms {
        let _starting = lock(&term.starting);
        if let Some(mut live) = lock(&term.live).take() {
            live.signal();
            lives.push(live);
        }
    }
    #[cfg(unix)]
    {
        let deadline = Instant::now() + KILL_GRACE;
        let running = |live: &Live| !live.reaped.load(Ordering::SeqCst) && live.pid.is_some_and(process_alive);
        while lives.iter().any(running) && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(10));
        }
        for live in lives.iter().filter(|live| running(live)) {
            if let Some(pid) = live.pid {
                hard_kill(pid);
            }
        }
    }
    for live in lives {
        close_detached(live);
    }
}

/// Close a PTY on a thread of its own, so no caller ever waits for it.
///
/// On Windows the pseudoconsole host starts by asking for the cursor position (`ESC[6n`) and
/// blocks until it is answered; the terminal view answers it, but with no view (quit before
/// the webview loaded, a reload) nobody does, and then `ClosePseudoConsole` blocks for minutes
/// and the headless `conhost.exe` outlives the app. The child is gone by now, so a cursor
/// report written first is read by nobody but that host, which can then shut down.
fn close_detached(live: Live) {
    std::thread::spawn(move || {
        let mut live = live;
        if let Some(input) = live.input.take() {
            if cfg!(windows) {
                let _ = input.send(b"\x1b[1;1R".to_vec());
            }
            drop(input);
        }
        if let Some(writer) = live.writer.take() {
            let _ = writer.join();
        }
        drop(live);
    });
}

/// SIGKILL the child's process group and the child itself.
#[cfg(unix)]
fn hard_kill(pid: u32) {
    let Ok(pid) = i32::try_from(pid) else {
        return;
    };
    // SAFETY: plain signal sends; the caller checked the child was not reaped, so the pid is
    // still ours.
    unsafe {
        libc::kill(-pid, libc::SIGKILL);
        libc::kill(pid, libc::SIGKILL);
    }
}

/// Whether `pid` still exists. A zombie (exited, not yet reaped) counts as existing; callers
/// pair this with the waiter's `reaped` flag.
#[cfg(unix)]
fn process_alive(pid: u32) -> bool {
    let Ok(pid) = i32::try_from(pid) else {
        return false;
    };
    // SAFETY: signal 0 only checks for existence.
    unsafe { libc::kill(pid, 0) == 0 }
}

// ---------------------------------------------------------------------------------------
// The manager
// ---------------------------------------------------------------------------------------

/// Every terminal of the app, by id (in `AppState`).
#[derive(Default)]
pub struct TermManager {
    terms: Mutex<HashMap<String, Arc<Term>>>,
    /// Open order, for `term_list`.
    order: Mutex<Vec<String>>,
}

/// The id of a project's plain terminal (one per project until tabs, Story 4.5).
pub fn plain_id(project_id: &str) -> String {
    format!("plain-{project_id}")
}

/// What a session terminal's id starts with; the session id follows.
pub const SESSION_PREFIX: &str = "session:";

/// The id of the terminal a launched session runs in (Story 4.2).
pub fn session_id(session_id: &str) -> String {
    format!("{SESSION_PREFIX}{session_id}")
}

impl TermManager {
    pub fn get(&self, id: &str) -> Option<Arc<Term>> {
        lock(&self.terms).get(id).cloned()
    }

    fn require(&self, id: &str) -> Result<Arc<Term>, String> {
        self.get(id).ok_or_else(|| "unknown terminal".to_string())
    }

    /// Open terminal `id`, or return it as it is (running or exited) when it already exists,
    /// once any spawn in progress has finished. `spec` is produced only for a new terminal:
    /// `Err` from it (a shell that cannot be resolved) still opens the terminal, exited with
    /// that message.
    #[allow(clippy::too_many_arguments)]
    pub fn open(
        &self,
        id: &str,
        project_id: &str,
        title: &str,
        cwd: &str,
        size: (u16, u16),
        spec: impl FnOnce() -> Result<SpawnSpec, String>,
        sink: Arc<dyn Sink>,
    ) -> TermInfo {
        let mut terms = lock(&self.terms);
        if let Some(existing) = terms.get(id).cloned() {
            drop(terms);
            let _starting = lock(&existing.starting);
            return existing.info();
        }
        let term = Arc::new(Term::new(
            id.to_string(),
            TermKind::Plain,
            project_id.to_string(),
            title.to_string(),
            cwd.to_string(),
            size.0,
            size.1,
        ));
        // Taken before the terminal is visible to anyone else.
        let starting = term.clone();
        let _starting = lock(&starting.starting);
        terms.insert(id.to_string(), term.clone());
        lock(&self.order).push(id.to_string());
        drop(terms);
        term.start(spec(), sink);
        term.info()
    }

    pub fn write(&self, id: &str, data: &[u8]) -> Result<(), String> {
        self.require(id)?.write(data)
    }

    pub fn resize(&self, id: &str, cols: u16, rows: u16) -> Result<(), String> {
        self.require(id)?.resize(cols, rows)
    }

    pub fn buffer(&self, id: &str) -> Result<TermBuffer, String> {
        Ok(self.require(id)?.buffer())
    }

    /// Open a session terminal (Story 4.2): `spec` runs under the new id `id`, titled with the
    /// session's name. Unlike [`TermManager::open`] a spawn failure is an `Err` (the line
    /// `could not start <program>: <cause>`) and leaves no new terminal behind. `hooks` run once
    /// each: on the first output, and with the exit code after `term://exit`. An exited
    /// terminal with the same id (a resumed session's last run, Story 4.4) is replaced, keeping
    /// its place in the list (and is put back when the spawn fails); a running one is an `Err`.
    #[allow(clippy::too_many_arguments)]
    pub fn open_session(
        &self,
        id: &str,
        project_id: &str,
        title: &str,
        cwd: &str,
        size: (u16, u16),
        spec: SpawnSpec,
        sink: Arc<dyn Sink>,
        hooks: SessionHooks,
    ) -> Result<TermInfo, String> {
        let mut terms = lock(&self.terms);
        let previous = terms.get(id).cloned();
        if let Some(previous) = &previous {
            let _starting = lock(&previous.starting);
            if previous.is_running() {
                return Err("terminal already exists".to_string());
            }
        }
        let term = Arc::new(Term::new(
            id.to_string(),
            TermKind::Session,
            project_id.to_string(),
            title.to_string(),
            cwd.to_string(),
            size.0,
            size.1,
        ));
        *lock(&term.first_output) = Some(hooks.first_output);
        *lock(&term.on_exit) = Some(hooks.exit);
        let starting = term.clone();
        let _starting = lock(&starting.starting);
        terms.insert(id.to_string(), term.clone());
        if previous.is_none() {
            lock(&self.order).push(id.to_string());
        }
        drop(terms);
        if let Err(message) = term.try_start(&spec, sink) {
            match previous {
                Some(previous) => {
                    lock(&self.terms).insert(id.to_string(), previous);
                }
                None => {
                    lock(&self.terms).remove(id);
                    lock(&self.order).retain(|known| known != id);
                }
            }
            return Err(message);
        }
        Ok(term.info())
    }

    /// Respawn an exited terminal under the same id; its buffer is kept. A session terminal is
    /// never restarted.
    pub fn restart(&self, id: &str, spec: impl FnOnce() -> Result<SpawnSpec, String>, sink: Arc<dyn Sink>) -> Result<TermInfo, String> {
        let term = self.require(id)?;
        if term.kind == TermKind::Session {
            return Err("a session terminal cannot be restarted".to_string());
        }
        let _starting = lock(&term.starting);
        if term.is_running() {
            return Err("terminal is still running".to_string());
        }
        term.start(spec(), sink);
        Ok(term.info())
    }

    pub fn kill(&self, id: &str) -> Result<(), String> {
        self.require(id)?.kill();
        Ok(())
    }

    /// Stop terminal `id` (see [`Term::stop`]); replies with its info, `stopping` set.
    pub fn stop(&self, id: &str, writes: Vec<(Duration, Vec<u8>)>, kill_after: Duration) -> Result<TermInfo, String> {
        let term = self.require(id)?;
        term.stop(writes, kill_after)?;
        Ok(term.info())
    }

    /// Forget an exited session terminal (its "Close"): it leaves the list and its buffer goes.
    /// A running terminal, or a plain one, is not closed.
    pub fn close(&self, id: &str) -> Result<(), String> {
        let term = self.require(id)?;
        let _starting = lock(&term.starting);
        if term.kind != TermKind::Session {
            return Err("only a session terminal is closed".to_string());
        }
        if term.is_running() {
            return Err("terminal is still running".to_string());
        }
        lock(&self.terms).remove(id);
        lock(&self.order).retain(|known| known != id);
        Ok(())
    }

    pub fn list(&self) -> Vec<TermInfo> {
        let terms: Vec<Arc<Term>> = {
            let map = lock(&self.terms);
            lock(&self.order).iter().filter_map(|id| map.get(id).cloned()).collect()
        };
        terms.iter().map(|t| t.info()).collect()
    }

    /// Kill every child and close every PTY now (app exit). Terminals stay listed.
    pub fn kill_all(&self) {
        let terms: Vec<Arc<Term>> = lock(&self.terms).values().cloned().collect();
        kill_now(&terms);
    }

    /// Kill and forget every terminal of `project_id` (the project left the canvas). Returns
    /// their ids.
    pub fn forget_project(&self, project_id: &str) -> Vec<String> {
        let gone: Vec<Arc<Term>> = {
            let mut terms = lock(&self.terms);
            let ids: Vec<String> = terms.values().filter(|t| t.project_id == project_id).map(|t| t.id.clone()).collect();
            lock(&self.order).retain(|id| !ids.contains(id));
            ids.iter().filter_map(|id| terms.remove(id)).collect()
        };
        kill_now(&gone);
        gone.iter().map(|t| t.id.clone()).collect()
    }
}

#[cfg(test)]
pub(crate) mod tests;
