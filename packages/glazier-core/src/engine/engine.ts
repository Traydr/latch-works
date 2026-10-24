import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { z } from "zod";

import { CatalogDatabase } from "../catalog/database.js";
import { toAbsolutePath, toFileRow } from "../catalog/file-rows.js";
import {
  deleteUnseenFiles,
  getFileRecords,
  listFiles,
  listFolders,
  replaceEmptyFolders,
  upsertWalkedFiles,
} from "../catalog/files.js";
import { computeOverview } from "../catalog/overview.js";
import {
  addRoot,
  listRoots,
  markScanned,
  readSettings,
  removeRoot,
  writeSettings,
} from "../catalog/roots.js";
import {
  type EncoderCapabilities,
  type EngineEvent,
  type EngineMethodName,
  EngineMethods,
  type EngineOutput,
  type Job,
  type OptimizeCategory,
  type OptimizeEstimate,
  type Overview,
  type PlanId,
  type Root,
  type RootId,
  type Settings,
  type SimilarityLevel,
} from "../contract.js";
import {
  computeSimilarClusters,
  exactDuplicateTotals,
  fingerprintCoverage,
  listExactGroups,
  loadSimilarGroups,
  type SimilarClusterSummary,
} from "../duplicates/queries.js";
import type { MediaToolkit } from "../media/toolkit.js";
import {
  type CandidateScan,
  findOptimizeCandidates,
  summarizeCandidates,
} from "../optimize/candidates.js";
import type { StillEncoder, Transcoder } from "../optimize/encoders.js";
import type { PassContext } from "../passes/context.js";
import { runFingerprintPass } from "../passes/fingerprint-pass.js";
import { runHashPass } from "../passes/hash-pass.js";
import { runLoudnessPass } from "../passes/loudness-pass.js";
import { runProbePass } from "../passes/probe-pass.js";
import { runSniffPass } from "../passes/sniff-pass.js";
import {
  applyPlan,
  discardDraft,
  type ExecutorDeps,
  listPlanSteps,
  listPlans,
  planRootIds,
  recoverInterruptedPlans,
  undoPlan,
} from "../plans/executor.js";
import { heldBatchPaths, listHolding, markBatchesEmptied, restoreHeld } from "../plans/holding.js";
import { draftSteps, isWithin, savePlan } from "../plans/planner.js";
import { walkRoot } from "../scan/walk.js";
import { type JobContext, JobQueue } from "./jobs.js";
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
  ffprobe: false,
};

/**
 * The Glazier engine: the catalog, the analysis passes, plans and holding, behind the methods of
 * `EngineMethods`. It knows nothing of Electron; the desktop app runs it in a utility process and
 * tests run it in place.
 */
export class GlazierEngine {
  private readonly jobs: JobQueue;

  private readonly thumbnails: ThumbnailCache;

  private readonly routes: Routes;

  private capabilities: EncoderCapabilities;

  private scanCounter = Date.now();

  private readonly overviewCache = new Map<string, Overview>();

  private readonly candidateCache = new Map<RootId, CandidateScan>();

  private readonly similarCache = new Map<string, Promise<SimilarClusterSummary[]>>();

  private constructor(
    private readonly db: CatalogDatabase,
    private readonly options: EngineOptions,
  ) {
    this.jobs = new JobQueue((job) => options.emit({ kind: "job", job }));
    this.thumbnails = new ThumbnailCache(path.join(options.dataDir, "thumbnails"), options.toolkit);
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
    await recoverInterruptedPlans(db);

    return new GlazierEngine(db, options);
  }

  close(): void {
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

        if (this.jobs.list().some((job) => job.rootId === rootId && isActive(job))) {
          throw new Error("Wait for this root's jobs to finish before removing it.");
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
      overview: async (raw) => this.overview(m.overview.input.parse(raw).rootId),
      listFiles: async (raw) => listFiles(this.db, m.listFiles.input.parse(raw)),
      getFiles: async (raw) =>
        getFileRecords(this.db, m.getFiles.input.parse(raw).ids).map(toFileRow),
      listFolders: async (raw) => listFolders(this.db, m.listFolders.input.parse(raw).rootId),
      exactDuplicates: async (raw) => {
        const page = m.exactDuplicates.input.parse(raw);
        const totals = exactDuplicateTotals(this.db, page.rootId);

        return {
          total: totals.groups,
          reclaimableBytes: totals.reclaimableBytes,
          groups: listExactGroups(this.db, page, readSettings(this.db)),
        };
      },
      analyzeSimilar: async (raw) => {
        const { rootId } = m.analyzeSimilar.input.parse(raw);

        return this.jobs.enqueue({
          type: "similar",
          rootId,
          label: "Finding similar pictures and videos",
          run: async (context) => {
            await runFingerprintPass(this.passContext(context, rootId));
            this.invalidate();
          },
        });
      },
      similarDuplicates: async (raw) => {
        const page = m.similarDuplicates.input.parse(raw);
        const clusters = await this.similarClusters(page.rootId, page.level);
        const coverage = fingerprintCoverage(this.db, page.rootId);

        return {
          total: clusters.length,
          fingerprinted: coverage.fingerprinted,
          fingerprintable: coverage.fingerprintable,
          groups: loadSimilarGroups(
            this.db,
            clusters.slice(page.offset, page.offset + page.limit),
            readSettings(this.db),
          ),
        };
      },
      analyzeSound: async (raw) => {
        const { rootId } = m.analyzeSound.input.parse(raw);

        return this.jobs.enqueue({
          type: "sound",
          rootId,
          label: "Listening to video soundtracks",
          run: async (context) => {
            await runLoudnessPass(this.passContext(context, rootId));
            this.invalidate();
          },
        });
      },
      optimizeSummary: async (raw) =>
        summarizeCandidates(this.candidates(m.optimizeSummary.input.parse(raw).rootId)),
      estimateOptimize: async (raw) => {
        const { rootId, category } = m.estimateOptimize.input.parse(raw);

        return this.estimate(rootId, category);
      },
      previewPlan: async (raw) => {
        const request = m.previewPlan.input.parse(raw);
        const context = { db: this.db, roots: listRoots(this.db), settings: readSettings(this.db) };

        return savePlan(context, request, draftSteps(context, request));
      },
      applyPlan: async (raw) => {
        const { planId } = m.applyPlan.input.parse(raw);

        return this.jobs.enqueue({
          type: "apply",
          rootId: planRootIds(this.db, planId)[0] ?? null,
          label: `Applying plan ${planId}`,
          run: async (context) => {
            try {
              await applyPlan(this.executorDeps(context), planId);
            } finally {
              this.invalidate();
              this.emitRoots();
            }
          },
        });
      },
      discardPlan: async (raw) => {
        discardDraft(this.db, m.discardPlan.input.parse(raw).planId);

        return {};
      },
      listPlans: async (raw) => listPlans(this.db, m.listPlans.input.parse(raw)),
      planSteps: async (raw) => listPlanSteps(this.db, m.planSteps.input.parse(raw)),
      undoPlan: async (raw) => {
        const { planId } = m.undoPlan.input.parse(raw);

        return this.jobs.enqueue({
          type: "undo",
          rootId: planRootIds(this.db, planId)[0] ?? null,
          label: `Undoing plan ${planId}`,
          run: async (context) => {
            await undoPlan(this.executorDeps(context), planId);
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

        return heldBatchPaths(this.db, root.id, root.path);
      },
      markHoldingEmptied: async (raw) => {
        const { rootId, batchPaths } = m.markHoldingEmptied.input.parse(raw);
        const root = this.requireRoot(rootId);

        return {
          emptied: await markBatchesEmptied(this.db, { rootId, rootPath: root.path, batchPaths }),
        };
      },
      updateSettings: async (raw) => {
        const settings = writeSettings(this.db, m.updateSettings.input.parse(raw));
        this.invalidate();

        return settings;
      },
      thumbnail: async (raw) => {
        const request = m.thumbnail.input.parse(raw);

        if (!this.isAuthorizedPath(request.path)) {
          return { path: null };
        }

        return { path: await this.thumbnails.get(request.path, request.size) };
      },
      authorizedRoots: async (raw) => {
        m.authorizedRoots.input.parse(raw);

        return listRoots(this.db).map((root) => root.path);
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

  private isAuthorizedPath(filePath: string): boolean {
    const resolved = path.resolve(filePath);

    return listRoots(this.db).some((root) => isWithin(resolved, root.path));
  }

  private emitRoots(): void {
    this.options.emit({ kind: "roots-changed", roots: listRoots(this.db) });
  }

  /** Drops every derived cache after the catalog changed and tells the renderer. */
  private invalidate(): void {
    this.overviewCache.clear();
    this.candidateCache.clear();
    this.similarCache.clear();
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
      toolkit: this.options.toolkit,
      stillEncoder: this.options.stillEncoder,
      transcoder: this.options.transcoder,
      roots: listRoots(this.db),
      stillConcurrency: this.options.stillConcurrency,
      signal: context.signal,
      checkpoint: context.checkpoint,
      progress: context.progress,
    };
  }

  private enqueueScan(root: Root): Job {
    const pending = this.jobs
      .list()
      .find((job) => job.type === "scan" && job.rootId === root.id && job.state === "queued");

    if (pending) {
      return pending;
    }

    return this.jobs.enqueue({
      type: "scan",
      rootId: root.id,
      label: `Scanning ${root.name}`,
      run: (context) => this.scan(root, context),
    });
  }

  private rescanRootsOf(planId: PlanId): void {
    for (const rootId of planRootIds(this.db, planId)) {
      this.enqueueScan(this.requireRoot(rootId));
    }
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
    this.invalidate();

    const pass = this.passContext(context, root.id);
    await runSniffPass(pass);
    await runProbePass(pass);
    this.invalidate();
    await runHashPass(pass);

    markScanned(this.db, root.id);
    this.invalidate();
    this.emitRoots();
  }

  private overview(rootId: RootId | null): Overview {
    const key = String(rootId);
    const cached = this.overviewCache.get(key);

    if (cached) {
      return cached;
    }

    let optimizableFiles = 0;
    let optimizableBytes = 0;
    const rootIds = rootId === null ? listRoots(this.db).map((root) => root.id) : [rootId];

    for (const id of rootIds) {
      for (const candidate of this.candidates(id).candidates) {
        optimizableFiles += 1;
        optimizableBytes += candidate.record.size;
      }
    }

    const overview = computeOverview(this.db, rootId, {
      duplicates: exactDuplicateTotals(this.db, rootId),
      optimizable: { files: optimizableFiles, bytes: optimizableBytes },
    });

    this.overviewCache.set(key, overview);

    return overview;
  }

  private candidates(rootId: RootId): CandidateScan {
    const cached = this.candidateCache.get(rootId);

    if (cached) {
      return cached;
    }

    const scan = findOptimizeCandidates(this.db, rootId);
    this.candidateCache.set(rootId, scan);

    return scan;
  }

  private similarClusters(
    rootId: RootId | null,
    level: SimilarityLevel,
  ): Promise<SimilarClusterSummary[]> {
    const key = `${rootId}:${level}`;
    const cached = this.similarCache.get(key);

    if (cached) {
      return cached;
    }

    const computed = computeSimilarClusters(
      this.db,
      { rootId, level },
      () => new Promise((resolve) => setImmediate(resolve)),
    );

    this.similarCache.set(key, computed);
    void computed.catch(() => this.similarCache.delete(key));

    return computed;
  }

  /**
   * Converts a small sample of a category into a temp folder (never the archive) to show what
   * the whole category would save, as a low–high range rather than one number.
   */
  private async estimate(rootId: RootId, category: OptimizeCategory): Promise<OptimizeEstimate> {
    const pool = this.candidates(rootId)
      .candidates.filter((candidate) => candidate.category === category)
      .sort((left, right) => left.record.size - right.record.size);

    const sampleSize = category === "video-convert" || category === "video-remux" ? 3 : 8;

    const sample = Array.from(
      { length: Math.min(sampleSize, pool.length) },
      (_, index) =>
        pool[Math.floor(((index + 0.5) * pool.length) / Math.min(sampleSize, pool.length))],
    ).flatMap((candidate) => (candidate ? [candidate] : []));

    if (category === "rename-avif" || category === "rename-mp4" || sample.length === 0) {
      return { category, sampled: sample.length, ratioLow: 1, ratioHigh: 1 };
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
            await this.options.transcoder.transcode(
              { kind: "animation", srcPath, outPath, mimeType: candidate.mimeType },
              controller.signal,
              () => undefined,
            );
          } else if (
            candidate.category === "video-remux" ||
            candidate.category === "video-convert"
          ) {
            await this.options.transcoder.transcode(
              {
                kind: "video",
                srcPath,
                outPath,
                video: candidate.plan.video,
                audio: candidate.plan.audio,
                quality: readSettings(this.db).reencodeQuality,
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
      ratioLow: ratios[Math.floor((ratios.length - 1) * 0.25)] ?? 1,
      ratioHigh: ratios[Math.ceil((ratios.length - 1) * 0.75)] ?? 1,
    };
  }

  /** The settings as stored; exposed for the desktop app's own defaults. */
  readSettings(): Settings {
    return readSettings(this.db);
  }
}

function isActive(job: Job): boolean {
  return job.state === "queued" || job.state === "running" || job.state === "paused";
}
