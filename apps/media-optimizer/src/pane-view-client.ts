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

interface MatchResponse {
  matched: boolean;
}

async function parseMatchResponse(response: Response, action: string): Promise<boolean> {
  if (response.status === 409) {
    return false;
  }

  if (!response.ok) {
    throw new Error(`${action} failed: ${response.status}`);
  }

  const body = (await response.json()) as MatchResponse;
  return body.matched;
}

export async function reportComplete(input: {
  height: number;
  mediaObjectId: string;
  objectKey: string;
  processingToken: string;
  size: number;
  width: number;
}): Promise<boolean> {
  const response = await postInternal("/internal/optimizer/complete", input);
  return parseMatchResponse(response, "complete");
}

export async function reportFailure(input: {
  error: string;
  mediaObjectId: string;
  processingToken: string;
  size: number;
}): Promise<boolean> {
  const response = await postInternal("/internal/optimizer/fail", input);
  return parseMatchResponse(response, "fail report");
}

export async function releaseJobs(input: {
  jobs: Array<{ mediaObjectId: string; size: number }>;
  processingToken: string;
}): Promise<void> {
  if (input.jobs.length === 0) {
    return;
  }

  const response = await postInternal("/internal/optimizer/release", input);
  if (!response.ok) {
    throw new Error(`release failed: ${response.status}`);
  }
}
