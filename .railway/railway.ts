/** biome-ignore-all lint/suspicious/noTemplateCurlyInString: This is necessary for railway to automatically inject env vars */
import {
  bucket,
  defineRailway,
  github,
  group,
  postgres,
  preserve,
  project,
  service,
} from "railway/iac";

const europeWest4 = "europe-west4-drams3a";

const paneViewPrivateUrl = "http://${{Pane-View.RAILWAY_PRIVATE_DOMAIN}}:${{Pane-View.PORT}}";
const mediaOptimizerPrivateUrl =
  "http://${{Media-Optimizer.RAILWAY_PRIVATE_DOMAIN}}:${{Media-Optimizer.PORT}}";

const workspaceConfigWatchPatterns = ["/package.json", "/pnpm-lock.yaml", "/pnpm-workspace.yaml"];

const mediaPackageWatchPatterns = [
  "/packages/media-delivery/**",
  "/packages/media-derivatives/**",
  "/packages/media-domain/**",
  "/packages/media-storage/**",
];

export default defineRailway(() => {
  const latchWorks = github("Traydr/latch-works");

  const mediaBucket = bucket("balanced-wrap", { region: "ams" });

  const postgresDb = {
    ...postgres("Postgres", { region: europeWest4 }),
    deploy: {
      multiRegionConfig: { [europeWest4]: { numReplicas: 1 } },
      requiredMountPath: "/var/lib/postgresql/data",
    },
  };

  const s3Env = {
    S3_ACCESS_KEY_ID: "${{balanced-wrap.ACCESS_KEY_ID}}",
    S3_BUCKET: "${{balanced-wrap.BUCKET}}",
    S3_ENDPOINT: "${{balanced-wrap.ENDPOINT}}",
    S3_REGION: "${{balanced-wrap.REGION}}",
    S3_SECRET_ACCESS_KEY: "${{balanced-wrap.SECRET_ACCESS_KEY}}",
  };

  const MediaOptimizer = service("Media-Optimizer", {
    source: latchWorks,
    build: {
      buildCommand: "pnpm --filter @latch-works/media-optimizer... build",
      buildEnvironment: "V3",
      builder: "RAILPACK",
      watchPatterns: [
        "/apps/media-optimizer/**",
        ...mediaPackageWatchPatterns,
        ...workspaceConfigWatchPatterns,
      ],
    },
    start: "cd ./apps/media-optimizer && pnpm start",
    replicas: {
      [europeWest4]: 1,
    },
    deploy: {
      limitOverride: { containers: { cpu: 2, memoryBytes: 6000000000 } },
      sleepApplication: true,
    },
    networking: { privateNetworkEndpoint: "latch-works-media-optimizer" },
    env: {
      MEDIA_OPTIMIZER_TOKEN: preserve(),
      NODE_ENV: "production",
      OPTIMIZER_BATCH_LIMIT: "250",
      OPTIMIZER_CLAIM_CHUNK: "5",
      OPTIMIZER_MAX_RUNTIME_MS: "300000",
      PANE_VIEW_INTERNAL_URL: paneViewPrivateUrl,
      ...s3Env,
    },
  });

  const PaneView = service("Pane-View", {
    source: latchWorks,
    build: {
      buildCommand: "pnpm --filter @latch-works/pane-view... build",
      buildEnvironment: "V3",
      builder: "RAILPACK",
      watchPatterns: [
        "/apps/pane-view/**",
        ...mediaPackageWatchPatterns,
        ...workspaceConfigWatchPatterns,
      ],
    },
    start: "cd ./apps/pane-view && pnpm start",
    replicas: {
      [europeWest4]: 1,
    },
    deploy: {
      limitOverride: { containers: { cpu: 2, memoryBytes: 6000000000 } },
      preDeployCommand: ["cd ./apps/pane-view && pnpm db:migrate"],
      sleepApplication: true,
    },
    domains: ["pane-view.traydr.dev"],
    networking: { privateNetworkEndpoint: "latch-works" },
    env: {
      BETTER_AUTH_SECRET: preserve(),
      BETTER_AUTH_URL: "https://pane-view.traydr.dev",
      DATABASE_URL: "${{Postgres.DATABASE_URL}}",
      DERIVATIVE_PROCESSING_MODE: "triggered",
      MEDIA_DELIVERY_SECRET: preserve(),
      MEDIA_DELIVERY_TTL_SECONDS: "86400",
      MEDIA_OPTIMIZER_TOKEN: MediaOptimizer.env.MEDIA_OPTIMIZER_TOKEN,
      MEDIA_OPTIMIZER_URL: mediaOptimizerPrivateUrl,
      NODE_ENV: "production",
      PANE_VIEW_PASSWORD: preserve(),
      PANE_VIEW_SYNC_TOKEN: preserve(),
      PANE_VIEW_USERNAME: preserve(),
      ...s3Env,
    },
  });

  const Showcase = service("Showcase", {
    source: latchWorks,
    build: {
      buildCommand: "pnpm --filter @latch-works/showcase build",
      buildEnvironment: "V3",
      builder: "RAILPACK",
      watchPatterns: ["/apps/showcase/**", ...workspaceConfigWatchPatterns],
    },
    start: "cd ./apps/showcase && pnpm start",
    replicas: {
      [europeWest4]: 1,
    },
    deploy: {
      limitOverride: { containers: { cpu: 2, memoryBytes: 4000000000 } },
      sleepApplication: true,
    },
    domains: ["latch-works.traydr.dev"],
    networking: { privateNetworkEndpoint: "latch-works-1797" },
  });

  const PostgreSQL = group("PostgreSQL", [postgresDb]);
  const Storage = group("Storage", [mediaBucket]);

  return project("latch-works", {
    resources: [MediaOptimizer, PaneView, Showcase, Storage, PostgreSQL],
  });
});
