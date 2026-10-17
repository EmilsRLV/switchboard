//! Read-only view of Claude Code's own files under `~/.claude`. This module never writes
//! there. Story 2.2 needs only project discovery (`discover`); transcripts and live sessions
//! follow in Epic 3.

pub mod discover;

use std::path::PathBuf;

pub use discover::{ClaudeProject, decode_dir_name, list_projects};

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
