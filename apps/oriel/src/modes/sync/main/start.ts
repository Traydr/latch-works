import { Result } from "better-result";
import { app, dialog } from "electron";

import type { ModeContext, ModeHost } from "../../../main/mode";
import type { LockstepProfileInput, LockstepRunEvent } from "../shared/types";
import { registerIpc } from "./ipc/registerIpc";
import { FileSecretStorage, fileSecretKeyPath } from "./services/fileSecretStorage";
import { decryptLegacyToken, readLegacyKey } from "./services/legacyTokens";
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
interface SyncHost extends ModeHost {
  /** How many profiles hold a token Sync cannot read, such as one the old app saved. */
  unreadableTokens(): number;
  /** Re-saves the tokens the standalone Lockstep app saved, with the key it used. */
  migrateLegacyTokens(): Promise<{ migrated: number; failed: number }>;
  /** Every profile's archive folder. */
  sourceRoots(): string[];
  /** Saves a profile, as the welcome's Pane View step does; resolves the problem, or null. */
  addProfile(input: LockstepProfileInput): Promise<string | null>;
}

export async function startSync({ dataDir, window, onProgress }: ModeContext): Promise<SyncHost> {
  const profileService = new ProfileService(dataDir, {
    // A data folder of its own (the e2e suite) takes nothing from the real ~/.latch-works.
    legacyConfigPath: app.commandLine.hasSwitch("user-data-dir") ? null : undefined,
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

  const unreadableTokens = () =>
    profileService.getSettings().profiles.filter((profile) => profile.tokenUnreadable).length;

  return {
    busy: () => {
      const run = runService.getActiveRun();

      // Plan and Doctor only read; a push or prune changes the server.
      return run?.action === "push" || run?.action === "prune";
    },
    unreadableTokens,
    migrateLegacyTokens: async () => {
      const key = await readLegacyKey(dataDir);

      if (!key) {
        return { migrated: 0, failed: unreadableTokens() };
      }

      return profileService.migrateLegacyTokens((encrypted) => decryptLegacyToken(encrypted, key));
    },
    addProfile: async (input) => {
      const created = await profileService.createProfile(input);

      return Result.isError(created) ? created.error.message : null;
    },
    sourceRoots: () =>
      profileService
        .getSettings()
        .profiles.flatMap((profile) => (profile.sourceRoot ? [profile.sourceRoot] : [])),
  };
}
