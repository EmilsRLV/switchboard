//! Live sessions (Story 3.2): every `poll.agents_ms` (re-read each tick, never below
//! [`MIN_INTERVAL_MS`]) the detected `claude` binary is run as `claude agents --json --all` on
//! a blocking thread, its rows are parsed tolerantly and folded into the in-memory [`LiveMap`]
//! keyed by session id. Each row is matched to the project whose path is its `cwd`
//! (`graph::project_for_cwd`); a row matching none goes to the Elsewhere tray.
//!
//! Two channels leave here. A change to *which* sessions are live, or where they belong,
//! changes the child list and goes out as a workspace snapshot (`graph::set_live_children`:
//! new revision, `workspace://changed`, no file write). Everything the cards and the tray
//! show about state goes out as `sessions://live` ([`LiveSnapshot`]), emitted only when it
//! changed, so a busy ↔ idle flip never bumps the workspace revision.
//!
//! A session missing from a successful poll after being seen this run is **exited**; it is
//! remembered until the app quits and is live again if it reappears. A failed poll (spawn
//! error, non-zero exit, timeout, unparsable output) keeps the last map; three in a row raise
//! the `claude.agents` banner, which the next success clears. Nothing is persisted, nothing is
//! written under `~/.claude`, and the poll does not run while `claude` is not `found`.

use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};
use std::path::Path;
use std::process::Command;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, Runtime};

use super::hooks::{HookSignal, WaitKind};
use crate::graph::{self, LiveChild, Workspace};
use crate::process::{self, RunError};
use crate::settings::{AppState, BinaryStatus, SettingsState};

/// Event name carrying a [`LiveSnapshot`] whenever it changes.
pub const LIVE_EVENT: &str = "sessions://live";

/// A `poll.agents_ms` below this is treated as this.
pub const MIN_INTERVAL_MS: u64 = 500;

/// How long one `claude agents` run may take before it is killed (a call takes ~190 ms).
pub const RUN_TIMEOUT: Duration = Duration::from_secs(5);

/// Failed polls in a row before the banner shows.
pub const FAILURES_FOR_BANNER: u32 = 3;

/// The id of the banner a run of failed polls raises.
pub const BANNER_ID: &str = "claude.agents";

/// At most this many exited sessions are remembered; the oldest exits beyond it are dropped.
pub const MAX_EXITED: usize = 200;

/// The arguments the poll passes to `claude`.
pub const AGENTS_ARGS: [&str; 3] = ["agents", "--json", "--all"];

// ---------------------------------------------------------------------------------------
// Rows and states
// ---------------------------------------------------------------------------------------

/// One row of `claude agents --json --all` (verified on Claude Code 2.1.302):
/// `{ pid, cwd, kind, startedAt (epoch ms), sessionId, name, status }`. Only `sessionId` and
/// `cwd` are required; every other field is optional and unknown ones are ignored.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LiveRow {
    pub session_id: String,
    pub cwd: String,
    pub pid: Option<u64>,
    pub kind: Option<String>,
    pub started_at: Option<i64>,
    pub name: Option<String>,
    pub status: Option<String>,
}

/// Parse the CLI's output: a top-level JSON array of rows. Rows that are not objects, or lack
/// a non-empty string `sessionId` or `cwd`, are skipped; a field of an unexpected type, or a
/// blank string (`status: ""`, `name: " "`), is treated as absent. Anything that is not a JSON
/// array is an `Err` naming why.
pub fn parse_rows(text: &str) -> Result<Vec<LiveRow>, String> {
    let value: Value = serde_json::from_str(text.trim()).map_err(|err| format!("unparsable output: {err}"))?;
    let Value::Array(items) = value else {
        return Err("unparsable output: not a JSON array".to_string());
    };
    let string = |row: &serde_json::Map<String, Value>, key: &str| {
        row.get(key)
            .and_then(Value::as_str)
            .filter(|s| !s.trim().is_empty())
            .map(str::to_string)
    };
    Ok(items
        .iter()
        .filter_map(Value::as_object)
        .filter_map(|row| {
            let session_id = string(row, "sessionId")?;
            let cwd = string(row, "cwd")?;
            Some(LiveRow {
                session_id,
                cwd,
                pid: row.get("pid").and_then(Value::as_u64),
                kind: string(row, "kind"),
                started_at: row
                    .get("startedAt")
                    .and_then(|v| v.as_i64().or_else(|| v.as_f64().filter(|f| f.is_finite()).map(|f| f as i64))),
                name: string(row, "name"),
                status: string(row, "status"),
            })
        })
        .collect())
}

/// A session's state. The poll produces `Busy`, `Idle` and `Other` (any other status string,
/// kept verbatim and shown muted); two states are derived here: [`SessionState::Exited`] when
/// a session drops out, and [`SessionState::Finished`] when a session the previous poll saw
/// `busy` is now `idle` (Story 3.3; see [`LiveMap::apply_at`]). `Waiting` exists for the hooks
/// of Story 4.3 and is never produced by the poll. On the wire: `{ "kind": "busy" }`,
/// `{ "kind": "other", "raw": "compacting" }`. `Starting` (Story 4.2) is a session the app has
/// just launched, before its first output or poll row.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SessionState {
    Starting,
    Busy,
    Idle,
    Waiting,
    Finished,
    Exited,
    Other { raw: String },
}

impl SessionState {
    /// The state a row's `status` names: `busy`, `idle`, or anything else verbatim (a missing
    /// status is `unknown`).
    pub fn from_status(status: Option<&str>) -> Self {
        match status {
            Some("busy") => SessionState::Busy,
            Some("idle") => SessionState::Idle,
            Some(raw) => SessionState::Other { raw: raw.to_string() },
            None => SessionState::Other { raw: "unknown".to_string() },
        }
    }

    /// Every state but `Exited` is a running session.
    pub fn is_live(&self) -> bool {
        !matches!(self, SessionState::Exited)
    }

    /// `Finished` and `Waiting`: the session needs the operator (accent card, project glow,
    /// optional toast; Story 3.3).
    pub fn needs_attention(&self) -> bool {
        matches!(self, SessionState::Finished | SessionState::Waiting)
    }
}

/// Where a state came from: the poll, the operator's acknowledgement (selecting a session
/// that needed attention turns it `Idle` with source `Ack`), or the app itself (`App`, Story
/// 4.2: a launch, its first PTY output, its PTY exit), or a Claude Code hook (`Hook`, Story
/// 4.3; also the keypress that answers a prompt in the session's terminal).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StateSource {
    Poll,
    Ack,
    App,
    Hook,
}

/// One session as the live map holds it (and `sessions://live` carries it).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LiveSession {
    pub state: SessionState,
    pub source: StateSource,
    pub pid: Option<u64>,
    pub kind: Option<String>,
    pub name: Option<String>,
    /// The project whose folder is the session's `cwd`; `None` for an Elsewhere row.
    pub project_id: Option<String>,
    pub cwd: String,
    /// The row's `startedAt`, milliseconds since the epoch.
    pub started_at: Option<i64>,
    /// When the session entered `Finished` / `Waiting` (milliseconds since the epoch); `None`
    /// in every other state. `attention.next` goes to the oldest first.
    pub attention_since: Option<i64>,
    /// A `finished` session's last assistant line (from the `Stop` hook, Story 4.3), cut to
    /// 200 characters; `None` in every other state.
    pub last_line: Option<String>,
    /// A `waiting` session's reason (the hook's message), the card's tooltip; `None` in every
    /// other state.
    pub detail: Option<String>,
}

/// A session that has just entered `Finished` or `Waiting`: what [`LiveMap::apply_at`]
/// returns for the toast decision (`crate::notify::decide`). The two labels are filled in by
/// [`apply_and_emit`] from the workspace (they are `None` straight out of `apply_at`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Transition {
    pub session_id: String,
    /// `Finished` or `Waiting`.
    pub state: SessionState,
    /// The project the session belongs to; `None` for an Elsewhere session.
    pub project_id: Option<String>,
    pub cwd: String,
    /// The poll row's `name`.
    pub name: Option<String>,
    /// The project's label, when the session has a project.
    pub project_label: Option<String>,
    /// The discovered transcript's title, when there is one.
    pub title: Option<String>,
}

/// A live session in a folder that is not on the canvas: one row of the Elsewhere tray.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ElsewhereRow {
    pub session_id: String,
    pub state: SessionState,
    pub name: Option<String>,
    pub cwd: String,
    pub started_at: Option<i64>,
}

/// What `live_sessions_get` returns and `sessions://live` carries: every session seen this
/// run by id (exited ones with state `exited`), the Elsewhere rows (live sessions with no
/// project, newest first) and the poll-failure banner text, if any.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct LiveSnapshot {
    pub sessions: BTreeMap<String, LiveSession>,
    pub elsewhere: Vec<ElsewhereRow>,
    pub banner: Option<String>,
}

/// The in-memory live map. Never persisted.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct LiveMap {
    /// Every session seen this run, live or exited.
    pub sessions: BTreeMap<String, LiveSession>,
    /// Ids of the sessions that dropped out of a successful poll and have not come back.
    pub exited: HashSet<String>,
    /// The same ids in the order they exited, oldest first; capped at [`MAX_EXITED`].
    pub exited_order: VecDeque<String>,
    /// Failed polls in a row.
    pub failures: u32,
    /// The banner text after [`FAILURES_FOR_BANNER`] failures in a row.
    pub banner: Option<String>,
    /// Ids of the sessions polled `busy` since they were last polled `idle` (an `Other` status
    /// in between keeps the mark), so the next `idle` is a finished turn. Memory only.
    pub busy_seen: HashSet<String>,
    /// Ids of the sessions the app launched whose PTY child still runs (Story 4.2): missing
    /// from a poll, such a session is carried over unchanged instead of turning exited.
    pub app_running: HashSet<String>,
    /// App-launched sessions whose PTY child has exited, with when (ms since the epoch): a
    /// poll row for one (the CLI lags a moment behind the exit) does not bring it back. An entry
    /// expires after [`APP_EXITED_TTL_MS`] (or with the session's eviction); a new launch of
    /// the id clears it.
    pub app_exited: HashMap<String, i64>,
    /// Hooked sessions (Story 4.3: at least one hook event accepted), each with how many polls
    /// in a row disagreed with its hook state since the last hook event. The poll's busy → idle
    /// `finished` guess does not apply to these.
    pub hooked: HashMap<String, u8>,
    /// What each hooked `Waiting` session waits for (it decides the answering keys).
    pub waits: HashMap<String, WaitKind>,
    /// When each session last left `waiting` through a terminal answer (ms since the epoch).
    pub answered: HashMap<String, i64>,
    /// Times the poll overrode a hooked session's state (Settings → Diagnostics).
    pub poll_overrides: u64,
}

/// How long a poll row for an app-launched session whose process exited is ignored.
pub const APP_EXITED_TTL_MS: i64 = 10_000;

/// Disagreeing polls in a row (with no hook event between) before the poll wins.
pub const POLLS_TO_OVERRIDE: u8 = 2;

/// A `Notification` wait this soon (ms) after the session left `waiting` through a terminal
/// answer is the late notice of the answered prompt (it fires ~6 s after the dialog) and is
/// ignored.
pub const LATE_NOTIFICATION_MS: i64 = 10_000;

/// Whether a poll's state agrees with a hooked session's hook state (Story 4.3): `busy`/busy,
/// `waiting`/busy, `waiting`/idle, `finished`/idle, `idle`/idle, `starting`/anything,
/// `finished` or `waiting` with an `Other` status (which the 3.3 fold would keep anyway), and any
/// state the poll reports verbatim (an `Other` status equal to the one held).
pub fn hook_agrees(hook: &SessionState, polled: &SessionState) -> bool {
    use SessionState::*;
    matches!(
        (hook, polled),
        (Busy, Busy)
            | (Waiting, Busy)
            | (Waiting, Idle)
            | (Finished, Idle)
            | (Idle, Idle)
            | (Starting, _)
            | (Finished | Waiting, Other { .. })
    ) || hook == polled
}

/// A key that can answer a waiting prompt in the terminal.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AnswerKey {
    /// Enter (`\r`, or `\n` / `\r\n`).
    Enter,
    /// A lone Esc.
    Esc,
    /// A digit, or `y` / `n` (either case): a menu choice.
    Choice,
}

/// The answer key a terminal write is, when it is exactly one such key press. Anything else —
/// pasted text, several keys, terminal reply sequences (CSI, OSC, DCS, focus and mouse reports),
/// bracketed paste, Esc followed by anything — is `None`.
pub fn answer_key(data: &str) -> Option<AnswerKey> {
    match data {
        "\r" | "\n" | "\r\n" => Some(AnswerKey::Enter),
        "\u{1b}" => Some(AnswerKey::Esc),
        _ => {
            let mut chars = data.chars();
            match (chars.next(), chars.next()) {
                (Some(c), None) if c.is_ascii_digit() || matches!(c, 'y' | 'Y' | 'n' | 'N') => Some(AnswerKey::Choice),
                _ => None,
            }
        }
    }
}

impl LiveMap {
    /// [`LiveMap::apply_at`] at the current time.
    pub fn apply(&mut self, polled: Result<Vec<LiveRow>, String>, workspace: &Workspace) -> Vec<Transition> {
        self.apply_at(polled, workspace, now_ms())
    }

    /// Fold one poll into the map at `now` (milliseconds since the epoch). `Ok(rows)`: every
    /// row becomes (or stays) live with its project re-matched against `workspace`; a session
    /// known before and missing now turns exited (and keeps its last facts; only the
    /// [`MAX_EXITED`] most recent exits are kept); the failure count and banner reset.
    /// `Err(cause)`: the map is kept as it is, the failure is counted and, from the third in a
    /// row, the banner names the latest cause.
    ///
    /// The `finished` rule (Story 3.3): a row reporting `idle` for a session polled `busy`
    /// since it was last `idle` (an `Other` status such as `compacting` in between does not
    /// break that) turns `Finished` (stamped `attention_since = now`) and stays `Finished`
    /// while the poll keeps reporting `idle` or an `Other` status; it becomes `Busy` on the
    /// next `busy`, `Exited` when it drops out and `Idle` when acknowledged
    /// ([`LiveMap::acknowledge`], which holds until the next `busy`). A session first seen
    /// `idle` is `Idle`; an `Other` status itself never turns `Finished`. `Waiting` (hooks
    /// only, Story 4.3) is left alone by `idle` and `Other` polls. A session listed twice in
    /// one poll counts once (the first row wins).
    ///
    /// Returns the sessions that entered `Finished` / `Waiting` with this poll (none on a
    /// failure, a startup `idle`, or for a session already in that state).
    pub fn apply_at(&mut self, polled: Result<Vec<LiveRow>, String>, workspace: &Workspace, now: i64) -> Vec<Transition> {
        let rows = match polled {
            Ok(rows) => rows,
            Err(cause) => {
                self.failures = self.failures.saturating_add(1);
                if self.failures >= FAILURES_FOR_BANNER {
                    self.banner = Some(format!("live session status unavailable: {cause}"));
                }
                return Vec::new();
            }
        };
        self.app_exited.retain(|_, at| now.saturating_sub(*at) <= APP_EXITED_TTL_MS);
        let mut transitions = Vec::new();
        let mut next: BTreeMap<String, LiveSession> = BTreeMap::new();
        for row in rows {
            if next.contains_key(&row.session_id) || self.app_exited.contains_key(&row.session_id) {
                continue;
            }
            let project_id = graph::project_for_cwd(workspace, &row.cwd);
            let previous = self.sessions.get(&row.session_id);
            let polled = SessionState::from_status(row.status.as_deref());
            let busy_seen = match polled {
                SessionState::Busy => true,
                SessionState::Idle => false,
                _ => self.busy_seen.contains(&row.session_id),
            };
            let hooked = self.hooked.get(&row.session_id).copied();
            let (state, source, attention_since, last_line, detail) = match (previous, hooked) {
                // A hooked session (Story 4.3): the hook state stands while the poll agrees; two
                // disagreeing polls in a row with no hook event between, and the poll wins.
                (Some(p), Some(disagreed)) if p.state != SessionState::Starting => {
                    let keep = (p.state.clone(), p.source, p.attention_since, p.last_line.clone(), p.detail.clone());
                    if hook_agrees(&p.state, &polled) {
                        self.hooked.insert(row.session_id.clone(), 0);
                        keep
                    } else if disagreed.saturating_add(1) < POLLS_TO_OVERRIDE {
                        self.hooked.insert(row.session_id.clone(), disagreed.saturating_add(1));
                        keep
                    } else {
                        self.hooked.insert(row.session_id.clone(), 0);
                        // No busy → idle guess for a hooked session.
                        let (state, _, since) = fold_state(previous, polled.clone(), false, now);
                        // Counted only when the poll changed the state; either way it is now the
                        // poll's.
                        if state != p.state {
                            self.poll_overrides = self.poll_overrides.saturating_add(1);
                            self.waits.remove(&row.session_id);
                        }
                        let (last_line, detail) = carried(p, &state);
                        (state, StateSource::Poll, since, last_line, detail)
                    }
                }
                _ => {
                    let was_busy = hooked.is_none()
                        && (self.busy_seen.contains(&row.session_id) || previous.is_some_and(|p| p.state == SessionState::Busy));
                    let (state, source, since) = fold_state(previous, polled.clone(), was_busy, now);
                    let (last_line, detail) = previous.map(|p| carried(p, &state)).unwrap_or_default();
                    (state, source, since, last_line, detail)
                }
            };
            if busy_seen {
                self.busy_seen.insert(row.session_id.clone());
            } else {
                self.busy_seen.remove(&row.session_id);
            }
            if state.needs_attention() && !previous.is_some_and(|p| p.state.needs_attention()) {
                transitions.push(Transition {
                    session_id: row.session_id.clone(),
                    state: state.clone(),
                    project_id: project_id.clone(),
                    cwd: row.cwd.clone(),
                    name: row.name.clone(),
                    project_label: None,
                    title: None,
                });
            }
            next.insert(
                row.session_id.clone(),
                LiveSession {
                    state,
                    source,
                    pid: row.pid,
                    kind: row.kind,
                    name: row.name,
                    project_id,
                    cwd: row.cwd,
                    started_at: row.started_at,
                    attention_since,
                    last_line,
                    detail,
                },
            );
        }
        // Sessions that came back are live again; they leave the exit order.
        self.exited_order.retain(|id| !next.contains_key(id));
        // A session that dropped out starts afresh if it comes back.
        self.busy_seen.retain(|id| next.contains_key(id));
        for (id, previous) in &self.sessions {
            if next.contains_key(id) {
                continue;
            }
            // The app's own child still runs (or has exited, and said so): the poll gap is not
            // an exit.
            if self.app_running.contains(id) || self.app_exited.contains_key(id) {
                next.insert(id.clone(), previous.clone());
                continue;
            }
            let mut gone = previous.clone();
            if gone.state.is_live() {
                self.exited_order.push_back(id.clone());
            }
            gone.state = SessionState::Exited;
            gone.source = StateSource::Poll;
            gone.attention_since = None;
            gone.last_line = None;
            gone.detail = None;
            gone.project_id = graph::project_for_cwd(workspace, &gone.cwd);
            next.insert(id.clone(), gone);
        }
        while self.exited_order.len() > MAX_EXITED {
            if let Some(oldest) = self.exited_order.pop_front() {
                next.remove(&oldest);
                self.app_exited.remove(&oldest);
            }
        }
        self.exited = self.exited_order.iter().cloned().collect();
        self.sessions = next;
        self.failures = 0;
        self.banner = None;
        transitions
    }

    /// The app launched session `id` in `cwd` (the project's folder) under `project_id`, named
    /// `name`, at `started_at` (ms since the epoch): it is `Starting` (source `App`) at once,
    /// and app-running until [`LiveMap::process_exited`]. Any earlier record of the id is
    /// replaced.
    pub fn launched(&mut self, id: &str, project_id: Option<String>, cwd: &str, name: &str, started_at: i64) {
        self.sessions.insert(
            id.to_string(),
            LiveSession {
                state: SessionState::Starting,
                source: StateSource::App,
                pid: None,
                kind: Some("interactive".to_string()),
                name: Some(name.to_string()),
                project_id,
                cwd: cwd.to_string(),
                started_at: Some(started_at),
                attention_since: None,
                last_line: None,
                detail: None,
            },
        );
        self.exited_order.retain(|known| known != id);
        self.exited.remove(id);
        self.busy_seen.remove(id);
        self.app_exited.remove(id);
        self.forget_hooks(id);
        self.app_running.insert(id.to_string());
    }

    /// Drop session `id`'s hook bookkeeping (hooked mark, wait kind, last terminal answer).
    fn forget_hooks(&mut self, id: &str) {
        self.hooked.remove(id);
        self.waits.remove(id);
        self.answered.remove(id);
    }

    /// The hooks endpoint failed: no hook will arrive, so every session goes back to the
    /// poll's Story 3.3 rules (the busy → idle guess included).
    pub fn clear_hooked(&mut self) {
        self.hooked.clear();
        self.waits.clear();
        self.answered.clear();
    }

    /// Apply one hook event's `signal` to session `id` at `now` (source `Hook`). The first
    /// accepted event makes the session hooked (the poll's busy → idle guess off, reconciliation
    /// on); every event resets its disagreeing-poll count.
    /// - `Started` turns `Starting` into `Idle`.
    /// - `Prompted` makes it busy; `ToolDone` too, except that a `Waiting` session stays waiting
    ///   (a parallel tool or a subagent finishing does not answer the prompt).
    /// - `Waiting` waits (keeping `detail` and the wait's kind); a `Notification` within
    ///   [`LATE_NOTIFICATION_MS`] of a terminal answer is ignored (it was about the answered
    ///   prompt).
    /// - `Finished` finishes (keeping `last_line`).
    ///
    /// Entering `Waiting` / `Finished` stamps `attention_since` and is returned as a transition,
    /// as for the poll. An unknown or exited session is left alone.
    pub fn apply_hook(&mut self, id: &str, signal: &HookSignal, now: i64) -> Vec<Transition> {
        let Some(session) = self.sessions.get_mut(id) else {
            return Vec::new();
        };
        if !session.state.is_live() {
            return Vec::new();
        }
        self.hooked.insert(id.to_string(), 0);
        self.busy_seen.remove(id);
        let before = session.state.clone();
        let busy = |session: &mut LiveSession| {
            session.state = SessionState::Busy;
            session.source = StateSource::Hook;
            session.attention_since = None;
            session.last_line = None;
            session.detail = None;
        };
        match signal {
            HookSignal::Started => {
                if session.state != SessionState::Starting {
                    return Vec::new();
                }
                session.state = SessionState::Idle;
                session.source = StateSource::Hook;
            }
            HookSignal::Prompted => busy(session),
            HookSignal::ToolDone => {
                if session.state == SessionState::Waiting {
                    return Vec::new();
                }
                busy(session);
            }
            HookSignal::Waiting { kind, detail, notification } => {
                let late = self.answered.get(id).is_some_and(|at| now.saturating_sub(*at) < LATE_NOTIFICATION_MS);
                if *notification && late && session.state != SessionState::Waiting {
                    return Vec::new();
                }
                if session.state != SessionState::Waiting {
                    session.state = SessionState::Waiting;
                    session.attention_since = Some(now);
                }
                session.source = StateSource::Hook;
                session.detail = detail.clone();
                session.last_line = None;
                self.waits.insert(id.to_string(), *kind);
            }
            HookSignal::Finished { last_line } => {
                if session.state != SessionState::Finished {
                    session.state = SessionState::Finished;
                    session.attention_since = Some(now);
                }
                session.source = StateSource::Hook;
                session.last_line = last_line.clone();
                session.detail = None;
            }
        }
        if session.state != SessionState::Waiting {
            self.waits.remove(id);
        }
        if session.state.needs_attention() && session.state != before {
            vec![Transition {
                session_id: id.to_string(),
                state: session.state.clone(),
                project_id: session.project_id.clone(),
                cwd: session.cwd.clone(),
                name: session.name.clone(),
                project_label: None,
                title: None,
            }]
        } else {
            Vec::new()
        }
    }

    /// [`LiveMap::terminal_input_at`] at the current time.
    pub fn terminal_input(&mut self, id: &str, data: &str) -> bool {
        self.terminal_input_at(id, data, now_ms())
    }

    /// The operator wrote `data` to session `id`'s terminal at `now`. While it is `Waiting`, a
    /// single-key write ([`answer_key`]) answers the prompt at once (source `Hook`; the tool's
    /// `PostToolUse` only arrives after it ran): on a permission wait Enter, a digit or `y`/`n`
    /// turns it `Busy` and a lone Esc (a rejection, which ends the turn) `Idle`; on an
    /// elicitation or `agent_needs_input` wait only Enter counts (`Busy`). Returns whether
    /// anything changed.
    pub fn terminal_input_at(&mut self, id: &str, data: &str, now: i64) -> bool {
        let Some(session) = self.sessions.get_mut(id).filter(|s| s.state == SessionState::Waiting) else {
            return false;
        };
        let Some(key) = answer_key(data) else {
            return false;
        };
        let kind = self.waits.get(id).copied().unwrap_or(WaitKind::Permission);
        let state = match (kind, key) {
            (WaitKind::Permission, AnswerKey::Esc) => SessionState::Idle,
            (WaitKind::Permission, _) | (WaitKind::Input, AnswerKey::Enter) => SessionState::Busy,
            (WaitKind::Input, _) => return false,
        };
        session.state = state;
        session.source = StateSource::Hook;
        session.attention_since = None;
        session.detail = None;
        session.last_line = None;
        self.waits.remove(id);
        self.answered.insert(id.to_string(), now);
        if let Some(count) = self.hooked.get_mut(id) {
            *count = 0;
        }
        true
    }


    /// Session `id`'s PTY printed its first output: `Starting` turns `Idle` (source `App`).
    /// Returns whether anything changed (a poll row may have got there first).
    pub fn first_output(&mut self, id: &str) -> bool {
        match self.sessions.get_mut(id) {
            Some(session) if session.state == SessionState::Starting => {
                session.state = SessionState::Idle;
                session.source = StateSource::App;
                true
            }
            _ => false,
        }
    }

    /// [`LiveMap::process_exited_at`] at the current time.
    pub fn process_exited(&mut self, id: &str) -> bool {
        self.process_exited_at(id, now_ms())
    }

    /// Session `id`'s PTY child exited at `now`: it is no longer app-running and turns `Exited`
    /// (source `App`) at once, without waiting for the poll. Returns whether anything changed.
    pub fn process_exited_at(&mut self, id: &str, now: i64) -> bool {
        let was_running = self.app_running.remove(id);
        if was_running {
            self.app_exited.insert(id.to_string(), now);
        }
        let Some(session) = self.sessions.get_mut(id) else {
            return false;
        };
        if !session.state.is_live() {
            return false;
        }
        session.state = SessionState::Exited;
        session.source = StateSource::App;
        session.attention_since = None;
        session.last_line = None;
        session.detail = None;
        self.busy_seen.remove(id);
        self.forget_hooks(id);
        self.exited_order.push_back(id.to_string());
        while self.exited_order.len() > MAX_EXITED {
            if let Some(oldest) = self.exited_order.pop_front() {
                self.sessions.remove(&oldest);
                self.app_exited.remove(&oldest);
            }
        }
        self.exited = self.exited_order.iter().cloned().collect();
        true
    }

    /// The map after `claude` stopped being found: everything the poll put there goes, but the
    /// sessions the app launched (running, or exited moments ago) stay, with both app sets.
    pub fn cleared_keeping_app(&self) -> LiveMap {
        let ours = |id: &String| self.app_running.contains(id) || self.app_exited.contains_key(id);
        let sessions: BTreeMap<String, LiveSession> =
            self.sessions.iter().filter(|(id, _)| ours(id)).map(|(id, s)| (id.clone(), s.clone())).collect();
        let exited_order: VecDeque<String> = self.exited_order.iter().filter(|id| sessions.contains_key(*id)).cloned().collect();
        LiveMap {
            exited: exited_order.iter().cloned().collect(),
            exited_order,
            sessions,
            app_running: self.app_running.clone(),
            app_exited: self.app_exited.clone(),
            hooked: self.hooked.iter().filter(|(id, _)| ours(id)).map(|(id, n)| (id.clone(), *n)).collect(),
            waits: self.waits.iter().filter(|(id, _)| ours(id)).map(|(id, k)| (id.clone(), *k)).collect(),
            answered: self.answered.iter().filter(|(id, _)| ours(id)).map(|(id, t)| (id.clone(), *t)).collect(),
            poll_overrides: self.poll_overrides,
            ..LiveMap::default()
        }
    }

    /// Forget session `id` entirely (a launch whose process never started).
    pub fn forget(&mut self, id: &str) {
        self.sessions.remove(id);
        self.app_running.remove(id);
        self.app_exited.remove(id);
        self.busy_seen.remove(id);
        self.forget_hooks(id);
        self.exited.remove(id);
        self.exited_order.retain(|known| known != id);
    }

    /// The operator selected `id`, which they saw needing attention since `seen_since`: a
    /// session in `Finished` or `Waiting` with that same `attention_since` turns `Idle` with
    /// source `Ack` (and stays so until the poll next reports `busy`). Returns whether anything
    /// changed; any other state, a different `attention_since` (a newer turn the operator has
    /// not seen) or an unknown id is a no-op.
    pub fn acknowledge(&mut self, id: &str, seen_since: Option<i64>) -> bool {
        match self.sessions.get_mut(id) {
            Some(session) if session.state.needs_attention() && session.attention_since == seen_since => {
                session.state = SessionState::Idle;
                session.source = StateSource::Ack;
                session.attention_since = None;
                session.last_line = None;
                session.detail = None;
                self.waits.remove(id);
                true
            }
            _ => false,
        }
    }

    /// The map as the frontend sees it.
    pub fn snapshot(&self) -> LiveSnapshot {
        let mut elsewhere: Vec<ElsewhereRow> = self
            .sessions
            .iter()
            .filter(|(_, s)| s.project_id.is_none() && s.state.is_live())
            .map(|(id, s)| ElsewhereRow {
                session_id: id.clone(),
                state: s.state.clone(),
                name: s.name.clone(),
                cwd: s.cwd.clone(),
                started_at: s.started_at,
            })
            .collect();
        elsewhere.sort_by(|a, b| b.started_at.cmp(&a.started_at).then_with(|| a.session_id.cmp(&b.session_id)));
        LiveSnapshot {
            sessions: self.sessions.clone(),
            elsewhere,
            banner: self.banner.clone(),
        }
    }

    /// The sessions placed under a project, by project id, each list ordered by id: what
    /// `graph::set_live_children` stores. Only identity and placement are carried, never the
    /// state word, so a busy ↔ idle flip leaves it equal.
    pub fn live_children(&self) -> HashMap<String, Vec<LiveChild>> {
        let mut out: HashMap<String, Vec<LiveChild>> = HashMap::new();
        // `sessions` is a BTreeMap: iteration is by id, so each list comes out ordered.
        for (id, session) in &self.sessions {
            let Some(project_id) = &session.project_id else {
                continue;
            };
            out.entry(project_id.clone()).or_default().push(LiveChild {
                id: id.clone(),
                name: session.name.clone(),
                started_at_ms: session.started_at,
                cwd: session.cwd.clone(),
                live: session.state.is_live(),
            });
        }
        out
    }
}

/// The state a polled status leaves a session in, given what the map held for it before and
/// whether it was polled `busy` since it was last `idle` (see [`LiveMap::apply_at`]):
/// `(state, source, attention_since)`.
fn fold_state(previous: Option<&LiveSession>, polled: SessionState, was_busy: bool, now: i64) -> (SessionState, StateSource, Option<i64>) {
    let keep_attention = |p: &LiveSession| (p.state.clone(), p.source, p.attention_since.or(Some(now)));
    let attention = previous.filter(|p| p.state.needs_attention());
    match (&polled, attention) {
        (SessionState::Idle, _) => {}
        // An `Other` status leaves an unacknowledged `Finished` / `Waiting` in place.
        (SessionState::Other { .. }, Some(p)) => return keep_attention(p),
        _ => return (polled, StateSource::Poll, None),
    }
    match previous {
        Some(p) if p.state.needs_attention() => keep_attention(p),
        _ if was_busy => (SessionState::Finished, StateSource::Poll, Some(now)),
        // An acknowledged session stays acknowledged while the poll keeps reporting `idle`.
        Some(p) if p.state == SessionState::Idle && p.source == StateSource::Ack => (SessionState::Idle, StateSource::Ack, None),
        _ => (SessionState::Idle, StateSource::Poll, None),
    }
}

/// The `last_line` and `detail` a session keeps after a poll: the previous ones while it stays
/// in the same attention state (an unacknowledged `Finished` / `Waiting`), else none.
fn carried(previous: &LiveSession, state: &SessionState) -> (Option<String>, Option<String>) {
    if state.needs_attention() && *state == previous.state {
        (previous.last_line.clone(), previous.detail.clone())
    } else {
        (None, None)
    }
}

/// Milliseconds since the epoch.
pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
        .unwrap_or(0)
}

// ---------------------------------------------------------------------------------------
// Polling
// ---------------------------------------------------------------------------------------

/// Run `claude agents --json --all` once (stdin closed, no console window, killed after
/// `timeout`) and parse its rows. A spawn failure, a timeout, a non-zero exit or output that
/// is not a JSON array is an `Err` with a cause fit for the banner.
pub fn poll_once(claude: &Path, timeout: Duration) -> Result<Vec<LiveRow>, String> {
    let mut cmd = Command::new(claude);
    cmd.args(AGENTS_ARGS);
    let done = process::run(cmd, timeout).map_err(|err| describe(&err))?;
    let done = done.success().map_err(|err| describe(&err))?;
    parse_rows(&done.stdout)
}

fn describe(err: &RunError) -> String {
    format!("claude agents: {err}")
}

/// The time between polls: `poll.agents_ms`, never below [`MIN_INTERVAL_MS`].
pub fn interval(settings: &SettingsState) -> Duration {
    Duration::from_millis(settings.settings.poll.agents_ms.max(MIN_INTERVAL_MS))
}

/// The `claude` to run, only while detection says it is `found`.
pub fn claude_binary(settings: &SettingsState) -> Option<std::path::PathBuf> {
    let claude = &settings.binaries.claude;
    match (&claude.status, &claude.path) {
        (BinaryStatus::Found, Some(path)) => Some(std::path::PathBuf::from(path)),
        _ => None,
    }
}

/// Start the poll loop on Tauri's async runtime. Called once from `setup`; it runs for the
/// life of the app. The interval is re-read each tick.
pub fn start<R: Runtime>(app: AppHandle<R>) {
    tauri::async_runtime::spawn(async move {
        loop {
            refresh(&app).await;
            let wait = interval(&app.state::<AppState>().read());
            tokio::time::sleep(wait).await;
        }
    });
}

/// One poll: run the CLI on a blocking thread (no lock held), fold the result into the map
/// against the current workspace, emit `sessions://live` when the snapshot changed, and hand
/// the per-project children to `graph::set_live_children` (which emits only on change).
/// Polls are serialised by `AppState::live_lock`. No poll runs while `claude` is not
/// `found`; a map left from when it was is cleared then (no sessions, exited ones or banner),
/// announced on both channels. Returns the snapshot after the poll.
pub async fn refresh<R: Runtime>(app: &AppHandle<R>) -> LiveSnapshot {
    let state = app.state::<AppState>();
    let _pass = state.live_lock.lock().await;
    let Some(claude) = claude_binary(&state.read()) else {
        let mut map = state.write_sessions_live();
        let kept = map.cleared_keeping_app();
        if *map != kept {
            *map = kept;
            // Announced under the map lock, so snapshots go out in the order they were made.
            emit_live(app, &map.snapshot());
            graph::set_live_children(app, map.live_children());
        }
        return map.snapshot();
    };
    let polled = tauri::async_runtime::spawn_blocking(move || poll_once(&claude, RUN_TIMEOUT))
        .await
        .unwrap_or_else(|err| Err(format!("claude agents: poll thread failed: {err}")));
    apply_and_emit(app, polled)
}

/// Fold `polled` into the stored map and emit what changed (see [`refresh`]); then hand the
/// sessions that entered `Finished` / `Waiting`, labelled from the workspace, to the toast
/// decision (`crate::notify::on_transitions`).
pub fn apply_and_emit<R: Runtime>(app: &AppHandle<R>, polled: Result<Vec<LiveRow>, String>) -> LiveSnapshot {
    let state = app.state::<AppState>();
    let workspace = state.read_workspace().workspace.clone();
    let (after, mut transitions) = {
        let mut map = state.write_sessions_live();
        let before = map.snapshot();
        let transitions = map.apply(polled, &workspace);
        let after = map.snapshot();
        // Announced under the map lock: a launched session's first-output or exit change made
        // on a PTY thread can never be overtaken by an older snapshot.
        if after != before {
            emit_live(app, &after);
        }
        graph::set_live_children(app, map.live_children());
        (after, transitions)
    };
    notify_transitions(app, &mut transitions);
    after
}

/// Apply hook event `signal` to session `id` (Story 4.3; called by the hooks endpoint): under
/// the map's write lock the state changes and, when the snapshot changed, `sessions://live`
/// goes out at once; a session entering `Finished` / `Waiting` goes to the same toast decision
/// as the poll's transitions. Returns the snapshot after.
pub fn hook_and_emit<R: Runtime>(app: &AppHandle<R>, id: &str, signal: super::hooks::HookSignal) -> LiveSnapshot {
    let state = app.state::<AppState>();
    let (after, mut transitions) = {
        let mut map = state.write_sessions_live();
        let before = map.snapshot();
        let transitions = map.apply_hook(id, &signal, now_ms());
        let after = map.snapshot();
        if after != before {
            emit_live(app, &after);
        }
        (after, transitions)
    };
    notify_transitions(app, &mut transitions);
    after
}

/// The operator typed `data` into session `id`'s terminal: a waiting session answered in the
/// terminal turns busy at once ([`LiveMap::terminal_input`]), announced on `sessions://live`.
pub fn terminal_input_and_emit<R: Runtime>(app: &AppHandle<R>, id: &str, data: &str) {
    let state = app.state::<AppState>();
    // Most keystrokes change nothing: look before taking the write lock.
    if state.read_sessions_live().sessions.get(id).is_none_or(|s| s.state != SessionState::Waiting) {
        return;
    }
    update_and_emit(app, |map| map.terminal_input(id, data));
}

/// Label `transitions` from the workspace (project label, transcript title) and hand them to
/// the toast decision (`crate::notify::on_transitions`).
fn notify_transitions<R: Runtime>(app: &AppHandle<R>, transitions: &mut [Transition]) {
    let state = app.state::<AppState>();
    if !transitions.is_empty() {
        {
            let ws = state.read_workspace();
            for transition in transitions.iter_mut() {
                transition.project_label = transition
                    .project_id
                    .as_ref()
                    .and_then(|id| ws.workspace.projects.iter().find(|p| &p.id == id))
                    .map(|p| p.label.clone());
                transition.title = ws
                    .discovered
                    .values()
                    .flatten()
                    .find(|s| s.id == transition.session_id)
                    .map(|s| s.title.clone())
                    .filter(|t| t != super::transcript::UNTITLED);
            }
        }
        crate::notify::on_transitions(app, transitions);
    }
}

/// Change the stored map with `change` (which says whether it changed anything) and, when it
/// did, emit `sessions://live` and hand the per-project children to `graph::set_live_children`
/// (Story 4.2's launch, first output and exit). Returns the snapshot after.
pub fn update_and_emit<R: Runtime>(app: &AppHandle<R>, change: impl FnOnce(&mut LiveMap) -> bool) -> LiveSnapshot {
    let state = app.state::<AppState>();
    let mut map = state.write_sessions_live();
    let changed = change(&mut map);
    let snapshot = map.snapshot();
    if changed {
        // Under the map lock, so two threads' changes go out in the order they were made.
        emit_live(app, &snapshot);
        graph::set_live_children(app, map.live_children());
    }
    snapshot
}

/// Emit `sessions://live` (callers hold the map's write lock, which orders the events).
fn emit_live<R: Runtime>(app: &AppHandle<R>, snapshot: &LiveSnapshot) {
    if let Err(err) = app.emit(LIVE_EVENT, snapshot) {
        eprintln!("live sessions: emit failed: {err}");
    }
}

/// Acknowledge `id`, seen needing attention since `seen_since` (the operator selected it; see
/// [`LiveMap::acknowledge`]). When that changed anything, emits `sessions://live` and returns
/// the new snapshot (the caller applies it too, so a lost event cannot leave the accent on);
/// else `None`.
pub fn acknowledge<R: Runtime>(app: &AppHandle<R>, id: &str, seen_since: Option<i64>) -> Option<LiveSnapshot> {
    let state = app.state::<AppState>();
    let mut map = state.write_sessions_live();
    if !map.acknowledge(id, seen_since) {
        return None;
    }
    let snapshot = map.snapshot();
    emit_live(app, &snapshot);
    Some(snapshot)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::graph::{ChildKind, Position, Project};
    use crate::process::fixtures::script;
    use crate::settings::Binary;
    use std::sync::mpsc;
    use tauri::Listener;
    use tauri::test::{MockRuntime, mock_builder, mock_context, noop_assets};

    fn mock_app() -> tauri::App<MockRuntime> {
        crate::with_commands(mock_builder())
            .build(mock_context(noop_assets()))
            .expect("mock app should build")
    }

    fn row(id: &str, cwd: &str, status: &str) -> Value {
        serde_json::json!({
            "pid": 40284, "cwd": cwd, "kind": "interactive", "startedAt": 1_791_553_254_656_i64,
            "sessionId": id, "name": format!("name-{id}"), "status": status
        })
    }

    fn ide_path() -> &'static str {
        if cfg!(windows) { "B:\\projects\\ide" } else { "/projects/ide" }
    }

    fn other_path() -> &'static str {
        if cfg!(windows) { "C:\\work\\other" } else { "/work/other" }
    }

    fn workspace_with_ide() -> Workspace {
        Workspace {
            projects: vec![Project {
                id: "ide".into(),
                path: ide_path().into(),
                label: "ide".into(),
                position: Position::default(),
                expanded: true,
                color: None,
                launch_defaults: None,
            }],
            ..Workspace::default()
        }
    }

    /// A `claude` that prints `out`'s contents (whatever its arguments) and exits 0.
    fn printing_claude(dir: &Path, out: &Path) -> std::path::PathBuf {
        script(
            dir,
            "claude",
            &format!("@type \"{}\"\n", out.display()),
            &format!("cat '{}'\n", out.display()),
        )
    }

    fn set_output(out: &Path, rows: &[Value]) {
        std::fs::write(out, serde_json::to_string(&Value::Array(rows.to_vec())).unwrap()).unwrap();
    }

    fn found(app: &tauri::App<MockRuntime>, path: &Path) {
        app.state::<AppState>().write().binaries.claude = Binary {
            name: "claude".into(),
            path: Some(path.display().to_string()),
            version: Some("2.1.302".into()),
            status: BinaryStatus::Found,
            configured: false,
        };
    }

    fn listen(app: &tauri::App<MockRuntime>) -> mpsc::Receiver<LiveSnapshot> {
        let (tx, rx) = mpsc::channel();
        app.listen_any(LIVE_EVENT, move |event| {
            let _ = tx.send(serde_json::from_str(event.payload()).expect("live payload"));
        });
        rx
    }

    fn listen_workspace(app: &tauri::App<MockRuntime>) -> mpsc::Receiver<graph::WorkspaceSnapshot> {
        let (tx, rx) = mpsc::channel();
        app.listen_any(graph::CHANGED_EVENT, move |event| {
            let _ = tx.send(serde_json::from_str(event.payload()).expect("workspace payload"));
        });
        rx
    }

    fn app_with_ide() -> (tauri::App<MockRuntime>, tempfile::TempDir) {
        let app = mock_app();
        let cfg = tempfile::tempdir().unwrap();
        app.state::<AppState>().stub_children.set(0).unwrap();
        graph::initialise_at(app.handle(), Some(cfg.path().join("workspace.json")));
        app.state::<AppState>().write_workspace().workspace = workspace_with_ide();
        (app, cfg)
    }

    #[test]
    fn parse_rows_reads_the_verified_shape_and_skips_rows_without_id_or_cwd() {
        let text = format!(
            "[{}, {{\"cwd\": \"/x\", \"status\": \"idle\"}}, {{\"sessionId\": \"no-cwd\"}}, 7, {{\"sessionId\": \"\", \"cwd\": \"/x\"}},
              {{\"sessionId\": \"odd\", \"cwd\": \"/y\", \"pid\": \"not a number\", \"extra\": {{\"a\": 1}}}}]\n",
            row("s1", "/p", "busy")
        );
        let rows = parse_rows(&text).unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(
            rows[0],
            LiveRow {
                session_id: "s1".into(),
                cwd: "/p".into(),
                pid: Some(40284),
                kind: Some("interactive".into()),
                started_at: Some(1_791_553_254_656),
                name: Some("name-s1".into()),
                status: Some("busy".into()),
            }
        );
        assert_eq!(rows[1].session_id, "odd");
        assert_eq!(rows[1].pid, None, "a field of the wrong type is absent, not fatal");
        assert_eq!(rows[1].status, None);
        assert_eq!(parse_rows("[]"), Ok(vec![]));
        assert!(parse_rows("garbage").unwrap_err().starts_with("unparsable output"));
        assert!(parse_rows("{\"rows\": []}").unwrap_err().contains("not a JSON array"));
    }

    #[test]
    fn statuses_map_to_states_and_unknown_ones_are_kept_verbatim() {
        assert_eq!(SessionState::from_status(Some("busy")), SessionState::Busy);
        assert_eq!(SessionState::from_status(Some("idle")), SessionState::Idle);
        assert_eq!(
            SessionState::from_status(Some("compacting")),
            SessionState::Other { raw: "compacting".into() }
        );
        assert_eq!(SessionState::from_status(Some("waiting")), SessionState::Other { raw: "waiting".into() }, "never from the poll");
        assert!(SessionState::Other { raw: "x".into() }.is_live());
        assert!(!SessionState::Exited.is_live());
        assert_eq!(serde_json::to_value(SessionState::Busy).unwrap(), serde_json::json!({ "kind": "busy" }));
        assert_eq!(
            serde_json::to_value(SessionState::Other { raw: "compacting".into() }).unwrap(),
            serde_json::json!({ "kind": "other", "raw": "compacting" })
        );
    }

    #[test]
    fn apply_tracks_exit_and_return_and_keeps_the_map_on_failure_with_a_banner_after_three() {
        let ws = workspace_with_ide();
        let rows = |status: &str| parse_rows(&Value::Array(vec![row("s1", ide_path(), status)]).to_string());
        let mut map = LiveMap::default();
        map.apply(rows("busy"), &ws);
        assert_eq!(map.sessions["s1"].state, SessionState::Busy);
        assert_eq!(map.sessions["s1"].project_id.as_deref(), Some("ide"));
        map.apply(rows("idle"), &ws);
        assert_eq!(map.sessions["s1"].state, SessionState::Finished, "busy → idle is a finished turn (Story 3.3)");

        // Failures keep the map; nothing turns exited.
        for _ in 0..2 {
            map.apply(Err("claude agents: exit code 1".into()), &ws);
            assert_eq!(map.sessions["s1"].state, SessionState::Finished);
            assert_eq!(map.banner, None, "fewer than three");
        }
        map.apply(Err("claude agents: timed out after 5s".into()), &ws);
        assert_eq!(map.banner.as_deref(), Some("live session status unavailable: claude agents: timed out after 5s"));
        assert_eq!(map.snapshot().banner, map.banner);

        // Missing from a successful poll: exited, kept, banner cleared.
        map.apply(Ok(vec![]), &ws);
        assert_eq!(map.sessions["s1"].state, SessionState::Exited);
        assert_eq!(map.sessions["s1"].name.as_deref(), Some("name-s1"), "last facts kept");
        assert!(map.exited.contains("s1"));
        assert_eq!((map.failures, map.banner.clone()), (0, None));
        map.apply(Ok(vec![]), &ws);
        assert_eq!(map.sessions["s1"].state, SessionState::Exited, "stays exited");

        // Comes back.
        map.apply(rows("busy"), &ws);
        assert_eq!(map.sessions["s1"].state, SessionState::Busy);
        assert!(map.exited.is_empty());
    }

    #[test]
    fn rows_outside_every_project_are_elsewhere_and_move_when_their_folder_is_added() {
        let mut ws = workspace_with_ide();
        let polled = || {
            parse_rows(
                &Value::Array(vec![
                    row("here", ide_path(), "busy"),
                    row("there", other_path(), "compacting"),
                    serde_json::json!({ "sessionId": "older", "cwd": other_path(), "status": "idle", "startedAt": 5 }),
                ])
                .to_string(),
            )
        };
        let mut map = LiveMap::default();
        map.apply(polled(), &ws);
        let snap = map.snapshot();
        let ids: Vec<&str> = snap.elsewhere.iter().map(|r| r.session_id.as_str()).collect();
        assert_eq!(ids, ["there", "older"], "newest first");
        assert_eq!(snap.elsewhere[0].state, SessionState::Other { raw: "compacting".into() });
        assert_eq!(snap.elsewhere[0].cwd, other_path());
        assert_eq!(snap.sessions["there"].project_id, None);
        let kids = map.live_children();
        assert_eq!(kids.len(), 1);
        assert_eq!(kids["ide"][0].id, "here");

        ws.projects.push(Project {
            id: "other".into(),
            path: other_path().into(),
            ..ws.projects[0].clone()
        });
        map.apply(polled(), &ws);
        assert!(map.snapshot().elsewhere.is_empty());
        let kids = map.live_children();
        let ids: Vec<&str> = kids["other"].iter().map(|c| c.id.as_str()).collect();
        assert_eq!(ids, ["older", "there"], "ordered by id");
    }

    #[test]
    fn interval_is_poll_agents_ms_with_a_floor_and_claude_runs_only_when_found() {
        let mut settings = SettingsState::default();
        assert_eq!(interval(&settings), Duration::from_secs(2), "default");
        settings.settings.poll.agents_ms = 10;
        assert_eq!(interval(&settings), Duration::from_millis(MIN_INTERVAL_MS));
        settings.settings.poll.agents_ms = 3_000;
        assert_eq!(interval(&settings), Duration::from_secs(3));

        assert_eq!(claude_binary(&settings), None, "pending");
        settings.binaries.claude.path = Some("/bin/claude".into());
        assert_eq!(claude_binary(&settings), None, "still pending");
        settings.binaries.claude.status = BinaryStatus::VersionFailed;
        assert_eq!(claude_binary(&settings), None);
        settings.binaries.claude.status = BinaryStatus::Found;
        assert_eq!(claude_binary(&settings), Some(std::path::PathBuf::from("/bin/claude")));
    }

    #[test]
    fn poll_once_runs_the_fixture_and_reports_failures() {
        let dir = tempfile::tempdir().unwrap();
        let out = dir.path().join("rows.json");
        set_output(&out, &[row("s1", "/p", "idle")]);
        let claude = printing_claude(dir.path(), &out);
        let rows = poll_once(&claude, RUN_TIMEOUT).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].status.as_deref(), Some("idle"));

        std::fs::write(&out, "Welcome to Claude!\nnot json").unwrap();
        assert!(poll_once(&claude, RUN_TIMEOUT).unwrap_err().contains("unparsable output"));

        let failing = script(dir.path(), "failing", "@echo auth expired 1>&2\n@exit /b 2\n", "echo 'auth expired' >&2\nexit 2\n");
        assert_eq!(poll_once(&failing, RUN_TIMEOUT).unwrap_err(), "claude agents: exit code 2: auth expired");

        let missing = dir.path().join("no-claude.exe");
        assert!(poll_once(&missing, RUN_TIMEOUT).unwrap_err().starts_with("claude agents: could not start it"));

        let hang = script(dir.path(), "hang", "@ping -n 60 127.0.0.1 >nul\n", "exec sleep 60\n");
        assert_eq!(poll_once(&hang, Duration::from_millis(200)).unwrap_err(), "claude agents: timed out after 200ms");
    }

    #[test]
    fn poll_once_passes_agents_json_all() {
        let dir = tempfile::tempdir().unwrap();
        let argv = dir.path().join("argv.txt");
        let claude = script(
            dir.path(),
            "claude",
            &format!("@>\"{}\" echo %*\n@echo []\n", argv.display()),
            &format!("echo \"$@\" > '{}'\necho '[]'\n", argv.display()),
        );
        assert_eq!(poll_once(&claude, RUN_TIMEOUT), Ok(vec![]));
        assert_eq!(std::fs::read_to_string(&argv).unwrap().trim(), "agents --json --all");
    }

    #[test]
    fn refresh_with_a_fixture_claude_follows_busy_idle_exit_and_return_on_both_channels() {
        let (app, cfg) = app_with_ide();
        let before = std::fs::read_to_string(cfg.path().join("workspace.json")).ok();
        let out = cfg.path().join("rows.json");
        let claude = printing_claude(cfg.path(), &out);
        let rx = listen(&app);
        let ws_rx = listen_workspace(&app);
        let revision = || app.state::<AppState>().read_workspace().revision;

        // Not found yet: no poll at all.
        set_output(&out, &[row("s1", ide_path(), "busy")]);
        let snap = tauri::async_runtime::block_on(refresh(app.handle()));
        assert!(snap.sessions.is_empty());
        assert!(rx.try_recv().is_err());

        found(&app, &claude);
        let snap = tauri::async_runtime::block_on(refresh(app.handle()));
        assert_eq!(snap.sessions["s1"].state, SessionState::Busy);
        assert_eq!(rx.try_recv().expect("first poll emits"), snap);
        let ws = ws_rx.try_recv().expect("the live-only child is a workspace change");
        assert_eq!(ws.revision, 1);
        assert_eq!(ws.children.len(), 1);
        assert_eq!(ws.children[0].id, "s1");
        assert_eq!(ws.children[0].kind, ChildKind::Session);
        assert_eq!(ws.children[0].label, "name-s1");

        // The same poll again: nothing on either channel.
        tauri::async_runtime::block_on(refresh(app.handle()));
        assert!(rx.try_recv().is_err());
        assert!(ws_rx.try_recv().is_err());

        // Busy → idle (finished): a live event, no workspace revision.
        set_output(&out, &[row("s1", ide_path(), "idle")]);
        let snap = tauri::async_runtime::block_on(refresh(app.handle()));
        assert_eq!(rx.try_recv().expect("state flip").sessions["s1"].state, SessionState::Finished);
        assert_eq!(snap.sessions["s1"].state, SessionState::Finished);
        assert!(ws_rx.try_recv().is_err(), "no workspace event for a state flip");
        assert_eq!(revision(), 1);

        // Garbage and a non-zero exit: the map is kept, nothing turns exited.
        std::fs::write(&out, "garbage").unwrap();
        tauri::async_runtime::block_on(refresh(app.handle()));
        tauri::async_runtime::block_on(refresh(app.handle()));
        assert!(rx.try_recv().is_err(), "two failures: nothing visible changed");
        let snap = tauri::async_runtime::block_on(refresh(app.handle()));
        assert_eq!(snap.sessions["s1"].state, SessionState::Finished);
        assert!(snap.banner.as_deref().unwrap().starts_with("live session status unavailable: unparsable output"));
        assert_eq!(rx.try_recv().expect("the banner").banner, snap.banner);

        // Missing from a successful poll: exited, still a (historic) child; banner cleared.
        set_output(&out, &[]);
        let snap = tauri::async_runtime::block_on(refresh(app.handle()));
        assert_eq!(snap.sessions["s1"].state, SessionState::Exited);
        assert_eq!(snap.banner, None);
        let ws = ws_rx.try_recv().expect("the session left the live set");
        assert_eq!(ws.revision, 2);
        assert_eq!(ws.children.len(), 1, "stays on the canvas");

        // Back again.
        set_output(&out, &[row("s1", ide_path(), "busy")]);
        let snap = tauri::async_runtime::block_on(refresh(app.handle()));
        assert_eq!(snap.sessions["s1"].state, SessionState::Busy);
        assert_eq!(ws_rx.try_recv().expect("live again").revision, 3);

        assert_eq!(std::fs::read_to_string(cfg.path().join("workspace.json")).ok(), before, "never written");
    }

    #[test]
    fn refresh_keeps_an_unknown_status_and_counts_it_live() {
        let (app, cfg) = app_with_ide();
        let out = cfg.path().join("rows.json");
        set_output(&out, &[row("s1", ide_path(), "compacting"), row("s2", other_path(), "idle")]);
        found(&app, &printing_claude(cfg.path(), &out));
        let snap = tauri::async_runtime::block_on(refresh(app.handle()));
        assert_eq!(snap.sessions["s1"].state, SessionState::Other { raw: "compacting".into() });
        assert_eq!(snap.sessions["s1"].project_id.as_deref(), Some("ide"));
        assert_eq!(snap.elsewhere.len(), 1);
        assert_eq!(snap.elsewhere[0].session_id, "s2");
        assert!(app.state::<AppState>().read_workspace().live_children["ide"][0].live);
    }

    #[test]
    fn blank_status_and_name_are_missing() {
        let rows = parse_rows(r#"[{"sessionId":"s","cwd":"/p","status":"  ","name":"","kind":""}]"#).unwrap();
        assert_eq!((rows[0].status.clone(), rows[0].name.clone(), rows[0].kind.clone()), (None, None, None));
        assert_eq!(
            SessionState::from_status(rows[0].status.as_deref()),
            SessionState::Other { raw: "unknown".into() }
        );
    }

    fn one(status: &str) -> Result<Vec<LiveRow>, String> {
        parse_rows(&Value::Array(vec![row("s1", ide_path(), status)]).to_string())
    }

    fn ids(transitions: &[Transition]) -> Vec<&str> {
        transitions.iter().map(|t| t.session_id.as_str()).collect()
    }

    #[test]
    fn busy_then_idle_is_finished_and_stays_so_while_idle() {
        let ws = workspace_with_ide();
        let mut map = LiveMap::default();
        assert!(map.apply_at(one("busy"), &ws, 10).is_empty());
        let entered = map.apply_at(one("idle"), &ws, 20);
        assert_eq!(ids(&entered), ["s1"], "turn ends");
        assert_eq!(entered[0].state, SessionState::Finished);
        assert_eq!(entered[0].project_id.as_deref(), Some("ide"));
        assert_eq!(map.sessions["s1"].state, SessionState::Finished);
        assert_eq!(map.sessions["s1"].attention_since, Some(20));
        assert_eq!(map.sessions["s1"].source, StateSource::Poll);
        // Still idle: still finished, no new transition, the time kept.
        assert!(map.apply_at(one("idle"), &ws, 30).is_empty());
        assert_eq!(map.sessions["s1"].state, SessionState::Finished);
        assert_eq!(map.sessions["s1"].attention_since, Some(20));
        // A failed poll keeps it.
        assert!(map.apply_at(Err("boom".into()), &ws, 35).is_empty());
        assert_eq!(map.sessions["s1"].state, SessionState::Finished);
        // Busy again.
        assert!(map.apply_at(one("busy"), &ws, 40).is_empty());
        assert_eq!(map.sessions["s1"].state, SessionState::Busy);
        assert_eq!(map.sessions["s1"].attention_since, None);
        assert_eq!(ids(&map.apply_at(one("idle"), &ws, 50)), ["s1"], "a new turn ends: a new transition");
        assert_eq!(map.sessions["s1"].attention_since, Some(50));
        let wire = serde_json::to_value(map.snapshot()).unwrap();
        assert_eq!(wire["sessions"]["s1"]["state"], serde_json::json!({ "kind": "finished" }));
        assert_eq!(wire["sessions"]["s1"]["attention_since"], 50);
    }

    #[test]
    fn a_session_first_seen_idle_is_idle_and_other_statuses_never_finish() {
        let ws = workspace_with_ide();
        let mut map = LiveMap::default();
        assert!(map.apply_at(one("idle"), &ws, 1).is_empty(), "already idle");
        assert_eq!(map.sessions["s1"].state, SessionState::Idle);
        assert!(map.apply_at(one("idle"), &ws, 2).is_empty());
        assert_eq!(map.sessions["s1"].state, SessionState::Idle);

        assert!(map.apply_at(one("compacting"), &ws, 3).is_empty());
        assert_eq!(map.sessions["s1"].state, SessionState::Other { raw: "compacting".into() });
        assert!(map.apply_at(one("idle"), &ws, 4).is_empty(), "idle → other → idle is not a finished turn");
        assert_eq!(map.sessions["s1"].state, SessionState::Idle);

        // Exited, then back idle: not finished either.
        map.apply_at(one("busy"), &ws, 5);
        map.apply_at(Ok(vec![]), &ws, 6);
        assert!(map.apply_at(one("idle"), &ws, 7).is_empty());
        assert_eq!(map.sessions["s1"].state, SessionState::Idle);
    }

    #[test]
    fn busy_then_an_other_status_then_idle_is_finished() {
        let ws = workspace_with_ide();
        let mut map = LiveMap::default();
        map.apply_at(one("busy"), &ws, 1);
        assert!(map.apply_at(one("compacting"), &ws, 2).is_empty());
        assert!(map.apply_at(one("compacting"), &ws, 3).is_empty());
        let entered = map.apply_at(one("idle"), &ws, 4);
        assert_eq!(ids(&entered), ["s1"]);
        assert_eq!(map.sessions["s1"].state, SessionState::Finished);
        assert_eq!(map.sessions["s1"].attention_since, Some(4));
        // Idle cleared the mark: idle → other → idle again is not a second turn.
        map.apply_at(one("busy"), &ws, 5);
        map.apply_at(Ok(vec![]), &ws, 6);
        assert!(map.apply_at(one("idle"), &ws, 7).is_empty(), "exited in between: starts afresh");
    }

    #[test]
    fn an_other_status_keeps_an_unacknowledged_finished_session() {
        let ws = workspace_with_ide();
        let mut map = LiveMap::default();
        map.apply_at(one("busy"), &ws, 1);
        map.apply_at(one("idle"), &ws, 2);
        assert!(map.apply_at(one("compacting"), &ws, 3).is_empty());
        assert_eq!(map.sessions["s1"].state, SessionState::Finished);
        assert_eq!(map.sessions["s1"].attention_since, Some(2));
        assert!(map.apply_at(one("idle"), &ws, 4).is_empty(), "still the same turn: no second toast");
        assert_eq!(map.sessions["s1"].attention_since, Some(2));
    }

    #[test]
    fn a_session_listed_twice_in_one_poll_counts_once() {
        let ws = workspace_with_ide();
        let mut map = LiveMap::default();
        let twice = |a: &str, b: &str| parse_rows(&Value::Array(vec![row("s1", ide_path(), a), row("s1", other_path(), b)]).to_string());
        map.apply_at(twice("busy", "busy"), &ws, 1);
        let entered = map.apply_at(twice("idle", "idle"), &ws, 2);
        assert_eq!(ids(&entered), ["s1"], "one transition");
        assert_eq!(map.sessions["s1"].project_id.as_deref(), Some("ide"), "the first row wins");
        assert!(map.apply_at(twice("busy", "idle"), &ws, 3).is_empty());
        assert_eq!(map.sessions["s1"].state, SessionState::Busy);
    }

    #[test]
    fn a_finished_session_that_drops_out_is_exited() {
        let ws = workspace_with_ide();
        let mut map = LiveMap::default();
        map.apply_at(one("busy"), &ws, 1);
        map.apply_at(one("idle"), &ws, 2);
        assert!(map.apply_at(Ok(vec![]), &ws, 3).is_empty());
        assert_eq!(map.sessions["s1"].state, SessionState::Exited);
        assert_eq!(map.sessions["s1"].attention_since, None);
        assert!(!map.acknowledge("s1", None), "exited: nothing to acknowledge");
    }

    #[test]
    fn acknowledging_a_finished_session_makes_it_idle_until_the_next_busy() {
        let ws = workspace_with_ide();
        let mut map = LiveMap::default();
        map.apply_at(one("busy"), &ws, 1);
        map.apply_at(one("idle"), &ws, 2);
        assert!(!map.acknowledge("s1", Some(1)), "an older turn's acknowledgement is a no-op");
        assert_eq!(map.sessions["s1"].state, SessionState::Finished);
        assert!(map.acknowledge("s1", Some(2)));
        let s = &map.sessions["s1"];
        assert_eq!((s.state.clone(), s.source, s.attention_since), (SessionState::Idle, StateSource::Ack, None));
        assert!(!map.acknowledge("s1", Some(2)), "already idle: a no-op");
        // The poll keeps reporting idle: still the acknowledged idle, no transition.
        assert!(map.apply_at(one("idle"), &ws, 3).is_empty());
        assert_eq!((map.sessions["s1"].state.clone(), map.sessions["s1"].source), (SessionState::Idle, StateSource::Ack));
        // Busy again, then idle: finished again.
        map.apply_at(one("busy"), &ws, 4);
        assert_eq!(map.sessions["s1"].source, StateSource::Poll);
        assert_eq!(ids(&map.apply_at(one("idle"), &ws, 5)), ["s1"]);
        assert_eq!(serde_json::to_value(StateSource::Ack).unwrap(), serde_json::json!("ack"));
    }

    #[test]
    fn acknowledging_a_session_not_in_attention_is_a_no_op() {
        let ws = workspace_with_ide();
        let mut map = LiveMap::default();
        map.apply_at(one("busy"), &ws, 1);
        let before = map.clone();
        assert!(!map.acknowledge("s1", None), "busy");
        assert!(!map.acknowledge("nope", None), "unknown");
        assert_eq!(map, before);
    }

    #[test]
    fn waiting_is_left_alone_by_an_idle_poll_and_can_be_acknowledged() {
        let ws = workspace_with_ide();
        let mut map = LiveMap::default();
        map.apply_at(one("idle"), &ws, 1);
        // Only hooks set `waiting` (Story 4.3); planted here.
        let s = map.sessions.get_mut("s1").unwrap();
        s.state = SessionState::Waiting;
        s.attention_since = Some(1);
        assert!(map.apply_at(one("idle"), &ws, 2).is_empty());
        assert_eq!(map.sessions["s1"].state, SessionState::Waiting);
        assert_eq!(map.sessions["s1"].attention_since, Some(1));
        assert!(map.apply_at(one("compacting"), &ws, 3).is_empty());
        assert_eq!(map.sessions["s1"].state, SessionState::Waiting, "an other status leaves it too");
        assert!(map.acknowledge("s1", Some(1)));
        assert_eq!(map.sessions["s1"].state, SessionState::Idle);
    }

    #[test]
    fn an_elsewhere_session_finishing_is_a_transition_without_a_project() {
        let ws = workspace_with_ide();
        let mut map = LiveMap::default();
        let other = |status: &str| parse_rows(&Value::Array(vec![row("e1", other_path(), status)]).to_string());
        map.apply_at(other("busy"), &ws, 1);
        let entered = map.apply_at(other("idle"), &ws, 2);
        assert_eq!(ids(&entered), ["e1"]);
        assert_eq!(entered[0].project_id, None);
        assert_eq!(entered[0].cwd, other_path());
        assert_eq!(entered[0].name.as_deref(), Some("name-e1"));
        assert_eq!(map.snapshot().elsewhere[0].state, SessionState::Finished);
    }

    #[test]
    fn only_the_most_recent_exits_are_remembered() {
        let ws = workspace_with_ide();
        let mut map = LiveMap::default();
        let rows: Vec<Value> = (0..MAX_EXITED + 5).map(|i| row(&format!("s{i:04}"), ide_path(), "idle")).collect();
        map.apply(parse_rows(&Value::Array(rows).to_string()), &ws);
        // The first five exit first, the rest later: the first five are the oldest exits.
        let later: Vec<Value> = (5..MAX_EXITED + 5).map(|i| row(&format!("s{i:04}"), ide_path(), "idle")).collect();
        map.apply(parse_rows(&Value::Array(later).to_string()), &ws);
        assert_eq!(map.exited.len(), 5);
        map.apply(Ok(vec![]), &ws);
        assert_eq!(map.exited.len(), MAX_EXITED);
        assert_eq!(map.sessions.len(), MAX_EXITED);
        assert!(!map.sessions.contains_key("s0000"), "the oldest exits are dropped");
        assert!(map.sessions.contains_key("s0005"));
        assert_eq!(map.exited_order.len(), MAX_EXITED);
    }

    #[test]
    fn losing_claude_clears_the_map_and_announces_it() {
        let (app, cfg) = app_with_ide();
        let out = cfg.path().join("rows.json");
        set_output(&out, &[row("s1", ide_path(), "busy"), row("s2", other_path(), "idle")]);
        found(&app, &printing_claude(cfg.path(), &out));
        tauri::async_runtime::block_on(refresh(app.handle()));
        assert_eq!(app.state::<AppState>().read_workspace().live_children.len(), 1);
        let rx = listen(&app);

        app.state::<AppState>().write().binaries.claude.status = BinaryStatus::Missing;
        let snap = tauri::async_runtime::block_on(refresh(app.handle()));
        assert_eq!(snap, LiveSnapshot::default());
        assert_eq!(rx.try_recv().expect("the clear is announced"), LiveSnapshot::default());
        assert_eq!(*app.state::<AppState>().read_sessions_live(), LiveMap::default());
        assert!(app.state::<AppState>().read_workspace().live_children.is_empty());
        tauri::async_runtime::block_on(refresh(app.handle()));
        assert!(rx.try_recv().is_err(), "already empty: quiet");
    }

    #[test]
    fn a_launched_session_starts_turns_idle_on_first_output_and_exits_with_its_process() {
        let ws = workspace_with_ide();
        let mut map = LiveMap::default();
        map.launched("s1", Some("ide".into()), ide_path(), "ide-ab12", 100);
        let s = &map.sessions["s1"];
        assert_eq!((s.state.clone(), s.source), (SessionState::Starting, StateSource::App));
        assert_eq!((s.name.as_deref(), s.project_id.as_deref(), s.started_at), (Some("ide-ab12"), Some("ide"), Some(100)));
        assert!(s.state.is_live() && !s.state.needs_attention());
        assert_eq!(map.live_children()["ide"][0].id, "s1", "a live-only child before the first poll");
        assert_eq!(serde_json::to_value(&s.state).unwrap(), serde_json::json!({ "kind": "starting" }));
        assert_eq!(serde_json::to_value(StateSource::App).unwrap(), serde_json::json!("app"));

        // The poll gap: not in `agents --json` yet, so carried over, not exited.
        assert!(map.apply_at(Ok(vec![]), &ws, 1).is_empty());
        assert_eq!(map.sessions["s1"].state, SessionState::Starting);
        assert!(map.exited.is_empty());

        assert!(map.first_output("s1"));
        assert_eq!((map.sessions["s1"].state.clone(), map.sessions["s1"].source), (SessionState::Idle, StateSource::App));
        assert!(!map.first_output("s1"), "once");
        assert!(!map.first_output("nope"));
        map.apply_at(Ok(vec![]), &ws, 2);
        assert_eq!(map.sessions["s1"].state, SessionState::Idle, "still no row: still idle");

        // Poll rows update it as for any session.
        map.apply_at(one("busy"), &ws, 3);
        assert_eq!(map.sessions["s1"].state, SessionState::Busy);
        map.apply_at(Ok(vec![]), &ws, 4);
        assert_eq!(map.sessions["s1"].state, SessionState::Busy, "a gap while its child runs");

        // The PTY exit: exited at once; a late row does not bring it back.
        assert!(map.process_exited("s1"));
        assert_eq!((map.sessions["s1"].state.clone(), map.sessions["s1"].source), (SessionState::Exited, StateSource::App));
        assert!(map.exited.contains("s1"));
        assert!(!map.process_exited("s1"), "once");
        map.apply_at(one("idle"), &ws, 5);
        assert_eq!(map.sessions["s1"].state, SessionState::Exited);
        map.apply_at(Ok(vec![]), &ws, 6);
        assert_eq!(map.sessions["s1"].state, SessionState::Exited);
        assert!(!map.live_children()["ide"][0].live);
    }

    #[test]
    fn a_first_poll_row_turns_a_starting_session_idle_and_forget_drops_it() {
        let ws = workspace_with_ide();
        let mut map = LiveMap::default();
        map.launched("s1", Some("ide".into()), ide_path(), "n", 1);
        assert!(map.apply_at(one("idle"), &ws, 2).is_empty());
        assert_eq!(map.sessions["s1"].state, SessionState::Idle);
        assert_eq!(map.sessions["s1"].source, StateSource::Poll);
        assert!(!map.first_output("s1"), "already idle");

        map.launched("s2", Some("ide".into()), ide_path(), "n", 1);
        map.forget("s2");
        assert!(!map.sessions.contains_key("s2"));
        assert!(!map.app_running.contains("s2"));
        // A poll without s1 carries it over: it is app-running.
        map.apply_at(Ok(vec![]), &ws, 3);
        assert_eq!(map.sessions["s1"].state, SessionState::Idle, "carried: s1 is app-running");
    }

    #[test]
    fn app_exited_entries_expire_are_cleared_by_a_new_launch_and_survive_a_lost_claude() {
        let ws = workspace_with_ide();
        let mut map = LiveMap::default();
        map.launched("s1", Some("ide".into()), ide_path(), "n", 1);
        assert!(map.process_exited_at("s1", 1_000));
        assert_eq!(map.app_exited.get("s1"), Some(&1_000));
        // Within the TTL a lagging row is ignored.
        map.apply_at(one("idle"), &ws, 1_000 + APP_EXITED_TTL_MS);
        assert_eq!(map.sessions["s1"].state, SessionState::Exited);
        // After it, the entry is gone and a row is an ordinary row again.
        map.apply_at(one("idle"), &ws, 1_001 + APP_EXITED_TTL_MS);
        assert!(map.app_exited.is_empty());
        assert_eq!(map.sessions["s1"].state, SessionState::Idle);

        // A new launch of the id clears its entry.
        map.launched("s2", Some("ide".into()), ide_path(), "n", 1);
        map.process_exited_at("s2", 5);
        assert!(map.app_exited.contains_key("s2"));
        map.launched("s2", Some("ide".into()), ide_path(), "n", 6);
        assert!(!map.app_exited.contains_key("s2"), "launched clears app_exited");
        assert!(map.app_running.contains("s2"));

        // claude lost: the poll's sessions go, the app's stay.
        let kept = map.cleared_keeping_app();
        assert_eq!(kept.sessions.keys().collect::<Vec<_>>(), ["s2"]);
        assert!(kept.app_running.contains("s2"));
        assert_eq!(LiveMap::default().cleared_keeping_app(), LiveMap::default());
    }

    #[test]
    fn app_exited_entries_go_with_their_evicted_session() {
        let mut map = LiveMap::default();
        for i in 0..=MAX_EXITED {
            let id = format!("s{i:04}");
            map.launched(&id, None, "/x", "n", 1);
            map.process_exited_at(&id, 1);
        }
        assert_eq!(map.sessions.len(), MAX_EXITED);
        assert!(!map.app_exited.contains_key("s0000"), "evicted with its session");
        assert_eq!(map.app_exited.len(), MAX_EXITED);
    }

    #[test]
    fn a_failing_claude_raises_the_banner_after_three_polls_and_success_clears_it() {
        let (app, cfg) = app_with_ide();
        let failing = script(cfg.path(), "claude-failing", "@exit /b 1\n", "exit 1\n");
        found(&app, &failing);
        let rx = listen(&app);
        for _ in 0..2 {
            assert_eq!(tauri::async_runtime::block_on(refresh(app.handle())).banner, None);
        }
        let snap = tauri::async_runtime::block_on(refresh(app.handle()));
        assert_eq!(snap.banner.as_deref(), Some("live session status unavailable: claude agents: exit code 1"));
        assert_eq!(rx.try_recv().unwrap().banner, snap.banner);

        let out = cfg.path().join("rows.json");
        set_output(&out, &[]);
        found(&app, &printing_claude(cfg.path(), &out));
        assert_eq!(tauri::async_runtime::block_on(refresh(app.handle())).banner, None);
        assert_eq!(rx.try_recv().unwrap().banner, None);
    }

    // --- Story 4.3: hooks -----------------------------------------------------------------

    use crate::claude::hooks::{HookSignal, WaitKind};

    /// A launched session `s1` in `ide`, not yet hooked (no hook event yet).
    fn launched() -> LiveMap {
        let mut map = LiveMap::default();
        map.launched("s1", Some("ide".into()), ide_path(), "ide-ab12", 1);
        map
    }

    /// A launched session whose first hook event (`SessionStart`) has arrived: hooked, idle.
    fn hooked() -> LiveMap {
        let mut map = launched();
        map.apply_hook("s1", &HookSignal::Started, 1);
        map
    }

    fn state_of(map: &LiveMap) -> (SessionState, StateSource) {
        (map.sessions["s1"].state.clone(), map.sessions["s1"].source)
    }

    fn permission(detail: &str) -> HookSignal {
        HookSignal::Waiting { kind: WaitKind::Permission, detail: Some(detail.into()), notification: false }
    }

    fn notice(kind: WaitKind, detail: &str) -> HookSignal {
        HookSignal::Waiting { kind, detail: Some(detail.into()), notification: true }
    }

    #[test]
    fn a_session_is_hooked_only_from_its_first_hook_event() {
        let ws = workspace_with_ide();
        let mut map = launched();
        assert!(!map.hooked.contains_key("s1"), "a launch alone does not hook it");
        // Unhooked, the 3.3 guess applies.
        map.apply_at(one("busy"), &ws, 2);
        assert_eq!(ids(&map.apply_at(one("idle"), &ws, 3)), ["s1"]);
        assert_eq!(map.sessions["s1"].state, SessionState::Finished);
        map.apply_hook("s1", &HookSignal::Prompted, 4);
        assert!(map.hooked.contains_key("s1"));
        // The endpoint failed: every mark goes, the guess is back.
        map.clear_hooked();
        assert!(map.hooked.is_empty() && map.waits.is_empty() && map.answered.is_empty());
        map.apply_at(one("busy"), &ws, 5);
        assert_eq!(ids(&map.apply_at(one("idle"), &ws, 6)), ["s1"]);
    }

    #[test]
    fn hook_events_drive_the_state_machine() {
        let mut map = launched();
        // SessionStart: starting → idle; afterwards it changes nothing.
        assert!(map.apply_hook("s1", &HookSignal::Started, 2).is_empty());
        assert_eq!(state_of(&map), (SessionState::Idle, StateSource::Hook));
        map.apply_hook("s1", &HookSignal::Prompted, 3);
        assert!(map.apply_hook("s1", &HookSignal::Started, 4).is_empty());
        assert_eq!(state_of(&map), (SessionState::Busy, StateSource::Hook));

        // PermissionRequest: waiting, stamped, one transition with its detail.
        let entered = map.apply_hook("s1", &permission("permission: Bash"), 5);
        assert_eq!(ids(&entered), ["s1"]);
        assert_eq!(entered[0].state, SessionState::Waiting);
        assert_eq!(entered[0].project_id.as_deref(), Some("ide"));
        let s = &map.sessions["s1"];
        assert_eq!((s.state.clone(), s.attention_since, s.detail.as_deref()), (SessionState::Waiting, Some(5), Some("permission: Bash")));
        assert_eq!(map.waits.get("s1"), Some(&WaitKind::Permission));
        // The 6 s Notification for the same prompt: no second transition, the time kept.
        assert!(map.apply_hook("s1", &notice(WaitKind::Permission, "Claude needs your permission"), 6).is_empty());
        assert_eq!(map.sessions["s1"].attention_since, Some(5));
        assert_eq!(map.sessions["s1"].detail.as_deref(), Some("Claude needs your permission"));

        // A parallel tool finishing does not answer the prompt.
        assert!(map.apply_hook("s1", &HookSignal::ToolDone, 7).is_empty());
        assert_eq!(map.sessions["s1"].state, SessionState::Waiting);
        assert_eq!(map.sessions["s1"].attention_since, Some(5));
        // A new prompt does.
        assert!(map.apply_hook("s1", &HookSignal::Prompted, 8).is_empty());
        let s = &map.sessions["s1"];
        assert_eq!((s.state.clone(), s.attention_since, s.detail.clone()), (SessionState::Busy, None, None));
        assert!(map.waits.is_empty());
        // A tool finishing while busy keeps it busy.
        map.apply_hook("s1", &HookSignal::ToolDone, 9);
        assert_eq!(state_of(&map), (SessionState::Busy, StateSource::Hook));

        // Stop: finished with the last line.
        let entered = map.apply_hook("s1", &HookSignal::Finished { last_line: Some("Done.".into()) }, 10);
        assert_eq!(ids(&entered), ["s1"]);
        let s = &map.sessions["s1"];
        assert_eq!((s.state.clone(), s.attention_since, s.last_line.as_deref()), (SessionState::Finished, Some(10), Some("Done.")));
        let wire = serde_json::to_value(map.snapshot()).unwrap();
        assert_eq!(wire["sessions"]["s1"]["last_line"], "Done.");
        assert_eq!(wire["sessions"]["s1"]["source"], "hook");

        // Acknowledging works as in 3.3, and drops the last line.
        assert!(map.acknowledge("s1", Some(10)));
        assert_eq!(state_of(&map), (SessionState::Idle, StateSource::Ack));
        assert_eq!(map.sessions["s1"].last_line, None);

        // StopFailure after a new prompt: finished, "turn failed".
        map.apply_hook("s1", &HookSignal::Prompted, 11);
        map.apply_hook("s1", &HookSignal::Finished { last_line: Some(crate::claude::hooks::TURN_FAILED.into()) }, 12);
        assert_eq!(map.sessions["s1"].last_line.as_deref(), Some("turn failed"));
        // Waiting → finished is a new kind of attention: a transition.
        map.apply_hook("s1", &HookSignal::Prompted, 13);
        map.apply_hook("s1", &permission("x"), 14);
        assert_eq!(ids(&map.apply_hook("s1", &HookSignal::Finished { last_line: None }, 15)), ["s1"]);
        assert_eq!(map.sessions["s1"].detail, None);
        assert!(map.waits.is_empty());

        // Exit: hooks change nothing any more; unknown ids neither.
        assert!(map.process_exited_at("s1", 16));
        assert!(!map.hooked.contains_key("s1"));
        assert!(map.apply_hook("s1", &HookSignal::Prompted, 17).is_empty());
        assert_eq!(map.sessions["s1"].state, SessionState::Exited);
        assert!(map.apply_hook("nope", &HookSignal::Prompted, 17).is_empty());
    }

    #[test]
    fn answer_keys_are_single_key_presses_only() {
        assert_eq!(answer_key("\r"), Some(AnswerKey::Enter));
        assert_eq!(answer_key("\n"), Some(AnswerKey::Enter));
        assert_eq!(answer_key("\u{1b}"), Some(AnswerKey::Esc));
        for c in ["1", "9", "y", "Y", "n", "N"] {
            assert_eq!(answer_key(c), Some(AnswerKey::Choice), "{c}");
        }
        // Pastes, several keys, escape sequences (CSI, SS3, OSC, DCS, bracketed paste), alt+key.
        for other in [
            "", "a", "12", "yes", "1\r", "\x1b[A", "\x1bOB", "\x1b[I", "\x1b[<0;12;5M", "\x1b]11;rgb:0000/0000/0000\x07",
            "\x1bP1$r0m\x1b\\", "\x1b[200~1\x1b[201~", "\x1by", "\x1b\r",
        ] {
            assert_eq!(answer_key(other), None, "{other:?}");
        }
    }

    #[test]
    fn a_permission_wait_is_answered_by_enter_a_digit_or_y_n_and_rejected_by_esc() {
        let mut map = hooked();
        assert!(!map.terminal_input_at("s1", "1", 2), "not waiting: nothing to answer");
        for answer in ["\r", "1", "2", "y", "N"] {
            map.apply_hook("s1", &permission("permission: Bash"), 3);
            assert!(map.terminal_input_at("s1", answer, 4), "{answer:?}");
            let s = &map.sessions["s1"];
            assert_eq!((s.state.clone(), s.source, s.attention_since), (SessionState::Busy, StateSource::Hook, None), "{answer:?}");
        }
        map.apply_hook("s1", &permission("permission: Bash"), 5);
        assert!(map.terminal_input_at("s1", "\u{1b}", 6));
        assert_eq!(state_of(&map), (SessionState::Idle, StateSource::Hook), "Esc rejects: the turn ends");
        assert_eq!(map.sessions["s1"].attention_since, None);
        map.apply_hook("s1", &permission("permission: Bash"), 7);
        for other in ["\x1b[A", "\x1b[I", "\x1b[<0;12;5M", "a", "q", "", "pasted 1\r", "\x1b[200~y\x1b[201~"] {
            assert!(!map.terminal_input_at("s1", other, 8), "{other:?}");
        }
        assert_eq!(map.sessions["s1"].state, SessionState::Waiting);
        assert!(!map.terminal_input_at("nope", "\r", 8));
    }

    #[test]
    fn an_input_wait_is_answered_by_enter_only() {
        let mut map = hooked();
        // Each round starts well past the late-notification window of the previous answer.
        for (t, kind_signal) in [
            (0, HookSignal::Waiting { kind: WaitKind::Input, detail: Some("Pick one".into()), notification: false }),
            (100_000, notice(WaitKind::Input, "Claude needs your input")),
        ] {
            map.apply_hook("s1", &HookSignal::Prompted, t + 2);
            map.apply_hook("s1", &kind_signal, t + 3);
            assert_eq!(map.waits.get("s1"), Some(&WaitKind::Input));
            for other in ["1", "y", "n", "\u{1b}"] {
                assert!(!map.terminal_input_at("s1", other, t + 4), "{other:?}");
            }
            assert_eq!(map.sessions["s1"].state, SessionState::Waiting);
            assert!(map.terminal_input_at("s1", "\r", t + 5));
            assert_eq!(state_of(&map), (SessionState::Busy, StateSource::Hook));
        }
    }

    #[test]
    fn a_late_notification_after_a_terminal_answer_is_ignored() {
        let mut map = hooked();
        map.apply_hook("s1", &permission("permission: Bash"), 1_000);
        assert!(map.terminal_input_at("s1", "1", 2_000));
        // The ~6 s Notification for the prompt just answered: ignored.
        assert!(map.apply_hook("s1", &notice(WaitKind::Permission, "Claude needs your permission"), 7_000).is_empty());
        assert_eq!(map.sessions["s1"].state, SessionState::Busy);
        // A PermissionRequest is a new prompt, whenever it comes.
        assert_eq!(ids(&map.apply_hook("s1", &permission("permission: Edit"), 7_500)), ["s1"]);
        assert!(map.terminal_input_at("s1", "\r", 8_000));
        // A Notification 10 s or more after the answer counts.
        assert_eq!(ids(&map.apply_hook("s1", &notice(WaitKind::Permission, "again"), 8_000 + LATE_NOTIFICATION_MS)), ["s1"]);
        assert_eq!(map.sessions["s1"].state, SessionState::Waiting);
    }

    #[test]
    fn agreeing_pairs_are_the_listed_ones() {
        use SessionState::*;
        let other = |raw: &str| Other { raw: raw.into() };
        for (hook, poll) in [
            (Busy, Busy),
            (Waiting, Busy),
            (Waiting, Idle),
            (Finished, Idle),
            (Idle, Idle),
            (Starting, Busy),
            (Starting, Idle),
            (other("c"), other("c")),
            (Finished, other("c")),
            (Waiting, other("c")),
        ] {
            assert!(hook_agrees(&hook, &poll), "{hook:?}/{poll:?}");
        }
        for (hook, poll) in [(Idle, Busy), (Busy, Idle), (Finished, Busy), (Busy, other("c")), (other("c"), other("d"))] {
            assert!(!hook_agrees(&hook, &poll), "{hook:?}/{poll:?}");
        }
    }

    #[test]
    fn two_disagreeing_polls_without_a_hook_between_and_the_poll_wins() {
        let ws = workspace_with_ide();
        let mut map = hooked();
        // Hooks silent: hook state idle, poll busy twice.
        assert!(map.apply_at(one("busy"), &ws, 3).is_empty());
        assert_eq!(state_of(&map), (SessionState::Idle, StateSource::Hook), "one disagreeing poll: the hook state stands");
        assert_eq!(map.poll_overrides, 0);
        map.apply_at(one("busy"), &ws, 4);
        assert_eq!(state_of(&map), (SessionState::Busy, StateSource::Poll), "the second: the poll wins");
        assert_eq!(map.poll_overrides, 1);

        // One disagreeing poll, then a hook: the hook state is kept, no override.
        map.apply_hook("s1", &HookSignal::Finished { last_line: Some("Done.".into()) }, 5);
        map.apply_at(one("busy"), &ws, 6);
        map.apply_hook("s1", &HookSignal::Finished { last_line: Some("Done.".into()) }, 7);
        map.apply_at(one("busy"), &ws, 8);
        assert_eq!(map.sessions["s1"].state, SessionState::Finished);
        assert_eq!(map.sessions["s1"].last_line.as_deref(), Some("Done."));
        assert_eq!(map.poll_overrides, 1);
        // An agreeing poll in between resets the count too.
        map.apply_at(one("idle"), &ws, 9);
        map.apply_at(one("busy"), &ws, 10);
        assert_eq!(map.sessions["s1"].state, SessionState::Finished);
        assert_eq!(map.poll_overrides, 1);
    }

    #[test]
    fn every_override_that_changes_the_state_is_counted_and_sourced_poll() {
        let ws = workspace_with_ide();
        let mut map = hooked();
        map.apply_hook("s1", &HookSignal::Prompted, 2);
        // busy held, `compacting` polled twice: the fold applies `compacting`: counted.
        map.apply_at(one("compacting"), &ws, 3);
        map.apply_at(one("compacting"), &ws, 4);
        assert_eq!(map.sessions["s1"].state, SessionState::Other { raw: "compacting".into() });
        assert_eq!(map.poll_overrides, 1);
        // `idle` held (by an Esc rejection), the poll says `compacting` twice: the 3.3 fold gives
        // `compacting`, a change: counted.
        map.apply_hook("s1", &permission("permission: Bash"), 5);
        map.terminal_input_at("s1", "\u{1b}", 6);
        map.apply_at(one("compacting"), &ws, 7);
        map.apply_at(one("compacting"), &ws, 8);
        assert_eq!(map.poll_overrides, 2);
        // A Hook-sourced `busy` with two `idle` polls whose fold is `idle`: a change, counted.
        map.apply_hook("s1", &HookSignal::Prompted, 9);
        map.apply_at(one("idle"), &ws, 10);
        map.apply_at(one("idle"), &ws, 11);
        assert_eq!(state_of(&map), (SessionState::Idle, StateSource::Poll));
        assert_eq!(map.poll_overrides, 3);
        // One disagreement already counted, then a differing `Other` status: applied, counted.
        let s = map.sessions.get_mut("s1").unwrap();
        s.state = SessionState::Other { raw: "x".into() };
        s.source = StateSource::Hook;
        map.hooked.insert("s1".into(), 1);
        // `Other{x}` held, `Other{y}` polled: the fold gives `Other{y}`, a change.
        map.apply_at(one("y"), &ws, 12);
        assert_eq!(map.poll_overrides, 4);
        assert_eq!(map.sessions["s1"].source, StateSource::Poll);
    }

    #[test]
    fn no_poll_state_ever_overrides_a_waiting_session() {
        let ws = workspace_with_ide();
        let mut map = hooked();
        map.apply_hook("s1", &permission("permission: Bash"), 2);
        for (status, t) in [("busy", 3), ("busy", 4), ("idle", 5), ("idle", 6), ("compacting", 7), ("compacting", 8), ("busy", 9)] {
            assert!(map.apply_at(one(status), &ws, t).is_empty(), "{status}");
        }
        let s = &map.sessions["s1"];
        assert_eq!((s.state.clone(), s.source, s.attention_since, s.detail.as_deref()), (SessionState::Waiting, StateSource::Hook, Some(2), Some("permission: Bash")));
        assert_eq!(map.poll_overrides, 0);
        // Only its process exit ends it from outside the hooks.
        assert!(map.process_exited_at("s1", 10));
        assert_eq!(map.sessions["s1"].state, SessionState::Exited);
    }

    #[test]
    fn the_busy_to_idle_guess_does_not_apply_to_a_hooked_session() {
        let ws = workspace_with_ide();
        let mut map = hooked();
        map.apply_hook("s1", &HookSignal::Prompted, 2);
        map.apply_at(one("busy"), &ws, 3);
        // The turn ended but the Stop hook is late: idle polls disagree with busy …
        assert!(map.apply_at(one("idle"), &ws, 4).is_empty());
        assert_eq!(map.sessions["s1"].state, SessionState::Busy);
        // … and after two the poll wins with `idle`, not a guessed `finished`.
        assert!(map.apply_at(one("idle"), &ws, 5).is_empty());
        assert_eq!(state_of(&map), (SessionState::Idle, StateSource::Poll));
        assert_eq!(map.poll_overrides, 1);

        // An unhooked session behaves exactly as before.
        let mut plain = LiveMap::default();
        plain.apply_at(one("busy"), &ws, 1);
        assert_eq!(ids(&plain.apply_at(one("idle"), &ws, 2)), ["s1"]);
        assert_eq!(plain.poll_overrides, 0);
    }

    #[test]
    fn a_starting_hooked_session_still_turns_idle_on_its_first_poll_row() {
        let ws = workspace_with_ide();
        let mut map = launched();
        map.hooked.insert("s1".into(), 0);
        map.apply_at(one("idle"), &ws, 2);
        assert_eq!(state_of(&map), (SessionState::Idle, StateSource::Poll));
        assert_eq!(map.poll_overrides, 0);
        assert!(map.hooked.contains_key("s1"));
        // Losing claude keeps the mark for the app's sessions; forget drops it.
        assert!(map.cleared_keeping_app().hooked.contains_key("s1"));
        map.forget("s1");
        assert!(map.hooked.is_empty());
    }
}
