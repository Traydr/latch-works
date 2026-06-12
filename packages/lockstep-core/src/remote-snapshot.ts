import { readFile } from "node:fs/promises";
import type { RemoteEntrySnapshot } from "@latch-works/media-index";

export async function readRemoteSnapshot(filePath: string): Promise<RemoteEntrySnapshot[]> {
  const raw = await readFile(filePath, "utf-8");
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error("Remote snapshot must be a JSON array.");
  }

  return parsed.map(parseRemoteEntry);
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

  const parsed = (await response.json()) as { entries?: unknown };
  if (!Array.isArray(parsed.entries)) {
    throw new Error("Remote sync snapshot response must include an entries array.");
  }

  return parsed.entries.map(parseRemoteEntry);
}

function parseRemoteEntry(entry: unknown): RemoteEntrySnapshot {
  if (
    typeof entry !== "object" ||
    entry === null ||
    !("path" in entry) ||
    !("size" in entry) ||
    typeof entry.path !== "string" ||
    typeof entry.size !== "number"
  ) {
    throw new Error("Remote snapshot entries must include path and size.");
  }

  return {
    path: entry.path,
    sha256: "sha256" in entry && typeof entry.sha256 === "string" ? entry.sha256 : undefined,
    size: entry.size,
  };
}
