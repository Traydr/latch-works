/*
 * The sync API schemas written out as one JSON Schema document for Oriel, whose Rust client
 * (apps/oriel/crates/core-sync) builds its request and response types from it with typify. After
 * a deliberate change, rewrite it and rebuild the Rust:
 *
 *   ORIEL_UPDATE_VECTORS=1 pnpm --filter @latch-works/sync-protocol test
 */
import { committedVectors } from "@latch-works/conformance";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  CompleteObjectRequestSchema,
  CompleteSyncRunRequestSchema,
  CreateSyncRunRequestSchema,
  DeleteObjectRequestSchema,
  RemoteEntrySchema,
  RemoteSnapshotResponseSchema,
  SyncPlanCountsSchema,
  SyncRunOutcomeCountsSchema,
  SyncRunSchema,
  UploadTargetSchema,
  UploadUrlRequestSchema,
} from "./schemas.js";

/** Every schema a client sends or reads, under the name its Rust type takes. */
const API_SCHEMAS = {
  CompleteObjectRequest: CompleteObjectRequestSchema,
  CompleteSyncRunRequest: CompleteSyncRunRequestSchema,
  CreateSyncRunRequest: CreateSyncRunRequestSchema,
  DeleteObjectRequest: DeleteObjectRequestSchema,
  LockstepPlanCounts: SyncPlanCountsSchema,
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
 * schemas' input side is what a client may send and what it accepts back, so objects allow fields
 * it does not read: Pane View answers with more than a client needs.
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
      "Pane View's sync API as @latch-works/sync-protocol's zod schemas describe it. Written by " +
      "packages/sync-protocol/src/api-schema.test.ts; do not edit by hand.",
    definitions,
  };
}

describe("sync API schema for Oriel", () => {
  it("matches the committed api-schema.json", () => {
    const document = apiSchemaDocument();

    expect(
      committedVectors(
        { set: "lockstep-core", name: "api-schema.json" },
        ApiSchemaDocumentSchema,
        document,
        { indented: true },
      ),
    ).toEqual(document);
  });
});
