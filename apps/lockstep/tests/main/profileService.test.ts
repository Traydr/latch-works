import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const encryptString = vi.fn((value: string) => Buffer.from(value, "utf-8"));

vi.mock("electron", () => ({
  safeStorage: {
    decryptString: vi.fn((buffer: Buffer) => buffer.toString("utf-8")),
    encryptString,
    isEncryptionAvailable: vi.fn(() => true),
  },
}));

describe("ProfileService", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "lockstep-profile-"));
    encryptString.mockClear();
    vi.resetModules();
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  async function createService() {
    const { ProfileService } = await import("../../src/main/services/profileService");
    const service = new ProfileService(tempDir, {
      legacyConfigPath: path.join(tempDir, "missing-legacy.json"),
    });
    await service.init();
    return service;
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

    expect(encryptString).toHaveBeenCalledWith("secret-token");
    expect(created.value.tokenConfigured).toBe(true);
    expect(created.value).not.toHaveProperty("token");

    const settings = service.getSettings();
    const profile = settings.profiles.find((entry) => entry.name === "Local");
    expect(profile?.tokenConfigured).toBe(true);
    expect(profile).not.toHaveProperty("token");
  });

  it("persists profiles to lockstep-settings.json", async () => {
    const service = await createService();

    await service.createProfile({
      apiUrl: "http://127.0.0.1:3000",
      name: "Local",
      sourceRoot: "/tmp/archive",
    });

    const raw = await readFile(path.join(tempDir, "lockstep-settings.json"), "utf-8");
    const parsed = JSON.parse(raw) as { profiles: Array<{ name: string }> };
    expect(parsed.profiles.some((profile) => profile.name === "Local")).toBe(true);
  });
});
