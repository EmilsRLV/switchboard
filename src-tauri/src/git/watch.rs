//! The branch watcher (Story 5.1): for every project with branches on, a `notify` watch on its
//! repository's common git dir ([`super::branches::common_dir`]) covering `HEAD`,
//! `packed-refs`, `refs/heads/**`, `refs/remotes/**` (a fetch moves `↑n ↓m` and `upstream
//! gone`), `worktrees/**` and, for a reftable repository, `reftable/**`. A burst of changes
//! there (a `git branch`, a commit, a fetch, a rebase touching many refs) refreshes that
//! project's branch list once, 300 ms after the last event, so the cards follow the disk within
//! 2 s. The 30 s branch pass ([`super::poll`]) covers a watch that could not start or lost events.
//!
//! [`sync`] starts and stops watches to match the workspace: turning branches off or removing
//! the project drops its watch, which ends its debounce thread; a project whose common dir
//! changed gets a new one.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::mpsc::Sender;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use notify::{Event, RecommendedWatcher, RecursiveMode, Watcher};
use tauri::{AppHandle, Manager, Runtime};

use crate::settings::AppState;

/// Quiet period after the last relevant event before the branch list is re-read.
pub const DEBOUNCE: Duration = Duration::from_millis(300);

/// One project's watch. Dropping it stops the fs watch and, with it, the debounce thread.
pub struct Watch {
    /// The watched common git dir.
    pub dir: PathBuf,
    _watcher: Arc<Mutex<RecommendedWatcher>>,
}

/// Every running watch by project id (`AppState::branch_watches`).
#[derive(Default)]
pub struct Watches {
    inner: Mutex<HashMap<String, Watch>>,
}

impl Watches {
    fn lock(&self) -> MutexGuard<'_, HashMap<String, Watch>> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// The ids of the projects being watched, sorted.
    pub fn ids(&self) -> Vec<String> {
        let mut ids: Vec<String> = self.lock().keys().cloned().collect();
        ids.sort();
        ids
    }

    /// The common git dir watched for `id`, if any.
    pub fn dir_of(&self, id: &str) -> Option<PathBuf> {
        self.lock().get(id).map(|w| w.dir.clone())
    }

    /// Stop every watch (the watches are dropped after the lock is released).
    pub fn clear(&self) {
        let dropped: Vec<Watch> = self.lock().drain().map(|(_, w)| w).collect();
        drop(dropped);
    }
}

/// True when the event can change a branch list: a path under `common` that is `HEAD`,
/// `packed-refs`, `refs/heads` or `refs/remotes` or anything in them, or inside `worktrees`
/// or `reftable`; or a rescan request (events were lost, so anything may have changed).
pub fn is_relevant(event: &Event, common: &Path) -> bool {
    event.need_rescan() || event.paths.iter().any(|p| relevant_path(p, common))
}

fn relevant_path(path: &Path, common: &Path) -> bool {
    let Ok(rel) = path.strip_prefix(common) else { return false };
    let mut parts = rel.components().map(|c| c.as_os_str());
    match parts.next().and_then(|first| first.to_str()) {
        Some("HEAD") | Some("packed-refs") => parts.next().is_none(),
        Some("worktrees") | Some("reftable") => true,
        Some("refs") => matches!(parts.next().and_then(|p| p.to_str()), Some("heads") | Some("remotes")),
        _ => false,
    }
}

/// The folders under the common dir watched recursively, each as soon as it exists:
/// `refs/heads` and `refs/remotes` (either may be missing at first, `refs/remotes` until the
/// first fetch), `worktrees` (it appears with the first `worktree add`) and `reftable`.
fn recursive_targets(common: &Path) -> Vec<PathBuf> {
    vec![
        common.join("refs").join("heads"),
        common.join("refs").join("remotes"),
        common.join("worktrees"),
        common.join("reftable"),
    ]
}

/// Watch `common` and call `on_change` once per burst of relevant events (see [`DEBOUNCE`]).
/// `common` and `refs` are watched flat (so the creation of a missing target is seen); each
/// of [`recursive_targets`] recursively, those missing at start once they appear (checked
/// after every burst, before `on_change`).
pub fn start<F>(common: &Path, on_change: F) -> notify::Result<Watch>
where
    F: FnMut() + Send + 'static,
{
    let (tx, rx) = std::sync::mpsc::channel::<()>();
    let mut watcher = notify::recommended_watcher(forwarder(tx, common.to_path_buf()))?;
    watcher.watch(common, RecursiveMode::NonRecursive)?;
    let refs = common.join("refs");
    let mut refs_armed = refs.is_dir() && watcher.watch(&refs, RecursiveMode::NonRecursive).is_ok();
    let mut pending: Vec<PathBuf> = Vec::new();
    for target in recursive_targets(common) {
        if !(target.is_dir() && watcher.watch(&target, RecursiveMode::Recursive).is_ok()) {
            pending.push(target);
        }
    }
    let shared = Arc::new(Mutex::new(watcher));
    let weak = Arc::downgrade(&shared);
    let mut on_change = on_change;
    std::thread::Builder::new()
        .name("branch-watch".into())
        .spawn(move || {
            crate::settings::watch::debounce_loop(rx, DEBOUNCE, move || {
                let due = (!refs_armed && refs.is_dir()) || pending.iter().any(|t| t.is_dir());
                if due && let Some(watcher) = weak.upgrade() {
                    let mut watcher = watcher.lock().unwrap_or_else(|e| e.into_inner());
                    if !refs_armed && refs.is_dir() {
                        refs_armed = watcher.watch(&refs, RecursiveMode::NonRecursive).is_ok();
                    }
                    pending.retain(|t| !(t.is_dir() && watcher.watch(t, RecursiveMode::Recursive).is_ok()));
                }
                on_change();
            })
        })
        .map_err(notify::Error::io)?;
    Ok(Watch {
        dir: common.to_path_buf(),
        _watcher: shared,
    })
}

/// The notify callback: a unit per relevant event; a watch error is treated as "something may
/// have changed" (the refresh is cheap, and the 30 s pass is there anyway).
fn forwarder(tx: Sender<()>, common: PathBuf) -> impl FnMut(notify::Result<Event>) + Send + 'static {
    move |res| match res {
        Ok(event) if is_relevant(&event, &common) => {
            let _ = tx.send(());
        }
        Ok(_) => {}
        Err(err) => {
            eprintln!("git: branch watch error: {err}");
            let _ = tx.send(());
        }
    }
}

/// The projects with branches on, as `(id, path)`.
fn wanted_projects(state: &AppState) -> Vec<(String, PathBuf)> {
    state
        .read_workspace()
        .workspace
        .projects
        .iter()
        .filter(|p| p.show_branches)
        .map(|p| (p.id.clone(), PathBuf::from(&p.path)))
        .collect()
}

/// Make the running watches match the workspace: a watch per project with branches on, on its
/// common dir (found with `git rev-parse`, with no lock held), none for the rest; a watch whose
/// project's common dir changed is replaced. The decision and every insert and removal happen
/// in one critical section of the watch map, against the workspace as it is then, so a sync
/// racing a toggle can never keep a watch for a project with branches off; the removed watches
/// are stopped after the lock is released. A project whose common dir cannot be read this time
/// keeps a running watch, and one whose watch cannot start is left to the 30 s pass and tried
/// again at the next sync. Blocking (runs git): call it off the main thread.
pub fn sync<R: Runtime>(app: &AppHandle<R>) {
    let state = app.state::<AppState>();
    let git = super::poll::git_binary(&state.read());
    let dirs: HashMap<String, PathBuf> = wanted_projects(&state)
        .into_iter()
        .filter(|(_, path)| path.is_dir())
        .filter_map(|(id, path)| super::branches::common_dir(&git, &path).ok().map(|dir| (id, dir)))
        .collect();
    let mut dropped: Vec<Watch> = Vec::new();
    {
        let mut watches = state.branch_watches.lock();
        let now: HashSet<String> = wanted_projects(&state).into_iter().map(|(id, _)| id).collect();
        let ids: Vec<String> = watches.keys().cloned().collect();
        for id in ids {
            let moved = matches!((dirs.get(&id), watches.get(&id)), (Some(dir), Some(watch)) if watch.dir != *dir);
            if (!now.contains(&id) || moved)
                && let Some(watch) = watches.remove(&id)
            {
                dropped.push(watch);
            }
        }
        for (id, dir) in &dirs {
            if !now.contains(id) || watches.contains_key(id) {
                continue;
            }
            let app = app.clone();
            let project = id.clone();
            let watch = start(dir, move || {
                let app = app.clone();
                let ids = vec![project.clone()];
                tauri::async_runtime::spawn(async move {
                    super::poll::refresh_branches(&app, Some(&ids)).await;
                });
            });
            match watch {
                Ok(watch) => {
                    watches.insert(id.clone(), watch);
                }
                Err(err) => eprintln!("git: cannot watch {}: {err}", dir.display()),
            }
        }
    }
    drop(dropped);
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use notify::EventKind;
    use std::time::Instant;

    use super::super::branches::tests::{git_ok, real_git, temp_repo};

    /// How long the watcher tests allow for a change to be seen: the product target is 2 s; a
    /// loaded CI runner gets 3 s (the IPC test in `lib.rs` uses the same bound).
    pub(crate) const SEEN_WITHIN: Duration = Duration::from_secs(3);

    fn event(paths: &[PathBuf]) -> Event {
        Event {
            kind: EventKind::Modify(notify::event::ModifyKind::Any),
            paths: paths.to_vec(),
            attrs: Default::default(),
        }
    }

    #[test]
    fn refs_heads_refs_remotes_packed_refs_head_worktrees_and_reftable_are_relevant() {
        let common = PathBuf::from("/r/.git");
        let yes = |p: &str| is_relevant(&event(&[common.join(p)]), &common);
        assert!(yes("HEAD"));
        assert!(yes("packed-refs"));
        assert!(yes("refs/heads/main"));
        assert!(yes("refs/heads/feature/x.lock"));
        assert!(yes("refs/heads"));
        assert!(yes("refs/remotes/origin/main"));
        assert!(yes("refs/remotes"));
        assert!(yes("worktrees/wt/HEAD"));
        assert!(yes("worktrees"));
        assert!(yes("reftable/tables.list"));
        assert!(!yes("index"));
        assert!(!yes("ORIG_HEAD"));
        assert!(!yes("FETCH_HEAD"));
        assert!(!yes("objects/ab/cdef"));
        assert!(!yes("refs/tags/v1"));
        assert!(!yes("refs"));
        assert!(!yes("logs/refs/heads/main"));
        assert!(!yes("HEAD/odd"));
        assert!(!is_relevant(&event(&[PathBuf::from("/elsewhere/HEAD")]), &common));
        let mut rescan = event(&[]);
        rescan.attrs.set_flag(notify::event::Flag::Rescan);
        assert!(is_relevant(&rescan, &common));
    }

    /// Drain everything already queued (a burst's trailing events).
    fn drain(rx: &std::sync::mpsc::Receiver<Instant>) {
        while rx.recv_timeout(DEBOUNCE * 2).is_ok() {}
    }

    #[test]
    fn a_real_watch_follows_branches_packed_refs_remotes_and_worktrees_and_stops_when_dropped() {
        let Some(git) = real_git() else {
            eprintln!("git not on PATH; skipping");
            return;
        };
        let dir = temp_repo(&git);
        let repo = dir.path();
        let common = super::super::branches::common_dir(&git, repo).unwrap();
        assert!(!common.join("refs").join("remotes").exists(), "no remotes yet: armed late");
        let (tx, rx) = std::sync::mpsc::channel();
        let watch = start(&common, move || {
            let _ = tx.send(Instant::now());
        })
        .expect("watch starts");
        std::thread::sleep(Duration::from_millis(150));

        let made = Instant::now();
        git_ok(&git, repo, &["branch", "fresh"]);
        let fired = rx.recv_timeout(SEEN_WITHIN).expect("a new branch is seen");
        assert!(fired - made < SEEN_WITHIN);
        // The burst fired once.
        assert!(rx.recv_timeout(DEBOUNCE * 3).is_err(), "one refresh per burst");

        // A change to `packed-refs` alone (written directly, as `pack-refs` or a packed
        // branch's deletion would).
        let head = git_ok(&git, repo, &["rev-parse", "HEAD"]);
        std::fs::write(common.join("packed-refs"), format!("# pack-refs with: peeled fully-peeled sorted \n{} refs/heads/packed\n", head.trim())).unwrap();
        rx.recv_timeout(SEEN_WITHIN).expect("a packed-refs change is seen");
        drain(&rx);

        // The first remote-tracking ref creates `refs/remotes/`: it is armed, and a later
        // change in it (what a fetch does) is seen.
        git_ok(&git, repo, &["update-ref", "refs/remotes/origin/main", "HEAD"]);
        rx.recv_timeout(SEEN_WITHIN).expect("refs/remotes appearing is seen");
        drain(&rx);
        git_ok(&git, repo, &["update-ref", "refs/remotes/origin/other", "HEAD"]);
        rx.recv_timeout(SEEN_WITHIN).expect("a remote-tracking ref change is seen");
        drain(&rx);

        // The first worktree creates `worktrees/`: it is armed and a later change there fires.
        let holder = tempfile::tempdir().unwrap();
        let wt = holder.path().join("wt");
        git_ok(&git, repo, &["worktree", "add", "-q", &wt.display().to_string(), "fresh"]);
        rx.recv_timeout(SEEN_WITHIN).expect("worktree add is seen");
        drain(&rx);
        git_ok(&git, &wt, &["checkout", "-q", "--detach"]);
        rx.recv_timeout(SEEN_WITHIN).expect("a HEAD change inside the worktree is seen");

        drop(watch);
        drain(&rx);
        git_ok(&git, repo, &["branch", "after"]);
        assert!(rx.recv_timeout(Duration::from_secs(1)).is_err(), "dropped: no more refreshes");
    }
}
