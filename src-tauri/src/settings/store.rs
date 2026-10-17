//! Persistence of `settings.json`: the settings schema's validation plus thin wrappers over
//! [`crate::persist`] (tolerant parsing with line/column errors, atomic writes, first-launch
//! creation) that name the settings file in their errors.

use std::path::Path;

use super::{Banner, PollSettings, SCHEMA_VERSION, Settings};
use crate::persist;

pub use crate::persist::ParseError;

#[derive(Debug, thiserror::Error)]
pub enum LoadError {
    #[error(transparent)]
    Parse(#[from] ParseError),
    #[error("cannot read settings: {0}")]
    Read(std::io::Error),
    #[error("cannot write settings: {0}")]
    Write(std::io::Error),
}

impl From<persist::LoadError> for LoadError {
    fn from(err: persist::LoadError) -> Self {
        match err {
            persist::LoadError::Parse(err) => LoadError::Parse(err),
            persist::LoadError::Read(err) => LoadError::Read(err),
            persist::LoadError::Write(err) => LoadError::Write(err),
        }
    }
}

/// Outcome of [`load_or_init`]: whether the file was there or had to be created.
pub type Loaded = persist::Loaded<Settings>;

impl Loaded {
    pub fn into_settings(self) -> Settings {
        self.into_inner()
    }
}

/// Parse settings text. Missing keys take their defaults and unknown keys are ignored
/// (`#[serde(default)]`, no `deny_unknown_fields`); a leading BOM is tolerated.
pub fn parse(text: &str) -> Result<Settings, ParseError> {
    persist::parse_json(text)
}

/// Soft checks on a parsed file. Values that cannot work are replaced by their defaults and
/// reported; a newer schema version is reported but otherwise loaded as-is (tolerant schema).
pub fn validate(settings: &mut Settings) -> Vec<Banner> {
    let mut banners = Vec::new();
    if settings.version > SCHEMA_VERSION {
        banners.push(Banner::new(
            "settings.version",
            format!(
                "settings.json is version {}; this build understands {SCHEMA_VERSION}",
                settings.version
            ),
        ));
    }
    let defaults = PollSettings::default();
    let mut replaced = Vec::new();
    if settings.poll.agents_ms == 0 {
        settings.poll.agents_ms = defaults.agents_ms;
        replaced.push(format!("poll.agents_ms ({})", defaults.agents_ms));
    }
    if settings.poll.git_ms == 0 {
        settings.poll.git_ms = defaults.git_ms;
        replaced.push(format!("poll.git_ms ({})", defaults.git_ms));
    }
    if !replaced.is_empty() {
        banners.push(Banner::new(
            "settings.poll",
            format!("poll intervals must be above 0; using the default for {}", replaced.join(", ")),
        ));
    }
    banners
}

/// The on-disk form: pretty JSON with every key present and a trailing newline.
pub fn to_json(settings: &Settings) -> String {
    persist::to_json(settings).expect("Settings always serialises")
}

/// Write `settings` to `path` atomically (temp file in the same dir, then rename); see
/// [`persist::write_atomic_json`].
pub fn write_atomic(path: &Path, settings: &Settings) -> std::io::Result<()> {
    persist::write_atomic_json(path, settings)
}

/// Read and parse `path`; when it does not exist, write `defaults` there and return them.
/// An existing file is never rewritten, so an operator's formatting and unknown keys survive.
pub fn load_or_init(path: &Path, defaults: &Settings) -> Result<Loaded, LoadError> {
    Ok(persist::load_or_init(path, defaults)?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_round_trip_through_json() {
        let defaults = Settings::default();
        let text = to_json(&defaults);
        assert!(text.ends_with("}\n"));
        assert_eq!(parse(&text).unwrap(), defaults);
    }

    #[test]
    fn written_file_has_every_key_present() {
        let text = to_json(&Settings::default());
        assert!(text.starts_with("{\n  \"version\": 1,\n"), "version comes first:\n{text}");
        let json: serde_json::Value = serde_json::from_str(&text).unwrap();
        // `Value` objects are sorted maps; compare the key set, not the on-disk order.
        let top: Vec<&String> = json.as_object().unwrap().keys().collect();
        assert_eq!(
            top,
            [
                "claude",
                "defaults",
                "external_editor",
                "git",
                "notifications",
                "poll",
                "shell",
                "theme",
                "version",
                "worktrees_root"
            ]
        );
        assert!(json["claude"].get("path").is_some());
        assert!(json["git"].get("path").is_some());
        for key in ["model", "effort", "permission_mode"] {
            assert!(json["defaults"].get(key).is_some(), "defaults.{key} missing");
        }
        assert!(json["poll"].get("agents_ms").is_some());
        assert!(json["poll"].get("git_ms").is_some());
        assert!(json["notifications"].get("finished").is_some());
        assert!(json["notifications"].get("waiting").is_some());
    }

    #[test]
    fn missing_keys_take_their_defaults() {
        let s = parse(r#"{ "theme": "light", "poll": { "git_ms": 9000 } }"#).unwrap();
        assert_eq!(s.theme, "light");
        assert_eq!(s.poll.git_ms, 9000);
        assert_eq!(s.poll.agents_ms, Settings::default().poll.agents_ms);
        assert_eq!(s.version, Settings::default().version);
        assert_eq!(s.claude, Settings::default().claude);
        assert_eq!(s.defaults, Settings::default().defaults);
    }

    #[test]
    fn empty_object_is_the_defaults() {
        assert_eq!(parse("{}").unwrap(), Settings::default());
    }

    #[test]
    fn a_utf8_bom_is_tolerated() {
        let s = parse("\u{feff}{ \"theme\": \"light\" }").unwrap();
        assert_eq!(s.theme, "light");
        // Byte-level check too: this is exactly what Notepad / PowerShell write.
        let bytes = [0xEF, 0xBB, 0xBF, b'{', b'}'];
        assert_eq!(parse(std::str::from_utf8(&bytes).unwrap()).unwrap(), Settings::default());
    }

    #[test]
    fn validate_accepts_the_defaults_silently() {
        let mut s = Settings::default();
        assert!(validate(&mut s).is_empty());
        assert_eq!(s, Settings::default());
    }

    #[test]
    fn validate_reports_a_newer_schema_version_but_keeps_the_settings() {
        let mut s = parse(r#"{ "version": 2, "theme": "light" }"#).unwrap();
        let banners = validate(&mut s);
        assert_eq!(
            banners,
            [Banner::new("settings.version", "settings.json is version 2; this build understands 1")]
        );
        assert_eq!(s.version, 2);
        assert_eq!(s.theme, "light");
        let mut same = parse(r#"{ "version": 1 }"#).unwrap();
        assert!(validate(&mut same).is_empty());
    }

    #[test]
    fn validate_replaces_zero_poll_intervals_with_defaults() {
        let mut s = parse(r#"{ "poll": { "agents_ms": 0, "git_ms": 0 } }"#).unwrap();
        let banners = validate(&mut s);
        assert_eq!(s.poll, PollSettings::default());
        assert_eq!(banners.len(), 1);
        assert_eq!(banners[0].id, "settings.poll");
        assert!(banners[0].text.contains("poll.agents_ms (2000)"), "{}", banners[0].text);
        assert!(banners[0].text.contains("poll.git_ms (5000)"), "{}", banners[0].text);

        let mut one = parse(r#"{ "poll": { "agents_ms": 0, "git_ms": 7 } }"#).unwrap();
        let banners = validate(&mut one);
        assert_eq!((one.poll.agents_ms, one.poll.git_ms), (2000, 7));
        assert!(banners[0].text.ends_with("poll.agents_ms (2000)"), "{}", banners[0].text);
    }

    #[test]
    fn unknown_keys_are_ignored_at_every_level() {
        let s = parse(
            r#"{ "version": 1, "future_key": true, "claude": { "path": "x", "flags": [] }, "poll": { "agents_ms": 1, "extra": 2 } }"#,
        )
        .unwrap();
        assert_eq!(s.claude.path.as_deref(), Some("x"));
        assert_eq!(s.poll.agents_ms, 1);
    }

    #[test]
    fn parse_error_reports_line_and_column_without_the_position_suffix() {
        let err = parse("{\n  \"version\": 1,\n  \"theme\": }\n").unwrap_err();
        assert_eq!((err.line, err.col), (3, 12));
        assert_eq!(err.msg, "expected value");
        assert_eq!(err.to_string(), "3:12 expected value");
    }

    #[test]
    fn type_errors_also_carry_a_position() {
        let err = parse(r#"{ "poll": { "agents_ms": "fast" } }"#).unwrap_err();
        assert_eq!(err.line, 1);
        assert!(err.col > 0);
        assert!(err.msg.contains("invalid type"), "{}", err.msg);
        assert!(!err.msg.contains("at line"), "{}", err.msg);
    }

    #[test]
    fn load_or_init_creates_the_file_with_defaults_when_absent() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("switchboard").join("settings.json");
        let mut defaults = Settings::default();
        defaults.claude.path = Some("C:/bin/claude.exe".into());

        let loaded = load_or_init(&path, &defaults).unwrap();
        assert_eq!(loaded, Loaded::Created(defaults.clone()));
        assert_eq!(std::fs::read_to_string(&path).unwrap(), to_json(&defaults));
        let leftovers: Vec<_> = std::fs::read_dir(path.parent().unwrap())
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        assert_eq!(leftovers, ["settings.json"], "no temp files left behind");
    }

    #[test]
    fn load_or_init_reads_an_existing_file_and_does_not_rewrite_it() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        let original = "{ \"theme\": \"light\", \"unknown\": 1 }";
        std::fs::write(&path, original).unwrap();

        let loaded = load_or_init(&path, &Settings::default()).unwrap();
        let Loaded::Existing(s) = loaded else {
            panic!("expected Existing")
        };
        assert_eq!(s.theme, "light");
        assert_eq!(std::fs::read_to_string(&path).unwrap(), original);
    }

    #[test]
    fn load_or_init_surfaces_a_parse_error_with_position() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        std::fs::write(&path, "{\n  \"version\": 1,\n  \"theme\": }\n").unwrap();
        match load_or_init(&path, &Settings::default()) {
            Err(LoadError::Parse(err)) => assert_eq!(err.to_string(), "3:12 expected value"),
            other => panic!("expected parse error, got {other:?}"),
        }
    }

    #[test]
    fn load_or_init_reports_a_write_failure() {
        let dir = tempfile::tempdir().unwrap();
        // A file where the config *directory* should be makes create_dir_all fail.
        let blocker = dir.path().join("switchboard");
        std::fs::write(&blocker, b"not a directory").unwrap();
        let path = blocker.join("settings.json");
        match load_or_init(&path, &Settings::default()) {
            Err(LoadError::Write(_)) => {}
            other => panic!("expected write error, got {other:?}"),
        }
    }

    #[test]
    fn write_atomic_replaces_an_existing_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        std::fs::write(&path, "old").unwrap();
        let s = Settings {
            theme: "light".into(),
            ..Settings::default()
        };
        write_atomic(&path, &s).unwrap();
        assert_eq!(parse(&std::fs::read_to_string(&path).unwrap()).unwrap(), s);
    }
}
