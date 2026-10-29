//! Oriel RS's developer commands, the usual Rust `xtask`: run from `apps/oriel-rs` as
//!
//! ```text
//! cargo run -p xtask -- <command> [options]
//! ```
//!
//! or through the package's pnpm scripts, which do the same:
//!
//! - `vendor [libvips] [libavif]`: fetches the prebuilt native libraries into
//!   `apps/oriel-rs/.vendor/<name>/<id>/`, each pinned by URL and SHA-256;
//! - `libmpv [--jobs N] [--work <dir>] [--out <dir>] [--keep-work]`: builds the LGPL libmpv
//!   from pinned sources into `apps/oriel-rs/.libmpv/<id>/`;
//! - `bundle`: makes `target/release/bundle/Oriel RS.app`, with the libraries above, the pinned
//!   ffmpeg and ffprobe, and an ad hoc signature.
//!
//! They replace the Node scripts that did this, so the workspace's tooling is Rust (the owner's
//! decision of 2026-10-29). They drive the system's own tools (curl, tar, otool,
//! install_name_tool, codesign) by absolute path, as the scripts did.

mod bundle;
mod libmpv;
mod support;
mod vendor;

use std::process::ExitCode;

const USAGE: &str = "usage: cargo run -p xtask -- <command>

commands:
  vendor [libvips] [libavif]   fetch the pinned prebuilt libraries into .vendor/ (both by default)
  libmpv [--jobs N] [--work <dir>] [--out <dir>] [--keep-work]
                               build the LGPL libmpv from pinned sources into .libmpv/
  bundle                       make target/release/bundle/Oriel RS.app";

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
