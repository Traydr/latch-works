import { z } from "zod";
import { ensureDirectoryPermission, loadDirectoryHandle } from "../gather/directory-store";
import type { SiteKey } from "../shared/sites";
import { SiteKeySchema } from "../shared/source-catalog";

export const OFFSCREEN_FILESYSTEM_PROOF_MESSAGE = "GATHER_BOX_OFFSCREEN_FILESYSTEM_PROOF" as const;

export const OffscreenFilesystemProofMessageSchema = z.object({
  type: z.literal(OFFSCREEN_FILESYSTEM_PROOF_MESSAGE),
  target: z.literal("offscreen"),
  siteKey: SiteKeySchema.nullable().catch(null),
  useGlobalFolder: z.boolean().catch(false)
});

export interface OffscreenFilesystemProofResult {
  ok: boolean;
  permission: "granted" | "requires-user-activation" | "denied";
  fileName?: string;
  message: string;
}

/**
 * Development-only vertical proof for Chrome's File System Access handle transfer through
 * extension-origin IndexedDB. The uniquely named file is always removed before returning.
 */
export async function proveOffscreenFilesystemAccess(input: {
  siteKey: SiteKey | null;
  useGlobalFolder: boolean;
}): Promise<OffscreenFilesystemProofResult> {
  const directory = await loadDirectoryHandle(input.siteKey, input.useGlobalFolder);
  if (!directory) {
    return {
      ok: false,
      permission: "denied",
      message: "No persisted test directory handle was found."
    };
  }

  const permission = await ensureDirectoryPermission(directory, false);
  if (permission !== "granted") {
    return {
      ok: false,
      permission,
      message: "The saved handle requires a visible extension page to grant read/write access."
    };
  }

  const fileName = `.gather-box-offscreen-proof-${crypto.randomUUID()}.txt`;
  const expected = `Gather Box offscreen filesystem proof: ${fileName}`;
  try {
    const handle = await directory.getFileHandle(fileName, { create: true });
    const writable = await handle.createWritable();
    await writable.write(expected);
    await writable.close();
    const actual = await (await handle.getFile()).text();
    if (actual !== expected) {
      throw new Error("The proof file did not read back the bytes that were written.");
    }
    return {
      ok: true,
      permission,
      fileName,
      message: "The offscreen document wrote and read the persisted directory handle."
    };
  } finally {
    await directory.removeEntry(fileName).catch(() => undefined);
  }
}
