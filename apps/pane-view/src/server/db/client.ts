import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

export type PaneViewDb = ReturnType<typeof createPaneViewDb>;

export function createPaneViewDb(databaseUrl: string) {
  const client = postgres(databaseUrl, {
    max: 5,
    prepare: false,
  });

  return drizzle(client, { schema });
}

export function readDatabaseUrl(env: NodeJS.ProcessEnv): string | null {
  return env.DATABASE_URL ?? null;
}
