//! Oriel's developer commands, the usual Rust `xtask`: run from `apps/oriel` as
//!
//! ```text
//! cargo run -p xtask -- <command> [options]
//! ```
//!
//! or through the package's pnpm scripts, which do the same:
//!
//! - `vendor [libvips] [libavif] [libavif-windows]`: fetches the prebuilt native libraries into
//!   `apps/oriel/.vendor/<name>/<id>/`, each pinned by URL and SHA-256, and Windows' libavif
//!   into `.vendor/libavif-windows`;
//! - `libmpv [--jobs N] [--work <dir>] [--out <dir>] [--keep-work]`: builds the LGPL libmpv
//!   from pinned sources into `apps/oriel/.libmpv/<id>/`;
//! - `bundle`: makes `target/release/bundle/Oriel.app`, with the libraries above, the pinned
//!   ffmpeg and ffprobe, the licence notices for all of them, and an ad hoc signature;
//! - `dmg [--app <Oriel.app>]`: makes the bundle (or takes one), then a compressed disk image
//!   laid out as Electron Oriel's: its background, icons and window, written without Finder;
//! - `package [windows]`: this system's installer, the DMG or Velopack's Setup.exe, or with
//!   `windows --stage-only` the folder Setup.exe installs, staged on any system;
//! - `measure <rows…> [--app <path>]… [--rounds N] [--out <dir>] [--fixture <dir>]`: takes Phase
//!   9's scorecard rows for one app, or several interleaved for an A/B (`measure/mod.rs`).
//!
//! They replace the Node scripts that did this, so the workspace's tooling is Rust (the owner's
//! decision of 2026-10-29). They drive the system's own tools (curl, tar, otool,
//! install_name_tool, codesign) by absolute path, as the scripts did.

mod bundle;
// hdiutil's disk image, for macOS only.
#[cfg(target_os = "macos")]
mod dmg;
// libavif and the DLLs it needs on Windows, from MSYS2.
mod libavif_windows;
mod libmpv;
// The scorecard's rows read the app through macOS's process APIs (`proc_pid_rusage`).
#[cfg(target_os = "macos")]
mod measure;
mod notices;
mod package;
mod support;
mod vendor;

use std::process::ExitCode;

const USAGE: &str = "usage: cargo run -p xtask -- <command>

commands:
  vendor [libvips] [libavif] [libavif-windows]
                               fetch the pinned prebuilt libraries into .vendor/ (the Mac's two
                               by default; on Windows, Windows' libavif)
  libmpv [--jobs N] [--work <dir>] [--out <dir>] [--keep-work]
                               build the LGPL libmpv from pinned sources into .libmpv/
  bundle                       make target/release/bundle/Oriel.app
  dmg [--app <Oriel.app>]      make the bundle (or take one), then Oriel-<version>-arm64.dmg
                               beside it
  package [windows [--stage-only] [--exe <oriel.exe>]]
                               this system's installer: the DMG, or Setup.exe through vpk
  measure <rows…> [--app <path>]… [--rounds N] [--out <dir>] [--fixture <dir>]
                               take the scorecard's rows (`measure --help` lists them)";

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let Some((command, rest)) = args.split_first() else {
        eprintln!("{USAGE}");
        return ExitCode::FAILURE;
    };
    let result = match command.as_str() {
        "vendor" => vendor::command(rest),
        "libmpv" => libmpv::command(rest),
        "bundle" => bundle::command(rest),
        "package" => package::command(rest),
        #[cfg(target_os = "macos")]
        "dmg" => dmg::command(rest),
        #[cfg(not(target_os = "macos"))]
        "dmg" => Err(anyhow::anyhow!("dmg runs on macOS only")),
        #[cfg(target_os = "macos")]
        "measure" => measure::command(rest),
        #[cfg(not(target_os = "macos"))]
        "measure" => Err(anyhow::anyhow!("measure runs on macOS only")),
        "help" | "--help" | "-h" => {
            println!("{USAGE}");
            Ok(())
        }
        other => {
            eprintln!("unknown command {other}\n\n{USAGE}");
            return ExitCode::FAILURE;
        }
    };
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("\nxtask {command} failed: {error:#}");
            ExitCode::FAILURE
        }
    }
}
