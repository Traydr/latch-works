//! View's scan of a folder: the folder's own media unless recursive, the root's excluded children
//! left out, the filters applied, and batches streamed.

use std::fs;
use std::path::{Path, PathBuf};

use oriel_core_domain::{GallerySortMode, IMAGE_EXTENSIONS, VIDEO_EXTENSIONS};
use oriel_runtime::CancelToken;

use super::*;

fn scratch(test: &str) -> PathBuf {
    let folder = std::env::temp_dir()
        .join("oriel-mode-view-catalog")
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
    symlink(&root.join("top.jpg"), &root.join("link.jpg"));
    symlink(&root.join("comics"), &root.join("linked"));
}

fn filters(show_images: bool, show_videos: bool) -> CatalogFilters {
    CatalogFilters {
        image_extensions: IMAGE_EXTENSIONS.map(String::from).into(),
        video_extensions: VIDEO_EXTENSIONS.map(String::from).into(),
        show_images,
        show_videos,
    }
}

/// A scan of `root` in name order.
fn scan(root: &Path, recursive: bool, filters: CatalogFilters) -> CatalogScan {
    excluding(root, recursive, filters, &[])
}

fn excluding(
    root: &Path,
    recursive: bool,
    filters: CatalogFilters,
    excluded: &[PathBuf],
) -> CatalogScan {
    CatalogScan::new(&ScanRequest {
        root: root.to_path_buf(),
        recursive,
        filters,
        excluded_root_children: excluded.to_vec(),
        order: (GallerySortMode::NameAsc, 0),
    })
}

/// Runs `scan` and returns its events and the paths it found, relative to `root`.
fn run(scan: CatalogScan, root: &Path) -> (Vec<CatalogEvent>, Vec<String>) {
    let mut events = Vec::new();
    scan.run(&CancelToken::new(), &mut |event| events.push(event));
    let mut found: Vec<String> = events
        .iter()
        .filter_map(|event| match event {
            CatalogEvent::Batch(items) => Some(items.clone()),
            _ => None,
        })
        .flatten()
        .map(|item| {
            item.path()
                .strip_prefix(root)
                .unwrap()
                .to_string_lossy()
                .replace(std::path::MAIN_SEPARATOR, "/")
        })
        .collect();
    found.sort();
    (events, found)
}

#[test]
fn lists_the_folders_own_media_then_recurses_without_excluded_children() {
    let root = scratch("scan");
    archive(&root);

    let (events, found) = run(scan(&root, false, filters(true, true)), &root);
    assert_eq!(found, ["clip.mp4", "top.jpg"]);
    assert!(matches!(events.first(), Some(CatalogEvent::Reset { .. })));
    let Some(CatalogEvent::Done { sorted, .. }) = events.last() else {
        panic!("the scan ends done");
    };
    let names: Vec<&str> = sorted.iter().map(|item| item.name().as_ref()).collect();
    assert_eq!(names, ["clip.mp4", "top.jpg"]);

    let (_, found) = run(scan(&root, true, filters(true, true)), &root);
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

    let excluded = excluding(
        &root,
        true,
        filters(true, true),
        &[
            root.join("bulk"),
            // Not a child of the root, so ignored.
            root.join("comics/alpha"),
        ],
    );
    let (_, found) = run(excluded, &root);
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

    let (_, found) = run(scan(&root, true, filters(true, false)), &root);
    assert!(!found.contains(&"clip.mp4".to_string()));
    let (_, found) = run(scan(&root, true, filters(false, true)), &root);
    assert_eq!(found, ["clip.mp4"]);
    fs::remove_dir_all(&root).unwrap();
}

#[test]
fn an_unreadable_folder_is_reported_and_passed_over() {
    let root = scratch("unreadable");
    archive(&root);
    let (events, found) = run(
        scan(&root.join("missing"), true, filters(true, true)),
        &root,
    );
    assert!(found.is_empty());
    assert!(events.iter().any(|event| matches!(
        event,
        CatalogEvent::Error { message, .. } if message.starts_with("Unable to access directory: ")
    )));
    assert!(matches!(
        events.last(),
        Some(CatalogEvent::Done { sorted, .. }) if sorted.is_empty()
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
    // Base strength without numeric order; system folders count,
    // and the symlinked folder does not.
    assert_eq!(names, ["__MACOSX", "10", "2", "bulk", "comics", "Zeta"]);
    fs::remove_dir_all(&root).unwrap();
}

/// A symlink, as the scan meets one. On Windows it needs developer mode or an elevated prompt.
#[cfg(unix)]
fn symlink(target: &Path, link: &Path) {
    std::os::unix::fs::symlink(target, link).unwrap();
}

#[cfg(windows)]
fn symlink(target: &Path, link: &Path) {
    let resolved = link.parent().unwrap().join(target);
    if resolved.is_dir() {
        std::os::windows::fs::symlink_dir(target, link).unwrap();
    } else {
        std::os::windows::fs::symlink_file(target, link).unwrap();
    }
}

#[test]
fn filters_choose_the_kinds_and_videos_win() {
    let filters = CatalogFilters {
        image_extensions: ["jpg", "gif", "png"].map(String::from).into(),
        video_extensions: ["mp4", "gif"].map(String::from).into(),
        show_images: true,
        show_videos: true,
    };
    assert_eq!(
        filters.classify("a.JPEG"),
        Some(("jpg".into(), MediaKind::Image))
    );
    assert_eq!(
        filters.classify("a.gif"),
        Some(("gif".into(), MediaKind::Video))
    );
    assert_eq!(filters.classify("._a.jpg"), None);
    assert_eq!(filters.classify("Thumbs.db"), None);
    let images_only = CatalogFilters {
        show_videos: false,
        ..filters
    };
    assert_eq!(images_only.classify("a.mp4"), None);
    assert_eq!(
        images_only.classify("a.gif"),
        Some(("gif".into(), MediaKind::Gif))
    );
}
