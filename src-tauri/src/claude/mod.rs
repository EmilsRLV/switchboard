//! Read-only view of Claude Code's own files under `~/.claude`. This module never writes
//! there. Project discovery (`discover`, Story 2.2), transcript summaries (`transcript`) and
//! the historic sessions per project (`sessions`, Story 3.1) and the live sessions polled from
//! `claude agents --json --all` (`live`, Story 3.2).

pub mod discover;
pub mod launch;
pub mod live;
pub mod sessions;
pub mod transcript;

use std::path::PathBuf;

pub use discover::{ClaudeProject, decode_dir_name, list_projects};
pub use sessions::{SessionCache, sessions_for};
pub use transcript::{SessionSummary, summarise};

/// `~/.claude`, or `None` when the platform has no home directory. Tests pass their own
/// directory to [`list_projects`] instead.
pub fn claude_home() -> Option<PathBuf> {
    dirs::home_dir().map(|home| home.join(".claude"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn claude_home_is_dot_claude_under_home() {
        let home = claude_home().expect("test machine has a home dir");
        assert_eq!(home.file_name().unwrap(), ".claude");
        assert_eq!(home.parent(), dirs::home_dir().as_deref());
    }
}
