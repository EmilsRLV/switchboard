//! Tauri IPC commands. Each command is thin: validate, then delegate.

use serde::Serialize;

/// Identity of the running app, as the Cargo package declares it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct AppInfo {
    pub name: String,
    pub version: String,
}

/// Report the app name and version so the UI can prove the IPC round trip.
#[tauri::command]
pub fn app_info() -> AppInfo {
    AppInfo {
        name: env!("CARGO_PKG_NAME").to_string(),
        version: env!("CARGO_PKG_VERSION").to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn app_info_reports_cargo_package_name_and_version() {
        let info = app_info();
        assert_eq!(info.name, env!("CARGO_PKG_NAME"));
        assert_eq!(info.version, env!("CARGO_PKG_VERSION"));
        assert_eq!(info.name, "switchboard");
        assert!(!info.version.is_empty());
    }

    #[test]
    fn app_info_serialises_to_the_shape_the_ui_expects() {
        let json = serde_json::to_value(app_info()).unwrap();
        assert_eq!(json["name"], "switchboard");
        assert_eq!(json["version"], env!("CARGO_PKG_VERSION"));
    }
}
