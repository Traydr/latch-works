import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { ProfileService, type SecretStorage } from "../../src/main/services/profileService";

interface FakeSecretStorage extends SecretStorage {
  encrypted: string[];
  setEncryptionAvailable(available: boolean): void;
}

/** Mirrors Electron's `safeStorage`: base64-free round trip through a Buffer. */
function createSecretStorage(): FakeSecretStorage {
  let available = true;
  const encrypted: string[] = [];

  return {
    decryptString: (buffer: Buffer) => buffer.toString("utf-8"),
    encrypted,
    encryptString: (value: string) => {
      encrypted.push(value);

      return Buffer.from(value, "utf-8");
    },
    isEncryptionAvailable: () => available,
    setEncryptionAvailable: (next: boolean) => {
      available = next;
    },
  };
}

const PersistedFileSchema = z.object({
  activeProfileId: z.string().nullable(),
  profiles: z.array(
    z.object({
      encryptedToken: z.string().optional(),
      id: z.string(),
      lastRun: z.object({ action: z.string() }).optional(),
      name: z.string(),
    }),
  ),
});

describe("ProfileService", () => {
  let tempDir: string;
  let secretStorage: FakeSecretStorage;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "lockstep-profile-"));
    secretStorage = createSecretStorage();
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  async function createService() {
    const service = new ProfileService(tempDir, {
      legacyConfigPath: path.join(tempDir, "missing-legacy.json"),
      secretStorage,
    });

    await service.init();

    return service;
  }

  async function readPersistedFile() {
    const raw = await readFile(path.join(tempDir, "lockstep-settings.json"), "utf-8");

    return PersistedFileSchema.parse(JSON.parse(raw));
  }

  it("stores profiles without exposing tokens to public settings", async () => {
    const service = await createService();

    const created = await service.createProfile({
      apiUrl: "http://127.0.0.1:3000",
      name: "Local",
      sourceRoot: "/tmp/archive",
      token: "secret-token",
    });

    expect(created.status).toBe("ok");

    if (created.status !== "ok") {
      return;
    }

    expect(secretStorage.encrypted).toContain("secret-token");
    expect(created.value.tokenConfigured).toBe(true);
    expect(created.value.tokenInSession).toBe(false);
    expect(created.value.tokenUnreadable).toBe(false);
    expect(created.value).not.toHaveProperty("token");

    const settings = service.getSettings();
    const profile = settings.profiles.find((entry) => entry.name === "Local");
    expect(profile?.tokenConfigured).toBe(true);
    expect(profile).not.toHaveProperty("token");
  });

  it("marks stored tokens unreadable when OS encryption is unavailable", async () => {
    const service = await createService();

    const created = await service.createProfile({
      apiUrl: "http://127.0.0.1:3000",
      name: "Remote",
      sourceRoot: "/tmp/archive",
      token: "secret-token",
    });

    expect(created.status).toBe("ok");

    if (created.status !== "ok") {
      return;
    }

    secretStorage.setEncryptionAvailable(false);

    const reloaded = new ProfileService(tempDir, {
      legacyConfigPath: path.join(tempDir, "missing-legacy.json"),
      secretStorage,
    });

    await reloaded.init();

    const profile = reloaded.getSettings().profiles[0];
    expect(profile?.tokenConfigured).toBe(false);
    expect(profile?.tokenUnreadable).toBe(true);
    expect(profile?.tokenInSession).toBe(false);
    expect(reloaded.getApiToken(created.value.id)).toBeUndefined();
  });

  it("clears persisted encryptedToken when updating a token without OS encryption", async () => {
    const service = await createService();

    const created = await service.createProfile({
      apiUrl: "http://127.0.0.1:3000",
      name: "Local",
      sourceRoot: "/tmp/archive",
      token: "old-token",
    });

    expect(created.status).toBe("ok");

    if (created.status !== "ok") {
      return;
    }

    secretStorage.setEncryptionAvailable(false);
    const updated = await service.updateProfile(created.value.id, { token: "session-token" });
    expect(updated.status).toBe("ok");
    expect(service.getApiToken(created.value.id)).toBe("session-token");

    const parsed = await readPersistedFile();
    const persisted = parsed.profiles.find((profile) => profile.id === created.value.id);
    expect(persisted?.encryptedToken).toBeUndefined();
  });

  it("clears session tokens when deleting a profile", async () => {
    secretStorage.setEncryptionAvailable(false);

    const service = await createService();

    const created = await service.createProfile({
      apiUrl: "http://127.0.0.1:3000",
      name: "Local",
      sourceRoot: "/tmp/archive",
      token: "session-token",
    });

    expect(created.status).toBe("ok");

    if (created.status !== "ok") {
      return;
    }

    expect(service.getApiToken(created.value.id)).toBe("session-token");
    await service.deleteProfile(created.value.id);
    expect(service.getApiToken(created.value.id)).toBeUndefined();
  });

  it("loads a settings file written by an earlier run", async () => {
    await writeFile(
      path.join(tempDir, "lockstep-settings.json"),
      `${JSON.stringify({
        activeProfileId: "profile-1",
        profiles: [
          {
            apiUrl: "http://127.0.0.1:3000",
            encryptedToken: Buffer.from("secret-token").toString("base64"),
            id: "profile-1",
            name: "Remote",
            sourceRoot: "/tmp/archive",
          },
        ],
      })}\n`,
      "utf-8",
    );

    const service = await createService();
    const settings = service.getSettings();
    expect(settings.activeProfileId).toBe("profile-1");
    expect(settings.profiles[0]?.name).toBe("Remote");
    expect(settings.profiles[0]?.tokenConfigured).toBe(true);
  });

  it("fails init when the settings file does not match the persisted schema", async () => {
    await writeFile(
      path.join(tempDir, "lockstep-settings.json"),
      JSON.stringify({ activeProfileId: null, profiles: "not-an-array" }),
      "utf-8",
    );

    const service = new ProfileService(tempDir, {
      legacyConfigPath: path.join(tempDir, "missing-legacy.json"),
      secretStorage,
    });

    const result = await service.init();

    expect(result.status).toBe("error");
    expect(service.getSettings()).toEqual({ activeProfileId: null, profiles: [] });
  });

  it("persists profiles to lockstep-settings.json", async () => {
    const service = await createService();

    await service.createProfile({
      apiUrl: "http://127.0.0.1:3000",
      name: "Local",
      sourceRoot: "/tmp/archive",
    });

    const parsed = await readPersistedFile();
    expect(parsed.profiles.some((profile) => profile.name === "Local")).toBe(true);
  });

  describe("editing and deleting profiles", () => {
    async function createProfile(
      service: ProfileService,
      name: string,
      token: string | undefined = "secret-token",
    ) {
      const created = await service.createProfile({
        apiUrl: "http://127.0.0.1:3000",
        name,
        sourceRoot: `/tmp/${name}`,
        token,
      });

      if (created.status !== "ok") {
        throw new Error(`createProfile failed: ${created.error.message}`);
      }

      return created.value;
    }

    const lastRun = {
      action: "plan",
      completedAt: "2026-09-25T00:00:00.000Z",
      failed: 0,
      pushed: 0,
      status: "completed",
    } as const;

    it("renames a profile, keeping its token and last run", async () => {
      const service = await createService();
      const profile = await createProfile(service, "Local");
      await service.recordLastRun(profile.id, lastRun);

      const updated = await service.updateProfile(profile.id, { name: "Renamed", token: "" });

      expect(updated.status).toBe("ok");
      expect(service.getApiToken(profile.id)).toBe("secret-token");
      expect(service.getSettings().profiles[0]).toMatchObject({
        name: "Renamed",
        sourceRoot: "/tmp/Local",
        tokenConfigured: true,
      });
      expect(service.getSettings().profiles[0]?.lastRun?.action).toBe("plan");
    });

    it("drops the last run once the source folder or API URL moves", async () => {
      const service = await createService();
      const first = await createProfile(service, "First");
      const second = await createProfile(service, "Second");
      await service.recordLastRun(first.id, lastRun);
      await service.recordLastRun(second.id, lastRun);

      await service.updateProfile(first.id, { sourceRoot: "/tmp/moved" });
      await service.updateProfile(second.id, { apiUrl: "https://pane.example.com" });

      const persisted = await readPersistedFile();
      expect(persisted.profiles.map((profile) => profile.lastRun)).toEqual([undefined, undefined]);
      expect(service.getSettings().profiles.map((profile) => profile.lastRun)).toEqual([
        undefined,
        undefined,
      ]);
    });

    it("replaces the saved token with a new one", async () => {
      const service = await createService();
      const profile = await createProfile(service, "Local");

      await service.updateProfile(profile.id, { token: "new-token" });

      expect(service.getApiToken(profile.id)).toBe("new-token");
      const persisted = await readPersistedFile();
      expect(Buffer.from(persisted.profiles[0]?.encryptedToken ?? "", "base64").toString()).toBe(
        "new-token",
      );
    });

    it("saves a new token securely over one only held in memory", async () => {
      secretStorage.setEncryptionAvailable(false);
      const service = await createService();
      const profile = await createProfile(service, "Local", "session-token");
      secretStorage.setEncryptionAvailable(true);

      const updated = await service.updateProfile(profile.id, { token: "saved-token" });

      expect(service.getApiToken(profile.id)).toBe("saved-token");
      expect(updated.status === "ok" && updated.value.tokenInSession).toBe(false);
    });

    it("forgets the saved token on clearToken", async () => {
      const service = await createService();
      const profile = await createProfile(service, "Local");

      const updated = await service.updateProfile(profile.id, { clearToken: true });

      expect(updated.status === "ok" && updated.value.tokenConfigured).toBe(false);
      expect(service.getApiToken(profile.id)).toBeUndefined();
      const persisted = await readPersistedFile();
      expect(persisted.profiles[0]?.encryptedToken).toBeUndefined();
    });

    it("rejects edits to a profile that does not exist", async () => {
      const service = await createService();

      const updated = await service.updateProfile("missing", { name: "Ghost" });

      expect(updated.status).toBe("error");
    });

    it("deletes a profile with its saved token and activates its neighbour", async () => {
      const service = await createService();
      const first = await createProfile(service, "First");
      const second = await createProfile(service, "Second");
      const third = await createProfile(service, "Third");
      await service.setActiveProfile(second.id);

      const deleted = await service.deleteProfile(second.id);

      expect(deleted.status === "ok" && deleted.value.activeProfileId).toBe(third.id);
      const persisted = await readPersistedFile();
      expect(persisted.profiles.map((profile) => profile.id)).toEqual([first.id, third.id]);
      expect(persisted.activeProfileId).toBe(third.id);

      await service.deleteProfile(third.id);
      expect(service.getSettings().activeProfileId).toBe(first.id);
    });

    it("keeps the active profile when deleting another one", async () => {
      const service = await createService();
      const first = await createProfile(service, "First");
      const second = await createProfile(service, "Second");

      await service.deleteProfile(second.id);

      expect(service.getSettings().activeProfileId).toBe(first.id);
    });

    it("leaves no active profile once the last one is deleted", async () => {
      const service = await createService();
      const profile = await createProfile(service, "Only");

      const deleted = await service.deleteProfile(profile.id);

      expect(deleted.status === "ok" && deleted.value).toEqual({
        activeProfileId: null,
        profiles: [],
      });
      expect(await readPersistedFile()).toEqual({ activeProfileId: null, profiles: [] });
    });

    it("rejects deleting a profile that does not exist", async () => {
      const service = await createService();
      await createProfile(service, "Local");

      const deleted = await service.deleteProfile("missing");

      expect(deleted.status).toBe("error");
      expect(service.getSettings().profiles).toHaveLength(1);
    });
  });
});
