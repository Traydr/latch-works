//! Comic mode, from `media-domain`'s `comics.ts`: each folder of images becomes one comic, its
//! pages in natural order and its first page the cover.

use std::{cmp::Ordering, collections::HashMap};

use crate::{
    GallerySortMode, MediaType, NamedPath, SortableMediaItem, compare_by_name,
    display_name_from_path, get_parent_path, normalize_path_for_compare, sort_media_items,
};

/// An item that can be a comic's page: sortable, with an id and a kind.
pub trait ComicMediaItem: SortableMediaItem {
    fn id(&self) -> &str;
    fn media_type(&self) -> MediaType;
}

impl<T: ComicMediaItem + ?Sized> ComicMediaItem for &T {
    fn id(&self) -> &str {
        (**self).id()
    }

    fn media_type(&self) -> MediaType {
        (**self).media_type()
    }
}

/// One comic: a folder's images, in natural order, the first of them its cover.
#[derive(Clone, Debug, PartialEq)]
pub struct ComicEntry<T> {
    pub cover: T,
    pub folder_path: String,
    /// The folder's path as the pages give it, which is what identifies the comic.
    pub id: String,
    pub name: String,
    pub pages: Vec<T>,
}

/// How a comic's folder is found from its pages' paths and shown. Archive paths are the default
/// ([`ArchiveComicPaths`]); a caller with absolute OS paths supplies its own, as Electron Oriel's
/// View does.
pub trait ComicPathAdapter {
    fn display_name_from_path(&self, path: &str) -> String;
    fn get_parent_path(&self, path: &str) -> String;
    fn normalize_path_for_compare(&self, path: &str) -> String;
}

/// Comics over archive paths, with `paths.ts`'s rules.
#[derive(Clone, Copy, Debug, Default)]
pub struct ArchiveComicPaths;

impl ComicPathAdapter for ArchiveComicPaths {
    fn display_name_from_path(&self, path: &str) -> String {
        display_name_from_path(path)
    }

    fn get_parent_path(&self, path: &str) -> String {
        get_parent_path(path)
    }

    fn normalize_path_for_compare(&self, path: &str) -> String {
        normalize_path_for_compare(path)
    }
}

/// The TypeScript's `BuildComicEntriesOptions`.
#[derive(Clone, Copy)]
pub struct ComicOptions<'a> {
    /// Skip folders that hold other folders, so only leaf folders become comics.
    pub leaf_folders_only: bool,
    /// The parent paths of the folders listed beside the items, which say which folders hold
    /// folders. They are compared with the pages' folders as written: the TypeScript does not
    /// normalize them.
    pub folder_parent_paths: &'a [&'a str],
    pub path_adapter: &'a dyn ComicPathAdapter,
}

impl Default for ComicOptions<'_> {
    fn default() -> Self {
        Self {
            leaf_folders_only: false,
            folder_parent_paths: &[],
            path_adapter: &ArchiveComicPaths,
        }
    }
}

/// Groups the images and GIFs among `items` into one comic per folder, sorted by name in natural
/// order, then by path.
///
/// Items directly in `root_path`, or in no folder at all, are not pages. The root is compared
/// through the adapter's normalization, so case, NFC and separators do not matter there; an empty
/// root, or one that normalizes to nothing, excludes nothing. Folders themselves are keyed as the
/// adapter's parent path gives them, so `Series/A` and `series/a` are two comics.
///
/// Pass `items.iter()` to get comics of references, or owned items to get comics that own them.
pub fn build_comic_entries<T, I>(
    items: I,
    root_path: Option<&str>,
    options: &ComicOptions<'_>,
) -> Vec<ComicEntry<T>>
where
    T: ComicMediaItem + Clone,
    I: IntoIterator<Item = T>,
{
    let adapter = options.path_adapter;
    let normalized_root = root_path
        .filter(|root| !root.is_empty())
        .map(|root| adapter.normalize_path_for_compare(root))
        .filter(|root| !root.is_empty());

    // Folders in the order their first page appears, as a JavaScript `Map` iterates.
    let mut folders: Vec<(String, Vec<T>)> = Vec::new();
    let mut folder_of_path: HashMap<String, usize> = HashMap::new();

    for item in items {
        if !matches!(item.media_type(), MediaType::Image | MediaType::Gif) {
            continue;
        }
        let folder_path = adapter.get_parent_path(item.path());
        if folder_path.is_empty() {
            continue;
        }
        if normalized_root
            .as_deref()
            .is_some_and(|root| adapter.normalize_path_for_compare(&folder_path) == root)
        {
            continue;
        }
        let folder = *folder_of_path
            .entry(folder_path.clone())
            .or_insert_with(|| {
                folders.push((folder_path, Vec::new()));
                folders.len() - 1
            });
        folders[folder].1.push(item);
    }

    let skips_folder = |folder_path: &str| {
        options.leaf_folders_only
            && options
                .folder_parent_paths
                .iter()
                .any(|&parent| !parent.is_empty() && parent == folder_path)
    };

    let mut comics: Vec<ComicEntry<T>> = folders
        .into_iter()
        .filter(|(folder_path, _)| !skips_folder(folder_path))
        .filter_map(|(folder_path, mut pages)| {
            pages.sort_by(|a, b| compare_by_name(a, b));
            let cover = pages.first()?.clone();
            Some(ComicEntry {
                cover,
                name: adapter.display_name_from_path(&folder_path),
                id: folder_path.clone(),
                folder_path,
                pages,
            })
        })
        .collect();

    comics.sort_by(compare_comics);
    comics
}

/// Orders comics by their covers, as [`sort_media_items`] orders items, for `mode` and `seed`.
///
/// Covers are matched back to comics by id. Comics whose covers share an id all become the last
/// comic with that id, as the TypeScript's map of covers keeps the last.
pub fn sort_comic_entries<T: ComicMediaItem>(
    comics: &[ComicEntry<T>],
    mode: GallerySortMode,
    seed: i64,
) -> Vec<&ComicEntry<T>> {
    let comic_of_cover: HashMap<&str, &ComicEntry<T>> = comics
        .iter()
        .map(|comic| (comic.cover.id(), comic))
        .collect();
    sort_media_items(
        comics.iter().map(|comic| &comic.cover).collect(),
        mode,
        seed,
    )
    .into_iter()
    .filter_map(|cover| comic_of_cover.get(cover.id()).copied())
    .collect()
}

/// A comic's name and folder, which comics sort by.
struct ComicName<'a> {
    name: &'a str,
    path: &'a str,
}

impl NamedPath for ComicName<'_> {
    fn name(&self) -> &str {
        self.name
    }

    fn path(&self) -> &str {
        self.path
    }
}

impl<'a, T> From<&'a ComicEntry<T>> for ComicName<'a> {
    fn from(comic: &'a ComicEntry<T>) -> Self {
        Self {
            name: &comic.name,
            path: &comic.folder_path,
        }
    }
}

fn compare_comics<T>(a: &ComicEntry<T>, b: &ComicEntry<T>) -> Ordering {
    compare_by_name(&ComicName::from(a), &ComicName::from(b))
}
