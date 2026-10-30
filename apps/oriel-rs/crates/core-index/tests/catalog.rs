//! View's scan of a folder, as Electron Oriel's `CatalogRuntime` scans one: the folder's own media
//! unless recursive, the root's excluded children left out, the filters applied, batches streamed,
//! and the index left holding what the last scan of the root saw.

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

use futures::executor::block_on;
use oriel_core_domain::{IMAGE_EXTENSIONS, VIDEO_EXTENSIONS};
use oriel_core_index::{
    CatalogEvent, CatalogFilters, CatalogScan, MediaIndex, list_folder_children,
};
use oriel_runtime::CancelToken;

fn scratch(test: &str) -> PathBuf {
    let folder = std::env::temp_dir()
        .join("oriel-core-index-catalog")
        .join(format!("{test}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&folder);
    fs::create_dir_all(&folder).unwrap();
    // The scan is given canonical roots, as View resolves them; the temp folder is a symlink.
    fs::canonicalize(&folder).unwrap()
}

fn archive(root: &Path) {
    for file in [
        "top.jpg",
        "clip.mp4",
        "notes.txt",
        ".DS_Store",
        "bulk/one.png",
        "bulk/two.png",
        "comics/alpha/1.jpg",
        "comics/alpha/2.jpg",
        "comics/beta/page.png",
        "__MACOSX/hidden.jpg",
    ] {
        let path = root.join(file);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, file).unwrap();
    }
    std::os::unix::fs::symlink(root.join("top.jpg"), root.join("link.jpg")).unwrap();
    std::os::unix::fs::symlink(root.join("comics"), root.join("linked")).unwrap();
}

fn filters(show_images: bool, show_videos: bool) -> CatalogFilters {
    CatalogFilters {
        image_extensions: IMAGE_EXTENSIONS.map(String::from).into(),
        video_extensions: VIDEO_EXTENSIONS.map(String::from).into(),
        show_images,
        show_videos,
    }
}

/// Runs `scan` and returns its events and the paths it found, relative to `root`.
fn run(
    scan: CatalogScan,
    index: Option<&MediaIndex>,
    root: &Path,
) -> (Vec<CatalogEvent>, Vec<String>) {
    let mut events = Vec::new();
    scan.run(index, &CancelToken::new(), &mut |event| events.push(event));
    let mut found: Vec<String> = events
        .iter()
        .filter_map(|event| match event {
            CatalogEvent::Batch { items, .. } => Some(items.to_vec()),
            _ => None,
        })
        .flatten()
        .map(|item| {
            Path::new(&item.path)
                .strip_prefix(root)
                .unwrap()
                .to_string_lossy()
                .into_owned()
        })
        .collect();
    found.sort();
    (events, found)
}

#[test]
fn lists_the_folders_own_media_then_recurses_without_excluded_children() {
    let root = scratch("scan");
    archive(&root);

    let (events, found) = run(
        CatalogScan::new(1, root.clone(), false, filters(true, true)),
        None,
        &root,
    );
    assert_eq!(found, ["clip.mp4", "top.jpg"]);
    assert!(matches!(
        events.first(),
        Some(CatalogEvent::Reset {
            run_id: 1,
            recursive: false,
            ..
        })
    ));
    assert!(matches!(
        events.last(),
        Some(CatalogEvent::Done {
            run_id: 1,
            total_items: 2,
            ..
        })
    ));

    let (_, found) = run(
        CatalogScan::new(2, root.clone(), true, filters(true, true)),
        None,
        &root,
    );
    assert_eq!(
        found,
        [
            "bulk/one.png",
            "bulk/two.png",
            "clip.mp4",
            "comics/alpha/1.jpg",
            "comics/alpha/2.jpg",
            "comics/beta/page.png",
            "top.jpg"
        ]
    );

    let excluded = CatalogScan::new(3, root.clone(), true, filters(true, true)).excluding([
        root.join("bulk"),
        // Not a child of the root, so ignored.
        root.join("comics/alpha"),
    ]);
    let (_, found) = run(excluded, None, &root);
    assert_eq!(
        found,
        [
            "clip.mp4",
            "comics/alpha/1.jpg",
            "comics/alpha/2.jpg",
            "comics/beta/page.png",
            "top.jpg"
        ]
    );

    let (_, found) = run(
        CatalogScan::new(4, root.clone(), true, filters(true, false)),
        None,
        &root,
    );
    assert!(!found.contains(&"clip.mp4".to_string()));
    let (_, found) = run(
        CatalogScan::new(5, root.clone(), true, filters(false, true)),
        None,
        &root,
    );
    assert_eq!(found, ["clip.mp4"]);
    fs::remove_dir_all(&root).unwrap();
}

#[test]
fn the_index_keeps_what_the_last_scan_of_a_root_saw() {
    let root = scratch("index");
    archive(&root);
    let index = block_on(MediaIndex::open_in(&root.join("data"))).unwrap();

    run(
        CatalogScan::new(1, root.clone(), true, filters(true, true)),
        Some(&index),
        &root,
    );
    assert_eq!(block_on(index.stats()).unwrap().total_items, 7);

    // A scan that sees less leaves the index holding only what it saw.
    run(
        CatalogScan::new(2, root.clone(), false, filters(true, true)),
        Some(&index),
        &root,
    );
    let rows = block_on(index.rows()).unwrap();
    let names: HashSet<&str> = rows.iter().map(|row| row.name.as_str()).collect();
    assert_eq!(names, HashSet::from(["clip.mp4", "top.jpg"]));
    assert_eq!(rows[0].root_path, root.to_string_lossy());

    // A cancelled scan is recorded as such and leaves the rows alone.
    let cancel = CancelToken::new();
    cancel.cancel();
    let mut events = Vec::new();
    CatalogScan::new(3, root.clone(), true, filters(true, true)).run(
        Some(&index),
        &cancel,
        &mut |event| events.push(event),
    );
    assert_eq!(events, [CatalogEvent::Cancelled { run_id: 3 }]);
    let runs = block_on(index.scan_runs()).unwrap();
    let statuses: Vec<&str> = runs.iter().map(|run| run.2.as_str()).collect();
    assert_eq!(statuses, ["done", "done", "cancelled"]);
    assert_eq!(block_on(index.stats()).unwrap().total_items, 2);

    block_on(index.clear()).unwrap();
    assert_eq!(block_on(index.stats()).unwrap().total_items, 0);
    block_on(index.close()).unwrap();
    fs::remove_dir_all(&root).unwrap();
}

#[test]
fn an_unreadable_folder_is_reported_and_passed_over() {
    let root = scratch("unreadable");
    archive(&root);
    let (events, found) = run(
        CatalogScan::new(1, root.join("missing"), true, filters(true, true)),
        None,
        &root,
    );
    assert!(found.is_empty());
    assert!(events.iter().any(|event| matches!(
        event,
        CatalogEvent::Error { message, .. } if message == "Unable to access directory"
    )));
    assert!(matches!(
        events.last(),
        Some(CatalogEvent::Done { total_items: 0, .. })
    ));
    fs::remove_dir_all(&root).unwrap();
}

#[test]
fn folder_children_are_every_real_folder_by_name() {
    let root = scratch("children");
    archive(&root);
    fs::create_dir_all(root.join("Zeta")).unwrap();
    fs::create_dir_all(root.join("10")).unwrap();
    fs::create_dir_all(root.join("2")).unwrap();
    let names: Vec<String> = list_folder_children(&root)
        .unwrap()
        .into_iter()
        .map(|node| node.name)
        .collect();
    // Base strength without numeric order, as `folderService.ts` sorts; system folders count,
    // and the symlinked folder does not.
    assert_eq!(names, ["__MACOSX", "10", "2", "bulk", "comics", "Zeta"]);
    fs::remove_dir_all(&root).unwrap();
}

/// The scan lists items in the order a breadth-first walk reading each folder with `readdir`
/// and stating each file finds them, with the same ids, whoever reads the folders.
fn walk_like_readdir(root: &Path, filters: &CatalogFilters) -> Vec<String> {
    let mut queue = vec![root.to_path_buf()];
    let mut cursor = 0;
    let mut ids = Vec::new();
    while cursor < queue.len() {
        let folder = queue[cursor].clone();
        cursor += 1;
        for entry in fs::read_dir(&folder).unwrap() {
            let entry = entry.unwrap();
            let kind = entry.file_type().unwrap();
            let name = entry.file_name().to_string_lossy().into_owned();
            if kind.is_dir() {
                if !oriel_core_domain::is_system_junk_directory(&name) {
                    queue.push(folder.join(&name));
                }
            } else if kind.is_file() && filters.classify(&name).is_some() {
                let metadata = fs::metadata(entry.path()).unwrap();
                ids.push(format!(
                    "{}:{}:{}",
                    folder.join(&name).display(),
                    metadata.len(),
                    oriel_core_index::modified_ms(&metadata)
                ));
            }
        }
    }
    ids
}

fn scanned_ids(root: &Path) -> Vec<String> {
    let mut ids = Vec::new();
    CatalogScan::new(1, root.to_path_buf(), true, filters(true, true)).run(
        None,
        &CancelToken::new(),
        &mut |event| {
            if let CatalogEvent::Batch { items, .. } = event {
                ids.extend(items.iter().map(|item| item.id.clone()));
            }
        },
    );
    ids
}

#[test]
fn lists_in_the_order_a_breadth_first_readdir_walk_finds() {
    let root = scratch("order");
    for folder in 0..12 {
        for file in 0..40 {
            let path = root.join(format!("f{folder}/sub{}/p{file}.jpg", file % 3));
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(&path, vec![b'x'; file]).unwrap();
        }
    }
    let ids = scanned_ids(&root);
    assert_eq!(ids.len(), 480);
    assert_eq!(ids, walk_like_readdir(&root, &filters(true, true)));
    fs::remove_dir_all(&root).unwrap();
}
