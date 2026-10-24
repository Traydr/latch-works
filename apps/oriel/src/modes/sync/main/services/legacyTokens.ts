import { spawn } from "node:child_process";
import { createDecipheriv, pbkdf2Sync } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

/**
 * The key the standalone Lockstep app's Electron `safeStorage` (Chromium's OSCrypt) encrypted its
 * tokens with: on macOS an AES-128 key derived from a Keychain password, on Windows an AES-256 key
 * that DPAPI protects in the app's `Local State`.
 */
export type LegacyKey = { kind: "mac"; key: Buffer } | { kind: "windows"; key: Buffer };

/** OSCrypt's version prefix on every blob both platforms write. */
const VERSION_PREFIX = Buffer.from("v10");

/** Chromium's fixed macOS parameters: PBKDF2-HMAC-SHA1 over the Keychain password. */
const MAC_SALT = "saltysalt";

const MAC_ITERATIONS = 1003;

const MAC_KEY_BYTES = 16;

/** And its fixed IV: sixteen spaces. */
const MAC_IV = Buffer.alloc(16, 0x20);

const GCM_NONCE_BYTES = 12;

const GCM_TAG_BYTES = 16;

/** The Keychain item Electron created for the app named Lockstep. */
const MAC_KEYCHAIN_SERVICE = "Lockstep Safe Storage";

/** A token is printable ASCII; a wrong macOS key that happened to leave valid padding is not. */
const TOKEN_PATTERN = /^[\x21-\x7e]+$/;

const LocalStateSchema = z.object({
  os_crypt: z.object({ encrypted_key: z.string() }),
});

/** The AES key Chromium derives on macOS from the Keychain item's password. */
export function macLegacyKey(password: string): LegacyKey {
  return {
    kind: "mac",
    key: pbkdf2Sync(password, MAC_SALT, MAC_ITERATIONS, MAC_KEY_BYTES, "sha1"),
  };
}

/** Decrypts one token the old app saved, or null when it is not one this key opens. */
export function decryptLegacyToken(encrypted: Buffer, key: LegacyKey): string | null {
  if (!encrypted.subarray(0, VERSION_PREFIX.length).equals(VERSION_PREFIX)) {
    return null;
  }

  const body = encrypted.subarray(VERSION_PREFIX.length);

  let plain: Buffer;

  try {
    switch (key.kind) {
      case "mac": {
        const decipher = createDecipheriv("aes-128-cbc", key.key, MAC_IV);

        plain = Buffer.concat([decipher.update(body), decipher.final()]);
        break;
      }

      case "windows": {
        const nonce = body.subarray(0, GCM_NONCE_BYTES);
        const tag = body.subarray(body.length - GCM_TAG_BYTES);
        const data = body.subarray(GCM_NONCE_BYTES, body.length - GCM_TAG_BYTES);
        const decipher = createDecipheriv("aes-256-gcm", key.key, nonce);

        decipher.setAuthTag(tag);
        plain = Buffer.concat([decipher.update(data), decipher.final()]);
        break;
      }

      default: {
        const _exhaustive: never = key;

        return _exhaustive;
      }
    }
  } catch {
    return null;
  }

  const token = plain.toString("utf8");

  return TOKEN_PATTERN.test(token) ? token : null;
}

/** Runs a command and resolves to its stdout; secrets go in on stdin, never in argv. */
function run(command: string, args: readonly string[], input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "ignore"] });
    const chunks: Buffer[] = [];

    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0
        ? resolve(Buffer.concat(chunks).toString("utf8"))
        : reject(new Error(`${command} exited with ${code}`)),
    );
    child.stdin.end(input ?? "");
  });
}

/** DPAPI's prefix on the key Chromium keeps in `Local State`. */
const DPAPI_PREFIX = Buffer.from("DPAPI");

const UNPROTECT_SCRIPT = [
  "Add-Type -AssemblyName System.Security",
  "$protected = [Convert]::FromBase64String([Console]::In.ReadToEnd())",
  "$key = [System.Security.Cryptography.ProtectedData]::Unprotect($protected, $null, 'CurrentUser')",
  "[Convert]::ToBase64String($key)",
].join("; ");

/**
 * The old Lockstep app's key, or null when there is none to read. On macOS this reads the Keychain
 * item, and macOS asks the owner once whether to allow it. On Windows it unprotects the key in the
 * app's `Local State`, which came into `lockstepDataDir` with the rest of its folder, as the user
 * who saved it.
 */
export async function readLegacyKey(lockstepDataDir: string): Promise<LegacyKey | null> {
  try {
    switch (process.platform) {
      case "darwin": {
        const password = await run("security", [
          "find-generic-password",
          "-w",
          "-s",
          MAC_KEYCHAIN_SERVICE,
        ]);

        return macLegacyKey(password.trim());
      }

      case "win32": {
        const localState = LocalStateSchema.parse(
          JSON.parse(await readFile(path.join(lockstepDataDir, "Local State"), "utf8")),
        );

        const protectedKey = Buffer.from(localState.os_crypt.encrypted_key, "base64");

        if (!protectedKey.subarray(0, DPAPI_PREFIX.length).equals(DPAPI_PREFIX)) {
          return null;
        }

        const key = await run(
          "powershell.exe",
          ["-NoProfile", "-NonInteractive", "-Command", UNPROTECT_SCRIPT],
          protectedKey.subarray(DPAPI_PREFIX.length).toString("base64"),
        );

        return { kind: "windows", key: Buffer.from(key.trim(), "base64") };
      }

      default:
        return null;
    }
  } catch {
    return null;
  }
}
