//! The git status poller: every `settings.poll.git_ms` (re-read each tick, so an edit to
//! `settings.json` applies at the next tick) it runs [`repo_status`] for every project on the
//! canvas, off the main thread, stores the results in [`LiveState`] and emits
//! `projects://status` when anything changed. [`refresh_ids`] does the same for the projects
//! just added, so a new card fills in without waiting for the timer or re-polling the rest.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager, Runtime};
use tokio::sync::Semaphore;

use super::{GitError, ProjectStatus, repo_status};
use crate::settings::{AppState, BinaryStatus, SettingsState};

/// Event name carrying the whole `project id → status` map whenever it changes.
pub const STATUS_EVENT: &str = "projects://status";

/// A `poll.git_ms` below this is treated as this: the settings validator already rejects 0,
/// and a tighter loop than 4 Hz would only burn CPU on `git`.
pub const MIN_INTERVAL_MS: u64 = 250;

/// How many `git status` processes a pass runs at once.
pub const MAX_CONCURRENT: usize = 4;

/// The first pass waits this long at most for binary detection to finish, polling every
/// [`DETECT_POLL`]: before that, a configured non-PATH git would show every card as
/// unavailable for one interval.
pub const DETECT_WAIT: Duration = Duration::from_secs(2);
pub const DETECT_POLL: Duration = Duration::from_millis(50);

/// Start the poller as a task on Tauri's async runtime. Called once from `setup`; it runs
/// for the life of the app.
pub fn start<R: Runtime>(app: AppHandle<R>) {
    tauri::async_runtime::spawn(async move {
        let mut waited = Duration::ZERO;
        while app.state::<AppState>().read().binaries.git.status == BinaryStatus::Pending && waited < DETECT_WAIT {
            tokio::time::sleep(DETECT_POLL).await;
            waited += DETECT_POLL;
        }
        loop {
            refresh(&app).await;
            let wait = interval(&app.state::<AppState>().read());
            tokio::time::sleep(wait).await;
        }
    });
}

/// The time between passes: `poll.git_ms`, never below [`MIN_INTERVAL_MS`].
pub fn interval(settings: &SettingsState) -> Duration {
    Duration::from_millis(settings.settings.poll.git_ms.max(MIN_INTERVAL_MS))
}

/// One pass over every project: run `git status` for each on a blocking thread (at most
/// [`MAX_CONCURRENT`] at once), store the map, emit it if it changed. Passes are serialised
/// by `AppState::refresh_lock`. Returns the fresh map.
pub async fn refresh<R: Runtime>(app: &AppHandle<R>) -> HashMap<String, ProjectStatus> {
    let state = app.state::<AppState>();
    let _pass = state.refresh_lock.lock().await;
    let projects = projects_of(&state, None);
    let next = poll_all(&state, projects).await;
    store_and_emit(app, &state, next)
}

/// A pass over `ids` only (the projects just added): their statuses are polled and merged
/// into the stored map, which is emitted when that changed anything. Ids not on the canvas
/// are ignored. Returns the merged map.
pub async fn refresh_ids<R: Runtime>(app: &AppHandle<R>, ids: &[String]) -> HashMap<String, ProjectStatus> {
    let state = app.state::<AppState>();
    let _pass = state.refresh_lock.lock().await;
    let projects = projects_of(&state, Some(ids));
    let polled = poll_all(&state, projects).await;
    let mut next = state.read_live().statuses.clone();
    next.extend(polled);
    store_and_emit(app, &state, next)
}

/// A project has left the canvas: drop its entry from the live map and emit the map when
/// that changed anything (an id never polled changes nothing). Takes the refresh lock, so a
/// pass that started before the removal cannot put the entry back afterwards. Returns the
/// resulting map.
pub async fn forget<R: Runtime>(app: &AppHandle<R>, id: &str) -> HashMap<String, ProjectStatus> {
    let state = app.state::<AppState>();
    let _pass = state.refresh_lock.lock().await;
    let mut next = state.read_live().statuses.clone();
    next.remove(id);
    store_and_emit(app, &state, next)
}

/// `(id, path, previous status)` of every project on the canvas, or of those in `only`.
fn projects_of(state: &AppState, only: Option<&[String]>) -> Vec<(String, PathBuf, Option<ProjectStatus>)> {
    let live = state.read_live();
    state
        .read_workspace()
        .workspace
        .projects
        .iter()
        .filter(|p| only.is_none_or(|ids| ids.contains(&p.id)))
        .map(|p| (p.id.clone(), PathBuf::from(&p.path), live.statuses.get(&p.id).cloned()))
        .collect()
}

/// Run [`status_of`] for every project, at most [`MAX_CONCURRENT`] at a time.
async fn poll_all(
    state: &AppState,
    projects: Vec<(String, PathBuf, Option<ProjectStatus>)>,
) -> HashMap<String, ProjectStatus> {
    let git = git_binary(&state.read());
    let permits = Arc::new(Semaphore::new(MAX_CONCURRENT));
    let handles: Vec<_> = projects
        .into_iter()
        .map(|(id, path, previous)| {
            let git = git.clone();
            let permits = permits.clone();
            (id, async move {
                // The semaphore is never closed, so acquiring cannot fail.
                let _permit = permits.acquire_owned().await.ok();
                tauri::async_runtime::spawn_blocking(move || status_of(&git, &path, previous.as_ref()))
                    .await
                    // A panicked status thread is "could not run git", not a reason to stop polling.
                    .unwrap_or(ProjectStatus::GitUnavailable)
            })
        })
        .collect();
    let mut next = HashMap::with_capacity(handles.len());
    // Awaiting in order is fine: the semaphore, not this loop, bounds the parallelism, and
    // every future was created above (they start running as they are awaited).
    let futures: Vec<_> = handles
        .into_iter()
        .map(|(id, fut)| tauri::async_runtime::spawn(async move { (id, fut.await) }))
        .collect();
    for handle in futures {
        if let Ok((id, status)) = handle.await {
            next.insert(id, status);
        }
    }
    next
}

/// Store `next` as the live map, emit it when it differs from what was there, return it.
fn store_and_emit<R: Runtime>(
    app: &AppHandle<R>,
    state: &AppState,
    next: HashMap<String, ProjectStatus>,
) -> HashMap<String, ProjectStatus> {
    let changed = {
        let mut live = state.write_live();
        if live.statuses == next {
            false
        } else {
            live.statuses = next.clone();
            true
        }
    };
    if changed && let Err(err) = app.emit(STATUS_EVENT, &next) {
        eprintln!("git: emit failed: {err}");
    }
    next
}

/// The status of one project folder: `Missing` when the folder is gone (no `git` run), else
/// what `git status` says. A git that cannot start is `GitUnavailable`; a run that timed out
/// keeps `previous` (a slow pass is not news) or, with nothing to keep, is a `GitError`;
/// any other failure is a `GitError` with git's first stderr line.
pub fn status_of(git: &Path, path: &Path, previous: Option<&ProjectStatus>) -> ProjectStatus {
    if !path.is_dir() {
        return ProjectStatus::Missing;
    }
    match repo_status(git, path) {
        Ok(Some(status)) => ProjectStatus::Repo(status),
        Ok(None) => ProjectStatus::NotRepo,
        Err(GitError::Spawn(_)) => ProjectStatus::GitUnavailable,
        Err(err @ GitError::Timeout(_)) => previous.cloned().unwrap_or(ProjectStatus::GitError {
            message: err.to_string(),
        }),
        Err(GitError::Failed { stderr, code }) => ProjectStatus::GitError {
            message: if stderr.is_empty() {
                format!("git exited with code {}", code.map(|c| c.to_string()).unwrap_or_else(|| "?".into()))
            } else {
                stderr
            },
        },
        Err(err) => ProjectStatus::GitError {
            message: err.to_string(),
        },
    }
}

/// Which `git` to run: the path detection recorded (configured or found), else bare `git`
/// resolved on PATH by the OS. Detection still pending, or git missing, both end up here as
/// `git`; a missing binary then fails to spawn and the card says so.
pub fn git_binary(settings: &SettingsState) -> PathBuf {
    match &settings.binaries.git.path {
        Some(path) => PathBuf::from(path),
        None => PathBuf::from("git"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::graph::{self, Position};
    use crate::settings::Binary;
    use std::sync::mpsc;
    use tauri::Listener;
    use tauri::test::{MockRuntime, mock_builder, mock_context, noop_assets};

    fn mock_app() -> tauri::App<MockRuntime> {
        crate::with_commands(mock_builder())
            .build(mock_context(noop_assets()))
            .expect("mock app should build")
    }

    fn listen(app: &tauri::App<MockRuntime>) -> mpsc::Receiver<HashMap<String, ProjectStatus>> {
        let (tx, rx) = mpsc::channel();
        app.listen_any(STATUS_EVENT, move |event| {
            let _ = tx.send(serde_json::from_str(event.payload()).expect("status payload"));
        });
        rx
    }

    fn add(app: &tauri::App<MockRuntime>, path: &Path) -> String {
        let result = graph::add_projects(app.handle(), &[path.display().to_string()], Position::default()).unwrap();
        result.added[0].clone()
    }

    fn with_git(settings: &mut SettingsState, path: Option<&str>, status: BinaryStatus) {
        settings.binaries.git = Binary {
            name: "git".into(),
            path: path.map(str::to_string),
            version: None,
            status,
            configured: false,
        };
    }

    #[test]
    fn git_binary_prefers_the_detected_path_and_falls_back_to_git() {
        let mut settings = SettingsState::default();
        assert_eq!(git_binary(&settings), PathBuf::from("git"), "pending: bare git");
        with_git(&mut settings, Some("C:/Program Files/Git/cmd/git.exe"), BinaryStatus::Found);
        assert_eq!(git_binary(&settings), PathBuf::from("C:/Program Files/Git/cmd/git.exe"));
        with_git(&mut settings, None, BinaryStatus::Missing);
        assert_eq!(git_binary(&settings), PathBuf::from("git"));
    }

    #[test]
    fn interval_is_poll_git_ms_with_a_floor() {
        let mut settings = SettingsState::default();
        assert_eq!(interval(&settings), Duration::from_secs(5), "default");
        settings.settings.poll.git_ms = 7;
        assert_eq!(interval(&settings), Duration::from_millis(MIN_INTERVAL_MS));
        assert_eq!(interval(&settings), Duration::from_millis(250));
        settings.settings.poll.git_ms = 9_000;
        assert_eq!(interval(&settings), Duration::from_secs(9));
    }

    #[test]
    fn status_of_a_vanished_folder_is_missing_without_running_git() {
        let dir = tempfile::tempdir().unwrap();
        let gone = dir.path().join("gone");
        let no_git = dir.path().join("no-git.exe");
        assert_eq!(status_of(&no_git, &gone, None), ProjectStatus::Missing);
        assert_eq!(
            status_of(&no_git, dir.path(), Some(&ProjectStatus::NotRepo)),
            ProjectStatus::GitUnavailable,
            "folder exists, git does not start: unavailable whatever came before"
        );
    }

    #[test]
    fn status_of_keeps_the_previous_status_on_a_timeout_and_reports_other_failures() {
        let dir = tempfile::tempdir().unwrap();
        let previous = ProjectStatus::Repo(super::super::RepoStatus {
            branch: "main".into(),
            ..Default::default()
        });
        // A "git" that hangs: with a previous status it is kept, without one it is an error.
        let hang = crate::process::fixtures::script(dir.path(), "hang", "@ping -n 60 127.0.0.1 >nul\n", "exec sleep 60\n");
        let timed_out = super::super::status::repo_status_with_timeout(&hang, dir.path(), Duration::from_millis(100)).unwrap_err();
        assert!(matches!(timed_out, GitError::Timeout(_)));
        assert_eq!(status_from(timed_out.clone(), Some(&previous)), previous);
        assert_eq!(
            status_from(timed_out, None),
            ProjectStatus::GitError {
                message: "timed out after 100ms".into()
            }
        );
        // A "git" that fails: its first stderr line, whatever came before.
        let fail = crate::process::fixtures::script(
            dir.path(),
            "fail",
            "@echo fatal: detected dubious ownership 1>&2\n@exit /b 128\n",
            "echo 'fatal: detected dubious ownership' >&2\nexit 128\n",
        );
        assert_eq!(
            status_of(&fail, dir.path(), Some(&previous)),
            ProjectStatus::GitError {
                message: "fatal: detected dubious ownership".into()
            }
        );
        let silent = crate::process::fixtures::script(dir.path(), "silent", "@exit /b 3\n", "exit 3\n");
        assert_eq!(
            status_of(&silent, dir.path(), None),
            ProjectStatus::GitError {
                message: "git exited with code 3".into()
            }
        );
    }

    /// `status_of`'s error mapping, fed a ready-made error (the timeout case is slow to
    /// reproduce for every assertion).
    fn status_from(err: GitError, previous: Option<&ProjectStatus>) -> ProjectStatus {
        match err {
            GitError::Spawn(_) => ProjectStatus::GitUnavailable,
            err @ GitError::Timeout(_) => previous.cloned().unwrap_or(ProjectStatus::GitError {
                message: err.to_string(),
            }),
            err => ProjectStatus::GitError {
                message: err.to_string(),
            },
        }
    }

    #[test]
    fn refresh_covers_every_project_stores_the_map_and_emits_only_on_change() {
        let app = mock_app();
        let cfg = tempfile::tempdir().unwrap();
        graph::initialise_at(app.handle(), Some(cfg.path().join("workspace.json")));
        // Point the poller at a git that does not exist: every existing folder is then
        // `git_unavailable`, deterministically, whatever the machine has installed.
        app.state::<AppState>().write().binaries.git.path = Some(cfg.path().join("no-git.exe").display().to_string());

        let folder = tempfile::tempdir().unwrap();
        let doomed = tempfile::tempdir().unwrap();
        let id_folder = add(&app, folder.path());
        let id_doomed = add(&app, doomed.path());
        let doomed_path = doomed.path().to_path_buf();
        drop(doomed);
        assert!(!doomed_path.exists());
        let rx = listen(&app);

        let map = tauri::async_runtime::block_on(refresh(app.handle()));
        assert_eq!(map.len(), 2);
        assert_eq!(map[&id_folder], ProjectStatus::GitUnavailable);
        assert_eq!(map[&id_doomed], ProjectStatus::Missing);
        assert_eq!(app.state::<AppState>().read_live().statuses, map);
        assert_eq!(rx.try_recv().expect("first pass emits"), map);

        let again = tauri::async_runtime::block_on(refresh(app.handle()));
        assert_eq!(again, map);
        assert!(rx.try_recv().is_err(), "unchanged: no second event");
    }

    #[test]
    fn refresh_ids_polls_only_those_ids_and_merges_into_the_stored_map() {
        let app = mock_app();
        let cfg = tempfile::tempdir().unwrap();
        graph::initialise_at(app.handle(), Some(cfg.path().join("workspace.json")));
        app.state::<AppState>().write().binaries.git.path = Some(cfg.path().join("no-git.exe").display().to_string());
        let a = tempfile::tempdir().unwrap();
        let b = tempfile::tempdir().unwrap();
        let id_a = add(&app, a.path());
        let id_b = add(&app, b.path());
        // A stale entry for `a` that a full pass would correct; `refresh_ids(b)` must keep it.
        app.state::<AppState>()
            .write_live()
            .statuses
            .insert(id_a.clone(), ProjectStatus::NotRepo);
        let rx = listen(&app);

        let map = tauri::async_runtime::block_on(refresh_ids(app.handle(), std::slice::from_ref(&id_b)));
        assert_eq!(map.len(), 2);
        assert_eq!(map[&id_a], ProjectStatus::NotRepo, "untouched");
        assert_eq!(map[&id_b], ProjectStatus::GitUnavailable, "polled");
        assert_eq!(app.state::<AppState>().read_live().statuses, map);
        assert_eq!(rx.try_recv().expect("merge changed the map"), map);

        let same = tauri::async_runtime::block_on(refresh_ids(app.handle(), &[id_b, "not-a-project".into()]));
        assert_eq!(same, map);
        assert!(rx.try_recv().is_err(), "nothing changed, unknown id ignored");

        let none = tauri::async_runtime::block_on(refresh_ids(app.handle(), &[]));
        assert_eq!(none, map);
    }

    #[test]
    fn forget_drops_the_id_from_the_live_map_and_emits_only_when_it_was_there() {
        let app = mock_app();
        {
            let state = app.state::<AppState>();
            let mut live = state.write_live();
            live.statuses.insert("ide".into(), ProjectStatus::NotRepo);
            live.statuses.insert("other".into(), ProjectStatus::Missing);
        }
        let rx = listen(&app);

        let map = tauri::async_runtime::block_on(forget(app.handle(), "ide"));
        assert_eq!(map.len(), 1);
        assert_eq!(map["other"], ProjectStatus::Missing);
        assert_eq!(app.state::<AppState>().read_live().statuses, map);
        assert_eq!(rx.try_recv().expect("the removal is announced"), map);

        let same = tauri::async_runtime::block_on(forget(app.handle(), "never-polled"));
        assert_eq!(same, map);
        assert!(rx.try_recv().is_err(), "nothing changed, no event");
    }

    #[test]
    fn refresh_with_no_projects_yields_an_empty_map_and_no_event() {
        let app = mock_app();
        let rx = listen(&app);
        let map = tauri::async_runtime::block_on(refresh(app.handle()));
        assert!(map.is_empty());
        assert!(rx.try_recv().is_err());
    }

    #[test]
    fn refresh_with_the_real_git_tells_a_repo_from_a_plain_folder() {
        let Some(git) = crate::settings::detect::Search::from_env(vec![]).locate("git") else {
            eprintln!("git not on PATH; skipping");
            return;
        };
        let app = mock_app();
        let cfg = tempfile::tempdir().unwrap();
        graph::initialise_at(app.handle(), Some(cfg.path().join("workspace.json")));
        app.state::<AppState>().write().binaries.git.path = Some(git.path.display().to_string());

        let repo = tempfile::tempdir().unwrap();
        let out = std::process::Command::new(&git.path)
            .args(["init", "-q", "-b", "main"])
            .current_dir(repo.path())
            .output()
            .unwrap();
        assert!(out.status.success());
        let plain = tempfile::tempdir().unwrap();
        let plain_in_tree = super::super::status::tests::inside_work_tree(&git.path, plain.path());
        let id_repo = add(&app, repo.path());
        let id_plain = add(&app, plain.path());

        let map = tauri::async_runtime::block_on(refresh(app.handle()));
        match &map[&id_repo] {
            ProjectStatus::Repo(status) => {
                assert_eq!(status.branch, "main");
                assert_eq!(status.dirty, 0);
            }
            other => panic!("expected a repo status, got {other:?}"),
        }
        match &map[&id_plain] {
            ProjectStatus::Repo(_) => assert!(plain_in_tree, "git says the plain folder is outside any work tree"),
            ProjectStatus::NotRepo => assert!(!plain_in_tree, "git says the plain folder is inside a work tree"),
            other => panic!("expected repo or not_repo for the plain folder, got {other:?}"),
        }
    }
}
