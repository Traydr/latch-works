import { spawn } from "node:child_process";
import {
  MAX_MEDIA_FACTS_PER_REQUEST,
  type MediaFact,
  type ReportMediaFactsRequest,
} from "@latch-works/sync-protocol";
import { formatError, throwIfAborted, toError } from "./errors.js";
import { runQueue } from "./queue.js";
import type { LockstepPlan } from "./types.js";

/*
 * What a push learns about a video's content beyond its type: whether it has audio, which Pane View
 * filters on. Videos are probed with ffprobe from PATH (or `LOCKSTEP_FFPROBE`); without it a push
 * still uploads, and Pane View leaves those videos' audio unknown until a later push can probe them.
 */

/** A kept video whose audio Pane View does not know: what a push probes and reports. */
export interface MissingAudioFact {
  path: string;
  sha256: string;
  size: number;
}

/**
 * The kept videos whose remote entry carries no `hasAudio`. Only those whose local hash is known to
 * match the remote one qualify, since a fact describes the bytes Pane View holds.
 */
export function videosMissingAudioFacts(plan: Pick<LockstepPlan, "items">): MissingAudioFact[] {
  return plan.items.flatMap((item) => {
    const { local, remote } = item;

    if (
      item.action !== "keep" ||
      local?.mediaType !== "video" ||
      remote === undefined ||
      remote.hasAudio !== undefined ||
      remote.sha256 === undefined ||
      local.sha256 !== remote.sha256
    ) {
      return [];
    }

    return [{ path: local.path, sha256: remote.sha256, size: remote.size }];
  });
}

/** The facts as the request bodies that carry them, in order, at most the route's limit each. */
export function mediaFactsRequests(facts: readonly MediaFact[]): ReportMediaFactsRequest[] {
  const requests: ReportMediaFactsRequest[] = [];

  for (let start = 0; start < facts.length; start += MAX_MEDIA_FACTS_PER_REQUEST) {
    requests.push({ facts: facts.slice(start, start + MAX_MEDIA_FACTS_PER_REQUEST) });
  }

  return requests;
}

/** Tells whether a video has audio; rejects when the video cannot be probed. */
export type AudioProbe = (filePath: string, signal?: AbortSignal) => Promise<boolean>;

/** ffprobe is not installed, or not where `LOCKSTEP_FFPROBE` points. */
export class FfprobeUnavailableError extends Error {
  constructor(command: string) {
    super(`ffprobe was not found (${command}); videos' audio is not reported to Pane View.`);
    this.name = "FfprobeUnavailableError";
  }
}

/** How long one probe may run, as Oriel's pinned ffprobe allows: a stalled share fails the probe. */
const PROBE_TIMEOUT_MS = 30_000;

function ffprobeCommand(): string {
  return process.env.LOCKSTEP_FFPROBE?.trim() || "ffprobe";
}

/**
 * Whether the file has at least one audio stream, from ffprobe's stream listing. Rejects with
 * `FfprobeUnavailableError` when ffprobe cannot be started, and with the probe's own error when the
 * file cannot be read as media.
 */
export const probeHasAudio: AudioProbe = (filePath, signal) => {
  const command = ffprobeCommand();

  return new Promise((resolve, reject) => {
    const child = spawn(
      command,
      [
        "-v",
        "error",
        "-select_streams",
        "a",
        "-show_entries",
        "stream=index",
        "-of",
        "csv=p=0",
        // Absolute (resolveLocalFilePath), so never read as an option.
        filePath,
      ],
      {
        killSignal: "SIGKILL",
        signal,
        stdio: ["ignore", "pipe", "pipe"],
        timeout: PROBE_TIMEOUT_MS,
      },
    );

    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });

    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error: NodeJS.ErrnoException) => {
      reject(error.code === "ENOENT" ? new FfprobeUnavailableError(command) : error);
    });
    child.on("close", (code, killedBy) => {
      if (code === 0) {
        resolve(stdout.trim() !== "");
      } else if (killedBy !== null && !signal?.aborted) {
        reject(new Error(`ffprobe did not finish within ${PROBE_TIMEOUT_MS / 1000}s`));
      } else {
        reject(new Error(`ffprobe failed with ${code}: ${stderr.trim() || "no output"}`));
      }
    });
  });
};

/** How many videos are probed at once while reporting facts. */
const PROBE_CONCURRENCY = 4;

/**
 * Probes every video in `missing` and returns the facts it learned. A video that fails to probe is
 * left out with a warning; a missing ffprobe stops the probing, and the probe reports that itself.
 */
export async function probeAudioFacts({
  missing,
  onWarning,
  probe,
  resolvePath,
  signal,
}: {
  missing: readonly MissingAudioFact[];
  onWarning: (message: string) => void;
  probe: AudioProbe;
  resolvePath: (archivePath: string) => string;
  signal?: AbortSignal;
}): Promise<MediaFact[]> {
  const facts: MediaFact[] = [];
  let unavailable = false;

  await runQueue({
    concurrency: PROBE_CONCURRENCY,
    signal,
    tasks: [...missing],
    work: async (video) => {
      if (unavailable) {
        return;
      }

      try {
        const hasAudio = await probe(resolvePath(video.path), signal);
        facts.push({ hasAudio, sha256: video.sha256, size: video.size });
      } catch (error) {
        throwIfAborted(signal);

        // The push's probe has already warned that ffprobe is missing.
        if (error instanceof FfprobeUnavailableError) {
          unavailable = true;

          return;
        }

        onWarning(`could not probe ${video.path} for audio: ${formatError(toError(error))}`);
      }
    },
  });

  return facts;
}
