import type { FileId, OptimizeCategory, RootId, Tidy } from "@latch-works/glazier-core/contract";

import { type PlanStep, planned } from "../../lib/actions";
import { call } from "../../lib/api";

/** Every video measured as silent. */
export async function silentVideoIds(rootId: RootId): Promise<FileId[]> {
  const { ids } = await call("listFileIds", {
    rootId,
    search: "",
    kinds: ["video"],
    formats: [],
    audioStates: ["silent"],
    flags: [],
    dir: null,
  });

  return ids;
}

/**
 * Tidy up's plans, in the order they run: Clean up, then silent soundtracks, then Convert.
 * `performAll` builds and drafts each once the one before has finished, so the silent videos are
 * listed from what Clean up left. Duplicates are not a step, identical copies included: which
 * copy to keep depends on where each one is, so the owner decides every set in Duplicates, and
 * Convert leaves their files alone until then.
 */
export function tidyUpSteps(
  rootId: RootId,
  tidy: Tidy,
  categories: readonly OptimizeCategory[],
): PlanStep[] {
  const steps: PlanStep[] = [];
  const { junk, emptyFolders, extensions } = tidy.cleanup;

  if (junk + emptyFolders + extensions > 0) {
    steps.push(planned({ kind: "cleanup", rootId }));
  }

  if (tidy.silentTracks.files > 0) {
    steps.push(async () => {
      const ids = await silentVideoIds(rootId);

      return ids.length > 0 ? { kind: "strip-audio", fileIds: ids } : null;
    });
  }

  if (categories.length > 0) {
    steps.push(planned({ kind: "optimize", rootId, categories: [...categories], fileIds: null }));
  }

  return steps;
}
