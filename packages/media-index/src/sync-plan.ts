import { type MediaItem, normalizePathForCompare } from "@latch-works/media-domain";

export interface RemoteEntrySnapshot {
  path: string;
  sha256?: string;
  size: number;
}

export type SyncPlanAction = "upload" | "update" | "keep" | "delete";

export interface SyncPlanItem {
  action: SyncPlanAction;
  local?: MediaItem;
  remote?: RemoteEntrySnapshot;
  path: string;
}

export interface SyncPlan {
  counts: Record<SyncPlanAction, number>;
  items: SyncPlanItem[];
}

export function createSyncPlan(
  localItems: readonly MediaItem[],
  remoteEntries: readonly RemoteEntrySnapshot[] = [],
): SyncPlan {
  const remoteByPath = new Map(
    remoteEntries.map((entry) => [normalizePathForCompare(entry.path), entry]),
  );
  const localByPath = new Map(localItems.map((item) => [normalizePathForCompare(item.path), item]));
  const items: SyncPlanItem[] = [];

  for (const local of localItems) {
    const remote = remoteByPath.get(normalizePathForCompare(local.path));
    if (!remote) {
      items.push({ action: "upload", local, path: local.path });
      continue;
    }

    if (
      remote.size !== local.size ||
      (remote.sha256 !== undefined && local.sha256 !== undefined && remote.sha256 !== local.sha256)
    ) {
      items.push({ action: "update", local, path: local.path, remote });
      continue;
    }

    items.push({ action: "keep", local, path: local.path, remote });
  }

  for (const remote of remoteEntries) {
    if (!localByPath.has(normalizePathForCompare(remote.path))) {
      items.push({ action: "delete", path: remote.path, remote });
    }
  }

  return {
    counts: {
      upload: items.filter((item) => item.action === "upload").length,
      update: items.filter((item) => item.action === "update").length,
      keep: items.filter((item) => item.action === "keep").length,
      delete: items.filter((item) => item.action === "delete").length,
    },
    items,
  };
}
