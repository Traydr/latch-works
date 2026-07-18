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
  const items: SyncPlanItem[] = [];
  const matchedRemotePaths = new Set<string>();

  for (const local of localItems) {
    const remote = remoteByPath.get(normalizePathForCompare(local.path));
    if (!remote) {
      items.push({ action: "upload", local, path: local.path });
      continue;
    }

    matchedRemotePaths.add(remote.path);

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
    // Prefer matchedRemotePaths so alias/case duplicate remotes collapsed in remoteByPath
    // still plan as deletes after the surviving identity is kept/updated.
    if (!matchedRemotePaths.has(remote.path)) {
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
