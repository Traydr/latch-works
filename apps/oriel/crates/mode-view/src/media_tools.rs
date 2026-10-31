//! View's use of ffmpeg and ffprobe, ported from Electron Oriel's `mediaToolsService.ts`: a
//! video's poster frame for its thumbnail, and its duration, size and codec for the viewer.
//!
//! The tools are the pinned builds `oriel-tools` finds (never `PATH`), run with Electron Oriel's
//! arguments and its 12 s timeout. Without them a video keeps its placeholder, as it does in an
//! Electron Oriel build without ffmpeg.

use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock, PoisonError};
use std::time::Duration;

use oriel_runtime::CancelToken;
use oriel_tools::{MediaTools, ToolRun, ToolSource};
use serde::Deserialize;

/// `DEFAULT_TIMEOUT_MS`.
const TIMEOUT: Duration = Duration::from_secs(12);

/// `MAX_PROBE_CACHE_ENTRIES`.
const PROBE_CACHE_ENTRIES: usize = 2000;

/// What View knows of its tools, for Settings › Storage and Diagnostics.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MediaToolsStatus {
    pub ffmpeg_path: Option<PathBuf>,
    pub ffprobe_path: Option<PathBuf>,
    /// Where they were found, or why they were not.
    pub source: Result<ToolSource, String>,
}

impl MediaToolsStatus {
    pub fn available(&self) -> bool {
        self.source.is_ok()
    }
}

/// A video's facts from ffprobe: `VideoProbeMetadataSchema`.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct VideoProbe {
    pub duration_ms: Option<u64>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub codec: Option<String>,
}

#[derive(Deserialize)]
struct ProbeOutput {
    #[serde(default)]
    streams: Vec<ProbeStream>,
    format: Option<ProbeFormat>,
}

#[derive(Deserialize)]
struct ProbeStream {
    codec_type: Option<String>,
    codec_name: Option<String>,
    width: Option<u32>,
    height: Option<u32>,
    duration: Option<String>,
}

#[derive(Deserialize)]
struct ProbeFormat {
    duration: Option<String>,
}

/// The tools, found once per process, and the probes made.
pub struct ViewMediaTools {
    tools: Result<MediaTools, String>,
    probes: Mutex<ProbeCache>,
}

#[derive(Default)]
struct ProbeCache {
    entries: HashMap<String, VideoProbe>,
    order: VecDeque<String>,
}

impl ViewMediaTools {
    /// The process's tools, found on first use.
    pub fn shared() -> Arc<Self> {
        static SHARED: OnceLock<Arc<ViewMediaTools>> = OnceLock::new();
        SHARED
            .get_or_init(|| {
                Arc::new(Self {
                    tools: MediaTools::locate().map_err(|error| error.to_string()),
                    probes: Mutex::default(),
                })
            })
            .clone()
    }

    pub fn status(&self) -> MediaToolsStatus {
        match &self.tools {
            Ok(tools) => MediaToolsStatus {
                ffmpeg_path: Some(tools.ffmpeg().to_path_buf()),
                ffprobe_path: Some(tools.ffprobe().to_path_buf()),
                source: Ok(tools.source()),
            },
            Err(error) => MediaToolsStatus {
                ffmpeg_path: None,
                ffprobe_path: None,
                source: Err(error.clone()),
            },
        }
    }

    /// `extractVideoFrame`: one frame as PNG bytes, a second in, or the first frame of a video
    /// shorter than that. `None` when ffmpeg is missing or reads neither. Blocks.
    pub fn extract_video_frame(
        &self,
        path: &Path,
        cancel: &CancelToken,
    ) -> Result<Option<Vec<u8>>, oriel_runtime::Cancelled> {
        let Ok(tools) = &self.tools else {
            return Ok(None);
        };
        let mut last_failure = String::new();
        for start in ["00:00:01", "00:00:00"] {
            let output = ToolRun::new(tools.ffmpeg(), TIMEOUT)
                .args(["-hide_banner", "-loglevel", "error", "-ss", start, "-i"])
                .arg(path)
                .args([
                    "-frames:v",
                    "1",
                    "-f",
                    "image2pipe",
                    "-vcodec",
                    "png",
                    "pipe:1",
                ])
                .cancel_on(cancel)
                .run();
            match output {
                Ok(output) if output.success() && !output.stdout.is_empty() => {
                    return Ok(Some(output.stdout));
                }
                Ok(output) => {
                    if !output.stderr.trim().is_empty() {
                        last_failure = output.stderr.trim().to_owned();
                    }
                }
                Err(error) if error.is_cancelled() => return Err(oriel_runtime::Cancelled),
                Err(error) => last_failure = error.to_string(),
            }
        }
        if !last_failure.is_empty() {
            log::debug!("ffmpeg could not extract a frame: {last_failure}");
        }
        Ok(None)
    }

    /// `probeVideo`: the video stream's codec and size, and the stream's duration or else the
    /// container's, cached by path, time and size. `None` without ffprobe or when it fails.
    pub fn probe_video(&self, path: &Path, mtime_ms: f64, size: u64) -> Option<VideoProbe> {
        let tools = self.tools.as_ref().ok()?;
        let key = format!("{}|{mtime_ms}|{size}", path.display());
        {
            let mut cache = self.probes.lock().unwrap_or_else(PoisonError::into_inner);
            if let Some(probe) = cache.entries.get(&key).cloned() {
                cache.order.retain(|known| known != &key);
                cache.order.push_back(key);
                return Some(probe);
            }
        }

        let output = ToolRun::new(tools.ffprobe(), TIMEOUT)
            .args([
                "-v",
                "error",
                "-print_format",
                "json",
                "-show_streams",
                "-show_format",
            ])
            .arg(path)
            .run()
            .ok()
            .filter(|output| output.code() == Some(0))?;
        let probe = parse_probe(&output.stdout)?;

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
}

/// Reads ffprobe's JSON as `probeVideo` does: the first video stream, the stream's duration if
/// it is a number and else the container's, rounded to whole milliseconds.
pub fn parse_probe(stdout: &[u8]) -> Option<VideoProbe> {
    let parsed: ProbeOutput = serde_json::from_slice(stdout).ok()?;
    let video = parsed
        .streams
        .iter()
        .find(|stream| stream.codec_type.as_deref() == Some("video"));
    let seconds = |value: Option<&String>| {
        value
            .and_then(|value| value.trim().parse::<f64>().ok())
            .filter(|seconds| seconds.is_finite())
    };
    let duration = seconds(video.and_then(|video| video.duration.as_ref())).or_else(|| {
        seconds(
            parsed
                .format
                .as_ref()
                .and_then(|format| format.duration.as_ref()),
        )
    });
    Some(VideoProbe {
        duration_ms: duration.map(|seconds| (seconds * 1000.).round().max(0.) as u64),
        width: video.and_then(|video| video.width),
        height: video.and_then(|video| video.height),
        codec: video.and_then(|video| video.codec_name.clone()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_video_stream_and_falls_back_to_the_container() {
        let probe = parse_probe(
            br#"{"streams":[{"codec_type":"audio","codec_name":"aac","duration":"9.0"},
            {"codec_type":"video","codec_name":"h264","width":1920,"height":1080,"duration":"4.0006"}],
            "format":{"duration":"9.1"}}"#,
        )
        .unwrap();
        assert_eq!(
            probe,
            VideoProbe {
                duration_ms: Some(4001),
                width: Some(1920),
                height: Some(1080),
                codec: Some("h264".into()),
            }
        );
        // MKV streams carry no duration of their own; the container's stands in.
        let mkv = parse_probe(
            br#"{"streams":[{"codec_type":"video","codec_name":"av1","width":640,"height":360}],
            "format":{"duration":"12.5"}}"#,
        )
        .unwrap();
        assert_eq!(mkv.duration_ms, Some(12_500));
        assert_eq!(parse_probe(b"not json"), None);
    }
}
