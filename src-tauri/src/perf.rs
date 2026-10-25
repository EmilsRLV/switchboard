//! Story 9.3: the performance measuring points behind Settings → Diagnostics.
//!
//! - **Startup.** [`mark_process_start`] runs first thing in `run()`; the frontend calls
//!   `perf_ready` once, after the first canvas frame with the workspace loaded, and the time
//!   between the two is kept ([`Perf::ready`]). Only the first call counts.
//! - **Typing.** The terminals time keydown → PTY write → the frame drawing the echo and send the
//!   samples in batches (`perf_typing`); the last [`TYPING_RING`] are kept here, so every window
//!   (pop-outs too) feeds one ring, and `perf_get` returns their median and p95.
//!
//! Always on and memory only: nothing is logged or written, except the one opt-in line for the
//! measuring script ([`PERF_OUT_ENV`]). Nothing is ever sent anywhere.

use std::collections::VecDeque;
use std::ffi::OsString;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::Instant;

use serde::Serialize;

/// How many typing samples the ring keeps (the last 100 keystrokes).
pub const TYPING_RING: usize = 100;

/// Fewer samples than this and the typing stats say `not enough samples` (no median, no p95).
pub const MIN_TYPING_SAMPLES: usize = 5;

/// A sample above this (ms) is not a keystroke's echo (a stalled window, a clock jump): dropped.
pub const MAX_TYPING_SAMPLE_MS: f64 = 10_000.0;

/// The most samples one `perf_typing` call may carry; extra ones are ignored.
pub const MAX_TYPING_BATCH: usize = TYPING_RING;

/// Opt-in for the measuring script (`scripts/perf/measure.ps1`): when this environment variable
/// names a file by an **absolute** path, `perf_ready` appends one JSON line
/// `{"startup_ms":N,"pid":P}` to it. Unset, empty or relative (the normal case: unset) nothing is
/// written. Read once by [`take_perf_out_env`] and removed from the environment, so no child
/// (shells, sessions, git) inherits it.
pub const PERF_OUT_ENV: &str = "SWITCHBOARD_PERF_OUT";

static PROCESS_START: OnceLock<Instant> = OnceLock::new();

static PERF_OUT: OnceLock<Option<PathBuf>> = OnceLock::new();

/// The file a [`PERF_OUT_ENV`] value names: only a non-empty absolute path counts.
pub fn perf_out_from(value: Option<OsString>) -> Option<PathBuf> {
    value.filter(|v| !v.is_empty()).map(PathBuf::from).filter(|p| p.is_absolute())
}

/// Read [`PERF_OUT_ENV`] once and remove it from this process's environment. `run()` calls it
/// first thing, while the process still has only its main thread: every child is spawned later and
/// inherits the environment as it is then, so none of them sees the variable. (Removing it here
/// rather than at each spawn site covers them all, including ones added later.)
pub fn take_perf_out_env() {
    let value = std::env::var_os(PERF_OUT_ENV);
    if value.is_some() {
        // SAFETY: called at the top of `run()`, before Tauri or anything else starts a thread, so
        // nothing reads the environment concurrently.
        unsafe { std::env::remove_var(PERF_OUT_ENV) };
    }
    let _ = PERF_OUT.set(perf_out_from(value));
}

/// The measuring script's file, when [`take_perf_out_env`] found one (never in tests).
pub fn perf_out() -> Option<&'static Path> {
    PERF_OUT.get().and_then(|p| p.as_deref())
}

/// The process's start as the startup clock sees it: the first call fixes it (`run()` makes that
/// call before anything else); later calls return the same instant.
pub fn mark_process_start() -> Instant {
    *PROCESS_START.get_or_init(Instant::now)
}

/// The median and p95 of the typing ring (`None` below [`MIN_TYPING_SAMPLES`]).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct TypingStats {
    /// Samples in the ring (at most [`TYPING_RING`]).
    pub samples: usize,
    pub median_ms: Option<f64>,
    pub p95_ms: Option<f64>,
}

/// What `perf_get` returns.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct PerfSnapshot {
    /// Process start → first canvas frame, once the frontend reported it.
    pub startup_ms: Option<u64>,
    pub typing: TypingStats,
}

/// The measuring points' store (in `AppState`).
#[derive(Default)]
pub struct Perf {
    startup_ms: OnceLock<u64>,
    typing: Mutex<VecDeque<f64>>,
}

impl Perf {
    /// Record the first canvas frame at `now`, `start` being the process start: the startup ms.
    /// Only the first call records; every call returns the recorded value.
    pub fn ready_at(&self, start: Instant, now: Instant) -> u64 {
        *self.startup_ms.get_or_init(|| {
            u64::try_from(now.saturating_duration_since(start).as_millis()).unwrap_or(u64::MAX)
        })
    }

    /// [`Perf::ready_at`] now, against [`mark_process_start`]. Also returns whether this call was
    /// the one that recorded it.
    pub fn ready(&self) -> (u64, bool) {
        let first = self.startup_ms.get().is_none();
        let ms = self.ready_at(mark_process_start(), Instant::now());
        (ms, first)
    }

    /// Add typing samples (ms) to the ring; the oldest drop out past [`TYPING_RING`]. Negative,
    /// non-finite and over-[`MAX_TYPING_SAMPLE_MS`] values are dropped, and a batch is cut at
    /// [`MAX_TYPING_BATCH`].
    pub fn add_typing(&self, samples: &[f64]) {
        let mut ring = self.typing.lock().unwrap_or_else(|e| e.into_inner());
        for &ms in samples.iter().take(MAX_TYPING_BATCH) {
            if ms.is_finite() && (0.0..=MAX_TYPING_SAMPLE_MS).contains(&ms) {
                ring.push_back(ms);
            }
        }
        while ring.len() > TYPING_RING {
            ring.pop_front();
        }
    }

    /// The startup ms and the typing stats.
    pub fn snapshot(&self) -> PerfSnapshot {
        let samples: Vec<f64> = self.typing.lock().unwrap_or_else(|e| e.into_inner()).iter().copied().collect();
        PerfSnapshot { startup_ms: self.startup_ms.get().copied(), typing: typing_stats(&samples) }
    }
}

/// The median and nearest-rank p95 of `samples`; both `None` below [`MIN_TYPING_SAMPLES`].
pub fn typing_stats(samples: &[f64]) -> TypingStats {
    if samples.len() < MIN_TYPING_SAMPLES {
        return TypingStats { samples: samples.len(), median_ms: None, p95_ms: None };
    }
    let mut sorted = samples.to_vec();
    sorted.sort_by(f64::total_cmp);
    TypingStats { samples: sorted.len(), median_ms: Some(median(&sorted)), p95_ms: Some(nearest_rank(&sorted, 95)) }
}

/// The median of a sorted, non-empty slice (the mean of the middle two for an even length).
fn median(sorted: &[f64]) -> f64 {
    let n = sorted.len();
    if n % 2 == 1 { sorted[n / 2] } else { (sorted[n / 2 - 1] + sorted[n / 2]) / 2.0 }
}

/// The nearest-rank `p`th percentile of a sorted, non-empty slice: the smallest value with at
/// least `p`% of the samples at or below it.
fn nearest_rank(sorted: &[f64], p: usize) -> f64 {
    let rank = (p * sorted.len()).div_ceil(100).max(1);
    sorted[rank - 1]
}

/// Append the measuring script's line for a recorded startup to `path` (see [`PERF_OUT_ENV`]).
pub fn append_startup_line(path: &Path, startup_ms: u64, pid: u32) -> std::io::Result<()> {
    let mut file = std::fs::OpenOptions::new().create(true).append(true).open(path)?;
    writeln!(file, "{}", serde_json::json!({ "startup_ms": startup_ms, "pid": pid }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn the_first_ready_call_fixes_the_startup_ms() {
        let perf = Perf::default();
        assert_eq!(perf.snapshot().startup_ms, None);
        let start = Instant::now();
        assert_eq!(perf.ready_at(start, start + Duration::from_millis(734)), 734);
        // A second report (a webview reload) does not move it.
        assert_eq!(perf.ready_at(start, start + Duration::from_millis(5_000)), 734);
        assert_eq!(perf.snapshot().startup_ms, Some(734));
    }

    #[test]
    fn a_clock_before_the_start_reads_zero() {
        let perf = Perf::default();
        let now = Instant::now();
        assert_eq!(perf.ready_at(now + Duration::from_secs(1), now), 0);
    }

    #[test]
    fn the_process_start_is_fixed_by_the_first_mark() {
        let first = mark_process_start();
        assert_eq!(mark_process_start(), first);
        let (ms, _) = Perf::default().ready();
        assert!(Instant::now().saturating_duration_since(first).as_millis() as u64 >= ms);
    }

    #[test]
    fn fewer_than_five_samples_have_no_stats() {
        let perf = Perf::default();
        perf.add_typing(&[3.0, 4.0, 5.0, 6.0]);
        assert_eq!(perf.snapshot().typing, TypingStats { samples: 4, median_ms: None, p95_ms: None });
        perf.add_typing(&[7.0]);
        assert_eq!(perf.snapshot().typing, TypingStats { samples: 5, median_ms: Some(5.0), p95_ms: Some(7.0) });
    }

    #[test]
    fn median_and_p95_follow_their_definitions() {
        // 1..=100 shuffled: median 50.5, nearest-rank p95 95.
        let samples: Vec<f64> = (1..=100).map(|i| f64::from((i * 37) % 100 + 1)).collect();
        let stats = typing_stats(&samples);
        assert_eq!(stats.samples, 100);
        assert_eq!(stats.median_ms, Some(50.5));
        assert_eq!(stats.p95_ms, Some(95.0));
        // Odd count: the middle value; p95 of 7 samples is the 7th (ceil(6.65)).
        let stats = typing_stats(&[9.0, 1.0, 5.0, 3.0, 7.0, 2.0, 4.0]);
        assert_eq!(stats.median_ms, Some(4.0));
        assert_eq!(stats.p95_ms, Some(9.0));
    }

    #[test]
    fn the_ring_keeps_the_last_hundred_and_drops_nonsense() {
        let perf = Perf::default();
        perf.add_typing(&[f64::NAN, -1.0, f64::INFINITY, MAX_TYPING_SAMPLE_MS + 1.0]);
        assert_eq!(perf.snapshot().typing.samples, 0);
        for i in 0..150 {
            perf.add_typing(&[f64::from(i)]);
        }
        let ring = perf.typing.lock().unwrap();
        assert_eq!(ring.len(), TYPING_RING);
        assert_eq!(ring.front(), Some(&50.0), "the oldest 50 dropped out");
        assert_eq!(ring.back(), Some(&149.0));
    }

    #[test]
    fn a_batch_is_cut_at_its_limit() {
        let perf = Perf::default();
        let big = vec![1.0; MAX_TYPING_BATCH + 50];
        perf.add_typing(&big);
        assert_eq!(perf.snapshot().typing.samples, TYPING_RING);
    }

    #[test]
    fn only_an_absolute_perf_out_path_counts() {
        assert_eq!(perf_out_from(None), None);
        assert_eq!(perf_out_from(Some(OsString::new())), None);
        assert_eq!(perf_out_from(Some("startup.jsonl".into())), None, "relative");
        assert_eq!(perf_out_from(Some("out/startup.jsonl".into())), None, "relative");
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("startup.jsonl");
        assert!(file.is_absolute());
        assert_eq!(perf_out_from(Some(file.clone().into_os_string())), Some(file));
        // Never set in tests: nothing is written.
        assert_eq!(perf_out(), None);
    }

    #[test]
    fn the_startup_line_is_appended_as_json() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("perf.jsonl");
        append_startup_line(&file, 812, 4242).unwrap();
        append_startup_line(&file, 790, 4343).unwrap();
        let text = std::fs::read_to_string(&file).unwrap();
        let lines: Vec<serde_json::Value> = text.lines().map(|l| serde_json::from_str(l).unwrap()).collect();
        assert_eq!(lines, vec![
            serde_json::json!({ "startup_ms": 812, "pid": 4242 }),
            serde_json::json!({ "startup_ms": 790, "pid": 4343 }),
        ]);
    }
}
