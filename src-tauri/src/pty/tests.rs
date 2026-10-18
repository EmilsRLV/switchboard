//! PTY tests. They spawn only `cmd.exe /d` (Windows, no AutoRun) or `/bin/sh` with `ENV`
//! removed (Unix, no profile), never the user's shell, and every test kills what it spawned.

use super::*;
use std::sync::mpsc;

/// Records every event per terminal; the waits answer ConPTY's start-up cursor query (`ESC[6n`)
/// for every terminal, the way each xterm view does.
/// One recorded event: `(id, Some((data, offset)))` for data, `(id, None)` for an exit.
type Logged = (String, Option<(String, u64)>);

#[derive(Default)]
struct Recorder {
    text: Mutex<HashMap<String, String>>,
    /// Every event in order: `(id, Some((data, offset)))` for data, `(id, None)` for an exit.
    log: Mutex<Vec<Logged>>,
    exit_tx: Mutex<Option<mpsc::Sender<Option<i32>>>>,
}

impl Recorder {
    /// The data events of `id`, in order.
    fn data_of(&self, id: &str) -> Vec<(String, u64)> {
        lock(&self.log).iter().filter(|(i, _)| i == id).filter_map(|(_, d)| d.clone()).collect()
    }
}

impl Sink for Recorder {
    fn data(&self, id: &str, data: String, offset: u64) {
        lock(&self.text).entry(id.to_string()).or_default().push_str(&data);
        lock(&self.log).push((id.to_string(), Some((data, offset))));
    }

    fn exit(&self, id: &str, code: Option<i32>) {
        lock(&self.log).push((id.to_string(), None));
        if let Some(tx) = lock(&self.exit_tx).as_ref() {
            let _ = tx.send(code);
        }
    }
}

const TIMEOUT: Duration = Duration::from_secs(20);

/// The fixture shell for this OS.
fn fixture(cwd: &std::path::Path) -> SpawnSpec {
    #[cfg(windows)]
    let mut spec = SpawnSpec::new("cmd.exe", vec!["/d".into()], cwd);
    #[cfg(not(windows))]
    let mut spec = SpawnSpec::new("/bin/sh", vec![], cwd);
    spec.env_remove = vec!["ENV".into(), "BASH_ENV".into()];
    spec
}

/// `a+b` evaluated by the fixture shell, so the output (the sum) differs from the input.
fn sum_line(a: u32, b: u32) -> String {
    if cfg!(windows) {
        format!("set /a {a}+{b}\r")
    } else {
        format!("echo $(({a}+{b}))\r")
    }
}

/// Strip CSI / OSC escape sequences (ConPTY interleaves cursor moves with text).
fn strip_escapes(text: &str) -> String {
    let mut out = String::new();
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if c != '\u{1b}' {
            out.push(c);
            continue;
        }
        match chars.next() {
            Some('[') => {
                for c in chars.by_ref() {
                    if ('@'..='~').contains(&c) {
                        break;
                    }
                }
            }
            Some(']') => {
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
            _ => {}
        }
    }
    out
}

struct Fixture {
    manager: TermManager,
    sink: Arc<Recorder>,
    exits: mpsc::Receiver<Option<i32>>,
    dir: tempfile::TempDir,
    answered: Mutex<HashMap<String, usize>>,
}

impl Fixture {
    fn new() -> Self {
        let (tx, rx) = mpsc::channel();
        let sink = Arc::new(Recorder::default());
        *lock(&sink.exit_tx) = Some(tx);
        Self {
            manager: TermManager::default(),
            sink,
            exits: rx,
            dir: tempfile::tempdir().unwrap(),
            answered: Mutex::new(HashMap::new()),
        }
    }

    fn open(&self, id: &str, cols: u16, rows: u16) -> TermInfo {
        let spec = fixture(self.dir.path());
        self.manager.open(
            id,
            "p",
            "project",
            &self.dir.path().display().to_string(),
            (cols, rows),
            move || Ok(spec),
            self.sink.clone(),
        )
    }

    fn answer_cursor_queries(&self) {
        let asked: Vec<(String, usize)> = lock(&self.sink.text)
            .iter()
            .map(|(id, text)| (id.clone(), text.matches("\u{1b}[6n").count()))
            .collect();
        let mut answered = lock(&self.answered);
        for (id, asked) in asked {
            let done = answered.entry(id.clone()).or_default();
            while *done < asked {
                let _ = self.manager.write(&id, b"\x1b[1;1R");
                *done += 1;
            }
        }
    }

    fn text(&self, id: &str) -> String {
        strip_escapes(lock(&self.sink.text).get(id).map(String::as_str).unwrap_or(""))
    }

    /// Wait until the escape-stripped output satisfies `pred`; panics with the output on timeout.
    fn wait_for(&self, id: &str, what: &str, pred: impl Fn(&str) -> bool) {
        let started = Instant::now();
        loop {
            self.answer_cursor_queries();
            let text = self.text(id);
            if pred(&text) {
                return;
            }
            assert!(started.elapsed() < TIMEOUT, "timed out waiting for {what}; output:\n{text:?}");
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    fn wait_exit(&self, id: &str) -> Option<i32> {
        let started = Instant::now();
        loop {
            self.answer_cursor_queries();
            match self.exits.recv_timeout(Duration::from_millis(50)) {
                Ok(code) => return code,
                Err(_) => assert!(started.elapsed() < TIMEOUT, "no exit event for {id}"),
            }
        }
    }

    /// Wait for the shell's first output (its prompt).
    fn ready(&self, id: &str) {
        self.wait_for(id, "the prompt", |t| !t.trim().is_empty());
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        self.manager.kill_all();
    }
}

/// Whether process `pid` still exists.
#[cfg(unix)]
pub(crate) fn alive(pid: u32) -> bool {
    // A zombie still answers until the waiter reaps it, which it does at once.
    super::process_alive(pid)
}

/// Whether process `pid` still exists.
#[cfg(windows)]
pub(crate) fn alive(pid: u32) -> bool {
    use windows_sys::Win32::Foundation::{CloseHandle, STILL_ACTIVE};
    use windows_sys::Win32::System::Threading::{GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};
    // SAFETY: plain handle queries; the handle is closed before returning.
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle.is_null() {
            return false;
        }
        let mut code = 0u32;
        let ok = GetExitCodeProcess(handle, &mut code);
        CloseHandle(handle);
        ok != 0 && code == STILL_ACTIVE as u32
    }
}

pub(crate) fn wait_dead(pid: u32) {
    let started = Instant::now();
    while alive(pid) {
        assert!(started.elapsed() < TIMEOUT, "process {pid} still alive");
        std::thread::sleep(Duration::from_millis(50));
    }
}

// --- pure ------------------------------------------------------------------------------

#[test]
fn ring_keeps_the_last_capacity_bytes() {
    let mut ring = Ring::new(8);
    assert!(ring.is_empty());
    ring.push(b"abc");
    ring.push(b"defg");
    assert_eq!(ring.bytes(), b"abcdefg");
    ring.push(b"hij");
    assert_eq!(ring.bytes(), b"cdefghij");
    assert_eq!(ring.len(), 8);
    ring.push(b"0123456789");
    assert_eq!(ring.bytes(), b"23456789");
    ring.push(b"");
    // Wrapped with no newline to start at: a reset first.
    assert_eq!(ring.text(), "\x1bc23456789");
    assert_eq!(ring.total(), 20);
    assert_eq!(ring.snapshot().1, 20);
}

#[test]
fn ring_text_skips_a_sequence_cut_by_the_wrap() {
    let mut ring = Ring::new(4);
    ring.push("aé".as_bytes()); // 61 c3 a9
    ring.push("€".as_bytes()); // e2 82 ac -> keeps a9 e2 82 ac
    assert_eq!(ring.text(), "\x1bc€");
    let mut fresh = Ring::new(16);
    fresh.push("é".as_bytes());
    assert_eq!(fresh.text(), "é");
}

#[test]
fn a_wrapped_ring_replays_from_its_first_newline_and_stops_before_a_cut_character() {
    let mut ring = Ring::new(16);
    ring.push(b"\x1b[31mold line\r\nnew");
    // 18 bytes into 16: the front is cut inside the first line.
    let (text, offset) = ring.snapshot();
    assert_eq!(text, "new");
    assert_eq!(offset, 18);
    // A character still arriving is left out, and the offset stops before it.
    ring.push(&"é".as_bytes()[..1]);
    let (text, offset) = ring.snapshot();
    assert_eq!(text, "new");
    assert_eq!(offset, 18);
    ring.push(&"é".as_bytes()[1..]);
    assert_eq!(ring.snapshot(), ("newé".to_string(), 20));
    // Not wrapped: everything, from the start.
    let mut fresh = Ring::new(64);
    fresh.push(b"one\r\ntwo");
    assert_eq!(fresh.snapshot(), ("one\r\ntwo".to_string(), 8));
}

#[test]
fn split_utf8_survives_across_chunks() {
    let text = "a€é😀z";
    let bytes = text.as_bytes();
    for cut in 0..=bytes.len() {
        let mut carry = Vec::new();
        let mut out = decode_utf8(&mut carry, &bytes[..cut]);
        assert!(carry.len() <= 3, "cut {cut}: carry {carry:?}");
        out.push_str(&decode_utf8(&mut carry, &bytes[cut..]));
        assert_eq!(out, text, "cut at {cut}");
        assert!(carry.is_empty());
    }
    // Byte by byte, too.
    let mut carry = Vec::new();
    let out: String = bytes.iter().map(|b| decode_utf8(&mut carry, &[*b])).collect();
    assert_eq!(out, text);
    // Invalid bytes become U+FFFD and decoding goes on.
    let mut carry = Vec::new();
    assert_eq!(decode_utf8(&mut carry, b"a\xffb"), "a\u{FFFD}b");
    assert!(carry.is_empty());
}

#[test]
fn sizes_are_clamped_to_two_by_one() {
    assert_eq!(clamp_size(0, 0), (2, 1));
    assert_eq!(clamp_size(1, 5), (2, 5));
    assert_eq!(clamp_size(80, 24), (80, 24));
}

#[test]
fn the_spawn_command_sets_term_and_colorterm_and_the_cwd() {
    let spec = SpawnSpec::new("sh", vec!["-i".into()], "/tmp/x");
    let cmd = spec.command();
    assert_eq!(cmd.get_env("TERM").and_then(|v| v.to_str()), Some("xterm-256color"));
    assert_eq!(cmd.get_env("COLORTERM").and_then(|v| v.to_str()), Some("truecolor"));
    assert_eq!(cmd.get_cwd().map(|c| c.to_string_lossy().into_owned()), Some("/tmp/x".into()));
    assert_eq!(cmd.get_argv().len(), 2);
}

// --- real PTYs -------------------------------------------------------------------------

#[test]
fn output_arrives_write_echoes_and_the_buffer_replays() {
    let f = Fixture::new();
    let info = f.open("t1", 100, 30);
    assert_eq!(info.exited, None);
    assert_eq!(info.error, None);
    assert_eq!(info.title, "project");
    f.ready("t1");
    f.manager.write("t1", sum_line(1234, 4321).as_bytes()).unwrap();
    f.wait_for("t1", "the sum", |t| t.contains("5555"));
    // The buffer holds what was streamed.
    let buffer = f.manager.buffer("t1").unwrap();
    assert!(strip_escapes(&buffer.data).contains("5555"), "{buffer:?}");
    // Each event is non-empty and ends at the byte offset of everything streamed so far.
    let events = f.sink.data_of("t1");
    let mut streamed = 0u64;
    for (data, offset) in &events {
        assert!(!data.is_empty());
        streamed += data.len() as u64;
        assert_eq!(*offset, streamed, "offsets count the bytes streamed");
    }
    assert!(buffer.offset >= streamed);
    assert!(events.iter().all(|(data, _)| data.len() <= MAX_PAYLOAD));
    let info = f.manager.list().pop().unwrap();
    assert_eq!((info.cols, info.rows), (100, 30));
    // Opening again returns the same terminal, no second shell.
    let pid = f.manager.get("t1").unwrap().pid();
    let again = f.open("t1", 80, 24);
    assert_eq!(again.id, "t1");
    assert_eq!(f.manager.get("t1").unwrap().pid(), pid);
    assert_eq!(f.manager.list().len(), 1);
    f.manager.kill("t1").unwrap();
    f.wait_exit("t1");
    wait_dead(pid.unwrap());
}

#[test]
fn resize_reaches_the_pty() {
    let f = Fixture::new();
    f.open("r", 80, 24);
    f.ready("r");
    f.manager.resize("r", 101, 37).unwrap();
    assert_eq!(f.manager.get("r").unwrap().size(), (101, 37));
    if cfg!(windows) {
        f.manager.write("r", b"mode con\r").unwrap();
        f.wait_for("r", "mode con reporting 37 x 101", |t| {
            let flat: String = t.chars().filter(|c| !c.is_whitespace()).collect();
            flat.contains(":37") && flat.contains(":101")
        });
    } else {
        f.manager.write("r", b"stty size\r").unwrap();
        f.wait_for("r", "stty size reporting 37 101", |t| t.contains("37 101"));
    }
    // Below the minimum is clamped, not an error.
    f.manager.resize("r", 0, 0).unwrap();
    assert_eq!(f.manager.get("r").unwrap().size(), (2, 1));
    assert!(f.manager.resize("nope", 10, 10).is_err());
    let pid = f.manager.get("r").unwrap().pid().unwrap();
    f.manager.kill_all();
    wait_dead(pid);
}

#[test]
fn exit_is_reported_and_restart_respawns_in_place() {
    let f = Fixture::new();
    f.open("e", 80, 24);
    f.ready("e");
    f.manager.write("e", sum_line(20, 22).as_bytes()).unwrap();
    f.wait_for("e", "42", |t| t.contains("42"));
    let first = f.manager.get("e").unwrap().pid().unwrap();
    f.manager.write("e", b"exit 3\r").unwrap();
    assert_eq!(f.wait_exit("e"), Some(3));
    let info = f.manager.list().pop().unwrap();
    assert_eq!(info.exited, Some(3));
    assert!(f.manager.write("e", b"x").is_err(), "an exited terminal takes no input");
    let kept = f.manager.buffer("e").unwrap();
    assert!(strip_escapes(&kept.data).contains("42"), "the buffer survives the exit");
    // Nothing of that spawn follows its exit.
    std::thread::sleep(Duration::from_millis(200));
    assert_eq!(lock(&f.sink.log).last().map(|(id, d)| (id.as_str(), d.is_none())), Some(("e", true)));
    wait_dead(first);

    let info = f
        .manager
        .restart("e", || Ok(fixture(f.dir.path())), f.sink.clone())
        .unwrap();
    assert_eq!(info.id, "e");
    assert_eq!(info.exited, None);
    let second = f.manager.get("e").unwrap().pid().unwrap();
    assert_ne!(first, second);
    assert!(
        f.manager.restart("e", || Ok(fixture(f.dir.path())), f.sink.clone()).is_err(),
        "a running terminal is not restarted"
    );
    f.manager.write("e", sum_line(3000, 333).as_bytes()).unwrap();
    f.wait_for("e", "3333", |t| t.contains("3333"));
    assert!(strip_escapes(&f.manager.buffer("e").unwrap().data).contains("42"), "old output is kept");
    f.manager.kill("e").unwrap();
    f.wait_exit("e");
    wait_dead(second);
}

#[test]
fn kill_ends_the_child_and_keeps_the_buffer() {
    let f = Fixture::new();
    f.open("k", 80, 24);
    f.ready("k");
    let pid = f.manager.get("k").unwrap().pid().unwrap();
    assert!(alive(pid));
    f.manager.kill("k").unwrap();
    let code = f.wait_exit("k");
    assert!(code.is_some());
    assert!(f.manager.list()[0].exited.is_some());
    wait_dead(pid);
    assert!(!f.manager.buffer("k").unwrap().data.is_empty());
    // Killing again (exited) and unknown ids.
    f.manager.kill("k").unwrap();
    assert!(f.manager.kill("nope").is_err());
}

#[test]
fn kill_all_leaves_no_child() {
    let f = Fixture::new();
    f.open("a", 80, 24);
    f.open("b", 80, 24);
    f.ready("a");
    f.ready("b");
    let pids: Vec<u32> = ["a", "b"].iter().map(|id| f.manager.get(id).unwrap().pid().unwrap()).collect();
    for pid in &pids {
        assert!(alive(*pid));
    }
    f.manager.kill_all();
    for pid in pids {
        wait_dead(pid);
    }
}

#[test]
fn a_shell_that_cannot_start_leaves_an_exited_terminal_with_the_reason() {
    let f = Fixture::new();
    let missing = f.dir.path().join("no-such-shell");
    let spec = SpawnSpec::new(&missing, vec![], f.dir.path());
    let info = f.manager.open("m", "p", "project", "x", (80, 24), move || Ok(spec), f.sink.clone());
    assert_eq!(info.exited, Some(SPAWN_FAILED));
    let error = info.error.unwrap();
    assert!(error.starts_with(&format!("could not start {}: ", missing.display())), "{error}");
    assert!(f.manager.buffer("m").unwrap().data.contains("could not start"));
    assert_eq!(f.wait_exit("m"), Some(SPAWN_FAILED));

    // A resolution failure is the same shape; restart then succeeds with a real shell.
    let info = f.manager.open("n", "p", "project", "x", (80, 24), || Err("could not start zsh: not found on PATH".into()), f.sink.clone());
    assert_eq!(info.error.as_deref(), Some("could not start zsh: not found on PATH"));
    let info = f.manager.restart("n", || Ok(fixture(f.dir.path())), f.sink.clone()).unwrap();
    assert_eq!(info.exited, None);
    assert_eq!(info.error, None);
    let pid = f.manager.get("n").unwrap().pid().unwrap();
    f.manager.kill_all();
    wait_dead(pid);
}

#[test]
fn kill_all_never_waits_for_a_pseudoconsole_nobody_answered() {
    // No `wait_for` here: ConPTY's start-up cursor query stays unanswered, as with no view.
    let f = Fixture::new();
    f.open("q", 80, 24);
    let pid = f.manager.get("q").unwrap().pid().unwrap();
    std::thread::sleep(Duration::from_millis(200));
    let started = Instant::now();
    f.manager.kill_all();
    assert!(started.elapsed() < Duration::from_secs(2), "kill_all blocked for {:?}", started.elapsed());
    wait_dead(pid);
    // The exit is still reported, within the flush grace.
    let code = f.exits.recv_timeout(Duration::from_secs(5)).expect("exit reported");
    assert!(code.is_some());
}


#[test]
fn forget_project_kills_and_drops_only_that_projects_terminals() {
    let f = Fixture::new();
    let open = |id: &str, project: &str| {
        let spec = fixture(f.dir.path());
        f.manager.open(id, project, project, "x", (80, 24), move || Ok(spec), f.sink.clone())
    };
    open("p1", "p");
    open("p2", "p");
    open("q1", "q");
    f.ready("p1");
    let pids: Vec<u32> = ["p1", "p2"].iter().map(|id| f.manager.get(id).unwrap().pid().unwrap()).collect();
    let mut gone = f.manager.forget_project("p");
    gone.sort();
    assert_eq!(gone, vec!["p1".to_string(), "p2".to_string()]);
    assert_eq!(f.manager.list().iter().map(|i| i.id.as_str()).collect::<Vec<_>>(), vec!["q1"]);
    assert!(f.manager.get("p1").is_none());
    for pid in pids {
        wait_dead(pid);
    }
    assert!(f.manager.get("q1").unwrap().is_running());
}

/// Kills `pids` when dropped, so a failed assertion leaves no grandchild behind.
struct Reap(Vec<u32>);

impl Drop for Reap {
    fn drop(&mut self) {
        for pid in &self.0 {
            force_kill(*pid);
        }
    }
}

#[cfg(windows)]
fn force_kill(pid: u32) {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::{OpenProcess, PROCESS_TERMINATE, TerminateProcess};
    // SAFETY: plain handle calls; the handle is closed before returning.
    unsafe {
        let handle = OpenProcess(PROCESS_TERMINATE, 0, pid);
        if !handle.is_null() {
            TerminateProcess(handle, 1);
            CloseHandle(handle);
        }
    }
}

#[cfg(unix)]
fn force_kill(pid: u32) {
    if let Ok(pid) = i32::try_from(pid) {
        // SAFETY: a plain signal send.
        unsafe {
            libc::kill(pid, libc::SIGKILL);
        }
    }
}

/// The processes whose parent is `parent`.
#[cfg(windows)]
fn children_of(parent: u32) -> Vec<u32> {
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, PROCESSENTRY32W, Process32FirstW, Process32NextW, TH32CS_SNAPPROCESS,
    };
    let mut out = Vec::new();
    // SAFETY: a process snapshot walked with a correctly sized entry, then closed.
    unsafe {
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snapshot == INVALID_HANDLE_VALUE {
            return out;
        }
        let mut entry: PROCESSENTRY32W = std::mem::zeroed();
        entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
        let mut more = Process32FirstW(snapshot, &mut entry) != 0;
        while more {
            if entry.th32ParentProcessID == parent {
                out.push(entry.th32ProcessID);
            }
            more = Process32NextW(snapshot, &mut entry) != 0;
        }
        CloseHandle(snapshot);
    }
    out
}

/// A shell that started a background `cmd` of its own: the shell's pid and the grandchild's.
#[cfg(windows)]
fn shell_with_grandchild(f: &Fixture, id: &str) -> (u32, u32, Reap) {
    f.open(id, 80, 24);
    f.ready(id);
    let shell = f.manager.get(id).unwrap().pid().unwrap();
    f.manager.write(id, b"start /b cmd /d /k\r").unwrap();
    let started = Instant::now();
    loop {
        f.answer_cursor_queries();
        if let Some(grandchild) = children_of(shell).into_iter().next() {
            return (shell, grandchild, Reap(vec![shell, grandchild]));
        }
        assert!(started.elapsed() < TIMEOUT, "no grandchild appeared");
        std::thread::sleep(Duration::from_millis(50));
    }
}

#[cfg(windows)]
#[test]
fn a_grandchild_dies_with_its_terminal_on_kill_and_on_kill_all() {
    let f = Fixture::new();
    let (shell, grandchild, _reap) = shell_with_grandchild(&f, "g1");
    assert!(alive(grandchild));
    f.manager.kill("g1").unwrap();
    wait_dead(shell);
    wait_dead(grandchild);

    let (shell, grandchild, _reap2) = shell_with_grandchild(&f, "g2");
    f.manager.kill_all();
    wait_dead(shell);
    wait_dead(grandchild);
}

#[cfg(unix)]
#[test]
fn kill_escalates_to_sigkill_when_hup_is_ignored() {
    let f = Fixture::new();
    for (id, all) in [("h1", false), ("h2", true)] {
        f.open(id, 80, 24);
        f.ready(id);
        let pid = f.manager.get(id).unwrap().pid().unwrap();
        let _reap = Reap(vec![pid]);
        f.manager.write(id, b"trap '' HUP; echo trapped-$((40+2))\r").unwrap();
        f.wait_for(id, "the trap", |t| t.contains("trapped-42"));
        if all {
            f.manager.kill_all();
        } else {
            f.manager.kill(id).unwrap();
        }
        wait_dead(pid);
    }
}

#[cfg(unix)]
#[test]
fn a_flood_of_output_goes_out_in_events_of_at_most_256_kib() {
    let f = Fixture::new();
    f.open("big", 80, 24);
    f.ready("big");
    f.manager.write("big", b"head -c 700000 /dev/zero | tr '\\0' a; echo; echo flood-$((1+1))\r").unwrap();
    f.wait_for("big", "the end of the flood", |t| t.contains("flood-2"));
    let events = f.sink.data_of("big");
    assert!(events.iter().all(|(data, _)| data.len() <= MAX_PAYLOAD));
    assert!(events.iter().map(|(d, _)| d.len()).sum::<usize>() >= 700_000);
    let pid = f.manager.get("big").unwrap().pid().unwrap();
    f.manager.kill_all();
    wait_dead(pid);
}
