export {
  resolveHashFiles,
  resolveLocalFilePath,
  selectChangedItems,
  selectDeleteItems,
  selectUploadUpdateItems,
} from "@latch-works/lockstep-core";

/** @deprecated Use selectUploadUpdateItems from lockstep-core */
export function selectChangedItemsForPush<T extends { action: string }>(
  changedItems: T[],
  maxChanges?: number,
): { items: T[]; omittedDeleteCount: number } {
  const uploadUpdate = changedItems.filter(
    (item) => item.action === "upload" || item.action === "update",
  );
  if (!maxChanges || uploadUpdate.length <= maxChanges) {
    return { items: uploadUpdate, omittedDeleteCount: 0 };
  }
  const items = uploadUpdate.slice(0, maxChanges);
  const omittedDeletes = changedItems
    .slice(maxChanges)
    .filter((item) => item.action === "delete").length;
  return { items, omittedDeleteCount: omittedDeletes };
}
