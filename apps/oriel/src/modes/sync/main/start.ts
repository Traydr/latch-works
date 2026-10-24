import { Result } from "better-result";
import { dialog } from "electron";

import type { ModeContext, ModeHost } from "../../../main/mode";
import type { LockstepRunEvent } from "../shared/types";
import { registerIpc } from "./ipc/registerIpc";
import { FileSecretStorage, fileSecretKeyPath } from "./services/fileSecretStorage";
import { ProfileService } from "./services/profileService";
import { type RunEventWindow, RunService } from "./services/runService";

/** How far a push or prune has got, from its item events. */
function runProgress(event: LockstepRunEvent): number | null | undefined {
  switch (event.type) {
    case "item-success":
    case "item-failure":
    case "item-skipped":
      return event.total > 0 ? event.current / event.total : undefined;
    case "complete":
    case "cancelled":
      return null;
    default:
      return undefined;
  }
}

/**
 * Starts Sync: Lockstep's profiles, runs and IPC, which live as long as the process. A run keeps
 * its controller when the window closes, and the shell keeps the app open until it ends.
 *
 * Tokens are encrypted with a key file in Sync's data folder on every platform, not with the
 * Keychain or DPAPI: an unsigned build's signature changes with each rebuild, and the Keychain
 * asked for access again every time.
 */
export async function startSync({ dataDir, window, onProgress }: ModeContext): Promise<ModeHost> {
  const profileService = new ProfileService(dataDir, {
    secretStorage: new FileSecretStorage(fileSecretKeyPath(dataDir)),
  });

  const initResult = await profileService.init();

  if (Result.isError(initResult)) {
    console.error(`[oriel:sync] ${initResult.error.message}`);
    dialog.showErrorBox("Sync could not load its profiles", initResult.error.message);
  }

  // Run events go to the window, and their progress to the Dock icon even while it is hidden.
  const events: RunEventWindow = {
    isDestroyed: () => false,
    webContents: {
      send: (channel, event) => {
        const progress = runProgress(event);

        if (progress !== undefined) {
          onProgress(progress);
        }

        const target = window();

        if (target && !target.isDestroyed()) {
          target.webContents.send(channel, event);
        }
      },
    },
  };

  const runService = new RunService(profileService, () => events);

  registerIpc(window, profileService, runService);

  return {
    busy: () => {
      const run = runService.getActiveRun();

      // Plan and Doctor only read; a push or prune changes the server.
      return run?.action === "push" || run?.action === "prune";
    },
  };
}
