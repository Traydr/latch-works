//! Checks `comics.ts`'s port against `conformance/media-domain/comics.json`.

mod support;

use oriel_core_domain::{
    ArchiveComicPaths, ComicEntry, ComicMediaItem, ComicOptions, GallerySortMode, MediaType,
    NamedPath, SortableMediaItem, build_comic_entries, sort_comic_entries,
};
use serde::Deserialize;
use support::{GeneratedWith, check, fail_with, read_vectors};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ComicVectors {
    generated_with: GeneratedWith,
    cases: Vec<ComicCase>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ComicCase {
    about: String,
    items: Vec<Item>,
    root_path: Option<String>,
    leaf_folders_only: bool,
    folders: Option<Vec<FolderParent>>,
    comics: Vec<ComicSummary>,
    orders: Vec<ComicOrder>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Item {
    id: String,
    name: String,
    path: String,
    mtime_ms: f64,
    media_type: MediaType,
}

impl NamedPath for Item {
    fn name(&self) -> &str {
        &self.name
    }

    fn path(&self) -> &str {
        &self.path
    }
}

impl SortableMediaItem for Item {
    fn mtime_ms(&self) -> f64 {
        self.mtime_ms
    }
}

impl ComicMediaItem for Item {
    fn id(&self) -> &str {
        &self.id
    }

    fn media_type(&self) -> MediaType {
        self.media_type
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FolderParent {
    parent_path: String,
}

#[derive(Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ComicSummary {
    id: String,
    folder_path: String,
    name: String,
    cover_id: String,
    page_ids: Vec<String>,
}

impl ComicSummary {
    fn of(comic: &ComicEntry<&Item>) -> Self {
        Self {
            id: comic.id.clone(),
            folder_path: comic.folder_path.clone(),
            name: comic.name.clone(),
            cover_id: comic.cover.id.clone(),
            page_ids: comic.pages.iter().map(|page| page.id.clone()).collect(),
        }
    }
}

#[derive(Deserialize)]
struct ComicOrder {
    mode: GallerySortMode,
    seed: i64,
    ids: Vec<String>,
}

fn build(case: &ComicCase) -> Vec<ComicEntry<&Item>> {
    let folder_parent_paths: Vec<&str> = case
        .folders
        .iter()
        .flatten()
        .map(|folder| folder.parent_path.as_str())
        .collect();
    let options = ComicOptions {
        leaf_folders_only: case.leaf_folders_only,
        folder_parent_paths: &folder_parent_paths,
        path_adapter: &ArchiveComicPaths,
    };
    build_comic_entries(case.items.iter(), case.root_path.as_deref(), &options)
}

#[test]
fn groups_pages_into_comics_as_the_typescript_does() {
    let vectors: ComicVectors = read_vectors("comics.json");
    let mut problems = Vec::new();
    for case in &vectors.cases {
        let comics: Vec<ComicSummary> = build(case).iter().map(ComicSummary::of).collect();
        check(&mut problems, || case.about.clone(), &case.comics, &comics);
    }
    fail_with(&problems, "groupings differ", &vectors.generated_with);
}

#[test]
fn sorts_comics_in_every_mode_as_the_typescript_does() {
    let vectors: ComicVectors = read_vectors("comics.json");
    let mut problems = Vec::new();
    for case in &vectors.cases {
        let comics = build(case);
        for order in &case.orders {
            let ids: Vec<String> = sort_comic_entries(&comics, order.mode, order.seed)
                .into_iter()
                .map(|comic| comic.id.clone())
                .collect();
            check(
                &mut problems,
                || {
                    format!(
                        "{} in {:?} with seed {}",
                        case.about, order.mode, order.seed
                    )
                },
                &order.ids,
                &ids,
            );
        }
    }
    fail_with(&problems, "comic orders differ", &vectors.generated_with);
}
