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
//!
//! Cooperate edges (Story 6.4) use the same one-line injection, per side: when a cooperate edge
//! is added, each end that runs in a Switchboard terminal is sent `A new peer session "<name>"
//! is linked to you (<purpose>). Use SendMessage or switchboard.inbox to coordinate.` + Enter
//! (Story 7.3's wording), under the same idle wait, draft rule and per-session slot. The line is a user prompt, so the side is `notified`
//! once the session goes busy within [`NOTIFY_TIMEOUT`] of the write, else `failed (not
//! confirmed)`. A side's entry is keyed `<edgeId>#<sessionId>` ([`side_key`]); a context edge's
//! entry stays keyed by its edge id.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, Runtime};

use super::discover::PROJECTS_DIR;
use super::launch::peer_value;
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
/// How long after the peer line a cooperate side has to go busy (Story 6.4).
pub const NOTIFY_TIMEOUT: Duration = Duration::from_secs(3);

/// Pending: the session is not idle yet.
pub const WAITING_FOR_IDLE: &str = "waiting for idle";
/// Pending: the operator has typed into the session's prompt; nothing is injected over it.
pub const TYPING: &str = "you're typing — Retry when done";
/// Pending: the line was written; the transcript has not answered yet.
pub const CONFIRMING: &str = "sent /add-dir, waiting for confirmation";
/// Pending (a cooperate side): the peer line was written; the session has not gone busy yet.
pub const SENT_PEER_LINE: &str = "sent, waiting for the session to take it";
/// Failed: the session stayed busy for [`BUSY_TIMEOUT`].
pub const STAYED_BUSY: &str = "session stayed busy";
/// Failed: no answer in the transcript within [`CONFIRM_TIMEOUT`] (a choice dialog included), or
/// a cooperate side that did not go busy within [`NOTIFY_TIMEOUT`].
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
/// Why Retry of a cooperate edge is refused without one of its sessions named.
pub const NOT_A_SIDE: &str = "name one of the edge's sessions to retry";
/// Why Retry of a cooperate side is refused while its line may already be on its way.
pub const SIDE_NOT_RETRYABLE: &str = "that side has not failed and no draft holds it back";
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
    /// A cooperate side whose session took the peer line (Story 6.4).
    Notified,
    Failed,
}

/// One entry in the map `edges://live` carries: a context edge's (keyed by its id) or one side
/// of a cooperate edge (keyed by [`side_key`]).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EdgeLive {
    pub state: EdgeState,
    /// Why, or what it waits for (`waiting for idle`, `no worktree`, Claude's stdout, ...).
    pub detail: Option<String>,
    /// The edge the entry belongs to.
    pub edge_id: String,
    /// The session the edge runs from (a cooperate side: the session of that side).
    pub session_id: String,
    /// The folder the edge grants, once resolved.
    pub path: Option<String>,
}

/// The waits a job uses; tests shorten them.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Timeouts {
    pub busy: Duration,
    pub confirm: Duration,
    pub notify: Duration,
    pub tick: Duration,
}

impl Default for Timeouts {
    fn default() -> Self {
        Self {
            busy: BUSY_TIMEOUT,
            confirm: CONFIRM_TIMEOUT,
            notify: NOTIFY_TIMEOUT,
            tick: TICK,
        }
    }
}

#[derive(Debug, Default)]
struct Inner {
    entries: BTreeMap<String, EdgeLive>,
    /// Entry key (edge id, or [`side_key`]) → the generation of its current job.
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

/// The key of one side of a cooperate edge (Story 6.4): `<edgeId>#<sessionId>`.
pub fn side_key(edge_id: &str, session_id: &str) -> String {
    format!("{edge_id}#{session_id}")
}

/// The edge an entry key belongs to (the key itself for a context edge).
fn key_edge(key: &str) -> &str {
    key.split_once('#').map_or(key, |(edge, _)| edge)
}

/// Change the map under its lock and emit it when it changed. With `job`, only while that job is
/// still the key's current one; returns whether the change was made.
fn change<R: Runtime>(app: &AppHandle<R>, key: &str, job: Option<u64>, entry: Option<EdgeLive>) -> bool {
    let state = app.state::<AppState>();
    let mut inner = lock(&state.live_edges.inner);
    if let Some(job) = job
        && inner.jobs.get(key) != Some(&job)
    {
        return false;
    }
    let before = inner.entries.get(key).cloned();
    if before == entry {
        return true;
    }
    match entry {
        Some(entry) => inner.entries.insert(key.to_string(), entry),
        None => inner.entries.remove(key),
    };
    // Under the lock, so the events go out in the order the changes were made.
    emit(app, &inner.entries);
    true
}

/// Set context edge `edge_id`'s entry from outside a job (Restart with flags), retiring its job.
pub fn mark<R: Runtime>(app: &AppHandle<R>, edge_id: &str, session_id: &str, state: EdgeState, detail: Option<&str>, path: Option<String>) {
    lock(&app.state::<AppState>().live_edges.inner).jobs.remove(edge_id);
    change(
        app,
        edge_id,
        None,
        Some(EdgeLive {
            state,
            detail: detail.map(str::to_string),
            edge_id: edge_id.to_string(),
            session_id: session_id.to_string(),
            path,
        }),
    );
}

/// Edge `edge_id` was removed: its jobs end and its entries (both sides of a cooperate edge) go.
/// Nothing is taken back from the session (Claude has no `/remove-dir`).
pub fn forget_edge<R: Runtime>(app: &AppHandle<R>, edge_id: &str) {
    let state = app.state::<AppState>();
    let mut inner = lock(&state.live_edges.inner);
    inner.jobs.retain(|key, _| key_edge(key) != edge_id);
    let before = inner.entries.len();
    inner.entries.retain(|_, e| e.edge_id != edge_id);
    if inner.entries.len() != before {
        emit(app, &inner.entries);
    }
}

/// Session `id` exited: every entry of its edges (and of its cooperate sides) goes and their
/// jobs end (an edge still pending applies at the next resume, Story 6.2; a peer is in the
/// resumed session's prompt, Story 6.4).
pub fn session_exited<R: Runtime>(app: &AppHandle<R>, id: &str) {
    let state = app.state::<AppState>();
    let mut inner = lock(&state.live_edges.inner);
    let keys: Vec<String> = inner.entries.iter().filter(|(_, e)| e.session_id == id).map(|(k, _)| k.clone()).collect();
    for key in &keys {
        inner.jobs.remove(key);
        inner.entries.remove(key);
    }
    lock(&state.live_edges.drafts).remove(id);
    if !keys.is_empty() {
        emit(app, &inner.entries);
    }
}

/// Retire the jobs of session `id`'s edges, keeping their entries (Restart with flags stops the
/// session itself).
pub fn cancel_session<R: Runtime>(app: &AppHandle<R>, id: &str) {
    let state = app.state::<AppState>();
    // Jobs of the session's stored edges too, not only those with an entry yet: its context
    // edges by edge id, its cooperate sides by side key.
    let mut keys = session_edges(&state, id).into_iter().map(|e| e.id).collect::<Vec<_>>();
    keys.extend(
        state
            .read_workspace()
            .workspace
            .edges
            .iter()
            .filter(|e| other_side(e, id).is_some())
            .map(|e| side_key(&e.id, id)),
    );
    let mut inner = lock(&state.live_edges.inner);
    keys.extend(inner.entries.iter().filter(|(_, e)| e.session_id == id).map(|(k, _)| k.clone()));
    for key in keys {
        inner.jobs.remove(&key);
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

/// Mark every context-edge entry of session `id`, and edge `edge_id`, `failed` with `detail` (a
/// Restart with flags that did not finish), retiring their jobs. The session's cooperate sides
/// still pending (their jobs were retired by [`cancel_session`]) are failed with `detail` too, so
/// Retry is offered; notified or failed sides stay as they are.
pub fn fail_session<R: Runtime>(app: &AppHandle<R>, id: &str, edge_id: &str, detail: &str) {
    let state = app.state::<AppState>();
    let mut inner = lock(&state.live_edges.inner);
    let mut ids: Vec<String> = inner
        .entries
        .iter()
        .filter(|(k, e)| e.session_id == id && **k == e.edge_id)
        .map(|(k, _)| k.clone())
        .collect();
    if !ids.iter().any(|k| k == edge_id) {
        ids.push(edge_id.to_string());
    }
    let sides: Vec<String> = inner
        .entries
        .iter()
        .filter(|(k, e)| e.session_id == id && **k != e.edge_id && e.state == EdgeState::Pending)
        .map(|(k, _)| k.clone())
        .collect();
    for key in sides {
        inner.jobs.remove(&key);
        if let Some(entry) = inner.entries.get_mut(&key) {
            entry.state = EdgeState::Failed;
            entry.detail = Some(detail.to_string());
        }
    }
    for key in ids {
        inner.jobs.remove(&key);
        let path = inner.entries.get(&key).and_then(|e| e.path.clone());
        inner.entries.insert(
            key.clone(),
            EdgeLive {
                state: EdgeState::Failed,
                detail: Some(detail.to_string()),
                edge_id: key,
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
    inner.entries.retain(|_, e| stored.contains(&e.edge_id));
    inner.jobs.retain(|key, _| stored.contains(key_edge(key)));
    if inner.entries.len() != before {
        emit(app, &inner.entries);
    }
}

// --- the edge and its session --------------------------------------------------------------

/// Whether `edge` is a context edge from a session (the only kind applied to a live session
/// with `/add-dir`).
pub fn is_session_context(edge: &Edge) -> bool {
    edge.kind == EdgeKind::Context && edge.from.kind == NodeType::Session
}

/// The other end of cooperate edge `edge` from session `session`: `None` when `edge` is not a
/// cooperate edge with `session` at one end.
pub fn other_side<'e>(edge: &'e Edge, session: &str) -> Option<&'e str> {
    if edge.kind != EdgeKind::Cooperate || edge.from.kind != NodeType::Session || edge.to.kind != NodeType::Session {
        return None;
    }
    if edge.from.id == session {
        Some(&edge.to.id)
    } else if edge.to.id == session {
        Some(&edge.from.id)
    } else {
        None
    }
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

/// Whether session `id`'s Switchboard terminal is being stopped (Stop, Restart with flags).
fn is_stopping(state: &AppState, id: &str) -> bool {
    state.terms.get(&pty::session_id(id)).is_some_and(|t| t.info().stopping)
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

/// The one line a cooperate side is sent (Story 6.4): `A new peer session "<name>" is linked to
/// you (<purpose>). Use SendMessage or switchboard.inbox to coordinate.` and Enter (Story 7.3). Both values lose their control
/// characters and are cut as the system prompt cuts them, so the line is always one line.
pub fn peer_line(name: &str, purpose: &str) -> String {
    format!(
        "A new peer session \"{}\" is linked to you ({}). Use SendMessage or switchboard.inbox to coordinate.\r",
        peer_value(name),
        peer_value(purpose)
    )
}

// --- jobs ------------------------------------------------------------------------------------

/// What a job applies: a context edge from a session (`/add-dir`), or one side of a cooperate
/// edge (the peer line).
#[derive(Debug, Clone, PartialEq, Eq)]
enum Target {
    Context { edge_id: String },
    Side { edge_id: String, session: String },
}

impl Target {
    fn key(&self) -> String {
        match self {
            Target::Context { edge_id } => edge_id.clone(),
            Target::Side { edge_id, session } => side_key(edge_id, session),
        }
    }

    fn edge_id(&self) -> &str {
        match self {
            Target::Context { edge_id } | Target::Side { edge_id, .. } => edge_id,
        }
    }
}

/// An edge was added (`edge_add`): a context edge from a session running in Switchboard is
/// applied now; a cooperate edge sends its peer line to each end running in Switchboard (an
/// end that is not live gets nothing: the peer is in its prompt at its next resume). Any other
/// edge has no live state.
pub fn edge_added<R: Runtime>(app: &AppHandle<R>, edge: &Edge) {
    let state = app.state::<AppState>();
    if is_session_context(edge) && running_session(&state, &edge.from.id).is_some() {
        start(app, Target::Context { edge_id: edge.id.clone() });
    }
    if edge.kind == EdgeKind::Cooperate {
        // Story 7.3: two running sessions each find a notice in their inbox too (no nudge).
        crate::inbox::link_notices(app, edge);
        for end in [&edge.from, &edge.to] {
            if end.kind == NodeType::Session && running_session(&state, &end.id).is_some() {
                start(
                    app,
                    Target::Side {
                        edge_id: edge.id.clone(),
                        session: end.id.clone(),
                    },
                );
            }
        }
    }
}

/// Retry (`edge_live_retry`): the operator says the prompt is clear (the draft mark goes) and
/// the injection runs again. A cooperate edge retries the side of `session` (required).
pub fn retry<R: Runtime>(app: &AppHandle<R>, edge_id: &str, session: Option<&str>) -> Result<(), String> {
    let state = app.state::<AppState>();
    let edge = stored_edge(&state, edge_id).ok_or_else(|| UNKNOWN_EDGE.to_string())?;
    let (target, session) = if edge.kind == EdgeKind::Cooperate {
        let session = session.filter(|s| other_side(&edge, s).is_some()).ok_or_else(|| NOT_A_SIDE.to_string())?;
        (
            Target::Side {
                edge_id: edge_id.to_string(),
                session: session.to_string(),
            },
            session.to_string(),
        )
    } else if is_session_context(&edge) {
        (Target::Context { edge_id: edge_id.to_string() }, edge.from.id.clone())
    } else {
        return Err(NOT_SESSION_CONTEXT.to_string());
    };
    if running_session(&state, &session).is_none() {
        return Err(NOT_LIVE.to_string());
    }
    // A side only when it failed or a draft holds it back: a pending line may already be written.
    // (A context edge's Retry is unchanged.)
    if let Target::Side { .. } = &target {
        let retryable = state.live_edges.snapshot().get(&target.key()).is_some_and(|e| {
            e.state == EdgeState::Failed || (e.state == EdgeState::Pending && e.detail.as_deref() == Some(TYPING))
        });
        if !retryable {
            return Err(SIDE_NOT_RETRYABLE.to_string());
        }
    }
    lock(&state.live_edges.drafts).remove(&session);
    start(app, target);
    Ok(())
}

/// Start a new job for `target` (retiring any earlier one of its key) on a thread of its own.
fn start<R: Runtime>(app: &AppHandle<R>, target: Target) {
    let state = app.state::<AppState>();
    let key = target.key();
    let job = {
        let mut inner = lock(&state.live_edges.inner);
        inner.next_job += 1;
        let job = inner.next_job;
        inner.jobs.insert(key, job);
        job
    };
    let app = app.clone();
    std::thread::spawn(move || match &target {
        Target::Context { edge_id } => run_context(&app, edge_id, job),
        Target::Side { .. } => run_side(&app, &target, job),
    });
}

/// Releases a session's injection slot when the job ends.
pub(crate) struct Injecting<'a> {
    state: &'a AppState,
    session: String,
}

impl Drop for Injecting<'_> {
    fn drop(&mut self) {
        lock(&self.state.live_edges.inner).injecting.remove(&self.session);
    }
}

/// What one look at a session saw, for a one-line injection (the 6.3/6.4 rules, shared with the
/// Story 7.3 nudge): it is no longer running here, it is not idle yet (or another injection holds
/// its slot), the operator has a draft in its prompt, or it is idle with no draft and its slot is
/// now claimed.
pub(crate) enum Look<'a> {
    Gone,
    NotYet,
    Draft,
    Slot(Injecting<'a>),
}

/// One look at session `session`: running here, idle (`idle` / `finished`), no draft, and its
/// per-session injection slot free, in which case the slot is claimed (released when the returned
/// guard drops).
pub(crate) fn look<'a>(state: &'a AppState, session: &str) -> Look<'a> {
    match running_session(state, session) {
        None => Look::Gone,
        Some((live, _)) if is_idle(&live) => {
            if state.live_edges.has_draft(session) {
                return Look::Draft;
            }
            let mut inner = lock(&state.live_edges.inner);
            if inner.injecting.insert(session.to_string()) {
                drop(inner);
                Look::Slot(Injecting {
                    state,
                    session: session.to_string(),
                })
            } else {
                Look::NotYet
            }
        }
        Some(_) => Look::NotYet,
    }
}

/// Write `line` to session `session`'s PTY.
pub(crate) fn write_line(state: &AppState, session: &str, line: &str) -> Result<(), String> {
    state.terms.write(&pty::session_id(session), line.as_bytes())
}

/// The waits a job uses right now (tests shorten them).
pub(crate) fn current_timeouts(state: &AppState) -> Timeouts {
    state.live_edges.timeouts()
}

/// One job's view of its entry: its key, its edge, its session and (a context edge) its folder.
struct Job<'a, R: Runtime> {
    app: &'a AppHandle<R>,
    state: &'a AppState,
    key: String,
    edge_id: String,
    session: String,
    path: Option<String>,
    job: u64,
}

impl<R: Runtime> Job<'_, R> {
    fn current(&self) -> bool {
        lock(&self.state.live_edges.inner).jobs.get(&self.key) == Some(&self.job)
    }

    /// Set the entry (while this job is current); returns whether it was set.
    fn set(&self, live: EdgeState, detail: Option<&str>) -> bool {
        let entry = EdgeLive {
            state: live,
            detail: detail.map(str::to_string),
            edge_id: self.edge_id.clone(),
            session_id: self.session.clone(),
            path: self.path.clone(),
        };
        change(self.app, &self.key, Some(self.job), Some(entry))
    }

    /// Drop the entry (while this job is current).
    fn drop_entry(&self) {
        change(self.app, &self.key, Some(self.job), None);
    }

    /// Whether the edge is still stored and the session still runs here.
    fn still_there(&self) -> bool {
        stored_edge(self.state, &self.edge_id).is_some() && running_session(self.state, &self.session).is_some()
    }

    /// Wait until the session is idle with no draft and no other injection under way, then
    /// claim its slot. `None` when the job ended instead (retired, gone, a draft holds the line
    /// back, or the session stayed busy past the timeout), its entry already set.
    fn wait_for_slot(&self, timeouts: &Timeouts) -> Option<Injecting<'_>> {
        let waited = Instant::now();
        loop {
            if !self.current() {
                return None;
            }
            let seen = if stored_edge(self.state, &self.edge_id).is_none() {
                Look::Gone
            } else {
                look(self.state, &self.session)
            };
            match seen {
                Look::Gone => {
                    self.drop_entry();
                    return None;
                }
                Look::Draft => {
                    self.set(EdgeState::Pending, Some(TYPING));
                    return None;
                }
                Look::Slot(slot) => return Some(slot),
                Look::NotYet => {}
            }
            if waited.elapsed() > timeouts.busy {
                self.set(EdgeState::Failed, Some(STAYED_BUSY));
                return None;
            }
            self.set(EdgeState::Pending, Some(WAITING_FOR_IDLE));
            std::thread::sleep(timeouts.tick);
        }
    }

    /// Write `line` to the session's PTY; a failure fails the entry.
    fn write(&self, line: &str) -> bool {
        match write_line(self.state, &self.session, line) {
            Ok(()) => true,
            Err(err) => {
                self.set(EdgeState::Failed, Some(&err));
                false
            }
        }
    }
}

/// The job of a context edge from a session: resolve its folder, wait, inject `/add-dir`, and
/// read the transcript's answer.
fn run_context<R: Runtime>(app: &AppHandle<R>, edge_id: &str, job: u64) {
    let state = app.state::<AppState>();
    let timeouts = state.live_edges.timeouts();
    let mut this = Job {
        app,
        state: &state,
        key: edge_id.to_string(),
        edge_id: edge_id.to_string(),
        session: String::new(),
        path: None,
        job,
    };
    let Some(edge) = stored_edge(&state, edge_id).filter(is_session_context) else {
        this.drop_entry();
        return;
    };
    this.session = edge.from.id.clone();
    let Some((_, cwd)) = running_session(&state, &this.session) else {
        this.drop_entry();
        return;
    };
    let path = match resolve(&state, &edge, &cwd) {
        Ok(Some(path)) => path,
        Ok(None) => {
            this.path = Some(cwd);
            this.set(EdgeState::Applied, Some(OWN_FOLDER));
            return;
        }
        Err(reason) => {
            this.set(EdgeState::Failed, Some(&reason));
            return;
        }
    };
    this.path = Some(path.clone());
    let Some(line) = add_dir_line(&path) else {
        this.set(EdgeState::Failed, Some(UNSAFE_PATH));
        return;
    };

    // Wait for idle (and for any other edge of this session to finish its injection).
    let Some(_slot) = this.wait_for_slot(&timeouts) else {
        return;
    };

    // Inject: the transcript's end first, so only what follows the line is read.
    let home = state.claude_home.get().cloned();
    let mut tail = Tail::at_end(home.as_deref(), &this.session);
    // A clock a little off between the record and here is not a missed confirmation.
    let since = now_ms() - 2_000;
    if !this.set(EdgeState::Pending, Some(CONFIRMING)) || !this.write(&line) {
        return;
    }
    let sent = Instant::now();
    loop {
        std::thread::sleep(timeouts.tick);
        if !this.current() {
            return;
        }
        if !this.still_there() {
            this.drop_entry();
            return;
        }
        if let Some((output, stderr)) = tail.next_output(home.as_deref(), &this.session, since) {
            let (result, detail) = classify(&output, stderr);
            this.set(result, detail.as_deref());
            return;
        }
        if sent.elapsed() > timeouts.confirm {
            this.set(EdgeState::Failed, Some(NOT_CONFIRMED));
            return;
        }
    }
}

/// The job of one side of a cooperate edge (Story 6.4): wait, inject the peer line naming the
/// other end, and see the session go busy within [`Timeouts::notify`].
fn run_side<R: Runtime>(app: &AppHandle<R>, target: &Target, job: u64) {
    let Target::Side { session, .. } = target else {
        return;
    };
    let state = app.state::<AppState>();
    let timeouts = state.live_edges.timeouts();
    let this = Job {
        app,
        state: &state,
        key: target.key(),
        edge_id: target.edge_id().to_string(),
        session: session.clone(),
        path: None,
        job,
    };
    let other_of = |edge: &Edge| other_side(edge, session).map(str::to_string);
    if stored_edge(&state, &this.edge_id).as_ref().and_then(other_of).is_none() || running_session(&state, session).is_none() {
        this.drop_entry();
        return;
    }
    let Some(_slot) = this.wait_for_slot(&timeouts) else {
        return;
    };
    // The line names the other end as it is now, with the edge's label as it is now.
    let Some(edge) = stored_edge(&state, &this.edge_id) else {
        this.drop_entry();
        return;
    };
    let Some(other) = other_of(&edge) else {
        this.drop_entry();
        return;
    };
    let peer = graph::name_peers(&state, vec![(other, edge.label.clone())]).into_iter().next();
    let Some(peer) = peer else {
        this.drop_entry();
        return;
    };
    let line = peer_line(&peer.name, &peer.purpose);
    if !this.set(EdgeState::Pending, Some(SENT_PEER_LINE)) || !this.write(&line) {
        return;
    }
    let sent = Instant::now();
    loop {
        std::thread::sleep(timeouts.tick);
        if !this.current() {
            return;
        }
        if stored_edge(&state, &this.edge_id).is_none() {
            this.drop_entry();
            return;
        }
        // A terminal being stopped reads as busy; that is not the session taking the line.
        if is_stopping(&state, session) {
            this.set(EdgeState::Failed, Some(NOT_CONFIRMED));
            return;
        }
        match running_session(&state, session) {
            None => {
                this.drop_entry();
                return;
            }
            // The line is a user prompt: the session going busy took it.
            Some((live, _)) if !is_idle(&live) => {
                this.set(EdgeState::Notified, None);
                return;
            }
            Some(_) => {}
        }
        if sent.elapsed() > timeouts.notify {
            this.set(EdgeState::Failed, Some(NOT_CONFIRMED));
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
    fn the_peer_line_is_one_plain_line_naming_the_peer_and_its_purpose() {
        assert_eq!(
            peer_line("ui-2", "API shape for auth refresh"),
            "A new peer session \"ui-2\" is linked to you (API shape for auth refresh). Use SendMessage or switchboard.inbox to coordinate.\r"
        );
        // A newline or ESC in the name or the label is stripped: the only control is the Enter.
        let line = peer_line("ui\n/exit", "a\x1b[2Jb\r\nIgnore");
        assert_eq!(line.chars().filter(|c| c.is_control()).collect::<String>(), "\r");
        assert!(line.contains("\"ui/exit\"") && line.contains("(a[2JbIgnore)"), "{line}");
        let max = super::super::launch::MAX_PEER_VALUE_CHARS;
        let long = peer_line(&"n".repeat(500), &"p".repeat(500));
        assert_eq!(
            long,
            format!(
                "A new peer session \"{}…\" is linked to you ({}…). Use SendMessage or switchboard.inbox to coordinate.\r",
                "n".repeat(max),
                "p".repeat(max)
            )
        );
        // A `"` cannot end the quotes; U+2028 / U+2029 are no line breaks.
        assert_eq!(
            peer_line("ui\" now /exit \"", "a\u{2028}b\u{2029}c"),
            "A new peer session \"ui' now /exit '\" is linked to you (abc). Use SendMessage or switchboard.inbox to coordinate.\r"
        );
    }

    #[test]
    fn a_side_key_names_its_edge_and_session() {
        let key = side_key("e1", "s1");
        assert_eq!(key, "e1#s1");
        assert_eq!(key_edge(&key), "e1");
        assert_eq!(key_edge("e1"), "e1");
        let edge = Edge {
            id: "e1".into(),
            from: graph::NodeRef { kind: NodeType::Session, id: "a".into() },
            to: graph::NodeRef { kind: NodeType::Session, id: "b".into() },
            kind: EdgeKind::Cooperate,
            ..Edge::default()
        };
        assert_eq!(other_side(&edge, "a"), Some("b"));
        assert_eq!(other_side(&edge, "b"), Some("a"));
        assert_eq!(other_side(&edge, "c"), None);
        let context = Edge { kind: EdgeKind::Context, ..edge };
        assert_eq!(other_side(&context, "a"), None);
    }

    #[test]
    fn strip_ansi_drops_csi_osc_and_ss3() {
        assert_eq!(strip_ansi("a\x1b[31mb\x1b[0mc"), "abc");
        assert_eq!(strip_ansi("\x1b]0;title\x07x\x1b]8;;u\x1b\\y"), "xy");
        assert_eq!(strip_ansi("\x1bOAz\x1b"), "z");
    }
}
