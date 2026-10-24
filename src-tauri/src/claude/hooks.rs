//! Hook-driven status (Story 4.3). Sessions Switchboard starts get Claude Code `http` hooks in
//! their per-session `--settings` file ([`settings_json`]); each hook POSTs its event JSON to a
//! localhost endpoint inside the app (`POST /hooks/<Event>`, `Authorization: Bearer <token>`),
//! and the event is mapped ([`map_event`]) onto the live state machine
//! (`crate::claude::live::LiveMap::apply_hook`), so `waiting` and `finished` show within a
//! second instead of a poll later.
//!
//! The endpoint is an `axum` server bound to `127.0.0.1:0` (an ephemeral port), started once
//! in `setup` ([`start`]). It never makes a network call. Each launched session gets its own
//! token (32 random bytes in hex), compared in constant time and dropped when the session's
//! process exits. An unknown token is 401, any other path or method 404, a body over 1 MiB
//! 413; the path and token are checked from the head before any body is read, and every refusal
//! closes the connection. Every accepted request gets an **empty 200**, sent before the event is
//! applied (on a worker thread, in arrival order), so a hook never approves, denies, blocks or
//! waits on anything. At most 64 connections are served at once, and one silent for 10 s is
//! closed -- except while an `/mcp` request it sent is being answered (Story 7.2: an act tool may
//! wait minutes for the operator), and the 10 s start again once the reply is out. A failed bind (or a failed server) leaves launches working without hooks (the
//! settings file is `{}`, as in Story 4.2), drops every token and hooked mark, and raises the
//! banner `hooks endpoint unavailable: <cause>`.
//!
//! The same server answers `POST /mcp`, the `switchboard` MCP endpoint of Story 7.1
//! (`crate::mcp`), on the same per-session tokens. A refused MCP request (no token, or one no
//! running session holds) is a 401 counted in `mcp_refused` and kept in a ring of the last
//! [`MCP_REFUSAL_RING`] refusals (time, path, reason; never the token).

use std::collections::{HashMap, HashSet, VecDeque};
use std::net::{Ipv4Addr, TcpListener};
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use axum::Router;
use axum::body::Body;
use axum::extract::{Path, Request, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{any, post};
use serde::Serialize;
use serde_json::{Value, json};
use tauri::{AppHandle, Manager, Runtime};

use crate::settings::{AppState, Banner};

/// The hook events Switchboard wires, in the order the settings file lists them. The user's
/// own hooks and every other event are left alone (settings layers merge).
pub const EVENTS: [&str; 9] = [
    "SessionStart",
    "UserPromptSubmit",
    "PermissionRequest",
    "Notification",
    "Elicitation",
    "PostToolUse",
    "PostToolUseFailure",
    "Stop",
    "StopFailure",
];

/// The `notification_type`s that mean the session waits for the operator.
pub const NOTIFICATION_TYPES: [&str; 4] = ["permission_prompt", "elicitation_dialog", "elicitation_url_dialog", "agent_needs_input"];

/// The `Notification` hook's matcher: exactly [`NOTIFICATION_TYPES`].
pub const NOTIFICATION_MATCHER: &str = "permission_prompt|elicitation_dialog|elicitation_url_dialog|agent_needs_input";

/// The largest body the endpoint accepts (1 MiB); a larger one is 413.
pub const MAX_BODY: usize = 1024 * 1024;

/// How much of a refused, over-long body is read and dropped before the reply, so the client
/// sees the 413 instead of a reset connection.
pub(crate) const DRAIN_CAP: usize = 16 * 1024 * 1024;

/// Each hook's `timeout`, in seconds.
pub const HOOK_TIMEOUT_SECS: u64 = 5;

/// The environment variable that names the endpoint's port in a launched session.
pub const PORT_ENV: &str = "SWITCHBOARD_PORT";

/// A `finished` card's last line is cut to this many characters (then `…`).
pub const LAST_LINE_MAX: usize = 200;

/// A `waiting` card's detail is cut to this many characters (then `…`).
pub const DETAIL_MAX: usize = 300;

/// The last line a `StopFailure` leaves.
pub const TURN_FAILED: &str = "turn failed";

/// The id of the banner a failed endpoint raises.
pub const BANNER_ID: &str = "hooks.endpoint";

// ---------------------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------------------

/// What a `waiting` session waits for, which decides the keys that answer it in the terminal
/// (`crate::claude::live::LiveMap::terminal_input`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WaitKind {
    /// A permission dialog (`PermissionRequest`, a `permission_prompt` Notification): Enter, a
    /// digit or `y`/`n` answers (busy), a lone Esc rejects (idle).
    Permission,
    /// An elicitation or `agent_needs_input`: only Enter answers (busy).
    Input,
}

/// What one hook event means for the session's state (see `LiveMap::apply_hook`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HookSignal {
    /// `SessionStart`: `starting` turns `idle`; any other state is left alone.
    Started,
    /// `UserPromptSubmit`: busy, whatever the state.
    Prompted,
    /// `PostToolUse`, `PostToolUseFailure`: busy, except that a `waiting` session stays waiting
    /// (a parallel tool or a subagent finishing does not answer the prompt).
    ToolDone,
    /// `PermissionRequest`, `Elicitation`, a `Notification` of a wired type; `detail` is the
    /// card's tooltip. `notification` marks a `Notification` (it can arrive late, ~6 s after
    /// the dialog, so one shortly after a terminal answer is ignored).
    Waiting { kind: WaitKind, detail: Option<String>, notification: bool },
    /// `Stop` (the turn's last assistant line) or `StopFailure` (`turn failed`).
    Finished { last_line: Option<String> },
}

/// `text` cut to `max` characters, with `…` appended when cut.
pub fn cut(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    let mut out: String = text.chars().take(max).collect();
    out.push('…');
    out
}

/// The first non-empty line of `message`, trimmed and cut to [`LAST_LINE_MAX`] characters
/// (`…` appended when cut); `None` when every line is blank.
pub fn last_line(message: &str) -> Option<String> {
    message
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(|line| cut(line, LAST_LINE_MAX))
}

fn text<'a>(payload: &'a Value, key: &str) -> Option<&'a str> {
    payload.get(key).and_then(Value::as_str)
}

/// A detail text: trimmed, not blank, cut to [`DETAIL_MAX`].
fn detail(raw: Option<&str>) -> Option<String> {
    raw.map(str::trim).filter(|t| !t.is_empty()).map(|t| cut(t, DETAIL_MAX))
}

/// The signal `event` (the path's event name) with its JSON `payload` gives, or `None` for an
/// event that changes nothing (an unwired event, a `Notification` of another type).
pub fn map_event(event: &str, payload: &Value) -> Option<HookSignal> {
    match event {
        "SessionStart" => Some(HookSignal::Started),
        "UserPromptSubmit" => Some(HookSignal::Prompted),
        "PostToolUse" | "PostToolUseFailure" => Some(HookSignal::ToolDone),
        "PermissionRequest" => Some(HookSignal::Waiting {
            kind: WaitKind::Permission,
            detail: detail(text(payload, "tool_name").map(|tool| format!("permission: {tool}")).as_deref()),
            notification: false,
        }),
        "Elicitation" => Some(HookSignal::Waiting {
            kind: WaitKind::Input,
            detail: detail(text(payload, "message")),
            notification: false,
        }),
        "Notification" => {
            let kind = text(payload, "notification_type")?;
            NOTIFICATION_TYPES.contains(&kind).then(|| HookSignal::Waiting {
                kind: if kind == "permission_prompt" { WaitKind::Permission } else { WaitKind::Input },
                detail: detail(text(payload, "message")),
                notification: true,
            })
        }
        "Stop" => Some(HookSignal::Finished {
            last_line: text(payload, "last_assistant_message").and_then(last_line),
        }),
        "StopFailure" => Some(HookSignal::Finished {
            last_line: Some(TURN_FAILED.to_string()),
        }),
        _ => None,
    }
}

/// The per-session settings file's content while the endpoint is up on `port`: one `http`
/// hook per wired event, POSTing to `http://127.0.0.1:<port>/hooks/<Event>` with the session's
/// bearer token written literally (the file is per-user, 0600 on Unix) and a 5 s timeout; and
/// (Story 7.1) `permissions.allow` naming exactly the `switchboard` read tools and (Story 7.3) the
/// peer tools `send` / `inbox`, so they never prompt.
pub fn settings_json(port: u16, token: &str) -> Value {
    let mut hooks = serde_json::Map::new();
    for event in EVENTS {
        let hook = json!({
            "type": "http",
            "url": format!("http://127.0.0.1:{port}/hooks/{event}"),
            "headers": { "Authorization": format!("Bearer {token}") },
            "timeout": HOOK_TIMEOUT_SECS,
        });
        let mut group = json!({ "hooks": [hook] });
        if event == "Notification" {
            group["matcher"] = json!(NOTIFICATION_MATCHER);
        }
        hooks.insert(event.to_string(), json!([group]));
    }
    json!({ "hooks": hooks, "permissions": { "allow": crate::mcp::allowed_tools() } })
}

/// A fresh token: 32 random bytes (two v4 UUIDs' worth from the OS generator) in hex.
pub fn new_token() -> String {
    let mut out = String::with_capacity(64);
    for _ in 0..2 {
        for byte in uuid::Uuid::new_v4().as_bytes() {
            out.push_str(&format!("{byte:02x}"));
        }
    }
    out
}

/// Equal without an early exit on the first differing byte.
fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

// ---------------------------------------------------------------------------------------
// Registry and diagnostics
// ---------------------------------------------------------------------------------------

/// The endpoint's state.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Endpoint {
    /// Not started (the mock app in tests, or `setup` has not run yet).
    Pending,
    /// Listening on `127.0.0.1:<port>`.
    Up(u16),
    /// The bind (or the server) failed; the cause.
    Failed(String),
}

/// What `diagnostics_get` returns (Settings → Diagnostics).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct DiagnosticsSnapshot {
    /// `127.0.0.1:<port>` while the endpoint is up.
    pub endpoint: Option<String>,
    /// Why the endpoint is not up, when it failed.
    pub endpoint_error: Option<String>,
    /// Hook requests accepted (with a known token).
    pub hook_events: u64,
    /// Requests refused (401, 404, 413).
    pub refused: u64,
    /// Accepted events whose payload `session_id` differs from the token's session.
    pub session_mismatches: u64,
    /// Times the poll overrode a hooked session's state (`LiveMap::poll_overrides`).
    pub poll_overrides: u64,
    /// `/mcp` requests refused (Story 7.1): 401, and 413 / 408 for an authenticated one.
    pub mcp_refused: u64,
    /// The last [`MCP_REFUSAL_RING`] of them, newest first.
    pub mcp_refusals: Vec<McpRefusal>,
}

/// How many `/mcp` refusals the diagnostics keep.
pub const MCP_REFUSAL_RING: usize = 20;

/// Why an `/mcp` request was refused: no bearer token.
pub const MISSING_TOKEN: &str = "missing token";

/// Why an `/mcp` request was refused: a token no running session holds (wrong, or expired).
pub const UNKNOWN_TOKEN: &str = "unknown token";

/// Why an authenticated `/mcp` request was refused: its body is over [`MAX_BODY`] (413).
pub const BODY_TOO_LARGE: &str = "body too large";

/// Why an authenticated `/mcp` request was refused: its body did not arrive within
/// [`READ_TIMEOUT`] (408).
pub const READ_TIMED_OUT: &str = "read timeout";

/// One refused `/mcp` request. Never any part of the token.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct McpRefusal {
    /// Milliseconds since the epoch.
    pub at: i64,
    pub path: String,
    /// [`MISSING_TOKEN`], [`UNKNOWN_TOKEN`], [`BODY_TOO_LARGE`] or [`READ_TIMED_OUT`].
    pub reason: String,
}

#[derive(Default)]
struct Inner {
    endpoint: Mutex<Option<Endpoint>>,
    /// Session id → its token.
    tokens: Mutex<HashMap<String, String>>,
    /// Session id → other session ids a `SessionStart` on its token announced (after `/clear`,
    /// say): events carrying them are not counted as mismatches.
    aliases: Mutex<HashMap<String, HashSet<String>>>,
    events: AtomicU64,
    refused: AtomicU64,
    mismatches: AtomicU64,
    mcp_refused: AtomicU64,
    mcp_refusals: Mutex<VecDeque<McpRefusal>>,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|e| e.into_inner())
}

/// The hooks registry (in `AppState`; cheap to clone, shared with the server): the endpoint's
/// state, each launched session's token, and the counters.
#[derive(Clone, Default)]
pub struct Hooks {
    inner: Arc<Inner>,
}

impl Hooks {
    pub fn endpoint(&self) -> Endpoint {
        lock(&self.inner.endpoint).clone().unwrap_or(Endpoint::Pending)
    }

    pub fn set_endpoint(&self, endpoint: Endpoint) {
        *lock(&self.inner.endpoint) = Some(endpoint);
    }

    /// The port while the endpoint is up.
    pub fn port(&self) -> Option<u16> {
        match self.endpoint() {
            Endpoint::Up(port) => Some(port),
            _ => None,
        }
    }

    /// A new token for `session_id` (replacing any it had).
    pub fn register(&self, session_id: &str) -> String {
        let token = new_token();
        lock(&self.inner.tokens).insert(session_id.to_string(), token.clone());
        token
    }

    /// Drop `session_id`'s token (its process exited, or never started): later requests with
    /// it are 401.
    pub fn drop_session(&self, session_id: &str) {
        lock(&self.inner.tokens).remove(session_id);
        lock(&self.inner.aliases).remove(session_id);
    }

    /// Drop every token (the endpoint failed): no session is hooked any more.
    pub fn drop_all(&self) {
        lock(&self.inner.tokens).clear();
        lock(&self.inner.aliases).clear();
    }

    /// How many sessions hold a token.
    pub fn token_count(&self) -> usize {
        lock(&self.inner.tokens).len()
    }

    /// An event on `session`'s token carried `claimed` as its `session_id`: whether that is a
    /// mismatch. A `SessionStart` announcing a new id makes it an alias (not a mismatch, then or
    /// later); following the new id is out of scope.
    pub fn check_session_id(&self, session: &str, claimed: &str, event: &str) -> bool {
        if claimed == session {
            return false;
        }
        let mut aliases = lock(&self.inner.aliases);
        if event == "SessionStart" {
            aliases.entry(session.to_string()).or_default().insert(claimed.to_string());
            return false;
        }
        !aliases.get(session).is_some_and(|known| known.contains(claimed))
    }

    /// The session `token` names, comparing against every token in constant time.
    pub fn session_for(&self, token: &str) -> Option<String> {
        let tokens = lock(&self.inner.tokens);
        let mut found = None;
        for (session, known) in tokens.iter() {
            if constant_time_eq(known.as_bytes(), token.as_bytes()) {
                found = Some(session.clone());
            }
        }
        found
    }

    /// Whether `session_id` has a token.
    pub fn has_token(&self, session_id: &str) -> bool {
        lock(&self.inner.tokens).contains_key(session_id)
    }

    /// The counters and the endpoint, with the live map's `poll_overrides`.
    pub fn diagnostics(&self, poll_overrides: u64) -> DiagnosticsSnapshot {
        let (endpoint, endpoint_error) = match self.endpoint() {
            Endpoint::Up(port) => (Some(format!("127.0.0.1:{port}")), None),
            Endpoint::Failed(cause) => (None, Some(cause)),
            Endpoint::Pending => (None, None),
        };
        DiagnosticsSnapshot {
            endpoint,
            endpoint_error,
            hook_events: self.inner.events.load(Ordering::Relaxed),
            refused: self.inner.refused.load(Ordering::Relaxed),
            session_mismatches: self.inner.mismatches.load(Ordering::Relaxed),
            poll_overrides,
            mcp_refused: self.inner.mcp_refused.load(Ordering::Relaxed),
            mcp_refusals: lock(&self.inner.mcp_refusals).iter().rev().cloned().collect(),
        }
    }

    /// Count a refused `/mcp` request and keep it in the ring (the oldest drops out past
    /// [`MCP_REFUSAL_RING`]).
    pub fn note_mcp_refusal(&self, path: &str, reason: &str) {
        Self::count(&self.inner.mcp_refused);
        let mut ring = lock(&self.inner.mcp_refusals);
        ring.push_back(McpRefusal {
            at: crate::claude::live::now_ms(),
            path: path.to_string(),
            reason: reason.to_string(),
        });
        while ring.len() > MCP_REFUSAL_RING {
            ring.pop_front();
        }
    }

    fn count(counter: &AtomicU64) {
        counter.fetch_add(1, Ordering::Relaxed);
    }
}

// ---------------------------------------------------------------------------------------
// The endpoint
// ---------------------------------------------------------------------------------------

/// What the endpoint does with an accepted event: apply `signal` to session `id`. It runs on
/// the endpoint's own worker thread, in arrival order, after the reply has gone out.
pub type Apply = Arc<dyn Fn(&str, HookSignal) + Send + Sync>;

/// At most this many connections are served at once; further ones wait to be accepted.
pub const MAX_CONNECTIONS: usize = 64;

/// A connection that sends nothing for this long (headers or body) is closed, and a body read
/// that takes longer fails. It does not run while the connection's `/mcp` reply is pending
/// ([`Hold`]).
pub const READ_TIMEOUT: Duration = Duration::from_secs(10);

/// Whether a connection is waiting for its own reply (Story 7.2): while an `/mcp` request it sent
/// is being answered (an act tool waits for the operator), the idle timer does not apply; once the
/// reply is out it starts afresh. Shared between the connection and its requests
/// ([`ConnInfo`]).
#[derive(Clone, Default)]
pub(crate) struct Hold(Arc<HoldState>);

#[derive(Default)]
struct HoldState {
    /// Requests of the connection being answered now.
    held: AtomicUsize,
    /// Bumped each time one is done, so the connection restarts its idle timer.
    released: AtomicU64,
    /// The connection's task, woken when a reply is done so its timer restarts from then.
    waker: Mutex<Option<std::task::Waker>>,
}

impl Hold {
    /// The connection's reply is pending until the guard drops.
    pub(crate) fn hold(&self) -> HoldGuard {
        self.0.held.fetch_add(1, Ordering::SeqCst);
        HoldGuard(self.clone())
    }

    fn is_held(&self) -> bool {
        self.0.held.load(Ordering::SeqCst) > 0
    }

    fn released(&self) -> u64 {
        self.0.released.load(Ordering::SeqCst)
    }

    fn park(&self, waker: &std::task::Waker) {
        *lock(&self.0.waker) = Some(waker.clone());
    }
}

/// A pending reply ([`Hold::hold`]); dropping it lets the idle timer run again.
pub(crate) struct HoldGuard(Hold);

impl Drop for HoldGuard {
    fn drop(&mut self) {
        self.0.0.released.fetch_add(1, Ordering::SeqCst);
        self.0.0.held.fetch_sub(1, Ordering::SeqCst);
        if let Some(waker) = lock(&self.0.0.waker).take() {
            waker.wake();
        }
    }
}

/// What a request knows of its connection (axum's `ConnectInfo`): its [`Hold`].
#[derive(Clone)]
pub(crate) struct ConnInfo {
    pub(crate) hold: Hold,
}

impl axum::extract::connect_info::Connected<axum::serve::IncomingStream<'_, Limited>> for ConnInfo {
    fn connect_info(stream: axum::serve::IncomingStream<'_, Limited>) -> Self {
        ConnInfo { hold: stream.io().hold.clone() }
    }
}

#[derive(Clone)]
pub(crate) struct Ctx {
    pub(crate) hooks: Hooks,
    /// To the worker thread that applies accepted events (so the reply never waits for the
    /// live lock, the emit or the toast).
    applier: std::sync::mpsc::Sender<(String, HookSignal)>,
    /// What answers the MCP tool calls (Story 7.1).
    pub(crate) tools: crate::mcp::Tools,
    /// What withdraws a call's pending approval when its `/mcp` request goes away (Story 7.2).
    pub(crate) cancel: crate::mcp::Cancel,
}

/// The router: `POST /hooks/{event}` and `/mcp` (Story 7.1, `crate::mcp::handle`); everything
/// else 404. Accepted events go to `apply` on a worker thread, one at a time in arrival order;
/// the thread ends when the router is dropped. MCP tool calls go to `tools`.
pub fn router(hooks: Hooks, apply: Apply, tools: crate::mcp::Tools) -> Router {
    router_with(hooks, apply, tools, Arc::new(|_| {}))
}

/// [`router`], with `cancel` told the id of every `/mcp` call that goes away before its reply
/// (Story 7.2: its pending approval is withdrawn).
pub fn router_with(hooks: Hooks, apply: Apply, tools: crate::mcp::Tools, cancel: crate::mcp::Cancel) -> Router {
    let (applier, queue) = std::sync::mpsc::channel::<(String, HookSignal)>();
    let spawned = std::thread::Builder::new().name("hooks-apply".into()).spawn(move || {
        for (session, signal) in queue {
            apply(&session, signal);
        }
    });
    if let Err(err) = spawned {
        eprintln!("hooks endpoint: no worker thread: {err}");
    }
    Router::new()
        .route("/hooks/{event}", post(receive).fallback(not_found))
        .route("/mcp", any(crate::mcp::handle))
        .fallback(not_found)
        .with_state(Ctx { hooks, applier, tools, cancel })
}

/// The bearer token in `Authorization`, if any.
pub(crate) fn bearer(headers: &HeaderMap) -> Option<&str> {
    headers
        .get(header::AUTHORIZATION)?
        .to_str()
        .ok()?
        .strip_prefix("Bearer ")
        .map(str::trim)
}

pub(crate) fn declared_length(headers: &HeaderMap) -> Option<u64> {
    headers.get(header::CONTENT_LENGTH)?.to_str().ok()?.trim().parse().ok()
}

/// Why a body was not read.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Unread {
    /// Over [`MAX_BODY`] (declared or as it arrived).
    TooLarge,
    /// Slower than [`READ_TIMEOUT`], or the connection failed.
    Failed,
}

/// The next chunk of `body`: `None` at its end.
async fn next_chunk(body: &mut Body) -> Option<Result<axum::body::Bytes, ()>> {
    use axum::body::HttpBody;
    loop {
        match std::future::poll_fn(|cx| std::pin::Pin::new(&mut *body).poll_frame(cx)).await? {
            Ok(frame) => {
                if let Ok(data) = frame.into_data() {
                    return Some(Ok(data));
                }
            }
            Err(_) => return Some(Err(())),
        }
    }
}

/// Read and drop what is left of `body`, `seen` bytes in, up to [`DRAIN_CAP`] in all (never
/// buffered), so the client is reading its reply when the connection closes.
pub(crate) async fn discard(mut body: Body, mut seen: usize) {
    let drain = async {
        while seen <= DRAIN_CAP {
            match next_chunk(&mut body).await {
                Some(Ok(data)) => seen += data.len(),
                _ => return,
            }
        }
    };
    let _ = tokio::time::timeout(READ_TIMEOUT, drain).await;
}

/// The body, at most [`MAX_BODY`] bytes, read within [`READ_TIMEOUT`]. A longer one (declared,
/// or chunked and found out as it arrives) is not buffered: the rest is discarded.
pub(crate) async fn read_body(mut body: Body, declared: Option<u64>) -> Result<Vec<u8>, Unread> {
    if let Some(len) = declared.filter(|len| *len > MAX_BODY as u64) {
        if len <= DRAIN_CAP as u64 {
            discard(body, 0).await;
        }
        return Err(Unread::TooLarge);
    }
    let read = async {
        let mut out = Vec::new();
        while let Some(chunk) = next_chunk(&mut body).await {
            let data = chunk.map_err(|()| Unread::Failed)?;
            out.extend_from_slice(&data);
            if out.len() > MAX_BODY {
                return Err(Unread::TooLarge);
            }
        }
        Ok(out)
    };
    let outcome = tokio::time::timeout(READ_TIMEOUT, read).await.unwrap_or(Err(Unread::Failed));
    if outcome == Err(Unread::TooLarge) {
        discard(body, MAX_BODY).await;
    }
    outcome
}

fn empty(status: StatusCode) -> Response {
    status.into_response()
}

/// A refusal: counted, the body (unread so far) discarded, and the connection closed after
/// the reply.
pub(crate) async fn refuse(ctx: &Ctx, status: StatusCode, body: Option<(Body, Option<u64>)>) -> Response {
    Hooks::count(&ctx.hooks.inner.refused);
    if let Some((body, declared)) = body
        && declared.is_none_or(|len| len <= DRAIN_CAP as u64)
    {
        discard(body, 0).await;
    }
    (status, [(header::CONNECTION, "close")]).into_response()
}

async fn not_found(State(ctx): State<Ctx>, request: Request) -> Response {
    let (parts, body) = request.into_parts();
    refuse(&ctx, StatusCode::NOT_FOUND, Some((body, declared_length(&parts.headers)))).await
}

async fn receive(State(ctx): State<Ctx>, Path(event): Path<String>, request: Request) -> Response {
    let (parts, body) = request.into_parts();
    let declared = declared_length(&parts.headers);
    // The path and the token come from the head; no body is read for a refusal.
    if !EVENTS.contains(&event.as_str()) {
        return refuse(&ctx, StatusCode::NOT_FOUND, Some((body, declared))).await;
    }
    let Some(session) = bearer(&parts.headers).and_then(|token| ctx.hooks.session_for(token)) else {
        return refuse(&ctx, StatusCode::UNAUTHORIZED, Some((body, declared))).await;
    };
    let bytes = match read_body(body, declared).await {
        Ok(bytes) => bytes,
        Err(Unread::TooLarge) => return refuse(&ctx, StatusCode::PAYLOAD_TOO_LARGE, None).await,
        Err(Unread::Failed) => return refuse(&ctx, StatusCode::REQUEST_TIMEOUT, None).await,
    };
    Hooks::count(&ctx.hooks.inner.events);
    let payload: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    if let Some(claimed) = text(&payload, "session_id")
        && ctx.hooks.check_session_id(&session, claimed, &event)
    {
        Hooks::count(&ctx.hooks.inner.mismatches);
    }
    if let Some(signal) = map_event(&event, &payload) {
        // Applied after the reply, off the request path.
        let _ = ctx.applier.send((session, signal));
    }
    // Always empty: the hook's decision is never changed.
    empty(StatusCode::OK)
}

/// Bind `127.0.0.1:0`, non-blocking (for the async runtime).
pub fn bind() -> std::io::Result<TcpListener> {
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))?;
    listener.set_nonblocking(true)?;
    Ok(listener)
}

/// The listener the endpoint serves on: at most [`MAX_CONNECTIONS`] connections at once, each
/// closed after [`READ_TIMEOUT`] without input.
struct Limited {
    inner: tokio::net::TcpListener,
    permits: Arc<tokio::sync::Semaphore>,
}

impl axum::serve::Listener for Limited {
    type Io = Conn;
    type Addr = std::net::SocketAddr;

    async fn accept(&mut self) -> (Conn, std::net::SocketAddr) {
        let permit = loop {
            if let Ok(permit) = self.permits.clone().acquire_owned().await {
                break permit;
            }
        };
        let (io, addr) = axum::serve::Listener::accept(&mut self.inner).await;
        let idle = Box::pin(tokio::time::sleep(READ_TIMEOUT));
        (
            Conn {
                io,
                idle,
                hold: Hold::default(),
                seen_release: 0,
                _permit: permit,
            },
            addr,
        )
    }

    fn local_addr(&self) -> std::io::Result<std::net::SocketAddr> {
        self.inner.local_addr()
    }
}

/// One connection: its socket, the read deadline, whether a reply is pending (the deadline does
/// not apply then), and its share of [`MAX_CONNECTIONS`].
struct Conn {
    io: tokio::net::TcpStream,
    idle: std::pin::Pin<Box<tokio::time::Sleep>>,
    hold: Hold,
    /// The [`Hold`]'s release count the deadline was last reset for.
    seen_release: u64,
    _permit: tokio::sync::OwnedSemaphorePermit,
}

impl tokio::io::AsyncRead for Conn {
    fn poll_read(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        buf: &mut tokio::io::ReadBuf<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        use std::future::Future;
        use std::task::Poll;
        let this = &mut *self;
        match std::pin::Pin::new(&mut this.io).poll_read(cx, buf) {
            Poll::Ready(result) => {
                this.idle.as_mut().reset(tokio::time::Instant::now() + READ_TIMEOUT);
                Poll::Ready(result)
            }
            Poll::Pending => {
                // A reply is pending (an act tool waits on the operator): the client is silent on
                // purpose. The deadline restarts from now, and again once the reply is out.
                if this.hold.is_held() {
                    // Woken when the reply is done, to start the deadline from then.
                    this.hold.park(cx.waker());
                    if this.hold.is_held() {
                        this.idle.as_mut().reset(tokio::time::Instant::now() + READ_TIMEOUT);
                        return Poll::Pending;
                    }
                }
                let released = this.hold.released();
                if released != this.seen_release {
                    this.seen_release = released;
                    this.idle.as_mut().reset(tokio::time::Instant::now() + READ_TIMEOUT);
                }
                match this.idle.as_mut().poll(cx) {
                    Poll::Ready(()) => Poll::Ready(Err(std::io::Error::new(std::io::ErrorKind::TimedOut, "no input for 10 s"))),
                    Poll::Pending => Poll::Pending,
                }
            }
        }
    }
}

impl tokio::io::AsyncWrite for Conn {
    fn poll_write(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        buf: &[u8],
    ) -> std::task::Poll<std::io::Result<usize>> {
        std::pin::Pin::new(&mut self.io).poll_write(cx, buf)
    }

    fn poll_flush(mut self: std::pin::Pin<&mut Self>, cx: &mut std::task::Context<'_>) -> std::task::Poll<std::io::Result<()>> {
        std::pin::Pin::new(&mut self.io).poll_flush(cx)
    }

    fn poll_shutdown(mut self: std::pin::Pin<&mut Self>, cx: &mut std::task::Context<'_>) -> std::task::Poll<std::io::Result<()>> {
        std::pin::Pin::new(&mut self.io).poll_shutdown(cx)
    }

    fn poll_write_vectored(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        bufs: &[std::io::IoSlice<'_>],
    ) -> std::task::Poll<std::io::Result<usize>> {
        std::pin::Pin::new(&mut self.io).poll_write_vectored(cx, bufs)
    }

    fn is_write_vectored(&self) -> bool {
        self.io.is_write_vectored()
    }
}

/// Serve `router` on `listener` until the task ends (called on the async runtime).
pub async fn serve(listener: TcpListener, router: Router) -> std::io::Result<()> {
    let listener = Limited {
        inner: tokio::net::TcpListener::from_std(listener)?,
        permits: Arc::new(tokio::sync::Semaphore::new(MAX_CONNECTIONS)),
    };
    axum::serve(listener, router.into_make_service_with_connect_info::<ConnInfo>()).await
}

/// Start the endpoint (once, from `setup`, before the settings snapshot first goes out).
pub fn start<R: Runtime>(app: &AppHandle<R>) -> Option<tauri::async_runtime::JoinHandle<()>> {
    start_on(app, bind())
}

/// Start the endpoint on an already bound listener; a bind error marks it failed with the
/// banner. Hook events go to `crate::claude::live::hook_and_emit`. Returns the server task.
pub fn start_on<R: Runtime>(app: &AppHandle<R>, bound: std::io::Result<TcpListener>) -> Option<tauri::async_runtime::JoinHandle<()>> {
    let state = app.state::<AppState>();
    let listener = match bound.and_then(|l| l.local_addr().map(|addr| (l, addr.port()))) {
        Ok(found) => found,
        Err(err) => {
            fail(app, &err.to_string());
            return None;
        }
    };
    let (listener, port) = listener;
    state.hooks.set_endpoint(Endpoint::Up(port));
    let apply_app = app.clone();
    let apply: Apply = Arc::new(move |id, signal| {
        crate::claude::live::hook_and_emit(&apply_app, id, signal);
    });
    // MCP tool calls (Story 7.1) answer from the app's live state.
    let tools_app = app.clone();
    // Story 7.2: the act tools launch, link and ask the operator through the app handle.
    let tools: crate::mcp::Tools = Arc::new(move |session, tool, args| crate::mcp::call_app(&tools_app, session, tool, args));
    // A call that goes away while it waits for the operator withdraws its request (Story 7.2).
    let cancel_app = app.clone();
    let cancel: crate::mcp::Cancel = Arc::new(move |call| crate::approvals::cancel_call(&cancel_app, call));
    let router = router_with(state.hooks.clone(), apply, tools, cancel);
    let handle = app.clone();
    Some(tauri::async_runtime::spawn(async move {
        if let Err(err) = serve(listener, router).await {
            eprintln!("hooks endpoint: {err}");
            fail(&handle, &err.to_string());
        }
    }))
}

/// The endpoint is unavailable: record why and raise the banner.
fn fail<R: Runtime>(app: &AppHandle<R>, cause: &str) {
    let state = app.state::<AppState>();
    state.hooks.set_endpoint(Endpoint::Failed(cause.to_string()));
    // No hook will arrive any more: every token goes, and every hooked session is back on the
    // poll's Story 3.3 rules.
    state.hooks.drop_all();
    state.write_sessions_live().clear_hooked();
    let snapshot = {
        let mut settings = state.write();
        settings.hooks_banner = Some(Banner::new(BANNER_ID, format!("hooks endpoint unavailable: {cause}")));
        settings.snapshot()
    };
    crate::settings::emit(app, &snapshot);
}

#[cfg(test)]
pub mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpStream;

    /// One raw HTTP/1.1 request to `127.0.0.1:<port>` (`request_head` is the whole head; `body` is
    /// sent as is after the head); the reply's status code, head and body.
    pub fn raw(port: u16, request_head: &str, body: &[u8]) -> (u16, String, String) {
        let mut stream = TcpStream::connect((Ipv4Addr::LOCALHOST, port)).expect("connect");
        stream.set_read_timeout(Some(Duration::from_secs(30))).unwrap();
        let mut writer = stream.try_clone().unwrap();
        let payload = [request_head.as_bytes(), body].concat();
        let sender = std::thread::spawn(move || {
            // A refused body may be cut short by the server; that is not the test's concern.
            let _ = writer.write_all(&payload);
        });
        let mut reply = Vec::new();
        let _ = stream.read_to_end(&mut reply);
        let _ = sender.join();
        let reply = String::from_utf8_lossy(&reply).to_string();
        let status = reply
            .split_whitespace()
            .nth(1)
            .and_then(|code| code.parse().ok())
            .unwrap_or_else(|| panic!("no status line in {reply:?}"));
        let (head, body) = reply.split_once("\r\n\r\n").map(|(h, b)| (h.to_string(), b.to_string())).unwrap_or((reply.clone(), String::new()));
        (status, head, body)
    }

    /// One raw HTTP/1.1 request with a `Content-Length` body; the reply's status and body.
    pub fn http(port: u16, method: &str, path: &str, token: Option<&str>, body: &[u8]) -> (u16, String) {
        let auth = token.map(|t| format!("Authorization: Bearer {t}\r\n")).unwrap_or_default();
        let head = format!(
            "{method} {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nContent-Type: application/json\r\n{auth}Content-Length: {}\r\nConnection: close\r\n\r\n",
            body.len()
        );
        let (status, _, body) = raw(port, &head, body);
        (status, body)
    }

    /// Wait (bounded) for `pred`: hook events are applied after the reply, on a worker thread.
    pub fn eventually(what: &str, pred: impl Fn() -> bool) {
        let started = std::time::Instant::now();
        while !pred() {
            assert!(started.elapsed() < Duration::from_secs(10), "timed out waiting for {what}");
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    type Seen = Arc<Mutex<Vec<(String, HookSignal)>>>;

    /// The router on an ephemeral port with a recording `apply`; the task is aborted on drop.
    struct Server {
        port: u16,
        hooks: Hooks,
        seen: Seen,
        task: Option<tauri::async_runtime::JoinHandle<()>>,
    }

    impl Drop for Server {
        fn drop(&mut self) {
            if let Some(task) = self.task.take() {
                task.abort();
            }
        }
    }

    fn server_with(apply: impl Fn(&str, HookSignal) + Send + Sync + 'static) -> Server {
        let hooks = Hooks::default();
        let seen: Seen = Arc::default();
        let record = seen.clone();
        let apply: Apply = Arc::new(move |id, signal| {
            apply(id, signal.clone());
            record.lock().unwrap().push((id.to_string(), signal));
        });
        let listener = bind().unwrap();
        let port = listener.local_addr().unwrap().port();
        let app = router(hooks.clone(), apply, Arc::new(|_, _, _| Err("no app state".into())));
        let task = tauri::async_runtime::spawn(async move {
            let _ = serve(listener, app).await;
        });
        Server { port, hooks, seen, task: Some(task) }
    }

    fn server() -> Server {
        server_with(|_, _| {})
    }

    fn permission(detail: &str) -> HookSignal {
        HookSignal::Waiting { kind: WaitKind::Permission, detail: Some(detail.into()), notification: false }
    }

    #[test]
    fn events_map_onto_signals() {
        assert_eq!(map_event("SessionStart", &json!({ "source": "startup" })), Some(HookSignal::Started));
        assert_eq!(map_event("UserPromptSubmit", &json!({ "prompt": "hi" })), Some(HookSignal::Prompted));
        for event in ["PostToolUse", "PostToolUseFailure"] {
            assert_eq!(map_event(event, &json!({})), Some(HookSignal::ToolDone), "{event}");
        }
        assert_eq!(
            map_event("PermissionRequest", &json!({ "tool_name": "Bash", "tool_input": { "command": "echo hi" } })),
            Some(permission("permission: Bash"))
        );
        assert_eq!(
            map_event("Elicitation", &json!({ "message": "  Pick one  " })),
            Some(HookSignal::Waiting { kind: WaitKind::Input, detail: Some("Pick one".into()), notification: false })
        );
        for (kind, wait) in [
            ("permission_prompt", WaitKind::Permission),
            ("elicitation_dialog", WaitKind::Input),
            ("elicitation_url_dialog", WaitKind::Input),
            ("agent_needs_input", WaitKind::Input),
        ] {
            assert_eq!(
                map_event("Notification", &json!({ "notification_type": kind, "message": "Claude needs your permission to use Bash" })),
                Some(HookSignal::Waiting { kind: wait, detail: Some("Claude needs your permission to use Bash".into()), notification: true }),
                "{kind}"
            );
        }
        assert_eq!(map_event("Notification", &json!({ "notification_type": "idle_prompt", "message": "x" })), None);
        assert_eq!(map_event("Notification", &json!({ "message": "x" })), None);
        assert_eq!(
            map_event("Stop", &json!({ "last_assistant_message": "\n  Done.  \nDetails…" })),
            Some(HookSignal::Finished { last_line: Some("Done.".into()) })
        );
        assert_eq!(map_event("Stop", &json!({})), Some(HookSignal::Finished { last_line: None }));
        assert_eq!(
            map_event("StopFailure", &json!({ "error": "rate_limit" })),
            Some(HookSignal::Finished { last_line: Some(TURN_FAILED.into()) })
        );
        assert_eq!(map_event("PreToolUse", &json!({})), None);
        assert_eq!(map_event("SessionEnd", &json!({})), None);
    }

    #[test]
    fn a_detail_is_cut_to_300_characters() {
        let long = "x".repeat(400);
        let Some(HookSignal::Waiting { detail: Some(detail), .. }) =
            map_event("Notification", &json!({ "notification_type": "permission_prompt", "message": long }))
        else {
            panic!("a waiting signal");
        };
        assert_eq!(detail.chars().count(), DETAIL_MAX + 1);
        assert_eq!(detail, format!("{}…", "x".repeat(300)));
        let exact = "y".repeat(300);
        assert_eq!(
            map_event("Elicitation", &json!({ "message": exact })),
            Some(HookSignal::Waiting { kind: WaitKind::Input, detail: Some(exact), notification: false })
        );
    }

    #[test]
    fn the_last_line_is_the_first_non_empty_line_cut_to_200() {
        assert_eq!(last_line("Done.\nDetails…"), Some("Done.".into()));
        assert_eq!(last_line("  \n\t\n  x  "), Some("x".into()));
        assert_eq!(last_line(" \n "), None);
        let long = "é".repeat(500);
        let cut_line = last_line(&long).unwrap();
        assert_eq!(cut_line.chars().count(), 201);
        assert!(cut_line.ends_with('…'));
        assert_eq!(cut_line.chars().take(200).collect::<String>(), "é".repeat(200));
        assert_eq!(last_line(&"a".repeat(200)), Some("a".repeat(200)), "exactly 200: not cut");
    }

    #[test]
    fn the_settings_file_wires_each_event_as_an_http_hook_with_the_bearer() {
        let value = settings_json(4242, "t0k");
        let hooks = value["hooks"].as_object().unwrap();
        assert_eq!(hooks.keys().cloned().collect::<std::collections::BTreeSet<_>>(), EVENTS.iter().map(|e| e.to_string()).collect());
        for event in EVENTS {
            let groups = hooks[event].as_array().unwrap();
            assert_eq!(groups.len(), 1);
            let hook = &groups[0]["hooks"][0];
            assert_eq!(hook["type"], "http");
            assert_eq!(hook["url"], format!("http://127.0.0.1:4242/hooks/{event}"));
            assert_eq!(hook["headers"]["Authorization"], "Bearer t0k");
            assert_eq!(hook["timeout"], 5);
            if event == "Notification" {
                assert_eq!(groups[0]["matcher"], NOTIFICATION_MATCHER);
            } else {
                assert!(groups[0].get("matcher").is_none(), "{event}");
            }
        }
        assert!(hooks.get("PreToolUse").is_none());
        // Story 7.1: exactly the read tools are allowed, so they never prompt (Story 7.2: never
        // the act tools; Story 7.3: the peer tools too).
        assert_eq!(
            value["permissions"]["allow"],
            json!([
                "mcp__switchboard__my_node",
                "mcp__switchboard__workspace",
                "mcp__switchboard__node",
                "mcp__switchboard__peers",
                "mcp__switchboard__sessions",
                "mcp__switchboard__send",
                "mcp__switchboard__inbox"
            ])
        );
        assert_eq!(value.as_object().unwrap().len(), 2, "hooks and permissions only");
    }

    #[test]
    fn tokens_are_64_hex_unique_and_die_with_their_session() {
        let hooks = Hooks::default();
        let a = hooks.register("s1");
        let b = hooks.register("s2");
        assert_eq!(a.len(), 64);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(a, b);
        assert_eq!(hooks.session_for(&a).as_deref(), Some("s1"));
        assert_eq!(hooks.session_for(&b).as_deref(), Some("s2"));
        assert_eq!(hooks.session_for(&a[..63]), None);
        assert_eq!(hooks.session_for(""), None);
        hooks.drop_session("s1");
        assert_eq!(hooks.session_for(&a), None);
        assert!(!hooks.has_token("s1") && hooks.has_token("s2"));
        assert_eq!(hooks.token_count(), 1);
        hooks.drop_all();
        assert_eq!(hooks.token_count(), 0);
        assert!(constant_time_eq(b"abc", b"abc") && !constant_time_eq(b"abc", b"abd") && !constant_time_eq(b"ab", b"abc"));
    }

    #[test]
    fn ids_a_session_start_announces_are_not_mismatches() {
        let hooks = Hooks::default();
        hooks.register("s1");
        assert!(!hooks.check_session_id("s1", "s1", "Stop"));
        assert!(hooks.check_session_id("s1", "other", "Stop"), "an unannounced id");
        // `/clear`: SessionStart with the new id on the same token.
        assert!(!hooks.check_session_id("s1", "cleared", "SessionStart"));
        assert!(!hooks.check_session_id("s1", "cleared", "PermissionRequest"));
        assert!(hooks.check_session_id("s1", "other", "Stop"));
        hooks.drop_session("s1");
        assert!(hooks.check_session_id("s1", "cleared", "Stop"), "forgotten with the session");
    }

    #[test]
    fn the_endpoint_accepts_known_tokens_with_an_empty_200_and_refuses_the_rest() {
        let s = server();
        let token = s.hooks.register("s1");
        let post = |path: &str, token: Option<&str>, body: &str| http(s.port, "POST", path, token, body.as_bytes());

        let (status, body) = post("/hooks/PermissionRequest", Some(&token), r#"{"session_id":"s1","tool_name":"Bash"}"#);
        assert_eq!((status, body.as_str()), (200, ""), "an empty 200: the decision is Claude's");
        eventually("the first event applied", || s.seen.lock().unwrap().len() == 1);
        assert_eq!(*s.seen.lock().unwrap(), [("s1".to_string(), permission("permission: Bash"))]);

        // A different session id in the payload: counted, still applied to the token's session.
        assert_eq!(post("/hooks/Stop", Some(&token), r#"{"session_id":"other","last_assistant_message":"Done.\nMore"}"#).0, 200);
        eventually("the stop applied", || s.seen.lock().unwrap().len() == 2);
        assert_eq!(s.seen.lock().unwrap()[1], ("s1".to_string(), HookSignal::Finished { last_line: Some("Done.".into()) }));
        // A SessionStart announcing a new id (`/clear`) and an event carrying it: no mismatch.
        assert_eq!(post("/hooks/SessionStart", Some(&token), r#"{"session_id":"cleared"}"#).0, 200);
        assert_eq!(post("/hooks/UserPromptSubmit", Some(&token), r#"{"session_id":"cleared"}"#).0, 200);
        // Garbage JSON or an event that changes nothing: still an empty 200.
        assert_eq!(post("/hooks/Notification", Some(&token), "not json"), (200, String::new()));
        eventually("all four applied", || s.seen.lock().unwrap().len() == 4);

        // Refusals: unknown token 401, other path / method 404, big body 413, each closing.
        assert_eq!(post("/hooks/Stop", Some("nope"), "{}").0, 401);
        assert_eq!(post("/hooks/Stop", None, "{}").0, 401);
        assert_eq!(post("/hooks/PreToolUse", Some(&token), "{}").0, 404);
        assert_eq!(post("/other", Some(&token), "{}").0, 404);
        assert_eq!(http(s.port, "GET", "/hooks/Stop", Some(&token), b"").0, 404);
        let big = vec![b' '; 2 * 1024 * 1024];
        assert_eq!(http(s.port, "POST", "/hooks/Stop", Some(&token), &big).0, 413);
        let refused_head = raw(
            s.port,
            "POST /hooks/Stop HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer nope\r\nContent-Length: 2\r\n\r\n",
            b"{}",
        )
        .1;
        assert!(refused_head.to_ascii_lowercase().contains("connection: close"), "{refused_head}");
        std::thread::sleep(Duration::from_millis(50));
        assert_eq!(s.seen.lock().unwrap().len(), 4, "no refused request changed anything");

        let d = s.hooks.diagnostics(7);
        assert_eq!((d.hook_events, d.refused, d.session_mismatches, d.poll_overrides), (5, 7, 1, 7));
        assert_eq!(d.endpoint, None, "this registry was never marked up");

        // The session exits: its token is dropped.
        s.hooks.drop_session("s1");
        assert_eq!(post("/hooks/Stop", Some(&token), "{}").0, 401);
    }

    #[test]
    fn oversized_and_unauthenticated_bodies_are_refused_without_being_buffered() {
        let s = server();
        let token = s.hooks.register("s1");
        // Chunked, over the limit as it arrives: 413.
        let chunk = vec![b'a'; 64 * 1024];
        let mut chunked = Vec::new();
        for _ in 0..20 {
            chunked.extend_from_slice(format!("{:x}\r\n", chunk.len()).as_bytes());
            chunked.extend_from_slice(&chunk);
            chunked.extend_from_slice(b"\r\n");
        }
        chunked.extend_from_slice(b"0\r\n\r\n");
        let head = format!("POST /hooks/Stop HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer {token}\r\nTransfer-Encoding: chunked\r\n\r\n");
        let (status, head, _) = raw(s.port, &head, &chunked);
        assert_eq!(status, 413);
        assert!(head.to_ascii_lowercase().contains("connection: close"), "{head}");
        // Declared over the drain cap: 413 at once, from the head alone (no body sent).
        let head = format!("POST /hooks/Stop HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer {token}\r\nContent-Length: {}\r\n\r\n", 64 * 1024 * 1024);
        assert_eq!(raw(s.port, &head, b"").0, 413);
        // A big body without a valid token: 401, decided from the head.
        let big = vec![b' '; 2 * 1024 * 1024];
        assert_eq!(http(s.port, "POST", "/hooks/Stop", Some("nope"), &big).0, 401);
        // Exactly 1 MiB is accepted.
        let mut fits = b"{\"last_assistant_message\":\"ok\"}".to_vec();
        fits.resize(MAX_BODY, b' ');
        assert_eq!(http(s.port, "POST", "/hooks/Stop", Some(&token), &fits).0, 200);
        eventually("the 1 MiB event applied", || s.seen.lock().unwrap().len() == 1);
        let d = s.hooks.diagnostics(0);
        assert_eq!((d.hook_events, d.refused), (1, 3));
    }

    #[test]
    fn the_reply_does_not_wait_for_the_apply_step() {
        let (release, gate) = std::sync::mpsc::channel::<()>();
        let gate = Mutex::new(gate);
        let s = server_with(move |_, _| {
            // A slow apply (a contended live lock, say): held until the test releases it.
            let _ = gate.lock().unwrap().recv_timeout(Duration::from_secs(10));
        });
        let token = s.hooks.register("s1");
        let started = std::time::Instant::now();
        assert_eq!(http(s.port, "POST", "/hooks/UserPromptSubmit", Some(&token), b"{}").0, 200);
        assert_eq!(http(s.port, "POST", "/hooks/Stop", Some(&token), b"{}").0, 200);
        assert!(started.elapsed() < Duration::from_secs(5), "replied before the apply ran");
        assert!(s.seen.lock().unwrap().is_empty());
        release.send(()).unwrap();
        release.send(()).unwrap();
        eventually("both applied, in order", || s.seen.lock().unwrap().len() == 2);
        assert_eq!(s.seen.lock().unwrap()[0].1, HookSignal::Prompted);
    }

    /// Story 7.2: a tool that answers after 15 s (an operator slow at the toast) still gets its
    /// reply through: the idle timer does not apply while the reply is pending; and the
    /// connection, kept alive, is closed 10 s after the reply once it is silent again.
    #[test]
    fn a_pending_mcp_reply_outlives_the_read_timeout() {
        let hooks = Hooks::default();
        let listener = bind().unwrap();
        let port = listener.local_addr().unwrap().port();
        let tools: crate::mcp::Tools = Arc::new(|_, _, _| {
            std::thread::sleep(READ_TIMEOUT + Duration::from_secs(5));
            Ok(json!({ "slow": true }))
        });
        let app = router(hooks.clone(), Arc::new(|_, _| {}), tools);
        let task = tauri::async_runtime::spawn(async move {
            let _ = serve(listener, app).await;
        });
        let token = hooks.register("s1");
        let body = json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": { "name": "my_node" } }).to_string();
        let mut stream = TcpStream::connect((Ipv4Addr::LOCALHOST, port)).unwrap();
        stream.set_read_timeout(Some(Duration::from_secs(60))).unwrap();
        // Keep-alive: the connection stays open after the reply.
        let head = format!(
            "POST /mcp HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer {token}\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n",
            body.len()
        );
        stream.write_all(head.as_bytes()).unwrap();
        stream.write_all(body.as_bytes()).unwrap();
        let started = std::time::Instant::now();
        let mut reply = Vec::new();
        let mut chunk = [0u8; 4096];
        while !String::from_utf8_lossy(&reply).contains("slow") {
            let n = stream.read(&mut chunk).expect("the reply arrives");
            assert!(n > 0, "closed before the reply: {}", String::from_utf8_lossy(&reply));
            reply.extend_from_slice(&chunk[..n]);
        }
        let waited = started.elapsed();
        assert!(waited >= READ_TIMEOUT + Duration::from_secs(4), "replied after {waited:?}");
        let text = String::from_utf8_lossy(&reply).to_string();
        assert!(text.starts_with("HTTP/1.1 200"), "{text}");
        // Silent again: closed after the read timeout, counted from the reply.
        let after = std::time::Instant::now();
        let mut rest = Vec::new();
        let _ = stream.read_to_end(&mut rest);
        let idle = after.elapsed();
        assert!(idle >= READ_TIMEOUT - Duration::from_secs(1), "closed {idle:?} after the reply");
        assert!(idle < READ_TIMEOUT + Duration::from_secs(8), "closed {idle:?} after the reply");
        task.abort();
    }

    #[test]
    fn a_silent_connection_is_closed_after_the_read_timeout() {
        let s = server();
        let mut stream = TcpStream::connect((Ipv4Addr::LOCALHOST, s.port)).unwrap();
        stream.set_read_timeout(Some(READ_TIMEOUT + Duration::from_secs(10))).unwrap();
        // Half a head, then nothing.
        stream.write_all(b"POST /hooks/Stop HTTP/1.1\r\nHost: x\r\n").unwrap();
        let started = std::time::Instant::now();
        let mut reply = Vec::new();
        let _ = stream.read_to_end(&mut reply);
        let waited = started.elapsed();
        assert!(waited >= READ_TIMEOUT - Duration::from_secs(1), "closed after {waited:?}");
        assert!(waited < READ_TIMEOUT + Duration::from_secs(8), "closed after {waited:?}");
    }
}
