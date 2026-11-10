//! ffmpeg and ffprobe for Oriel. They stay separate programs, run as child processes:
//!
//! - [`MediaTools::locate`]: finds the pinned builds at run time, never on `PATH` (xtask's
//!   `fetch-media-tools` fetches them for development, and its `bundle` and `package` pack them),
//!   and [`MediaTools::shared`] the process's, found once;
//! - [`ToolRun`]: runs one, with a timeout, a kill on cancel and bounded output;
//! - [`probe_video`] and [`poster_frame`]: what the modes read of a video.

mod facts;
mod locate;
mod run;

pub use facts::{VideoProbe, parse_video_probe, poster_frame, probe_video};
pub use locate::{LocateError, MediaTools};
pub use run::{
    MAX_STDERR_BYTES, MAX_STDOUT_BYTES, ToolError, ToolOutput, ToolRun, kill_running_tools,
    running_tools, spawn,
};
