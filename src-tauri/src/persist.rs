//! Atomic JSON persistence shared by `settings.json` and `workspace.json`: tolerant parsing
//! with line/column errors (BOM stripped), atomic writes (temp file in the same directory,
//! then rename) and first-launch creation. Callers bring the schema type; this module knows
//! nothing about what is in the file.

use std::io::Write;
use std::path::Path;

use serde::Serialize;
use serde::de::DeserializeOwned;

/// A JSON syntax or shape error with its 1-based position, formatted `line:col message`.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{line}:{col} {msg}")]
pub struct ParseError {
    pub line: usize,
    pub col: usize,
    pub msg: String,
}

/// Why a file could not be loaded. `Read` and `Write` carry the bare I/O error so each caller
/// can name its own file in the message.
#[derive(Debug, thiserror::Error)]
pub enum LoadError {
    #[error(transparent)]
    Parse(#[from] ParseError),
    #[error("{0}")]
    Read(std::io::Error),
    #[error("{0}")]
    Write(std::io::Error),
}

/// Outcome of [`load_or_init`]: whether the file was there or had to be created.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Loaded<T> {
    Created(T),
    Existing(T),
}

impl<T> Loaded<T> {
    pub fn into_inner(self) -> T {
        match self {
            Loaded::Created(value) | Loaded::Existing(value) => value,
        }
    }
}

/// Parse JSON text into `T`. Tolerance (missing keys, unknown keys) is the schema's business
/// (`#[serde(default)]`, no `deny_unknown_fields`); this only strips a leading BOM and
/// positions the error.
pub fn parse_json<T: DeserializeOwned>(text: &str) -> Result<T, ParseError> {
    // Windows editors (Notepad, PowerShell's `-Encoding utf8`) prepend a BOM, which
    // serde_json rejects as "expected value" at 1:1.
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    serde_json::from_str(text).map_err(|err| {
        let (line, col) = (err.line(), err.column());
        let full = err.to_string();
        // serde_json renders "<message> at line L column C"; keep only the message.
        let suffix = format!(" at line {line} column {col}");
        let msg = full.strip_suffix(suffix.as_str()).unwrap_or(&full).to_string();
        ParseError { line, col, msg }
    })
}

/// The on-disk form: pretty JSON with every key present and a trailing newline.
pub fn to_json<T: Serialize>(value: &T) -> serde_json::Result<String> {
    let mut text = serde_json::to_string_pretty(value)?;
    text.push('\n');
    Ok(text)
}

/// Write `value` to `path` atomically: the parent dir is created if needed, the JSON goes to
/// a temp file in that dir, is flushed, then renamed over `path`. A crash mid-write leaves
/// either the old file or the new one, never a half-written one.
pub fn write_atomic_json<T: Serialize>(path: &Path, value: &T) -> std::io::Result<()> {
    let dir = path.parent().ok_or_else(|| {
        std::io::Error::new(std::io::ErrorKind::InvalidInput, "path has no parent directory")
    })?;
    let text = to_json(value).map_err(std::io::Error::other)?;
    std::fs::create_dir_all(dir)?;
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let mut tmp = tempfile::Builder::new()
        .prefix(&format!(".{name}-"))
        .suffix(".tmp")
        .tempfile_in(dir)?;
    tmp.write_all(text.as_bytes())?;
    tmp.as_file().sync_all()?;
    tmp.persist(path).map_err(|err| err.error)?;
    Ok(())
}

/// Remove the `.<name>-*.tmp` siblings of `path` that a crash between writing a temp file
/// and renaming it left behind. Returns how many were removed; a missing parent directory
/// is simply nothing to sweep.
pub fn sweep_temp_files(path: &Path) -> std::io::Result<usize> {
    let (Some(dir), Some(name)) = (path.parent(), path.file_name()) else {
        return Ok(0);
    };
    let prefix = format!(".{}-", name.to_string_lossy());
    let entries = match std::fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(0),
        Err(err) => return Err(err),
    };
    let mut removed = 0;
    for entry in entries {
        let entry = entry?;
        let file_name = entry.file_name();
        let file_name = file_name.to_string_lossy();
        if file_name.starts_with(&prefix) && file_name.ends_with(".tmp") && entry.path().is_file() {
            std::fs::remove_file(entry.path())?;
            removed += 1;
        }
    }
    Ok(removed)
}

/// Read and parse `path`. `Ok(None)` means there is no file to read (not found, or a file
/// where its directory should be); every other I/O failure is `LoadError::Read`.
pub fn read_json<T: DeserializeOwned>(path: &Path) -> Result<Option<T>, LoadError> {
    match std::fs::read_to_string(path) {
        Ok(text) => Ok(Some(parse_json(&text)?)),
        // `NotADirectory` (a file where the config dir should be) is a write problem too: Linux
        // reports it on the read, Windows reports `NotFound` and fails in `create_dir_all`.
        Err(err)
            if matches!(
                err.kind(),
                std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory
            ) =>
        {
            Ok(None)
        }
        Err(err) => Err(LoadError::Read(err)),
    }
}

/// Read and parse `path`; when it does not exist, write `defaults` there and return them.
/// An existing file is never rewritten, so an operator's formatting and unknown keys survive.
pub fn load_or_init<T: DeserializeOwned + Serialize + Clone>(
    path: &Path,
    defaults: &T,
) -> Result<Loaded<T>, LoadError> {
    match read_json(path)? {
        Some(value) => Ok(Loaded::Existing(value)),
        None => {
            write_atomic_json(path, defaults).map_err(LoadError::Write)?;
            Ok(Loaded::Created(defaults.clone()))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;

    #[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
    #[serde(default)]
    struct Doc {
        version: u32,
        name: String,
        nested: Nested,
    }

    #[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
    #[serde(default)]
    struct Nested {
        count: u64,
    }

    #[test]
    fn to_json_is_pretty_with_a_trailing_newline_and_round_trips() {
        let doc = Doc {
            version: 1,
            name: "x".into(),
            nested: Nested { count: 2 },
        };
        let text = to_json(&doc).unwrap();
        assert!(text.starts_with("{\n  \"version\": 1,\n"), "{text}");
        assert!(text.ends_with("}\n"));
        assert_eq!(parse_json::<Doc>(&text).unwrap(), doc);
    }

    #[test]
    fn parse_json_strips_a_utf8_bom() {
        let bytes = [0xEF, 0xBB, 0xBF, b'{', b'}'];
        let doc: Doc = parse_json(std::str::from_utf8(&bytes).unwrap()).unwrap();
        assert_eq!(doc, Doc::default());
        let doc: Doc = parse_json("\u{feff}{ \"name\": \"bom\" }").unwrap();
        assert_eq!(doc.name, "bom");
    }

    #[test]
    fn parse_json_reports_line_and_column_without_the_position_suffix() {
        let err = parse_json::<Doc>("{\n  \"version\": 1,\n  \"name\": }\n").unwrap_err();
        assert_eq!((err.line, err.col), (3, 11));
        assert_eq!(err.msg, "expected value");
        assert_eq!(err.to_string(), "3:11 expected value");
    }

    #[test]
    fn type_errors_also_carry_a_position() {
        let err = parse_json::<Doc>(r#"{ "nested": { "count": "many" } }"#).unwrap_err();
        assert_eq!(err.line, 1);
        assert!(err.col > 0);
        assert!(err.msg.contains("invalid type"), "{}", err.msg);
        assert!(!err.msg.contains("at line"), "{}", err.msg);
    }

    #[test]
    fn read_json_distinguishes_missing_from_broken() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("doc.json");
        assert!(matches!(read_json::<Doc>(&path), Ok(None)));
        std::fs::write(&path, "{ \"version\": ").unwrap();
        assert!(matches!(read_json::<Doc>(&path), Err(LoadError::Parse(_))));
        std::fs::write(&path, "{ \"version\": 3 }").unwrap();
        assert_eq!(read_json::<Doc>(&path).unwrap().unwrap().version, 3);
    }

    #[test]
    fn write_atomic_json_creates_the_directory_and_leaves_no_temp_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("sub").join("doc.json");
        let doc = Doc {
            name: "a".into(),
            ..Doc::default()
        };
        write_atomic_json(&path, &doc).unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), to_json(&doc).unwrap());
        let leftovers: Vec<_> = std::fs::read_dir(path.parent().unwrap())
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        assert_eq!(leftovers, ["doc.json"]);
    }

    #[test]
    fn write_atomic_json_replaces_an_existing_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("doc.json");
        std::fs::write(&path, "old").unwrap();
        let doc = Doc {
            name: "new".into(),
            ..Doc::default()
        };
        write_atomic_json(&path, &doc).unwrap();
        assert_eq!(parse_json::<Doc>(&std::fs::read_to_string(&path).unwrap()).unwrap(), doc);
    }

    #[test]
    fn sweep_temp_files_removes_orphans_of_this_file_only() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("doc.json");
        std::fs::write(&path, "{}").unwrap();
        std::fs::write(dir.path().join(".doc.json-abc.tmp"), "half").unwrap();
        std::fs::write(dir.path().join(".doc.json-def.tmp"), "half").unwrap();
        std::fs::write(dir.path().join(".other.json-abc.tmp"), "half").unwrap();
        std::fs::write(dir.path().join("doc.json.bak"), "keep").unwrap();
        std::fs::create_dir(dir.path().join(".doc.json-dir.tmp")).unwrap();

        assert_eq!(sweep_temp_files(&path).unwrap(), 2);

        let mut names: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .map(|e| e.unwrap().file_name().into_string().unwrap())
            .collect();
        names.sort();
        assert_eq!(names, [".doc.json-dir.tmp", ".other.json-abc.tmp", "doc.json", "doc.json.bak"]);
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "{}");
    }

    #[test]
    fn sweep_temp_files_without_a_parent_directory_is_nothing_to_do() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(sweep_temp_files(&dir.path().join("missing").join("doc.json")).unwrap(), 0);
    }

    #[test]
    fn load_or_init_creates_then_reads_without_rewriting() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("doc.json");
        let defaults = Doc {
            version: 1,
            ..Doc::default()
        };
        assert_eq!(load_or_init(&path, &defaults).unwrap(), Loaded::Created(defaults.clone()));

        let hand_edited = "{ \"name\": \"edited\", \"unknown\": true }";
        std::fs::write(&path, hand_edited).unwrap();
        let loaded = load_or_init(&path, &defaults).unwrap();
        assert_eq!(loaded.clone().into_inner().name, "edited");
        assert!(matches!(loaded, Loaded::Existing(_)));
        assert_eq!(std::fs::read_to_string(&path).unwrap(), hand_edited);
    }

    #[test]
    fn load_or_init_reports_a_write_failure_when_the_directory_is_a_file() {
        let dir = tempfile::tempdir().unwrap();
        let blocker = dir.path().join("blocked");
        std::fs::write(&blocker, b"not a directory").unwrap();
        match load_or_init(&blocker.join("doc.json"), &Doc::default()) {
            Err(LoadError::Write(_)) => {}
            other => panic!("expected write error, got {other:?}"),
        }
    }
}
