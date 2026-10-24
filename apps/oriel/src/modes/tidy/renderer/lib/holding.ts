import type { RootId } from "@latch-works/glazier-core/contract";
import { useCallback } from "react";

import { useToasts } from "../components/Toasts";
import { desktop } from "./api";
import { useEngine } from "./engine-state";
import { formatBytes, plural } from "./format";

/**
 * Empties a root's holding into the system Trash, without asking: the Trash is the safety net, as
 * Finder's Move to Trash is. Resolves with how many files went.
 */
export function useEmptyHolding(
  rootId: RootId,
): (held: { files: number; bytes: number }) => Promise<number> {
  const { report } = useEngine();
  const toasts = useToasts();

  return useCallback(
    async (held) => {
      try {
        const result = await desktop.emptyHolding(rootId);

        if (result.failed.length > 0) {
          toasts.show({
            message: `${plural(result.failed.length, "batch", "batches")} stayed in holding`,
            detail: result.failed[0] ?? null,
            tone: "error",
          });
        } else {
          toasts.show({
            message: `Moved ${plural(result.emptied, "file")} to the Trash`,
            detail: `${formatBytes(held.bytes)} freed once the Trash is emptied`,
          });
        }

        return result.emptied;
      } catch (error) {
        report(error);

        return 0;
      }
    },
    [report, rootId, toasts],
  );
}
