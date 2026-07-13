#!/usr/bin/env node
/**
 * Lockstep push-phase performance benchmark.
 *
 * Generates synthetic archives and compares scan/hash strategies relevant to push planning.
 * Run: pnpm --filter @latch-works/media-index benchmark:push-perf
 */
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { createSyncPlan, scanArchive } from "../src/index.js";
import { createEmptyHashCache, writeHashCache } from "../src/hash-cache.js";
import {
  scanArchiveIncremental,
  scanArchiveSelectiveHash,
  scanArchiveWithHashCache,
} from "../src/scan-optimized.js";
import type { RemoteEntrySnapshot } from "../src/sync-plan.js";

interface BenchScenario {
  changedFiles: number;
  fileCount: number;
  fileSizeBytes: number;
  label: string;
  newFiles: number;
}

interface BenchResult {
  durationMs: number;
  extra?: Record<string, number>;
  label: string;
  scenario: string;
  speedupVsBaseline: number;
}

async function generateArchive({
  changedFiles,
  fileCount,
  fileSizeBytes,
  newFiles,
  root,
}: {
  changedFiles: number;
  fileCount: number;
  fileSizeBytes: number;
  newFiles: number;
  root: string;
}): Promise<{ remote: RemoteEntrySnapshot[] }> {
  const remote: RemoteEntrySnapshot[] = [];
  const photosDir = path.join(root, "photos");
  await mkdir(photosDir, { recursive: true });

  const existingCount = fileCount - newFiles;
  for (let index = 0; index < fileCount; index += 1) {
    const fileName = `img-${String(index).padStart(5, "0")}.jpg`;
    const relativePath = `photos/${fileName}`;
    const absolutePath = path.join(photosDir, fileName);
    const isNew = index >= existingCount;
    const isChanged = !isNew && index < changedFiles;
    const payload = Buffer.alloc(isChanged ? fileSizeBytes + 64 : fileSizeBytes, isChanged ? 99 : index % 256);
    await writeFile(absolutePath, payload);

    if (!isNew) {
      const originalPayload = Buffer.alloc(fileSizeBytes, index % 256);
      remote.push({
        path: relativePath,
        sha256: createHash("sha256").update(originalPayload).digest("hex"),
        size: fileSizeBytes,
      });
    }
  }

  return { remote };
}

async function warmCacheFromFullScan(sourceRoot: string, cachePath: string): Promise<void> {
  const scan = await scanArchive({ hashFiles: true, fileConcurrency: 8, sourceRoot });
  const cache = createEmptyHashCache();
  for (const item of scan.items) {
    if (item.sha256) {
      cache.entries[item.path] = {
        mtimeMs: item.mtimeMs,
        sha256: item.sha256,
        size: item.size,
      };
    }
  }
  await writeHashCache(cachePath, cache);
}

async function touchChangedFiles(sourceRoot: string, count: number): Promise<void> {
  const photosDir = path.join(sourceRoot, "photos");
  const now = Date.now() / 1000;
  for (let index = 0; index < count; index += 1) {
    const fileName = `img-${String(index).padStart(5, "0")}.jpg`;
    await utimes(path.join(photosDir, fileName), now, now);
  }
}

async function runStrategy(
  name: string,
  scenario: BenchScenario,
  sourceRoot: string,
  remote: RemoteEntrySnapshot[],
  cachePath: string,
  fn: () => Promise<unknown>,
): Promise<BenchResult> {
  const start = performance.now();
  const extra = await fn();
  const durationMs = performance.now() - start;
  return {
    durationMs,
    extra: typeof extra === "object" && extra !== null ? (extra as Record<string, number>) : undefined,
    label: name,
    scenario: scenario.label,
    speedupVsBaseline: 1,
  };
}

async function simulateUploads(
  itemCount: number,
  latencyMs: number,
  concurrency: number,
): Promise<number> {
  const start = performance.now();
  let next = 0;
  let active = 0;
  let settled = false;

  await new Promise<void>((resolve) => {
    const schedule = (): void => {
      while (active < concurrency && next < itemCount) {
        next += 1;
        active += 1;
        setTimeout(() => {
          active -= 1;
          if (next === itemCount && active === 0) {
            settled = true;
            resolve();
          } else {
            schedule();
          }
        }, latencyMs);
      }
      if (next === itemCount && active === 0 && !settled) {
        settled = true;
        resolve();
      }
    };
    schedule();
  });

  return performance.now() - start;
}

async function main(): Promise<void> {
  const fileCount = Number(process.env.BENCH_FILE_COUNT ?? 2000);
  const fileSizeBytes = Number(process.env.BENCH_FILE_SIZE ?? 48 * 1024);
  const scenarios: BenchScenario[] = [
    {
      changedFiles: 0,
      fileCount,
      fileSizeBytes,
      label: "cold-all-new",
      newFiles: fileCount,
    },
    {
      changedFiles: Math.max(1, Math.floor(fileCount * 0.01)),
      fileCount,
      fileSizeBytes,
      label: "warm-1pct-changed",
      newFiles: 0,
    },
    {
      changedFiles: 0,
      fileCount,
      fileSizeBytes,
      label: "warm-no-changes",
      newFiles: 0,
    },
  ];

  const allResults: BenchResult[] = [];

  for (const scenario of scenarios) {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "lockstep-bench-"));
    const cachePath = path.join(tempRoot, ".latch-works", "hash-cache.json");
    await mkdir(path.dirname(cachePath), { recursive: true });

    try {
      const { remote } = await generateArchive({
        changedFiles: scenario.changedFiles,
        fileCount: scenario.fileCount,
        fileSizeBytes: scenario.fileSizeBytes,
        newFiles: scenario.newFiles,
        root: tempRoot,
      });

      if (scenario.label.startsWith("warm")) {
        await warmCacheFromFullScan(tempRoot, cachePath);
        if (scenario.changedFiles > 0) {
          await touchChangedFiles(tempRoot, scenario.changedFiles);
        }
      }

      const strategies: Array<{
        name: string;
        run: () => Promise<Record<string, number> | void>;
      }> = [
        {
          name: "1-baseline-hash-all-concurrency-4",
          run: async () => {
            await scanArchive({ fileConcurrency: 4, hashFiles: true, sourceRoot: tempRoot });
          },
        },
        {
          name: "2-high-concurrency-16",
          run: async () => {
            await scanArchive({ fileConcurrency: 16, hashFiles: true, sourceRoot: tempRoot });
          },
        },
        {
          name: "3-local-hash-cache",
          run: async () => {
            const result = await scanArchiveWithHashCache({
              cachePath,
              fileConcurrency: 8,
              persistCache: false,
              sourceRoot: tempRoot,
            });
            return { cacheHits: result.cacheHits, cacheMisses: result.cacheMisses };
          },
        },
        {
          name: "4-remote-selective-hash",
          run: async () => {
            const result = await scanArchiveSelectiveHash({
              fileConcurrency: 8,
              remoteEntries: remote,
              sourceRoot: tempRoot,
            });
            return { hashed: result.hashed, skippedHash: result.skippedHash };
          },
        },
        {
          name: "5-cache-plus-selective",
          run: async () => {
            const result = await scanArchiveIncremental({
              cachePath,
              fileConcurrency: 8,
              persistCache: false,
              remoteEntries: remote,
              sourceRoot: tempRoot,
            });
            return {
              cacheHits: result.cacheHits,
              hashed: result.hashed,
              skippedHash: result.skippedHash,
            };
          },
        },
        {
          name: "6-stat-only-no-hash",
          run: async () => {
            await scanArchive({ hashFiles: false, sourceRoot: tempRoot });
          },
        },
      ];

      const scenarioResults: BenchResult[] = [];
      for (const strategy of strategies) {
        const result = await runStrategy(
          strategy.name,
          scenario,
          tempRoot,
          remote,
          cachePath,
          strategy.run,
        );
        scenarioResults.push(result);
      }

      const baseline = scenarioResults.find((result) => result.label.startsWith("1-baseline"));
      if (baseline) {
        for (const result of scenarioResults) {
          result.speedupVsBaseline = baseline.durationMs / result.durationMs;
        }
      }

      allResults.push(...scenarioResults);

      const uploadCount = createSyncPlan(
        await scanArchive({ hashFiles: false, sourceRoot: tempRoot }).then((scan) => scan.items),
        remote,
      ).counts.upload + createSyncPlan(
        await scanArchive({ hashFiles: false, sourceRoot: tempRoot }).then((scan) => scan.items),
        remote,
      ).counts.update;

      const serialUploadMs = await simulateUploads(uploadCount || 100, 25, 1);
      const parallelUploadMs = await simulateUploads(uploadCount || 100, 25, 3);

      allResults.push(
        {
          durationMs: serialUploadMs,
          label: "7-upload-serial-mock",
          scenario: scenario.label,
          speedupVsBaseline: 1,
        },
        {
          durationMs: parallelUploadMs,
          label: "8-upload-parallel-3-mock",
          scenario: scenario.label,
          speedupVsBaseline: serialUploadMs / parallelUploadMs,
        },
      );
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  }

  const extrapolationFactor = 20_000 / fileCount;

  console.log("\n=== Lockstep Push Performance Benchmark ===\n");
  console.log(`Files per run: ${fileCount.toLocaleString()} (extrapolate ×${extrapolationFactor} for 20k)`);
  console.log(`File size: ${(fileSizeBytes / 1024).toFixed(1)} KiB\n`);

  for (const scenarioLabel of [...new Set(allResults.map((result) => result.scenario))]) {
    console.log(`--- ${scenarioLabel} ---`);
    console.log(
      "Strategy".padEnd(34),
      "Time(ms)".padStart(10),
      "Est@20k(s)".padStart(12),
      "Speedup".padStart(10),
      "Notes",
    );
    for (const result of allResults.filter((entry) => entry.scenario === scenarioLabel)) {
      const estSeconds = ((result.durationMs * extrapolationFactor) / 1000).toFixed(1);
      const notes = result.extra
        ? Object.entries(result.extra)
            .map(([key, value]) => `${key}=${value}`)
            .join(", ")
        : "";
      console.log(
        result.label.padEnd(34),
        result.durationMs.toFixed(0).padStart(10),
        estSeconds.padStart(12),
        `${result.speedupVsBaseline.toFixed(2)}x`.padStart(10),
        notes,
      );
    }
    console.log();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
