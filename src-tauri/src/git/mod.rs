//! Git facts for project nodes, read through the `git` CLI only (no remote operations, no
//! other module ever spawns `git`). [`status`] runs one `git status --porcelain=v2 --branch`
//! per repository and parses it; [`poll`] does that for every project on a timer and keeps
//! the result in memory as live, never persisted, state. [`branches`] lists a repository's
//! local branches and linked worktrees (Story 5.1), [`watch`] refreshes them when the refs
//! change on disk, and [`poll`] re-reads them every 30 s as a fallback. [`worktree`] makes the
//! one write, `git worktree add`, on the operator's submit of the "New worktree" sheet (Story 5.2).
//! [`diff`] reads the working-tree diff the Review pane shows (Story 8.1), read-only, and [`range`]
//! a branch against its base and its commits (Story 8.2), read-only too.

pub mod branches;
pub mod diff;
pub mod poll;
pub mod range;
pub mod status;
pub mod watch;
pub mod worktree;

use serde::{Deserialize, Serialize};

pub use branches::{BranchInfo, WorktreeChip};
pub use status::{GitError, RepoStatus, parse_porcelain_v2, repo_status};

/// What the card shows about a project's folder. Serialised internally tagged, so a repo is
/// `{ "kind": "repo", "branch": …, "dirty": … }` and the others are just `{ "kind": … }`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ProjectStatus {
    /// The folder is inside a git work tree.
    Repo(RepoStatus),
    /// The folder exists but is not under git.
    NotRepo,
    /// The folder is gone (deleted, drive unplugged); the node stays until removed.
    Missing,
    /// `git` could not be started (not installed, wrong path); the settings banner from
    /// detection explains the common case.
    GitUnavailable,
    /// `git` ran but failed (non-zero exit that is not "not a repository", e.g. a
    /// `safe.directory` refusal); `message` is its first stderr line.
    GitError { message: String },
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn project_status_serialises_internally_tagged_in_snake_case() {
        let repo = ProjectStatus::Repo(RepoStatus {
            branch: "master".into(),
            detached: false,
            dirty: 2,
            ahead: 1,
            behind: 0,
        });
        assert_eq!(
            serde_json::to_value(&repo).unwrap(),
            serde_json::json!({
                "kind": "repo", "branch": "master", "detached": false, "dirty": 2, "ahead": 1, "behind": 0
            })
        );
        assert_eq!(
            serde_json::to_value(ProjectStatus::NotRepo).unwrap(),
            serde_json::json!({ "kind": "not_repo" })
        );
        assert_eq!(
            serde_json::to_value(ProjectStatus::Missing).unwrap(),
            serde_json::json!({ "kind": "missing" })
        );
        assert_eq!(
            serde_json::to_value(ProjectStatus::GitUnavailable).unwrap(),
            serde_json::json!({ "kind": "git_unavailable" })
        );
        assert_eq!(
            serde_json::to_value(ProjectStatus::GitError {
                message: "fatal: detected dubious ownership".into()
            })
            .unwrap(),
            serde_json::json!({ "kind": "git_error", "message": "fatal: detected dubious ownership" })
        );
        let back: ProjectStatus = serde_json::from_value(serde_json::to_value(&repo).unwrap()).unwrap();
        assert_eq!(back, repo);
    }
}
