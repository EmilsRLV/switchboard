//! Live reload: watch the config *directory* (editors replace files, so watching the file
//! itself would lose it on the first save), keep only events about `settings.json`, and
//! debounce 250 ms so a save that arrives as several events reloads once.

use std::ffi::{OsStr, OsString};
use std::path::Path;
use std::sync::mpsc::{Receiver, RecvTimeoutError, Sender};
use std::time::Duration;

use notify::{Event, RecommendedWatcher, RecursiveMode, Watcher};

/// Quiet period after the last event before the file is reloaded.
pub const DEBOUNCE: Duration = Duration::from_millis(250);

/// Watch `dir` for changes to `file_name` and call `on_change` once per burst of events.
/// The returned watcher must be kept alive; dropping it stops the watch.
pub fn start<F>(dir: &Path, file_name: &OsStr, on_change: F) -> notify::Result<RecommendedWatcher>
where
    F: FnMut() + Send + 'static,
{
    let (tx, rx) = std::sync::mpsc::channel::<()>();
    let mut watcher = notify::recommended_watcher(forwarder(tx, file_name.to_os_string()))?;
    watcher.watch(dir, RecursiveMode::NonRecursive)?;
    std::thread::Builder::new()
        .name("settings-watch".into())
        .spawn(move || debounce_loop(rx, DEBOUNCE, on_change))
        .map_err(notify::Error::io)?;
    Ok(watcher)
}

/// The notify callback: forward a unit for every relevant event, drop the rest.
fn forwarder(tx: Sender<()>, file_name: OsString) -> impl FnMut(notify::Result<Event>) + Send + 'static {
    move |res| match res {
        Ok(event) if is_relevant(&event, &file_name) => {
            let _ = tx.send(());
        }
        Ok(_) => {}
        Err(err) => eprintln!("settings: watch error: {err}"),
    }
}

/// True when the event names `file_name`, or when the backend asks for a rescan (it lost
/// events, so the file may have changed without us seeing it).
pub fn is_relevant(event: &Event, file_name: &OsStr) -> bool {
    event.need_rescan() || event.paths.iter().any(|p| p.file_name() == Some(file_name))
}

/// Trailing-edge debounce: after the first event, wait until `quiet` passes with no further
/// event, then fire once. Returns when every sender is gone.
pub fn debounce_loop<F: FnMut()>(rx: Receiver<()>, quiet: Duration, mut on_change: F) {
    while rx.recv().is_ok() {
        loop {
            match rx.recv_timeout(quiet) {
                Ok(()) => continue,
                Err(RecvTimeoutError::Timeout) => break,
                Err(RecvTimeoutError::Disconnected) => {
                    on_change();
                    return;
                }
            }
        }
        on_change();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use notify::EventKind;
    use std::path::PathBuf;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::mpsc::channel;
    use std::time::Instant;

    fn event(paths: &[&str]) -> Event {
        Event {
            kind: EventKind::Modify(notify::event::ModifyKind::Any),
            paths: paths.iter().map(PathBuf::from).collect(),
            attrs: Default::default(),
        }
    }

    #[test]
    fn only_events_naming_the_settings_file_are_relevant() {
        let name = OsStr::new("settings.json");
        assert!(is_relevant(&event(&["/cfg/switchboard/settings.json"]), name));
        assert!(is_relevant(
            &event(&["/cfg/switchboard/.settings-abc.tmp", "/cfg/switchboard/settings.json"]),
            name
        ));
        assert!(!is_relevant(&event(&["/cfg/switchboard/.settings-abc.tmp"]), name));
        assert!(!is_relevant(&event(&["/cfg/switchboard/workspace.json"]), name));
        assert!(!is_relevant(&event(&[]), name));
    }

    #[test]
    fn a_rescan_request_is_relevant_even_without_paths() {
        let mut rescan = event(&[]);
        rescan.attrs.set_flag(notify::event::Flag::Rescan);
        assert!(is_relevant(&rescan, OsStr::new("settings.json")));
    }

    #[test]
    fn a_burst_of_events_reloads_once_after_the_quiet_period() {
        let (tx, rx) = channel();
        let fired = Arc::new(AtomicUsize::new(0));
        let counter = fired.clone();
        let quiet = Duration::from_millis(400);
        let worker = std::thread::spawn(move || {
            debounce_loop(rx, quiet, move || {
                counter.fetch_add(1, Ordering::SeqCst);
            })
        });

        let start = Instant::now();
        for _ in 0..5 {
            tx.send(()).unwrap();
            std::thread::sleep(Duration::from_millis(20));
        }
        // Assert only once the quiet window has certainly closed: one reload for the burst.
        std::thread::sleep(quiet * 3);
        assert_eq!(fired.load(Ordering::SeqCst), 1);
        assert!(start.elapsed() >= quiet);

        // A second, separate burst fires again.
        tx.send(()).unwrap();
        std::thread::sleep(quiet * 3);
        assert_eq!(fired.load(Ordering::SeqCst), 2);

        drop(tx);
        worker.join().unwrap();
    }

    #[test]
    fn real_watcher_reports_a_write_to_settings_json() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("settings.json");
        std::fs::write(&file, "{}").unwrap();
        let (tx, rx) = channel();
        let _watcher = start(dir.path(), OsStr::new("settings.json"), move || {
            let _ = tx.send(Instant::now());
        })
        .expect("watcher starts on a temp dir");

        // Give the OS watcher a moment to arm before writing.
        std::thread::sleep(Duration::from_millis(100));
        let written = Instant::now();
        std::fs::write(&file, "{ \"theme\": \"light\" }").unwrap();

        // Generous bound: the product target is 1 s, but a loaded CI runner may be slow.
        let fired = rx
            .recv_timeout(Duration::from_secs(3))
            .expect("change callback within 3 s");
        assert!(fired - written >= DEBOUNCE - Duration::from_millis(5), "debounced");
    }
}
