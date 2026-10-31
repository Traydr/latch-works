//! The sync plan, ported from `media-index`'s `sync-plan.ts`: each local item paired with Pane
//! View's entry for it, by `media-domain`'s path identities, and what a push does with each.

use std::collections::{HashMap, HashSet};

use oriel_core_domain::{MediaItem, pair_sync_paths};
use serde::{Deserialize, Serialize};

/// What Pane View holds at a path.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RemoteEntrySnapshot {
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sha256: Option<String>,
    pub size: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SyncPlanAction {
    Upload,
    Update,
    Keep,
    Delete,
}

/// One step of a plan. An upload has only `local`, a delete only `remote`.
#[derive(Clone, Debug, PartialEq)]
pub struct SyncPlanItem {
    pub action: SyncPlanAction,
    pub local: Option<MediaItem>,
    pub remote: Option<RemoteEntrySnapshot>,
    pub path: String,
}

#[derive(Clone, Debug, PartialEq)]
pub struct SyncPlan {
    pub items: Vec<SyncPlanItem>,
}

impl SyncPlan {
    /// How many steps take `action`.
    pub fn count(&self, action: SyncPlanAction) -> usize {
        self.items
            .iter()
            .filter(|item| item.action == action)
            .count()
    }
}

/// `createSyncPlan`: the local items in order, each an upload (no remote entry pairs with it),
/// an update (the size differs, or both hashes are known and differ) or a keep; then a delete
/// for every remote entry no local item paired with, in the remote order.
pub fn create_sync_plan(
    local_items: &[MediaItem],
    remote_entries: &[RemoteEntrySnapshot],
) -> SyncPlan {
    let local_paths: Vec<&str> = local_items.iter().map(|item| item.path.as_str()).collect();
    let remote_paths: Vec<&str> = remote_entries
        .iter()
        .map(|entry| entry.path.as_str())
        .collect();
    // A `Map` from local to remote path: a local path listed twice keeps its last pairing.
    let pairs: HashMap<&str, &str> = pair_sync_paths(&local_paths, &remote_paths)
        .into_iter()
        .collect();
    // A `Map` by path keeps the last entry of a path listed twice.
    let remote_by_path: HashMap<&str, &RemoteEntrySnapshot> = remote_entries
        .iter()
        .map(|entry| (entry.path.as_str(), entry))
        .collect();

    let mut items = Vec::with_capacity(local_items.len() + remote_entries.len());
    let mut matched_remote_paths = HashSet::new();

    for local in local_items {
        let remote = pairs
            .get(local.path.as_str())
            .and_then(|paired| remote_by_path.get(paired).copied());
        let Some(remote) = remote else {
            items.push(SyncPlanItem {
                action: SyncPlanAction::Upload,
                local: Some(local.clone()),
                remote: None,
                path: local.path.clone(),
            });
            continue;
        };
        matched_remote_paths.insert(remote.path.as_str());
        let changed = remote.size != local.size
            || matches!((&remote.sha256, &local.sha256), (Some(remote), Some(local)) if remote != local);
        items.push(SyncPlanItem {
            action: if changed {
                SyncPlanAction::Update
            } else {
                SyncPlanAction::Keep
            },
            local: Some(local.clone()),
            remote: Some(remote.clone()),
            path: local.path.clone(),
        });
    }

    for remote in remote_entries {
        // A remote entry no local path paired with is gone locally, including an alias or case
        // twin left over after its sibling paired.
        if !matched_remote_paths.contains(remote.path.as_str()) {
            items.push(SyncPlanItem {
                action: SyncPlanAction::Delete,
                local: None,
                remote: Some(remote.clone()),
                path: remote.path.clone(),
            });
        }
    }

    SyncPlan { items }
}
