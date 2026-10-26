import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { z } from "zod";

import { CatalogDatabase } from "../catalog/database.js";
import { toAbsolutePath, toFileRow } from "../catalog/file-rows.js";
import {
  deleteUnseenFiles,
  fileFacets,
  filterNeedsConvertible,
  getFileRecords,
  listEmptyFolders,
  listFileIds,
  listFiles,
  listFolders,
  replaceEmptyFolders,
  rootsOfFiles,
  selectionSummary,
  upsertWalkedFiles,
} from "../catalog/files.js";
import {
  addRoot,
  listRoots,
  markScanned,
  readSettings,
  removeRoot,
  writeSettings,
} from "../catalog/roots.js";
import { catalogTidy } from "../catalog/tidy.js";
import {
  type EncoderCapabilities,
  type EngineEvent,
  type EngineMethodName,
  EngineMethods,
  type EngineOutput,
  type Job,
  type OptimizeCategory,
  type OptimizeEstimate,
  type PlanId,
  type PlanPreview,
  type PlanRequest,
  type Root,
  type RootId,
  type Settings,
  type SimilarityLevel,
  type Tidy,
} from "../contract.js";
import { addDismissal, Dismissals, removeDismissal } from "../duplicates/dismissals.js";
import { computeSimilarClusters, fingerprintCoverage } from "../duplicates/queries.js";
import {
  buildDuplicateSets,
  type ComputedSet,
  duplicateTotals,
  openSets,
  pageDuplicateSets,
} from "../duplicates/sets.js";
import { hasSvtAv1, withFfmpegFallback } from "../media/ffmpeg-transcode.js";
import type { MediaToolkit } from "../media/toolkit.js";
import {
  type CandidateHolds,
  type CandidateScan,
  findOptimizeCandidates,
  forgetConvertible,
  NO_HOLDS,
  type OptimizeCandidate,
  recordConvertible,
  summarizeCandidates,
} from "../optimize/candidates.js";
import type { StillEncoder, Transcoder } from "../optimize/encoders.js";
import { findShrinkCandidates, type ShrinkScan } from "../optimize/shrink.js";
import type { PassContext } from "../passes/context.js";
import { runDetailPass } from "../passes/detail-pass.js";
import { pendingFingerprints, runFingerprintPass } from "../passes/fingerprint-pass.js";
import { runHashPass } from "../passes/hash-pass.js";
import { pendingLoudness, runLoudnessPass } from "../passes/loudness-pass.js";
import { runProbePass } from "../passes/probe-pass.js";
import { runSniffPass } from "../passes/sniff-pass.js";
import {
  applyPlan,
  discardDraft,
  type ExecutorDeps,
  getPlan,
  listPlanSteps,
  listPlans,
  planRootIds,
  planSubject,
  recoverInterruptedPlans,
  undoPlan,
} from "../plans/executor.js";
import {
  followDataFolder,
  HoldingPlaces,
  heldBatchPaths,
  listHolding,
  markBatchesEmptied,
  relocateLegacyHolding,
  restoreHeld,
} from "../plans/holding.js";
import {
  draftSteps,
  extensionFixes,
  isWithin,
  type PlannerContext,
  savePlan,
} from "../plans/planner.js";
import { applyLabel, undoLabel } from "../plans/wording.js";
import { walkRoot } from "../scan/walk.js";
import type { SimilarCluster } from "../similarity/group.js";
import { type JobContext, JobQueue, type JobSpec } from "./jobs.js";
import { ThumbnailCache } from "./thumbnails.js";

/** Any JSON value; what arrives over a process boundary before it is parsed. */
const JsonValueSchema = z.json();

export type JsonValue = z.infer<typeof JsonValueSchema>;

export interface EngineOptions {
  /** Where the catalog and thumbnail cache live (the app's user-data folder). */
  dataDir: string;
  toolkit: MediaToolkit;
  stillEncoder: StillEncoder;
  transcoder: Transcoder;
  /** How many AVIF encodes run at once. */
  stillConcurrency: number;
  emit: (event: EngineEvent) => void;
}

type Routes = { [M in EngineMethodName]: (raw: JsonValue) => Promise<EngineOutput<M>> };

const NO_CAPABILITIES: EncoderCapabilities = {
  video: { avc: false, hevc: false, av1: false },
  aac: false,
  ffmpeg: false,
  svtAv1: false,
  ffprobe: false,
};

/** Tiles Shrink shows for the batch that runs next. */
const SHRINK_PREVIEW_ROWS = 60;

function shrinkTotals(scan: ShrinkScan): Tidy["shrink"] {
  let bytes = 0;
  let estimatedBytes = 0;

  for (const { item } of scan.candidates) {
    bytes += item.bytes;
    estimatedBytes += item.estimatedBytes;
  }

  return { files: scan.candidates.length, bytes, estimatedBytes };
}

/** Samples per category an estimate converts; videos take longest, so fewer of them. */
const VIDEO_SAMPLES = 3;

const STILL_SAMPLES = 8;

interface CachedEstimate {
  files: number;
  bytes: number;
  quality: Settings["reencodeQuality"];
  estimate: Promise<OptimizeEstimate>;
}

/**
 * The Glazier engine: the catalog, the analysis passes, plans and holding, behind the methods of
 * `EngineMethods`. It knows nothing of Electron; the desktop app runs it in a utility process and
 * tests run it in place.
 */
export class GlazierEngine {
  private readonly jobs: JobQueue;

  private readonly thumbnails: ThumbnailCache;

  private readonly places: HoldingPlaces;

  /** The Mediabunny transcoder, falling back to ffmpeg for files it cannot convert. */
  private readonly transcoder: Transcoder;

  private readonly routes: Routes;

  private capabilities: EncoderCapabilities;

  private scanCounter = Date.now();

  /** Bumped whenever the catalog changes, so a result computed across a change is not cached. */
  private generation = 0;

  private readonly tidyCache = new Map<RootId, Tidy>();

  /** Convert candidates per root, mirrored into the `convertible_files` temp table. */
  private readonly candidateCache = new Map<RootId, CandidateScan>();

  /** Shrink candidates per root, dropped with Convert's whenever the catalog changes. */
  private readonly shrinkCache = new Map<RootId, ShrinkScan>();

  /** Duplicate sets per root and level, before dismissals (applied per request) hide some. */
  private readonly setCache = new Map<string, Promise<ComputedSet[]>>();

  /**
   * Similar clusters per root and level. Comparing fingerprints is the slow part of building
   * sets, and only new or changed fingerprints change the answer, so this survives other catalog
   * changes: a file resolved away since simply drops out of its cluster when sets are built.
   */
  private readonly clusterCache = new Map<string, Promise<SimilarCluster[]>>();

  /** Estimates per root and category, kept while the category holds the same files and bytes. */
  private readonly estimateCache = new Map<string, CachedEstimate>();

  private constructor(
    private readonly db: CatalogDatabase,
    private readonly options: EngineOptions,
  ) {
    this.jobs = new JobQueue((job) => options.emit({ kind: "job", job }));
    this.transcoder = withFfmpegFallback(options.transcoder, options.toolkit.ffmpegPath);
    this.thumbnails = new ThumbnailCache(path.join(options.dataDir, "thumbnails"), options.toolkit);
    this.places = new HoldingPlaces(options.dataDir);
    this.capabilities = {
      ...NO_CAPABILITIES,
      ffmpeg: options.toolkit.ffmpegPath !== null,
      ffprobe: options.toolkit.ffprobePath !== null,
    };
    this.routes = this.buildRoutes();
  }

  static async open(options: EngineOptions): Promise<GlazierEngine> {
    await mkdir(options.dataDir, { recursive: true });
    const db = new CatalogDatabase(path.join(options.dataDir, "catalog.sqlite"));
    followDataFolder(db, options.dataDir);
    await recoverInterruptedPlans(db);

    const engine = new GlazierEngine(db, options);
    await relocateLegacyHolding({ db, places: engine.places });
    engine.capabilities = {
      ...engine.capabilities,
      svtAv1: await hasSvtAv1(options.toolkit.ffmpegPath),
    };

    return engine;
  }

  /** Cancels every job and closes the catalog. */
  close(): void {
    this.jobs.cancelAll();
    this.db.close();
  }

  /** Records what the transcoder window can encode on this machine. */
  setEncoderCapabilities(video: EncoderCapabilities["video"], aac: boolean): void {
    this.capabilities = { ...this.capabilities, video, aac };
    this.options.emit({ kind: "capabilities", capabilities: this.capabilities });
  }

  /** Runs one method on input that arrived over a process boundary; it is parsed here. */
  dispatch(method: EngineMethodName, raw: JsonValue): Promise<EngineOutput<EngineMethodName>> {
    return this.routes[method](raw);
  }

  private buildRoutes(): Routes {
    const m = EngineMethods;

    return {
      getState: async (raw) => {
        m.getState.input.parse(raw);

        return {
          roots: listRoots(this.db),
          settings: readSettings(this.db),
          jobs: this.jobs.list(),
          capabilities: this.capabilities,
        };
      },
      addRoot: async (raw) => {
        const root = await addRoot(this.db, m.addRoot.input.parse(raw).path);
        this.emitRoots();
        this.enqueueScan(root);

        return root;
      },
      removeRoot: async (raw) => {
        const { rootId } = m.removeRoot.input.parse(raw);
        const active = this.jobs.list().filter((job) => job.rootId === rootId && isActive(job));

        if (active.some((job) => !job.background)) {
          throw new Error("Wait for this root's jobs to finish before removing it.");
        }

        // Background analysis is only ever worth finishing for a root that stays.
        for (const job of active) {
          this.jobs.cancel(job.id);
        }

        removeRoot(this.db, rootId);
        this.invalidate();
        this.emitRoots();

        return listRoots(this.db);
      },
      scanRoot: async (raw) =>
        this.enqueueScan(this.requireRoot(m.scanRoot.input.parse(raw).rootId)),
      cancelJob: async (raw) => {
        this.jobs.cancel(m.cancelJob.input.parse(raw).jobId);

        return {};
      },
      pauseJob: async (raw) => {
        const { jobId, paused } = m.pauseJob.input.parse(raw);
        this.jobs.setPaused(jobId, paused);

        return {};
      },
      tidy: async (raw) => this.tidy(this.requireRoot(m.tidy.input.parse(raw).rootId).id),
      listFiles: async (raw) => {
        const query = m.listFiles.input.parse(raw);

        if (filterNeedsConvertible(query)) {
          await this.prepareConvertible(query.rootId);
        }

        return listFiles(this.db, query);
      },
      listFileIds: async (raw) => {
        const filter = m.listFileIds.input.parse(raw);

        if (filterNeedsConvertible(filter)) {
          await this.prepareConvertible(filter.rootId);
        }

        return listFileIds(this.db, filter);
      },
      fileFacets: async (raw) => {
        const filter = m.fileFacets.input.parse(raw);
        await this.prepareConvertible(filter.rootId);

        return fileFacets(this.db, filter);
      },
      getFiles: async (raw) =>
        getFileRecords(this.db, m.getFiles.input.parse(raw).ids).map(toFileRow),
      selectionSummary: async (raw) => {
        const { fileIds } = m.selectionSummary.input.parse(raw);

        for (const rootId of rootsOfFiles(this.db, fileIds)) {
          await this.candidates(rootId);
        }

        return selectionSummary(this.db, fileIds);
      },
      listFolders: async (raw) => listFolders(this.db, m.listFolders.input.parse(raw).rootId),
      listEmptyFolders: async (raw) =>
        listEmptyFolders(this.db, m.listEmptyFolders.input.parse(raw).rootId),
      duplicateSets: async (raw) => {
        const request = m.duplicateSets.input.parse(raw);
        const computed = await this.duplicateSetList(request.rootId, request.level);
        const coverage = fingerprintCoverage(this.db, request.rootId);

        return {
          ...pageDuplicateSets(computed, Dismissals.load(this.db), request),
          fingerprinted: coverage.fingerprinted,
          fingerprintable: coverage.fingerprintable,
        };
      },
      dismissDuplicateSet: async (raw) => {
        const { fileIds } = m.dismissDuplicateSet.input.parse(raw);
        const dismissalId = addDismissal(this.db, { fileIds, planId: null });
        this.dismissalsChanged();

        return { dismissalId };
      },
      restoreDuplicateSet: async (raw) => {
        removeDismissal(this.db, m.restoreDuplicateSet.input.parse(raw).dismissalId);
        this.dismissalsChanged();

        return {};
      },
      analyzeSimilar: async (raw) =>
        this.requestAnalysis(this.similarJob(m.analyzeSimilar.input.parse(raw).rootId, false)),
      analyzeSound: async (raw) =>
        this.requestAnalysis(this.soundJob(m.analyzeSound.input.parse(raw).rootId, false)),
      optimizeSummary: async (raw) =>
        summarizeCandidates(await this.candidates(m.optimizeSummary.input.parse(raw).rootId)),
      shrinkSummary: async (raw) => {
        const scan = await this.shrinkScan(m.shrinkSummary.input.parse(raw).rootId);

        return {
          items: scan.candidates.map((candidate) => candidate.item),
          preview: scan.candidates
            .slice(0, SHRINK_PREVIEW_ROWS)
            .map((candidate) => toFileRow(candidate.record)),
          skipped: [...scan.skipped].map(([reason, files]) => ({ reason, files })),
        };
      },
      estimateOptimize: async (raw) => {
        const { rootId, category } = m.estimateOptimize.input.parse(raw);

        return this.estimate(rootId, category);
      },
      previewPlan: async (raw) => this.preview(m.previewPlan.input.parse(raw)),
      perform: async (raw) => {
        const preview = await this.preview(m.perform.input.parse(raw));

        return {
          preview,
          job: this.enqueueApply(preview.planId),
        };
      },
      applyPlan: async (raw) => this.enqueueApply(m.applyPlan.input.parse(raw).planId),
      discardPlan: async (raw) => {
        discardDraft(this.db, m.discardPlan.input.parse(raw).planId);

        return {};
      },
      listPlans: async (raw) => listPlans(this.db, m.listPlans.input.parse(raw)),
      getPlan: async (raw) => {
        const plan = getPlan(this.db, m.getPlan.input.parse(raw).planId);

        if (plan === null) {
          throw new Error("That plan no longer exists.");
        }

        return plan;
      },
      planSteps: async (raw) => listPlanSteps(this.db, m.planSteps.input.parse(raw)),
      undoPlan: async (raw) => {
        const { planId } = m.undoPlan.input.parse(raw);
        const subject = planSubject(this.db, planId);

        if (subject === null) {
          throw new Error("That plan no longer exists.");
        }

        return this.jobs.enqueue({
          type: "undo",
          rootId: planRootIds(this.db, planId)[0] ?? null,
          planId,
          background: false,
          label: undoLabel(subject),
          run: async (context) => {
            try {
              await undoPlan(this.executorDeps(context), planId);
            } finally {
              this.invalidate();
            }

            this.rescanRootsOf(planId);
          },
        });
      },
      listHolding: async (raw) => listHolding(this.db, m.listHolding.input.parse(raw)),
      restoreHolding: async (raw) => {
        const { ids } = m.restoreHolding.input.parse(raw);
        const failed: string[] = [];
        const touched = new Set<RootId>();
        let restored = 0;

        for (const id of ids) {
          try {
            const record = await restoreHeld(this.db, id);
            touched.add(record.root_id);
            restored += 1;
          } catch (error) {
            failed.push(error instanceof Error ? error.message : String(error));
          }
        }

        for (const rootId of touched) {
          this.enqueueScan(this.requireRoot(rootId));
        }

        return { restored, failed };
      },
      holdingBatches: async (raw) => {
        const root = this.requireRoot(m.holdingBatches.input.parse(raw).rootId);

        return heldBatchPaths(this.db, root.id);
      },
      markHoldingEmptied: async (raw) => {
        const { rootId, batchPaths } = m.markHoldingEmptied.input.parse(raw);
        this.requireRoot(rootId);

        const emptied = await markBatchesEmptied(this.db, { rootId, batchPaths });

        // Holding's size shows in the sidebar and on Overview, so they refetch.
        this.options.emit({ kind: "catalog-changed", rootId });

        return { emptied };
      },
      updateSettings: async (raw) => {
        const before = readSettings(this.db);
        const settings = writeSettings(this.db, m.updateSettings.input.parse(raw));
        this.invalidate();

        if (settings.autoAnalyze && !before.autoAnalyze) {
          this.queueAnalysis(listRoots(this.db).map((root) => root.id));
        }

        // Turning Spot variants on, or changing which sets there are, needs prints for them. It
        // runs in the background, so duplicate review carries on meanwhile.
        const newSets = !before.spotVariants || before.similarity !== settings.similarity;

        if (settings.spotVariants && newSets) {
          for (const root of listRoots(this.db)) {
            if (!this.jobs.waiting("similar", root.id)) {
              this.jobs.enqueue(this.similarJob(root.id, true));
            }
          }
        }

        return settings;
      },
      thumbnail: async (raw) => {
        const request = m.thumbnail.input.parse(raw);

        if (!(await this.isAuthorizedPath(request.path))) {
          return { path: null };
        }

        return { path: await this.thumbnails.get(request.path, request.size) };
      },
      authorizedRoots: async (raw) => {
        m.authorizedRoots.input.parse(raw);

        return this.authorizedFolders();
      },
    };
  }

  private requireRoot(rootId: RootId): Root {
    const root = listRoots(this.db).find((candidate) => candidate.id === rootId);

    if (!root) {
      throw new Error("That root is no longer configured.");
    }

    return root;
  }

  /** The roots, and the holding folder of each root that has one by now. */
  private async authorizedFolders(): Promise<string[]> {
    const roots = listRoots(this.db);

    const holding = await Promise.all(
      roots.map((root) => this.places.folderFor(root).catch(() => null)),
    );

    return [...roots.map((root) => root.path), ...holding.flatMap((folder) => folder ?? [])];
  }

  private async isAuthorizedPath(filePath: string): Promise<boolean> {
    const resolved = path.resolve(filePath);

    return (await this.authorizedFolders()).some((folder) => isWithin(resolved, folder));
  }

  private emitRoots(): void {
    this.options.emit({ kind: "roots-changed", roots: listRoots(this.db) });
  }

  /** Drops the similar clusters, after fingerprints were written or reset. */
  private fingerprintsChanged(): void {
    this.clusterCache.clear();
  }

  /** Drops every derived cache after the catalog changed and tells the renderer. */
  private invalidate(): void {
    this.setCache.clear();
    this.dismissalsChanged();
  }

  /**
   * Drops what dismissals feed (Tidy totals, and Convert candidates, which leave out extra copies
   * of open duplicates) and tells the renderer. Duplicate sets are kept: dismissals apply per
   * request.
   */
  private dismissalsChanged(): void {
    this.generation += 1;
    this.tidyCache.clear();
    this.candidateCache.clear();
    this.shrinkCache.clear();
    forgetConvertible(this.db);
    this.options.emit({ kind: "catalog-changed", rootId: null });
  }

  private passContext(context: JobContext, rootId: RootId | null): PassContext {
    return {
      db: this.db,
      toolkit: this.options.toolkit,
      rootId,
      signal: context.signal,
      checkpoint: context.checkpoint,
      progress: context.progress,
    };
  }

  private executorDeps(context: JobContext): ExecutorDeps {
    return {
      db: this.db,
      places: this.places,
      toolkit: this.options.toolkit,
      stillEncoder: this.options.stillEncoder,
      transcoder: this.transcoder,
      roots: listRoots(this.db),
      stillConcurrency: this.options.stillConcurrency,
      svtAv1: this.capabilities.svtAv1,
      signal: context.signal,
      checkpoint: context.checkpoint,
      progress: context.progress,
    };
  }

  private enqueueScan(root: Root): Job {
    const pending = this.jobs.waiting("scan", root.id);

    if (pending) {
      return pending;
    }

    return this.jobs.enqueue({
      type: "scan",
      rootId: root.id,
      planId: null,
      background: false,
      label: `Scanning ${root.name}`,
      run: (context) => this.scan(root, context),
    });
  }

  private rescanRootsOf(planId: PlanId): void {
    for (const rootId of planRootIds(this.db, planId)) {
      this.enqueueScan(this.requireRoot(rootId));
    }
  }

  private similarJob(rootId: RootId | null, background: boolean): JobSpec {
    return {
      type: "similar",
      rootId,
      planId: null,
      background,
      label: "Finding similar versions",
      run: async (context) => {
        try {
          await runFingerprintPass(this.passContext(context, rootId));
          this.fingerprintsChanged();
          this.setCache.clear();

          const settings = readSettings(this.db);

          // Spot variants compares the stills of the sets those fingerprints made.
          if (settings.spotVariants) {
            const sets = await this.duplicateSetList(rootId, settings.similarity);
            const open = openSets(sets, Dismissals.load(this.db), "all");

            await runDetailPass(
              this.passContext(context, rootId),
              open.flatMap((entry) => (entry.set.kind === "similar" ? entry.fileIds : [])),
            );
          }
        } finally {
          this.fingerprintsChanged();
          this.invalidate();
        }
      },
    };
  }

  private soundJob(rootId: RootId | null, background: boolean): JobSpec {
    return {
      type: "sound",
      rootId,
      planId: null,
      background,
      label: "Measuring soundtracks",
      run: async (context) => {
        try {
          await runLoudnessPass(this.passContext(context, rootId));
        } finally {
          this.invalidate();
        }
      },
    };
  }

  /** Analysis the owner asked for: a waiting background run of it moves to the foreground. */
  private requestAnalysis(spec: JobSpec): Job {
    const waiting = this.jobs.waiting(spec.type, spec.rootId);

    return (waiting ? this.jobs.promote(waiting.id) : null) ?? this.jobs.enqueue(spec);
  }

  /**
   * With auto-analysis on, queues background fingerprinting and then loudness measurement for
   * roots whose files need them, unless such a job is already waiting.
   */
  private queueAnalysis(rootIds: readonly RootId[]): void {
    if (!readSettings(this.db).autoAnalyze) {
      return;
    }

    for (const rootId of rootIds) {
      if (pendingFingerprints(this.db, rootId) > 0 && !this.jobs.waiting("similar", rootId)) {
        this.jobs.enqueue(this.similarJob(rootId, true));
      }

      if (
        this.options.toolkit.ffmpegPath !== null &&
        pendingLoudness(this.db, rootId) > 0 &&
        !this.jobs.waiting("sound", rootId)
      ) {
        this.jobs.enqueue(this.soundJob(rootId, true));
      }
    }
  }

  private enqueueApply(planId: PlanId): Job {
    const subject = planSubject(this.db, planId);

    if (subject === null) {
      throw new Error("That plan no longer exists.");
    }

    const rootIds = planRootIds(this.db, planId);

    return this.jobs.enqueue({
      type: "apply",
      rootId: rootIds[0] ?? null,
      planId,
      background: false,
      label: applyLabel(subject),
      run: async (context) => {
        try {
          const { staleSteps } = await applyPlan(this.executorDeps(context), planId);

          // Files that changed or left since the scan were skipped; a scan catches the catalog
          // up, so the next try acts on what is there now.
          if (staleSteps > 0) {
            this.rescanRootsOf(planId);
          }
        } finally {
          this.invalidate();
          this.emitRoots();
          // Conversions write files that need fingerprints and, without copied audio, loudness.
          this.queueAnalysis(rootIds);
        }
      },
    });
  }

  /** Saves a request as a draft plan and returns its preview. */
  private async preview(request: PlanRequest): Promise<PlanPreview> {
    const holdsRoot =
      request.kind === "optimize" || request.kind === "cleanup" || request.kind === "shrink-videos"
        ? request.rootId
        : null;

    const context: PlannerContext = {
      db: this.db,
      roots: listRoots(this.db),
      settings: readSettings(this.db),
      candidateHolds: holdsRoot === null ? NO_HOLDS : await this.candidateHolds(holdsRoot),
    };

    return savePlan(context, request, draftSteps(context, request));
  }

  /**
   * Walks a root and runs the cheap passes: formats, media details, duplicate hashes. A root
   * that is not mounted fails the scan instead of looking empty, so its catalog survives.
   */
  private async scan(root: Root, context: JobContext): Promise<void> {
    const rootStat = await stat(root.path).catch(() => null);

    if (!rootStat?.isDirectory()) {
      throw new Error(`${root.path} is not available. Is its drive connected?`);
    }

    this.scanCounter = Math.max(Date.now(), this.scanCounter + 1);
    const scanId = this.scanCounter;

    context.progress({ done: 0, total: 0, label: `Walking ${root.name}` });

    const summary = await walkRoot({
      rootPath: root.path,
      signal: context.signal,
      onBatch: (files) => upsertWalkedFiles(this.db, { rootId: root.id, scanId }, files),
      onProgress: (files) =>
        context.progress({ done: files, total: 0, label: `Walking ${root.name}` }),
    });

    deleteUnseenFiles(this.db, root.id, scanId);
    replaceEmptyFolders(this.db, root.id, summary.emptyFolders);
    // A file whose bytes changed lost its fingerprint in the walk.
    this.fingerprintsChanged();
    this.invalidate();

    const pass = this.passContext(context, root.id);
    await runSniffPass(pass);
    await runProbePass(pass);
    this.invalidate();
    await runHashPass(pass);

    markScanned(this.db, root.id);
    this.invalidate();
    this.emitRoots();
    this.queueAnalysis([root.id]);
  }

  private async tidy(rootId: RootId): Promise<Tidy> {
    const cached = this.tidyCache.get(rootId);

    if (cached) {
      return cached;
    }

    const generation = this.generation;
    const settings = readSettings(this.db);
    const sets = await this.duplicateSetList(rootId, settings.similarity);
    const open = openSets(sets, Dismissals.load(this.db), "all");
    const scan = await this.candidates(rootId);
    const catalog = catalogTidy(this.db, rootId);

    const tidy: Tidy = {
      files: catalog.files,
      bytes: catalog.bytes,
      lastScanAt: catalog.lastScanAt,
      duplicates: {
        exact: duplicateTotals(open.filter((entry) => entry.set.kind === "exact")),
        similar: duplicateTotals(open.filter((entry) => entry.set.kind === "similar")),
      },
      convert: summarizeCandidates(scan),
      shrink: shrinkTotals(await this.shrinkScan(rootId)),
      silentTracks: catalog.silentTracks,
      cleanup: {
        junk: catalog.junk,
        emptyFolders: catalog.emptyFolders,
        extensions: extensionFixes(this.db, rootId, scan.candidates).length,
      },
      attention: catalog.attention,
      analysis: catalog.analysis,
    };

    if (generation === this.generation) {
      this.tidyCache.set(rootId, tidy);
    }

    return tidy;
  }

  /**
   * What Convert leaves alone for now: members of open similar sets at the current level, and,
   * while background analysis will check them, files not yet fingerprinted.
   */
  private async candidateHolds(rootId: RootId): Promise<CandidateHolds> {
    const settings = readSettings(this.db);
    const sets = await this.duplicateSetList(rootId, settings.similarity);
    const similar = openSets(sets, Dismissals.load(this.db), "similar");

    return {
      reviewing: new Set(similar.flatMap((entry) => entry.fileIds)),
      waitForFingerprints: settings.autoAnalyze,
    };
  }

  private async candidates(rootId: RootId): Promise<CandidateScan> {
    const cached = this.candidateCache.get(rootId);

    if (cached) {
      return cached;
    }

    const generation = this.generation;
    const holds = await this.candidateHolds(rootId);
    const scan = findOptimizeCandidates(this.db, rootId, holds);

    // A scan computed across a catalog change is used once and not kept.
    if (generation === this.generation) {
      recordConvertible(this.db, rootId, scan.candidates);
      this.candidateCache.set(rootId, scan);
    }

    return scan;
  }

  private async shrinkScan(rootId: RootId): Promise<ShrinkScan> {
    const cached = this.shrinkCache.get(rootId);

    if (cached) {
      return cached;
    }

    const generation = this.generation;
    const scan = findShrinkCandidates(this.db, rootId, await this.candidateHolds(rootId));

    if (generation === this.generation) {
      this.shrinkCache.set(rootId, scan);
    }

    return scan;
  }

  /** Makes sure the convertible files of a root (or every root) are recorded for file queries. */
  private async prepareConvertible(rootId: RootId | null): Promise<void> {
    const rootIds = rootId === null ? listRoots(this.db).map((root) => root.id) : [rootId];

    for (const id of rootIds) {
      await this.candidates(id);
    }
  }

  private duplicateSetList(rootId: RootId | null, level: SimilarityLevel): Promise<ComputedSet[]> {
    const key = `${rootId}:${level}`;
    const cached = this.setCache.get(key);

    if (cached) {
      return cached;
    }

    const computed = (async () => {
      const clusters = await this.similarClusters(rootId, level);

      return buildDuplicateSets(this.db, { rootId, settings: readSettings(this.db), clusters });
    })();

    this.setCache.set(key, computed);

    void computed.catch(() => {
      if (this.setCache.get(key) === computed) {
        this.setCache.delete(key);
      }
    });

    return computed;
  }

  private similarClusters(
    rootId: RootId | null,
    level: SimilarityLevel,
  ): Promise<SimilarCluster[]> {
    const key = `${rootId}:${level}`;
    const cached = this.clusterCache.get(key);

    if (cached) {
      return cached;
    }

    const computed = computeSimilarClusters(
      this.db,
      { rootId, level },
      () => new Promise((resolve) => setImmediate(resolve)),
    );

    this.clusterCache.set(key, computed);

    void computed.catch(() => {
      if (this.clusterCache.get(key) === computed) {
        this.clusterCache.delete(key);
      }
    });

    return computed;
  }

  /**
   * What converting a category would save, from a sample converted into a temp folder (never
   * the archive). Kept while the category holds the same number of files and bytes, so asking
   * for every category each time Tidy opens does not encode the samples again.
   */
  private async estimate(rootId: RootId, category: OptimizeCategory): Promise<OptimizeEstimate> {
    const pool = (await this.candidates(rootId)).candidates.filter(
      (candidate) => candidate.category === category,
    );

    const key = `${rootId}:${category}`;
    const bytes = pool.reduce((sum, candidate) => sum + candidate.record.size, 0);
    const quality = readSettings(this.db).reencodeQuality;
    const cached = this.estimateCache.get(key);

    if (
      cached &&
      cached.files === pool.length &&
      cached.bytes === bytes &&
      cached.quality === quality
    ) {
      return cached.estimate;
    }

    const estimate = this.sampleEstimate(category, pool, quality);
    this.estimateCache.set(key, { files: pool.length, bytes, quality, estimate });

    void estimate.catch(() => {
      if (this.estimateCache.get(key)?.estimate === estimate) {
        this.estimateCache.delete(key);
      }
    });

    return estimate;
  }

  /** Converts an even spread of a category's files, smallest to largest, and reads the ratios. */
  private async sampleEstimate(
    category: OptimizeCategory,
    candidates: readonly OptimizeCandidate[],
    quality: Settings["reencodeQuality"],
  ): Promise<OptimizeEstimate> {
    const pool = [...candidates].sort((left, right) => left.record.size - right.record.size);

    const wanted =
      category === "video-convert" || category === "video-remux" ? VIDEO_SAMPLES : STILL_SAMPLES;

    const count = Math.min(wanted, pool.length);

    const sample = Array.from(
      { length: count },
      (_, index) => pool[Math.floor(((index + 0.5) * pool.length) / count)],
    ).flatMap((candidate) => (candidate ? [candidate] : []));

    if (category === "rename-avif" || category === "rename-mp4" || sample.length === 0) {
      return { category, sampled: sample.length, ratio: 1, ratioLow: 1, ratioHigh: 1 };
    }

    const folder = await mkdtemp(path.join(os.tmpdir(), "glazier-estimate-"));
    const ratios: number[] = [];
    const controller = new AbortController();

    try {
      for (const [index, candidate] of sample.entries()) {
        const srcPath = toAbsolutePath(candidate.record.root_path, candidate.record.rel_path);
        const outPath = path.join(folder, `${index}${path.extname(candidate.targetName)}`);

        try {
          if (candidate.category === "still-to-avif") {
            await this.options.stillEncoder.encode({ srcPath, outPath }, controller.signal);
          } else if (candidate.category === "animation-to-mp4") {
            await this.transcoder.transcode(
              { kind: "animation", srcPath, outPath, mimeType: candidate.mimeType },
              controller.signal,
              () => undefined,
            );
          } else if (
            candidate.category === "video-remux" ||
            candidate.category === "video-convert"
          ) {
            await this.transcoder.transcode(
              {
                kind: "video",
                srcPath,
                outPath,
                video: candidate.plan.video,
                audio: candidate.plan.audio,
                quality,
              },
              controller.signal,
              () => undefined,
            );
          }

          ratios.push((await stat(outPath)).size / Math.max(1, candidate.record.size));
        } catch {
          // A sample that fails to convert says nothing about size; the plan reports it later.
        }
      }
    } finally {
      await rm(folder, { force: true, recursive: true });
    }

    ratios.sort((left, right) => left - right);

    return {
      category,
      sampled: ratios.length,
      ratio: median(ratios) ?? 1,
      ratioLow: ratios[Math.floor((ratios.length - 1) * 0.25)] ?? 1,
      ratioHigh: ratios[Math.ceil((ratios.length - 1) * 0.75)] ?? 1,
    };
  }

  /** The settings as stored; exposed for the desktop app's own defaults. */
  readSettings(): Settings {
    return readSettings(this.db);
  }
}

/** The middle of sorted values, or the mean of the middle two; null for none. */
function median(sorted: readonly number[]): number | null {
  const middle = Math.floor(sorted.length / 2);
  const upper = sorted[middle];

  if (upper === undefined) {
    return null;
  }

  const lower = sorted[middle - 1];

  return sorted.length % 2 === 0 && lower !== undefined ? (lower + upper) / 2 : upper;
}

function isActive(job: Job): boolean {
  return job.state === "queued" || job.state === "running" || job.state === "paused";
}
