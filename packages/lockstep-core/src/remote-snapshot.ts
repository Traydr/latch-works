import { readFile } from "node:fs/promises";
import {
  type RemoteEntry,
  RemoteEntrySchema,
  RemoteSnapshotResponseSchema,
  SYNC_ROUTES,
} from "@latch-works/sync-protocol";
import { z } from "zod";
import type { PaneViewApi } from "./types.js";

const ENTRY_ERROR = "Remote snapshot entries must include path and size.";

const RemoteEntryListSchema = z.array(RemoteEntrySchema);

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

export async function readRemoteSnapshot(filePath: string): Promise<RemoteEntry[]> {
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

/** Reads the body of a `GET /api/sync/snapshot` answer, or throws the error a client reports. */
export function parseSnapshotResponse(body: string): RemoteEntry[] {
  const snapshot = RemoteSnapshotResponseSchema.safeParse(JSON.parse(body));

  if (!snapshot.success) {
    // An issue at depth 0 or 1 is the object or its entries array, not an entry inside it.
    throw new Error(
      snapshot.error.issues.some((issue) => issue.path.length <= 1)
        ? "Remote sync snapshot response must include an entries array."
        : ENTRY_ERROR,
    );
  }

  return snapshot.data.entries;
}

export async function fetchRemoteSnapshot(
  { apiToken, apiUrl }: PaneViewApi,
  signal?: AbortSignal,
): Promise<RemoteEntry[]> {
  const url = new URL(SYNC_ROUTES.snapshot, apiUrl);

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
    throw new Error(
      `${SYNC_ROUTES.snapshot} failed with ${response.status}: ${await response.text()}`,
    );
  }

  return parseSnapshotResponse(await response.text());
}
