import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { Result, type Result as ResultType } from "better-result";
import { safeStorage } from "electron";

import type {
  LockstepProfileInput,
  LockstepProfilePatch,
  LockstepProfilePublic,
  LockstepRunSummary,
  LockstepSettings,
} from "../../shared/types";
import { type FileSystemError, unexpectedFileSystemError } from "../errors";

interface PersistedProfile {
  apiUrl: string;
  encryptedToken?: string;
  id: string;
  lastRun?: LockstepRunSummary;
  name: string;
  sourceRoot: string;
}

interface PersistedState {
  activeProfileId: string | null;
  profiles: PersistedProfile[];
}

interface LegacyLockstepConfig {
  apiUrl?: string;
  source?: string;
}

export class ProfileService {
  private readonly filePath: string;
  private readonly legacyConfigPath: string;
  private readonly sessionTokens = new Map<string, string>();
  private state: PersistedState = { activeProfileId: null, profiles: [] };

  constructor(
    userDataPath: string,
    options?: {
      legacyConfigPath?: string;
    },
  ) {
    this.filePath = path.join(userDataPath, "lockstep-settings.json");
    this.legacyConfigPath =
      options?.legacyConfigPath ?? path.join(homedir(), ".latch-works", "lockstep.json");
  }

  async init(): Promise<ResultType<void, FileSystemError>> {
    try {
      if (existsSync(this.filePath)) {
        const raw = await readFile(this.filePath, "utf-8");
        this.state = JSON.parse(raw) as PersistedState;
      } else {
        await this.migrateLegacyConfig();
      }

      return Result.ok();
    } catch (error) {
      this.state = { activeProfileId: null, profiles: [] };
      return Result.err(unexpectedFileSystemError("init-profiles", error, this.filePath));
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
    if (!profile?.encryptedToken || !safeStorage.isEncryptionAvailable()) {
      return undefined;
    }

    return safeStorage.decryptString(Buffer.from(profile.encryptedToken, "base64"));
  }

  setSessionToken(profileId: string, token: string): void {
    this.sessionTokens.set(profileId, token);
  }

  isTokenConfigured(profileId: string): boolean {
    const profile = this.getProfile(profileId);
    return Boolean(profile?.encryptedToken || this.sessionTokens.has(profileId));
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
    return {
      apiUrl: profile.apiUrl,
      id: profile.id,
      lastRun: profile.lastRun,
      name: profile.name,
      sourceRoot: profile.sourceRoot,
      tokenConfigured: this.isTokenConfigured(profile.id),
    };
  }

  private encryptToken(token: string): string | undefined {
    if (!safeStorage.isEncryptionAvailable()) {
      return undefined;
    }

    return safeStorage.encryptString(token).toString("base64");
  }

  private async migrateLegacyConfig(): Promise<void> {
    if (!existsSync(this.legacyConfigPath)) {
      return;
    }

    const raw = await readFile(this.legacyConfigPath, "utf-8");
    const legacy = JSON.parse(raw) as LegacyLockstepConfig;
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
      return Result.err(unexpectedFileSystemError("save-profiles", error, this.filePath));
    }
  }
}
