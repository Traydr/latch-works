import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
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
  /** Settles when the last queued change has been written; see `exclusive`. */
  private pendingChange: Promise<void> = Promise.resolve();

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
      const failure = toError(error);

      if (!existsSync(this.filePath)) {
        return Result.err(unexpectedFileSystemError("init-profiles", failure, this.filePath));
      }

      return Result.err(await this.setAsideUnreadableSettings(failure));
    }
  }

  /**
   * Moves a settings file that failed to load out of the way, so the next save starts a new file
   * instead of overwriting profiles and saved tokens that might still be recovered by hand.
   */
  private async setAsideUnreadableSettings(failure: Error): Promise<FileSystemError> {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");

    const keptPath = path.join(
      path.dirname(this.filePath),
      `lockstep-settings.corrupt-${stamp}.json`,
    );

    try {
      await rename(this.filePath, keptPath);
    } catch (renameError) {
      return unexpectedFileSystemError(
        "init-profiles",
        new Error(
          `${failure.message}. The file could not be set aside either: ${toError(renameError).message}`,
        ),
        this.filePath,
      );
    }

    return unexpectedFileSystemError(
      "init-profiles",
      new Error(`${failure.message}. The unreadable settings file was kept as ${keptPath}.`),
      keptPath,
    );
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
    return this.exclusive(async () => {
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
    });
  }

  /**
   * Applies an edit. A new token replaces the saved one, `clearToken` forgets it, and moving the
   * source folder or API URL drops the last-run summary, which described the old target.
   */
  async updateProfile(
    profileId: string,
    patch: LockstepProfilePatch,
  ): Promise<ResultType<LockstepProfilePublic, FileSystemError>> {
    return this.exclusive(async () => {
      const current = this.getProfile(profileId);

      if (!current) {
        return Result.err(
          unexpectedFileSystemError("update-profile", new Error("Profile not found"), profileId),
        );
      }

      const next: PersistedProfile = {
        ...current,
        apiUrl: patch.apiUrl || current.apiUrl,
        name: patch.name || current.name,
        sourceRoot: patch.sourceRoot || current.sourceRoot,
      };

      if (next.apiUrl !== current.apiUrl || next.sourceRoot !== current.sourceRoot) {
        delete next.lastRun;
      }

      let sessionToken = this.sessionTokens.get(profileId);

      if (patch.token) {
        const encrypted = this.encryptToken(patch.token);

        if (encrypted) {
          next.encryptedToken = encrypted;
          sessionToken = undefined;
        } else {
          // Clear any previously persisted ciphertext so a later restart cannot revive a stale token.
          delete next.encryptedToken;
          sessionToken = patch.token;
        }
      } else if (patch.clearToken) {
        delete next.encryptedToken;
        sessionToken = undefined;
      }

      const nextState: PersistedState = {
        ...this.state,
        profiles: this.state.profiles.map((profile) => (profile.id === profileId ? next : profile)),
      };

      const saveResult = await this.save(nextState);

      if (Result.isError(saveResult)) {
        return saveResult;
      }

      this.state = nextState;

      if (sessionToken) {
        this.sessionTokens.set(profileId, sessionToken);
      } else {
        this.sessionTokens.delete(profileId);
      }

      return Result.ok(this.toPublicProfile(next));
    });
  }

  /**
   * Removes a profile with its saved token. Deleting the active profile activates its neighbour in
   * list order, or none when it was the last one.
   */
  async deleteProfile(profileId: string): Promise<ResultType<LockstepSettings, FileSystemError>> {
    return this.exclusive(async () => {
      const index = this.state.profiles.findIndex((profile) => profile.id === profileId);

      if (index === -1) {
        return Result.err(
          unexpectedFileSystemError("delete-profile", new Error("Profile not found"), profileId),
        );
      }

      const profiles = this.state.profiles.filter((profile) => profile.id !== profileId);

      const activeProfileId =
        this.state.activeProfileId === profileId
          ? (profiles[Math.min(index, profiles.length - 1)]?.id ?? null)
          : this.state.activeProfileId;

      const nextState: PersistedState = { activeProfileId, profiles };
      const saveResult = await this.save(nextState);

      if (Result.isError(saveResult)) {
        return saveResult;
      }

      this.state = nextState;
      this.sessionTokens.delete(profileId);

      return Result.ok(this.getSettings());
    });
  }

  async setActiveProfile(
    profileId: string,
  ): Promise<ResultType<LockstepSettings, FileSystemError>> {
    return this.exclusive(async () => {
      if (!this.getProfile(profileId)) {
        return Result.err(
          unexpectedFileSystemError(
            "set-active-profile",
            new Error("Profile not found"),
            profileId,
          ),
        );
      }

      this.state.activeProfileId = profileId;
      const saveResult = await this.save();

      if (Result.isError(saveResult)) {
        return saveResult;
      }

      return Result.ok(this.getSettings());
    });
  }

  async recordLastRun(
    profileId: string,
    summary: LockstepRunSummary,
  ): Promise<ResultType<void, FileSystemError>> {
    return this.exclusive(async () => {
      const profile = this.getProfile(profileId);

      if (!profile) {
        return Result.ok();
      }

      profile.lastRun = { ...summary, profileId };

      return this.save();
    });
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

  /**
   * Runs one read-modify-write of the settings after every change queued before it, so an edit
   * cannot write back a state that misses a selection saved while it waited.
   */
  private exclusive<T>(change: () => Promise<T>): Promise<T> {
    const result = this.pendingChange.then(change);
    this.pendingChange = result.then(
      () => undefined,
      () => undefined,
    );

    return result;
  }

  /**
   * Writes `state` (the current state by default) so callers can commit only after it lands. The
   * file is replaced by rename, so a failed or interrupted write never leaves a partial document.
   */
  private async save(
    state: PersistedState = this.state,
  ): Promise<ResultType<void, FileSystemError>> {
    const tempPath = `${this.filePath}.${randomUUID()}.tmp`;

    try {
      await mkdir(path.dirname(this.filePath), { recursive: true });
      await writeFile(tempPath, `${JSON.stringify(state, null, 2)}\n`, "utf-8");
      await rename(tempPath, this.filePath);

      return Result.ok();
    } catch (error) {
      await rm(tempPath, { force: true });

      return Result.err(unexpectedFileSystemError("save-profiles", toError(error), this.filePath));
    }
  }
}
