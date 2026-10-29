/*
 * Sync's tokens in the same format in Electron Oriel and Oriel RS (plan 063, "Same formats"):
 * each writes a profile with a token through its own storage, and reads the other's files. This
 * suite writes Electron Oriel's into apps/oriel-rs/conformance/lockstep-core/secret-storage/electron
 * when updating and reads Oriel RS's from .../oriel-rs, which `cargo test -p oriel-mode-sync
 * --test secrets` writes. The token and its key are made for this check alone:
 *
 *   ORIEL_RS_UPDATE_VECTORS=1 pnpm --filter @latch-works/oriel exec vitest run \
 *     tests/sync/main/secretStorage.conformance.test.ts
 */
import { copyFile, mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Result } from "better-result";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FileSecretStorage } from "../../../src/modes/sync/main/services/fileSecretStorage";
import { ProfileService } from "../../../src/modes/sync/main/services/profileService";

const conformance = fileURLToPath(
  new URL("../../../../oriel-rs/conformance/lockstep-core/secret-storage/", import.meta.url),
);

const updating = process.env.ORIEL_RS_UPDATE_VECTORS === "1";

const FILES = ["lockstep-settings.json", "secret-storage.key"];

/** What both implementations save: a made-up token, never a real one. */
const TOKEN = "conformance-sync-token-0123456789abcdef";

const PROFILE = {
  apiUrl: "http://127.0.0.1:3100",
  name: "Conformance archive",
  sourceRoot: "/Volumes/Archive",
};

function openService(folder: string): ProfileService {
  return new ProfileService(folder, {
    legacyConfigPath: null,
    secretStorage: new FileSecretStorage(path.join(folder, "secret-storage.key")),
  });
}

describe("Sync's secret storage, Electron Oriel against Oriel RS", () => {
  let folder: string;

  beforeEach(async () => {
    folder = await mkdtemp(path.join(os.tmpdir(), "oriel-secret-conformance-"));
  });

  afterEach(async () => {
    await rm(folder, { force: true, recursive: true });
  });

  it("writes a token it reads back, sealed under a 0600 key, never in the clear", async () => {
    const service = openService(folder);
    expect(Result.isOk(await service.init())).toBe(true);
    expect(Result.isOk(await service.createProfile({ ...PROFILE, token: TOKEN }))).toBe(true);

    const settings = await readFile(path.join(folder, "lockstep-settings.json"), "utf8");
    expect(settings).toContain(PROFILE.name);
    expect(settings).not.toContain(TOKEN);
    const key = await stat(path.join(folder, "secret-storage.key"));
    expect(key.size).toBe(32);
    expect(key.mode & 0o777).toBe(0o600);

    const reopened = openService(folder);
    await reopened.init();
    const [profile] = reopened.getSettings().profiles;
    expect(profile?.tokenConfigured).toBe(true);
    expect(reopened.getApiToken(profile?.id ?? "")).toBe(TOKEN);

    if (updating) {
      const target = path.join(conformance, "electron");
      await mkdir(target, { recursive: true });

      for (const file of FILES) {
        await copyFile(path.join(folder, file), path.join(target, file));
      }
    }
  });

  it("reads the profile and token Oriel RS wrote", async () => {
    for (const file of FILES) {
      await copyFile(path.join(conformance, "oriel-rs", file), path.join(folder, file));
    }

    const service = openService(folder);
    expect(Result.isOk(await service.init())).toBe(true);
    const { activeProfileId, profiles } = service.getSettings();
    expect(profiles).toHaveLength(1);
    const [profile] = profiles;
    expect(profile).toMatchObject({ ...PROFILE, tokenConfigured: true, tokenUnreadable: false });
    expect(activeProfileId).toBe(profile?.id);
    expect(service.getApiToken(profile?.id ?? "")).toBe(TOKEN);
  });
});
