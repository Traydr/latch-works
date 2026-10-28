//! ffmpeg and ffprobe for Oriel GPUI. They stay separate programs, run as child processes, as in
//! Electron Oriel:
//!
//! - [`PINS`]: the builds Electron Oriel pins, by the same URLs and hashes;
//! - [`ensure_media_tools`]: fetches a pin into a cache folder, for development and packaging
//!   (`cargo run -p oriel-tools --bin fetch-media-tools`);
//! - [`MediaTools::locate`]: finds the binaries at run time, never on `PATH`;
//! - [`ToolRun`]: runs one, with a timeout, a kill on cancel and bounded output.

mod fetch;
mod locate;
mod pins;
mod run;

pub use fetch::{FETCH_COMMAND, Fetched, dev_cache, ensure_media_tools};
pub use locate::{LocateError, MediaTools, OVERRIDE_VARIABLE, ToolSource};
pub use pins::{MediaToolsPin, PINS, PinnedArchive, current_platform, pin_for, tool_files};
pub use run::{
    MAX_STDERR_BYTES, MAX_STDOUT_BYTES, ToolError, ToolOutput, ToolRun, kill_running_tools,
};
