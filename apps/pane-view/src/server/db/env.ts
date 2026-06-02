const DATABASE_URL_KEYS = ["DATABASE_URL", "DATABASE_PRIVATE_URL", "DATABASE_PUBLIC_URL"] as const;
const RAILWAY_DATABASE_REFERENCE = "$" + "{{Postgres.DATABASE_URL}}";

export function readDatabaseUrl(env: NodeJS.ProcessEnv): string | null {
  for (const key of DATABASE_URL_KEYS) {
    const value = env[key];
    if (value) {
      return value;
    }
  }

  return readPgConnectionUrl(env);
}

export function requireDatabaseUrl(env: NodeJS.ProcessEnv, context: string): string {
  const databaseUrl = readDatabaseUrl(env);
  if (databaseUrl) {
    return databaseUrl;
  }

  throw new Error(
    `${context} requires DATABASE_URL. On Railway, add DATABASE_URL=${RAILWAY_DATABASE_REFERENCE} to the Pane View service variables.`,
  );
}

function readPgConnectionUrl(env: NodeJS.ProcessEnv): string | null {
  const host = env.PGHOST;
  const database = env.PGDATABASE;
  const user = env.PGUSER;
  const password = env.PGPASSWORD;

  if (!host || !database || !user || !password) {
    return null;
  }

  const port = env.PGPORT ?? "5432";
  return `postgres://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}/${encodeURIComponent(database)}`;
}
