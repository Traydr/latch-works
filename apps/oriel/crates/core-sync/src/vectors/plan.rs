//! `plan.json`, written from `createSyncPlan` and what push, prune and hashing take from a plan.

use oriel_core_domain::MediaItem;
use serde::Deserialize;

use super::{media_item, read_vectors};
use crate::plan::{HashMode, planned_deletes, planned_uploads, select_planning_hash_paths};
use crate::sync_plan::{PlanCounts, RemoteEntrySnapshot, SyncPlanAction, create_sync_plan};

#[derive(Deserialize)]
struct Entry {
    path: String,
    size: u64,
    sha256: Option<String>,
}

#[derive(Deserialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
struct PlanItem {
    action: String,
    path: String,
    local_path: Option<String>,
    local_size: Option<u64>,
    remote_path: Option<String>,
}

#[derive(Deserialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
struct Selection {
    max_changes: Option<usize>,
    paths: Vec<String>,
    omitted_count: usize,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct HashPaths {
    all: Vec<String>,
    remote_aware: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PlanCase {
    name: String,
    local: Vec<Entry>,
    remote: Vec<Entry>,
    items: Vec<PlanItem>,
    counts: PlanCounts,
    hash_paths: HashPaths,
    push: Vec<Selection>,
    prune: Vec<Selection>,
    planned_local_paths: Vec<String>,
}

#[derive(Deserialize)]
struct PlanVectors {
    cases: Vec<PlanCase>,
}

#[test]
fn plans_as_lockstep_core_does() {
    let vectors: PlanVectors = read_vectors("plan.json");
    for case in vectors.cases {
        let local: Vec<MediaItem> = case
            .local
            .iter()
            .map(|entry| media_item(&entry.path, entry.size, entry.sha256.as_deref()))
            .collect();
        let remote: Vec<RemoteEntrySnapshot> = case
            .remote
            .iter()
            .map(|entry| RemoteEntrySnapshot {
                path: entry.path.clone(),
                sha256: entry.sha256.clone(),
                size: entry.size,
            })
            .collect();
        let plan = create_sync_plan(&local, &remote);
        let items: Vec<PlanItem> = plan
            .items
            .iter()
            .map(|item| PlanItem {
                action: item.action.as_str().to_owned(),
                path: item.path.clone(),
                local_path: item.local.as_ref().map(|local| local.path.clone()),
                local_size: item.local.as_ref().map(|local| local.size),
                remote_path: item.remote.as_ref().map(|remote| remote.path.clone()),
            })
            .collect();
        assert_eq!(items, case.items, "{}: the plan's items", case.name);

        assert_eq!(plan.counts, case.counts, "{}: the counts", case.name);

        assert_eq!(
            select_planning_hash_paths(HashMode::All, &local, &remote),
            case.hash_paths.all,
            "{}: what `all` hashes",
            case.name
        );
        assert_eq!(
            select_planning_hash_paths(HashMode::RemoteAware, &local, &remote),
            case.hash_paths.remote_aware,
            "{}: what `remote-aware` hashes",
            case.name
        );

        let select = |pick: &dyn Fn(Option<usize>) -> (Vec<String>, usize)| {
            [None, Some(1), Some(2)]
                .into_iter()
                .map(|max_changes| {
                    let (paths, omitted_count) = pick(max_changes);
                    Selection {
                        max_changes,
                        paths,
                        omitted_count,
                    }
                })
                .collect::<Vec<_>>()
        };
        let push = select(&|max| {
            let (items, omitted) = planned_uploads(&plan.items, max);
            (
                items.iter().map(|item| item.path.clone()).collect(),
                omitted,
            )
        });
        let prune = select(&|max| {
            let (items, omitted) = planned_deletes(&plan.items, max);
            (
                items.iter().map(|item| item.path.clone()).collect(),
                omitted,
            )
        });
        assert_eq!(push, case.push, "{}: what a push takes", case.name);
        assert_eq!(prune, case.prune, "{}: what a prune takes", case.name);

        let planned_local: Vec<String> = plan
            .items
            .iter()
            .filter(|item| item.action != SyncPlanAction::Delete)
            .map(|item| item.path.clone())
            .collect();
        assert_eq!(planned_local, case.planned_local_paths, "{}", case.name);
    }
}
