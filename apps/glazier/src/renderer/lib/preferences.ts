import type { RootId } from "@latch-works/glazier-core/contract";
import { useCallback } from "react";

import { useToasts } from "../components/Toasts";
import { useActions } from "./actions";
import { useEngine } from "./engine-state";

/** Makes a folder preferred for duplicate review, with a toast and ⌘Z to take it back. */
export function usePreferFolder(rootId: RootId): (dir: string) => Promise<void> {
  const { settings, setSettings } = useEngine();
  const actions = useActions();
  const toasts = useToasts();

  return useCallback(
    async (dir: string) => {
      if (!settings) {
        return;
      }

      const label = dir || "the top folder";

      if (settings.preferredFolders.some((entry) => entry.rootId === rootId && entry.dir === dir)) {
        toasts.show({ message: `${label} is already preferred`, tone: "info" });

        return;
      }

      const before = settings;

      await setSettings({
        ...settings,
        preferredFolders: [...settings.preferredFolders, { rootId, dir }],
      });

      const undo = () => setSettings(before);

      actions.pushUndo(undo);
      toasts.show({
        message: `Preferring ${label}`,
        detail: "Duplicate sets keep their copy there first.",
        action: { label: "Undo", run: () => void undo() },
      });
    },
    [settings, setSettings, rootId, actions, toasts],
  );
}
