/*
 * The differential run against Oriel RS (plan 063): glazier-core's engine scans and analyses its
 * own copy of a throwaway archive, with Spot variants off and then on, and its report must equal
 * the committed one, which `cargo test -p oriel-core-tidy --test differential` checks Rust's
 * report against. Then e2e's Tidy cases run as scenarios of decisions, each on a fresh copy, and
 * what each decision left (the archive, holding, the journal, Overview) must equal the committed
 * `changes.json`, which `cargo test -p oriel-core-tidy --test changes` replays through Rust.
 * After a deliberate change to the engine, regenerate the archives and the reports:
 *
 *   ORIEL_RS_UPDATE_VECTORS=1 pnpm --filter @latch-works/glazier-core exec vitest run \
 *     src/engine/differential.test.ts
 *
 * Any other folder can be compared too: GLAZIER_DIFFERENTIAL_SOURCE names it (a copy is scanned,
 * never the folder) and GLAZIER_DIFFERENTIAL_OUT the report to write; nothing is compared then.
 */
import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { buildShrinkArchive, SCENARIOS, ScenarioRunner } from "../test-support/changes.js";
import {
  ArchiveManifestSchema,
  buildDifferentialArchive,
  copyArchive,
  type DifferentialReport,
  differentialReport,
  manifestOf,
} from "../test-support/differential.js";
import { type EngineHarness, openEngine } from "../test-support/engine-harness.js";
import type { JsonValue } from "./engine.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

const CONFORMANCE = path.join(REPO, "apps/oriel-rs/conformance/glazier-core");

const ARCHIVE = path.join(CONFORMANCE, "archive");

const MANIFEST = path.join(CONFORMANCE, "archive.json");

const REPORT = path.join(CONFORMANCE, "differential.json");

const SHRINK_ARCHIVE = path.join(CONFORMANCE, "shrink-archive");

const SHRINK_MANIFEST = path.join(CONFORMANCE, "shrink-archive.json");

const CHANGES = path.join(CONFORMANCE, "changes.json");

const UPDATE = process.env.ORIEL_RS_UPDATE_VECTORS === "1";

const SOURCE = process.env.GLAZIER_DIFFERENTIAL_SOURCE;

const OUT = process.env.GLAZIER_DIFFERENTIAL_OUT;

function hasTool(name: string): boolean {
  try {
    execFileSync("which", [name], { stdio: "ignore" });

    return true;
  } catch {
    return false;
  }
}

/* Videos are probed, measured and fingerprinted through ffmpeg; without it the run says less. */
const HAS_TOOLS = hasTool("ffmpeg") && hasTool("ffprobe");

async function writeJson(file: string, value: JsonValue): Promise<void> {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
  execFileSync("pnpm", ["exec", "biome", "format", "--write", file], {
    cwd: REPO,
    stdio: "inherit",
  });
}

async function prepareArchive(target: string): Promise<void> {
  if (SOURCE !== undefined) {
    await cp(SOURCE, target, { recursive: true, preserveTimestamps: true });

    return;
  }

  if (UPDATE) {
    await rm(ARCHIVE, { force: true, recursive: true });
    await mkdir(ARCHIVE, { recursive: true });
    await buildDifferentialArchive(ARCHIVE);
    await writeJson(
      MANIFEST,
      await manifestOf(
        ARCHIVE,
        "Made by packages/glazier-core/src/engine/differential.test.ts with ORIEL_RS_UPDATE_VECTORS=1; do not edit. The archive both engines scan a copy of, with the dates a copy carries and the folders Git cannot hold.",
      ),
    );
  }

  const manifest = ArchiveManifestSchema.parse(JSON.parse(await readFile(MANIFEST, "utf8")));
  await copyArchive({ source: ARCHIVE, manifest, target });
}

/** What glazier-core made of the archive with Spot variants off, then on. */
interface DifferentialRun {
  off: DifferentialReport;
  on: DifferentialReport;
}

describe.skipIf(!HAS_TOOLS)("the differential run against Oriel RS", () => {
  let scratch: string;
  let harness: EngineHarness;
  let report: DifferentialRun;

  beforeAll(async () => {
    scratch = await mkdtemp(path.join(os.tmpdir(), "glazier-differential-"));
    const archive = path.join(scratch, "archive");
    const dataDir = path.join(scratch, "data");
    await mkdir(archive);
    await prepareArchive(archive);

    const started = performance.now();
    harness = await openEngine(dataDir);
    const root = await harness.call("addRoot", { path: archive });
    await harness.idle();
    const off = await differentialReport({ harness, root, dataDir });

    const { settings } = await harness.call("getState", {});
    await harness.call("updateSettings", { ...settings, spotVariants: true });
    await harness.idle();
    const on = await differentialReport({ harness, root, dataDir });

    report = { off, on };

    // A folder compared on demand also says how long the scans, analyses and reports took.
    if (OUT !== undefined) {
      await writeFile(
        `${OUT}.timing.json`,
        `${JSON.stringify({ milliseconds: Math.round(performance.now() - started) })}\n`,
      );
    }
  }, 3_600_000);

  afterAll(async () => {
    await harness?.idle();
    harness?.engine.close();
    await rm(scratch, { force: true, recursive: true });
  });

  it("makes the committed report of the archive", async () => {
    const made = z.json().parse(JSON.parse(JSON.stringify(report)));

    if (OUT !== undefined) {
      await writeFile(OUT, `${JSON.stringify(made, null, 2)}\n`);

      return;
    }

    if (UPDATE) {
      await writeJson(REPORT, {
        about:
          "Made by packages/glazier-core/src/engine/differential.test.ts; do not edit. What glazier-core's engine makes of archive/, Spot variants off and on; Oriel RS's must be the same.",
        ...z.object({ off: z.json(), on: z.json() }).parse(made),
      });
    }

    const { about: _about, ...committed } = z
      .object({ about: z.string(), off: z.json(), on: z.json() })
      .parse(JSON.parse(await readFile(REPORT, "utf8")));

    expect(made).toEqual(committed);
  });
});

/** Copies the shrink archive, building it first when the vectors are being rewritten. */
async function prepareShrinkArchive(target: string): Promise<void> {
  if (UPDATE) {
    await rm(SHRINK_ARCHIVE, { force: true, recursive: true });
    await mkdir(SHRINK_ARCHIVE, { recursive: true });
    await buildShrinkArchive(SHRINK_ARCHIVE);
    await writeJson(
      SHRINK_MANIFEST,
      await manifestOf(
        SHRINK_ARCHIVE,
        "Made by packages/glazier-core/src/engine/differential.test.ts with ORIEL_RS_UPDATE_VECTORS=1; do not edit. The clips Shrink's scenario changes, with the dates a copy carries.",
      ),
    );
  }

  const manifest = ArchiveManifestSchema.parse(JSON.parse(await readFile(SHRINK_MANIFEST, "utf8")));
  await copyArchive({ source: SHRINK_ARCHIVE, manifest, target });
}

describe.skipIf(!HAS_TOOLS || SOURCE !== undefined)(
  "the changes Oriel RS must make the same",
  () => {
    const made: Record<string, JsonValue> = {};

    beforeAll(async () => {
      const ffprobePath = execFileSync("which", ["ffprobe"], { encoding: "utf8" }).trim();

      for (const [name, scenario] of Object.entries(SCENARIOS)) {
        const scratch = await mkdtemp(path.join(os.tmpdir(), `glazier-changes-${name}-`));

        try {
          const archive = path.join(scratch, "archive");
          const dataDir = path.join(scratch, "data");
          await mkdir(archive);

          if (scenario.archive === "archive") {
            const manifest = ArchiveManifestSchema.parse(
              JSON.parse(await readFile(MANIFEST, "utf8")),
            );

            await copyArchive({ source: ARCHIVE, manifest, target: archive });
          } else {
            await prepareShrinkArchive(archive);
          }

          const harness = await openEngine(dataDir);

          try {
            const root = await harness.call("addRoot", { path: archive });
            await harness.idle();
            const runner = new ScenarioRunner(harness, root, dataDir, ffprobePath);
            await scenario.run(runner);
            made[name] = z.json().parse({ archive: scenario.archive, decisions: runner.decisions });
          } finally {
            await harness.idle();
            harness.engine.close();
          }
        } finally {
          await rm(scratch, { force: true, recursive: true });
        }
      }
    }, 3_600_000);

    it("makes the committed changes", async () => {
      const report = z.json().parse(JSON.parse(JSON.stringify(made)));

      if (UPDATE) {
        await writeJson(CHANGES, {
          about:
            "Made by packages/glazier-core/src/engine/differential.test.ts; do not edit. e2e's Tidy cases as decisions, each on a fresh copy of archive/ (or shrink-archive/), with what each decision left; Oriel RS replays the decisions and must leave the same.",
          scenarios: report,
        });
      }

      const { about: _about, scenarios } = z
        .object({ about: z.string(), scenarios: z.json() })
        .parse(JSON.parse(await readFile(CHANGES, "utf8")));

      expect(report).toEqual(scenarios);
    });
  },
);
