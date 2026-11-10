//! The one way a file is converted, for Convert's changes and for its estimates alike: a still
//! to AVIF through libvips and libavif within the process's [`EncodeBudget`], or an animation or
//! a video through ffmpeg.

use std::path::Path;

use anyhow::{Context as _, anyhow};
use oriel_avif::Libavif;
use oriel_core_format::{AudioTrackPlan, VideoTrackPlan};
use oriel_runtime::Cancelled;
use oriel_tools::ToolError;

use super::still::encode_still_to_avif;
use super::transcode::{TranscodeJob, transcode_with_ffmpeg};
use crate::contract::VideoQuality;
use crate::passes::{Media, Progress};
use crate::plans::encode_budget::EncodeBudget;

/// What a conversion makes of its source.
#[derive(Clone, Copy, Debug)]
pub(crate) enum Conversion {
    /// A still to AVIF; `pixels` bounds the memory its encode reserves.
    Still {
        pixels: Option<u64>,
    },
    Animation,
    Video {
        video: VideoTrackPlan,
        audio: AudioTrackPlan,
        quality: VideoQuality,
    },
}

/// The pixels of a still the catalog measured, for [`Conversion::Still`].
pub(crate) fn pixels(width: Option<i64>, height: Option<i64>) -> Option<u64> {
    width
        .zip(height)
        .map(|(width, height)| (width.max(0) * height.max(0)) as u64)
}

/// What converting runs with.
pub(crate) struct Converter<'a> {
    pub media: &'a Media,
    pub libavif: Result<&'a Libavif, String>,
    pub budget: &'a EncodeBudget,
}

impl Converter<'_> {
    /// Converts `src` into `out`. A long ffmpeg run reports the seconds it has encoded to
    /// `on_seconds`. A stop kills the tool and fails with [`Cancelled`].
    pub(crate) fn convert(
        &self,
        conversion: Conversion,
        src: &Path,
        out: &Path,
        progress: &dyn Progress,
        on_seconds: &(dyn Fn(f64) + Send + Sync),
    ) -> anyhow::Result<()> {
        let job = match conversion {
            Conversion::Still { pixels } => {
                let vips = self
                    .media
                    .loaded_vips()
                    .context("libvips is unavailable, so stills cannot be converted.")?;
                let libavif = self.libavif.clone().map_err(|error| anyhow!(error))?;
                let _memory = self.budget.reserve(pixels, progress)?;
                encode_still_to_avif(vips, libavif, src, out)?;
                return Ok(());
            }
            Conversion::Animation => TranscodeJob::Animation { src, out },
            Conversion::Video {
                video,
                audio,
                quality,
            } => TranscodeJob::Video {
                src,
                out,
                video,
                audio,
                quality,
            },
        };
        let ffmpeg = self
            .media
            .ffmpeg
            .as_deref()
            .context("ffmpeg is unavailable, so the file cannot be converted.")?;
        transcode_with_ffmpeg(ffmpeg, &job, progress.cancel_token(), on_seconds).map_err(|error| {
            match error {
                ToolError::Cancelled => Cancelled.into(),
                error => anyhow!("{error}"),
            }
        })
    }
}
