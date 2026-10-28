//! A folder's media, listed recursively in the shared ordering rules: what the gallery shows and
//! the viewer steps through.
//!
//! The rules are `media-domain`'s (`media.ts`, `system-files.ts`, `sort.ts`): the same image and
//! video extensions, the same system folders and junk files skipped, and symlinks never followed,
//! as View's scan in Electron Oriel does.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::UNIX_EPOCH;

use gpui_kit::SharedString;
use oriel_core_domain::{NamedPath, compare_by_name};

/// `media-domain`'s `ImageExtensions`, `gif` included; `detectMediaType` calls `gif` its own type.
const IMAGE_EXTENSIONS: [&str; 7] = ["jpg", "jpeg", "png", "webp", "gif", "bmp", "avif"];

/// `media-domain`'s `VideoExtensions`.
const VIDEO_EXTENSIONS: [&str; 5] = ["mp4", "webm", "mov", "mkv", "m4v"];

/// `media-domain`'s `SYSTEM_JUNK_FILE_NAMES`, compared in lower case.
const JUNK_FILE_NAMES: [&str; 5] = [
    ".ds_store",
    "desktop.ini",
    "ehthumbs.db",
    "ehthumbs_vista.db",
    "thumbs.db",
];

/// `media-domain`'s `SYSTEM_JUNK_DIRECTORY_NAMES`, compared in lower case. `.latch-works` is
/// where every Latch Works app keeps its data, Oriel GPUI's thumbnails included.
const JUNK_DIRECTORY_NAMES: [&str; 10] = [
    ".latch-works",
    ".glazier-holding",
    "$recycle.bin",
    ".documentrevisions-v100",
    ".fseventsd",
    ".spotlight-v100",
    ".temporaryitems",
    ".trashes",
    "__macosx",
    "system volume information",
];

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum MediaKind {
    /// A still ImageIO decodes.
    Image,
    /// A GIF, which GPUI's own decoder animates.
    Gif,
    Video,
}

/// One file the gallery shows: where it is, what it is, and what its thumbnail is keyed by.
#[derive(Clone, Debug, PartialEq)]
pub struct MediaEntry {
    path: Arc<Path>,
    name: SharedString,
    kind: MediaKind,
    size: u64,
    modified_ms: f64,
}

impl MediaEntry {
    pub fn new(path: impl Into<Arc<Path>>, kind: MediaKind, size: u64, modified_ms: f64) -> Self {
        let path = path.into();
        let name = path
            .file_name()
            .map(|name| SharedString::from(name.to_string_lossy().into_owned()))
            .unwrap_or_default();
        Self {
            path,
            name,
            kind,
            size,
            modified_ms,
        }
    }

    pub fn path(&self) -> &Arc<Path> {
        &self.path
    }

    /// The file's name, which the gallery sorts by and the viewer titles itself with.
    pub fn name(&self) -> &SharedString {
        &self.name
    }

    pub fn kind(&self) -> MediaKind {
        self.kind
    }

    pub fn is_video(&self) -> bool {
        self.kind == MediaKind::Video
    }

    /// The file's size in bytes.
    pub fn size(&self) -> u64 {
        self.size
    }

    /// The file's modification time as Node's `fs.Stats.mtimeMs` gives it: milliseconds since
    /// the epoch, with the nanoseconds as a fraction. Electron Oriel keys thumbnails by it.
    pub fn modified_ms(&self) -> f64 {
        self.modified_ms
    }
}

/// What a file name is to the gallery, by its extension as `detectMediaType` reads it.
pub fn media_kind(file_name: &str) -> Option<MediaKind> {
    let (_, extension) = file_name.rsplit_once('.')?;
    let extension = extension.to_ascii_lowercase();
    if extension == "gif" {
        Some(MediaKind::Gif)
    } else if IMAGE_EXTENSIONS.contains(&extension.as_str()) {
        Some(MediaKind::Image)
    } else if VIDEO_EXTENSIONS.contains(&extension.as_str()) {
        Some(MediaKind::Video)
    } else {
        None
    }
}

fn is_junk_file(name: &str) -> bool {
    name.starts_with("._") || JUNK_FILE_NAMES.contains(&name.to_lowercase().as_str())
}

fn is_junk_directory(name: &str) -> bool {
    JUNK_DIRECTORY_NAMES.contains(&name.to_lowercase().as_str())
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

/// Every media file under `root`, sorted by name. Blocks on the file system, so run it on the
/// background executor. A folder that cannot be read is skipped, as Electron Oriel's scan skips
/// it; only an unreadable `root` is an error.
pub fn list_media(root: &Path) -> io::Result<Vec<MediaEntry>> {
    let mut entries = Vec::new();
    let mut folders: Vec<PathBuf> = vec![root.to_path_buf()];
    let mut first = true;
    while let Some(folder) = folders.pop() {
        let reader = match fs::read_dir(&folder) {
            Ok(reader) => reader,
            Err(error) if first => return Err(error),
            Err(_) => continue,
        };
        first = false;
        for item in reader.flatten() {
            // `DirEntry::file_type` does not follow a symlink, so a link is neither a file nor
            // a folder here and is left out, as `media-index`'s scan leaves it.
            let Ok(file_type) = item.file_type() else {
                continue;
            };
            let name = item.file_name();
            let name = name.to_string_lossy();
            if file_type.is_dir() {
                if !is_junk_directory(&name) {
                    folders.push(item.path());
                }
            } else if file_type.is_file()
                && !is_junk_file(&name)
                && let Some(kind) = media_kind(&name)
                && let Ok(metadata) = item.metadata()
            {
                entries.push(MediaEntry::new(
                    item.path(),
                    kind,
                    metadata.len(),
                    modified_ms(&metadata),
                ));
            }
        }
    }
    sort_by_name(&mut entries);
    Ok(entries)
}

/// `media-domain`'s `name-asc`, through `oriel-core-domain`: natural order by name (numeric, base
/// strength, as `Intl.Collator` compares), then by path for names that tie.
pub fn sort_by_name(entries: &mut [MediaEntry]) {
    entries.sort_by(compare_by_name::<MediaEntry>);
}

impl NamedPath for MediaEntry {
    fn name(&self) -> &str {
        &self.name
    }

    /// The path as text, as the TypeScript compares it. macOS file names are UTF-8, so the
    /// empty fallback is for a path no Mac volume makes.
    fn path(&self) -> &str {
        self.path.to_str().unwrap_or_default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(test: &str) -> PathBuf {
        let folder = std::env::temp_dir()
            .join("oriel-mode-view-listing-tests")
            .join(format!("{test}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&folder);
        fs::create_dir_all(&folder).unwrap();
        folder
    }

    #[test]
    fn classifies_by_extension_as_media_domain_does() {
        assert_eq!(media_kind("a.AVIF"), Some(MediaKind::Image));
        assert_eq!(media_kind("a.jpeg"), Some(MediaKind::Image));
        assert_eq!(media_kind("a.gif"), Some(MediaKind::Gif));
        assert_eq!(media_kind("clip.M4V"), Some(MediaKind::Video));
        assert_eq!(media_kind("scan.pdf"), None);
        assert_eq!(media_kind("photo.heic"), None);
        assert_eq!(media_kind("jpg"), None);
    }

    #[test]
    fn lists_media_recursively_and_skips_junk_and_links() {
        let root = scratch("recursive");
        for file in [
            "b.jpg",
            "a.avif",
            "notes.txt",
            "._a.avif",
            ".DS_Store",
            "deep/c.png",
            "deep/deeper/clip.mp4",
            ".latch-works/view/thumb.webp",
            "__MACOSX/d.jpg",
        ] {
            let path = root.join(file);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, b"x").unwrap();
        }
        std::os::unix::fs::symlink(root.join("b.jpg"), root.join("link.jpg")).unwrap();
        std::os::unix::fs::symlink(root.join("deep"), root.join("linked-folder")).unwrap();

        let names: Vec<_> = list_media(&root)
            .unwrap()
            .iter()
            .map(|entry| entry.path().strip_prefix(&root).unwrap().to_owned())
            .collect();
        assert_eq!(
            names,
            ["a.avif", "b.jpg", "deep/c.png", "deep/deeper/clip.mp4"]
                .map(PathBuf::from)
                .to_vec()
        );
        assert!(list_media(&root.join("missing")).is_err());
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
    fn names_tie_on_the_path() {
        let mut entries = vec![
            MediaEntry::new(Path::new("/r/z/same.jpg"), MediaKind::Image, 1, 0.0),
            MediaEntry::new(Path::new("/r/a/same.jpg"), MediaKind::Image, 1, 0.0),
            MediaEntry::new(Path::new("/r/m/other.jpg"), MediaKind::Image, 1, 0.0),
        ];
        sort_by_name(&mut entries);
        let paths: Vec<_> = entries
            .iter()
            .map(|entry| entry.path().to_path_buf())
            .collect();
        assert_eq!(
            paths,
            ["/r/m/other.jpg", "/r/a/same.jpg", "/r/z/same.jpg"]
                .map(PathBuf::from)
                .to_vec()
        );
    }
}
