import path from "node:path";

import { isSupportedMediaFile } from "@latch-works/media-domain";
import {
  type ArchiveVideoPlan,
  planStripAudio,
  planVideoReencode,
  replaceFileExtension,
} from "@latch-works/media-format";
import { z } from "zod";

import type { CatalogDatabase } from "../catalog/database.js";
import {
  FILE_COLUMNS,
  FILES_FROM,
  type FileRecord,
  FileRecordSchema,
  toAbsolutePath,
} from "../catalog/file-rows.js";
import { getFileRecords } from "../catalog/files.js";
import {
  type FileId,
  FileIdSchema,
  type PlanId,
  PlanIdSchema,
  type PlanKind,
  type PlanPreview,
  type PlanRequest,
  type PlanStepAction,
  type Root,
  type RootId,
  type Settings,
  type VideoQuality,
  VideoQualitySchema,
} from "../contract.js";
import { addDismissal } from "../duplicates/dismissals.js";
import { removalsFor } from "../duplicates/sets.js";
import {
  type CandidateHolds,
  findOptimizeCandidates,
  type OptimizeCandidate,
  videoSourceOf,
} from "../optimize/candidates.js";
import {
  AnimatedImageMimeTypeSchema,
  AudioTrackPlanSchema,
  VideoTrackPlanSchema,
} from "../optimize/encoders.js";
import { preferredExtension } from "../scan/sniff.js";

/** What a step does, stored as JSON beside it. The `kind` matches the step's `action` column. */
export const StepSpecSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("hold"), reason: z.string() }),
  z.object({ kind: z.literal("move") }),
  z.object({ kind: z.literal("rename") }),
  z.object({ kind: z.literal("convert-avif") }),
  z.object({ kind: z.literal("convert-animation"), mimeType: AnimatedImageMimeTypeSchema }),
  z.object({
    kind: z.literal("convert-video"),
    video: VideoTrackPlanSchema,
    audio: AudioTrackPlanSchema,
    quality: VideoQualitySchema,
    /** Re-encodes must save space to be kept; container moves only need to succeed. */
    requireSmaller: z.boolean(),
  }),
  z.object({ kind: z.literal("remove-folder") }),
]);

export type StepSpec = z.infer<typeof StepSpecSchema>;

/** A step before it is stored. File steps carry the fingerprint the executor re-checks. */
interface DraftStep {
  spec: StepSpec;
  rootId: Root["id"];
  fromRel: string;
  /** The absolute path a move, rename or conversion writes to. */
  toAbs: string | null;
  expected: { size: number; mtimeMs: number; ctimeMs: number };
}

class PlanRequestError extends Error {
  override readonly name = "PlanRequestError";
}

/** A duplicate set as a `resolve-duplicate-sets` request sees it: its files and suggestion. */
interface ResolvableSet {
  key: string;
  fileIds: readonly FileId[];
  keep: readonly FileId[];
}

export interface PlannerContext {
  db: CatalogDatabase;
  roots: readonly Root[];
  settings: Settings;
  /**
   * The open sets in a `resolve-duplicate-sets` request's scope, computed by the engine before
   * planning (clustering is asynchronous; planning is not). Empty for every other request.
   */
  duplicateSets: readonly ResolvableSet[];
  /** Files Convert and Clean up leave alone for now, worked out by the engine before planning. */
  candidateHolds: CandidateHolds;
}

function fileStep(record: FileRecord, spec: StepSpec, toAbs: string | null): DraftStep {
  return {
    spec,
    rootId: record.root_id,
    fromRel: record.rel_path,
    toAbs,
    expected: { size: record.size, mtimeMs: record.mtime_ms, ctimeMs: record.ctime_ms },
  };
}

function besideOriginal(record: FileRecord, name: string): string {
  return path.join(path.dirname(toAbsolutePath(record.root_path, record.rel_path)), name);
}

function loadRecords(context: PlannerContext, ids: readonly FileId[]): FileRecord[] {
  const unique = [...new Set(ids)];
  const records = getFileRecords(context.db, unique);

  if (records.length !== unique.length) {
    throw new PlanRequestError("Some files are no longer in the catalog. Rescan and try again.");
  }

  return records;
}

type VideoStepResult = { kind: "step"; step: DraftStep } | { kind: "skip"; reason: string };

function videoStep(
  record: FileRecord,
  plan: ArchiveVideoPlan,
  options: { quality: VideoQuality; requireSmaller: boolean },
): VideoStepResult {
  if (plan.action !== "convert-mp4") {
    return {
      kind: "skip",
      reason: plan.action === "unsupported" ? plan.reason : "Nothing to change.",
    };
  }

  const step = fileStep(
    record,
    {
      kind: "convert-video",
      video: plan.video,
      audio: plan.audio,
      quality: options.quality,
      requireSmaller: options.requireSmaller,
    },
    besideOriginal(record, plan.fileName),
  );

  return { kind: "step", step };
}

/** A request expanded into steps, with what the owner should know before applying it. */
export interface PlanDraft {
  steps: DraftStep[];
  warnings: string[];
  /** What the plan is about, counted: duplicate sets, empty folders, or else its steps. */
  count: number;
  /** The files each group that keeps several remembers as not duplicates of each other. */
  dismissals: FileId[][];
}

interface ResolveGroup {
  keep: readonly FileId[];
  remove: readonly FileId[];
}

/**
 * Hold steps for duplicate decisions. A file some group keeps, or that shares its bytes on disk
 * with a kept file, is never removed.
 */
function draftResolution(
  context: PlannerContext,
  groups: readonly ResolveGroup[],
): Omit<PlanDraft, "count"> & { resolved: number } {
  const byId = new Map(
    loadRecords(
      context,
      groups.flatMap((group) => [...group.keep, ...group.remove]),
    ).map((record) => [record.id, record]),
  );

  const kept = new Set(groups.flatMap((group) => group.keep));
  const removed = new Set<FileId>();
  const steps: DraftStep[] = [];
  const dismissals: FileId[][] = [];
  let resolved = 0;

  for (const group of groups) {
    const keepers = group.keep.flatMap((id) => byId.get(id) ?? []);
    const keeper = keepers[0];

    if (keeper === undefined || group.remove.some((id) => group.keep.includes(id))) {
      throw new PlanRequestError("Every duplicate group must keep a file and remove others.");
    }

    const members = [...keepers, ...group.remove.flatMap((id) => byId.get(id) ?? [])];
    let changed = false;

    for (const record of removalsFor(members, group.keep)) {
      if (removed.has(record.id) || kept.has(record.id)) {
        continue;
      }

      removed.add(record.id);
      changed = true;

      steps.push(
        fileStep(record, { kind: "hold", reason: `Duplicate of ${keeper.rel_path}` }, null),
      );
    }

    const keptIds = [...new Set(group.keep)];

    if (keptIds.length > 1) {
      dismissals.push(keptIds);
      changed = true;
    }

    if (changed) {
      resolved += 1;
    }
  }

  // Keepers already favour preferred folders, so removing a copy from one is a deliberate pick
  // (or every copy is in one) and is not warned about.
  return { steps, warnings: [], dismissals, resolved };
}

/** Each set with its suggested keeper or the override for its key, minus skipped sets. */
function setGroups(
  request: Extract<PlanRequest, { kind: "resolve-duplicate-sets" }>,
  sets: readonly ResolvableSet[],
): ResolveGroup[] {
  const skipped = new Set(request.skip);
  const overrides = new Map(request.overrides.map((override) => [override.key, override.keep]));

  return sets.flatMap((set) => {
    if (skipped.has(set.key)) {
      return [];
    }

    const keep = overrides.get(set.key) ?? set.keep;

    // An override chosen for files the set no longer holds says nothing about the set as it is.
    if (!keep.every((id) => set.fileIds.includes(id))) {
      return [];
    }

    return [{ keep, remove: set.fileIds.filter((id) => !keep.includes(id)) }];
  });
}

/**
 * Every file whose extension Clean up fixes, once each: names that do not match their bytes, and
 * AVIF and MP4 files under another extension.
 */
export function extensionFixes(
  db: CatalogDatabase,
  rootId: RootId,
  candidates: readonly OptimizeCandidate[],
): Array<{ record: FileRecord; name: string }> {
  const fixes = new Map<FileId, { record: FileRecord; name: string }>();

  for (const candidate of candidates) {
    if (candidate.category === "rename-avif" || candidate.category === "rename-mp4") {
      fixes.set(candidate.record.id, { record: candidate.record, name: candidate.targetName });
    }
  }

  const mismatched = db.all(
    `SELECT ${FILE_COLUMNS} FROM ${FILES_FROM}
      WHERE f.root_id = $root AND f.ext_mismatch = 1 AND f.is_junk = 0 ORDER BY f.id`,
    FileRecordSchema,
    { $root: rootId },
  );

  for (const record of mismatched) {
    const extension = record.format === null ? null : preferredExtension(record.format);

    if (extension !== null && !fixes.has(record.id)) {
      fixes.set(record.id, { record, name: replaceFileExtension(record.name, extension) });
    }
  }

  return [...fixes.values()];
}

/** Appends a step removing each of a root's empty folders, deepest first; returns how many. */
function draftFolderRemovals(context: PlannerContext, rootId: RootId, steps: DraftStep[]): number {
  const folders = context.db.all(
    "SELECT rel_path FROM empty_folders WHERE root_id = $root ORDER BY length(rel_path) DESC",
    z.object({ rel_path: z.string() }),
    { $root: rootId },
  );

  for (const folder of folders) {
    steps.push({
      spec: { kind: "remove-folder" },
      rootId,
      fromRel: folder.rel_path,
      toAbs: null,
      expected: { size: 0, mtimeMs: 0, ctimeMs: 0 },
    });
  }

  return folders.length;
}

function junkRecords(context: PlannerContext, rootId: RootId, dir: string | null): FileRecord[] {
  const rows = context.db.all(
    `SELECT f.id FROM files f WHERE f.root_id = $root AND f.is_junk = 1
      ${dir === null ? "" : "AND f.dir = $dir"}`,
    z.object({ id: FileIdSchema }),
    dir === null ? { $root: rootId } : { $root: rootId, $dir: dir },
  );

  return loadRecords(
    context,
    rows.map((row) => row.id),
  );
}

/** Expands a request into concrete steps against the current catalog. Nothing touches disk. */
export function draftSteps(context: PlannerContext, request: PlanRequest): PlanDraft {
  const warnings: string[] = [];
  const steps: DraftStep[] = [];
  const dismissals: FileId[][] = [];
  let count: number | null = null;

  switch (request.kind) {
    case "hold": {
      for (const record of loadRecords(context, request.fileIds)) {
        steps.push(fileStep(record, { kind: "hold", reason: "Removed" }, null));
      }

      break;
    }

    case "move": {
      const target = path.resolve(request.targetDir);
      const inRoot = context.roots.some((root) => isWithin(target, root.path));

      if (!inRoot) {
        warnings.push(
          "The target folder is outside every root, so moved files leave Glazier's catalog.",
        );
      }

      for (const record of loadRecords(context, request.fileIds)) {
        steps.push(fileStep(record, { kind: "move" }, path.join(target, record.name)));
      }

      break;
    }

    case "rename": {
      const records = loadRecords(
        context,
        request.renames.map((rename) => rename.fileId),
      );

      const byId = new Map(records.map((record) => [record.id, record]));

      for (const rename of request.renames) {
        const record = byId.get(rename.fileId);
        const name = rename.name.trim();

        if (!record || name === record.name) {
          continue;
        }

        if (!isPlainFileName(name)) {
          throw new PlanRequestError(`"${name}" is not a usable file name.`);
        }

        steps.push(fileStep(record, { kind: "rename" }, besideOriginal(record, name)));
      }

      break;
    }

    case "fix-extension": {
      for (const record of loadRecords(context, request.fileIds)) {
        const extension = record.format === null ? null : preferredExtension(record.format);

        if (record.ext_mismatch === 1 && extension !== null) {
          steps.push(
            fileStep(
              record,
              { kind: "rename" },
              besideOriginal(record, replaceFileExtension(record.name, extension)),
            ),
          );
        }
      }

      break;
    }

    case "optimize": {
      const wanted = new Set<FileId>(request.fileIds ?? []);

      const scan = findOptimizeCandidates(context.db, request.rootId, context.candidateHolds);

      for (const candidate of scan.candidates) {
        if (!request.categories.includes(candidate.category)) {
          continue;
        }

        if (request.fileIds !== null && !wanted.has(candidate.record.id)) {
          continue;
        }

        const target = besideOriginal(candidate.record, candidate.targetName);

        switch (candidate.category) {
          case "still-to-avif":
            steps.push(fileStep(candidate.record, { kind: "convert-avif" }, target));
            break;
          case "animation-to-mp4":
            steps.push(
              fileStep(
                candidate.record,
                { kind: "convert-animation", mimeType: candidate.mimeType },
                target,
              ),
            );
            break;
          case "video-remux":
          case "video-convert":
            steps.push(
              fileStep(
                candidate.record,
                {
                  kind: "convert-video",
                  video: candidate.plan.video,
                  audio: candidate.plan.audio,
                  quality: context.settings.reencodeQuality,
                  requireSmaller: false,
                },
                target,
              ),
            );
            break;
          case "rename-avif":
          case "rename-mp4":
            steps.push(fileStep(candidate.record, { kind: "rename" }, target));
            break;
          default: {
            const _exhaustive: never = candidate;

            return _exhaustive;
          }
        }
      }

      break;
    }

    case "reencode":
    case "strip-audio": {
      let skipped = 0;

      for (const record of loadRecords(context, request.fileIds)) {
        const source = record.kind === "video" ? videoSourceOf(record) : null;

        if (source === null) {
          skipped += 1;

          continue;
        }

        const step =
          request.kind === "reencode"
            ? videoStep(record, planVideoReencode(source, request.codec), {
                quality: request.quality,
                requireSmaller: true,
              })
            : videoStep(record, planStripAudio(source), {
                quality: context.settings.reencodeQuality,
                requireSmaller: false,
              });

        if (step.kind === "skip") {
          skipped += 1;
        } else {
          steps.push(step.step);
        }
      }

      if (skipped > 0) {
        warnings.push(
          `${skipped} selected files are not videos Glazier can rewrite and are left out.`,
        );
      }

      break;
    }

    case "resolve-duplicates":
    case "resolve-duplicate-sets": {
      const resolution = draftResolution(
        context,
        request.kind === "resolve-duplicates"
          ? request.groups
          : setGroups(request, context.duplicateSets),
      );

      steps.push(...resolution.steps);
      warnings.push(...resolution.warnings);
      dismissals.push(...resolution.dismissals);
      count = resolution.resolved;

      break;
    }

    case "clean-junk": {
      for (const record of junkRecords(context, request.rootId, null)) {
        steps.push(fileStep(record, { kind: "hold", reason: "System junk" }, null));
      }

      break;
    }

    case "remove-empty-folders": {
      const folders: DraftStep[] = [];
      count = draftFolderRemovals(context, request.rootId, folders);

      for (const folder of folders) {
        // A folder holding only `.DS_Store` and the like counts as empty; its junk goes first.
        for (const record of junkRecords(context, request.rootId, folder.fromRel)) {
          steps.push(fileStep(record, { kind: "hold", reason: "System junk" }, null));
        }

        steps.push(folder);
      }

      break;
    }

    case "cleanup": {
      const scan = findOptimizeCandidates(context.db, request.rootId, context.candidateHolds);

      // Renames and junk first, so folders that held only junk are empty when their turn comes.
      for (const fix of extensionFixes(context.db, request.rootId, scan.candidates)) {
        steps.push(fileStep(fix.record, { kind: "rename" }, besideOriginal(fix.record, fix.name)));
      }

      for (const record of junkRecords(context, request.rootId, null)) {
        steps.push(fileStep(record, { kind: "hold", reason: "System junk" }, null));
      }

      draftFolderRemovals(context, request.rootId, steps);

      break;
    }

    default: {
      const _exhaustive: never = request;

      return _exhaustive;
    }
  }

  return { steps, warnings, count: count ?? steps.length, dismissals };
}

function isPlainFileName(name: string): boolean {
  return (
    name !== "." &&
    name !== ".." &&
    !/[\\/]/.test(name) &&
    !name.includes("\0") &&
    name.length <= 255
  );
}

export function isWithin(target: string, rootPath: string): boolean {
  const relative = path.relative(rootPath, target);

  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/** Saves a draft plan and its steps, and returns the preview the owner reviews before applying. */
export function savePlan(
  context: PlannerContext,
  request: PlanRequest,
  draft: PlanDraft,
): PlanPreview {
  if (draft.steps.length === 0 && draft.dismissals.length === 0) {
    throw new PlanRequestError("There is nothing to do for this selection.");
  }

  const planId = context.db.transaction(() => {
    const created = context.db.run(
      "INSERT INTO plans (kind, created_at, status, count) VALUES ($kind, $now, 'draft', $count)",
      { $kind: request.kind, $now: Date.now(), $count: draft.count },
    );

    const id = PlanIdSchema.parse(created.lastInsertRowid);

    for (const step of draft.steps) {
      context.db.run(
        `INSERT INTO plan_steps (plan_id, action, root_id, from_rel, to_abs, spec, expected_size,
          expected_mtime_ms, expected_ctime_ms, bytes_before)
          VALUES ($plan, $action, $root, $from, $to, $spec, $size, $mtime, $ctime, $size)`,
        {
          $plan: id,
          $action: step.spec.kind,
          $root: step.rootId,
          $from: step.fromRel,
          $to: step.toAbs,
          $spec: JSON.stringify(step.spec),
          $size: step.expected.size,
          $mtime: step.expected.mtimeMs,
          $ctime: step.expected.ctimeMs,
        },
      );
    }

    for (const fileIds of draft.dismissals) {
      addDismissal(context.db, { fileIds, planId: id });
    }

    return id;
  });

  return previewOf(context, { planId, kind: request.kind, draft });
}

/** Whether a step puts a file in holding: a hold outright, a conversion the original it replaces. */
const MOVES_TO_HOLDING = {
  hold: true,
  move: false,
  rename: false,
  "convert-avif": true,
  "convert-animation": true,
  "convert-video": true,
  "remove-folder": false,
} as const satisfies Record<PlanStepAction, boolean>;

function previewOf(
  context: PlannerContext,
  plan: {
    planId: PlanId;
    kind: PlanKind;
    draft: PlanDraft;
  },
): PlanPreview {
  const counts = new Map<PlanStepAction, number>();
  let bytesToHolding = 0;
  let bytesTouched = 0;
  let removedPaths = 0;
  let addedPaths = 0;

  for (const step of plan.draft.steps) {
    counts.set(step.spec.kind, (counts.get(step.spec.kind) ?? 0) + 1);
    bytesTouched += step.expected.size;

    if (MOVES_TO_HOLDING[step.spec.kind]) {
      bytesToHolding += step.expected.size;
    }

    if (step.spec.kind === "remove-folder") {
      continue;
    }

    // Lockstep only syncs media; junk and other files never reach Pane View.
    if (isSupportedMediaFile(step.fromRel)) {
      removedPaths += 1;
    }

    if (
      step.toAbs !== null &&
      isSupportedMediaFile(step.toAbs) &&
      context.roots.some((root) => step.toAbs !== null && isWithin(step.toAbs, root.path))
    ) {
      addedPaths += 1;
    }
  }

  return {
    planId: plan.planId,
    kind: plan.kind,
    steps: plan.draft.steps.length,
    byAction: [...counts].map(([action, steps]) => ({ action, steps })),
    bytesToHolding,
    bytesTouched,
    lockstep: { removedPaths, addedPaths },
    warnings: [...plan.draft.warnings],
  };
}
