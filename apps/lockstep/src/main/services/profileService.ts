import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { Result, type Result as ResultType } from "better-result";
import { z } from "zod";

import { LockstepRunSummarySchema } from "../../shared/contracts";
import type {
  LockstepProfileInput,
  LockstepProfilePatch,
  LockstepProfilePublic,
  LockstepRunSummary,
  LockstepSettings,
} from "../../shared/types";
import { type FileSystemError, toError, unexpectedFileSystemError } from "../errors";

/** Electron's `safeStorage`, narrowed to what profile persistence uses. */
export interface SecretStorage {
  decryptString(encrypted: Buffer): string;
  encryptString(plainText: string): Buffer;
  isEncryptionAvailable(): boolean;
}

const PersistedProfileSchema = z.object({
  apiUrl: z.string(),
  encryptedToken: z.string().optional(),
  id: z.string(),
  lastRun: LockstepRunSummarySchema.optional(),
  name: z.string(),
  sourceRoot: z.string(),
});

/** The on-disk `lockstep-settings.json` document. */
const PersistedStateSchema = z.object({
  activeProfileId: z.string().nullable(),
  profiles: z.array(PersistedProfileSchema),
});

/** The pre-profiles `~/.latch-works/lockstep.json` file, migrated once on first run. */
const LegacyLockstepConfigSchema = z.object({
  apiUrl: z.string().optional(),
  source: z.string().optional(),
});

type PersistedProfile = z.infer<typeof PersistedProfileSchema>;
type PersistedState = z.infer<typeof PersistedStateSchema>;

interface ProfileServiceOptions {
  legacyConfigPath?: string;
  secretStorage: SecretStorage;
}

export class ProfileService {
  private readonly filePath: string;
  private readonly legacyConfigPath: string;
  private readonly secretStorage: SecretStorage;
  private readonly sessionTokens = new Map<string, string>();
  private state: PersistedState = { activeProfileId: null, profiles: [] };

  constructor(userDataPath: string, options: ProfileServiceOptions) {
    this.filePath = path.join(userDataPath, "lockstep-settings.json");
    this.legacyConfigPath =
      options.legacyConfigPath ?? path.join(homedir(), ".latch-works", "lockstep.json");
    this.secretStorage = options.secretStorage;
  }

  async init(): Promise<ResultType<void, FileSystemError>> {
    try {
      if (existsSync(this.filePath)) {
        const raw = await readFile(this.filePath, "utf-8");
        this.state = PersistedStateSchema.parse(JSON.parse(raw));
      } else {
        await this.migrateLegacyConfig();
      }

      return Result.ok();
    } catch (error) {
      this.state = { activeProfileId: null, profiles: [] };
      return Result.err(unexpectedFileSystemError("init-profiles", toError(error), this.filePath));
    }
  }

  getSettings(): LockstepSettings {
    return {
      activeProfileId: this.state.activeProfileId,
      profiles: this.state.profiles.map((profile) => this.toPublicProfile(profile)),
    };
  }

  getProfile(profileId: string): PersistedProfile | undefined {
    return this.state.profiles.find((profile) => profile.id === profileId);
  }

  getApiToken(profileId: string): string | undefined {
    const sessionToken = this.sessionTokens.get(profileId);
    if (sessionToken) {
      return sessionToken;
    }

    const profile = this.getProfile(profileId);
    if (!profile?.encryptedToken || !this.secretStorage.isEncryptionAvailable()) {
      return undefined;
    }

    try {
      return this.secretStorage.decryptString(Buffer.from(profile.encryptedToken, "base64"));
    } catch {
      return undefined;
    }
  }

  setSessionToken(profileId: string, token: string): void {
    this.sessionTokens.set(profileId, token);
  }

  isTokenConfigured(profileId: string): boolean {
    const tokenState = this.getTokenState(profileId);
    return tokenState === "session" || tokenState === "secure";
  }

  private getTokenState(profileId: string): "none" | "secure" | "session" | "unreadable" {
    if (this.sessionTokens.has(profileId)) {
      return "session";
    }

    const profile = this.getProfile(profileId);
    if (!profile?.encryptedToken) {
      return "none";
    }

    if (!this.secretStorage.isEncryptionAvailable()) {
      return "unreadable";
    }

    try {
      this.secretStorage.decryptString(Buffer.from(profile.encryptedToken, "base64"));
      return "secure";
    } catch {
      return "unreadable";
    }
  }

  async createProfile(
    input: LockstepProfileInput,
  ): Promise<ResultType<LockstepProfilePublic, FileSystemError>> {
    const profile: PersistedProfile = {
      apiUrl: input.apiUrl,
      id: randomUUID(),
      name: input.name,
      sourceRoot: input.sourceRoot,
    };

    if (input.token) {
      const encrypted = this.encryptToken(input.token);
      if (encrypted) {
        profile.encryptedToken = encrypted;
      } else {
        // Do not persist a plaintext or stale encrypted blob when OS encryption is unavailable.
        delete profile.encryptedToken;
        this.sessionTokens.set(profile.id, input.token);
      }
    }

    this.state.profiles.push(profile);
    if (!this.state.activeProfileId) {
      this.state.activeProfileId = profile.id;
    }

    const saveResult = await this.save();
    if (Result.isError(saveResult)) {
      return saveResult;
    }

    return Result.ok(this.toPublicProfile(profile));
  }

  async updateProfile(
    profileId: string,
    patch: LockstepProfilePatch,
  ): Promise<ResultType<LockstepProfilePublic, FileSystemError>> {
    const profile = this.getProfile(profileId);
    if (!profile) {
      return Result.err(
        unexpectedFileSystemError("update-profile", new Error("Profile not found"), profileId),
      );
    }

    if (patch.name) {
      profile.name = patch.name;
    }
    if (patch.apiUrl) {
      profile.apiUrl = patch.apiUrl;
    }
    if (patch.sourceRoot) {
      profile.sourceRoot = patch.sourceRoot;
    }
    if (patch.token) {
      const encrypted = this.encryptToken(patch.token);
      if (encrypted) {
        profile.encryptedToken = encrypted;
      } else {
        // Clear any previously persisted ciphertext so a later restart cannot revive a stale token.
        delete profile.encryptedToken;
        this.sessionTokens.set(profileId, patch.token);
      }
    }

    const saveResult = await this.save();
    if (Result.isError(saveResult)) {
      return saveResult;
    }

    return Result.ok(this.toPublicProfile(profile));
  }

  async deleteProfile(profileId: string): Promise<ResultType<LockstepSettings, FileSystemError>> {
    this.sessionTokens.delete(profileId);
    this.state.profiles = this.state.profiles.filter((profile) => profile.id !== profileId);
    if (this.state.activeProfileId === profileId) {
      this.state.activeProfileId = this.state.profiles[0]?.id ?? null;
    }

    const saveResult = await this.save();
    if (Result.isError(saveResult)) {
      return saveResult;
    }

    return Result.ok(this.getSettings());
  }

  async setActiveProfile(
    profileId: string,
  ): Promise<ResultType<LockstepSettings, FileSystemError>> {
    if (!this.getProfile(profileId)) {
      return Result.err(
        unexpectedFileSystemError("set-active-profile", new Error("Profile not found"), profileId),
      );
    }

    this.state.activeProfileId = profileId;
    const saveResult = await this.save();
    if (Result.isError(saveResult)) {
      return saveResult;
    }

    return Result.ok(this.getSettings());
  }

  async recordLastRun(
    profileId: string,
    summary: LockstepRunSummary,
  ): Promise<ResultType<void, FileSystemError>> {
    const profile = this.getProfile(profileId);
    if (!profile) {
      return Result.ok();
    }

    profile.lastRun = { ...summary, profileId };
    return this.save();
  }

  private toPublicProfile(profile: PersistedProfile): LockstepProfilePublic {
    const tokenState = this.getTokenState(profile.id);

    return {
      apiUrl: profile.apiUrl,
      id: profile.id,
      lastRun: profile.lastRun,
      name: profile.name,
      sourceRoot: profile.sourceRoot,
      tokenConfigured: tokenState === "session" || tokenState === "secure",
      tokenInSession: tokenState === "session",
      tokenUnreadable: tokenState === "unreadable",
    };
  }

  private encryptToken(token: string): string | undefined {
    if (!this.secretStorage.isEncryptionAvailable()) {
      return undefined;
    }

    return this.secretStorage.encryptString(token).toString("base64");
  }

  private async migrateLegacyConfig(): Promise<void> {
    if (!existsSync(this.legacyConfigPath)) {
      return;
    }

    const raw = await readFile(this.legacyConfigPath, "utf-8");
    const parsed = LegacyLockstepConfigSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) {
      return;
    }

    const legacy = parsed.data;
    if (!legacy.source && !legacy.apiUrl) {
      return;
    }

    const profile: PersistedProfile = {
      apiUrl: legacy.apiUrl ?? "http://127.0.0.1:3000",
      id: randomUUID(),
      name: "Default",
      sourceRoot: legacy.source ?? "",
    };

    this.state.profiles = [profile];
    this.state.activeProfileId = profile.id;
    await this.save();
  }

  private async save(): Promise<ResultType<void, FileSystemError>> {
    try {
      await mkdir(path.dirname(this.filePath), { recursive: true });
      await writeFile(this.filePath, `${JSON.stringify(this.state, null, 2)}\n`, "utf-8");
      return Result.ok();
    } catch (error) {
      return Result.err(unexpectedFileSystemError("save-profiles", toError(error), this.filePath));
    }
  }
}
