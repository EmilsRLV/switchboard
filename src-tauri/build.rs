use tauri_build::{Attributes, WindowsAttributes};

fn main() {
    // Let tauri-build do everything (icon, version info, ACL manifest) except embedding the
    // Windows application manifest, which `embed_app_manifest` handles for every executable.
    tauri_build::try_build(
        Attributes::new().windows_attributes(WindowsAttributes::new_without_app_manifest()),
    )
    .expect("failed to run tauri-build");
    embed_app_manifest();
}

/// tauri-build's own manifest embedding reaches the app binary only (`rustc-link-arg-bins`),
/// so the lib's unit-test executable had none. Without the Common Controls v6 dependency the
/// loader binds the legacy `comctl32.dll`, which lacks `TaskDialogIndirect` (imported through
/// tauri-runtime-wry's dialog), and `cargo test` dies with `STATUS_ENTRYPOINT_NOT_FOUND` before
/// running a single test. `rustc-link-arg` applies to binaries, cdylibs and test harnesses
/// alike, so the same manifest reaches all of them exactly once.
fn embed_app_manifest() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("windows") {
        return;
    }
    let out_dir = std::path::PathBuf::from(std::env::var("OUT_DIR").expect("OUT_DIR is set"));
    let manifest = out_dir.join("app.manifest");
    std::fs::write(&manifest, COMMON_CONTROLS_V6_MANIFEST).expect("write app manifest");
    println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
    println!("cargo:rustc-link-arg=/MANIFESTINPUT:{}", manifest.display());
}

/// Same content as tauri-build's default `windows-app-manifest.xml`.
const COMMON_CONTROLS_V6_MANIFEST: &str = r#"<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0">
  <dependency>
    <dependentAssembly>
      <assemblyIdentity
        type="win32"
        name="Microsoft.Windows.Common-Controls"
        version="6.0.0.0"
        processorArchitecture="*"
        publicKeyToken="6595b64144ccf1df"
        language="*"
      />
    </dependentAssembly>
  </dependency>
</assembly>
"#;
