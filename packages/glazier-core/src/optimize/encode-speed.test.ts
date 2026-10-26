import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CatalogDatabase } from "../catalog/database.js";
import { encodeSpeed, recordEncodeTiming } from "./encode-speed.js";

const P720 = 1280 * 720;

const P1080 = 1920 * 1080;

let folder: string;

let db: CatalogDatabase;

beforeEach(async () => {
  folder = await mkdtemp(path.join(os.tmpdir(), "glazier-speed-"));
  db = new CatalogDatabase(path.join(folder, "catalog.sqlite"));
});

afterEach(async () => {
  db.close();
  await rm(folder, { force: true, recursive: true });
});

/** A minute of video that took `minute / speed` to encode. */
function timed(pixels: number, speed: number, mediaMs = 60_000): void {
  recordEncodeTiming(db, { pixels, mediaMs, wallMs: mediaMs / speed });
}

describe("encode speed", () => {
  it("uses the M5 Pro's figures until this machine has timed its own", () => {
    timed(P1080, 1);
    timed(P1080, 1);

    expect(encodeSpeed(db)).toMatchObject({ measured: false });
    expect(encodeSpeed(db).at(P1080)).toBe(2.4);
  });

  it("takes the median of a size's encodes and scales the sizes it has not timed", () => {
    timed(P1080, 1.0);
    timed(P1080, 1.2);
    timed(P1080, 1.1);
    // A few seconds of clip mostly times ffmpeg starting, so it is left out.
    timed(P1080, 0.1, 4_000);

    const speed = encodeSpeed(db);

    expect(speed.measured).toBe(true);
    expect(speed.at(P1080)).toBeCloseTo(1.1);
    expect(speed.at(P720)).toBeCloseTo(3.5 * (1.1 / 2.4));
  });
});
