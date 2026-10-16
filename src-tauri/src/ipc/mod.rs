//! Tauri IPC commands. Each command is thin: validate, then delegate.

use serde::Serialize;
use tauri::{AppHandle, Runtime, State};
use tauri_plugin_opener::OpenerExt;

use crate::settings::{self, AppState, Snapshot};

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

/// The current settings snapshot: file path, effective settings, detected binaries, banners.
#[tauri::command]
pub fn settings_get(state: State<'_, AppState>) -> Snapshot {
    state.read().snapshot()
}

/// Open the config folder in the OS file manager with `settings.json` selected; when the
/// file is gone but its folder exists, open the folder (that is where the operator wants to
/// be to recreate it).
#[tauri::command]
pub fn settings_reveal<R: Runtime>(app: AppHandle<R>, state: State<'_, AppState>) -> Result<(), String> {
    let path = state
        .read()
        .path
        .clone()
        .ok_or_else(|| "settings file location is unknown".to_string())?;
    let opener = app.opener();
    if path.is_file() {
        opener.reveal_item_in_dir(&path)
    } else if let Some(dir) = path.parent().filter(|d| d.is_dir()) {
        opener.open_path(dir.display().to_string(), None::<&str>)
    } else {
        return Err(format!("{} does not exist", path.display()));
    }
    .map_err(|err| err.to_string())
}

/// Re-run binary detection (`claude`, `git`). Also emits `settings://changed`.
#[tauri::command]
pub async fn binaries_redetect<R: Runtime>(app: AppHandle<R>) -> Snapshot {
    settings::redetect(app).await
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
