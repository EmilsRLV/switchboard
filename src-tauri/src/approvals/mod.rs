//! Agent approvals (Story 7.2): the act tools of the `switchboard` MCP server (`start_session`,
//! `link`, `unlink`) wait here for the operator. Rust owns the pending requests: each holds who
//! asked (the caller session), the tool, what will happen in words and, for a start, the exact
//! argv, whether "Always for this edge" is offered, and a deadline. The UI only shows them
//! (`approvals_get`, then every `approvals://pending`) and sends the operator's answer
//! (`approval_answer`).
//!
//! A tool call blocks its own worker thread (the MCP handler runs tools in `spawn_blocking`) on
//! one channel per request until the answer comes, [`ANSWER_TIMEOUT`] passes (denied: [`NO_ANSWER`])
//! or the caller's process exits (the request is dropped: [`caller_exited`]). Nothing here is
//! persisted; the per-edge "Always" lives on the stored edge (`graph::Edge::agent_allowed`) and
//! the workspace's allow-all on `graph::Workspace::agent_actions`.

use std::sync::mpsc::{self, RecvTimeoutError, SyncSender};
use std::sync::{Mutex, MutexGuard};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, Runtime};

use crate::settings::AppState;

/// The event carrying the whole pending list (oldest first) on every change.
pub const EVENT: &str = "approvals://pending";

/// The event carrying the one-line notice of an act that ran without a toast (allow all, or an
/// edge's Always): `<caller> started <name> on ui`.
pub const NOTICE_EVENT: &str = "approvals://notice";

/// The event carrying the `TermInfo` of a session an agent started, so the UI knows its
/// terminal without focusing it (the session starts in the background).
pub const STARTED_EVENT: &str = "approvals://started";

/// How long a request waits for the operator before it is denied.
pub const ANSWER_TIMEOUT: Duration = Duration::from_secs(120);

/// What a request nobody answered in time returns.
pub const NO_ANSWER: &str = "the operator did not answer";

/// What a request whose caller exited returns (nobody reads it: the caller is gone).
pub const CALLER_EXITED: &str = "the caller exited";

/// What an act tool returns when its caller already has [`MAX_PENDING_PER_CALLER`] requests
/// waiting (no toast).
pub const TOO_MANY: &str = "too many pending requests";

/// How many requests one caller may have waiting at once: each holds an HTTP connection (of the
/// endpoint's 64) and a blocking thread for up to [`ANSWER_TIMEOUT`].
pub const MAX_PENDING_PER_CALLER: usize = 3;

/// What a request whose `/mcp` call went away (the client timed out or disconnected) returns;
/// nobody reads it.
pub const CANCELLED: &str = "the request was withdrawn";

/// `approval_answer` for a request that is no longer pending (answered, timed out, dropped).
pub const NOT_PENDING: &str = "that request is no longer pending";

/// `approval_answer` with `always` for a request that does not offer it.
pub const ALWAYS_NOT_OFFERED: &str = "Always is not offered for this request";

/// The operator's answer.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Answer {
    Allow,
    Deny,
    /// Allow, and set `agentAllowed` on the edge joining the caller and the target.
    Always,
}

/// One pending request as the toast shows it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingRequest {
    pub id: String,
    /// The caller's session id.
    pub caller: String,
    /// The caller's name (its live `--name`, else its transcript title, else its project label).
    pub caller_name: String,
    /// `start_session`, `link` or `unlink`.
    pub tool: String,
    /// What will happen, in words: `start a session on ui`, `link session:… → project:… (context)`.
    pub action: String,
    /// The exact argv a start runs as one line ([`argv_line`]), or the edge described; shown
    /// in mono.
    pub detail: String,
    /// A start's argv, one entry per argument (the JSON twin of `detail`); `None` for a link.
    pub argv: Option<Vec<String>>,
    /// Whether "Always for this edge" is offered: a stored edge joins the caller and the target.
    pub always: bool,
    /// The other node of the pair "Always" is about, as the operator reads it (`ui`,
    /// `ui:feat`, a session's name); `None` when there is none.
    pub target: Option<String>,
    /// Milliseconds since the epoch.
    pub created_at: i64,
    /// When it is denied unanswered (ms since the epoch).
    pub deadline: i64,
}

/// What an act tool asks the operator.
#[derive(Debug, Clone)]
pub struct Ask {
    pub caller: String,
    pub caller_name: String,
    pub tool: String,
    pub action: String,
    pub detail: String,
    pub argv: Option<Vec<String>>,
    pub always: bool,
    pub target: Option<String>,
}

/// One pending request: what the toast shows, the channel its answer goes down, and the `/mcp`
/// call it belongs to (cancelled when that call goes away).
struct Entry {
    request: PendingRequest,
    tx: SyncSender<Answer>,
    call: Option<u64>,
}

/// How many cancelled call ids are remembered for a request not yet asked.
const CANCELLED_MEMORY: usize = 256;

#[derive(Default)]
struct Inner {
    pending: Vec<Entry>,
    /// `/mcp` calls that went away before their request was asked: a later `ask` from one of them
    /// is refused.
    cancelled: std::collections::VecDeque<u64>,
    next: u64,
    /// Tests shorten [`ANSWER_TIMEOUT`].
    timeout: Option<Duration>,
}

/// The pending requests (in `AppState`).
#[derive(Default)]
pub struct Approvals {
    inner: Mutex<Inner>,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|e| e.into_inner())
}

impl Approvals {
    /// The pending requests, oldest first.
    pub fn list(&self) -> Vec<PendingRequest> {
        lock(&self.inner).pending.iter().map(|e| e.request.clone()).collect()
    }

    /// Replace [`ANSWER_TIMEOUT`] (tests).
    pub fn set_timeout(&self, timeout: Duration) {
        lock(&self.inner).timeout = Some(timeout);
    }
}

fn emit<R: Runtime>(app: &AppHandle<R>, pending: &[Entry]) {
    let list: Vec<&PendingRequest> = pending.iter().map(|e| &e.request).collect();
    if let Err(err) = app.emit(EVENT, &list) {
        eprintln!("approvals: emit failed: {err}");
    }
}

thread_local! {
    /// The `/mcp` call the current thread is answering (`crate::mcp::handle` sets it around the
    /// tool), so a request [`ask`] makes is cancelled when that call goes away.
    static CALL: std::cell::Cell<Option<u64>> = const { std::cell::Cell::new(None) };
}

/// Run `work` as part of `/mcp` call `call` (see [`cancel_call`]).
pub fn within_call<T>(call: u64, work: impl FnOnce() -> T) -> T {
    CALL.with(|c| c.set(Some(call)));
    let out = work();
    CALL.with(|c| c.set(None));
    out
}

/// Put `ask` before the operator and wait for the answer (blocking this thread): `Ok` with the
/// answer, or `Err(NO_ANSWER)` after the timeout (the toast goes), or `Err(CALLER_EXITED)` /
/// `Err(CANCELLED)` when the request was dropped. Refused at once, with no toast: a caller that
/// is not running any more ([`CALLER_EXITED`]), one that already has
/// [`MAX_PENDING_PER_CALLER`] requests waiting ([`TOO_MANY`]), or a `/mcp` call that already went
/// away ([`CANCELLED`]). A new request also sends an OS notification while Switchboard is not
/// focused (`crate::notify::on_approval`). Call it off the async runtime.
pub fn ask<R: Runtime>(app: &AppHandle<R>, ask: Ask) -> Result<Answer, String> {
    let state = app.state::<AppState>();
    let approvals = &state.approvals;
    let call = CALL.with(std::cell::Cell::get);
    let (tx, rx) = mpsc::sync_channel::<Answer>(1);
    let (request, timeout) = {
        let mut inner = lock(&approvals.inner);
        if let Some(call) = call
            && let Some(at) = inner.cancelled.iter().position(|c| *c == call)
        {
            inner.cancelled.remove(at);
            return Err(CANCELLED.to_string());
        }
        // Under the lock: the exit hook drops a caller's requests after marking it exited, so a
        // request is either refused here or dropped there.
        let live = state.read_sessions_live().sessions.get(&ask.caller).is_some_and(|s| s.state.is_live());
        if !live {
            return Err(CALLER_EXITED.to_string());
        }
        if inner.pending.iter().filter(|e| e.request.caller == ask.caller).count() >= MAX_PENDING_PER_CALLER {
            return Err(TOO_MANY.to_string());
        }
        inner.next += 1;
        let id = format!("a{}", inner.next);
        let timeout = inner.timeout.unwrap_or(ANSWER_TIMEOUT);
        let now = crate::claude::live::now_ms();
        let request = PendingRequest {
            id,
            caller: ask.caller,
            caller_name: ask.caller_name,
            tool: ask.tool,
            action: ask.action,
            detail: ask.detail,
            argv: ask.argv,
            always: ask.always,
            target: ask.target,
            created_at: now,
            deadline: now.saturating_add(i64::try_from(timeout.as_millis()).unwrap_or(i64::MAX)),
        };
        inner.pending.push(Entry { request: request.clone(), tx, call });
        // Under the lock, so the lists go out in the order they were made.
        emit(app, &inner.pending);
        (request, timeout)
    };
    crate::notify::on_approval(app, &request.caller, &format!("{} wants to {}", request.caller_name, request.action));
    let id = request.id;
    match rx.recv_timeout(timeout) {
        Ok(answer) => Ok(answer),
        Err(RecvTimeoutError::Timeout) => {
            let mut inner = lock(&approvals.inner);
            let before = inner.pending.len();
            inner.pending.retain(|e| e.request.id != id);
            if inner.pending.len() != before {
                emit(app, &inner.pending);
                return Err(NO_ANSWER.to_string());
            }
            drop(inner);
            // Answered at the last moment: the answer is in the channel.
            rx.try_recv().map_err(|_| NO_ANSWER.to_string())
        }
        Err(RecvTimeoutError::Disconnected) => Err(CALLER_EXITED.to_string()),
    }
}

/// `/mcp` call `call` went away before its reply (the client timed out or disconnected): its
/// pending request is dropped (the toast goes, a late answer finds nothing), or, when it has not
/// asked yet, its later [`ask`] is refused.
pub fn cancel_call<R: Runtime>(app: &AppHandle<R>, call: u64) {
    let approvals = &app.state::<AppState>().approvals;
    let mut inner = lock(&approvals.inner);
    let before = inner.pending.len();
    inner.pending.retain(|e| e.call != Some(call));
    if inner.pending.len() != before {
        emit(app, &inner.pending);
        return;
    }
    inner.cancelled.push_back(call);
    while inner.cancelled.len() > CANCELLED_MEMORY {
        inner.cancelled.pop_front();
    }
}

/// The operator's answer to request `id` (`approval_answer`): the toast goes and the waiting tool
/// call resumes. `Err(NOT_PENDING)` for a request that is gone, `Err(ALWAYS_NOT_OFFERED)` for an
/// `always` the request does not offer (it stays pending).
pub fn answer<R: Runtime>(app: &AppHandle<R>, id: &str, answer: Answer) -> Result<(), String> {
    let approvals = &app.state::<AppState>().approvals;
    let mut inner = lock(&approvals.inner);
    let at = inner.pending.iter().position(|e| e.request.id == id).ok_or_else(|| NOT_PENDING.to_string())?;
    if answer == Answer::Always && !inner.pending[at].request.always {
        return Err(ALWAYS_NOT_OFFERED.to_string());
    }
    let entry = inner.pending.remove(at);
    emit(app, &inner.pending);
    // The channel holds one answer; a caller that stopped waiting just drops it.
    let _ = entry.tx.try_send(answer);
    Ok(())
}

/// Session `caller` exited: its pending requests are dropped (their toasts go; the waiting calls
/// end with [`CALLER_EXITED`]).
pub fn caller_exited<R: Runtime>(app: &AppHandle<R>, caller: &str) {
    let approvals = &app.state::<AppState>().approvals;
    let mut inner = lock(&approvals.inner);
    let before = inner.pending.len();
    inner.pending.retain(|e| e.request.caller != caller);
    if inner.pending.len() != before {
        emit(app, &inner.pending);
    }
}

/// Show the one-line notice of an act that ran without a toast.
pub fn notice<R: Runtime>(app: &AppHandle<R>, text: &str) {
    if let Err(err) = app.emit(NOTICE_EVENT, text) {
        eprintln!("approvals: notice failed: {err}");
    }
}

/// An argv as one line for the toast: a plain argument as is; one with whitespace (or empty) in
/// double quotes; one with a control character or a double quote as a JSON string (a multi-line
/// system prompt reads `"…\n…"`). The same text every time for the same argv.
pub fn argv_line(argv: &[String]) -> String {
    argv.iter()
        .map(|arg| {
            if arg.chars().any(|c| c.is_control() || c == '"') {
                serde_json::to_string(arg).unwrap_or_else(|_| arg.clone())
            } else if arg.is_empty() || arg.chars().any(char::is_whitespace) {
                format!("\"{arg}\"")
            } else {
                arg.clone()
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn app() -> tauri::App<tauri::test::MockRuntime> {
        let app = tauri::test::mock_builder()
            .manage(AppState::default())
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        {
            let state = app.state::<AppState>();
            let mut map = state.write_sessions_live();
            for id in ["s1", "s2"] {
                map.launched(id, None, "/w", id, 1);
            }
        }
        app
    }

    fn sample(caller: &str, always: bool) -> Ask {
        Ask {
            caller: caller.into(),
            caller_name: format!("{caller}-name"),
            tool: "start_session".into(),
            action: "start a session on ui".into(),
            detail: "claude --session-id x".into(),
            argv: None,
            always,
            target: always.then(|| "ui".to_string()),
        }
    }

    fn wait_for(app: &tauri::App<tauri::test::MockRuntime>, count: usize) -> Vec<PendingRequest> {
        let state = app.state::<AppState>();
        let started = std::time::Instant::now();
        loop {
            let list = state.approvals.list();
            if list.len() == count {
                return list;
            }
            assert!(started.elapsed() < Duration::from_secs(10), "timed out waiting for {count} pending");
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    #[test]
    fn a_request_waits_for_the_answer_oldest_first() {
        let app = app();
        let handle = app.handle().clone();
        let first = std::thread::spawn({
            let handle = handle.clone();
            move || ask(&handle, sample("s1", false))
        });
        wait_for(&app, 1);
        let second = std::thread::spawn({
            let handle = handle.clone();
            move || ask(&handle, sample("s2", true))
        });
        let list = wait_for(&app, 2);
        assert_eq!(list[0].caller, "s1", "oldest first");
        assert!(!list[0].always && list[1].always);
        assert!(list[0].deadline - list[0].created_at >= 119_000);
        assert_eq!(answer(app.handle(), &list[0].id, Answer::Always), Err(ALWAYS_NOT_OFFERED.to_string()));
        assert_eq!(app.state::<AppState>().approvals.list().len(), 2, "still pending");
        answer(app.handle(), &list[0].id, Answer::Deny).unwrap();
        assert_eq!(first.join().unwrap(), Ok(Answer::Deny));
        answer(app.handle(), &list[1].id, Answer::Always).unwrap();
        assert_eq!(second.join().unwrap(), Ok(Answer::Always));
        assert!(app.state::<AppState>().approvals.list().is_empty());
        assert_eq!(answer(app.handle(), &list[1].id, Answer::Allow), Err(NOT_PENDING.to_string()));
    }

    #[test]
    fn an_unanswered_request_is_denied_and_a_callers_exit_drops_its_requests() {
        let app = app();
        app.state::<AppState>().approvals.set_timeout(Duration::from_millis(200));
        assert_eq!(ask(app.handle(), sample("s1", false)), Err(NO_ANSWER.to_string()));
        assert!(app.state::<AppState>().approvals.list().is_empty(), "the toast went");

        app.state::<AppState>().approvals.set_timeout(Duration::from_secs(30));
        let handle = app.handle().clone();
        let waiting = std::thread::spawn(move || ask(&handle, sample("s1", false)));
        let other = std::thread::spawn({
            let handle = app.handle().clone();
            move || ask(&handle, sample("s2", false))
        });
        let list = wait_for(&app, 2);
        caller_exited(app.handle(), "s1");
        assert_eq!(waiting.join().unwrap(), Err(CALLER_EXITED.to_string()));
        let left = app.state::<AppState>().approvals.list();
        assert_eq!(left.len(), 1);
        assert_eq!(left[0].caller, "s2");
        let id = list.iter().find(|r| r.caller == "s2").unwrap().id.clone();
        answer(app.handle(), &id, Answer::Allow).unwrap();
        assert_eq!(other.join().unwrap(), Ok(Answer::Allow));
    }

    #[test]
    fn the_argv_line_quotes_only_what_needs_it() {
        let argv = ["claude", "--name", "ui-1a2b", "--append-system-prompt", "line one\nline \"two\"", ""].map(String::from);
        assert_eq!(argv_line(&argv), r#"claude --name ui-1a2b --append-system-prompt "line one\nline \"two\"" """#);
        assert_eq!(argv_line(&[r"C:\Program Files\claude.exe".to_string()]), r#""C:\Program Files\claude.exe""#);
    }

    #[test]
    fn a_dead_caller_a_fourth_request_and_a_cancelled_call_are_refused_without_a_toast() {
        let app = app();
        let state = app.state::<AppState>();
        assert_eq!(ask(app.handle(), sample("gone", false)), Err(CALLER_EXITED.to_string()));
        let handles: Vec<_> = (0..MAX_PENDING_PER_CALLER)
            .map(|_| {
                let handle = app.handle().clone();
                std::thread::spawn(move || ask(&handle, sample("s1", false)))
            })
            .collect();
        wait_for(&app, MAX_PENDING_PER_CALLER);
        assert_eq!(ask(app.handle(), sample("s1", false)), Err(TOO_MANY.to_string()));
        assert_eq!(state.approvals.list().len(), MAX_PENDING_PER_CALLER, "no toast for the fourth");
        caller_exited(app.handle(), "s1");
        for handle in handles {
            assert!(handle.join().unwrap().is_err());
        }
        // A call that went away before it asked: its ask is refused.
        cancel_call(app.handle(), 7);
        assert_eq!(within_call(7, || ask(app.handle(), sample("s2", false))), Err(CANCELLED.to_string()));
        // A call that goes away while its request waits: the toast goes, a late answer finds nothing.
        let handle = app.handle().clone();
        let waiting = std::thread::spawn(move || within_call(8, || ask(&handle, sample("s2", false))));
        let id = wait_for(&app, 1)[0].id.clone();
        cancel_call(app.handle(), 8);
        assert!(state.approvals.list().is_empty());
        assert!(waiting.join().unwrap().is_err());
        assert_eq!(answer(app.handle(), &id, Answer::Allow), Err(NOT_PENDING.to_string()));
    }

    #[test]
    fn a_new_request_notifies_while_unfocused_following_the_waiting_setting() {
        let app = app();
        let recorder = std::sync::Arc::new(crate::notify::fixtures::Recorder::default());
        *app.state::<AppState>().notifier.lock().unwrap() = Some(recorder.clone());
        app.state::<AppState>().approvals.set_timeout(Duration::from_millis(50));
        // No main window in the mock app: unfocused.
        let _ = ask(app.handle(), sample("s1", false));
        assert_eq!(
            *recorder.sent.lock().unwrap(),
            [("s1-name wants to start a session on ui".to_string(), crate::notify::APPROVAL_BODY.to_string())]
        );
        app.state::<AppState>().write().settings.notifications.waiting = false;
        let _ = ask(app.handle(), sample("s1", false));
        assert_eq!(recorder.sent.lock().unwrap().len(), 1, "waiting toasts are off");
    }
}
