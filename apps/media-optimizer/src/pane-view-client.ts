import type { MediaType } from "@latch-works/media-domain";
import { env } from "./env.js";

export interface DerivativeJob {
  attemptCount: number;
  extension: string;
  mediaObjectId: string;
  mediaType: MediaType;
  objectKey: string;
  originalObjectKey: string;
  sha256: string;
  size: number;
}

interface ClaimResponse {
  jobs: DerivativeJob[];
  processingToken: string;
}

function internalUrl(path: string): string {
  return new URL(path, env.PANE_VIEW_INTERNAL_URL).toString();
}

async function postInternal(path: string, body: unknown): Promise<Response> {
  return fetch(internalUrl(path), {
    body: JSON.stringify(body),
    headers: {
      authorization: `Bearer ${env.MEDIA_OPTIMIZER_TOKEN}`,
      "content-type": "application/json",
    },
    method: "POST",
  });
}

export async function claimJobs(limit: number): Promise<ClaimResponse> {
  const response = await postInternal("/internal/optimizer/claim", { limit });
  if (!response.ok) {
    throw new Error(`claim failed: ${response.status}`);
  }

  return (await response.json()) as ClaimResponse;
}

export async function reportComplete(input: {
  height: number;
  mediaObjectId: string;
  objectKey: string;
  processingToken: string;
  size: number;
  width: number;
}): Promise<void> {
  const response = await postInternal("/internal/optimizer/complete", input);
  // 409 means the lease no longer matches (reclaimed); not fatal for the loop.
  if (!response.ok && response.status !== 409) {
    throw new Error(`complete failed: ${response.status}`);
  }
}

export async function reportFailure(input: {
  error: string;
  mediaObjectId: string;
  processingToken: string;
  size: number;
}): Promise<void> {
  const response = await postInternal("/internal/optimizer/fail", input);
  if (!response.ok && response.status !== 409) {
    throw new Error(`fail report failed: ${response.status}`);
  }
}
