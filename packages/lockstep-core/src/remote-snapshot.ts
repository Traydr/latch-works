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

const RemoteEntryListSchema = z.array(RemoteEntrySchema);

const RemoteSnapshotResponseSchema = z.object({ entries: RemoteEntryListSchema });

/** undici rejects with a bare "fetch failed" and keeps the useful reason (ECONNREFUSED…) in `cause`. */
const NetworkErrorReasonSchema = z
  .union([
    z.object({ cause: z.object({ message: z.string() }) }).transform(({ cause }) => cause.message),
    z.object({ message: z.string() }).transform(({ message }) => message),
  ])
  .catch("network error");

/**
 * A snapshot file holds either a bare entry list or a saved `GET /api/sync/snapshot` response
 * (`{ entries, status }`). Both reduce to the list before the entries themselves are checked.
 */
const RemoteSnapshotFileSchema = z.union([
  z.array(z.unknown()),
  z.object({ entries: z.array(z.unknown()) }).transform(({ entries }) => entries),
]);

export async function readRemoteSnapshot(filePath: string): Promise<RemoteEntrySnapshot[]> {
  const raw = await readFile(filePath, "utf-8");
  let json: unknown;

  try {
    json = JSON.parse(raw);
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);

    throw new Error(`Remote snapshot ${filePath} is not valid JSON: ${detail}`, { cause });
  }

  const entries = RemoteSnapshotFileSchema.safeParse(json);

  if (!entries.success) {
    throw new Error(
      `Remote snapshot ${filePath} must be a JSON array of entries or an object with an ` +
        "entries array (a saved GET /api/sync/snapshot response).",
    );
  }

  const snapshot = RemoteEntryListSchema.safeParse(entries.data);

  if (!snapshot.success) {
    throw new Error(`${ENTRY_ERROR} (${filePath})`);
  }

  return snapshot.data;
}

export async function fetchRemoteSnapshot(
  apiUrl: string,
  apiToken: string,
  signal?: AbortSignal,
): Promise<RemoteEntrySnapshot[]> {
  const url = new URL("/api/sync/snapshot", apiUrl);

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${apiToken}`,
    },
    method: "GET",
    signal,
  }).catch((cause: unknown) => {
    if (signal?.aborted) {
      throw cause;
    }

    const reason = NetworkErrorReasonSchema.parse(cause);

    throw new Error(`Could not reach Pane View at ${url.origin}: ${reason}`, { cause });
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
