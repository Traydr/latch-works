//! The gallery's entries, from `media-domain`'s `browser-entries.ts`: a folder's subfolders, then
//! its comics or its media.

use crate::{ComicEntry, FolderNode, GallerySortMode, comics::ComicMediaItem, sort::compare_names};

/// One tile in the gallery. Each borrows what it shows: comics of `C`, media of `T`.
#[derive(Debug, PartialEq)]
pub enum BrowserEntry<'a, C, T> {
    Folder {
        key: String,
        folder: &'a FolderNode,
    },
    Comic {
        key: String,
        comic: &'a ComicEntry<C>,
    },
    Media {
        key: String,
        media: &'a T,
        /// Where the item is among all the items, which the viewer steps through.
        media_index: usize,
    },
}

impl<C, T> BrowserEntry<'_, C, T> {
    /// A key unique within one listing: `folder:`, `comic:` or `media:` and the path or id.
    pub fn key(&self) -> &str {
        match self {
            Self::Folder { key, .. } | Self::Comic { key, .. } | Self::Media { key, .. } => key,
        }
    }
}

/// What the gallery is showing. Comics and items are separate types, so comics built from
/// `items.iter()` can sit beside the items they borrow.
#[derive(Clone, Copy, Debug)]
pub struct BrowserListing<'a, C, T> {
    pub folders: &'a [FolderNode],
    pub comics: &'a [ComicEntry<C>],
    pub items: &'a [T],
    /// Recursive listings flatten the tree, so they show no folders.
    pub recursive: bool,
    /// Comic mode shows comics in place of media.
    pub comic_mode: bool,
    pub sort_mode: GallerySortMode,
}

/// The gallery's entries: folders unless recursive, then comics in comic mode or media otherwise.
///
/// Folders sort by name alone in natural order, and only `NameDesc` reverses them, ties
/// included, since the TypeScript reverses the sorted list. Comics and media keep the order they
/// are given in.
pub fn build_browser_entries<'a, C, T: ComicMediaItem>(
    listing: &BrowserListing<'a, C, T>,
) -> Vec<BrowserEntry<'a, C, T>> {
    let mut entries = Vec::new();

    if !listing.recursive {
        let mut folders: Vec<&FolderNode> = listing.folders.iter().collect();
        folders.sort_by(|a, b| compare_names(&a.name, &b.name));
        if listing.sort_mode == GallerySortMode::NameDesc {
            folders.reverse();
        }
        entries.extend(folders.into_iter().map(|folder| BrowserEntry::Folder {
            key: format!("folder:{}", folder.path),
            folder,
        }));
    }

    if listing.comic_mode {
        entries.extend(listing.comics.iter().map(|comic| BrowserEntry::Comic {
            key: format!("comic:{}", comic.id),
            comic,
        }));
    } else {
        entries.extend(
            listing
                .items
                .iter()
                .enumerate()
                .map(|(media_index, media)| BrowserEntry::Media {
                    key: format!("media:{}", media.id()),
                    media,
                    media_index,
                }),
        );
    }

    entries
}
