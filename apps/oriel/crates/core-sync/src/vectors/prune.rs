//! `prune.json`, written from `pruneDeleted`: prune must go ahead with and skip the same deletes
//! of a plan, and reuse a folder listing no sooner.

use std::fs;
use std::path::Path;

use oriel_core_domain::MediaItem;
use serde::Deserialize;

use super::{media_item, read_vectors, symlink};

use crate::prune::{
    BACK_IN_SOURCE_REASON, DirectoryAliasIndex, is_absent_locally, listing_is_reusable,
    planned_local_paths,
};
use crate::sync_plan::{RemoteEntrySnapshot, SyncPlanAction, create_sync_plan};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PruneVectors {
    cases: Vec<PruneCase>,
    racy_listings: Vec<RacyListing>,
}

#[derive(Deserialize)]
struct PruneCase {
    name: String,
    local: Vec<String>,
    remote: Vec<String>,
    tree: Vec<TreeEntry>,
    deletes: Vec<Delete>,
}

#[derive(Deserialize)]
struct TreeEntry {
    path: String,
    kind: String,
}

#[derive(Deserialize, Debug, PartialEq)]
struct Delete {
    path: String,
    outcome: String,
    reason: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RacyListing {
    name: String,
    listed_at_ns: String,
    modified_ns: String,
    changed_ns: String,
    reused: bool,
}

fn vectors() -> PruneVectors {
    read_vectors("prune.json")
}

/// The source folder at prune time: files, folders, and links to a file outside it.
fn make_tree(root: &Path, tree: &[TreeEntry]) {
    fs::create_dir_all(root).unwrap();
    let outside = root.parent().unwrap().join("outside.jpg");
    fs::write(&outside, "x").unwrap();
    for entry in tree {
        let path = root.join(&entry.path);
        match entry.kind.as_str() {
            "directory" => fs::create_dir_all(&path).unwrap(),
            "file" => {
                fs::create_dir_all(path.parent().unwrap()).unwrap();
                fs::write(&path, "x").unwrap();
            }
            "symlink" => {
                fs::create_dir_all(path.parent().unwrap()).unwrap();
                symlink(&outside, &path);
            }
            other => panic!("unknown kind {other}"),
        }
    }
}

#[test]
fn prunes_as_lockstep_core_does() {
    let scratch = tempfile::tempdir().unwrap();
    for (index, case) in vectors().cases.iter().enumerate() {
        let root = scratch.path().join(index.to_string()).join("source");
        make_tree(&root, &case.tree);
        let local: Vec<MediaItem> = case
            .local
            .iter()
            .map(|path| media_item(path, 1, None))
            .collect();
        let remote: Vec<RemoteEntrySnapshot> = case
            .remote
            .iter()
            .map(|path| RemoteEntrySnapshot {
                path: path.clone(),
                sha256: None,
                size: 1,
            })
            .collect();
        let plan = create_sync_plan(&local, &remote);
        let planned = planned_local_paths(&plan.items);
        let mut index = DirectoryAliasIndex::new(root.clone());
        let deletes: Vec<Delete> = plan
            .items
            .iter()
            .filter(|item| item.action == SyncPlanAction::Delete)
            .map(|item| {
                let absent = is_absent_locally(&root, &item.path, &planned, &mut index).unwrap();
                Delete {
                    path: item.path.clone(),
                    outcome: if absent { "deleted" } else { "skipped" }.to_owned(),
                    reason: (!absent).then(|| BACK_IN_SOURCE_REASON.to_owned()),
                }
            })
            .collect();
        assert_eq!(deletes, case.deletes, "{}", case.name);
    }
}

#[test]
fn reuses_folder_listings_as_lockstep_core_does() {
    let ns = |text: &str| text.parse::<i128>().expect("nanoseconds in prune.json");
    for listing in vectors().racy_listings {
        assert_eq!(
            listing_is_reusable(
                ns(&listing.listed_at_ns),
                ns(&listing.modified_ns),
                ns(&listing.changed_ns)
            ),
            listing.reused,
            "{}",
            listing.name
        );
    }
}
