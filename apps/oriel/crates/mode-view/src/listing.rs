//! The items the gallery shows and the viewer steps through, as View's scan finds them, and the
//! extensions View lists: the settings' lists (`media-domain`'s by default) and
//! [`EXTRA_IMAGE_EXTENSIONS`], kept out of the settings file.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use gpui_kit::SharedString;
use oriel_core_domain::{
    ComicMediaItem, EXTRA_IMAGE_EXTENSIONS, MEDIA_KEY_PREFIX, MediaType, NamedPath,
    SortableMediaItem, media_key,
};

use crate::catalog::CatalogFilters;
use crate::settings::FileFilterSettings;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum MediaKind {
    /// A still ImageIO decodes.
    Image,
    /// A GIF, which GPUI's own decoder animates.
    Gif,
    Video,
}

/// One file the gallery shows: where it is, what it is, and what its thumbnail is keyed by.
///
/// Clones share one allocation. The scan's items, their sorted order, the tiles, the thumbnail
/// queue and the viewer all hold every item, so a clone is a reference count and a listing of
/// 20,000 is a few hundred kilobytes of handles rather than a copy of each item per holder.
#[derive(Clone)]
pub struct MediaEntry(Arc<Entry>);

#[derive(Debug, PartialEq)]
struct Entry {
    /// The gallery tile's key, [`media_key`] of the id, made once for the item; the id is the
    /// rest of it.
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
    /// The item for the file at `path`, an absolute path, with its canonical `extension`, its
    /// `size` and its `fs.stat` `mtimeMs`.
    pub fn new(
        path: &Path,
        name: &str,
        extension: &str,
        kind: MediaKind,
        size: u64,
        modified_ms: f64,
    ) -> Self {
        let id = media_id(&path.to_string_lossy(), size, modified_ms);
        Self(Arc::new(Entry {
            key: media_key(&id).into(),
            path: Arc::from(path),
            name: SharedString::from(name),
            extension: SharedString::from(extension),
            kind,
            size,
            modified_ms,
        }))
    }

    /// [`media_id`].
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

    pub fn size(&self) -> u64 {
        self.0.size
    }

    /// The file's modification time as Node's `fs.Stats.mtimeMs` gives it: milliseconds since
    /// the epoch, with the nanoseconds as a fraction.
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

    /// The shared rules' two kinds: a GIF is an image.
    fn media_type(&self) -> MediaType {
        match self.0.kind {
            MediaKind::Video => MediaType::Video,
            MediaKind::Image | MediaKind::Gif => MediaType::Image,
        }
    }
}

/// What View knows a file by: `path:size:mtimeMs`, which changes when the file does. The gallery's
/// tiles, the viewer and the thumbnail cache key it.
pub fn media_id(path: &str, size: u64, mtime_ms: f64) -> String {
    format!("{path}:{size}:{mtime_ms}")
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

/// The folder itself, or the folder a file is in, with symlinks resolved; `None` for a path that
/// is not there.
pub fn resolve_folder_path(candidate: &Path) -> Option<PathBuf> {
    let metadata = fs::metadata(candidate).ok()?;
    let folder = if metadata.is_dir() {
        candidate.to_path_buf()
    } else if metadata.is_file() {
        candidate.parent()?.to_path_buf()
    } else {
        return None;
    };
    // Without the `\\?\` prefix std's `canonicalize` gives on Windows, which would change every
    // item's id.
    Some(oriel_runtime::paths::canonicalize(&folder).unwrap_or(folder))
}
