import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { icuDataDir } from "@electric-sql/pglite-icu-full";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import { z } from "zod";
import * as schema from "../db/schema";

/**
 * Test-only. An in-process PostgreSQL (pglite) with the checked-in migrations
 * applied, so repository tests execute the real SQL instead of pinning
 * strings. Loads pg_trgm (migration 0008) and the full ICU data set so the
 * `natural` collation (migration 0018) behaves as it does on a Postgres server
 * built with ICU. Inject the returned `db` with `vi.mock("../db", ...)`.
 *
 * Migrations are applied by reading `drizzle/meta/_journal.json` and running
 * each file as one script through the simple query protocol. Drizzle's pglite
 * migrator sends each file as a prepared statement, which rejects the
 * hand-written multi-statement migrations (0004 onwards) that carry no
 * `--> statement-breakpoint` markers.
 */
export type TestDatabase = PgliteDatabase<typeof schema>;

export interface TestDatabaseHandle {
  client: PGlite;
  close(): Promise<void>;
  db: TestDatabase;
}

/** The hoisted slot a suite's `../db` mock fills, so tests can reach the client and close it. */
export interface TestDatabaseHarness {
  handle: TestDatabaseHandle | null;
}

const migrationsFolder = fileURLToPath(new URL("../../../drizzle", import.meta.url));

const MigrationJournalSchema = z.object({
  entries: z.array(z.object({ tag: z.string() })),
});

async function applyCheckedInMigrations(client: PGlite): Promise<void> {
  const journal = MigrationJournalSchema.parse(
    JSON.parse(await readFile(join(migrationsFolder, "meta", "_journal.json"), "utf8")),
  );

  for (const entry of journal.entries) {
    const script = await readFile(join(migrationsFolder, `${entry.tag}.sql`), "utf8");
    try {
      await client.exec(script);
    } catch (error) {
      throw new Error(`Migration ${entry.tag} failed under pglite: ${String(error)}`, {
        cause: error,
      });
    }
  }
}

export async function createTestDatabase(): Promise<TestDatabaseHandle> {
  const client = await PGlite.create({
    extensions: { pg_trgm },
    icuDataDir: await icuDataDir(),
  });
  await applyCheckedInMigrations(client);
  const db = drizzle(client, { schema });
  return { client, close: () => client.close(), db };
}
