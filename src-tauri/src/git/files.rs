//! The Review pane's Files mode (Story 8.3): a lazy, read-only tree of the reviewed folder and the
//! text of one file in it. Nothing is written.
//!
//! **A folder's children** are read when the UI asks for them (`read_dir`, one folder at a time):
//! folders first, then the rest, each by name case-insensitively; dotfiles are listed. `.git` (a
//! folder or a file, at any depth) and the linked worktrees inside the repository
//! ([`super::branches::inside_of`]) are left out. Entries git ignores are marked: one
//! `git check-ignore --stdin -z` per folder over its listed entries (folders with a trailing `/`,
//! so `dir/` patterns match) and the folder itself (everything under an ignored folder is
//! ignored). A folder that is not in a git repository lists nothing as ignored. A symbolic link
//! (a junction on Windows too) is listed as a link and never followed: it is not a folder. At most
//! [`MAX_ENTRIES`] entries are sent, the rest counted (`more`).
//!
//! **Paths.** The UI sends paths relative to the folder with `/`. Each part must be a plain name
//! (no `.`, `..`, `.git`, empty part, control character, drive or root; on Windows no device or
//! alias name and no trailing dot or space), it must not lie in a linked worktree ([`Scope`]) or
//! pass through a link (even one pointing inside), and the result must really lie inside the folder
//! ([`crate::review::within`]). Inside a submodule or a nested repository, check-ignore runs there.
//!
//! **A file's text** is 8.1's new side: [`super::diff::read_disk`] (a link is its target text,
//! never followed) and [`super::diff::content_of`] (binary, over 2 MB or 50,000 lines, not UTF-8,
//! CRLF shown as LF).

use std::path::{Component, Path, PathBuf};

use serde::Serialize;

use super::branches::git;
use super::diff::{self, Content, DIFF_TIMEOUT, Side};

/// The most entries one folder sends; the rest are counted in `more`.
pub const MAX_ENTRIES: usize = 2000;

/// Why a path from the UI is refused: it is not a plain relative path.
pub const BAD_PATH: &str = "not a path inside the folder";

/// Why a path is refused: nothing is there (followed by `: <path>`).
pub const NOT_ON_DISK: &str = "not on disk";

/// Why `file_view` refuses a folder.
pub const IS_FOLDER: &str = "a folder, not a file";

/// Why `list_dir` refuses a path that is not a folder.
pub const NOT_FOLDER: &str = "not a folder";

/// What an entry is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum EntryKind {
    Dir,
    File,
    /// A symbolic link (or a junction): shown, never followed.
    Link,
}

/// One entry of a folder.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirEntry {
    /// The entry's name (lossy when it is not UTF-8).
    pub name: String,
    /// Relative to the reviewed folder, `/`-separated: what the UI sends back.
    pub path: String,
    pub kind: EntryKind,
    /// git ignores it (or the folder it is in).
    pub ignored: bool,
    /// The name is not valid UTF-8: listed lossily, never opened.
    pub unreadable_name: bool,
}

/// What `review_dir` returns: one folder's entries.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirListing {
    /// The reviewed folder (canonical).
    pub root: String,
    /// The folder listed, relative to `root` (`""` for the root itself).
    pub path: String,
    pub entries: Vec<DirEntry>,
    /// Entries past [`MAX_ENTRIES`], not sent.
    pub more: usize,
}

/// What `review_view` returns: one file's text, or why it is not shown.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileView {
    pub path: String,
    /// [`Content::Text`] with `old` always `None`, or `Binary` / `TooLarge`.
    pub content: Content,
}

/// Why a path is refused: it names `.git` (git's own data) or a linked worktree inside the folder.
pub const HIDDEN: &str = "not shown in the folder";

/// Why a path is refused: one of the folders on the way is a link (never followed).
pub const THROUGH_LINK: &str = "a path through a link";

/// The most bytes of `git check-ignore` output read (far more than 2,000 paths need).
const IGNORE_OUTPUT_CAP: usize = 8 * 1024 * 1024;

/// Whether `name` is `.git` (any case on Windows, where the file system does not tell them apart).
fn is_git_name(name: &str) -> bool {
    if cfg!(windows) { name.eq_ignore_ascii_case(".git") } else { name == ".git" }
}

/// Windows only: a device or alias name (`CON`, `NUL`, `COM1`, `aux.txt`, …) or a name ending in a
/// dot or a space (Windows drops them, so the name means another file).
fn windows_special(name: &str) -> bool {
    if name.ends_with('.') || name.ends_with(' ') {
        return true;
    }
    let stem = name.split('.').next().unwrap_or("").trim_end().to_ascii_uppercase();
    let numbered = stem.strip_prefix("COM").or_else(|| stem.strip_prefix("LPT")).is_some_and(|d| {
        let mut digits = d.chars();
        matches!((digits.next(), digits.next()), (Some('0'..='9' | '¹' | '²' | '³'), None))
    });
    numbered || matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$")
}

/// Whether `name` is a plain name the UI may send: not empty, `.`, `..` or `.git`, no control
/// characters, one normal path component; on Windows no `\`, `:`, device names or trailing dot
/// or space.
fn plain_name(name: &str) -> bool {
    !name.is_empty()
        && name != "."
        && name != ".."
        && !is_git_name(name)
        && !name.chars().any(char::is_control)
        && !(cfg!(windows) && (name.contains('\\') || name.contains(':') || windows_special(name)))
        && matches!(Path::new(name).components().next(), Some(Component::Normal(_)))
        && Path::new(name).components().count() == 1
}

/// The parts of `rel` (a UI path, `/`-separated; `""` is the folder itself), each a plain name.
pub fn parts(rel: &str) -> Result<Vec<&str>, String> {
    if rel.is_empty() {
        return Ok(Vec::new());
    }
    let parts: Vec<&str> = rel.split('/').collect();
    if parts.iter().all(|p| plain_name(p)) { Ok(parts) } else { Err(BAD_PATH.to_string()) }
}

/// `rel` joined onto `folder`, its parts checked ([`parts`]); nothing on disk is touched.
pub fn join(folder: &Path, rel: &str) -> Result<PathBuf, String> {
    let mut path = folder.to_path_buf();
    for part in parts(rel)? {
        path.push(part);
    }
    Ok(path)
}

/// What a request knows about the folder once: the linked worktrees inside it (relative, `/`).
#[derive(Debug, Clone, Default)]
pub struct Scope {
    pub worktrees: Vec<String>,
}

impl Scope {
    /// The linked worktrees inside the repository holding `folder` (one `git worktree list`).
    pub fn of(git_bin: &Path, folder: &Path) -> Self {
        Scope { worktrees: worktrees_in(git_bin, folder) }
    }

    /// Whether `rel` is a linked worktree or lies inside one.
    pub fn hides(&self, rel: &str) -> bool {
        let same = |a: &str, b: &str| if cfg!(windows) { a.eq_ignore_ascii_case(b) } else { a == b };
        self.worktrees.iter().any(|w| {
            same(rel, w) || (rel.len() > w.len() && rel.as_bytes()[w.len()] == b'/' && rel.is_char_boundary(w.len()) && same(&rel[..w.len()], w))
        })
    }
}

/// `rel` inside `folder`: its parts plain, not in a linked worktree, no folder on the way a link,
/// and (when it exists) its real location inside the folder ([`diff::OUTSIDE`] otherwise).
pub fn resolve(folder: &Path, rel: &str, scope: &Scope) -> Result<PathBuf, String> {
    let names = parts(rel)?;
    if scope.hides(rel) {
        return Err(HIDDEN.to_string());
    }
    let mut path = folder.to_path_buf();
    for (i, name) in names.iter().enumerate() {
        path.push(name);
        if i + 1 < names.len() && std::fs::symlink_metadata(&path).is_ok_and(|m| m.file_type().is_symlink()) {
            return Err(THROUGH_LINK.to_string());
        }
    }
    if !crate::review::within(&path, folder) {
        return Err(diff::OUTSIDE.to_string());
    }
    Ok(path)
}

/// The file `o` opens: `rel` inside `folder` ([`resolve`]) that exists; else
/// `not on disk: <rel>`. A folder is refused too.
pub fn on_disk(folder: &Path, rel: &str, scope: &Scope) -> Result<PathBuf, String> {
    if rel.is_empty() {
        return Err(BAD_PATH.to_string());
    }
    let path = resolve(folder, rel, scope)?;
    match std::fs::metadata(&path) {
        Ok(meta) if meta.is_dir() => Err(IS_FOLDER.to_string()),
        Ok(_) => Ok(path),
        Err(_) => Err(format!("{NOT_ON_DISK}: {rel}")),
    }
}

/// How entries are ordered: folders first, then names case-insensitively (exact name breaking ties).
fn order(a: &DirEntry, b: &DirEntry) -> std::cmp::Ordering {
    let dir = |e: &DirEntry| e.kind != EntryKind::Dir;
    dir(a)
        .cmp(&dir(b))
        .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
        .then_with(|| a.name.cmp(&b.name))
}

/// The linked worktrees inside the repository holding `folder`, relative to `folder` with `/`
/// (those outside the folder are not needed). Empty outside a git repository.
fn worktrees_in(git_bin: &Path, folder: &Path) -> Vec<String> {
    let Ok((top, entries)) = super::branches::worktree_listing(git_bin, folder) else { return Vec::new() };
    let inside = super::branches::inside_of(&entries, &top);
    let Ok(rel) = folder.strip_prefix(&top) else { return Vec::new() };
    let prefix: Vec<String> = rel.components().map(|c| c.as_os_str().to_string_lossy().into_owned()).collect();
    let prefix = if prefix.is_empty() { String::new() } else { format!("{}/", prefix.join("/")) };
    inside.into_iter().filter_map(|w| w.strip_prefix(prefix.as_str()).map(str::to_string)).collect()
}

/// The paths of `asked` (relative to `cwd`, folders ending in `/`) git ignores, as asked; empty
/// when git cannot tell (not a repository, git missing, a path git refuses, output past the cap).
pub fn ignored_of(git_bin: &Path, cwd: &Path, asked: &[String]) -> Vec<String> {
    if asked.is_empty() {
        return Vec::new();
    }
    let mut input = Vec::new();
    // `./` first, so a name starting with `:` is a name, never pathspec magic; git echoes each
    // ignored path as given.
    for path in asked {
        input.extend_from_slice(b"./");
        input.extend_from_slice(path.as_bytes());
        input.push(0);
    }
    let cmd = git(git_bin, cwd, &["check-ignore", "--stdin", "-z"]);
    let Ok(done) = crate::process::run_bytes_with_input(cmd, input, DIFF_TIMEOUT, IGNORE_OUTPUT_CAP) else { return Vec::new() };
    // 0: some are ignored; 1: none; anything else (128: not a repository): cannot tell.
    if done.status.code() != Some(0) || done.over_cap {
        return Vec::new();
    }
    done.stdout
        .split(|b| *b == 0)
        .filter(|p| !p.is_empty())
        .map(|p| String::from_utf8_lossy(p.strip_prefix(b"./").unwrap_or(p)).into_owned())
        .collect()
}

/// The entries of the folder `rel` inside `folder` (the reviewed folder, canonical), sorted, at
/// most [`MAX_ENTRIES`], with the ignored ones marked. Entries that cannot be read are counted in
/// `more`. `Err`: a refused path, a path that is not a folder, or why the folder could not be read.
pub fn list_dir(git_bin: &Path, folder: &Path, rel: &str) -> Result<DirListing, String> {
    let scope = Scope::of(git_bin, folder);
    let dir = resolve(folder, rel, &scope)?;
    let meta = std::fs::symlink_metadata(&dir).map_err(|_| format!("{NOT_ON_DISK}: {rel}"))?;
    // A link is never followed, not even when it is asked for directly.
    if !meta.is_dir() {
        return Err(NOT_FOLDER.to_string());
    }
    let base = if rel.is_empty() { String::new() } else { format!("{rel}/") };
    let mut entries = Vec::new();
    let mut failed = 0usize;
    for item in std::fs::read_dir(&dir).map_err(|e| e.to_string())? {
        let Ok(item) = item else {
            failed += 1;
            continue;
        };
        let raw = item.file_name();
        let (name, readable) = match raw.to_str() {
            Some(name) => (name.to_string(), true),
            None => (raw.to_string_lossy().into_owned(), false),
        };
        if is_git_name(&name) {
            continue;
        }
        let path = format!("{base}{name}");
        if scope.hides(&path) {
            continue;
        }
        let kind = match item.file_type() {
            Ok(t) if t.is_symlink() => EntryKind::Link,
            Ok(t) if t.is_dir() => EntryKind::Dir,
            _ => EntryKind::File,
        };
        entries.push(DirEntry {
            // A name the UI could not send back (control characters, a Windows device name) is
            // listed, never opened.
            unreadable_name: !readable || !plain_name(&name),
            name,
            path,
            kind,
            ignored: false,
        });
    }
    entries.sort_by(order);
    let more = entries.len().saturating_sub(MAX_ENTRIES) + failed;
    entries.truncate(MAX_ENTRIES);
    mark_ignored(git_bin, folder, rel, &mut entries);
    Ok(DirListing {
        root: folder.display().to_string(),
        path: rel.to_string(),
        entries,
        more,
    })
}

/// Whether `dir` is the top of a repository of its own (a submodule or a nested repository).
fn is_repo_top(dir: &Path) -> bool {
    std::fs::symlink_metadata(dir.join(".git")).is_ok()
}

/// Mark the entries of the folder `rel` git ignores: all of them when the folder itself is. git is
/// asked in the repository holding the folder: inside a submodule or a nested repository, that one
/// (git refuses a path inside another repository, which would leave nothing dimmed); a nested
/// repository's own top is never asked about.
fn mark_ignored(git_bin: &Path, folder: &Path, rel: &str, entries: &mut [DirEntry]) {
    let names: Vec<&str> = if rel.is_empty() { Vec::new() } else { rel.split('/').collect() };
    // The deepest nested repository at or above the folder listed (inside the reviewed folder).
    let nested = (1..=names.len()).rev().find(|&i| is_repo_top(&folder.join(names[..i].join("/"))));
    let (cwd, inner) = match nested {
        Some(i) => (folder.join(names[..i].join("/")), names[i..].join("/")),
        None => (folder.to_path_buf(), rel.to_string()),
    };
    let prefix = if inner.is_empty() { String::new() } else { format!("{inner}/") };
    let asked_for = |e: &DirEntry| format!("{prefix}{}{}", e.name, if e.kind == EntryKind::Dir { "/" } else { "" });
    let dir = folder.join(rel);
    let askable = |e: &DirEntry| !(e.unreadable_name || (e.kind == EntryKind::Dir && is_repo_top(&dir.join(&e.name))));
    let mut asked: Vec<String> = entries.iter().filter(|e| askable(e)).map(asked_for).collect();
    let own = format!("{inner}/");
    if !inner.is_empty() {
        asked.push(own.clone());
    }
    let ignored = ignored_of(git_bin, &cwd, &asked);
    let all = !inner.is_empty() && ignored.contains(&own);
    for entry in entries.iter_mut() {
        entry.ignored = all || (askable(entry) && ignored.contains(&asked_for(entry)));
    }
}

/// The text of the file `rel` inside `folder`, as 8.1 shows a new side: a link is its target
/// text (never followed); binary, too large and not-UTF-8 as in the diff. `Err`: a refused path,
/// a folder, `not on disk: <rel>`, or why it could not be read.
pub fn file_view(folder: &Path, rel: &str, scope: &Scope) -> Result<FileView, String> {
    if rel.is_empty() {
        return Err(IS_FOLDER.to_string());
    }
    let names = parts(rel)?;
    // The folder it is in must really be inside; the file itself may be a link (shown as text).
    let parent_rel = names[..names.len() - 1].join("/");
    let parent = resolve(folder, &parent_rel, scope)?;
    if scope.hides(rel) {
        return Err(HIDDEN.to_string());
    }
    if !parent_rel.is_empty() && std::fs::symlink_metadata(&parent).is_ok_and(|m| m.file_type().is_symlink()) {
        return Err(THROUGH_LINK.to_string());
    }
    let path = parent.join(names[names.len() - 1]);
    let meta = std::fs::symlink_metadata(&path).map_err(|_| format!("{NOT_ON_DISK}: {rel}"))?;
    if meta.is_dir() {
        return Err(IS_FOLDER.to_string());
    }
    let side = diff::read_disk(&path, folder)?;
    if side == Side::Absent {
        return Err(format!("{NOT_ON_DISK}: {rel}"));
    }
    Ok(FileView {
        path: rel.to_string(),
        content: diff::content_of(Side::Absent, side, false),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::branches::tests::{git_ok, real_git, temp_repo};

    fn names(list: &DirListing) -> Vec<(&str, EntryKind, bool)> {
        list.entries.iter().map(|e| (e.name.as_str(), e.kind, e.ignored)).collect()
    }

    #[test]
    fn ui_paths_must_be_plain_relative_names() {
        assert_eq!(parts(""), Ok(vec![]));
        assert_eq!(parts("src/a.ts"), Ok(vec!["src", "a.ts"]));
        assert_eq!(parts(".env"), Ok(vec![".env"]));
        for bad in ["..", "../x", "src/../../x", "/etc/passwd", "src//a", "src/", "./a", "a\u{0}b", "a\u{1b}[2J", ".git", ".git/config", "sub/.git/HEAD"] {
            assert_eq!(parts(bad), Err(BAD_PATH.to_string()), "{bad:?}");
        }
        assert_eq!(parts(".gitignore"), Ok(vec![".gitignore"]));
        if cfg!(windows) {
            for bad in [
                "C:/Windows", "C:", "a\\..\\b", "\\\\server\\share", ".GIT", "src/.Git/config", "CON", "con", "NUL", "nul.txt", "COM1", "com9.log", "LPT1",
                "aux.txt", "AUX .txt", "src/prn", "CONIN$", "name.", "name ", "dir./x",
            ] {
                assert_eq!(parts(bad), Err(BAD_PATH.to_string()), "{bad:?}");
            }
            for good in ["console.log", "COM10", "nul-thing", "LPT", "auxiliary.txt"] {
                assert!(parts(good).is_ok(), "{good:?}");
            }
        }
    }

    #[test]
    fn linked_worktree_paths_are_hidden_and_refused() {
        let scope = Scope { worktrees: vec![".worktrees/feat".into()] };
        assert!(scope.hides(".worktrees/feat"));
        assert!(scope.hides(".worktrees/feat/a.txt"));
        assert!(!scope.hides(".worktrees/feature"));
        assert!(!scope.hides(".worktrees"));
        assert_eq!(scope.hides(".WORKTREES/feat/a.txt"), cfg!(windows));
        let dir = tempfile::tempdir().unwrap();
        let folder = dunce::canonicalize(dir.path()).unwrap();
        std::fs::create_dir_all(folder.join(".worktrees/feat")).unwrap();
        std::fs::write(folder.join(".worktrees/feat/a.txt"), "a").unwrap();
        assert_eq!(resolve(&folder, ".worktrees/feat", &scope), Err(HIDDEN.to_string()));
        assert_eq!(on_disk(&folder, ".worktrees/feat/a.txt", &scope), Err(HIDDEN.to_string()));
        assert_eq!(file_view(&folder, ".worktrees/feat/a.txt", &scope), Err(HIDDEN.to_string()));
        assert!(resolve(&folder, ".worktrees", &scope).is_ok());
    }

    /// A name the UI could not send back (control characters) is listed as unreadable. Skipped
    /// where the file system refuses such a name (Windows).
    #[test]
    fn a_name_with_control_characters_is_listed_unreadable() {
        let dir = tempfile::tempdir().unwrap();
        if std::fs::write(dir.path().join("bad\u{1b}name"), "x").is_err() {
            eprintln!("skipped: the file system refuses the name");
            return;
        }
        std::fs::write(dir.path().join("ok.txt"), "x").unwrap();
        let list = list_dir(Path::new("git-not-here"), dir.path(), "").unwrap();
        let got: Vec<(&str, bool)> = list.entries.iter().map(|e| (e.name.as_str(), e.unreadable_name)).collect();
        assert_eq!(got, [("bad\u{1b}name", true), ("ok.txt", false)]);
    }

    #[test]
    fn entries_sort_folders_first_then_names_case_insensitively() {
        let e = |name: &str, kind| DirEntry { name: name.into(), path: name.into(), kind, ignored: false, unreadable_name: false };
        let mut list = [e("b.txt", EntryKind::File), e("Zed", EntryKind::Dir), e("A.md", EntryKind::File), e("link", EntryKind::Link), e("alpha", EntryKind::Dir), e(".env", EntryKind::File)];
        list.sort_by(order);
        let got: Vec<&str> = list.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(got, ["alpha", "Zed", ".env", "A.md", "b.txt", "link"]);
    }

    #[test]
    fn a_file_view_applies_the_diff_limits() {
        let dir = tempfile::tempdir().unwrap();
        let folder = dunce::canonicalize(dir.path()).unwrap();
        std::fs::write(folder.join("a.ts"), "one\r\ntwo\r\n").unwrap();
        std::fs::write(folder.join("bin.dat"), b"x\0y").unwrap();
        std::fs::write(folder.join("big.txt"), "x\n".repeat(diff::MAX_SIDE_LINES + 1)).unwrap();
        std::fs::write(folder.join("huge.txt"), vec![b'x'; diff::MAX_SIDE_BYTES + 1]).unwrap();
        std::fs::write(folder.join("latin.txt"), b"caf\xe9\n").unwrap();
        std::fs::create_dir(folder.join("src")).unwrap();
        assert_eq!(file_view(&folder, "a.ts", &Scope::default()).unwrap().content, Content::Text { old: None, new: Some("one\ntwo\n".into()), not_utf8: false });
        assert_eq!(file_view(&folder, "bin.dat", &Scope::default()).unwrap().content, Content::Binary);
        assert_eq!(file_view(&folder, "big.txt", &Scope::default()).unwrap().content, Content::TooLarge);
        assert_eq!(file_view(&folder, "huge.txt", &Scope::default()).unwrap().content, Content::TooLarge);
        assert_eq!(file_view(&folder, "latin.txt", &Scope::default()).unwrap().content, Content::Text { old: None, new: Some("caf\u{FFFD}\n".into()), not_utf8: true });
        assert_eq!(file_view(&folder, "src", &Scope::default()), Err(IS_FOLDER.to_string()));
        assert_eq!(file_view(&folder, "gone.ts", &Scope::default()), Err(format!("{NOT_ON_DISK}: gone.ts")));
        assert_eq!(file_view(&folder, "../x", &Scope::default()), Err(BAD_PATH.to_string()));
        assert_eq!(on_disk(&folder, "a.ts", &Scope::default()), Ok(folder.join("a.ts")));
        assert_eq!(on_disk(&folder, "src/gone.ts", &Scope::default()), Err(format!("{NOT_ON_DISK}: src/gone.ts")));
        assert_eq!(on_disk(&folder, "src", &Scope::default()), Err(IS_FOLDER.to_string()));
        assert_eq!(on_disk(&folder, "", &Scope::default()), Err(BAD_PATH.to_string()));
    }

    /// A link to a folder elsewhere (a junction on Windows when links need a privilege) is listed
    /// as a link and never listed through, and a file reached through it is refused. Skipped where
    /// no link can be made.
    #[test]
    fn a_folder_link_is_shown_never_followed() {
        let dir = tempfile::tempdir().unwrap();
        let base = dunce::canonicalize(dir.path()).unwrap();
        let folder = base.join("repo");
        let outside = base.join("secret");
        std::fs::create_dir_all(&folder).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(outside.join("key.txt"), "k").unwrap();
        let dir_link = folder.join("out");
        #[cfg(windows)]
        let made = std::os::windows::fs::symlink_dir(&outside, &dir_link).is_ok()
            || std::process::Command::new("cmd")
                .args(["/C", "mklink", "/J"])
                .arg(&dir_link)
                .arg(&outside)
                .output()
                .is_ok_and(|o| o.status.success());
        #[cfg(not(windows))]
        let made = std::os::unix::fs::symlink(&outside, &dir_link).is_ok();
        if !made {
            eprintln!("skipped: cannot create a link here");
            return;
        }
        let git = real_git().unwrap_or_else(|| PathBuf::from("git-not-here"));
        let list = list_dir(&git, &folder, "").unwrap();
        assert_eq!(names(&list), [("out", EntryKind::Link, false)]);
        assert_eq!(list_dir(&git, &folder, "out"), Err(diff::OUTSIDE.to_string()));
        assert_eq!(file_view(&folder, "out/key.txt", &Scope::default()), Err(diff::OUTSIDE.to_string()));
        assert_eq!(on_disk(&folder, "out/key.txt", &Scope::default()), Err(THROUGH_LINK.to_string()));
    }

    /// A file link is viewed as its target text and never opened when it points elsewhere.
    /// Skipped where links cannot be made.
    #[test]
    fn a_file_link_is_its_target_text() {
        let dir = tempfile::tempdir().unwrap();
        let base = dunce::canonicalize(dir.path()).unwrap();
        let folder = base.join("repo");
        let outside = base.join("secret");
        std::fs::create_dir_all(&folder).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(outside.join("key.txt"), "k").unwrap();
        let file_link = folder.join("key-link");
        #[cfg(windows)]
        let made = std::os::windows::fs::symlink_file(outside.join("key.txt"), &file_link).is_ok();
        #[cfg(not(windows))]
        let made = std::os::unix::fs::symlink(outside.join("key.txt"), &file_link).is_ok();
        if !made {
            eprintln!("skipped: cannot create a link here");
            return;
        }
        let list = list_dir(Path::new("git-not-here"), &folder, "").unwrap();
        assert_eq!(names(&list), [("key-link", EntryKind::Link, false)]);
        match file_view(&folder, "key-link", &Scope::default()).unwrap().content {
            Content::Text { new: Some(text), .. } => assert!(text.ends_with("secret/key.txt"), "{text}"),
            other => panic!("not the link's text: {other:?}"),
        }
        assert_eq!(on_disk(&folder, "key-link", &Scope::default()), Err(diff::OUTSIDE.to_string()));
    }

    /// A link to a folder inside the reviewed folder is still never passed through. Skipped where
    /// no link can be made.
    #[test]
    fn a_path_through_a_link_inside_the_folder_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let folder = dunce::canonicalize(dir.path()).unwrap();
        std::fs::create_dir_all(folder.join("src")).unwrap();
        std::fs::write(folder.join("src/a.ts"), "a").unwrap();
        let link = folder.join("alias");
        #[cfg(windows)]
        let made = std::os::windows::fs::symlink_dir(folder.join("src"), &link).is_ok()
            || std::process::Command::new("cmd")
                .args(["/C", "mklink", "/J"])
                .arg(&link)
                .arg(folder.join("src"))
                .output()
                .is_ok_and(|o| o.status.success());
        #[cfg(not(windows))]
        let made = std::os::unix::fs::symlink(folder.join("src"), &link).is_ok();
        if !made {
            eprintln!("skipped: cannot create a link here");
            return;
        }
        let none = Scope::default();
        assert_eq!(on_disk(&folder, "alias/a.ts", &none), Err(THROUGH_LINK.to_string()));
        assert_eq!(file_view(&folder, "alias/a.ts", &none), Err(THROUGH_LINK.to_string()));
        assert_eq!(list_dir(Path::new("git-not-here"), &folder, "alias"), Err(NOT_FOLDER.to_string()));
        assert_eq!(list_dir(Path::new("git-not-here"), &folder, "alias/x"), Err(THROUGH_LINK.to_string()));
        assert_eq!(on_disk(&folder, "src/a.ts", &none), Ok(folder.join("src").join("a.ts")));
    }

    #[test]
    fn a_folder_lists_ignored_entries_dimmed_without_git_or_linked_worktrees() {
        let Some(git) = real_git() else {
            eprintln!("git not on PATH; skipping");
            return;
        };
        let dir = temp_repo(&git);
        let repo = dunce::canonicalize(dir.path()).unwrap();
        std::fs::write(repo.join(".gitignore"), "node_modules/\n*.log\n").unwrap();
        std::fs::create_dir_all(repo.join("src/nested")).unwrap();
        std::fs::write(repo.join("src/a.ts"), "a\n").unwrap();
        std::fs::write(repo.join("src/nested/b.ts"), "b\n").unwrap();
        std::fs::write(repo.join("src/debug.log"), "x\n").unwrap();
        std::fs::create_dir_all(repo.join("node_modules/pkg")).unwrap();
        std::fs::write(repo.join("node_modules/pkg/index.js"), "x\n").unwrap();
        std::fs::write(repo.join(".env"), "X=1\n").unwrap();
        git_ok(&git, &repo, &["worktree", "add", "-q", "-b", "feat", ".worktrees/feat"]);

        let top = list_dir(&git, &repo, "").unwrap();
        assert_eq!(top.root, repo.display().to_string());
        assert_eq!(
            names(&top),
            [
                (".worktrees", EntryKind::Dir, false),
                ("node_modules", EntryKind::Dir, true),
                ("src", EntryKind::Dir, false),
                (".env", EntryKind::File, false),
                (".gitignore", EntryKind::File, false),
                ("a.txt", EntryKind::File, false),
            ]
        );
        // The linked worktree inside is left out of its folder.
        assert!(list_dir(&git, &repo, ".worktrees").unwrap().entries.is_empty());
        let src = list_dir(&git, &repo, "src").unwrap();
        assert_eq!(names(&src), [("nested", EntryKind::Dir, false), ("a.ts", EntryKind::File, false), ("debug.log", EntryKind::File, true)]);
        assert_eq!(src.entries[1].path, "src/a.ts");
        assert_eq!(names(&list_dir(&git, &repo, "src/nested").unwrap()), [("b.ts", EntryKind::File, false)]);
        // Everything under an ignored folder is ignored.
        assert_eq!(names(&list_dir(&git, &repo, "node_modules").unwrap()), [("pkg", EntryKind::Dir, true)]);
        assert_eq!(names(&list_dir(&git, &repo, "node_modules/pkg").unwrap()), [("index.js", EntryKind::File, true)]);
        assert_eq!(list_dir(&git, &repo, "src/a.ts"), Err(NOT_FOLDER.to_string()));
        assert_eq!(list_dir(&git, &repo, "gone"), Err(format!("{NOT_ON_DISK}: gone")));
        assert_eq!(list_dir(&git, &repo, "../x"), Err(BAD_PATH.to_string()));

        // A subfolder project sees its own entries; the worktree reviewed on its own lists no `.git` file.
        assert_eq!(names(&list_dir(&git, &repo.join("src"), "").unwrap())[2], ("debug.log", EntryKind::File, true));
        let feat = list_dir(&git, &repo.join(".worktrees/feat"), "").unwrap();
        assert_eq!(names(&feat), [("a.txt", EntryKind::File, false)]);

        // A nested repository (a submodule's checkout looks the same): the outer listing still
        // dims, and inside it its own `.gitignore` decides.
        let inner = repo.join("vendor").join("lib");
        std::fs::create_dir_all(&inner).unwrap();
        git_ok(&git, &inner, &["init", "-q"]);
        std::fs::write(inner.join(".gitignore"), "out/\n").unwrap();
        std::fs::create_dir_all(inner.join("out")).unwrap();
        std::fs::write(inner.join("x.log"), "x").unwrap();
        let top = list_dir(&git, &repo, "").unwrap();
        assert!(top.entries.iter().any(|e| e.name == "node_modules" && e.ignored), "{:?}", names(&top));
        assert_eq!(names(&list_dir(&git, &repo, "vendor").unwrap()), [("lib", EntryKind::Dir, false)]);
        assert_eq!(
            names(&list_dir(&git, &repo, "vendor/lib").unwrap()),
            [("out", EntryKind::Dir, true), (".gitignore", EntryKind::File, false), ("x.log", EntryKind::File, false)]
        );
        assert!(list_dir(&git, &repo, "vendor/lib/out").unwrap().entries.is_empty());

        // A plain folder: nothing is ignored.
        let plain = tempfile::tempdir().unwrap();
        std::fs::write(plain.path().join("x.log"), "x").unwrap();
        assert_eq!(names(&list_dir(&git, plain.path(), "").unwrap()), [("x.log", EntryKind::File, false)]);
    }

    #[test]
    fn a_folder_past_the_cap_counts_the_rest() {
        let dir = tempfile::tempdir().unwrap();
        for n in 0..(MAX_ENTRIES + 3) {
            std::fs::write(dir.path().join(format!("f{n:05}")), "").unwrap();
        }
        let list = list_dir(Path::new("git-not-here"), dir.path(), "").unwrap();
        assert_eq!((list.entries.len(), list.more), (MAX_ENTRIES, 3));
        assert_eq!(list.entries[0].name, "f00000");
    }
}
