//! Context edges on live sessions (Story 6.3). A context edge drawn from a session that runs
//! in a Switchboard terminal is applied to that session at once: once it is idle (`idle` or
//! `finished`, as Stop reads them) and the operator has no draft in its prompt, the single line
//! `/add-dir <path>` + Enter is written to its PTY, and the session's transcript is tailed
//! (read-only) for the `<local-command-stdout>` record that answers it. The edge's state --
//! `pending`, `applied` or `failed`, with a detail -- lives here, in memory only, and every
//! change goes out as `edges://live` with the whole map. Nothing is persisted: after an app
//! restart an edge has no live state.
//!
//! A job per edge does the waiting on a thread of its own; a newer job of the same edge (a
//! Retry), the edge's removal or the session's exit retires it. Jobs of one session inject one
//! at a time, so each confirmation is read against its own line.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, Runtime};

use super::discover::PROJECTS_DIR;
use super::live::{SessionState, now_ms};
use super::transcript::parse_iso_ms;
use crate::graph::{self, Edge, EdgeKind, NodeType};
use crate::pty::{self, TermKind};
use crate::settings::AppState;

/// The event that carries the whole map on every change.
pub const EVENT: &str = "edges://live";

/// How long a session may stay not idle before the edge fails.
pub const BUSY_TIMEOUT: Duration = Duration::from_secs(60);
/// How long after the injection the transcript has to confirm it.
pub const CONFIRM_TIMEOUT: Duration = Duration::from_secs(10);
/// How often a job looks at the session and the transcript.
pub const TICK: Duration = Duration::from_millis(250);

/// Pending: the session is not idle yet.
pub const WAITING_FOR_IDLE: &str = "waiting for idle";
/// Pending: the operator has typed into the session's prompt; nothing is injected over it.
pub const TYPING: &str = "you're typing — Retry when done";
/// Pending: the line was written; the transcript has not answered yet.
pub const CONFIRMING: &str = "sent /add-dir, waiting for confirmation";
/// Failed: the session stayed busy for [`BUSY_TIMEOUT`].
pub const STAYED_BUSY: &str = "session stayed busy";
/// Failed: no answer in the transcript within [`CONFIRM_TIMEOUT`] (a choice dialog included).
pub const NOT_CONFIRMED: &str = "not confirmed";
/// Failed: the folder's path holds a control character or a newline; nothing was written.
pub const UNSAFE_PATH: &str = "path has control characters";
/// Applied: the target is the folder the session runs in.
pub const OWN_FOLDER: &str = "the session's own folder";
/// Applied: the session was stopped and resumed with `--add-dir`.
pub const RESTARTED: &str = "restarted with flags";

/// Why Retry is refused: the session is not running in a Switchboard terminal.
pub const NOT_LIVE: &str = "the session is not running in Switchboard";
/// Why Retry or Restart is refused for an edge that is not a context edge from a session.
pub const NOT_SESSION_CONTEXT: &str = "only a context edge from a session applies to a running session";
/// Why Retry or Restart is refused for an edge that is gone.
pub const UNKNOWN_EDGE: &str = "unknown edge";

/// The longest detail stored (a stdout line quoted back), in characters.
pub const MAX_DETAIL_CHARS: usize = 200;

/// An edge's live state.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum EdgeState {
    Pending,
    Applied,
    Failed,
}

/// One edge's entry in the map `edges://live` carries.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EdgeLive {
    pub state: EdgeState,
    /// Why, or what it waits for (`waiting for idle`, `no worktree`, Claude's stdout, ...).
    pub detail: Option<String>,
    /// The session the edge runs from.
    pub session_id: String,
    /// The folder the edge grants, once resolved.
    pub path: Option<String>,
}

/// The waits a job uses; tests shorten them.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Timeouts {
    pub busy: Duration,
    pub confirm: Duration,
    pub tick: Duration,
}

impl Default for Timeouts {
    fn default() -> Self {
        Self {
            busy: BUSY_TIMEOUT,
            confirm: CONFIRM_TIMEOUT,
            tick: TICK,
        }
    }
}

#[derive(Debug, Default)]
struct Inner {
    entries: BTreeMap<String, EdgeLive>,
    /// Edge id → the generation of its current job.
    jobs: HashMap<String, u64>,
    next_job: u64,
    /// Sessions a job is injecting into and confirming right now.
    injecting: HashSet<String>,
}

/// The live edge state (in `AppState`). Memory only.
#[derive(Debug, Default)]
pub struct LiveEdges {
    inner: Mutex<Inner>,
    /// Sessions whose prompt holds text the operator typed and has not sent.
    drafts: Mutex<HashSet<String>>,
    /// Sessions a Restart with flags is running for.
    restarting: Mutex<HashSet<String>>,
    pub timeouts: Mutex<Timeouts>,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|e| e.into_inner())
}

impl LiveEdges {
    /// The whole map, as `edges://live` carries it.
    pub fn snapshot(&self) -> BTreeMap<String, EdgeLive> {
        lock(&self.inner).entries.clone()
    }

    /// Whether session `id` has a draft in its prompt.
    pub fn has_draft(&self, id: &str) -> bool {
        lock(&self.drafts).contains(id)
    }

    fn timeouts(&self) -> Timeouts {
        *lock(&self.timeouts)
    }
}

/// What the operator's input `data` does to a draft in the prompt: `Some(true)` leaves text
/// there (a printable key, a paste, Up/Down recalling history), `Some(false)` sends or clears
/// it (Enter, Ctrl+C, Ctrl+U), `None` neither (focus reports, cursor-position replies,
/// Backspace, other keys). The last such key in `data` decides.
/// A bracketed paste (`ESC[200~ … ESC[201~`) always leaves text, even one ending in a newline.
pub fn draft_effect(data: &str) -> Option<bool> {
    const PASTE_START: &str = "\x1b[200~";
    const PASTE_END: &str = "\x1b[201~";
    let mut effect = None;
    let mut rest = data;
    while let Some(at) = rest.find(PASTE_START) {
        // Whatever was typed before it, the paste leaves text.
        effect = Some(true);
        let pasted = &rest[at + PASTE_START.len()..];
        rest = pasted.find(PASTE_END).map_or("", |end| &pasted[end + PASTE_END.len()..]);
    }
    keys_effect(rest).or(effect)
}

/// [`draft_effect`] of typed keys (no paste).
fn keys_effect(data: &str) -> Option<bool> {
    let mut effect = None;
    for recall in ["\x1b[A", "\x1b[B", "\x1bOA", "\x1bOB"] {
        if data.contains(recall) {
            effect = Some(true);
        }
    }
    for c in strip_ansi(data).chars() {
        match c {
            '\r' | '\n' | '\x03' | '\x15' => effect = Some(false),
            c if !c.is_control() => effect = Some(true),
            _ => {}
        }
    }
    effect
}

/// The operator wrote `data` to session `id`'s terminal (`term_write`): its draft mark follows.
/// Keys pressed while the session is `waiting` answer a dialog and do not count.
pub fn note_input(state: &AppState, id: &str, data: &str) {
    if state.read_sessions_live().sessions.get(id).is_some_and(|s| s.state == SessionState::Waiting) {
        return;
    }
    match draft_effect(data) {
        Some(true) => {
            lock(&state.live_edges.drafts).insert(id.to_string());
        }
        Some(false) => {
            lock(&state.live_edges.drafts).remove(id);
        }
        None => {}
    }
}

/// `text` without terminal escape sequences (CSI, OSC, and two-byte escapes; a lone trailing
/// ESC too).
pub fn strip_ansi(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if c != '\x1b' {
            out.push(c);
            continue;
        }
        match chars.next() {
            Some('[') => {
                // Parameters and intermediates, then one final byte in @..~.
                for c in chars.by_ref() {
                    if ('\x40'..='\x7e').contains(&c) {
                        break;
                    }
                }
            }
            Some(']') => {
                // Up to BEL or ESC \.
                while let Some(c) = chars.next() {
                    if c == '\x07' {
                        break;
                    }
                    if c == '\x1b' {
                        chars.next_if_eq(&'\\');
                        break;
                    }
                }
            }
            Some('O') => {
                chars.next();
            }
            _ => {}
        }
    }
    out
}

/// The line injected for `path`: `/add-dir <path>` and Enter. `None` for a path with a control
/// character or a newline (never written).
pub fn add_dir_line(path: &str) -> Option<String> {
    (!path.is_empty() && !path.chars().any(char::is_control)).then(|| format!("/add-dir {path}\r"))
}

/// What a `<local-command-stdout>` text says about the injection: `Added …` or `… already
/// accessible …` applied it; anything else failed it, with that text.
/// Stderr output (`stderr`) always fails it.
pub fn classify(stdout: &str, stderr: bool) -> (EdgeState, Option<String>) {
    let text = strip_ansi(stdout).trim().to_string();
    if !stderr && (text.starts_with("Added ") || text.contains("already accessible")) {
        (EdgeState::Applied, None)
    } else {
        (EdgeState::Failed, Some(cut(&text)))
    }
}

fn cut(text: &str) -> String {
    let flat: String = text.chars().map(|c| if c.is_control() { ' ' } else { c }).collect();
    let mut out: String = flat.trim().chars().take(MAX_DETAIL_CHARS).collect();
    if flat.trim().chars().count() > MAX_DETAIL_CHARS {
        out.push('…');
    }
    out
}

/// The local-command output a transcript line carries, when it is one recorded at or after
/// `since_ms` (a record with no timestamp counts): the text inside `<local-command-stdout>`
/// (or `<local-command-stderr>`, a failure) of the record's content.
/// The second value says whether it was stderr.
pub fn local_command_output(line: &str, since_ms: i64) -> Option<(String, bool)> {
    let record: serde_json::Value = serde_json::from_str(line).ok()?;
    if let Some(at) = record.get("timestamp").and_then(|t| t.as_str()).and_then(parse_iso_ms)
        && at < since_ms
    {
        return None;
    }
    let mut texts = texts_of(record.get("message").and_then(|m| m.get("content")));
    texts.extend(texts_of(record.get("content")));
    texts.into_iter().find_map(|text| {
        ["local-command-stdout", "local-command-stderr"].iter().find_map(|tag| {
            let open = format!("<{tag}>");
            let start = text.find(&open)? + open.len();
            let rest = &text[start..];
            let end = rest.find(&format!("</{tag}>")).unwrap_or(rest.len());
            Some((rest[..end].to_string(), *tag == "local-command-stderr"))
        })
    })
}

/// The texts of a record's `content`: the string itself, or each part's `text`.
fn texts_of(content: Option<&serde_json::Value>) -> Vec<&str> {
    match content {
        Some(serde_json::Value::String(text)) => vec![text.as_str()],
        Some(serde_json::Value::Array(items)) => items.iter().filter_map(|item| item.get("text").and_then(|t| t.as_str())).collect(),
        _ => Vec::new(),
    }
}

/// Session `id`'s transcript under `home`: `<home>/projects/<dir>/<id>.jsonl` in whichever
/// project dir holds it (read-only).
pub fn find_transcript(home: &Path, id: &str) -> Option<PathBuf> {
    let file = format!("{id}.jsonl");
    fs::read_dir(home.join(PROJECTS_DIR))
        .ok()?
        .filter_map(Result::ok)
        .map(|entry| entry.path().join(&file))
        .find(|path| path.is_file())
}

/// A read-only tail of a session's transcript from where it ended at the injection.
#[derive(Debug, Clone)]
pub struct Tail {
    path: Option<PathBuf>,
    offset: u64,
}

impl Tail {
    /// The transcript as it stands now (its end is where reading starts), or none yet.
    pub fn at_end(home: Option<&Path>, id: &str) -> Self {
        let path = home.and_then(|home| find_transcript(home, id));
        let offset = path.as_ref().and_then(|p| fs::metadata(p).ok()).map_or(0, |m| m.len());
        Self { path, offset }
    }

    /// The first local-command output in the complete lines added since the last read; a
    /// transcript that appears only now is read from its start.
    pub fn next_output(&mut self, home: Option<&Path>, id: &str, since_ms: i64) -> Option<(String, bool)> {
        if self.path.is_none() {
            self.path = home.and_then(|home| find_transcript(home, id));
            self.offset = 0;
        }
        let path = self.path.as_ref()?;
        let mut file = fs::File::open(path).ok()?;
        let len = file.metadata().ok()?.len();
        if len < self.offset {
            self.offset = 0;
        }
        file.seek(SeekFrom::Start(self.offset)).ok()?;
        let mut bytes = Vec::new();
        file.take(len - self.offset).read_to_end(&mut bytes).ok()?;
        let complete = bytes.iter().rposition(|b| *b == b'\n').map_or(0, |i| i + 1);
        self.offset += complete as u64;
        String::from_utf8_lossy(&bytes[..complete]).lines().find_map(|line| local_command_output(line, since_ms))
    }
}

// --- the map and its event -----------------------------------------------------------------

fn emit<R: Runtime>(app: &AppHandle<R>, entries: &BTreeMap<String, EdgeLive>) {
    if let Err(err) = app.emit(EVENT, entries) {
        eprintln!("live edges: emit failed: {err}");
    }
}

/// Change the map under its lock and emit it when it changed. With `job`, only while that job is
/// still the edge's current one; returns whether the change was made.
fn change<R: Runtime>(app: &AppHandle<R>, edge_id: &str, job: Option<u64>, entry: Option<EdgeLive>) -> bool {
    let state = app.state::<AppState>();
    let mut inner = lock(&state.live_edges.inner);
    if let Some(job) = job
        && inner.jobs.get(edge_id) != Some(&job)
    {
        return false;
    }
    let before = inner.entries.get(edge_id).cloned();
    if before == entry {
        return true;
    }
    match entry {
        Some(entry) => inner.entries.insert(edge_id.to_string(), entry),
        None => inner.entries.remove(edge_id),
    };
    // Under the lock, so the events go out in the order the changes were made.
    emit(app, &inner.entries);
    true
}

/// Set edge `edge_id`'s entry from outside a job (Restart with flags), retiring its job.
pub fn mark<R: Runtime>(app: &AppHandle<R>, edge_id: &str, session_id: &str, state: EdgeState, detail: Option<&str>, path: Option<String>) {
    lock(&app.state::<AppState>().live_edges.inner).jobs.remove(edge_id);
    change(
        app,
        edge_id,
        None,
        Some(EdgeLive {
            state,
            detail: detail.map(str::to_string),
            session_id: session_id.to_string(),
            path,
        }),
    );
}

/// Edge `edge_id` was removed: its job ends and its entry goes. Nothing is taken back from the
/// session (Claude has no `/remove-dir`).
pub fn forget_edge<R: Runtime>(app: &AppHandle<R>, edge_id: &str) {
    lock(&app.state::<AppState>().live_edges.inner).jobs.remove(edge_id);
    change(app, edge_id, None, None);
}

/// Session `id` exited: every entry of its edges goes and their jobs end (an edge still pending
/// applies at the next resume, Story 6.2).
pub fn session_exited<R: Runtime>(app: &AppHandle<R>, id: &str) {
    let state = app.state::<AppState>();
    let mut inner = lock(&state.live_edges.inner);
    let ids: Vec<String> = inner.entries.iter().filter(|(_, e)| e.session_id == id).map(|(k, _)| k.clone()).collect();
    for edge_id in &ids {
        inner.jobs.remove(edge_id);
        inner.entries.remove(edge_id);
    }
    lock(&state.live_edges.drafts).remove(id);
    if !ids.is_empty() {
        emit(app, &inner.entries);
    }
}

/// Retire the jobs of session `id`'s edges, keeping their entries (Restart with flags stops the
/// session itself).
pub fn cancel_session<R: Runtime>(app: &AppHandle<R>, id: &str) {
    let state = app.state::<AppState>();
    // Jobs of the session's stored edges too, not only those with an entry yet.
    let mut ids = session_edges(&state, id).into_iter().map(|e| e.id).collect::<Vec<_>>();
    let mut inner = lock(&state.live_edges.inner);
    ids.extend(inner.entries.iter().filter(|(_, e)| e.session_id == id).map(|(k, _)| k.clone()));
    for edge_id in ids {
        inner.jobs.remove(&edge_id);
    }
}

/// The stored context edges from session `id`.
pub fn session_edges(state: &AppState, id: &str) -> Vec<Edge> {
    state
        .read_workspace()
        .workspace
        .edges
        .iter()
        .filter(|e| is_session_context(e) && e.from.id == id)
        .cloned()
        .collect()
}

/// Mark every entry of session `id`, and edge `edge_id`, `failed` with `detail` (a Restart with
/// flags that did not finish), retiring their jobs.
pub fn fail_session<R: Runtime>(app: &AppHandle<R>, id: &str, edge_id: &str, detail: &str) {
    let state = app.state::<AppState>();
    let mut inner = lock(&state.live_edges.inner);
    let mut ids: Vec<String> = inner.entries.iter().filter(|(_, e)| e.session_id == id).map(|(k, _)| k.clone()).collect();
    if !ids.iter().any(|k| k == edge_id) {
        ids.push(edge_id.to_string());
    }
    for key in ids {
        inner.jobs.remove(&key);
        let path = inner.entries.get(&key).and_then(|e| e.path.clone());
        inner.entries.insert(
            key,
            EdgeLive {
                state: EdgeState::Failed,
                detail: Some(detail.to_string()),
                session_id: id.to_string(),
                path,
            },
        );
    }
    emit(app, &inner.entries);
}

/// Why a second Restart with flags of one session is refused while the first runs.
pub const ALREADY_RESTARTING: &str = "that session is already restarting";

/// Held while a Restart with flags of a session runs; released when dropped.
pub struct Restarting<'a> {
    state: &'a AppState,
    session: String,
}

impl Drop for Restarting<'_> {
    fn drop(&mut self) {
        lock(&self.state.live_edges.restarting).remove(&self.session);
    }
}

/// Claim session `id` for a Restart with flags, or [`ALREADY_RESTARTING`].
pub fn begin_restart<'a>(state: &'a AppState, id: &str) -> Result<Restarting<'a>, String> {
    if !lock(&state.live_edges.restarting).insert(id.to_string()) {
        return Err(ALREADY_RESTARTING.to_string());
    }
    Ok(Restarting {
        state,
        session: id.to_string(),
    })
}

/// Drop the entries of edges no longer stored (a project removed with its edges).
pub fn prune<R: Runtime>(app: &AppHandle<R>) {
    let state = app.state::<AppState>();
    let stored: HashSet<String> = state.read_workspace().workspace.edges.iter().map(|e| e.id.clone()).collect();
    let mut inner = lock(&state.live_edges.inner);
    let before = inner.entries.len();
    inner.entries.retain(|id, _| stored.contains(id));
    inner.jobs.retain(|id, _| stored.contains(id));
    if inner.entries.len() != before {
        emit(app, &inner.entries);
    }
}

// --- the edge and its session --------------------------------------------------------------

/// Whether `edge` is a context edge from a session (the only kind applied to a live session).
pub fn is_session_context(edge: &Edge) -> bool {
    edge.kind == EdgeKind::Context && edge.from.kind == NodeType::Session
}

/// The stored edge `edge_id`.
pub fn stored_edge(state: &AppState, edge_id: &str) -> Option<Edge> {
    state.read_workspace().workspace.edges.iter().find(|e| e.id == edge_id).cloned()
}

/// Session `id` as a running Switchboard session: its live state and folder, while its session
/// terminal runs and the live map holds it in a live state; `None` otherwise. A terminal being
/// stopped reads as busy (never injected into).
pub fn running_session(state: &AppState, id: &str) -> Option<(SessionState, String)> {
    let term = state.terms.get(&pty::session_id(id)).filter(|t| t.kind == TermKind::Session && t.is_running())?;
    let stopping = term.info().stopping;
    let map = state.read_sessions_live();
    let session = map.sessions.get(id).filter(|s| s.state.is_live())?;
    let live = if stopping { SessionState::Busy } else { session.state.clone() };
    Some((live, session.cwd.clone()))
}

/// Idle as Stop reads it: `idle` or `finished`.
pub fn is_idle(state: &SessionState) -> bool {
    matches!(state, SessionState::Idle | SessionState::Finished)
}

/// The folder `edge` grants a session running in `cwd`, through the Story 6.2 resolver for that
/// one edge: `Ok(Some(path))`, `Ok(None)` for the session's own folder, or `Err(reason)` (`no
/// worktree`, `folder missing`, `not found`). The target is read under the workspace lock, the
/// folder checked after it is released.
pub fn resolve(state: &AppState, edge: &Edge, cwd: &str) -> Result<Option<String>, String> {
    let heads = graph::checked_out_heads(state);
    let target = graph::context_target(&state.read_workspace(), &edge.to, &heads);
    let (dirs, skipped) = graph::resolve_context_targets(vec![target], cwd);
    match (dirs.into_iter().next(), skipped.into_iter().next()) {
        (Some(dir), _) => Ok(Some(dir.path)),
        (None, Some(skip)) => Err(skip.reason),
        (None, None) => Ok(None),
    }
}

// --- jobs ------------------------------------------------------------------------------------

/// A context edge was added (`edge_add`): from a session running in Switchboard, it is applied
/// now. Any other edge has no live state.
pub fn edge_added<R: Runtime>(app: &AppHandle<R>, edge: &Edge) {
    let state = app.state::<AppState>();
    if is_session_context(edge) && running_session(&state, &edge.from.id).is_some() {
        start(app, &edge.id);
    }
}

/// Retry (`edge_live_retry`): the operator says the prompt is clear (the draft mark goes) and
/// the injection runs again.
pub fn retry<R: Runtime>(app: &AppHandle<R>, edge_id: &str) -> Result<(), String> {
    let state = app.state::<AppState>();
    let edge = stored_edge(&state, edge_id).ok_or_else(|| UNKNOWN_EDGE.to_string())?;
    if !is_session_context(&edge) {
        return Err(NOT_SESSION_CONTEXT.to_string());
    }
    if running_session(&state, &edge.from.id).is_none() {
        return Err(NOT_LIVE.to_string());
    }
    lock(&state.live_edges.drafts).remove(&edge.from.id);
    start(app, edge_id);
    Ok(())
}

/// Start a new job for `edge_id` (retiring any earlier one) on a thread of its own.
fn start<R: Runtime>(app: &AppHandle<R>, edge_id: &str) {
    let state = app.state::<AppState>();
    let job = {
        let mut inner = lock(&state.live_edges.inner);
        inner.next_job += 1;
        let job = inner.next_job;
        inner.jobs.insert(edge_id.to_string(), job);
        job
    };
    let (app, edge_id) = (app.clone(), edge_id.to_string());
    std::thread::spawn(move || run(&app, &edge_id, job));
}

/// Releases a session's injection slot when the job ends.
struct Injecting<'a> {
    state: &'a AppState,
    session: String,
}

impl Drop for Injecting<'_> {
    fn drop(&mut self) {
        lock(&self.state.live_edges.inner).injecting.remove(&self.session);
    }
}

/// What a tick of the wait saw.
enum Wait {
    Gone,
    NotYet,
    Ready,
}

fn run<R: Runtime>(app: &AppHandle<R>, edge_id: &str, job: u64) {
    let state = app.state::<AppState>();
    let timeouts = state.live_edges.timeouts();
    let entry = |live: EdgeState, detail: Option<&str>, session: &str, path: Option<&str>| EdgeLive {
        state: live,
        detail: detail.map(str::to_string),
        session_id: session.to_string(),
        path: path.map(str::to_string),
    };
    let current = || lock(&state.live_edges.inner).jobs.get(edge_id) == Some(&job);
    let drop_entry = || {
        change(app, edge_id, Some(job), None);
    };
    let Some(edge) = stored_edge(&state, edge_id).filter(is_session_context) else {
        drop_entry();
        return;
    };
    let session = edge.from.id.clone();
    let Some((_, cwd)) = running_session(&state, &session) else {
        drop_entry();
        return;
    };
    let path = match resolve(&state, &edge, &cwd) {
        Ok(Some(path)) => path,
        Ok(None) => {
            change(app, edge_id, Some(job), Some(entry(EdgeState::Applied, Some(OWN_FOLDER), &session, Some(&cwd))));
            return;
        }
        Err(reason) => {
            change(app, edge_id, Some(job), Some(entry(EdgeState::Failed, Some(&reason), &session, None)));
            return;
        }
    };
    let Some(line) = add_dir_line(&path) else {
        change(app, edge_id, Some(job), Some(entry(EdgeState::Failed, Some(UNSAFE_PATH), &session, Some(&path))));
        return;
    };

    // Wait for idle (and for any other edge of this session to finish its injection).
    let waited = Instant::now();
    let _slot = loop {
        if !current() {
            return;
        }
        let seen = if stored_edge(&state, edge_id).is_none() {
            Wait::Gone
        } else {
            match running_session(&state, &session) {
                None => Wait::Gone,
                Some((live, _)) if is_idle(&live) => Wait::Ready,
                Some(_) => Wait::NotYet,
            }
        };
        match seen {
            Wait::Gone => {
                drop_entry();
                return;
            }
            Wait::Ready => {
                if state.live_edges.has_draft(&session) {
                    change(app, edge_id, Some(job), Some(entry(EdgeState::Pending, Some(TYPING), &session, Some(&path))));
                    return;
                }
                let mut inner = lock(&state.live_edges.inner);
                if inner.injecting.insert(session.clone()) {
                    drop(inner);
                    break Injecting {
                        state: &state,
                        session: session.clone(),
                    };
                }
            }
            Wait::NotYet => {}
        }
        if waited.elapsed() > timeouts.busy {
            change(app, edge_id, Some(job), Some(entry(EdgeState::Failed, Some(STAYED_BUSY), &session, Some(&path))));
            return;
        }
        change(app, edge_id, Some(job), Some(entry(EdgeState::Pending, Some(WAITING_FOR_IDLE), &session, Some(&path))));
        std::thread::sleep(timeouts.tick);
    };

    // Inject: the transcript's end first, so only what follows the line is read.
    let home = state.claude_home.get().cloned();
    let mut tail = Tail::at_end(home.as_deref(), &session);
    // A clock a little off between the record and here is not a missed confirmation.
    let since = now_ms() - 2_000;
    if !change(app, edge_id, Some(job), Some(entry(EdgeState::Pending, Some(CONFIRMING), &session, Some(&path)))) {
        return;
    }
    if let Err(err) = state.terms.write(&pty::session_id(&session), line.as_bytes()) {
        change(app, edge_id, Some(job), Some(entry(EdgeState::Failed, Some(&err), &session, Some(&path))));
        return;
    }
    let sent = Instant::now();
    loop {
        std::thread::sleep(timeouts.tick);
        if !current() {
            return;
        }
        if stored_edge(&state, edge_id).is_none() || running_session(&state, &session).is_none() {
            drop_entry();
            return;
        }
        if let Some((output, stderr)) = tail.next_output(home.as_deref(), &session, since) {
            let (result, detail) = classify(&output, stderr);
            change(app, edge_id, Some(job), Some(entry(result, detail.as_deref(), &session, Some(&path))));
            return;
        }
        if sent.elapsed() > timeouts.confirm {
            change(app, edge_id, Some(job), Some(entry(EdgeState::Failed, Some(NOT_CONFIRMED), &session, Some(&path))));
            return;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn drafts_follow_typing_sending_and_clearing() {
        assert_eq!(draft_effect("a"), Some(true));
        assert_eq!(draft_effect("abc\r"), Some(false));
        assert_eq!(draft_effect("\r"), Some(false));
        assert_eq!(draft_effect("\x03"), Some(false));
        assert_eq!(draft_effect("\x15"), Some(false));
        assert_eq!(draft_effect("one\rtwo"), Some(true), "a paste that leaves a line behind");
        // Focus reports and a cursor-position reply are not typing; Backspace changes nothing.
        assert_eq!(draft_effect("\x1b[I"), None);
        assert_eq!(draft_effect("\x1b[O"), None);
        assert_eq!(draft_effect("\x1b[12;1R"), None);
        assert_eq!(draft_effect("\x7f"), None);
        // History recall and a bracketed paste leave text.
        assert_eq!(draft_effect("\x1b[A"), Some(true));
        assert_eq!(draft_effect("\x1bOB"), Some(true));
        assert_eq!(draft_effect("\x1b[200~pasted\x1b[201~"), Some(true));
        // A paste ending in a newline still leaves text; Enter after it sends it.
        assert_eq!(draft_effect("\x1b[200~line one\r\x1b[201~"), Some(true));
        assert_eq!(draft_effect("\x1b[200~x\x1b[201~\r"), Some(false));
        assert_eq!(draft_effect("\x1b[200~unterminated\r"), Some(true));
    }

    #[test]
    fn the_line_is_one_add_dir_and_enter_and_never_a_control_character() {
        assert_eq!(add_dir_line("/work/ui").as_deref(), Some("/add-dir /work/ui\r"));
        assert_eq!(add_dir_line("C:\\work\\my ui").as_deref(), Some("/add-dir C:\\work\\my ui\r"));
        assert_eq!(add_dir_line("/work/ui\n/exit"), None);
        assert_eq!(add_dir_line("/work/ui\r"), None);
        assert_eq!(add_dir_line("/work/\x1b[2Jui"), None);
        assert_eq!(add_dir_line(""), None);
    }

    #[test]
    fn stdout_is_classified_and_ansi_stripped() {
        assert_eq!(classify("Added /work/ui as a working directory for this session", false), (EdgeState::Applied, None));
        assert_eq!(classify("\x1b[1mAdded\x1b[22m /work/ui as a working directory", false), (EdgeState::Applied, None));
        assert_eq!(classify("/work/ui is already accessible within the existing working directory /work.", false), (EdgeState::Applied, None));
        assert_eq!(
            classify("\x1b[31mPath /nope was not found.\x1b[39m", false),
            (EdgeState::Failed, Some("Path /nope was not found.".to_string()))
        );
        // stderr always fails, whatever it says.
        assert_eq!(
            classify("/work/ui is already accessible", true),
            (EdgeState::Failed, Some("/work/ui is already accessible".to_string()))
        );
        let long = "x".repeat(300);
        let (_, detail) = classify(&long, false);
        assert_eq!(detail.unwrap().chars().count(), MAX_DETAIL_CHARS + 1);
    }

    #[test]
    fn local_command_output_is_read_from_user_and_system_records_newer_than_the_injection() {
        let user = |text: &str, at: &str| {
            serde_json::json!({ "type": "user", "timestamp": at, "message": { "role": "user", "content": text } }).to_string()
        };
        let since = parse_iso_ms("2026-10-22T10:00:00.000Z").unwrap();
        assert_eq!(
            local_command_output(&user("<local-command-stdout>Added /a as a working directory</local-command-stdout>", "2026-10-22T10:00:01.000Z"), since)
                .map(|(t, _)| t)
            .as_deref(),
            Some("Added /a as a working directory")
        );
        // Older than the injection: someone else's.
        assert_eq!(local_command_output(&user("<local-command-stdout>Added /a</local-command-stdout>", "2026-10-22T09:59:00.000Z"), since), None);
        assert_eq!(local_command_output(&user("<command-name>/add-dir</command-name>", "2026-10-22T10:00:01.000Z"), since), None);
        let system = serde_json::json!({ "type": "system", "subtype": "local_command", "content": "<local-command-stderr>bad</local-command-stderr>" }).to_string();
        assert_eq!(local_command_output(&system, since), Some(("bad".to_string(), true)));
        let parts = serde_json::json!({ "type": "user", "message": { "content": [{ "type": "text", "text": "<local-command-stdout>ok</local-command-stdout>" }] } }).to_string();
        assert_eq!(local_command_output(&parts, since), Some(("ok".to_string(), false)));
        assert_eq!(local_command_output("not json", since), None);
    }

    #[test]
    fn a_tail_reads_only_complete_lines_written_after_it_started() {
        let home = tempfile::tempdir().unwrap();
        let dir = home.path().join("projects").join("X--work");
        fs::create_dir_all(&dir).unwrap();
        let id = "s1";
        let file = dir.join(format!("{id}.jsonl"));
        let record = |text: &str| {
            format!(
                "{}\n",
                serde_json::json!({ "type": "user", "message": { "content": format!("<local-command-stdout>{text}</local-command-stdout>") } })
            )
        };
        fs::write(&file, record("old")).unwrap();
        let mut tail = Tail::at_end(Some(home.path()), id);
        assert_eq!(tail.next_output(Some(home.path()), id, 0), None);
        let mut f = fs::OpenOptions::new().append(true).open(&file).unwrap();
        use std::io::Write;
        let line = record("Added /x");
        f.write_all(&line.as_bytes()[..10]).unwrap();
        assert_eq!(tail.next_output(Some(home.path()), id, 0), None, "a half-written line waits");
        f.write_all(&line.as_bytes()[10..]).unwrap();
        assert_eq!(tail.next_output(Some(home.path()), id, 0), Some(("Added /x".to_string(), false)));

        // A transcript that appears only after the injection is read from its start.
        let mut late = Tail::at_end(Some(home.path()), "s2");
        assert_eq!(late.next_output(Some(home.path()), "s2", 0), None);
        fs::write(dir.join("s2.jsonl"), record("Added /y")).unwrap();
        assert_eq!(late.next_output(Some(home.path()), "s2", 0), Some(("Added /y".to_string(), false)));
        assert_eq!(find_transcript(home.path(), "nope"), None);
        assert_eq!(Tail::at_end(None, id).next_output(None, id, 0), None);
    }

    #[test]
    fn strip_ansi_drops_csi_osc_and_ss3() {
        assert_eq!(strip_ansi("a\x1b[31mb\x1b[0mc"), "abc");
        assert_eq!(strip_ansi("\x1b]0;title\x07x\x1b]8;;u\x1b\\y"), "xy");
        assert_eq!(strip_ansi("\x1bOAz\x1b"), "z");
    }
}
