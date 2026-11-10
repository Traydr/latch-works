/*
 * The conformance vectors Oriel's Rust ports are tested against, kept in
 * apps/oriel/conformance/<set>/. A TypeScript suite makes each file from the code it pins and fails
 * when the committed file differs; `ORIEL_UPDATE_VECTORS=1` rewrites the files first. A file, or a
 * top-level key in one, that no TypeScript makes any more is frozen: Rust owns that rule, and an
 * update carries its committed value over unchanged (see apps/oriel/conformance/README.md).
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";
import type { z } from "zod";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));

const vectorRoot = join(repositoryRoot, "apps/oriel/conformance");

const updating = process.env.ORIEL_UPDATE_VECTORS === "1";

export interface VectorFileOptions {
  /** Top-level keys the TypeScript no longer makes; their committed values are kept. */
  frozen?: readonly string[];
  /** Written indented, so Biome keeps every object expanded instead of fitting it on one line. */
  indented?: boolean;
}

/** One committed vector file: `set` is its folder under apps/oriel/conformance. */
export interface VectorFile {
  name: string;
  set: string;
}

type Json = z.core.util.JSONType;

type JsonObject = Record<string, Json>;

function parseJsonObject(text: string): JsonObject {
  const value: Json = JSON.parse(text);

  if (value === null || Array.isArray(value) || !(value instanceof Object)) {
    throw new Error("A conformance vector file holds one JSON object.");
  }

  return value;
}

function pathOf(file: VectorFile): string {
  return join(vectorRoot, file.set, file.name);
}

function readCommitted(file: VectorFile): JsonObject {
  return parseJsonObject(readFileSync(pathOf(file), "utf8"));
}

/* Non-ASCII written as escapes, so the files survive any editor's normalization. */
function writeAscii(path: string, json: string): void {
  const ascii = json.replace(
    /[\u007f-\uffff]/g,
    (unit) => `\\u${unit.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${ascii}\n`);
  execFileSync(join(repositoryRoot, "node_modules/.bin/biome"), ["format", "--write", path], {
    cwd: repositoryRoot,
    stdio: "inherit",
  });
}

/* The generated keys in the committed file's order, with the frozen ones carried over. */
function merged(file: VectorFile, generated: JsonObject, frozen: readonly string[]): JsonObject {
  if (frozen.length === 0) {
    return generated;
  }

  const committed = readCommitted(file);

  const kept = Object.entries(committed).flatMap(([key, value]): [string, Json][] => {
    const fresh = generated[key];

    if (frozen.includes(key)) {
      return [[key, value]];
    }

    return fresh === undefined ? [] : [[key, fresh]];
  });

  const added = Object.entries(generated).filter(([key]) => !Object.hasOwn(committed, key));

  return Object.fromEntries([...kept, ...added]);
}

function write<T extends object>(file: VectorFile, generated: T, options: VectorFileOptions): void {
  const value = merged(file, parseJsonObject(JSON.stringify(generated)), options.frozen ?? []);

  writeAscii(pathOf(file), JSON.stringify(value, null, options.indented ? 2 : undefined));
}

function withoutFrozen(committed: JsonObject, frozen: readonly string[]): JsonObject {
  return Object.fromEntries(Object.entries(committed).filter(([key]) => !frozen.includes(key)));
}

/**
 * Rewrites the file when updating, then parses what is committed with `schema`. Frozen keys are
 * left out before parsing, so the schema describes only what the TypeScript makes.
 */
export function committedVectors<T extends object>(
  file: VectorFile,
  schema: z.ZodType<T>,
  generated: T,
  options: VectorFileOptions = {},
): T {
  if (updating) {
    write(file, generated, options);
  }

  return schema.parse(withoutFrozen(readCommitted(file), options.frozen ?? []));
}

/** Rewrites the file when updating, then expects it to hold what the TypeScript makes. */
export function expectCommitted<T extends object>(
  file: VectorFile,
  generated: T,
  options: VectorFileOptions = {},
): void {
  if (updating) {
    write(file, generated, options);
  }

  // The round trip drops what JSON cannot hold (undefined fields), as the committed file did.
  const expected = parseJsonObject(JSON.stringify(generated));

  expect(
    withoutFrozen(readCommitted(file), options.frozen ?? []),
    `${file.set}/${file.name} is stale: rerun with ORIEL_UPDATE_VECTORS=1 and port the change`,
  ).toEqual(expected);
}

/** Parses a committed file another suite writes, for a suite that only reads it. */
export function readVectors<T extends object>(file: VectorFile, schema: z.ZodType<T>): T {
  return schema.parse(readCommitted(file));
}
