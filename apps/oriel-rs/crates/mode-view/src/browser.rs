//! What the gallery shows for a folder, from `media-domain`'s rules through `oriel-core-domain`:
//! its subfolders unless the listing is recursive, then its comics in comic mode or its media,
//! as Electron Oriel's `buildBrowserEntryCollection` and `utils/comics.ts` make them.
//!
//! Comics group absolute paths, so they take Electron Oriel's absolute-path adapter
//! ([`AbsoluteComicPaths`]) rather than the archive-path one Pane View uses.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use gpui_kit::SharedString;
use oriel_core_domain::{
    BrowserEntry, BrowserListing, ComicEntry, ComicOptions, ComicPathAdapter, FolderNode,
    GallerySortMode, build_browser_entries, build_comic_entries, sort_comic_entries,
    sort_media_items,
};

use crate::listing::MediaEntry;

/// One comic: a folder's stills in reading order, the first its cover.
#[derive(Clone, Debug, PartialEq)]
pub struct Comic {
    id: SharedString,
    name: SharedString,
    folder_path: Arc<Path>,
    cover: MediaEntry,
    pages: Arc<[MediaEntry]>,
}

impl Comic {
    /// The folder's path as the pages give it, which identifies the comic.
    pub fn id(&self) -> &SharedString {
        &self.id
    }

    /// The folder's name with `_` and `-` as spaces, as the reader titles itself.
    pub fn name(&self) -> &SharedString {
        &self.name
    }

    pub fn folder_path(&self) -> &Arc<Path> {
        &self.folder_path
    }

    pub fn cover(&self) -> &MediaEntry {
        &self.cover
    }

    pub fn pages(&self) -> &Arc<[MediaEntry]> {
        &self.pages
    }
}

/// One tile of the gallery.
#[derive(Clone, Debug, PartialEq)]
pub enum Tile {
    Folder {
        key: SharedString,
        path: Arc<Path>,
        name: SharedString,
    },
    Comic {
        key: SharedString,
        comic: Arc<Comic>,
    },
    Media {
        key: SharedString,
        media: MediaEntry,
        /// Where the item is in the listing's media, which the viewer steps through.
        media_index: usize,
    },
}

impl Tile {
    /// `folder:`, `comic:` or `media:` and the path or id: unique within a listing, and what a
    /// selection is kept by.
    pub fn key(&self) -> &SharedString {
        match self {
            Self::Folder { key, .. } | Self::Comic { key, .. } | Self::Media { key, .. } => key,
        }
    }

    pub fn name(&self) -> &SharedString {
        match self {
            Self::Folder { name, .. } => name,
            Self::Comic { comic, .. } => comic.name(),
            Self::Media { media, .. } => media.name(),
        }
    }

    /// The file whose thumbnail the tile draws: the item, a comic's cover, and none for a
    /// folder.
    pub fn thumbnail_source(&self) -> Option<&MediaEntry> {
        match self {
            Self::Folder { .. } => None,
            Self::Comic { comic, .. } => Some(comic.cover()),
            Self::Media { media, .. } => Some(media),
        }
    }
}

/// Electron Oriel's `absolutePathComicAdapter`.
#[derive(Clone, Copy, Debug, Default)]
pub struct AbsoluteComicPaths;

impl ComicPathAdapter for AbsoluteComicPaths {
    /// The last segment, with `_` and `-` read as spaces.
    fn display_name_from_path(&self, path: &str) -> String {
        let normalized = path.replace('\\', "/");
        let normalized = normalized.trim_end_matches('/');
        let last = normalized
            .rfind('/')
            .map_or(normalized, |separator| &normalized[separator + 1..]);
        last.replace(['_', '-'], " ")
    }

    /// Everything before the last separator, as written; `""` for a file at the top.
    fn get_parent_path(&self, path: &str) -> String {
        let normalized = path.replace('\\', "/");
        match normalized.rfind('/') {
            Some(separator) if separator > 0 => path[..separator].to_owned(),
            _ => String::new(),
        }
    }

    fn normalize_path_for_compare(&self, path: &str) -> String {
        path.replace('\\', "/").trim_end_matches('/').to_lowercase()
    }
}

/// The items in the order the settings give, as `sortMediaItems` sorts them.
pub fn sort_media(items: &[MediaEntry], mode: GallerySortMode, seed: i64) -> Vec<MediaEntry> {
    sort_media_items(items.to_vec(), mode, seed)
}

/// `buildComicEntries` then `sortComicEntries`: the folders of stills under `root`, not `root`
/// itself, ordered by their covers.
pub fn build_comics(
    items: &[MediaEntry],
    root: Option<&str>,
    mode: GallerySortMode,
    seed: i64,
) -> Vec<Arc<Comic>> {
    let options = ComicOptions {
        path_adapter: &AbsoluteComicPaths,
        ..ComicOptions::default()
    };
    let comics: Vec<ComicEntry<MediaEntry>> =
        build_comic_entries(items.iter().cloned(), root, &options);
    sort_comic_entries(&comics, mode, seed)
        .into_iter()
        .map(|comic| {
            Arc::new(Comic {
                id: comic.id.clone().into(),
                name: comic.name.clone().into(),
                folder_path: PathBuf::from(&comic.folder_path).into(),
                cover: comic.cover.clone(),
                pages: comic.pages.clone().into(),
            })
        })
        .collect()
}

/// What a gallery shows of one folder.
pub struct Browse<'a> {
    pub folders: &'a [FolderNode],
    /// The media, already in display order.
    pub media: &'a [MediaEntry],
    pub comics: &'a [Arc<Comic>],
    pub recursive: bool,
    pub comic_mode: bool,
    pub sort_mode: GallerySortMode,
}

/// The gallery's tiles: `buildBrowserEntryCollection`.
pub fn build_tiles(browse: &Browse<'_>) -> Vec<Tile> {
    // The shared rule decides the order and the keys; the comics ride along by position.
    let shared: Vec<ComicEntry<&MediaEntry>> = browse
        .comics
        .iter()
        .map(|comic| ComicEntry {
            cover: comic.cover(),
            folder_path: comic.folder_path().to_string_lossy().into_owned(),
            id: comic.id().to_string(),
            name: comic.name().to_string(),
            pages: Vec::new(),
        })
        .collect();
    let listing = BrowserListing {
        folders: browse.folders,
        comics: &shared,
        items: browse.media,
        recursive: browse.recursive,
        comic_mode: browse.comic_mode,
        sort_mode: browse.sort_mode,
    };
    build_browser_entries(&listing)
        .into_iter()
        .map(|entry| match entry {
            BrowserEntry::Folder { key, folder } => Tile::Folder {
                key: key.into(),
                path: PathBuf::from(&folder.path).into(),
                name: folder.name.clone().into(),
            },
            BrowserEntry::Comic { key, comic } => {
                let position = shared
                    .iter()
                    .position(|candidate| std::ptr::eq(candidate, comic))
                    .expect("the comic came from this list");
                Tile::Comic {
                    key: key.into(),
                    comic: browse.comics[position].clone(),
                }
            }
            BrowserEntry::Media {
                key,
                media,
                media_index,
            } => Tile::Media {
                key: key.into(),
                media: media.clone(),
                media_index,
            },
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::listing::MediaKind;

    fn still(path: &str, modified_ms: f64) -> MediaEntry {
        MediaEntry::new(Path::new(path), MediaKind::Image, 1, modified_ms)
    }

    fn folder(path: &str) -> FolderNode {
        FolderNode {
            path: path.into(),
            parent_path: "/r".into(),
            parent_id: None,
            name: Path::new(path)
                .file_name()
                .unwrap()
                .to_string_lossy()
                .into_owned(),
            has_children: true,
        }
    }

    #[test]
    fn the_absolute_path_adapter_reads_folders_as_electron_oriel_does() {
        let adapter = AbsoluteComicPaths;
        assert_eq!(
            adapter.display_name_from_path("/r/My_Comic-01/"),
            "My Comic 01"
        );
        assert_eq!(adapter.get_parent_path("/r/comics/a.jpg"), "/r/comics");
        assert_eq!(adapter.get_parent_path("/a.jpg"), "");
        assert_eq!(adapter.get_parent_path("a.jpg"), "");
        assert_eq!(
            adapter.normalize_path_for_compare("/R/Comics//"),
            "/r/comics"
        );
    }

    #[test]
    fn comics_are_the_folders_of_stills_below_the_root() {
        let items = vec![
            still("/r/root.jpg", 1.),
            still("/r/alpha/2.jpg", 2.),
            still("/r/alpha/10.jpg", 3.),
            still("/r/alpha/1.jpg", 4.),
            still("/r/beta_two/page.png", 5.),
            MediaEntry::new(Path::new("/r/videos/clip.mp4"), MediaKind::Video, 1, 6.),
        ];
        let comics = build_comics(&items, Some("/r"), GallerySortMode::NameAsc, 1);
        let names: Vec<&str> = comics.iter().map(|comic| comic.name().as_ref()).collect();
        assert_eq!(names, ["alpha", "beta two"]);
        let pages: Vec<&str> = comics[0]
            .pages()
            .iter()
            .map(|page| page.name().as_ref())
            .collect();
        assert_eq!(pages, ["1.jpg", "2.jpg", "10.jpg"]);
        assert_eq!(comics[0].cover().name().as_ref(), "1.jpg");
    }

    #[test]
    fn folders_come_first_unless_recursive_and_comics_replace_media() {
        let folders = [
            folder("/r/b"),
            folder("/r/A"),
            folder("/r/10"),
            folder("/r/9"),
        ];
        let media = [still("/r/x.jpg", 1.)];
        let browse = Browse {
            folders: &folders,
            media: &media,
            comics: &[],
            recursive: false,
            comic_mode: false,
            sort_mode: GallerySortMode::NameAsc,
        };
        let keys: Vec<String> = build_tiles(&browse)
            .iter()
            .map(|tile| tile.key().to_string())
            .collect();
        assert_eq!(
            keys,
            [
                "folder:/r/9",
                "folder:/r/10",
                "folder:/r/A",
                "folder:/r/b",
                "media:/r/x.jpg:1:1"
            ]
        );

        let recursive = Browse {
            recursive: true,
            ..browse
        };
        assert_eq!(build_tiles(&recursive).len(), 1);

        let comic_items = [still("/r/c/1.jpg", 1.)];
        let comics = build_comics(&comic_items, Some("/r"), GallerySortMode::NameAsc, 1);
        let comic_mode = Browse {
            folders: &folders,
            media: &comic_items,
            comics: &comics,
            recursive: true,
            comic_mode: true,
            sort_mode: GallerySortMode::NameAsc,
        };
        let tiles = build_tiles(&comic_mode);
        assert_eq!(tiles.len(), 1);
        assert!(matches!(&tiles[0], Tile::Comic { key, .. } if key.as_ref() == "comic:/r/c"));
    }
}
