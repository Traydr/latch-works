import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";
import {
  CreateBucketCommand,
  HeadBucketCommand,
  PutBucketCorsCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import postgres from "postgres";
import {
  E2E_BUCKET,
  E2E_DATABASE_NAME,
  type E2eEnvironment,
  loadE2eEnvironment,
  PANE_VIEW_URL,
  paneViewProcessEnv,
  REPO_ROOT,
} from "../src/env.ts";

/**
 * Playwright's webServer command for the Pane View project. Recreates the e2e
 * database from the checked-in migrations, ensures the e2e bucket exists,
 * builds Pane View (skip with E2E_SKIP_BUILD=1 when iterating on tests) and
 * serves the built output on the e2e port.
 */
const PANE_VIEW_DIR = path.join(REPO_ROOT, "apps", "pane-view");

function run(command: string, args: string[], env: NodeJS.ProcessEnv, cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(" ")} exited with ${code}`));
    });
  });
}

async function recreateDatabase(environment: E2eEnvironment): Promise<void> {
  const sql = postgres(environment.adminDatabaseUrl, { max: 1 });
  try {
    await sql.unsafe(`drop database if exists ${E2E_DATABASE_NAME} with (force)`);
    await sql.unsafe(`create database ${E2E_DATABASE_NAME}`);
  } finally {
    await sql.end();
  }
}

async function ensureBucket(environment: E2eEnvironment): Promise<void> {
  const client = new S3Client({
    credentials: {
      accessKeyId: environment.s3.accessKeyId,
      secretAccessKey: environment.s3.secretAccessKey,
    },
    endpoint: environment.s3.endpoint,
    forcePathStyle: true,
    region: environment.s3.region,
  });
  try {
    await client.send(new HeadBucketCommand({ Bucket: E2E_BUCKET }));
  } catch {
    await client.send(new CreateBucketCommand({ Bucket: E2E_BUCKET }));
  }
  // The PDF viewer fetches signed originals from the browser; like a production
  // bucket, the e2e bucket must allow the app origin.
  await client.send(
    new PutBucketCorsCommand({
      Bucket: E2E_BUCKET,
      CORSConfiguration: {
        CORSRules: [
          {
            AllowedHeaders: ["*"],
            AllowedMethods: ["GET", "HEAD"],
            AllowedOrigins: [PANE_VIEW_URL],
            ExposeHeaders: ["Accept-Ranges", "Content-Length", "Content-Range"],
          },
        ],
      },
    }),
  );
}

async function assertStackReachable(environment: E2eEnvironment): Promise<void> {
  try {
    await recreateDatabase(environment);
    await ensureBucket(environment);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `The local stack is not reachable (${reason}). Start it with \`docker compose up -d\` in docs/localhost.`,
    );
  }
}

async function main(): Promise<void> {
  const environment = await loadE2eEnvironment();
  const env = paneViewProcessEnv(environment);
  await assertStackReachable(environment);
  await run("pnpm", ["exec", "drizzle-kit", "migrate"], env, PANE_VIEW_DIR);

  const serverEntry = path.join(PANE_VIEW_DIR, ".output", "server", "index.mjs");
  const skipBuild = process.env.E2E_SKIP_BUILD === "1";
  if (skipBuild) {
    await access(serverEntry);
  } else {
    await run(
      "pnpm",
      ["exec", "vite", "build"],
      { ...env, SKIP_ENV_VALIDATION: "1" },
      PANE_VIEW_DIR,
    );
  }

  console.log(`pane-view e2e server: ${PANE_VIEW_URL} (database ${E2E_DATABASE_NAME})`);
  const server = spawn("node", [serverEntry], { cwd: PANE_VIEW_DIR, env, stdio: "inherit" });
  const stop = () => {
    server.kill("SIGTERM");
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  server.on("exit", (code) => process.exit(code ?? 0));
}

await main();
