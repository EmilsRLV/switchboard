//! Peer messages between cooperating sessions (Story 7.3): the `switchboard` MCP server's `send`
//! and `inbox` tools, each session's unread messages, the unread badge's counts and the nudge.
//!
//! **Who may write to whom.** Only the sessions joined by a cooperate edge (Story 6.4's rule,
//! `graph::cooperate_peers`). `send({peer, text})` finds the peer by its session id (or
//! `session:<id>`), else by its name (exact, then ignoring case); no match is `not a peer`, two
//! matching peers an error naming their node ids. Neither tool asks the operator: the edge is
//! the permission, and both are in the session's `permissions.allow`.
//!
//! **The inbox.** Rust owns it: per session, at most [`MAX_UNREAD`] messages in arrival order (the
//! oldest dropped first, and then a `N older messages were dropped` notice leads the inbox), in
//! memory only. `inbox()` returns them once and clears them. Every change goes out as [`EVENT`]
//! with `{sessionId: count}` for every session with unread messages, so the UI draws the `N new`
//! badge. A message to a peer that is not running in a Switchboard terminal is kept for it (`send`
//! says `running: false`): the inbox outlives the session's exit within this app run and is lost
//! when the app quits, or when the session's ref or its project is removed ([`forget_sessions`]).
//!
//! **The nudge** (`peers.nudge`, on by default). Each arrival of a peer message starts the
//! recipient's nudge job (retiring an earlier one): it waits, with no give-up, until the session
//! runs in a Switchboard terminal, is idle (`idle` / `finished`), has no draft in its prompt and
//! its per-session injection slot is free (the 6.3/6.4 rules, `live_edges::look`), then writes
//! one line built from the unread messages at that moment ([`nudge_line`]) and Enter. Nothing is
//! written when they were already read, and an arrival is nudged once: a later idle with the same
//! unread messages writes nothing. An arrival counts as nudged only once its line was written. The
//! job ends with the session's exit; a resumed session with an arrival not yet nudged gets a new
//! job ([`session_started`]), and so does every running one when the setting is turned on
//! ([`nudge_turned_on`]).
//!
//! **The loop guard.** At most [`NudgeLimit::max`] nudges per session in any rolling
//! [`NudgeLimit::window`] (20 an hour). Past that the messages and the badge go on, no nudge is
//! typed, and a one-line notice says `nudges paused for <name>: 20 in the last hour`; nudges resume
//! once the window's count falls below the limit.
//!
//! **The link notice.** When a cooperate edge joins two running sessions, each inbox gets
//! `Linked to "<other>" (<purpose>).` from `switchboard`. It counts as unread but never nudges
//! on its own (the 6.4 peer line already tells the session).
//!
//! **Line comments** (Story 8.4). The Review pane sends `Review comment on <path>:<line>:
//! <comment>` ([`comment_line`]: one line, at most [`MAX_COMMENT_CHARS`] characters) to a session.
//! It lands in the inbox from `operator` (so `inbox()` returns it) and never counts as a peer
//! arrival: the `You have N messages` nudge and its loop guard ignore it. While the session runs
//! in a Switchboard terminal, its comment job types the line itself at the next idle with no draft
//! and a free slot (the shared injection rules, `live_edges::look`), each comment once, oldest
//! first. It is typed whatever `peers.nudge` says (that setting governs only the peer-message
//! nudge). A session that is not running keeps it queued in the inbox, and it is typed once the
//! session next runs here and is idle, unless the session read it with `inbox()` first. A typed
//! comment leaves the inbox (it counts as read there), so the agent never gets it twice. Comment
//! messages are never evicted from a full inbox ahead of other messages, nor queued comments from
//! the per-session list; one that must go anyway is `dropped`. Each comment's state (`queued`,
//! `sent` once typed, `read` once drained by `inbox()`, `dropped`) is kept for this run only and goes
//! out as [`COMMENTS_EVENT`].

use std::collections::{BTreeMap, HashMap, VecDeque};
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::{Value, json};
use tauri::{AppHandle, Emitter, Manager, Runtime};

use crate::claude::launch::peer_value;
use crate::claude::live_edges::{self, Look};
use crate::graph::{self, Edge, EdgeKind, NodeType};
use crate::settings::AppState;

/// The event that carries `{sessionId: unread count}` on every change.
pub const EVENT: &str = "inbox://unread";

/// The most unread messages a session holds; the oldest go first.
pub const MAX_UNREAD: usize = 100;

/// The longest text `send` takes once cleaned, in characters.
pub const MAX_TEXT_CHARS: usize = 4000;

/// Why `send` is refused for a session that no cooperate edge joins to the caller.
pub const NOT_A_PEER: &str = "not a peer";

/// The sender of the notices.
pub const SWITCHBOARD: &str = "switchboard";

/// The loop guard's default: at most this many nudges per session ...
pub const MAX_NUDGES: usize = 20;
/// ... in any rolling window this long.
pub const NUDGE_WINDOW: Duration = Duration::from_secs(3600);

/// The loop guard (tests shorten it).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct NudgeLimit {
    pub max: usize,
    pub window: Duration,
}

impl Default for NudgeLimit {
    fn default() -> Self {
        Self {
            max: MAX_NUDGES,
            window: NUDGE_WINDOW,
        }
    }
}

/// One message in an inbox.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Message {
    /// The sender's name as its peers know it, or `switchboard` for a notice.
    pub from: String,
    /// The sender's session id; `None` for a notice.
    pub from_node_id: Option<String>,
    pub text: String,
    /// ISO 8601 UTC.
    pub at: String,
    /// Story 8.4: the line comment this message carries (never sent to the session).
    #[serde(skip)]
    pub comment: Option<u64>,
}

#[derive(Debug, Default)]
struct Mailbox {
    messages: VecDeque<Message>,
    /// Messages pushed out at the cap since the last read, and when the last one was.
    dropped: usize,
    dropped_at: String,
    /// Counts the arrivals of peer messages (never the notices).
    arrival: u64,
    /// The arrival the last nudge written (or a drain, or the loop guard) covered.
    nudged: u64,
    /// When the nudges of the loop guard's window were written.
    nudges: VecDeque<Instant>,
    /// The loop guard holds the nudges back (its notice was shown).
    paused: bool,
}

impl Mailbox {
    /// The unread count: the messages, and the dropped notice when there is one.
    fn len(&self) -> usize {
        self.messages.len() + usize::from(self.dropped > 0)
    }

    /// An arrival not yet nudged, with something unread.
    fn owed(&self) -> bool {
        self.arrival > self.nudged && !self.messages.is_empty()
    }
}

/// `N older messages were dropped` (one: `1 older message was dropped`).
pub fn dropped_text(n: usize) -> String {
    if n == 1 {
        "1 older message was dropped".to_string()
    } else {
        format!("{n} older messages were dropped")
    }
}

#[derive(Debug, Default)]
struct Inner {
    boxes: HashMap<String, Mailbox>,
    /// Session → the generation of its current nudge job.
    jobs: HashMap<String, u64>,
    next_job: u64,
    /// Story 8.4: the line comments of this run, oldest first.
    comments: Vec<Comment>,
    next_comment: u64,
    /// Session → the generation of its current comment job.
    comment_jobs: HashMap<String, u64>,
}

/// Every session's inbox (in `AppState`). Memory only.
#[derive(Debug, Default)]
pub struct Inboxes {
    inner: Mutex<Inner>,
    /// The loop guard.
    pub limit: Mutex<NudgeLimit>,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|e| e.into_inner())
}

impl Inboxes {
    /// `{sessionId: count}` for every session with unread messages.
    pub fn unread(&self) -> BTreeMap<String, usize> {
        counts(&lock(&self.inner))
    }

    /// Session `id`'s unread count.
    pub fn count(&self, id: &str) -> usize {
        lock(&self.inner).boxes.get(id).map_or(0, Mailbox::len)
    }

    /// Whether session `id` has a nudge job waiting.
    pub fn nudge_pending(&self, id: &str) -> bool {
        lock(&self.inner).jobs.contains_key(id)
    }

    /// Whether session `id` has an arrival not yet nudged (with something unread).
    pub fn nudge_owed(&self, id: &str) -> bool {
        lock(&self.inner).boxes.get(id).is_some_and(Mailbox::owed)
    }

    /// Whether session `id` has an inbox at all.
    pub fn has_box(&self, id: &str) -> bool {
        lock(&self.inner).boxes.contains_key(id)
    }

    /// Story 8.4: session `id`'s line comments of this run, oldest first.
    pub fn comments_of(&self, id: &str) -> Vec<Comment> {
        lock(&self.inner).comments.iter().filter(|c| c.session_id == id).cloned().collect()
    }

    /// Story 8.4: every line comment of this run, oldest first.
    pub fn comments(&self) -> Vec<Comment> {
        lock(&self.inner).comments.clone()
    }

    /// Story 8.4: whether session `id` has a comment job waiting.
    pub fn comment_pending(&self, id: &str) -> bool {
        lock(&self.inner).comment_jobs.contains_key(id)
    }
}

fn counts(inner: &Inner) -> BTreeMap<String, usize> {
    inner
        .boxes
        .iter()
        .filter(|(_, b)| b.len() > 0)
        .map(|(id, b)| (id.clone(), b.len()))
        .collect()
}

fn emit<R: Runtime>(app: &AppHandle<R>, inner: &Inner) {
    if let Err(err) = app.emit(EVENT, counts(inner)) {
        eprintln!("inbox: emit failed: {err}");
    }
}

fn now_iso() -> String {
    crate::claude::transcript::format_iso_ms(crate::claude::live::now_ms())
}

/// Put `message` in session `to`'s inbox (dropping the oldest past [`MAX_UNREAD`]) and emit the
/// counts; a peer message (`arrival`) counts as an arrival for the nudge. Returns the count and
/// how many older messages this push dropped.
fn push<R: Runtime>(app: &AppHandle<R>, to: &str, message: Message, arrival: bool) -> (usize, usize) {
    let state = app.state::<AppState>();
    let mut inner = lock(&state.inbox.inner);
    let (count, dropped, comments_changed) = push_locked(&mut inner, to, message, arrival);
    // Under the lock, so the events go out in the order the changes were made.
    emit(app, &inner);
    if comments_changed {
        emit_comments(app, &inner);
    }
    (count, dropped)
}

/// [`push`] under the caller's lock, without the events. Past [`MAX_UNREAD`] the oldest message
/// that is not a line comment goes first; a comment message goes only when nothing else is left,
/// and its comment is then `dropped`. Returns the count, the messages dropped and whether a
/// comment's state changed.
fn push_locked(inner: &mut Inner, to: &str, message: Message, arrival: bool) -> (usize, usize, bool) {
    let Inner { boxes, comments, .. } = inner;
    let entry = boxes.entry(to.to_string()).or_default();
    entry.messages.push_back(message);
    let mut dropped = 0;
    let mut comments_changed = false;
    while entry.messages.len() > MAX_UNREAD {
        let at = entry.messages.iter().position(|m| m.comment.is_none()).unwrap_or(0);
        if let Some(gone) = entry.messages.remove(at)
            && let Some(id) = gone.comment
            && let Some(comment) = comments.iter_mut().find(|c| c.id == id && c.state == CommentState::Queued)
        {
            comment.state = CommentState::Dropped;
            comments_changed = true;
        }
        dropped += 1;
    }
    if dropped > 0 {
        entry.dropped += dropped;
        entry.dropped_at = now_iso();
    }
    if arrival {
        entry.arrival += 1;
    }
    (entry.len(), dropped, comments_changed)
}

/// A message's text as it is stored: line breaks kept (`\r\n`, `\r`, U+2028 and U+2029 become
/// `\n`), the bidi embeddings, overrides and isolates (U+202A–U+202E, U+2066–U+2069) and every
/// other control character stripped, trimmed.
pub fn clean_text(raw: &str) -> String {
    let lines = raw.replace("\r\n", "\n").replace(['\r', '\u{2028}', '\u{2029}'], "\n");
    lines
        .chars()
        .filter(|c| *c == '\n' || !(c.is_control() || ('\u{202A}'..='\u{202E}').contains(c) || ('\u{2066}'..='\u{2069}').contains(c)))
        .collect::<String>()
        .trim()
        .to_string()
}

/// The caller's cooperate peer that `wanted` names: its session id or `session:<id>`, else its
/// name (exact, then ignoring case). Returns the peer's id and name.
pub fn find_peer(state: &AppState, caller: &str, wanted: &str) -> Result<(String, String), String> {
    let mut list = graph::cooperate_peers(&state.read_workspace(), caller);
    // Two edges to one peer name it once.
    let mut seen = Vec::new();
    list.retain(|(id, _)| {
        let first = !seen.contains(id);
        seen.push(id.clone());
        first
    });
    let ids: Vec<String> = list.iter().map(|(id, _)| id.clone()).collect();
    let peers: Vec<(String, String)> = ids.into_iter().zip(graph::name_peers(state, list)).map(|(id, p)| (id, p.name)).collect();
    let by_id = wanted.strip_prefix("session:").unwrap_or(wanted);
    if let Some(found) = peers.iter().find(|(id, _)| id == by_id) {
        return Ok(found.clone());
    }
    let exact: Vec<&(String, String)> = peers.iter().filter(|(_, name)| name == wanted).collect();
    let loose: Vec<&(String, String)> = peers.iter().filter(|(_, name)| name.to_lowercase() == wanted.to_lowercase()).collect();
    let by_name = if exact.is_empty() { loose } else { exact };
    match by_name.as_slice() {
        [] => Err(format!("{NOT_A_PEER}: {wanted}")),
        [one] => Ok((*one).clone()),
        many => {
            let ids: Vec<&str> = many.iter().map(|(id, _)| id.as_str()).collect();
            Err(format!("ambiguous peer name {wanted}: {}; give the node id", ids.join(", ")))
        }
    }
}

/// Session `id`'s name as its peers know it (Story 6.4's rule).
fn name_of(state: &AppState, id: &str) -> String {
    graph::name_peers(state, vec![(id.to_string(), None)])
        .into_iter()
        .next()
        .map_or_else(|| id.to_string(), |p| p.name)
}

/// `send({peer, text})`: no approval; refused for a session that is not a cooperate peer of the
/// caller, a blank text or one over [`MAX_TEXT_CHARS`] once cleaned. The message lands in the
/// peer's inbox (kept for it when it is not running in a Switchboard terminal) and, with the nudge
/// on, the peer is nudged once idle. Returns `{delivered: true, to, unread}`, plus `running: false`
/// for a peer not running in a Switchboard terminal and `dropped: N` when older messages went.
pub fn send<R: Runtime>(app: &AppHandle<R>, caller: &str, args: &Value) -> Result<Value, String> {
    let state = app.state::<AppState>();
    let wanted = match args.get("peer") {
        Some(Value::String(peer)) if !peer.trim().is_empty() => peer.trim().to_string(),
        Some(Value::String(_)) | None | Some(Value::Null) => return Err("peer is required".to_string()),
        Some(_) => return Err("peer must be a string".to_string()),
    };
    let raw = match args.get("text") {
        Some(Value::String(text)) => text.clone(),
        None | Some(Value::Null) => String::new(),
        Some(_) => return Err("text must be a string".to_string()),
    };
    let text = clean_text(&raw);
    if text.chars().count() > MAX_TEXT_CHARS {
        return Err(format!("text is over {MAX_TEXT_CHARS} characters"));
    }
    if text.is_empty() {
        return Err("text is empty".to_string());
    }
    let (to, to_name) = find_peer(&state, caller, &wanted)?;
    let message = Message {
        from: name_of(&state, caller),
        from_node_id: Some(caller.to_string()),
        text,
        at: now_iso(),
        comment: None,
    };
    let (unread, dropped) = push(app, &to, message, true);
    let running = live_edges::running_session(&state, &to).is_some();
    if running && nudge_on(&state) {
        start(app, &to);
    }
    let mut result = json!({ "delivered": true, "to": to_name, "unread": unread });
    if !running {
        result["running"] = json!(false);
    }
    if dropped > 0 {
        result["dropped"] = json!(dropped);
    }
    Ok(result)
}

/// `inbox()`: the caller's unread messages in arrival order, `[{from, fromNodeId, text, at}]`
/// (led by the dropped notice when older ones went), each returned once: the inbox (and its badge)
/// is cleared.
pub fn inbox<R: Runtime>(app: &AppHandle<R>, caller: &str) -> Result<Value, String> {
    let state = app.state::<AppState>();
    let mut inner = lock(&state.inbox.inner);
    let Some(entry) = inner.boxes.get_mut(caller) else {
        return Ok(json!([]));
    };
    let mut messages = Vec::new();
    if entry.dropped > 0 {
        messages.push(Message {
            from: SWITCHBOARD.to_string(),
            from_node_id: None,
            text: dropped_text(entry.dropped),
            at: std::mem::take(&mut entry.dropped_at),
            comment: None,
        });
        entry.dropped = 0;
    }
    messages.extend(entry.messages.drain(..));
    // Read: nothing is left for a nudge to tell.
    entry.nudged = entry.arrival;
    if !messages.is_empty() {
        emit(app, &inner);
    }
    // Story 8.4: a drained line comment is read (and so never typed).
    let mut read = false;
    for id in messages.iter().filter_map(|m| m.comment) {
        if let Some(comment) = inner.comments.iter_mut().find(|c| c.id == id)
            && comment.state == CommentState::Queued
        {
            comment.state = CommentState::Read;
            read = true;
        }
    }
    if read {
        emit_comments(app, &inner);
    }
    serde_json::to_value(messages).map_err(|e| e.to_string())
}

/// The live-link notice (deferred from Story 6.4): cooperate edge `edge` joins two sessions that
/// both run here, so each inbox gets `Linked to "<other>" (<purpose>).` from `switchboard`. It does
/// not nudge.
pub fn link_notices<R: Runtime>(app: &AppHandle<R>, edge: &Edge) {
    if edge.kind != EdgeKind::Cooperate || edge.from.kind != NodeType::Session || edge.to.kind != NodeType::Session || edge.from.id == edge.to.id {
        return;
    }
    let state = app.state::<AppState>();
    let (a, b) = (&edge.from.id, &edge.to.id);
    if live_edges::running_session(&state, a).is_none() || live_edges::running_session(&state, b).is_none() {
        return;
    }
    for (me, other) in [(a, b), (b, a)] {
        let Some(peer) = graph::name_peers(&state, vec![(other.clone(), edge.label.clone())]).into_iter().next() else {
            continue;
        };
        let message = Message {
            from: SWITCHBOARD.to_string(),
            from_node_id: None,
            text: notice_text(&peer.name, &peer.purpose),
            at: now_iso(),
            comment: None,
        };
        push(app, me, message, false);
    }
}

/// `Linked to "<other>" (<purpose>).`, both values cleaned like the peer line's.
pub fn notice_text(name: &str, purpose: &str) -> String {
    format!("Linked to \"{}\" ({}).", peer_value(name), peer_value(purpose))
}

/// The nudge for `messages` (the unread ones; the notices do not count): `You have 1 message from
/// "A". Call switchboard.inbox.`, `You have N messages from "A". …` (one sender) or `You have N
/// messages from M peers. Call switchboard.inbox.`, and Enter. `None` when no peer message is
/// among them.
pub fn nudge_line<'a>(messages: impl IntoIterator<Item = &'a Message>) -> Option<String> {
    let mut senders: Vec<(&str, &str)> = Vec::new();
    let mut n = 0;
    for message in messages {
        let Some(id) = message.from_node_id.as_deref() else {
            continue;
        };
        n += 1;
        if !senders.iter().any(|(s, _)| *s == id) {
            senders.push((id, &message.from));
        }
    }
    let from = match senders.as_slice() {
        [] => return None,
        [(_, name)] => format!("\"{}\"", peer_value(name)),
        many => format!("{} peers", many.len()),
    };
    let what = if n == 1 { "1 message".to_string() } else { format!("{n} messages") };
    Some(format!("You have {what} from {from}. Call switchboard.inbox.\r"))
}

/// The loop guard's notice: `nudges paused for <name>: 20 in the last hour`.
pub fn paused_text(name: &str, max: usize) -> String {
    format!("nudges paused for {}: {max} in the last hour", peer_value(name))
}

fn nudge_on(state: &AppState) -> bool {
    state.read().settings.peers.nudge
}

/// Session `id` started (a launch or a resume) in a Switchboard terminal: an arrival it has not
/// been nudged for gets a nudge job, with the nudge on.
pub fn session_started<R: Runtime>(app: &AppHandle<R>, id: &str) {
    let state = app.state::<AppState>();
    if state.inbox.nudge_owed(id) && nudge_on(&state) {
        start(app, id);
    }
    // Story 8.4: comments still queued (sent while it was stopped, or not typed before it exited).
    if next_comment(&lock(&state.inbox.inner), id).is_some() {
        start_comments(app, id);
    }
}

/// `peers.nudge` was turned on: every running session with an arrival not yet nudged gets a job.
pub fn nudge_turned_on<R: Runtime>(app: &AppHandle<R>) {
    let state = app.state::<AppState>();
    let owed: Vec<String> = lock(&state.inbox.inner).boxes.iter().filter(|(_, b)| b.owed()).map(|(id, _)| id.clone()).collect();
    for id in owed {
        if live_edges::running_session(&state, &id).is_some() {
            start(app, &id);
        }
    }
}

/// Session `id` exited: its nudge job ends; its inbox stays for a later resume.
pub fn session_exited<R: Runtime>(app: &AppHandle<R>, id: &str) {
    let state = app.state::<AppState>();
    let mut inner = lock(&state.inbox.inner);
    inner.jobs.remove(id);
    inner.comment_jobs.remove(id);
}

/// Sessions removed from the workspace (their ref, or their project): their inboxes and nudge
/// jobs go, and the counts are emitted.
pub fn forget_sessions<'a, R: Runtime>(app: &AppHandle<R>, ids: impl IntoIterator<Item = &'a str>) {
    let state = app.state::<AppState>();
    let mut inner = lock(&state.inbox.inner);
    let mut removed = false;
    let before = inner.comments.len();
    for id in ids {
        inner.jobs.remove(id);
        inner.comment_jobs.remove(id);
        inner.comments.retain(|c| c.session_id != id);
        removed |= inner.boxes.remove(id).is_some();
    }
    if removed {
        emit(app, &inner);
    }
    if inner.comments.len() != before {
        emit_comments(app, &inner);
    }
}

/// Start session `id`'s nudge job on a thread of its own, retiring an earlier one.
fn start<R: Runtime>(app: &AppHandle<R>, id: &str) {
    let state = app.state::<AppState>();
    let job = {
        let mut inner = lock(&state.inbox.inner);
        inner.next_job += 1;
        let job = inner.next_job;
        inner.jobs.insert(id.to_string(), job);
        job
    };
    let app = app.clone();
    let id = id.to_string();
    std::thread::spawn(move || run_nudge(&app, &id, job));
}

/// Whether `job` is still session `id`'s nudge job.
fn current(state: &AppState, id: &str, job: u64) -> bool {
    lock(&state.inbox.inner).jobs.get(id) == Some(&job)
}

/// The job is done: it stops being the session's job (unless a newer one took its place).
fn finish(state: &AppState, id: &str, job: u64) {
    let mut inner = lock(&state.inbox.inner);
    if inner.jobs.get(id) == Some(&job) {
        inner.jobs.remove(id);
    }
}

/// What one nudge attempt did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Nudge {
    /// Nothing owed (already nudged or read, only notices, or the nudge is off).
    Nothing,
    /// The line was written; the arrival is nudged.
    Written,
    /// The loop guard held it back; the arrival counts as nudged.
    Paused,
    /// The write failed; the arrival is still owed.
    Failed(String),
}

/// One nudge of session `id`, through `write`: the line is built from the unread messages at this
/// moment; the arrival is marked nudged only once the line is written. Past the loop guard nothing
/// is written and (once per pause) the `nudges paused for …` notice goes out.
pub(crate) fn nudge_once<R: Runtime>(app: &AppHandle<R>, id: &str, write: impl FnOnce(&str) -> Result<(), String>) -> Nudge {
    let state = app.state::<AppState>();
    let on = nudge_on(&state);
    let limit = *lock(&state.inbox.limit);
    let (line, arrival) = {
        let mut inner = lock(&state.inbox.inner);
        let Some(entry) = inner.boxes.get_mut(id) else {
            return Nudge::Nothing;
        };
        if !on || entry.arrival <= entry.nudged {
            return Nudge::Nothing;
        }
        let now = Instant::now();
        while entry.nudges.front().is_some_and(|at| now.duration_since(*at) >= limit.window) {
            entry.nudges.pop_front();
        }
        if entry.nudges.len() >= limit.max {
            entry.nudged = entry.arrival;
            let first = !entry.paused;
            entry.paused = true;
            drop(inner);
            if first {
                crate::approvals::notice(app, &paused_text(&name_of(&state, id), limit.max));
            }
            return Nudge::Paused;
        }
        entry.paused = false;
        match nudge_line(&entry.messages) {
            Some(line) => (line, entry.arrival),
            None => {
                entry.nudged = entry.arrival;
                return Nudge::Nothing;
            }
        }
    };
    if let Err(err) = write(&line) {
        return Nudge::Failed(err);
    }
    let mut inner = lock(&state.inbox.inner);
    if let Some(entry) = inner.boxes.get_mut(id) {
        entry.nudged = entry.nudged.max(arrival);
        entry.nudges.push_back(Instant::now());
    }
    Nudge::Written
}

/// The nudge job of session `id`: wait (no give-up) for the session to be idle with no draft and
/// its slot free, then nudge once ([`nudge_once`]), and hold the slot until the session takes the
/// line (goes busy) or the 6.4 notify wait passes, so no other injection lands on top of it.
fn run_nudge<R: Runtime>(app: &AppHandle<R>, id: &str, job: u64) {
    let state = app.state::<AppState>();
    let timeouts = live_edges::current_timeouts(&state);
    let slot = loop {
        if !current(&state, id, job) {
            return;
        }
        match live_edges::look(&state, id) {
            Look::Gone => {
                finish(&state, id, job);
                return;
            }
            Look::Slot(slot) => break slot,
            Look::NotYet | Look::Draft => {}
        }
        std::thread::sleep(timeouts.tick);
    };
    if !current(&state, id, job) {
        return;
    }
    match nudge_once(app, id, |line| live_edges::write_line(&state, id, line)) {
        Nudge::Written => {}
        Nudge::Failed(err) => {
            eprintln!("inbox: nudge for {id} not written: {err}");
            finish(&state, id, job);
            return;
        }
        Nudge::Nothing | Nudge::Paused => {
            finish(&state, id, job);
            return;
        }
    }
    let sent = Instant::now();
    while sent.elapsed() <= timeouts.notify {
        std::thread::sleep(timeouts.tick);
        match live_edges::running_session(&state, id) {
            Some((live, _)) if live_edges::is_idle(&live) => {}
            _ => break,
        }
    }
    drop(slot);
    finish(&state, id, job);
}

// -- Story 8.4: line comments from the Review pane ---------------------------------------------

/// The event that carries every line comment of this run (`[Comment]`, oldest first) on each change.
pub const COMMENTS_EVENT: &str = "review://comments";

/// The sender of a line comment.
pub const OPERATOR: &str = "operator";

/// The longest comment line, in characters (cut there).
pub const MAX_COMMENT_CHARS: usize = 1000;

/// The most comments kept per session (those already typed, read or dropped go first).
pub const MAX_COMMENTS: usize = 100;

/// Why a comment to a project or a branch is refused.
pub const COMMENTS_GO_TO_A_SESSION: &str = "comments go to a session";

/// Why an empty comment is refused.
pub const EMPTY_COMMENT: &str = "comment is empty";

/// Why a comment on a bad path is refused.
pub const BAD_COMMENT_PATH: &str = "the file is not in the reviewed folder";

/// Why a comment whose path leaves no room for its text is refused.
pub const PATH_TOO_LONG: &str = "the file's path is too long for a comment";

/// A comment's delivery state.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CommentState {
    /// In the inbox, waiting for an idle (or for the session to run here).
    Queued,
    /// Typed into the session (it left the inbox).
    Sent,
    /// Drained by the session's `inbox()`.
    Read,
    /// Pushed out of a full inbox or comment list before it was delivered.
    Dropped,
}

/// One line comment.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Comment {
    pub id: u64,
    pub session_id: String,
    /// Relative to the reviewed folder, with `/`.
    pub path: String,
    pub line: u32,
    /// The line as delivered: `Review comment on <path>:<line>: <comment>`.
    pub text: String,
    pub state: CommentState,
    /// ISO 8601 UTC.
    pub at: String,
}

fn emit_comments<R: Runtime>(app: &AppHandle<R>, inner: &Inner) {
    if let Err(err) = app.emit(COMMENTS_EVENT, &inner.comments) {
        eprintln!("inbox: comments emit failed: {err}");
    }
}

fn is_break(c: char) -> bool {
    matches!(c, '\r' | '\n' | '\u{2028}' | '\u{2029}')
}

fn is_stripped(c: char) -> bool {
    c.is_control() || ('\u{202A}'..='\u{202E}').contains(&c) || ('\u{2066}'..='\u{2069}').contains(&c)
}

/// `text` as one plain line: each run of line breaks (`\r`, `\n`, U+2028, U+2029) becomes one
/// space (as the comment box does); every other control character and the bidi embeddings,
/// overrides and isolates are stripped; trimmed.
pub fn one_line(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut in_break = false;
    for c in text.chars() {
        if is_break(c) {
            if !in_break {
                out.push(' ');
                in_break = true;
            }
        } else if !is_stripped(c) {
            out.push(c);
            in_break = false;
        }
    }
    out.trim().to_string()
}

/// `Review comment on <path>:<line>: <comment>`, one line, cut to [`MAX_COMMENT_CHARS`]
/// characters. `Err` ([`EMPTY_COMMENT`]) when nothing is left of the comment, and
/// ([`PATH_TOO_LONG`]) when the path leaves no room for it.
pub fn comment_line(path: &str, line: u32, comment: &str) -> Result<String, String> {
    let comment = one_line(comment);
    if comment.is_empty() {
        return Err(EMPTY_COMMENT.to_string());
    }
    let lead = format!("Review comment on {path}:{line}: ");
    if lead.chars().count() >= MAX_COMMENT_CHARS {
        return Err(PATH_TOO_LONG.to_string());
    }
    Ok(format!("{lead}{comment}").chars().take(MAX_COMMENT_CHARS).collect())
}

/// The path a comment names, checked lexically (the comment only names it; nothing is read):
/// relative to the reviewed folder as the pane lists it (`/` between the parts, names kept as
/// listed, spaces included), with no empty, `.` or `..` part and no control, line-break or bidi
/// characters, so it lies inside the folder; on Windows also no `:` or `\`.
pub fn comment_path(path: &str) -> Result<String, String> {
    let bad = |c: char| is_break(c) || is_stripped(c) || (cfg!(windows) && matches!(c, ':' | '\\'));
    let plain = !path.is_empty() && !path.chars().any(bad) && path.split('/').all(|p| !p.is_empty() && p != "." && p != "..");
    if plain { Ok(path.to_string()) } else { Err(BAD_COMMENT_PATH.to_string()) }
}

/// Take comment `id`'s message out of session `session`'s inbox: where it was and the message.
fn take_comment_message(inner: &mut Inner, session: &str, id: u64) -> Option<(usize, Message)> {
    let entry = inner.boxes.get_mut(session)?;
    let at = entry.messages.iter().position(|m| m.comment == Some(id))?;
    entry.messages.remove(at).map(|m| (at, m))
}

/// Room for one more comment of `session`: past [`MAX_COMMENTS`] its oldest comment that is no
/// longer queued goes; when every one is still queued, the oldest is `dropped` (it stays listed as
/// such, and leaves the inbox). Other sessions' comments are never touched.
fn make_room(inner: &mut Inner, session: &str) {
    while inner.comments.iter().filter(|c| c.session_id == session).count() >= MAX_COMMENTS {
        if let Some(at) = inner.comments.iter().position(|c| c.session_id == session && c.state != CommentState::Queued) {
            inner.comments.remove(at);
            continue;
        }
        if let Some(oldest) = inner.comments.iter_mut().find(|c| c.session_id == session && c.state == CommentState::Queued) {
            oldest.state = CommentState::Dropped;
            let id = oldest.id;
            take_comment_message(inner, session, id);
        }
        break;
    }
}

/// A line comment to session `session` on `path` (checked by the caller) at `line`: built
/// ([`comment_line`]; an empty comment and line 0 are refused), pushed to its inbox from
/// [`OPERATOR`] (no peer arrival, no nudge) and, while the session runs here, typed in at its next
/// idle by its comment job (otherwise once it runs here again: [`session_started`]). Returns the
/// comment.
pub fn comment<R: Runtime>(app: &AppHandle<R>, session: &str, path: &str, line: u32, text: &str) -> Result<Comment, String> {
    if line == 0 {
        return Err("line must be 1 or more".to_string());
    }
    let text = comment_line(path, line, text)?;
    let state = app.state::<AppState>();
    let at = now_iso();
    let (comment, running) = {
        let mut inner = lock(&state.inbox.inner);
        make_room(&mut inner, session);
        inner.next_comment += 1;
        let comment = Comment {
            id: inner.next_comment,
            session_id: session.to_string(),
            path: path.to_string(),
            line,
            text: text.clone(),
            state: CommentState::Queued,
            at: at.clone(),
        };
        inner.comments.push(comment.clone());
        let message = Message {
            from: OPERATOR.to_string(),
            from_node_id: None,
            text,
            at,
            comment: Some(comment.id),
        };
        push_locked(&mut inner, session, message, false);
        emit(app, &inner);
        emit_comments(app, &inner);
        // Decided under the lock that holds the queued comment: a start after this point finds it
        // owed (`session_started`), and one before it is seen running here.
        let running = live_edges::running_session(&state, session).is_some();
        (comment, running)
    };
    if running {
        start_comments(app, session);
    }
    Ok(comment)
}

/// Session `id`'s oldest comment still to be typed in (queued: not read, typed or dropped).
fn next_comment(inner: &Inner, id: &str) -> Option<u64> {
    inner.comments.iter().find(|c| c.session_id == id && c.state == CommentState::Queued).map(|c| c.id)
}

/// Start session `id`'s comment job on a thread of its own, retiring an earlier one.
fn start_comments<R: Runtime>(app: &AppHandle<R>, id: &str) {
    let state = app.state::<AppState>();
    let job = {
        let mut inner = lock(&state.inbox.inner);
        inner.next_job += 1;
        let job = inner.next_job;
        inner.comment_jobs.insert(id.to_string(), job);
        job
    };
    let app = app.clone();
    let id = id.to_string();
    std::thread::spawn(move || run_comments(&app, &id, job));
}

fn comment_job_current(state: &AppState, id: &str, job: u64) -> bool {
    lock(&state.inbox.inner).comment_jobs.get(id) == Some(&job)
}

fn finish_comments(state: &AppState, id: &str, job: u64) {
    let mut inner = lock(&state.inbox.inner);
    if inner.comment_jobs.get(id) == Some(&job) {
        inner.comment_jobs.remove(id);
    }
}

/// What a comment job took for one write: the comment, its line and its inbox message (and where
/// it was), to put back if the write fails.
struct Claimed {
    id: u64,
    line: String,
    message: Option<(usize, Message)>,
}

/// Claim session `id`'s oldest queued comment under the lock, before it is written: it is `sent`
/// and its message leaves the inbox, so a drain from now on cannot also return it.
fn claim<R: Runtime>(app: &AppHandle<R>, state: &AppState, id: &str, job: u64) -> Option<Claimed> {
    let mut inner = lock(&state.inbox.inner);
    if inner.comment_jobs.get(id) != Some(&job) {
        return None;
    }
    let comment = next_comment(&inner, id)?;
    let line = {
        let c = inner.comments.iter_mut().find(|c| c.id == comment)?;
        c.state = CommentState::Sent;
        c.text.clone()
    };
    let message = take_comment_message(&mut inner, id, comment);
    emit(app, &inner);
    emit_comments(app, &inner);
    Some(Claimed { id: comment, line, message })
}

/// The write failed: the comment is queued again and its message back where it was.
fn unclaim<R: Runtime>(app: &AppHandle<R>, state: &AppState, session: &str, claimed: Claimed) {
    let mut inner = lock(&state.inbox.inner);
    if let Some(c) = inner.comments.iter_mut().find(|c| c.id == claimed.id && c.state == CommentState::Sent) {
        c.state = CommentState::Queued;
        if let Some((at, message)) = claimed.message {
            let entry = inner.boxes.entry(session.to_string()).or_default();
            let at = at.min(entry.messages.len());
            entry.messages.insert(at, message);
        }
    }
    emit(app, &inner);
    emit_comments(app, &inner);
}

/// The comment job of session `id`: while a comment is queued, wait (no give-up) for the session
/// to be idle with no draft and its slot free, claim the oldest queued comment ([`claim`]), type
/// its line and Enter, and hold the slot until the session takes it (goes busy) or the notify wait
/// passes. A failed write puts the comment back and is tried again on the next tick. Ends when
/// nothing is queued or the session is gone (the rest stay queued for its next run).
fn run_comments<R: Runtime>(app: &AppHandle<R>, id: &str, job: u64) {
    let state = app.state::<AppState>();
    let timeouts = live_edges::current_timeouts(&state);
    loop {
        if !comment_job_current(&state, id, job) {
            return;
        }
        if next_comment(&lock(&state.inbox.inner), id).is_none() {
            finish_comments(&state, id, job);
            return;
        }
        let slot = match live_edges::look(&state, id) {
            Look::Gone => {
                finish_comments(&state, id, job);
                return;
            }
            Look::Slot(slot) => slot,
            Look::NotYet | Look::Draft => {
                std::thread::sleep(timeouts.tick);
                continue;
            }
        };
        let Some(claimed) = claim(app, &state, id, job) else {
            // Retired, or read meanwhile: the loop's next look decides.
            drop(slot);
            continue;
        };
        if let Err(err) = live_edges::write_line(&state, id, &format!("{}\r", claimed.line)) {
            eprintln!("inbox: comment for {id} not written: {err}");
            unclaim(app, &state, id, claimed);
            drop(slot);
            std::thread::sleep(timeouts.tick);
            continue;
        }
        let sent = Instant::now();
        while sent.elapsed() <= timeouts.notify {
            std::thread::sleep(timeouts.tick);
            match live_edges::running_session(&state, id) {
                Some((live, _)) if live_edges::is_idle(&live) => {}
                _ => break,
            }
        }
        drop(slot);
    }
}

#[cfg(test)]
mod comment_tests {
    use super::*;

    #[test]
    fn a_comment_is_one_cleaned_line_cut_to_the_limit() {
        assert_eq!(comment_line("src/a.ts", 12, "rename this").unwrap(), "Review comment on src/a.ts:12: rename this");
        assert_eq!(
            comment_line("src/a.ts", 3, " first\r\n\r\nsecond\u{2028}third\u{2029}\n\u{7}\n\u{1b}[2J\u{202E}x\u{7} ").unwrap(),
            "Review comment on src/a.ts:3: first second third [2Jx",
            "a run of line breaks is one space"
        );
        assert_eq!(comment_line("a", 1, " \n\t\u{2028} "), Err(EMPTY_COMMENT.to_string()));
        let long = comment_line("a", 1, &"x".repeat(5000)).unwrap();
        assert_eq!(long.chars().count(), MAX_COMMENT_CHARS);
        assert!(!long.contains('\n') && !long.contains('\r'));
        // A path that leaves no room for the comment is refused; one that leaves a little is cut.
        assert_eq!(comment_line(&"p".repeat(990), 1, "x"), Err(PATH_TOO_LONG.to_string()));
        assert!(comment_line(&"p".repeat(970), 1, "xyz").unwrap().ends_with(": xyz"));
    }

    #[test]
    fn a_comment_path_is_checked_lexically_and_kept_as_listed() {
        assert_eq!(comment_path("src/a.ts"), Ok("src/a.ts".to_string()));
        assert_eq!(comment_path(" spaced name .md"), Ok(" spaced name .md".to_string()), "names are kept as listed");
        assert_eq!(comment_path("link/out.txt"), Ok("link/out.txt".to_string()), "nothing is resolved or read");
        for bad in ["", "../x", "src/../../x", "/etc/passwd", "a//b", "./a", "a\nb", "a/", "a\u{202E}b", "a\u{7}"] {
            assert_eq!(comment_path(bad), Err(BAD_COMMENT_PATH.to_string()), "{bad:?}");
        }
        for name in ["C:/x", "a\\b", "x:y.txt"] {
            assert_eq!(comment_path(name).is_ok(), !cfg!(windows), "{name:?}: valid on Linux only");
        }
    }
}
