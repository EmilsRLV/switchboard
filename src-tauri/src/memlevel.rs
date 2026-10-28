//! Story 9.6: WebView2's memory usage target level, `Low` while the app is idle.
//!
//! - **Idle** means no app window is focused (unfocused, minimized, hidden to the tray), or a
//!   window is focused but has had no keyboard, pointer or wheel input for [`IDLE_AFTER`]. The
//!   frontend reports input through `memory_activity` (at most once a second per window); focus
//!   comes from the window events (`lib.rs`).
//! - **Normal** returns at once on the next input or focus. `Low` is only ever reached on the
//!   ticker's 1 s beat, and losing focus (or a window closing) counts as a last use with a short
//!   grace ([`UNFOCUS_GRACE`]), so focus moving from the main window to a pop-out (lost, then
//!   gained) never flips the level. Until the ticker starts ([`start`]) the level stays `Normal`.
//! - **One owner.** The pure [`Machine`] decides; [`MemLevel`] (in `AppState`) wraps it in a
//!   mutex and queues each change, in order, to the ticker thread, the only caller of the
//!   [`Applier`]. No lock is held while applying (the WebView2 call runs on the main thread,
//!   which also delivers the focus events). Every webview window (main and pop-outs) gets the
//!   same level, each only when its own level changes: a window opened while at `Low` gets it on
//!   the next beat ([`Ticker`] tracks what each window was given).
//! - **Off Windows** WebKitGTK has no equivalent: the state machine still runs, no ticker is
//!   started and Diagnostics says `not supported` ([`SUPPORTED`]). The same goes for a WebView2
//!   runtime too old for `ICoreWebView2_19` ([`Health`]).
//!
//! No user setting, nothing persisted, nothing logged except a failed apply (once).

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;

/// No input for this long in a focused window: idle.
pub const IDLE_AFTER: Duration = Duration::from_secs(30);

/// No app window focused for this long (and no input meanwhile): idle. Covers the moment focus
/// moves between two app windows (lost on one, then gained on the other) and the frontend's 1 s
/// activity throttle, so a reported use is never undone by the next tick.
pub const UNFOCUS_GRACE: Duration = Duration::from_secs(2);

/// The ticker's beat: how often idleness is checked.
pub const TICK: Duration = Duration::from_secs(1);

/// Whether this platform's webview has a memory usage target level (WebView2 only).
pub const SUPPORTED: bool = cfg!(windows);

/// WebView2's memory usage target level.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Level {
    Normal,
    Low,
}

/// What Diagnostics shows (`perf_get`'s `memory_level`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Reported {
    Normal,
    Low,
    Unsupported,
}

/// The pure state machine: the focused app windows, the last use and the level applied.
#[derive(Debug)]
pub struct Machine {
    focused: HashSet<String>,
    last_use: Instant,
    level: Level,
    /// Set by [`Machine::arm`] (the ticker starting); until then the wanted level is `Normal`.
    armed: bool,
}

impl Machine {
    /// A machine at `Normal` (WebView2's default), not armed, with no window focused yet.
    pub fn new(now: Instant) -> Self {
        Self { focused: HashSet::new(), last_use: now, level: Level::Normal, armed: false }
    }

    /// Start deciding: the last use is `now` (start-up counts as use).
    pub fn arm(&mut self, now: Instant) {
        self.armed = true;
        self.last_use = self.last_use.max(now);
    }

    /// The level applied (or about to be).
    pub fn level(&self) -> Level {
        self.level
    }

    /// The level the app should have at `now`.
    pub fn wanted(&self, now: Instant) -> Level {
        if !self.armed {
            return Level::Normal;
        }
        let unused = now.saturating_duration_since(self.last_use);
        if unused >= IDLE_AFTER || (self.focused.is_empty() && unused >= UNFOCUS_GRACE) {
            Level::Low
        } else {
            Level::Normal
        }
    }

    /// Window `label` gained or lost focus at `now`. Either way it is a use: gaining focus brings
    /// `Normal` back; losing it starts the [`UNFOCUS_GRACE`].
    pub fn focus(&mut self, label: &str, focused: bool, now: Instant) {
        if focused {
            self.focused.insert(label.to_owned());
        } else {
            self.focused.remove(label);
        }
        self.last_use = self.last_use.max(now);
    }

    /// Window `label` is gone at `now`: like losing focus, a use that starts the grace.
    pub fn destroyed(&mut self, label: &str, now: Instant) {
        self.focused.remove(label);
        self.last_use = self.last_use.max(now);
    }

    /// Keyboard, pointer or wheel input in some app window at `now`.
    pub fn activity(&mut self, now: Instant) {
        self.last_use = self.last_use.max(now);
    }

    /// Move to the wanted level: the new level when it changed, else `None`. With `allow_low`
    /// false (an event, not the ticker) only a change to `Normal` is taken.
    pub fn update(&mut self, now: Instant, allow_low: bool) -> Option<Level> {
        let wanted = self.wanted(now);
        if wanted == self.level || (wanted == Level::Low && !allow_low) {
            return None;
        }
        self.level = wanted;
        Some(wanted)
    }
}

/// Whether applying works: one once-only failure log for every failure (the ticker's dispatch
/// errors and the main-thread call's), and whether the runtime lacks the API.
#[derive(Debug, Default)]
pub struct Health {
    failure_logged: AtomicBool,
    unsupported: AtomicBool,
}

impl Health {
    /// Log `message` if no failure was logged yet; returns whether this call logged.
    pub fn log_failure(&self, message: &str) -> bool {
        if self.failure_logged.swap(true, Ordering::Relaxed) {
            return false;
        }
        eprintln!("memory target: {message}");
        true
    }

    /// The WebView2 runtime has no memory target level (Diagnostics then says `not supported`).
    pub fn mark_unsupported(&self) {
        self.unsupported.store(true, Ordering::Relaxed);
    }

    pub fn is_unsupported(&self) -> bool {
        self.unsupported.load(Ordering::Relaxed)
    }
}

/// Sets one app webview's memory usage target level (tests inject a recorder).
pub trait Applier: Send + 'static {
    /// The labels of the app's webview windows now.
    fn windows(&self) -> Vec<String>;
    /// Set window `label`'s level.
    fn apply(&mut self, label: &str, level: Level) -> Result<(), String>;
}

/// What the ticker is told, in order.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Msg {
    /// The level changed.
    Level(Level),
    /// A window is gone: forget what it was given.
    Destroyed(String),
}

struct Inner {
    machine: Machine,
    /// The ticker's queue; `None` until [`MemLevel::start_queue`].
    queue: Option<Sender<Msg>>,
}

/// The state behind a mutex (in `AppState`). Each change is queued while the lock is held, so the
/// ticker applies the changes in the order they were decided.
pub struct MemLevel {
    inner: Mutex<Inner>,
    health: Arc<Health>,
}

impl Default for MemLevel {
    fn default() -> Self {
        Self {
            inner: Mutex::new(Inner { machine: Machine::new(Instant::now()), queue: None }),
            health: Arc::default(),
        }
    }
}

impl MemLevel {
    fn with<T>(&self, f: impl FnOnce(&mut Inner) -> T) -> T {
        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        f(&mut inner)
    }

    /// Update at `now` and queue a change (the queue's send never blocks).
    fn step(inner: &mut Inner, now: Instant, allow_low: bool) {
        if let Some(level) = inner.machine.update(now, allow_low)
            && let Some(queue) = &inner.queue
        {
            let _ = queue.send(Msg::Level(level));
        }
    }

    /// Window `label` gained or lost focus.
    pub fn on_focus(&self, label: &str, focused: bool, now: Instant) {
        self.with(|inner| {
            inner.machine.focus(label, focused, now);
            Self::step(inner, now, false);
        });
    }

    /// Window `label` was destroyed at `now`.
    pub fn on_destroyed(&self, label: &str, now: Instant) {
        self.with(|inner| {
            inner.machine.destroyed(label, now);
            if let Some(queue) = &inner.queue {
                let _ = queue.send(Msg::Destroyed(label.to_owned()));
            }
        });
    }

    /// Input in some app window (`memory_activity`): back to `Normal` at once when at `Low`.
    pub fn on_activity(&self, now: Instant) {
        self.with(|inner| {
            inner.machine.activity(now);
            Self::step(inner, now, false);
        });
    }

    /// The ticker's beat: `Low` once idle.
    pub fn tick(&self, now: Instant) {
        self.with(|inner| Self::step(inner, now, true));
    }

    /// The level applied (or queued).
    pub fn level(&self) -> Level {
        self.with(|inner| inner.machine.level())
    }

    /// The shared failure state (the applier's and the ticker's).
    pub fn health(&self) -> Arc<Health> {
        self.health.clone()
    }

    /// What Diagnostics shows: the level, or `unsupported` off Windows or on a runtime without
    /// the API.
    pub fn reported(&self) -> Reported {
        if !SUPPORTED || self.health.is_unsupported() {
            return Reported::Unsupported;
        }
        match self.level() {
            Level::Normal => Reported::Normal,
            Level::Low => Reported::Low,
        }
    }

    /// Arm the machine at `now` (start-up counts as use) and start queueing changes; the receiver
    /// goes to the ticker ([`run_ticker`]).
    pub fn start_queue(&self, now: Instant) -> Receiver<Msg> {
        let (tx, rx) = mpsc::channel();
        self.with(|inner| {
            inner.machine.arm(now);
            inner.queue = Some(tx);
        });
        rx
    }
}

/// Applies the level to every window through an [`Applier`], each window only when what it was
/// given differs (a window never given anything has WebView2's default, `Normal`).
pub struct Ticker<A: Applier> {
    applier: A,
    health: Arc<Health>,
    target: Level,
    given: HashMap<String, Level>,
}

impl<A: Applier> Ticker<A> {
    pub fn new(applier: A, health: Arc<Health>) -> Self {
        Self { applier, health, target: Level::Normal, given: HashMap::new() }
    }

    /// Take one message from the queue.
    pub fn handle(&mut self, msg: Msg) {
        match msg {
            Msg::Level(level) => {
                self.target = level;
                self.sync();
            }
            Msg::Destroyed(label) => {
                self.given.remove(&label);
            }
        }
    }

    /// Give the target level to every window that does not have it yet (new windows included).
    /// A failed window counts as given (no retry every beat); the failure is logged once.
    pub fn sync(&mut self) {
        for label in self.applier.windows() {
            if self.given.get(&label).copied().unwrap_or(Level::Normal) == self.target {
                continue;
            }
            if let Err(err) = self.applier.apply(&label, self.target) {
                self.health.log_failure(&format!("cannot set {:?} on {label}: {err}", self.target));
            }
            self.given.insert(label, self.target);
        }
    }
}

/// The ticker loop: handle each queued message as it comes; with none for `beat`, call `tick`
/// (which queues `Low` once idle) and give the level to any new window. In the app the queue's
/// sender lives in `AppState` for the whole process, so this runs until exit; it ends only if
/// the sender is dropped (tests).
pub fn run_ticker<A: Applier>(rx: Receiver<Msg>, mut ticker: Ticker<A>, beat: Duration, mut tick: impl FnMut()) {
    loop {
        match rx.recv_timeout(beat) {
            Ok(msg) => ticker.handle(msg),
            Err(RecvTimeoutError::Timeout) => {
                tick();
                ticker.sync();
            }
            Err(RecvTimeoutError::Disconnected) => return,
        }
    }
}

/// Start the ticker thread (`setup`): the only caller of the WebView2 API. Not started where the
/// webview has no memory target level ([`SUPPORTED`]); the level then stays `Normal`.
pub fn start(app: &tauri::AppHandle<tauri::Wry>) {
    use tauri::Manager;
    if !SUPPORTED {
        return;
    }
    let memlevel = &app.state::<crate::settings::AppState>().memlevel;
    let rx = memlevel.start_queue(Instant::now());
    let health = memlevel.health();
    let handle = app.clone();
    let applier = WebviewApplier::new(app.clone(), health.clone());
    let spawned = std::thread::Builder::new().name("memlevel".into()).spawn(move || {
        run_ticker(rx, Ticker::new(applier, health), TICK, move || {
            handle.state::<crate::settings::AppState>().memlevel.tick(Instant::now());
        });
    });
    if let Err(err) = spawned {
        eprintln!("memory target: cannot start the ticker: {err}");
    }
}

/// The real applier: a webview window's WebView2 (`ICoreWebView2_19`), on the main thread.
pub struct WebviewApplier {
    #[cfg_attr(not(windows), allow(dead_code))]
    app: tauri::AppHandle<tauri::Wry>,
    /// Shared with the ticker and `MemLevel`: a failure inside the main-thread call is logged
    /// there (once), and a missing interface marks the runtime unsupported.
    #[cfg_attr(not(windows), allow(dead_code))]
    health: Arc<Health>,
}

impl WebviewApplier {
    pub fn new(app: tauri::AppHandle<tauri::Wry>, health: Arc<Health>) -> Self {
        Self { app, health }
    }
}

impl Applier for WebviewApplier {
    fn windows(&self) -> Vec<String> {
        use tauri::Manager;
        self.app.webview_windows().into_keys().collect()
    }

    #[cfg(windows)]
    fn apply(&mut self, label: &str, level: Level) -> Result<(), String> {
        use tauri::Manager;
        let window = self.app.get_webview_window(label).ok_or_else(|| "window is gone".to_owned())?;
        let health = self.health.clone();
        window
            .with_webview(move |webview| match set_level(&webview, level) {
                Ok(()) => {}
                Err(SetError::Unsupported(err)) => {
                    health.mark_unsupported();
                    health.log_failure(&format!("not supported by this WebView2 runtime: {err}"));
                }
                Err(SetError::Failed(err)) => {
                    health.log_failure(&format!("cannot set {level:?}: {err}"));
                }
            })
            .map_err(|e| e.to_string())
    }

    #[cfg(not(windows))]
    fn apply(&mut self, _label: &str, _level: Level) -> Result<(), String> {
        Ok(())
    }
}

#[cfg(windows)]
enum SetError {
    /// No `ICoreWebView2_19` (a runtime older than the API).
    Unsupported(String),
    Failed(String),
}

/// `SetMemoryUsageTargetLevel` on one webview (main thread).
#[cfg(windows)]
fn set_level(webview: &tauri::webview::PlatformWebview, level: Level) -> Result<(), SetError> {
    // The leading `::`: this crate has its own `mod windows`.
    use ::windows::core::Interface;
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW, COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL, ICoreWebView2_19,
    };
    let target = match level {
        Level::Normal => COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL,
        Level::Low => COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW,
    };
    // SAFETY: COM calls on the webview's own controller, made on the main thread (`with_webview`).
    unsafe {
        let core = webview.controller().CoreWebView2().map_err(|e| SetError::Failed(e.to_string()))?;
        let core19 = core.cast::<ICoreWebView2_19>().map_err(|e| SetError::Unsupported(e.to_string()))?;
        core19.SetMemoryUsageTargetLevel(target).map_err(|e| SetError::Failed(e.to_string()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn secs(n: u64) -> Duration {
        Duration::from_secs(n)
    }

    /// An armed [`MemLevel`] whose queue the test drains.
    fn queued() -> (MemLevel, Receiver<Msg>, Instant) {
        let start = Instant::now();
        let mem = MemLevel::default();
        let rx = mem.start_queue(start);
        (mem, rx, start)
    }

    /// The level changes queued so far (destroy messages left out).
    fn drain(rx: &Receiver<Msg>) -> Vec<Level> {
        rx.try_iter()
            .filter_map(|m| match m {
                Msg::Level(level) => Some(level),
                Msg::Destroyed(_) => None,
            })
            .collect()
    }

    /// Focused, no input for 30 s: `Low`, once.
    #[test]
    fn idle_while_focused_goes_low_once() {
        let (mem, rx, t0) = queued();
        mem.on_focus("main", true, t0);
        for s in 1..30 {
            mem.tick(t0 + secs(s));
        }
        assert_eq!(drain(&rx), vec![], "still in use before 30 s");
        mem.tick(t0 + secs(30));
        mem.tick(t0 + secs(31));
        mem.tick(t0 + secs(120));
        assert_eq!(drain(&rx), vec![Level::Low], "applied once");
        assert_eq!(mem.level(), Level::Low);
    }

    /// At `Low`, input in any window: `Normal` at once (no tick needed).
    #[test]
    fn use_brings_normal_back_at_once() {
        let (mem, rx, t0) = queued();
        mem.on_focus("main", true, t0);
        mem.on_focus("main", false, t0 + secs(1));
        mem.on_focus("term-3", true, t0 + secs(1));
        mem.tick(t0 + secs(40));
        assert_eq!(drain(&rx), vec![Level::Low]);
        // Input reported by the pop-out.
        mem.on_activity(t0 + secs(41));
        assert_eq!(drain(&rx), vec![Level::Normal]);
        assert_eq!(mem.level(), Level::Normal);
        // And it stays Normal while in use.
        mem.tick(t0 + secs(42));
        assert_eq!(drain(&rx), vec![]);
    }

    /// Every app window losing focus: `Low` on the next tick past the grace, not after 30 s.
    #[test]
    fn unfocus_goes_low_without_waiting_thirty_seconds() {
        let (mem, rx, t0) = queued();
        mem.on_focus("main", true, t0);
        mem.on_focus("main", false, t0 + secs(5));
        assert_eq!(drain(&rx), vec![], "an event never applies Low itself");
        mem.tick(t0 + secs(6));
        assert_eq!(drain(&rx), vec![], "within the grace");
        mem.tick(t0 + secs(5) + UNFOCUS_GRACE);
        assert_eq!(drain(&rx), vec![Level::Low]);
        assert!(UNFOCUS_GRACE < IDLE_AFTER);
    }

    /// A window gaining focus: `Normal`, and the 30 s count starts again.
    #[test]
    fn refocus_brings_normal_back() {
        let (mem, rx, t0) = queued();
        mem.tick(t0 + secs(3));
        assert_eq!(drain(&rx), vec![Level::Low], "never focused: idle");
        mem.on_focus("main", true, t0 + secs(100));
        assert_eq!(drain(&rx), vec![Level::Normal]);
        mem.tick(t0 + secs(129));
        assert_eq!(drain(&rx), vec![], "focus counts as use");
        mem.tick(t0 + secs(130));
        assert_eq!(drain(&rx), vec![Level::Low]);
    }

    /// Focus moving from main to a pop-out (lost, a tick in between, gained): no change.
    #[test]
    fn main_to_popout_changes_nothing() {
        let (mem, rx, t0) = queued();
        mem.on_focus("main", true, t0);
        mem.on_focus("main", false, t0 + secs(10));
        mem.tick(t0 + secs(10));
        mem.on_focus("term-1", true, t0 + secs(10));
        mem.tick(t0 + secs(11));
        mem.tick(t0 + secs(20));
        assert_eq!(drain(&rx), vec![]);
        assert_eq!(mem.level(), Level::Normal);
    }

    /// A focused window destroyed without losing focus first: a use that starts the grace, so
    /// the main window regaining focus right after changes nothing.
    #[test]
    fn a_destroyed_focused_window_starts_the_grace() {
        let (mem, rx, t0) = queued();
        mem.on_focus("term-1", true, t0);
        mem.on_destroyed("term-1", t0 + secs(20));
        assert_eq!(rx.try_iter().collect::<Vec<_>>(), vec![Msg::Destroyed("term-1".into())]);
        mem.tick(t0 + secs(21));
        assert_eq!(drain(&rx), vec![], "within the grace");
        mem.on_focus("main", true, t0 + secs(21));
        mem.tick(t0 + secs(25));
        assert_eq!(drain(&rx), vec![]);
        // Nothing focused again: Low past the grace.
        mem.on_destroyed("main", t0 + secs(26));
        mem.tick(t0 + secs(26) + UNFOCUS_GRACE);
        assert_eq!(drain(&rx), vec![Level::Low]);
    }

    /// Continuous typing at `Normal`: no apply at all.
    #[test]
    fn steady_use_applies_nothing() {
        let (mem, rx, t0) = queued();
        mem.on_focus("main", true, t0);
        for s in 0..300 {
            mem.on_activity(t0 + secs(s));
            mem.tick(t0 + secs(s));
        }
        assert_eq!(drain(&rx), vec![]);
    }

    /// Out-of-order clocks (an event stamped before the last use) never move the last use back.
    #[test]
    fn the_last_use_never_goes_back() {
        let t0 = Instant::now();
        let mut m = Machine::new(t0);
        m.arm(t0);
        m.focus("main", true, t0 + secs(10));
        m.activity(t0 + secs(5));
        assert_eq!(m.wanted(t0 + secs(39)), Level::Normal);
        assert_eq!(m.wanted(t0 + secs(40)), Level::Low);
    }

    /// Before the ticker starts the level stays `Normal`, however long start-up takes; arming
    /// counts as a use.
    #[test]
    fn normal_until_armed_and_arming_is_a_use() {
        let t0 = Instant::now();
        let mem = MemLevel::default();
        mem.tick(t0 + secs(100));
        assert_eq!(mem.level(), Level::Normal, "not armed: Normal");
        let rx = mem.start_queue(t0 + secs(100));
        mem.tick(t0 + secs(101));
        assert_eq!(drain(&rx), vec![], "armed at 100 s: within the grace");
        mem.tick(t0 + secs(100) + UNFOCUS_GRACE);
        assert_eq!(drain(&rx), vec![Level::Low]);
    }

    /// What Diagnostics shows: the level on Windows; `unsupported` elsewhere or once the runtime
    /// lacks the API.
    #[test]
    fn reported_follows_the_platform_and_the_runtime() {
        let (mem, _rx, t0) = queued();
        let expect = |level| if SUPPORTED { level } else { Reported::Unsupported };
        assert_eq!(mem.reported(), expect(Reported::Normal));
        mem.tick(t0 + secs(5));
        assert_eq!(mem.reported(), expect(Reported::Low));
        mem.health().mark_unsupported();
        assert_eq!(mem.reported(), Reported::Unsupported);
        assert_eq!(serde_json::to_value(Reported::Unsupported).unwrap(), "unsupported");
        assert_eq!(serde_json::to_value(Reported::Low).unwrap(), "low");
    }

    /// Records each window's applies; `windows` is the window list the test sets.
    struct Recorder {
        windows: Arc<Mutex<Vec<String>>>,
        applied: Arc<Mutex<Vec<(String, Level)>>>,
        fail: bool,
    }

    impl Applier for Recorder {
        fn windows(&self) -> Vec<String> {
            self.windows.lock().unwrap().clone()
        }
        fn apply(&mut self, label: &str, level: Level) -> Result<(), String> {
            self.applied.lock().unwrap().push((label.to_owned(), level));
            if self.fail { Err("window is gone".into()) } else { Ok(()) }
        }
    }

    type Shared<T> = Arc<Mutex<T>>;
    type Applied = Shared<Vec<(String, Level)>>;

    fn recorder(labels: &[&str], fail: bool) -> (Recorder, Shared<Vec<String>>, Applied) {
        let windows = Arc::new(Mutex::new(labels.iter().map(|l| l.to_string()).collect()));
        let applied = Arc::new(Mutex::new(Vec::new()));
        (Recorder { windows: windows.clone(), applied: applied.clone(), fail }, windows, applied)
    }

    fn take(applied: &Applied) -> Vec<(String, Level)> {
        std::mem::take(&mut *applied.lock().unwrap())
    }

    fn pair(label: &str, level: Level) -> (String, Level) {
        (label.to_owned(), level)
    }

    /// Every window gets each change once; a window opened while at `Low` gets `Low` on the next
    /// beat; one opened at `Normal` gets nothing (that is WebView2's default); a destroyed label
    /// reused later is treated as new.
    #[test]
    fn every_window_gets_the_level_including_new_ones() {
        let (rec, windows, applied) = recorder(&["main"], false);
        let mut ticker = Ticker::new(rec, Arc::default());
        ticker.sync();
        assert_eq!(take(&applied), vec![], "Normal is the default: nothing to do");

        ticker.handle(Msg::Level(Level::Low));
        assert_eq!(take(&applied), vec![pair("main", Level::Low)]);
        ticker.sync();
        assert_eq!(take(&applied), vec![], "no redundant call");

        windows.lock().unwrap().push("term-1".into());
        ticker.sync();
        assert_eq!(take(&applied), vec![pair("term-1", Level::Low)], "the new pop-out gets Low");

        ticker.handle(Msg::Level(Level::Normal));
        let mut got = take(&applied);
        got.sort_by(|a, b| a.0.cmp(&b.0));
        assert_eq!(got, vec![pair("main", Level::Normal), pair("term-1", Level::Normal)]);

        ticker.handle(Msg::Level(Level::Low));
        take(&applied);
        windows.lock().unwrap().retain(|l| l != "term-1");
        ticker.handle(Msg::Destroyed("term-1".into()));
        windows.lock().unwrap().push("term-1".into());
        ticker.sync();
        assert_eq!(take(&applied), vec![pair("term-1", Level::Low)], "a reused label starts at the default");

        // At Normal, a new window gets nothing.
        ticker.handle(Msg::Level(Level::Normal));
        take(&applied);
        windows.lock().unwrap().push("term-2".into());
        ticker.sync();
        assert_eq!(take(&applied), vec![]);
    }

    /// A failing apply is logged once (one flag for every failure); it is not retried each beat.
    #[test]
    fn a_failed_apply_is_logged_once_and_not_retried() {
        let health = Arc::new(Health::default());
        let (rec, _windows, applied) = recorder(&["main", "term-1"], true);
        let mut ticker = Ticker::new(rec, health.clone());
        ticker.handle(Msg::Level(Level::Low));
        assert_eq!(take(&applied).len(), 2);
        assert!(!health.log_failure("again"), "the ticker's failure already used the one log");
        ticker.sync();
        assert_eq!(take(&applied), vec![], "not retried");
        assert!(!health.is_unsupported(), "a dispatch failure is not a missing API");
    }

    /// The ticker loop handles queued messages in order, ticks and syncs when none comes, and
    /// ends with the queue (instant: the beat is a parameter).
    #[test]
    fn the_ticker_handles_queued_messages_in_order() {
        let (tx, rx) = mpsc::channel();
        tx.send(Msg::Level(Level::Low)).unwrap();
        tx.send(Msg::Level(Level::Normal)).unwrap();
        let (rec, windows, applied) = recorder(&["main"], false);
        let ticks = Arc::new(Mutex::new(0));
        let tx = Mutex::new(Some(tx));
        let counted = ticks.clone();
        let opened = windows.clone();
        run_ticker(rx, Ticker::new(rec, Arc::default()), Duration::from_millis(1), move || {
            let n = {
                let mut n = counted.lock().unwrap();
                *n += 1;
                *n
            };
            let mut tx = tx.lock().unwrap();
            match n {
                // The first tick queues Low.
                1 => tx.as_ref().unwrap().send(Msg::Level(Level::Low)).unwrap(),
                // The second opens a window: the sync after the tick gives it Low.
                2 => opened.lock().unwrap().push("term-1".into()),
                // The third drops the sender: the loop ends.
                _ => *tx = None,
            }
        });
        assert_eq!(
            take(&applied),
            vec![pair("main", Level::Low), pair("main", Level::Normal), pair("main", Level::Low), pair("term-1", Level::Low)]
        );
        assert_eq!(*ticks.lock().unwrap(), 3);
    }
}
