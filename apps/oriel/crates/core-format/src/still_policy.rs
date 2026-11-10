//! Which still or animated image becomes what, from `media-format`'s `still-policy.ts`. The
//! archive keeps stills as AVIF and animations as MP4.

use serde::{Deserialize, Serialize};

use crate::{get_file_extension, replace_file_extension};

/// What happens to a file on its way into the archive. The serde names are the TypeScript ones.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ArchiveMediaAction {
    ConvertAvif,
    ConvertMp4,
    RenameAvif,
    RenameMp4,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveMediaPlan {
    pub action: ArchiveMediaAction,
    pub file_name: String,
}

impl ArchiveMediaPlan {
    fn new(action: ArchiveMediaAction, file_name: &str, extension: &str) -> Self {
        Self {
            action,
            file_name: replace_file_extension(file_name, extension),
        }
    }
}

/// The image format a file's bytes are, which can differ from its extension. The serde names
/// are the TypeScript ones.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ArchiveImageFormat {
    Avif,
    Bmp,
    Gif,
    Jpeg,
    Png,
    Webp,
}

/// A still or animated image on disk, decoded at its boundary.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ArchiveImageSource<'a> {
    pub file_name: &'a str,
    pub format: ArchiveImageFormat,
    /// 1 for a still; more for an animated GIF, WebP or PNG.
    pub frame_count: u32,
}

/// Plans an image already on disk from its format and frame count: an animated GIF, WebP or PNG
/// becomes an MP4 and a single-frame one an AVIF, so animation is never flattened into a still. An
/// AVIF is only renamed, when its extension says otherwise; every other image converts, even one
/// already named `.avif`.
pub fn plan_archive_image(source: &ArchiveImageSource<'_>) -> Option<ArchiveMediaPlan> {
    let file_name = source.file_name;
    if source.format == ArchiveImageFormat::Avif {
        return (get_file_extension(file_name) != "avif")
            .then(|| ArchiveMediaPlan::new(ArchiveMediaAction::RenameAvif, file_name, "avif"));
    }
    let animated = source.frame_count > 1
        && !matches!(
            source.format,
            ArchiveImageFormat::Bmp | ArchiveImageFormat::Jpeg
        );
    Some(if animated {
        ArchiveMediaPlan::new(ArchiveMediaAction::ConvertMp4, file_name, "mp4")
    } else {
        ArchiveMediaPlan::new(ArchiveMediaAction::ConvertAvif, file_name, "avif")
    })
}
