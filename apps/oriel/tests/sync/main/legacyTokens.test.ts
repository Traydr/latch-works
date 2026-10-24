import { createCipheriv, pbkdf2Sync, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  FileSecretStorage,
  fileSecretKeyPath,
} from "../../../src/modes/sync/main/services/fileSecretStorage";
import {
  decryptLegacyToken,
  type LegacyKey,
  macLegacyKey,
} from "../../../src/modes/sync/main/services/legacyTokens";
import { ProfileService } from "../../../src/modes/sync/main/services/profileService";

const TOKEN = "lw-sync-0123456789abcdef";

/** What Electron's `safeStorage` writes on macOS: Chromium's OSCrypt `v10` over AES-128-CBC. */
function macBlob(token: string, password: string): Buffer {
  const key = pbkdf2Sync(password, "saltysalt", 1003, 16, "sha1");
  const cipher = createCipheriv("aes-128-cbc", key, Buffer.alloc(16, 0x20));

  return Buffer.concat([Buffer.from("v10"), cipher.update(token, "utf8"), cipher.final()]);
}

/** And on Windows: `v10`, a 12-byte nonce, AES-256-GCM ciphertext and its tag. */
function windowsBlob(token: string, key: Buffer): Buffer {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const data = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);

  return Buffer.concat([Buffer.from("v10"), nonce, data, cipher.getAuthTag()]);
}

describe("the standalone Lockstep app's tokens", () => {
  it("open with the macOS Keychain password they were saved under", () => {
    expect(decryptLegacyToken(macBlob(TOKEN, "keychain-pw"), macLegacyKey("keychain-pw"))).toBe(
      TOKEN,
    );
    expect(decryptLegacyToken(macBlob(TOKEN, "keychain-pw"), macLegacyKey("other-pw"))).toBeNull();
  });

  it("open with the Windows key they were saved under", () => {
    const key = randomBytes(32);
    const legacy: LegacyKey = { kind: "windows", key };

    expect(decryptLegacyToken(windowsBlob(TOKEN, key), legacy)).toBe(TOKEN);
    expect(
      decryptLegacyToken(windowsBlob(TOKEN, key), { kind: "windows", key: randomBytes(32) }),
    ).toBeNull();
  });

  it("are left alone when they are not OSCrypt's", () => {
    expect(decryptLegacyToken(Buffer.from("plain text"), macLegacyKey("keychain-pw"))).toBeNull();
  });
});

describe("migrating them into Sync's key file", () => {
  let dataDir: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(path.join(os.tmpdir(), "oriel-legacy-tokens-"));
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it("re-saves a token the old app saved, once, and leaves one it cannot open", async () => {
    const key = macLegacyKey("keychain-pw");

    await writeFile(
      path.join(dataDir, "lockstep-settings.json"),
      JSON.stringify({
        activeProfileId: "home",
        profiles: [
          {
            apiUrl: "https://archive.example",
            encryptedToken: macBlob(TOKEN, "keychain-pw").toString("base64"),
            id: "home",
            name: "Home",
            sourceRoot: "/archive",
          },
          {
            apiUrl: "https://backup.example",
            encryptedToken: macBlob(TOKEN, "a-key-long-gone").toString("base64"),
            id: "backup",
            name: "Backup",
            sourceRoot: "/archive",
          },
        ],
      }),
    );

    const service = () =>
      new ProfileService(dataDir, {
        legacyConfigPath: path.join(dataDir, "no-legacy-config.json"),
        secretStorage: new FileSecretStorage(fileSecretKeyPath(dataDir, {})),
      });

    const first = service();
    await first.init();

    const decrypt = (encrypted: Buffer) => decryptLegacyToken(encrypted, key);

    expect(await first.migrateLegacyTokens(decrypt)).toEqual({ migrated: 1, failed: 1 });
    expect(first.getApiToken("home")).toBe(TOKEN);
    expect(first.getSettings().profiles.map((profile) => profile.tokenUnreadable)).toEqual([
      false,
      true,
    ]);

    // Saved for good: a new start reads it with the key file, and has nothing left to migrate.
    const again = service();
    await again.init();

    expect(again.getApiToken("home")).toBe(TOKEN);
    expect(await again.migrateLegacyTokens(decrypt)).toEqual({ migrated: 0, failed: 1 });
    expect(await readFile(path.join(dataDir, "lockstep-settings.json"), "utf8")).not.toContain(
      TOKEN,
    );
  });
});
