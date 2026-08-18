import { readFile } from "node:fs/promises";
import type { RemoteEntrySnapshot } from "@latch-works/media-index";
import { z } from "zod";

const ENTRY_ERROR = "Remote snapshot entries must include path and size.";

/** A non-string `sha256` is dropped rather than rejected, matching the pre-schema reader. */
const RemoteEntrySchema = z.object({
  path: z.string(),
  sha256: z.string().optional().catch(undefined),
  size: z.number(),
});

const RemoteSnapshotFileSchema = z.array(RemoteEntrySchema);
const RemoteSnapshotResponseSchema = z.object({ entries: RemoteSnapshotFileSchema });

export async function readRemoteSnapshot(filePath: string): Promise<RemoteEntrySnapshot[]> {
  const raw = await readFile(filePath, "utf-8");
  const snapshot = RemoteSnapshotFileSchema.safeParse(JSON.parse(raw));
  if (!snapshot.success) {
    throw new Error(
      failedAtRoot(snapshot.error, 0) ? "Remote snapshot must be a JSON array." : ENTRY_ERROR,
    );
  }

  return snapshot.data;
}

export async function fetchRemoteSnapshot(
  apiUrl: string,
  apiToken: string,
  signal?: AbortSignal,
): Promise<RemoteEntrySnapshot[]> {
  const response = await fetch(new URL("/api/sync/snapshot", apiUrl), {
    headers: {
      Authorization: `Bearer ${apiToken}`,
    },
    method: "GET",
    signal,
  });

  if (!response.ok) {
    throw new Error(`/api/sync/snapshot failed with ${response.status}: ${await response.text()}`);
  }

  const snapshot = RemoteSnapshotResponseSchema.safeParse(await response.json());
  if (!snapshot.success) {
    throw new Error(
      failedAtRoot(snapshot.error, 1)
        ? "Remote sync snapshot response must include an entries array."
        : ENTRY_ERROR,
    );
  }

  return snapshot.data.entries;
}

/** True when the array itself is malformed rather than one of the entries inside it. */
function failedAtRoot(error: z.ZodError, arrayDepth: number): boolean {
  return error.issues.some((issue) => issue.path.length <= arrayDepth);
}
