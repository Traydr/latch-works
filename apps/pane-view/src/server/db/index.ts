import type { ExtractTablesWithRelations } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

import { env } from "@/env/server";
import * as schema from "./schema";

/**
 * The database surface server modules depend on: the drizzle query builder over
 * this app's schema, independent of the driver underneath. The production
 * `db` (node-postgres) and the pglite handle from `library/test-db.ts` both
 * satisfy it, so modules take a `Database` seam and tests pass a real pglite
 * database or a typed fake.
 */
export type Database = PgDatabase<
  PgQueryResultHKT,
  typeof schema,
  ExtractTablesWithRelations<typeof schema>
>;

export const db = drizzle(env.DATABASE_URL, { schema });
