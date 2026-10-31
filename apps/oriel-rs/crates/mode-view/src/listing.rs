//! The items the gallery shows and the viewer steps through, made from View's scan
//! ([`oriel_core_index::CatalogItem`]), and the extensions View lists.
//!
//! The extension lists are Electron Oriel's settings (`media-domain`'s `ImageExtensions` and
//! `VideoExtensions` by default), plus HEIC and HEIF stills, which ImageIO decodes. Listing them is
//! an Oriel RS addition (the owner, 2026-10-29), kept here rather than in `oriel-core-domain`,
//! so the shared rules and their vectors stay as the TypeScript has them, and out of the
//! settings file, so Electron Oriel reads the same file it writes.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::UNIX_EPOCH;

use gpui_kit::SharedString;
use oriel_core_domain::{ComicMediaItem, MediaType, NamedPath, SortableMediaItem, compare_by_name};
use oriel_core_index::{CatalogFilters, CatalogItem, CatalogMediaType};

use crate::settings::FileFilterSettings;

/// The stills View lists beyond the settings' extensions: an Oriel RS addition.
pub const EXTRA_IMAGE_EXTENSIONS: [&str; 2] = ["heic", "heif"];

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum MediaKind {
    /// A still ImageIO decodes.
    Image,
    /// A GIF, which GPUI's own decoder animates.
    Gif,
    Video,
}

/// What every media tile's key starts with, before the item's id, as `media-domain`'s
/// `buildBrowserEntryCollection` keys it.
pub const MEDIA_KEY_PREFIX: &str = "media:";

/// One file the gallery shows: where it is, what it is, and what its thumbnail is keyed by.
///
/// Clones share one allocation. The scan's items, their sorted order, the tiles, the thumbnail
/// queue and the viewer all hold every item, so a clone is a reference count and a listing of
/// 20,000 is a few hundred kilobytes of handles rather than a copy of each item per holder.
#[derive(Clone)]
pub struct MediaEntry(Arc<Entry>);

#[derive(Debug, PartialEq)]
struct Entry {
    /// The gallery tile's key, [`MEDIA_KEY_PREFIX`] and the id, made once for the item; the id
    /// is the rest of it.
    key: SharedString,
    path: Arc<Path>,
    name: SharedString,
    extension: SharedString,
    kind: MediaKind,
    size: u64,
    modified_ms: f64,
}

impl PartialEq for MediaEntry {
    fn eq(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.0, &other.0) || self.0 == other.0
    }
}

impl std::fmt::Debug for MediaEntry {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.0.fmt(f)
    }
}

impl MediaEntry {
    pub fn new(path: impl Into<Arc<Path>>, kind: MediaKind, size: u64, modified_ms: f64) -> Self {
        let path = path.into();
        let name = path
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default();
        let extension = oriel_core_domain::get_extension(&name);
        Self(Arc::new(Entry {
            key: format!("{MEDIA_KEY_PREFIX}{}:{size}:{modified_ms}", path.display()).into(),
            path,
            name: name.into(),
            extension: extension.into(),
            kind,
            size,
            modified_ms,
        }))
    }

    /// The gallery's item for a file the scan found.
    pub fn from_catalog(item: &CatalogItem) -> Self {
        let kind = match item.media_type {
            CatalogMediaType::Video => MediaKind::Video,
            CatalogMediaType::Image if item.extension == "gif" => MediaKind::Gif,
            CatalogMediaType::Image => MediaKind::Image,
        };
        Self(Arc::new(Entry {
            key: format!("{MEDIA_KEY_PREFIX}{}", item.id).into(),
            path: Arc::from(Path::new(&item.path)),
            name: SharedString::from(item.name.as_str()),
            extension: SharedString::from(item.extension.as_str()),
            kind,
            size: item.size,
            modified_ms: item.mtime_ms,
        }))
    }

    /// `path:size:mtimeMs`, which changes when the file does.
    pub fn id(&self) -> &str {
        &self.0.key[MEDIA_KEY_PREFIX.len()..]
    }

    /// The item's gallery tile key, `media:` and the id. The thumbnails and the video facts are
    /// kept by it, since it is as unique as the id and already made.
    pub fn key(&self) -> &SharedString {
        &self.0.key
    }

    pub fn path(&self) -> &Arc<Path> {
        &self.0.path
    }

    /// The file's name, which the gallery sorts by and the viewer titles itself with.
    pub fn name(&self) -> &SharedString {
        &self.0.name
    }

    /// The canonical extension, lowercased (`jpeg` reads `jpg`).
    pub fn extension(&self) -> &SharedString {
        &self.0.extension
    }

    pub fn kind(&self) -> MediaKind {
        self.0.kind
    }

    pub fn is_video(&self) -> bool {
        self.0.kind == MediaKind::Video
    }

    /// The file's size in bytes.
    pub fn size(&self) -> u64 {
        self.0.size
    }

    /// The file's modification time as Node's `fs.Stats.mtimeMs` gives it: milliseconds since
    /// the epoch, with the nanoseconds as a fraction. Electron Oriel keys thumbnails by it.
    pub fn modified_ms(&self) -> f64 {
        self.0.modified_ms
    }
}

impl NamedPath for MediaEntry {
    fn name(&self) -> &str {
        &self.0.name
    }

    /// The path as text, as the TypeScript compares it. macOS file names are UTF-8, so the
    /// empty fallback is for a path no Mac volume makes.
    fn path(&self) -> &str {
        self.0.path.to_str().unwrap_or_default()
    }
}

impl SortableMediaItem for MediaEntry {
    fn mtime_ms(&self) -> f64 {
        self.0.modified_ms
    }
}

impl ComicMediaItem for MediaEntry {
    fn id(&self) -> &str {
        MediaEntry::id(self)
    }

    /// View's two kinds, as its `MediaItem` has them: a GIF is an image.
    fn media_type(&self) -> MediaType {
        match self.0.kind {
            MediaKind::Video => MediaType::Video,
            MediaKind::Image | MediaKind::Gif => MediaType::Image,
        }
    }
}

/// What a file name is to the gallery under the default lists, by its extension: for tests and
/// callers without settings.
pub fn media_kind(file_name: &str) -> Option<MediaKind> {
    let extension = oriel_core_domain::get_extension(file_name);
    if extension == "gif" {
        Some(MediaKind::Gif)
    } else if oriel_core_domain::IMAGE_EXTENSIONS.contains(&extension.as_str())
        || EXTRA_IMAGE_EXTENSIONS.contains(&extension.as_str())
    {
        Some(MediaKind::Image)
    } else if oriel_core_domain::VIDEO_EXTENSIONS.contains(&extension.as_str()) {
        Some(MediaKind::Video)
    } else {
        None
    }
}

/// The scan's filters for View's settings, with HEIC and HEIF added to the stills.
pub fn scan_filters(filters: &FileFilterSettings) -> CatalogFilters {
    let mut image_extensions: std::collections::HashSet<String> =
        filters.image_extensions.iter().cloned().collect();
    image_extensions.extend(EXTRA_IMAGE_EXTENSIONS.map(String::from));
    CatalogFilters {
        image_extensions,
        video_extensions: filters.video_extensions.iter().cloned().collect(),
        show_images: filters.show_images,
        show_videos: filters.show_videos,
    }
}

/// Node's `mtimeMs`: whole seconds in milliseconds plus the nanoseconds as a fraction, in that
/// order, so the same file gives the same float and so the same thumbnail key.
pub fn modified_ms(metadata: &fs::Metadata) -> f64 {
    metadata
        .modified()
        .ok()
        .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
        .map(|since| since.as_secs() as f64 * 1e3 + f64::from(since.subsec_nanos()) / 1e6)
        .unwrap_or(0.0)
}

/// `media-domain`'s `name-asc`, through `oriel-core-domain`: natural order by name (numeric, base
/// strength, as `Intl.Collator` compares), then by path for names that tie.
pub fn sort_by_name(entries: &mut [MediaEntry]) {
    entries.sort_by(compare_by_name::<MediaEntry>);
}

/// `resolveFolderPath`: the folder itself, or the folder a file is in, with symlinks resolved;
/// `None` for a path that is not there.
pub fn resolve_folder_path(candidate: &Path) -> Option<PathBuf> {
    let metadata = fs::metadata(candidate).ok()?;
    let folder = if metadata.is_dir() {
        candidate.to_path_buf()
    } else if metadata.is_file() {
        candidate.parent()?.to_path_buf()
    } else {
        return None;
    };
    // Node's `realpath`, without the `\\?\` prefix std's `canonicalize` gives on Windows, so the
    // thumbnail keys (which hold the path) are Electron Oriel's.
    Some(oriel_runtime::paths::canonicalize(&folder).unwrap_or(folder))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_by_extension_with_heic_added() {
        assert_eq!(media_kind("a.AVIF"), Some(MediaKind::Image));
        assert_eq!(media_kind("a.jpeg"), Some(MediaKind::Image));
        assert_eq!(media_kind("a.gif"), Some(MediaKind::Gif));
        assert_eq!(media_kind("clip.M4V"), Some(MediaKind::Video));
        assert_eq!(media_kind("photo.HEIC"), Some(MediaKind::Image));
        assert_eq!(media_kind("scan.pdf"), None);
        assert_eq!(media_kind("jpg"), None);
    }

    #[test]
    fn the_scan_lists_heic_beside_the_settings_extensions() {
        let filters = scan_filters(&crate::settings::ViewSettings::default().filters);
        assert!(filters.image_extensions.contains("heic"));
        assert!(filters.image_extensions.contains("avif"));
        assert!(filters.video_extensions.contains("m4v"));
    }

    #[test]
    fn sorts_in_the_shared_natural_order() {
        let mut entries: Vec<MediaEntry> = ["img-10.jpg", "B.jpg", "img-2.jpg", "a.jpg"]
            .map(|name| MediaEntry::new(Path::new("/r").join(name), MediaKind::Image, 1, 0.0))
            .to_vec();
        sort_by_name(&mut entries);
        let names: Vec<&str> = entries.iter().map(|entry| entry.name().as_ref()).collect();
        assert_eq!(names, ["a.jpg", "B.jpg", "img-2.jpg", "img-10.jpg"]);
    }

    #[test]
    fn ids_follow_the_catalogs() {
        let item = CatalogItem::new(
            "/r/a.gif".into(),
            "a.gif".into(),
            "gif".into(),
            CatalogMediaType::Image,
            12,
            1_730_000_000_123.5,
        );
        let entry = MediaEntry::from_catalog(&item);
        assert_eq!(entry.kind(), MediaKind::Gif);
        assert_eq!(entry.id(), item.id);
        assert_eq!(entry.key().as_ref(), format!("media:{}", item.id));
        assert_eq!(
            MediaEntry::new(
                Path::new("/r/a.gif"),
                MediaKind::Gif,
                12,
                1_730_000_000_123.5
            )
            .id(),
            entry.id()
        );
    }
}
