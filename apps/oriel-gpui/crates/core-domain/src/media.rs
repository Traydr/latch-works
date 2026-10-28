//! The media types from `media-domain`'s `media.ts`: kinds, extensions, sort modes, and the item
//! and folder records the gallery shows.

use serde::{Deserialize, Serialize};

use crate::{NamedPath, SortableMediaItem, canonicalize_extension, comics::ComicMediaItem};

/// The still and animated image extensions the gallery lists. HEIC is not one, though ImageIO
/// decodes it: View lists what Electron Oriel lists, and `media.ts` does not list HEIC.
pub const IMAGE_EXTENSIONS: [&str; 7] = ["jpg", "jpeg", "png", "webp", "gif", "bmp", "avif"];

/// The video extensions the gallery lists.
pub const VIDEO_EXTENSIONS: [&str; 5] = ["mp4", "webm", "mov", "mkv", "m4v"];

/// The document extensions the gallery lists.
pub const PDF_EXTENSIONS: [&str; 1] = ["pdf"];

/// What kind of media a file is, by its extension. The serde names are the TypeScript ones,
/// which View's index and Pane View's API carry.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MediaType {
    Image,
    Gif,
    Video,
    Pdf,
    Unknown,
}

impl MediaType {
    /// Every kind, in the order `MediaTypeSchema` lists them.
    pub const ALL: [Self; 5] = [
        Self::Image,
        Self::Gif,
        Self::Video,
        Self::Pdf,
        Self::Unknown,
    ];
}

/// How the gallery orders its items. The serde names are the TypeScript ones, which View's
/// settings file stores.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum GallerySortMode {
    NameAsc,
    NameDesc,
    DateNewest,
    DateOldest,
    Random,
}

impl GallerySortMode {
    /// Every mode, in the order `GallerySortModeSchema` lists them.
    pub const ALL: [Self; 5] = [
        Self::NameAsc,
        Self::NameDesc,
        Self::DateNewest,
        Self::DateOldest,
        Self::Random,
    ];
}

/// One file the gallery shows, as `MediaItemSchema` describes it.
///
/// The schema's checks (whole, non-negative sizes; positive dimensions) are carried by the field
/// types where Rust has one; a value parsed from JSON is not checked further.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaItem {
    pub id: String,
    pub path: String,
    pub parent_path: String,
    pub name: String,
    pub extension: String,
    pub media_type: MediaType,
    pub size: u64,
    /// Milliseconds since the epoch, with a fraction, as `fs.stat`'s `mtimeMs` gives it.
    pub mtime_ms: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sha256: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub width: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub height: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub page_count: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thumbnail_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub original_url: Option<String>,
}

impl NamedPath for MediaItem {
    fn name(&self) -> &str {
        &self.name
    }

    fn path(&self) -> &str {
        &self.path
    }
}

impl SortableMediaItem for MediaItem {
    fn mtime_ms(&self) -> f64 {
        self.mtime_ms
    }
}

impl ComicMediaItem for MediaItem {
    fn id(&self) -> &str {
        &self.id
    }

    fn media_type(&self) -> MediaType {
        self.media_type
    }
}

/// A folder the gallery shows, as `FolderNodeSchema` describes it. `parent_id` is absent or null
/// alike in the TypeScript, so one `None` stands for both.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderNode {
    pub path: String,
    pub parent_path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_id: Option<String>,
    pub name: String,
    pub has_children: bool,
}

/// The canonical extension after the last dot, or `""` when there is none or it ends the name.
///
/// The last dot is found in the whole string, so a dotfile has an extension (`.jpg` is a JPEG)
/// and a dot in a folder's name counts when the file has none (`dir.mp4/file` gives `mp4/file`).
/// `media-format`'s `get_file_extension` reads only the last segment and skips dotfiles; the two
/// differ in the TypeScript too.
pub fn get_extension(file_name: &str) -> String {
    match file_name.rfind('.') {
        // The dot is one byte, so `dot + 1` is the next character's start.
        Some(dot) if dot + 1 < file_name.len() => canonicalize_extension(&file_name[dot + 1..]),
        _ => String::new(),
    }
}

/// The kind of media a file is, by its extension alone.
pub fn detect_media_type(file_name: &str) -> MediaType {
    let extension = get_extension(file_name);
    let extension = extension.as_str();

    if extension == "gif" {
        MediaType::Gif
    } else if IMAGE_EXTENSIONS.contains(&extension) {
        MediaType::Image
    } else if VIDEO_EXTENSIONS.contains(&extension) {
        MediaType::Video
    } else if PDF_EXTENSIONS.contains(&extension) {
        MediaType::Pdf
    } else {
        MediaType::Unknown
    }
}

/// Whether the gallery shows a file of this name.
pub fn is_supported_media_file(file_name: &str) -> bool {
    detect_media_type(file_name) != MediaType::Unknown
}
