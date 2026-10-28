//! Checks `browser-entries.ts`'s port against `conformance/media-domain/browser-entries.json`.

mod support;

use oriel_core_domain::{
    BrowserEntry, BrowserListing, ComicEntry, FolderNode, GallerySortMode, MediaItem,
    build_browser_entries,
};
use serde::Deserialize;
use support::{GeneratedWith, check, fail_with, read_vectors};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BrowserVectors {
    generated_with: GeneratedWith,
    cases: Vec<BrowserCase>,
}

#[derive(Deserialize)]
struct BrowserCase {
    about: String,
    folders: Vec<FolderNode>,
    items: Vec<MediaItem>,
    comics: Vec<ComicSummary>,
    views: Vec<View>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ComicSummary {
    id: String,
    folder_path: String,
    name: String,
    cover_id: String,
    page_ids: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct View {
    recursive: bool,
    comic_mode: bool,
    sort_mode: GallerySortMode,
    entries: Vec<EntrySummary>,
}

#[derive(Debug, PartialEq, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "lowercase",
    rename_all_fields = "camelCase"
)]
enum EntrySummary {
    Folder {
        key: String,
        path: String,
        name: String,
        has_children: bool,
    },
    Comic {
        key: String,
        comic_id: String,
    },
    Media {
        key: String,
        media_id: String,
        media_index: usize,
    },
}

impl EntrySummary {
    fn of(entry: &BrowserEntry<'_, &MediaItem, MediaItem>) -> Self {
        match entry {
            BrowserEntry::Folder { key, folder } => Self::Folder {
                key: key.clone(),
                path: folder.path.clone(),
                name: folder.name.clone(),
                has_children: folder.has_children,
            },
            BrowserEntry::Comic { key, comic } => Self::Comic {
                key: key.clone(),
                comic_id: comic.id.clone(),
            },
            BrowserEntry::Media {
                key,
                media,
                media_index,
            } => Self::Media {
                key: key.clone(),
                media_id: media.id.clone(),
                media_index: *media_index,
            },
        }
    }
}

/// The comics the TypeScript built, rebuilt over the same items. Comic grouping has its own
/// vectors; these only carry comics into the entries.
fn comics(case: &BrowserCase) -> Vec<ComicEntry<&MediaItem>> {
    let item = |id: &str| {
        case.items
            .iter()
            .find(|item| item.id == id)
            .expect("each page is one of the items")
    };
    case.comics
        .iter()
        .map(|comic| ComicEntry {
            cover: item(&comic.cover_id),
            folder_path: comic.folder_path.clone(),
            id: comic.id.clone(),
            name: comic.name.clone(),
            pages: comic.page_ids.iter().map(|id| item(id)).collect(),
        })
        .collect()
}

#[test]
fn builds_the_galleries_entries_in_every_view_as_the_typescript_does() {
    let vectors: BrowserVectors = read_vectors("browser-entries.json");
    let mut problems = Vec::new();
    for case in &vectors.cases {
        let comics = comics(case);
        for view in &case.views {
            let listing = BrowserListing {
                folders: &case.folders,
                comics: &comics,
                items: &case.items,
                recursive: view.recursive,
                comic_mode: view.comic_mode,
                sort_mode: view.sort_mode,
            };
            let entries: Vec<EntrySummary> = build_browser_entries(&listing)
                .iter()
                .map(EntrySummary::of)
                .collect();
            check(
                &mut problems,
                || {
                    format!(
                        "{}, recursive {}, comic mode {}, {:?}",
                        case.about, view.recursive, view.comic_mode, view.sort_mode
                    )
                },
                &view.entries,
                &entries,
            );
        }
    }
    fail_with(&problems, "listings differ", &vectors.generated_with);
}
