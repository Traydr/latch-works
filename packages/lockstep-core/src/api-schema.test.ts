/*
 * Pane View's sync API as this package's zod schemas describe it, written out as JSON Schema for
 * Oriel. Its Rust client (apps/oriel/crates/core-sync) builds its request and response types
 * from apps/oriel/conformance/lockstep-core/api-schema.json with typify, so the two clients
 * cannot drift apart (plan 063, "Keeping two implementations honest"). This suite fails when the
 * committed file no longer matches the schemas; after a deliberate change, rewrite it and rebuild
 * the Rust:
 *
 *   ORIEL_UPDATE_VECTORS=1 pnpm --filter @latch-works/lockstep-core test
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  CompleteObjectRequestSchema,
  CompleteSyncRunRequestSchema,
  CreateSyncRunRequestSchema,
  DeleteObjectRequestSchema,
  LockstepPlanCountsSchema,
  SyncRunOutcomeCountsSchema,
  SyncRunSchema,
  UploadTargetSchema,
  UploadUrlRequestSchema,
} from "./remote-api.js";
import { RemoteEntrySchema, RemoteSnapshotResponseSchema } from "./remote-snapshot.js";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));

const schemaFile = fileURLToPath(
  new URL("../../../apps/oriel/conformance/lockstep-core/api-schema.json", import.meta.url),
);

const updating = process.env.ORIEL_UPDATE_VECTORS === "1";

/** Every schema the client sends or reads, under the name its Rust type takes. */
const API_SCHEMAS = {
  CompleteObjectRequest: CompleteObjectRequestSchema,
  CompleteSyncRunRequest: CompleteSyncRunRequestSchema,
  CreateSyncRunRequest: CreateSyncRunRequestSchema,
  DeleteObjectRequest: DeleteObjectRequestSchema,
  LockstepPlanCounts: LockstepPlanCountsSchema,
  RemoteEntry: RemoteEntrySchema,
  RemoteSnapshotResponse: RemoteSnapshotResponseSchema,
  SyncRun: SyncRunSchema,
  SyncRunOutcomeCounts: SyncRunOutcomeCountsSchema,
  UploadTarget: UploadTargetSchema,
  UploadUrlRequest: UploadUrlRequestSchema,
} satisfies Record<string, z.ZodType>;

/** One generated definition: its draft and id, which the document drops, and the schema itself. */
const GeneratedDefinitionSchema = z.looseObject({
  $id: z.string().optional(),
  $schema: z.string().optional(),
});

const GeneratedSchema = z.object({ schemas: z.record(z.string(), GeneratedDefinitionSchema) });

const ApiSchemaDocumentSchema = z.object({
  $schema: z.literal("http://json-schema.org/draft-07/schema#"),
  title: z.string(),
  description: z.string(),
  definitions: z.record(z.string(), GeneratedDefinitionSchema),
});

type ApiSchemaDocument = z.infer<typeof ApiSchemaDocumentSchema>;

/**
 * One draft-07 document with each schema under `definitions`, shared ones by reference. The
 * schemas' input side is what this client may send and what it accepts back, so objects allow
 * fields it does not read: Pane View answers with more than the client needs.
 */
function apiSchemaDocument(): ApiSchemaDocument {
  const registry = z.registry<{ id: string }>();

  for (const [id, schema] of Object.entries(API_SCHEMAS)) {
    registry.add(schema, { id });
  }

  const generated = GeneratedSchema.parse(
    z.toJSONSchema(registry, {
      io: "input",
      target: "draft-7",
      uri: (id) => `#/definitions/${id}`,
    }),
  );

  const definitions = Object.fromEntries(
    Object.entries(generated.schemas)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([id, { $id: _id, $schema: _schema, ...definition }]) => [id, definition]),
  );

  return {
    $schema: "http://json-schema.org/draft-07/schema#",
    title: "PaneViewSyncApi",
    description:
      "Pane View's sync API as @latch-works/lockstep-core's zod schemas describe it. Written by " +
      "packages/lockstep-core/src/api-schema.test.ts; do not edit by hand.",
    definitions,
  };
}

describe("Pane View sync API schema for Oriel", () => {
  it("matches the committed api-schema.json", () => {
    const document = apiSchemaDocument();

    if (updating) {
      mkdirSync(dirname(schemaFile), { recursive: true });
      writeFileSync(schemaFile, `${JSON.stringify(document, null, 2)}\n`);
      execFileSync("pnpm", ["exec", "biome", "format", "--write", schemaFile], {
        cwd: repositoryRoot,
        stdio: "inherit",
      });
    }

    const committed = ApiSchemaDocumentSchema.parse(JSON.parse(readFileSync(schemaFile, "utf8")));

    expect(
      committed,
      "api-schema.json is stale: rerun with ORIEL_UPDATE_VECTORS=1 and rebuild Oriel",
    ).toEqual(document);
  });
});
