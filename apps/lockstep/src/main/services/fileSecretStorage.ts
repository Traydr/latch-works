import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import type { SecretStorage } from "./profileService";

const KEY_BYTES = 32;

const IV_BYTES = 12;

const TAG_BYTES = 16;

/** `$XDG_CONFIG_HOME/lockstep`, falling back to `~/.config/lockstep`. */
export function lockstepConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(env.XDG_CONFIG_HOME || path.join(homedir(), ".config"), "lockstep");
}

/**
 * A `safeStorage` stand-in for unattended test runs: AES-256-GCM with a random key kept in a
 * 0600 file, so saving a token never waits on a macOS Keychain prompt. Ciphertext is
 * `iv | tag | data`, which `ProfileService` stores as base64 like Electron's own output.
 */
export class FileSecretStorage implements SecretStorage {
  private key: Buffer | undefined;

  constructor(private readonly keyPath: string) {}

  isEncryptionAvailable(): boolean {
    return true;
  }

  encryptString(plainText: string): Buffer {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv("aes-256-gcm", this.loadKey(), iv);
    const data = Buffer.concat([cipher.update(plainText, "utf8"), cipher.final()]);

    return Buffer.concat([iv, cipher.getAuthTag(), data]);
  }

  decryptString(encrypted: Buffer): string {
    const iv = encrypted.subarray(0, IV_BYTES);
    const tag = encrypted.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
    const decipher = createDecipheriv("aes-256-gcm", this.loadKey(), iv);
    decipher.setAuthTag(tag);

    return Buffer.concat([
      decipher.update(encrypted.subarray(IV_BYTES + TAG_BYTES)),
      decipher.final(),
    ]).toString("utf8");
  }

  private loadKey(): Buffer {
    if (this.key) {
      return this.key;
    }

    try {
      this.key = readFileSync(this.keyPath);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
        throw error;
      }

      mkdirSync(path.dirname(this.keyPath), { mode: 0o700, recursive: true });
      // `wx` fails instead of overwriting a key another process wrote first.
      writeFileSync(this.keyPath, randomBytes(KEY_BYTES), { flag: "wx", mode: 0o600 });
      chmodSync(this.keyPath, 0o600);
      this.key = readFileSync(this.keyPath);
    }

    if (this.key.length !== KEY_BYTES) {
      throw new Error(`Lockstep secret key at ${this.keyPath} is not ${KEY_BYTES} bytes`);
    }

    return this.key;
  }
}
