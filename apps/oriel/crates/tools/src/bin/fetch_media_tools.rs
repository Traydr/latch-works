//! Fetches this platform's pinned ffmpeg and ffprobe into the development cache,
//! `apps/oriel/.media-tools/<platform>`, or into the folder given as the one argument, which
//! is how packaging will stage them. Does nothing when the cache already holds the pin intact.
//!
//! `cargo run -p oriel-tools --bin fetch-media-tools [-- <cache folder>]`

use std::path::PathBuf;
use std::process::ExitCode;

use oriel_tools::{current_platform, dev_cache, ensure_media_tools, pin_for};

fn main() -> ExitCode {
    let cache = std::env::args_os()
        .nth(1)
        .map(PathBuf::from)
        .unwrap_or_else(dev_cache);
    let platform = current_platform();
    let Some(pin) = pin_for(&platform) else {
        eprintln!("No ffmpeg is pinned for {platform}.");
        return ExitCode::FAILURE;
    };

    eprintln!(
        "Checking ffmpeg {} for {platform} in {}",
        pin.version,
        cache.display()
    );
    match ensure_media_tools(&cache, pin) {
        Ok(fetched) => {
            let verb = if fetched.downloaded {
                "Fetched and verified"
            } else {
                "Already intact:"
            };
            eprintln!("{verb} {}", fetched.folder.display());
            ExitCode::SUCCESS
        }
        Err(error) => {
            eprintln!("Fetching ffmpeg failed: {error:#}");
            ExitCode::FAILURE
        }
    }
}
