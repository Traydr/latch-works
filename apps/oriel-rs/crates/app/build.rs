//! The Windows executable's icon and version information, which Explorer, the taskbar and its
//! shortcuts show, and from which GPUI loads the window's icon (resource 1). The icon is Electron
//! Oriel's `oriel-icon.ico`, the same artwork the Mac bundle takes from `oriel-icon.icns`, with
//! every size from 16 to 256 pixels in it. Elsewhere this does nothing.

use std::env;
use std::fs;
use std::path::PathBuf;

fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    if env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("windows") {
        return;
    }
    let manifest = PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").expect("cargo sets it"));
    let icon = manifest.join("../../../oriel/media/oriel-icon.ico");
    println!("cargo:rerun-if-changed={}", icon.display());
    let icon = icon
        .canonicalize()
        .expect("apps/oriel/media/oriel-icon.ico is in the repository");

    let version = env::var("CARGO_PKG_VERSION").expect("cargo sets it");
    let mut parts = version
        .split(['.', '-', '+'])
        .map(|part| part.parse::<u16>().unwrap_or(0));
    let mut next = || parts.next().unwrap_or(0);
    let numeric = format!("{},{},{},0", next(), next(), next());

    // The resource compiler reads a path in quotes with C escapes; forward slashes need none.
    let icon_path = icon.to_string_lossy().replace('\\', "/");
    let script = format!(
        r#"1 ICON "{icon_path}"

1 VERSIONINFO
FILEVERSION {numeric}
PRODUCTVERSION {numeric}
FILEFLAGSMASK 0x3f
FILEFLAGS 0x0
FILEOS 0x40004
FILETYPE 0x1
FILESUBTYPE 0x0
BEGIN
  BLOCK "StringFileInfo"
  BEGIN
    BLOCK "040904b0"
    BEGIN
      VALUE "CompanyName", "Traydr"
      VALUE "FileDescription", "Oriel RS"
      VALUE "FileVersion", "{version}"
      VALUE "InternalName", "oriel-rs"
      VALUE "OriginalFilename", "oriel-rs.exe"
      VALUE "ProductName", "Oriel RS"
      VALUE "ProductVersion", "{version}"
    END
  END
  BLOCK "VarFileInfo"
  BEGIN
    VALUE "Translation", 0x409, 1200
  END
END
"#
    );
    let out = PathBuf::from(env::var_os("OUT_DIR").expect("cargo sets it")).join("oriel-rs.rc");
    fs::write(&out, script).expect("OUT_DIR is writable");
    embed_resource::compile(&out, embed_resource::NONE)
        .manifest_optional()
        .expect("the icon and version resource compiles");
}
