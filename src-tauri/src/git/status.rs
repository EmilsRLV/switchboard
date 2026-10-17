//! `git status --porcelain=v2 --branch`: one call per repository gives the branch, the
//! upstream divergence and every changed path; this module runs it and parses it.
//!
//! Porcelain v2 (stable, documented in `git-status(1)`):
//!
//! ```text
//! # branch.oid <commit> | (initial)
//! # branch.head <branch> | (detached)
//! # branch.upstream <upstream>          only when an upstream is set
//! # branch.ab +<ahead> -<behind>        only when an upstream is set
//! 1 <XY> … <path>                       ordinary changed entry
//! 2 <XY> … <path><tab><origPath>        renamed or copied
//! u <XY> … <path>                       unmerged
//! ? <path>                              untracked
//! ! <path>                              ignored (only with --ignored, which we do not pass)
//! ```

use std::path::Path;
use std::process::Command;
use std::time::Duration;

use serde::{Deserialize, Serialize};

pub use crate::process::RunError as GitError;

/// How long one `git status` may take before it is killed.
pub const STATUS_TIMEOUT: Duration = Duration::from_secs(5);

/// Length of the abbreviated commit shown as the "branch" of a detached HEAD.
const SHORT_OID: usize = 7;

/// The git facts a project card shows.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct RepoStatus {
    /// Branch name, or the abbreviated commit when `detached` (`HEAD` if even that is unknown).
    pub branch: String,
    pub detached: bool,
    /// Changed entries: staged, unstaged, unmerged and untracked paths (ignored ones are not
    /// listed, so they do not count).
    pub dirty: u32,
    /// Commits ahead of / behind the upstream; both 0 when there is no upstream.
    pub ahead: u32,
    pub behind: u32,
}

/// Parse porcelain v2 output (with `--branch` headers). Tolerant: unknown header keys and
/// record types are skipped, so a newer git adding lines cannot break the count.
pub fn parse_porcelain_v2(text: &str) -> RepoStatus {
    let mut status = RepoStatus {
        branch: "HEAD".to_string(),
        ..RepoStatus::default()
    };
    let mut oid: Option<&str> = None;
    let mut detached = false;
    for line in text.lines() {
        if let Some(header) = line.strip_prefix("# ") {
            let (key, value) = header.split_once(' ').unwrap_or((header, ""));
            match key {
                "branch.oid" => oid = Some(value.trim()),
                "branch.head" => {
                    let head = value.trim();
                    if head == "(detached)" {
                        detached = true;
                    } else if !head.is_empty() {
                        status.branch = head.to_string();
                    }
                }
                "branch.ab" => {
                    for token in value.split_whitespace() {
                        if let Some(n) = token.strip_prefix('+') {
                            status.ahead = n.parse().unwrap_or(0);
                        } else if let Some(n) = token.strip_prefix('-') {
                            status.behind = n.parse().unwrap_or(0);
                        }
                    }
                }
                _ => {}
            }
        } else if line.starts_with("1 ") || line.starts_with("2 ") || line.starts_with("u ") || line.starts_with("? ") {
            status.dirty += 1;
        }
    }
    if detached {
        status.detached = true;
        status.branch = match oid {
            Some(oid) if oid != "(initial)" && !oid.is_empty() => {
                oid.chars().take(SHORT_OID).collect()
            }
            _ => "HEAD".to_string(),
        };
    }
    status
}

/// True when git's stderr says the folder is not inside a repository (exit code 128 carries
/// other fatal errors too, such as `safe.directory` refusals, which are real failures).
fn says_not_a_repo(stderr: &str) -> bool {
    stderr.to_ascii_lowercase().contains("not a git repository")
}

/// Run `git status --porcelain=v2 --branch` in `path` with `git_bin`. `Ok(None)` means the
/// folder is not a git repository (exit 128 with git saying so); `Err` means git could not
/// tell us (missing binary, timeout, any other failure). Never takes optional locks, so a
/// poll cannot stall a `git` the operator is running in that repo.
pub fn repo_status(git_bin: &Path, path: &Path) -> Result<Option<RepoStatus>, GitError> {
    repo_status_with_timeout(git_bin, path, STATUS_TIMEOUT)
}

pub fn repo_status_with_timeout(git_bin: &Path, path: &Path, timeout: Duration) -> Result<Option<RepoStatus>, GitError> {
    let mut cmd = Command::new(git_bin);
    // `--untracked-files=normal` overrides a repo's `status.showUntrackedFiles=no`, so an
    // untracked file always counts as a change.
    cmd.args(["status", "--porcelain=v2", "--branch", "--untracked-files=normal"])
        .current_dir(path)
        .env("GIT_OPTIONAL_LOCKS", "0")
        // A status prompt-less and English, whatever the operator's git is configured with.
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("LC_ALL", "C");
    let done = crate::process::run(cmd, timeout)?;
    if done.status.success() {
        return Ok(Some(parse_porcelain_v2(&done.stdout)));
    }
    if done.status.code() == Some(128) && says_not_a_repo(&done.stderr) {
        return Ok(None);
    }
    Err(done.success().unwrap_err())
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    const CLEAN: &str = "# branch.oid 5ff9de9583839fc19457e65f728f20de79623ee3\n\
                         # branch.head master\n\
                         # branch.upstream origin/master\n\
                         # branch.ab +0 -0\n";

    const DIRTY: &str = "# branch.oid 33b337f53873cdc58855411922edef910f6a61ab\n\
                         # branch.head feature/x\n\
                         # branch.upstream origin/feature/x\n\
                         # branch.ab +0 -0\n\
                         1 .M N... 100644 100644 100644 45b983be36b73c0788dc9cbcb76cbb80fc7bb057 45b983be36b73c0788dc9cbcb76cbb80fc7bb057 src/lib.rs\n\
                         1 A. N... 000000 100644 100644 0000000000000000000000000000000000000000 45b983be36b73c0788dc9cbcb76cbb80fc7bb057 new.txt\n\
                         2 R. N... 100644 100644 100644 ce013625030ba8dba906f756967f9e9ca394464a ce013625030ba8dba906f756967f9e9ca394464a R100 renamed.txt\told.txt\n\
                         u UU N... 100644 100644 100644 100644 e69de29bb2d1d6434b8b29ae775ad8c2e48c5391 e69de29bb2d1d6434b8b29ae775ad8c2e48c5391 e69de29bb2d1d6434b8b29ae775ad8c2e48c5391 conflict.txt\n";

    const AHEAD_BEHIND: &str = "# branch.oid 5ff9de9583839fc19457e65f728f20de79623ee3\n\
                                # branch.head master\n\
                                # branch.upstream origin/master\n\
                                # branch.ab +3 -12\n";

    const DETACHED: &str = "# branch.oid 5ff9de9583839fc19457e65f728f20de79623ee3\n\
                            # branch.head (detached)\n";

    const UNTRACKED: &str = "# branch.oid 33b337f53873cdc58855411922edef910f6a61ab\n\
                             # branch.head master\n\
                             ? u\n\
                             ? dir/\n\
                             ! ignored.log\n";

    const INITIAL: &str = "# branch.oid (initial)\n# branch.head master\n";

    #[test]
    fn clean_repo_with_upstream() {
        assert_eq!(
            parse_porcelain_v2(CLEAN),
            RepoStatus {
                branch: "master".into(),
                detached: false,
                dirty: 0,
                ahead: 0,
                behind: 0
            }
        );
    }

    #[test]
    fn dirty_counts_ordinary_renamed_and_unmerged_entries() {
        let status = parse_porcelain_v2(DIRTY);
        assert_eq!(status.branch, "feature/x");
        assert_eq!(status.dirty, 4);
        assert!(!status.detached);
    }

    #[test]
    fn ahead_and_behind_come_from_branch_ab() {
        let status = parse_porcelain_v2(AHEAD_BEHIND);
        assert_eq!((status.ahead, status.behind), (3, 12));
        assert_eq!(status.dirty, 0);
    }

    #[test]
    fn detached_head_shows_the_short_commit() {
        let status = parse_porcelain_v2(DETACHED);
        assert!(status.detached);
        assert_eq!(status.branch, "5ff9de9");
        assert_eq!((status.ahead, status.behind), (0, 0), "no upstream when detached");
    }

    #[test]
    fn untracked_counts_as_dirty_but_ignored_does_not() {
        let status = parse_porcelain_v2(UNTRACKED);
        assert_eq!(status.dirty, 2);
        assert_eq!(status.branch, "master");
    }

    #[test]
    fn initial_commitless_repo_has_a_branch_and_nothing_else() {
        assert_eq!(
            parse_porcelain_v2(INITIAL),
            RepoStatus {
                branch: "master".into(),
                ..RepoStatus::default()
            }
        );
    }

    #[test]
    fn empty_output_and_unknown_lines_are_tolerated() {
        assert_eq!(
            parse_porcelain_v2(""),
            RepoStatus {
                branch: "HEAD".into(),
                ..RepoStatus::default()
            }
        );
        let status = parse_porcelain_v2("# branch.future x y\n# branch.head main\nz something new\n\n");
        assert_eq!(status.branch, "main");
        assert_eq!(status.dirty, 0);
    }

    #[test]
    fn detached_at_initial_falls_back_to_head() {
        let status = parse_porcelain_v2("# branch.oid (initial)\n# branch.head (detached)\n");
        assert!(status.detached);
        assert_eq!(status.branch, "HEAD");
    }

    #[test]
    fn says_not_a_repo_matches_gits_message_case_insensitively() {
        assert!(says_not_a_repo("fatal: not a git repository (or any of the parent directories): .git\n"));
        assert!(says_not_a_repo("fatal: Not a git repository"));
        assert!(!says_not_a_repo("fatal: detected dubious ownership in repository"));
    }

    // -- the real binary (skipped when git is not on PATH) --------------------------------

    fn real_git() -> Option<std::path::PathBuf> {
        let git = crate::settings::detect::Search::from_env(vec![]).locate("git")?;
        Some(git.path)
    }

    fn git_in(dir: &Path, args: &[&str]) {
        let out = Command::new(real_git().unwrap())
            .args(args)
            .current_dir(dir)
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .output()
            .unwrap();
        assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    }

    #[test]
    fn repo_status_reads_a_fresh_repository_and_sees_a_new_file() {
        let Some(git) = real_git() else {
            eprintln!("git not on PATH; skipping");
            return;
        };
        let dir = tempfile::tempdir().unwrap();
        git_in(dir.path(), &["init", "-q", "-b", "main"]);
        let status = repo_status(&git, dir.path()).unwrap().expect("a repository");
        assert_eq!(status.branch, "main");
        assert_eq!(status.dirty, 0);

        std::fs::write(dir.path().join("hello.txt"), "hi").unwrap();
        let status = repo_status(&git, dir.path()).unwrap().unwrap();
        assert_eq!(status.dirty, 1);
    }

    /// What git itself says about `dir`: inside a work tree or not. The temp dir may sit
    /// inside a repository (some machines keep `~` under git), so the expectation is computed.
    pub(crate) fn inside_work_tree(git: &Path, dir: &Path) -> bool {
        Command::new(git)
            .args(["-C"])
            .arg(dir)
            .args(["rev-parse", "--is-inside-work-tree"])
            .output()
            .map(|out| out.status.success())
            .unwrap_or(false)
    }

    #[test]
    fn repo_status_reports_a_plain_folder_as_git_does() {
        let Some(git) = real_git() else {
            eprintln!("git not on PATH; skipping");
            return;
        };
        let dir = tempfile::tempdir().unwrap();
        let expected = inside_work_tree(&git, dir.path());
        match repo_status(&git, dir.path()).unwrap() {
            None => assert!(!expected, "git says the folder is inside a work tree"),
            Some(status) => {
                assert!(expected, "git says the folder is not inside a work tree");
                assert!(!status.branch.is_empty());
            }
        }
    }

    #[test]
    fn repo_status_with_a_missing_binary_is_a_spawn_error() {
        let dir = tempfile::tempdir().unwrap();
        let err = repo_status(&dir.path().join("no-git.exe"), dir.path()).unwrap_err();
        assert!(matches!(err, GitError::Spawn(_)), "{err:?}");
    }
}
