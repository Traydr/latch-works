//! The clip an engine opens once before any video, so that the first video of a session does not
//! pay for what only the first file in a process pays: VideoToolbox's first decode (120 to
//! 135 ms on an M5 Pro), the first audio output (54 to 67 ms) and the renderer's first shaders
//! (about 30 ms).
//!
//! No clip ships with the app. The pinned ffmpeg makes it the first time it is needed, a quarter
//! of a second of black at 64 by 64 in H.264 with a silent AAC track, and it is kept in View's
//! data folder for every launch after. Without ffmpeg there is no clip, and engines start
//! unprimed, as they did before.

use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;

use oriel_core_paths::DataRoot;
use oriel_tools::{MediaTools, ToolRun};

/// Bumped whenever the recipe below changes, so a clip made by an older one is not played.
const VERSION: u32 = 1;
/// How long ffmpeg may take to make the clip.
const MAKE_TIMEOUT: Duration = Duration::from_secs(10);
/// The clip, or why there is none, once a first engine has asked.
static CLIP: Mutex<Option<Option<PathBuf>>> = Mutex::new(None);

/// The clip, made first if it is not on disk yet; `None` when it cannot be made. Called off
/// the UI thread: making it runs ffmpeg once, for a few hundred milliseconds.
pub(super) fn clip() -> Option<PathBuf> {
    let mut clip = CLIP.lock().unwrap_or_else(|p| p.into_inner());
    clip.get_or_insert_with(|| {
        find_or_make()
            .inspect_err(|why| log::info!("no clip to prime libmpv with: {why}"))
            .ok()
    })
    .clone()
}

fn find_or_make() -> Result<PathBuf, String> {
    let folder = DataRoot::from_environment()
        .map_err(|error| error.to_string())?
        .view()
        .join("cache");
    let path = folder.join(format!("video-prime-{VERSION}.mp4"));
    if path.is_file() {
        return Ok(path);
    }
    let tools = MediaTools::locate().map_err(|error| error.to_string())?;
    std::fs::create_dir_all(&folder).map_err(|error| error.to_string())?;
    // Made under another name and moved into place, so a clip cut short never plays.
    let partial = folder.join(format!("video-prime-{VERSION}.{}.mp4", std::process::id()));
    let made = ToolRun::new(tools.ffmpeg(), MAKE_TIMEOUT)
        .args(["-hide_banner", "-loglevel", "error", "-nostdin"])
        .args(["-f", "lavfi", "-i", "color=c=black:s=64x64:r=30:d=0.25"])
        .args(["-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo"])
        .args(["-t", "0.25", "-shortest", "-pix_fmt", "yuv420p"])
        .args(["-c:v", "libx264", "-c:a", "aac"])
        .args(["-movflags", "+faststart", "-y"])
        .arg(&partial)
        .run()
        .map_err(|error| error.to_string())?;
    if !made.success() {
        std::fs::remove_file(&partial).ok();
        return Err(format!(
            "ffmpeg exited with {:?}: {}",
            made.code(),
            made.stderr.trim()
        ));
    }
    std::fs::rename(&partial, &path).map_err(|error| error.to_string())?;
    Ok(path)
}
