import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { env } from "../../env/server";
import * as schema from "./schema";

function createUncachedPaneViewDb(databaseUrl: string) {
  const client = postgres(databaseUrl, {
    max: 5,
    prepare: false,
  });

  return drizzle(client, { schema });
}

export type PaneViewDb = ReturnType<typeof createUncachedPaneViewDb>;

const globalForPaneViewDb = globalThis as typeof globalThis & {
  __latchWorksPaneViewDbs?: Map<string, PaneViewDb>;
};

export function createPaneViewDb(databaseUrl: string) {
  globalForPaneViewDb.__latchWorksPaneViewDbs ??= new Map();

  const cached = globalForPaneViewDb.__latchWorksPaneViewDbs.get(databaseUrl);
  if (cached) {
    return cached;
  }

  const db = createUncachedPaneViewDb(databaseUrl);
  globalForPaneViewDb.__latchWorksPaneViewDbs.set(databaseUrl, db);
  return db;
}

export function getPaneViewDb() {
  return createPaneViewDb(env.DATABASE_URL);
}
