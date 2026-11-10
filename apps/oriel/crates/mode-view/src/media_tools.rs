//! View's use of ffmpeg and ffprobe: a video's poster frame for its thumbnail, its facts for the
//! gallery's captions and the viewer's details, and the clip that primes the video engine.
//!
//! The tools are the pinned builds `oriel-tools` finds (never `PATH`). Without them a video
//! keeps its placeholder.

use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock, PoisonError};
use std::time::Duration;

use oriel_runtime::CancelToken;
use oriel_tools::{MediaTools, ToolError, ToolRun, VideoProbe};

use crate::listing::MediaEntry;

/// How many videos' facts are kept, the least recently read going first.
const PROBE_CACHE_ENTRIES: usize = 2000;

/// How long ffmpeg may take to make the prime clip.
const PRIME_CLIP_TIMEOUT: Duration = Duration::from_secs(10);

/// ffmpeg's arguments for the clip `oriel_media::video::prime` opens, all but the output: a
/// quarter of a second of black at 64 by 64 in H.264 with a silent AAC track, so the decoder, the
/// audio output and the renderer all start. No clip ships with the app.
const PRIME_CLIP_ARGS: [&str; 24] = [
    "-hide_banner",
    "-loglevel",
    "error",
    "-nostdin",
    "-f",
    "lavfi",
    "-i",
    "color=c=black:s=64x64:r=30:d=0.25",
    "-f",
    "lavfi",
    "-i",
    "anullsrc=r=44100:cl=stereo",
    "-t",
    "0.25",
    "-shortest",
    "-pix_fmt",
    "yuv420p",
    "-c:v",
    "libx264",
    "-c:a",
    "aac",
    "-movflags",
    "+faststart",
    "-y",
];

/// The prime clip's file name, named after its recipe, so a clip an older recipe made is not
/// played.
fn prime_clip_stem() -> String {
    let recipe = sha1_smol::Sha1::from(PRIME_CLIP_ARGS.join("\0"))
        .digest()
        .to_string();
    format!("video-prime-{}", &recipe[..12])
}

/// The videos' facts read so far, and the prime clip once asked for.
pub struct ViewMediaTools {
    probes: Mutex<ProbeCache>,
    prime_clip: Mutex<Option<Option<PathBuf>>>,
}

/// Facts by file, keyed by path, modification time and size, so a changed file is read again.
#[derive(Default)]
struct ProbeCache {
    entries: HashMap<String, VideoProbe>,
    order: VecDeque<String>,
}

impl ViewMediaTools {
    pub fn shared() -> Arc<Self> {
        static SHARED: OnceLock<Arc<ViewMediaTools>> = OnceLock::new();
        SHARED
            .get_or_init(|| {
                Arc::new(Self {
                    probes: Mutex::default(),
                    prime_clip: Mutex::default(),
                })
            })
            .clone()
    }

    /// The clip that primes the video engine (`oriel_media::video::prime`), kept in `cache`
    /// (`DataRoot::view_cache`) and made there first if it is not yet; `None` when it cannot be
    /// made. Blocks for the few hundred milliseconds ffmpeg takes, once per process.
    pub fn prime_clip(&self, cache: &Path) -> Option<PathBuf> {
        let mut clip = self
            .prime_clip
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        clip.get_or_insert_with(|| {
            make_prime_clip(cache)
                .inspect_err(|why| log::info!("no clip to prime libmpv with: {why}"))
                .ok()
        })
        .clone()
    }

    /// The video's poster frame as PNG bytes, or `None` when the tools are missing or read none.
    /// Blocks.
    pub fn poster_frame(
        &self,
        path: &Path,
        cancel: &CancelToken,
    ) -> Result<Option<Vec<u8>>, oriel_runtime::Cancelled> {
        let Ok(tools) = MediaTools::shared() else {
            return Ok(None);
        };
        match oriel_tools::poster_frame(tools.ffmpeg(), path, Some(cancel)) {
            Ok(png) => Ok(Some(png)),
            Err(ToolError::Cancelled) => Err(oriel_runtime::Cancelled),
            Err(failure) => {
                log::debug!("ffmpeg could not extract a frame: {failure}");
                Ok(None)
            }
        }
    }

    /// ffprobe's facts about `entry`, read once per version of the file. `None` without ffprobe
    /// or when it fails. Blocks.
    pub fn probe(&self, entry: &MediaEntry) -> Option<VideoProbe> {
        if let Some(probe) = self.cached_probe(entry) {
            return Some(probe);
        }
        let tools = MediaTools::shared().ok()?;
        let probe = oriel_tools::probe_video(tools.ffprobe(), entry.path(), None)
            .inspect_err(|failure| log::debug!("ffprobe could not read a video: {failure}"))
            .ok()?;
        let key = probe_key(entry);
        let mut cache = self.probes.lock().unwrap_or_else(PoisonError::into_inner);
        if cache.entries.len() >= PROBE_CACHE_ENTRIES
            && let Some(oldest) = cache.order.pop_front()
        {
            cache.entries.remove(&oldest);
        }
        cache.entries.insert(key.clone(), probe.clone());
        cache.order.push_back(key);
        Some(probe)
    }

    /// The facts [`Self::probe`] read about `entry`, if it has.
    pub fn cached_probe(&self, entry: &MediaEntry) -> Option<VideoProbe> {
        let key = probe_key(entry);
        let mut cache = self.probes.lock().unwrap_or_else(PoisonError::into_inner);
        let probe = cache.entries.get(&key).cloned()?;
        cache.order.retain(|known| known != &key);
        cache.order.push_back(key);
        Some(probe)
    }
}

fn probe_key(entry: &MediaEntry) -> String {
    format!(
        "{}|{}|{}",
        entry.path().display(),
        entry.modified_ms(),
        entry.size()
    )
}

fn make_prime_clip(cache: &Path) -> Result<PathBuf, String> {
    let stem = prime_clip_stem();
    let path = cache.join(format!("{stem}.mp4"));
    if path.is_file() {
        return Ok(path);
    }
    let tools = MediaTools::shared().map_err(ToString::to_string)?;
    std::fs::create_dir_all(cache).map_err(|error| error.to_string())?;
    // Made under another name and moved into place, so a clip cut short never plays.
    let partial = cache.join(format!("{stem}.{}.mp4", std::process::id()));
    let made = ToolRun::new(tools.ffmpeg(), PRIME_CLIP_TIMEOUT)
        .args(PRIME_CLIP_ARGS)
        .arg(&partial)
        .run()
        .map_err(|error| error.to_string())?;
    if !made.success() {
        if let Err(error) = std::fs::remove_file(&partial) {
            log::debug!("cannot remove {}: {error}", partial.display());
        }
        return Err(format!(
            "ffmpeg exited with {:?}: {}",
            made.code(),
            made.stderr.trim()
        ));
    }
    std::fs::rename(&partial, &path).map_err(|error| error.to_string())?;
    Ok(path)
}
