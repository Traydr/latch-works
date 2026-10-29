/**
 * The differential run of changes between glazier-core and Oriel RS (plan 063, "Keeping two
 * implementations honest"): each of e2e's Tidy cases as a scenario of decisions on its own copy
 * of a throwaway archive, and after each decision what is on disk, in holding and in the
 * journal. `engine/differential.test.ts` runs them and writes the report with the decisions in
 * it; `apps/oriel-rs/crates/core-tidy/tests/changes.rs` replays the same decisions through the
 * Rust engine and compares. Files are named by their path in the archive and plans by id, so the
 * two catalogs can number files as they like; holding batches are named by their plan alone,
 * since their names carry the time.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";

import sharp from "sharp";
import { z } from "zod";

import {
  type FileId,
  FileIdSchema,
  type Job,
  type OptimizeCategory,
  type PlanId,
  type PlanRequest,
  type PlanSummary,
  type Root,
  type RootId,
} from "../contract.js";
import type { JsonValue } from "../engine/engine.js";
import { probeVideo } from "../media/video-probe.js";
import type { EngineHarness } from "./engine-harness.js";

const execFileAsync = promisify(execFile);

/** Convert's switches as Electron Oriel starts with them: pictures, animations and videos. */
const CONVERT_CATEGORIES: OptimizeCategory[] = [
  "still-to-avif",
  "animation-to-mp4",
  "video-remux",
  "video-convert",
];

/** Shrink's batch as Electron Oriel starts with it: 5 GB. */
const SHRINK_LIMIT_BYTES = 5e9;

/**
 * Short H.264 clips with a tone, as e2e's `shrink.spec.ts` makes them but smaller, so the
 * committed archive stays small: grain in every frame makes `busy.mp4` worth shrinking;
 * `lean.mp4`, at a low rate, is compact already; and `tiny.mp4` is offered but comes out larger
 * as AV1, since a second of it is mostly the container, so Shrink keeps the original.
 */
export async function buildShrinkArchive(archive: string): Promise<void> {
  await mkdir(path.join(archive, "clips"), { recursive: true });

  const clip = async (name: string, picture: string, seconds: number, rate: readonly string[]) => {
    await execFileAsync("ffmpeg", [
      "-y",
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      picture,
      "-f",
      "lavfi",
      "-i",
      `sine=frequency=440:duration=${seconds}`,
      "-t",
      String(seconds),
      "-c:v",
      "libx264",
      ...rate,
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-b:a",
      "16k",
      "-shortest",
      path.join(archive, "clips", name),
    ]);
  };

  await clip("busy.mp4", "testsrc2=s=320x180:r=30,noise=alls=24:allf=t", 1, ["-crf", "18"]);
  await clip("lean.mp4", "mandelbrot=s=640x360:r=30", 2, ["-b:v", "40k"]);
  await clip("tiny.mp4", "mandelbrot=s=320x180:r=30", 1, ["-b:v", "8k"]);
}

/** A request with every file id replaced by the file's path, so the other engine can map it. */
type PathRequest = JsonValue;

/** One decision of a scenario, as both engines make it. */
type Decision =
  | { do: "perform"; request: PathRequest }
  | { do: "undo"; plans: PlanId[] }
  | { do: "tidy-up"; categories: OptimizeCategory[] }
  | { do: "dismiss"; files: string[] }
  | { do: "spot-variants" }
  | { do: "restore"; files: string[] }
  | { do: "mark-emptied" }
  | { do: "estimate"; category: OptimizeCategory };

const ID_LISTS = ["fileIds", "keep", "remove"] as const;

const JsonObjectSchema = z.record(z.string(), z.json());

/**
 * Replaces the ids in a request by paths, and a folder inside the root by `<root>/` and its path
 * there.
 */
function toPathRequest(
  request: PlanRequest,
  rootPath: string,
  pathOf: (id: FileId) => string,
): PathRequest {
  const json = z.json().parse(JSON.parse(JSON.stringify(request)));

  const walk = (value: JsonValue): JsonValue => {
    if (Array.isArray(value)) {
      return value.map(walk);
    }

    const object = JsonObjectSchema.safeParse(value);

    if (!object.success) {
      return value;
    }

    const out: Record<string, JsonValue> = {};

    for (const [key, entry] of Object.entries(object.data)) {
      if (ID_LISTS.some((name) => name === key) && Array.isArray(entry)) {
        out[key] = entry.map((id) => pathOf(FileIdSchema.parse(id)));
      } else if (key === "fileId") {
        out[key] = pathOf(FileIdSchema.parse(entry));
      } else if (key === "targetDir") {
        const relative = path.relative(rootPath, z.string().parse(entry));

        out[key] = `<root>/${relative.split(path.sep).join("/")}`;
      } else {
        out[key] = walk(entry);
      }
    }

    return out;
  };

  return walk(json);
}

const BATCH_STAMP = /^\d{4}-\d{2}-\d{2}_\d{6}-/u;

/** A holding path inside its root's folder with the batch named by its plan alone. */
function batchless(holdRel: string): string {
  return holdRel.replace(BATCH_STAMP, "");
}

async function sha256Of(file: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(file))
    .digest("hex");
}

const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".webm", ".mkv", ".avi"]);

/** What a re-encoded file is: its format and picture, and for video its length and tracks. */
async function mediaOf(file: string, ffprobePath: string): Promise<JsonValue> {
  const extension = path.extname(file).toLowerCase();

  if (extension === ".avif") {
    const metadata = await sharp(file).metadata();

    return { format: metadata.format, width: metadata.width, height: metadata.height };
  }

  if (VIDEO_EXTENSIONS.has(extension)) {
    const probe = await probeVideo(ffprobePath, file);

    return {
      width: probe.width,
      height: probe.height,
      durationMs: probe.durationMs,
      videoCodec: probe.videoCodec,
      audioCodec: probe.audioCodec,
      audioStreams: probe.audioStreams,
    };
  }

  return null;
}

/** Every file and folder under `folder`, in path order, with what each holds. */
async function treeOf(folder: string, ffprobePath: string) {
  const files: JsonValue[] = [];
  const folders: string[] = [];

  const walk = async (relDir: string) => {
    const entries = await readdir(path.join(folder, ...relDir.split("/").filter(Boolean)), {
      withFileTypes: true,
    }).catch(() => []);

    for (const entry of entries) {
      const relPath = relDir ? `${relDir}/${entry.name}` : entry.name;
      const full = path.join(folder, ...relPath.split("/"));

      if (entry.isDirectory()) {
        folders.push(relPath);
        await walk(relPath);
      } else if (entry.isFile()) {
        const stats = await stat(full);

        files.push({
          path: relPath,
          size: stats.size,
          mtimeMs: Math.trunc(stats.mtimeMs),
          sha256: await sha256Of(full),
          media: await mediaOf(full, ffprobePath),
        });
      }
    }
  };

  await walk("");
  const byPath = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);
  folders.sort(byPath);

  return {
    files: files.sort((left, right) =>
      byPath(
        z.object({ path: z.string() }).parse(left).path,
        z.object({ path: z.string() }).parse(right).path,
      ),
    ),
    folders,
  };
}

const HoldingRowSchema = z.object({
  original_rel: z.string(),
  hold_rel: z.string(),
  size: z.number(),
  reason: z.string(),
  state: z.string(),
  plan_id: z.number().nullable(),
});

function relativeTo(rootPath: string, absPath: string | null): string | null {
  if (absPath === null) {
    return null;
  }

  const relative = path.relative(rootPath, absPath);

  return relative.startsWith("..")
    ? `<outside>/${path.basename(absPath)}`
    : relative.split(path.sep).join("/");
}

/** Plans in id order, each with its steps, paths relative to the root. */
async function journalOf(harness: EngineHarness, root: Root) {
  const plans = await harness.call("listPlans", { rootId: root.id, offset: 0, limit: 500 });
  const report: JsonValue[] = [];

  for (const plan of [...plans].sort((left, right) => left.id - right.id)) {
    const { createdAt: _createdAt, ...summary } = plan;
    const page = await harness.call("planSteps", { planId: plan.id, offset: 0, limit: 500 });

    report.push({
      ...summary,
      steps: page.steps.map((step) => ({
        action: step.action,
        from: relativeTo(root.path, step.fromPath),
        to: relativeTo(root.path, step.toPath),
        status: step.status,
        message: step.message,
        bytesBefore: step.bytesBefore,
        bytesAfter: step.bytesAfter,
      })),
    });
  }

  return report;
}

/**
 * What the archive, holding and the journal hold after a decision: every file on disk with its
 * hash (and for an AVIF or a video what it shows), every folder, holding's rows and files, each
 * plan with its steps, and Overview's numbers.
 */
async function changeState(input: {
  harness: EngineHarness;
  root: Root;
  dataDir: string;
  ffprobePath: string;
}): Promise<JsonValue> {
  const { harness, root, dataDir, ffprobePath } = input;
  const db = new DatabaseSync(path.join(dataDir, "catalog.sqlite"), { readOnly: true });
  let holding: JsonValue[];

  try {
    holding = db
      .prepare(
        `SELECT original_rel, hold_rel, size, reason, state, plan_id FROM holding
          WHERE root_id = $root ORDER BY original_rel, hold_rel, id`,
      )
      .all({ $root: root.id })
      .map((row) => {
        const parsed = HoldingRowSchema.parse(row);

        return {
          originalRel: parsed.original_rel,
          holdRel: batchless(parsed.hold_rel),
          size: parsed.size,
          reason: parsed.reason,
          state: parsed.state,
          planId: parsed.plan_id,
        };
      });
  } finally {
    db.close();
  }

  const holdingFolder = path.join(dataDir, "holding");
  const rootFolders = await readdir(holdingFolder).catch(() => []);
  const held = [];

  for (const folder of rootFolders.sort()) {
    const tree = await treeOf(path.join(holdingFolder, folder), ffprobePath);

    for (const file of tree.files) {
      const entry = z.object({ path: z.string() }).loose().parse(file);

      held.push({ ...entry, path: batchless(entry.path) });
    }
  }

  const { lastScanAt: _lastScanAt, ...overview } = await harness.call("tidy", { rootId: root.id });

  return {
    archive: await treeOf(root.path, ffprobePath),
    holding,
    held: z.json().parse(held),
    plans: await journalOf(harness, root),
    overview,
  };
}

/** The finished state of a job, once the queue is idle. */
async function finished(harness: EngineHarness, job: Job): Promise<Job> {
  await harness.idle();
  const { jobs } = await harness.call("getState", {});

  return jobs.find((candidate) => candidate.id === job.id) ?? job;
}

/** What a decision did, as both engines report it. */
interface DecisionResult {
  decision: Decision;
  result: JsonValue;
  state: JsonValue;
}

/**
 * Runs scenarios' decisions on one engine and root, recording each with its result and the
 * state after it. `pathOf` and `idOf` map this catalog's ids, as they stand when asked.
 */
export class ScenarioRunner {
  constructor(
    private readonly harness: EngineHarness,
    private readonly root: Root,
    private readonly dataDir: string,
    private readonly ffprobePath: string,
  ) {}

  readonly decisions: DecisionResult[] = [];

  get rootId(): RootId {
    return this.root.id;
  }

  get rootPath(): string {
    return this.root.path;
  }

  private async paths(): Promise<Map<FileId, string>> {
    const page = await this.harness.call("listFiles", {
      rootId: this.root.id,
      search: "",
      kinds: [],
      formats: [],
      audioStates: [],
      flags: [],
      dir: null,
      sort: "path",
      descending: false,
      offset: 0,
      limit: 1000,
    });

    return new Map(page.rows.map((row) => [row.id, row.relPath]));
  }

  async pathOf(id: FileId): Promise<string> {
    const found = (await this.paths()).get(id);

    if (found === undefined) {
      throw new Error(`No catalog row for file ${id}`);
    }

    return found;
  }

  async idOf(relPath: string): Promise<FileId> {
    for (const [id, candidate] of await this.paths()) {
      if (candidate === relPath) {
        return id;
      }
    }

    throw new Error(`${relPath} is not in the catalog`);
  }

  private async record(decision: Decision, result: JsonValue): Promise<void> {
    this.decisions.push({
      decision,
      result,
      state: await changeState({
        harness: this.harness,
        root: this.root,
        dataDir: this.dataDir,
        ffprobePath: this.ffprobePath,
      }),
    });
  }

  /** Previews and applies a request, then waits for what the engine queues after it. */
  async perform(request: PlanRequest): Promise<PlanSummary> {
    const paths = await this.paths();

    const recorded = toPathRequest(request, this.root.path, (id) => {
      const found = paths.get(id);

      if (found === undefined) {
        throw new Error(`No catalog row for file ${id}`);
      }

      return found;
    });

    const { preview, job } = await this.harness.call("perform", request);
    await finished(this.harness, job);
    const plan = await this.harness.call("getPlan", { planId: preview.planId });
    const { planId: _planId, ...shown } = preview;
    const { createdAt: _createdAt, ...summary } = plan;

    await this.record({ do: "perform", request: recorded }, { preview: shown, plan: summary });

    return plan;
  }

  /**
   * Undoes plans newest first, as one Undo, stopping at one that does not finish. It starts in a
   * later second than the change did: holding's batch folder is named by the second and the plan,
   * so an undo within the change's second would hold a re-encode beside its original there
   * (`busy (2).mp4`), and the report, which leaves the time out, would depend on the clock.
   */
  async undo(plans: readonly PlanId[]): Promise<void> {
    const states: JsonValue[] = [];

    await new Promise((resolve) => setTimeout(resolve, 1005 - (Date.now() % 1000)));

    for (const planId of [...plans].reverse()) {
      const job = await finished(this.harness, await this.harness.call("undoPlan", { planId }));
      const { createdAt: _createdAt, ...summary } = await this.harness.call("getPlan", { planId });

      states.push({ job: job.state, message: job.message, plan: summary });

      if (job.state !== "done") {
        break;
      }
    }

    await this.record({ do: "undo", plans: [...plans] }, states);
  }

  /** Tidy up as Overview runs it: Clean up, the silent soundtracks, then Convert. */
  async tidyUp(categories: OptimizeCategory[]): Promise<PlanId[]> {
    const rootId: RootId = this.root.id;
    const tidy = await this.harness.call("tidy", { rootId });
    const steps: Array<() => Promise<PlanRequest | null>> = [];
    const { junk, emptyFolders, extensions } = tidy.cleanup;

    if (junk + emptyFolders + extensions > 0) {
      steps.push(async () => ({ kind: "cleanup", rootId }));
    }

    if (tidy.silentTracks.files > 0) {
      steps.push(async () => {
        const { ids } = await this.harness.call("listFileIds", {
          rootId,
          search: "",
          kinds: ["video"],
          formats: [],
          audioStates: ["silent"],
          flags: [],
          dir: null,
        });

        return ids.length > 0 ? { kind: "strip-audio", fileIds: ids } : null;
      });
    }

    if (categories.length > 0) {
      steps.push(async () => ({ kind: "optimize", rootId, categories, fileIds: null }));
    }

    const plans: PlanSummary[] = [];
    const notes: string[] = [];

    for (const step of steps) {
      try {
        const request = await step();

        if (request === null) {
          continue;
        }

        const { preview, job } = await this.harness.call("perform", request);
        const done = await finished(this.harness, job);
        const plan = await this.harness.call("getPlan", { planId: preview.planId });

        if (plan.steps > 0) {
          plans.push(plan);
        }

        if (done.state === "cancelled") {
          notes.push(`Stopped during “${plan.title}”`);

          break;
        }

        if (done.state === "failed" || plan.failed > 0) {
          notes.push(`${plan.title}: ${plan.failed} failed`);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);

        if (!message.includes("nothing to do")) {
          notes.push(message);
        }
      }
    }

    await this.record(
      { do: "tidy-up", categories },
      {
        plans: plans.map(({ createdAt: _createdAt, ...summary }) => summary),
        notes,
      },
    );

    return plans.flatMap((plan) =>
      plan.done > 0 && ["applied", "partial", "cancelled"].includes(plan.status) ? [plan.id] : [],
    );
  }

  /** Marks files as not duplicates of each other. */
  async dismiss(files: string[]): Promise<void> {
    const fileIds = await Promise.all(files.map((file) => this.idOf(file)));
    await this.harness.call("dismissDuplicateSet", { fileIds });
    await this.record({ do: "dismiss", files }, null);
  }

  /** Turns Spot variants on and waits for the prints it needs. */
  async spotVariants(): Promise<void> {
    const { settings } = await this.harness.call("getState", {});
    await this.harness.call("updateSettings", { ...settings, spotVariants: true });
    await this.harness.idle();
    await this.record({ do: "spot-variants" }, null);
  }

  /** Brings held files back by their original paths. */
  async restore(files: string[]): Promise<void> {
    const listing = await this.harness.call("listHolding", {
      rootId: this.root.id,
      offset: 0,
      limit: 500,
    });

    const ids = files.flatMap((file) =>
      listing.items
        .filter((item) => item.originalPath === path.join(this.root.path, ...file.split("/")))
        .map((item) => item.id),
    );

    const result = await this.harness.call("restoreHolding", { ids: ids.length > 0 ? ids : [] });
    await this.harness.idle();
    await this.record({ do: "restore", files }, result);
  }

  /** Records every batch as emptied, without trashing anything (a test must not). */
  async markEmptied(): Promise<void> {
    const batchPaths = await this.harness.call("holdingBatches", { rootId: this.root.id });

    const result = await this.harness.call("markHoldingEmptied", {
      rootId: this.root.id,
      batchPaths,
    });

    await this.record({ do: "mark-emptied" }, result);
  }

  /** What converting a category would save, from samples converted outside the archive. */
  async estimate(category: OptimizeCategory): Promise<void> {
    const estimate = await this.harness.call("estimateOptimize", {
      rootId: this.root.id,
      category,
    });

    await this.record({ do: "estimate", category }, estimate);
  }

  /** The open sets at the balanced level, by kind, as paths. */
  async openSets(scope: "all" | "exact" | "similar" | "variants") {
    const page = await this.harness.call("duplicateSets", {
      rootId: this.root.id,
      offset: 0,
      limit: 500,
      level: "balanced",
      scope,
      dismissed: false,
    });

    return page.sets;
  }

  /** Return on a set: keep the suggestion, hold the rest. */
  async keepSuggestions(
    sets: Awaited<ReturnType<ScenarioRunner["openSets"]>>,
  ): Promise<PlanSummary> {
    const groups = sets.map((set) => {
      const keep = new Set(set.keep);

      return {
        keep: [...set.keep],
        remove: set.versions
          .flatMap((version) => version.files)
          .flatMap((file) => (keep.has(file.id) ? [] : [file.id])),
      };
    });

    return this.perform({ kind: "resolve-duplicates", groups });
  }
}

/** One scenario: the archive it starts from, and its decisions. */
interface Scenario {
  archive: "archive" | "shrink-archive";
  run: (runner: ScenarioRunner) => Promise<void>;
}

/**
 * The scenarios, e2e's Tidy cases on the differential archive (or Shrink's): each runs its
 * decisions on a fresh copy and a fresh engine.
 */
export const SCENARIOS = {
  // workbench.spec.ts: Return keeps the suggested copy, and Undo brings the set back.
  duplicates: {
    archive: "archive",
    run: async (runner) => {
      // The copy and the smaller re-encode of with-sound.mp4 are one set with it.
      const sets = await runner.openSets("all");

      const withSound = sets.filter((set) =>
        set.versions.some((version) =>
          version.files.some((file) => file.relPath === "clips/with-sound.mp4"),
        ),
      );

      const plan = await runner.keepSuggestions(withSound);
      await runner.undo([plan.id]);
    },
  },
  // workbench.spec.ts: Convert turns stills into AVIF and video into MP4, keeping dates, and
  // leaves versions under review; then Undo.
  convert: {
    archive: "archive",
    run: async (runner) => {
      for (const category of CONVERT_CATEGORIES) {
        await runner.estimate(category);
      }

      const plan = await runner.perform({
        kind: "optimize",
        rootId: runner.rootId,
        categories: CONVERT_CATEGORIES,
        fileIds: null,
      });

      await runner.undo([plan.id]);
    },
  },
  // Convert again once review is done, so every still becomes an AVIF: the similar sets marked
  // as not duplicates, the identical copies resolved.
  "convert-stills": {
    archive: "archive",
    run: async (runner) => {
      for (const set of await runner.openSets("similar")) {
        await runner.dismiss(
          set.versions.flatMap((version) => version.files).map((file) => file.relPath),
        );
      }

      await runner.keepSuggestions(await runner.openSets("exact"));
      await runner.estimate("still-to-avif");

      const plan = await runner.perform({
        kind: "optimize",
        rootId: runner.rootId,
        categories: ["still-to-avif"],
        fileIds: null,
      });

      await runner.undo([plan.id]);
    },
  },
  // workbench.spec.ts: Clean up fixes the extension, holds the junk and removes the empty
  // folder; then holding: a restore, the batches emptied, and an Undo that finds them gone.
  cleanup: {
    archive: "archive",
    run: async (runner) => {
      const plan = await runner.perform({ kind: "cleanup", rootId: runner.rootId });
      await runner.restore(["._sunset.png"]);
      await runner.markEmptied();
      await runner.undo([plan.id]);
    },
  },
  // shrink.spec.ts: Shrink re-encodes the busy video to AV1, leaves the compact one (and keeps
  // one that came out larger), and Undo restores it.
  shrink: {
    archive: "shrink-archive",
    run: async (runner) => {
      const plan = await runner.perform({
        kind: "shrink-videos",
        rootId: runner.rootId,
        limitBytes: SHRINK_LIMIT_BYTES,
      });

      await runner.undo([plan.id]);
    },
  },
  // The Library's own changes, which no e2e case covers: Rename, Move to…, Fix extension, Remove
  // and a re-encode to HEVC, then one Undo for them all, newest first.
  library: {
    archive: "archive",
    run: async (runner) => {
      const renamed = await runner.perform({
        kind: "rename",
        renames: [
          { fileId: await runner.idOf("photos/sunset-small.jpg"), name: "sunset-thumb.jpg" },
        ],
      });

      const moved = await runner.perform({
        kind: "move",
        fileIds: [await runner.idOf("notes.txt")],
        targetDir: path.join(runner.rootPath, "moved"),
      });

      const fixed = await runner.perform({
        kind: "fix-extension",
        fileIds: [await runner.idOf("photos/cover.jpg")],
      });

      const held = await runner.perform({
        kind: "hold",
        fileIds: [await runner.idOf("clips/no-audio.mp4")],
      });

      const reencoded = await runner.perform({
        kind: "reencode",
        fileIds: [await runner.idOf("clips/talk.mov")],
        codec: "hevc",
        quality: "medium",
      });

      await runner.undo([renamed.id, moved.id, fixed.id, held.id, reencoded.id]);
    },
  },
  // tidy-up.spec.ts: every step but duplicates as one change, and one Undo takes it all back.
  "tidy-up": {
    archive: "archive",
    run: async (runner) => {
      await runner.undo(await runner.tidyUp(CONVERT_CATEGORIES));
    },
  },
  // variants.spec.ts: Spot variants keeps each picture once and moves sets of variants out of
  // review; Undo brings the other site's copies back.
  "spot-variants": {
    archive: "archive",
    run: async (runner) => {
      await runner.spotVariants();

      const page = (await runner.openSets("similar")).filter((set) =>
        set.versions.some((version) =>
          version.files.some((file) => file.relPath.startsWith("pages/fanbox/")),
        ),
      );

      const plan = await runner.keepSuggestions(page);

      for (const set of await runner.openSets("variants")) {
        await runner.dismiss(
          set.versions.flatMap((version) => version.files).map((file) => file.relPath),
        );
      }

      await runner.undo([plan.id]);
    },
  },
} satisfies Record<string, Scenario>;
