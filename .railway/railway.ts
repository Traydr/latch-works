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

const workspaceConfigWatchPatterns = ["/package.json", "/pnpm-lock.yaml", "/pnpm-workspace.yaml"];

const mediaPackageWatchPatterns = ["/packages/media-domain/**", "/packages/media-storage/**"];

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
      NODE_ENV: "production",
      PANE_VIEW_PASSWORD: preserve(),
      PANE_VIEW_SYNC_TOKEN: preserve(),
      PANE_VIEW_USERNAME: preserve(),
      SHUTTER_CAPABILITY_KEYS: preserve(),
      SHUTTER_CAPABILITY_KID: preserve(),
      SHUTTER_CONTROL_URL: "https://shutter-control.traydr.dev",
      SHUTTER_EDGE_URL: "https://shutter-edge.traydr.dev",
      SHUTTER_SPACE_API_TOKEN: preserve(),
      SHUTTER_SPACE_ID: "pane-view",
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
    resources: [PaneView, Showcase, Storage, PostgreSQL],
  });
});
