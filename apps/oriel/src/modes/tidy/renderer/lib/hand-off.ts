import { useCallback } from "react";

import { type HandOffTarget, useShell } from "../../../../shell/shell";
import { useToasts } from "../components/Toasts";

/** Shows a file (in the viewer) or a folder in View, or says in a toast why it could not. */
export function useOpenInView(): (path: string, kind?: HandOffTarget["kind"]) => void {
  const { handOff } = useShell();
  const toasts = useToasts();

  return useCallback(
    (path, kind = "file") => {
      void handOff("view", { kind, path }).then((opened) => {
        if (!opened) {
          toasts.show({ message: "View could not open it", detail: path, tone: "error" });
        }
      });
    },
    [handOff, toasts],
  );
}
