//! Which still or animated image becomes what, from `media-format`'s `still-policy.ts`. The
//! archive keeps stills as AVIF and animations as MP4.

use serde::{Deserialize, Serialize};

use crate::{get_file_extension, replace_file_extension};

const STILL_IMAGE_EXTENSIONS: [&str; 5] = ["bmp", "jpeg", "jpg", "png", "webp"];

/// What happens to a file on its way into the archive. The serde names are the TypeScript ones.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ArchiveMediaAction {
    ConvertAvif,
    ConvertMp4,
    RenameAvif,
    RenameMp4,
}

/// The action and the file name the result takes.
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

/// The name a file is expected to take in the archive, from its extension alone, or `None` when
/// it stays as it is.
pub fn get_expected_archive_target(file_name: &str) -> Option<String> {
    plan_from_extension(file_name).map(|plan| plan.file_name)
}

/// Plans a download from its name and the MIME type it was served with. The MIME type decides
/// when it names an image or video; its parameters, case and surrounding whitespace do not
/// count. SVG and unrecognized types fall back to the extension, and other video is left alone.
pub fn plan_archive_media(file_name: &str, mime_type: &str) -> Option<ArchiveMediaPlan> {
    let extension = get_file_extension(file_name);
    let lowercase = mime_type.to_lowercase();
    let essence = lowercase
        .split(';')
        .next()
        .unwrap_or_default()
        .trim_matches(is_javascript_whitespace);

    if essence == "image/avif" {
        return (extension != "avif")
            .then(|| ArchiveMediaPlan::new(ArchiveMediaAction::RenameAvif, file_name, "avif"));
    }
    if essence == "video/mp4" {
        return (extension != "mp4")
            .then(|| ArchiveMediaPlan::new(ArchiveMediaAction::RenameMp4, file_name, "mp4"));
    }
    if essence == "image/gif" {
        return Some(ArchiveMediaPlan::new(
            ArchiveMediaAction::ConvertMp4,
            file_name,
            "mp4",
        ));
    }
    if essence.starts_with("video/") {
        return None;
    }
    if essence.starts_with("image/") && essence != "image/svg+xml" {
        return Some(ArchiveMediaPlan::new(
            ArchiveMediaAction::ConvertAvif,
            file_name,
            "avif",
        ));
    }
    plan_from_extension(file_name)
}

fn plan_from_extension(file_name: &str) -> Option<ArchiveMediaPlan> {
    let extension = get_file_extension(file_name);
    if extension == "gif" {
        Some(ArchiveMediaPlan::new(
            ArchiveMediaAction::ConvertMp4,
            file_name,
            "mp4",
        ))
    } else if STILL_IMAGE_EXTENSIONS.contains(&extension.as_str()) {
        Some(ArchiveMediaPlan::new(
            ArchiveMediaAction::ConvertAvif,
            file_name,
            "avif",
        ))
    } else {
        None
    }
}

/// What `String.prototype.trim` removes: ECMAScript's white space and line terminators. Rust's
/// `trim` uses Unicode's `White_Space` instead, which adds U+0085 and leaves U+FEFF, so a MIME
/// type such as `"image/avif\u{85}"` would plan differently.
fn is_javascript_whitespace(character: char) -> bool {
    matches!(
        character,
        '\t' | '\n' | '\u{b}' | '\u{c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200a}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202f}'
                | '\u{205f}'
                | '\u{3000}'
                | '\u{feff}'
    )
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

/// Plans an image already on disk. Unlike [`plan_archive_media`], which sees only a download's
/// name and MIME type, this knows the frame count: an animated GIF, WebP or PNG becomes an MP4 and
/// a single-frame one an AVIF, so animation is never flattened into a still. An AVIF is only
/// renamed, when its extension says otherwise; every other image converts, even one already
/// named `.avif`.
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
