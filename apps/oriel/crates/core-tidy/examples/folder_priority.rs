//! Measures folder priority (plan 065) against a copy of a catalog: how many open sets it decides,
//! how many suggestions it changes against the keeper rules without it, and how many of those now
//! keep fewer pixels. It prints numbers only, never a path or a name.
//!
//! The owner's files are not touched; the catalog is copied into the scratch folder twice, and the
//! second copy has its duplicate resolutions marked undone, which is the ranking with no history.
//!
//! ```sh
//! cargo run --release -p oriel-core-tidy --example folder_priority -- <catalog> <scratch>
//! ```

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use futures::executor::block_on;
use oriel_core_paths::DataRoot;
use oriel_core_tidy::contract::{
    DuplicateScope, DuplicateSet, DuplicateSetRequest, FileId, KeepReason,
};
use oriel_core_tidy::{Media, TidyEngine};
use rusqlite::{Connection, OpenFlags};

fn copy_catalog(catalog: &str, folder: &Path, forget_history: bool) -> PathBuf {
    let _ = std::fs::remove_dir_all(folder);
    std::fs::create_dir_all(folder).unwrap();
    let copy = folder.join("catalog.sqlite");
    Connection::open_with_flags(catalog, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .unwrap()
        .execute_batch(&format!("VACUUM INTO '{}'", copy.display()))
        .unwrap();
    let connection = Connection::open(&copy).unwrap();
    // Opened, the engine recovers a change under way, which the owner's app may be running.
    connection
        .execute(
            "UPDATE plans SET status = 'cancelled' WHERE status = 'applying'",
            [],
        )
        .unwrap();
    if forget_history {
        connection
            .execute(
                "UPDATE plan_steps SET status = 'undone' WHERE plan_id IN
                   (SELECT id FROM plans WHERE kind = 'resolve-duplicates')",
                [],
            )
            .unwrap();
    }
    copy
}

fn open_sets(catalog: &str, folder: &Path, forget_history: bool) -> Vec<DuplicateSet> {
    let copy = copy_catalog(catalog, folder, forget_history);
    let data = DataRoot::at(folder.join("data")).unwrap();
    let engine = block_on(TidyEngine::open_with(data, copy, Media::locate())).unwrap();
    let settings = block_on(engine.settings()).unwrap();
    let mut sets = Vec::new();
    for root in block_on(engine.roots()).unwrap() {
        sets.extend(
            block_on(engine.duplicate_sets(DuplicateSetRequest {
                root_id: Some(root.id),
                offset: 0,
                limit: 1_000_000,
                level: settings.similarity,
                scope: DuplicateScope::All,
                dismissed: false,
            }))
            .unwrap()
            .sets,
        );
    }
    sets
}

fn pixels_kept(set: &DuplicateSet, keep: &[FileId]) -> i64 {
    set.versions
        .iter()
        .flat_map(|version| &version.files)
        .filter(|file| keep.contains(&file.id))
        .map(|file| file.width.unwrap_or(0) * file.height.unwrap_or(0))
        .sum()
}

fn main() {
    let mut args = std::env::args().skip(1);
    let (Some(catalog), Some(scratch)) = (args.next(), args.next()) else {
        eprintln!("usage: folder_priority <catalog> <scratch>");
        std::process::exit(2);
    };
    let scratch = PathBuf::from(scratch);
    let now = open_sets(&catalog, &scratch.join("with-history"), false);
    let before = open_sets(&catalog, &scratch.join("without-history"), true);
    let before: HashMap<&str, &DuplicateSet> =
        before.iter().map(|set| (set.key.as_str(), set)).collect();

    let spanning = now.iter().filter(|set| set.folders.len() > 1).count();
    let by_folder = now
        .iter()
        .filter(|set| set.keep_reason == KeepReason::FolderPriority)
        .count();
    let mut compared = 0;
    let mut changed = 0;
    let mut fewer_pixels = 0;
    for set in &now {
        let Some(old) = before.get(set.key.as_str()) else {
            continue;
        };
        compared += 1;
        let (mut keep, mut old_keep) = (set.keep.clone(), old.keep.clone());
        keep.sort_unstable();
        old_keep.sort_unstable();
        if keep != old_keep {
            changed += 1;
            if pixels_kept(set, &keep) < pixels_kept(set, &old_keep) {
                fewer_pixels += 1;
            }
        }
    }
    let recorded = now
        .iter()
        .filter(|set| set.folders.iter().any(|folder| folder.standing.is_some()))
        .count();
    println!("Open sets: {}", now.len());
    println!("Spanning two folders or more: {spanning}");
    println!("With a standing between folder 1 and another: {recorded}");
    println!("Decided by folder priority: {by_folder}");
    println!("Suggestions changed, of {compared} in both: {changed}");
    println!("Of those, keeping fewer pixels than before: {fewer_pixels}");
}
