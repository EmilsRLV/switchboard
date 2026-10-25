//! Platform paths. The config dir is `dirs::config_dir()/switchboard` -- `%APPDATA%\switchboard`
//! on Windows, `$XDG_CONFIG_HOME/switchboard` (default `~/.config/switchboard`) on Linux --
//! deliberately not Tauri's identifier-based `app_config_dir`.

use std::path::{Path, PathBuf};

/// Directory name under the platform config dir.
pub const DIR_NAME: &str = "switchboard";
/// The settings file name inside [`config_dir`].
pub const FILE_NAME: &str = "settings.json";
/// The workspace file name inside [`config_dir`], beside `settings.json`.
pub const WORKSPACE_FILE_NAME: &str = "workspace.json";
/// The keybinding overrides file name inside [`config_dir`], beside `settings.json` (Story 9.4).
pub const KEYBINDINGS_FILE_NAME: &str = "keybindings.json";

/// `<platform config dir>/switchboard`, or `None` when the platform has no config dir
/// (no `%APPDATA%` / no home).
pub fn config_dir() -> Option<PathBuf> {
    dirs::config_dir().map(|base| config_dir_in(&base))
}

/// The app's config dir under an explicit base; what [`config_dir`] does with `dirs`.
pub fn config_dir_in(base: &Path) -> PathBuf {
    base.join(DIR_NAME)
}

/// Absolute path of `settings.json`.
pub fn settings_path() -> Option<PathBuf> {
    config_dir().map(|dir| settings_path_in(&dir))
}

/// `settings.json` inside a given config dir.
pub fn settings_path_in(config_dir: &Path) -> PathBuf {
    config_dir.join(FILE_NAME)
}

/// Absolute path of `workspace.json`.
pub fn workspace_path() -> Option<PathBuf> {
    config_dir().map(|dir| workspace_path_in(&dir))
}

/// `workspace.json` inside a given config dir.
pub fn workspace_path_in(config_dir: &Path) -> PathBuf {
    config_dir.join(WORKSPACE_FILE_NAME)
}

/// `keybindings.json` inside a given config dir.
pub fn keybindings_path_in(config_dir: &Path) -> PathBuf {
    config_dir.join(KEYBINDINGS_FILE_NAME)
}

/// Directories searched for `claude` after PATH: `~/.local/bin` (where the native installer
/// puts it on every platform).
pub fn extra_bin_dirs() -> Vec<PathBuf> {
    dirs::home_dir()
        .map(|home| home.join(".local").join("bin"))
        .into_iter()
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn config_dir_in_appends_the_app_folder() {
        assert_eq!(
            config_dir_in(Path::new("/base")),
            Path::new("/base").join("switchboard")
        );
    }

    #[test]
    fn settings_path_in_appends_the_file_name() {
        let dir = Path::new("/base").join("switchboard");
        assert_eq!(settings_path_in(&dir), dir.join("settings.json"));
    }

    #[test]
    fn workspace_path_sits_beside_settings_json() {
        let dir = Path::new("/base").join("switchboard");
        assert_eq!(workspace_path_in(&dir), dir.join("workspace.json"));
        let (settings, workspace) = (settings_path().unwrap(), workspace_path().unwrap());
        assert_eq!(settings.parent(), workspace.parent());
        assert_eq!(workspace.file_name().unwrap(), "workspace.json");
    }

    #[test]
    fn keybindings_path_sits_beside_settings_json() {
        let dir = Path::new("/base").join("switchboard");
        assert_eq!(keybindings_path_in(&dir), dir.join("keybindings.json"));
        assert_eq!(keybindings_path_in(&dir).parent(), settings_path_in(&dir).parent());
    }

    #[test]
    fn settings_path_ends_with_switchboard_settings_json() {
        let path = settings_path().expect("this platform has a config dir");
        assert_eq!(path.file_name().unwrap(), "settings.json");
        assert_eq!(path.parent().unwrap().file_name().unwrap(), "switchboard");
    }

    #[cfg(windows)]
    #[test]
    fn windows_config_dir_is_under_appdata() {
        let appdata = std::env::var_os("APPDATA").expect("APPDATA is set on Windows");
        assert_eq!(
            config_dir().unwrap(),
            PathBuf::from(appdata).join("switchboard")
        );
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    #[test]
    fn linux_config_dir_honours_xdg_config_home_or_falls_back_to_dot_config() {
        let dir = config_dir().unwrap();
        let expected_base = match std::env::var_os("XDG_CONFIG_HOME").filter(|v| !v.is_empty()) {
            Some(xdg) => PathBuf::from(xdg),
            None => PathBuf::from(std::env::var_os("HOME").expect("HOME is set")).join(".config"),
        };
        assert_eq!(dir, expected_base.join("switchboard"));
    }

    #[test]
    fn extra_bin_dirs_is_home_local_bin() {
        let dirs = extra_bin_dirs();
        assert_eq!(dirs.len(), 1);
        let p = &dirs[0];
        assert_eq!(p.file_name().unwrap(), "bin");
        assert_eq!(p.parent().unwrap().file_name().unwrap(), ".local");
    }
}
