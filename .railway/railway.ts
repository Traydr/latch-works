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

export default defineRailway(() => {
  const latchWorks = github("Traydr/latch-works");

  const MediaOptimizer = service("Media-Optimizer", {
    source: latchWorks,
    build: {
      buildCommand: "pnpm build",
      buildEnvironment: "V3",
      builder: "RAILPACK",
      watchPatterns: ["/apps/media-optimizer/**"],
    },
    start: "cd ./apps/media-optimizer && pnpm start",
    replicas: 1,
    deploy: {
      limitOverride: { containers: { cpu: 2, memoryBytes: 6000000000 } },
      sleepApplication: false,
    },
    networking: { privateNetworkEndpoint: "latch-works-media-optimizer" },
    env: {
      MEDIA_OPTIMIZER_TOKEN: preserve(),
      NODE_ENV: preserve(),
      OPTIMIZER_BATCH_LIMIT: "250",
      OPTIMIZER_CLAIM_CHUNK: "5",
      OPTIMIZER_MAX_RUNTIME_MS: "300000",
      PANE_VIEW_INTERNAL_URL: preserve(),
      S3_ACCESS_KEY_ID: preserve(),
      S3_BUCKET: preserve(),
      S3_ENDPOINT: preserve(),
      S3_REGION: preserve(),
      S3_SECRET_ACCESS_KEY: preserve(),
    },
  });
  const Postgres = {
    ...postgres("Postgres", { region: "europe-west4-drams3a" }),
    deploy: {
      multiRegionConfig: { "europe-west4-drams3a": { numReplicas: 1 } },
      requiredMountPath: "/var/lib/postgresql/data",
    },
  };
  const PaneView = service("Pane-View", {
    source: latchWorks,
    build: {
      buildCommand: "pnpm build",
      buildEnvironment: "V3",
      builder: "RAILPACK",
      watchPatterns: ["/apps/pane-view/**"],
    },
    start: "cd ./apps/pane-view && pnpm start",
    replicas: 1,
    deploy: {
      limitOverride: { containers: { cpu: 2, memoryBytes: 6000000000 } },
      preDeployCommand: ["cd ./apps/pane-view && pnpm db:migrate"],
      sleepApplication: false,
    },
    domains: ["pane-view.traydr.dev"],
    networking: { privateNetworkEndpoint: "latch-works" },
    env: {
      BETTER_AUTH_SECRET: preserve(),
      BETTER_AUTH_URL: preserve(),
      DATABASE_URL: preserve(),
      DERIVATIVE_PROCESSING_MODE: "triggered",
      MEDIA_DELIVERY_SECRET: preserve(),
      MEDIA_DELIVERY_TTL_SECONDS: preserve(),
      MEDIA_OPTIMIZER_TOKEN: preserve(),
      MEDIA_OPTIMIZER_URL: preserve(),
      NODE_ENV: preserve(),
      PANE_VIEW_PASSWORD: preserve(),
      PANE_VIEW_SYNC_TOKEN: preserve(),
      PANE_VIEW_USERNAME: preserve(),
      S3_ACCESS_KEY_ID: preserve(),
      S3_BUCKET: preserve(),
      S3_ENDPOINT: preserve(),
      S3_REGION: preserve(),
      S3_SECRET_ACCESS_KEY: preserve(),
    },
  });
  const Showcase = service("Showcase", {
    source: latchWorks,
    build: {
      buildCommand: "pnpm build",
      buildEnvironment: "V3",
      builder: "RAILPACK",
      watchPatterns: ["/apps/showcase/**"],
    },
    start: "cd ./apps/showcase && pnpm start",
    replicas: 1,
    deploy: {
      limitOverride: { containers: { cpu: 2, memoryBytes: 4000000000 } },
      sleepApplication: true,
    },
    domains: ["latch-works.traydr.dev"],
    networking: { privateNetworkEndpoint: "latch-works-1797" },
  });
  const balancedWrap = bucket("balanced-wrap", { region: "ams" });
  const PostgreSQL = group("PostgreSQL", [Postgres]);

  return project("latch-works", {
    resources: [MediaOptimizer, PaneView, Showcase, balancedWrap, PostgreSQL],
  });
});
