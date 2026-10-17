//! Persistence of `workspace.json`: thin wrappers over [`crate::persist`] for the
//! [`Workspace`] schema, plus the soft validation that produces banners.

use std::path::Path;

use super::{SCHEMA_VERSION, Viewport, Workspace};
use crate::persist::{self, LoadError, Loaded, ParseError};
use crate::settings::Banner;

/// Parse workspace text. Missing keys take their defaults, unknown keys are ignored and a
/// leading BOM is tolerated.
pub fn parse(text: &str) -> Result<Workspace, ParseError> {
    persist::parse_json(text)
}

/// The on-disk form: pretty JSON with every key present and a trailing newline.
pub fn to_json(workspace: &Workspace) -> String {
    persist::to_json(workspace).expect("Workspace always serialises")
}

/// Soft checks on a loaded workspace. An older version is upgraded in place (nothing to
/// migrate yet, no banner); a newer one is reported and loaded as-is, and the caller keeps
/// the file read-only so a v1 write cannot drop its fields. A viewport the canvas cannot show
/// (non-finite, or zoom outside the limits) is replaced by the home view and reported.
pub fn validate(workspace: &mut Workspace) -> Vec<Banner> {
    let mut banners = Vec::new();
    if workspace.version < SCHEMA_VERSION {
        workspace.version = SCHEMA_VERSION;
    }
    if workspace.version > SCHEMA_VERSION {
        banners.push(Banner::new(
            "workspace.version",
            format!(
                "workspace.json is version {}; this build understands {SCHEMA_VERSION}; \
                 changes are kept in memory and not saved",
                workspace.version
            ),
        ));
    }
    if !workspace.viewport.is_usable() {
        workspace.viewport = Viewport::default();
        banners.push(Banner::new(
            "workspace.viewport",
            "workspace.json had an unusable viewport; reset to the home view",
        ));
    }
    // Node ids must be unique and non-empty (xyflow keys on them); a hand-edited file that
    // breaks this loses the offending projects, first of a duplicate kept.
    let before = workspace.projects.len();
    let mut seen = std::collections::HashSet::new();
    workspace
        .projects
        .retain(|project| !project.id.is_empty() && seen.insert(project.id.clone()));
    let dropped = before - workspace.projects.len();
    if dropped > 0 {
        banners.push(Banner::new(
            "workspace.projects",
            format!(
                "workspace.json had {dropped} project{} with an empty or duplicate id; dropped",
                if dropped == 1 { "" } else { "s" }
            ),
        ));
    }
    banners
}

/// Read and parse `path`; when it does not exist, write the default workspace there.
pub fn load_or_init(path: &Path) -> Result<Loaded<Workspace>, LoadError> {
    persist::load_or_init(path, &Workspace::default())
}

/// Write `workspace` to `path` atomically (temp file in the same dir, then rename).
pub fn write(path: &Path, workspace: &Workspace) -> std::io::Result<()> {
    persist::write_atomic_json(path, workspace)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::graph::Viewport;

    #[test]
    fn defaults_round_trip_through_json_with_version_first() {
        let text = to_json(&Workspace::default());
        assert!(text.starts_with("{\n  \"version\": 1,\n"), "{text}");
        assert!(text.ends_with("}\n"));
        assert_eq!(parse(&text).unwrap(), Workspace::default());
        let json: serde_json::Value = serde_json::from_str(&text).unwrap();
        let top: Vec<&String> = json.as_object().unwrap().keys().collect();
        assert_eq!(
            top,
            ["branches", "defaults", "edges", "projects", "sessions", "version", "viewport"]
        );
        assert_eq!(json["viewport"], serde_json::json!({ "x": 0.0, "y": 0.0, "zoom": 1.0 }));
    }

    #[test]
    fn empty_object_is_the_defaults() {
        assert_eq!(parse("{}").unwrap(), Workspace::default());
    }

    #[test]
    fn missing_keys_take_their_defaults_and_unknown_keys_are_ignored() {
        let ws = parse(
            r#"{ "viewport": { "x": 3, "extra": 1 }, "future": [1, 2], "projects": [{ "id": "p", "unknown": {} }] }"#,
        )
        .unwrap();
        assert_eq!(ws.viewport, Viewport { x: 3.0, y: 0.0, zoom: 1.0 });
        assert_eq!(ws.projects.len(), 1);
        assert_eq!(ws.projects[0].id, "p");
        assert_eq!(ws.projects[0].label, "");
        assert!(!ws.projects[0].expanded);
    }

    #[test]
    fn a_utf8_bom_is_tolerated() {
        let ws = parse("\u{feff}{ \"viewport\": { \"zoom\": 0.5 } }").unwrap();
        assert_eq!(ws.viewport.zoom, 0.5);
    }

    #[test]
    fn parse_error_reports_line_and_column() {
        let err = parse("{\n  \"version\": 1,\n  \"viewport\": }\n").unwrap_err();
        assert_eq!(err.to_string(), "3:15 expected value");
    }

    #[test]
    fn validate_accepts_the_defaults_and_reports_a_newer_version() {
        let mut defaults = Workspace::default();
        assert!(validate(&mut defaults).is_empty());
        assert_eq!(defaults, Workspace::default());

        let mut newer = parse(r#"{ "version": 2 }"#).unwrap();
        assert_eq!(
            validate(&mut newer),
            [Banner::new(
                "workspace.version",
                "workspace.json is version 2; this build understands 1; changes are kept in memory and not saved"
            )]
        );
        assert_eq!(newer.version, 2, "loaded as-is");
    }

    #[test]
    fn validate_upgrades_an_older_version_silently() {
        let mut older = parse(r#"{ "version": 0, "viewport": { "zoom": 2 } }"#).unwrap();
        assert!(validate(&mut older).is_empty());
        assert_eq!(older.version, SCHEMA_VERSION);
        assert_eq!(older.viewport.zoom, 2.0, "nothing else touched");
    }

    #[test]
    fn validate_resets_an_unusable_viewport_to_the_home_view() {
        let banner = Banner::new("workspace.viewport", "workspace.json had an unusable viewport; reset to the home view");
        for text in [
            r#"{ "viewport": { "x": 5, "y": 6, "zoom": 0 } }"#,
            r#"{ "viewport": { "zoom": -1 } }"#,
            r#"{ "viewport": { "zoom": 0.05 } }"#,
            r#"{ "viewport": { "zoom": 9 } }"#,
        ] {
            let mut ws = parse(text).unwrap();
            assert_eq!(validate(&mut ws), std::slice::from_ref(&banner), "{text}");
            assert_eq!(ws.viewport, Viewport::default(), "{text}");
        }
        // JSON cannot carry NaN or infinity (serde_json rejects `1e400` as out of range), so
        // the non-finite branch is reached only from memory.
        let mut ws = Workspace {
            viewport: Viewport {
                x: f64::INFINITY,
                ..Viewport::default()
            },
            ..Workspace::default()
        };
        assert_eq!(validate(&mut ws), std::slice::from_ref(&banner));
        assert_eq!(ws.viewport, Viewport::default());
        for text in [
            r#"{ "viewport": { "x": -120, "y": 40, "zoom": 1.5 } }"#,
            r#"{ "viewport": { "zoom": 0.1 } }"#,
            r#"{ "viewport": { "zoom": 4 } }"#,
        ] {
            let mut ws = parse(text).unwrap();
            let before = ws.viewport;
            assert!(validate(&mut ws).is_empty(), "{text}");
            assert_eq!(ws.viewport, before, "{text}");
        }
    }

    #[test]
    fn validate_drops_projects_with_empty_or_duplicate_ids_keeping_the_first() {
        let mut ws = parse(
            r#"{ "projects": [
                { "id": "a", "label": "first a" },
                { "id": "", "label": "no id" },
                { "id": "b" },
                { "id": "a", "label": "second a" }
            ] }"#,
        )
        .unwrap();
        assert_eq!(
            validate(&mut ws),
            [Banner::new(
                "workspace.projects",
                "workspace.json had 2 projects with an empty or duplicate id; dropped"
            )]
        );
        let kept: Vec<(&str, &str)> = ws.projects.iter().map(|p| (p.id.as_str(), p.label.as_str())).collect();
        assert_eq!(kept, [("a", "first a"), ("b", "")]);

        let mut one = parse(r#"{ "projects": [{ "id": "" }] }"#).unwrap();
        assert_eq!(validate(&mut one)[0].text, "workspace.json had 1 project with an empty or duplicate id; dropped");
        assert!(one.projects.is_empty());

        let mut fine = parse(r#"{ "projects": [{ "id": "a" }, { "id": "b" }] }"#).unwrap();
        assert!(validate(&mut fine).is_empty());
        assert_eq!(fine.projects.len(), 2);
    }

    #[test]
    fn load_or_init_creates_the_default_file_when_absent() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("switchboard").join("workspace.json");
        assert_eq!(load_or_init(&path).unwrap(), Loaded::Created(Workspace::default()));
        assert_eq!(std::fs::read_to_string(&path).unwrap(), to_json(&Workspace::default()));
    }

    #[test]
    fn write_then_load_returns_what_was_written() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("workspace.json");
        let ws = Workspace {
            viewport: Viewport {
                x: -120.0,
                y: 40.0,
                zoom: 1.5,
            },
            ..Workspace::default()
        };
        write(&path, &ws).unwrap();
        assert_eq!(load_or_init(&path).unwrap(), Loaded::Existing(ws));
    }
}
