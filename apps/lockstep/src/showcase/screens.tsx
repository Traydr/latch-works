import { LayoutProvider } from "../renderer/layouts/LayoutContext";
import { LayoutRenderer } from "../renderer/layouts/LayoutRenderer";
import type { LayoutContentProps } from "../renderer/layouts/types";
import type { LockstepPlan, LockstepPlanItem, LockstepSettings } from "../shared/types";

export const showcaseSettings: LockstepSettings = {
  activeProfileId: "showcase-profile",
  profiles: [
    {
      apiUrl: "https://archive.example.com",
      id: "showcase-profile",
      name: "Main archive",
      sourceRoot: "/tmp/lockstep-demo-archive",
      tokenConfigured: true,
      tokenInSession: false,
      tokenUnreadable: false,
      lastRun: {
        action: "push",
        completedAt: new Date().toISOString(),
        failed: 0,
        pushed: 8,
        status: "completed",
      },
    },
  ],
};

export const showcasePlan: LockstepPlan = {
  counts: {
    delete: 2,
    keep: 1842,
    update: 5,
    upload: 12,
  },
  items: showcasePlanItems(),
  skipped: 3,
  skippedEntries: [{ path: "sfw/.DS_Store", reason: "not media" }],
  sourceRoot: "/tmp/lockstep-demo-archive",
  totalBytes: 1_842_000_000,
  totalFiles: 1866,
};

export function showcasePlanItems(): LockstepPlanItem[] {
  return [
    { action: "upload", path: "sfw/photos/sample-14.jpg" },
    { action: "upload", path: "sfw/photos/sample-15.jpg" },
    { action: "upload", path: "sfw/comics/chapter-01/001.webp" },
    { action: "update", path: "sfw/photos/sample-03.jpg" },
    { action: "update", path: "sfw/stories/author-long_title.pdf" },
    { action: "delete", path: "sfw/photos/retired/sample-old.jpg" },
    { action: "delete", path: "sfw/comics/dropped-series/page-04.webp" },
  ];
}

const pushLogs = [
  "Creating sync run...",
  "Pushing 8 upload/update change(s).",
  "[1/8] upload sfw/photos/sample-14.jpg",
  "[2/8] upload sfw/photos/sample-15.jpg",
  "[3/8] upload sfw/comics/chapter-01/001.webp",
  "[4/8] update sfw/photos/sample-03.jpg",
  "Hashing sfw/stories/author-long_title.pdf (847 files)",
];

const noop = () => undefined;

const showcaseLayoutProps: LayoutContentProps = {
  activeProfile: showcaseSettings.profiles[0] ?? null,
  doctorResult: null,
  error: null,
  filter: "",
  filteredItems: showcasePlanItems(),
  handlers: {
    onBack: noop,
    onCancel: noop,
    onCreateProfile: noop,
    onDoctor: noop,
    onFilterChange: noop,
    onPlan: noop,
    onPrune: noop,
    onProfileChange: noop,
    onPush: noop,
    onSessionTokenChange: noop,
    onViewActivity: noop,
    onViewPlan: noop,
  },
  logs: pushLogs,
  plan: showcasePlan,
  profileForm: {
    apiUrl: "https://archive.example.com",
    name: "",
    sourceRoot: "",
    token: "",
  },
  runLabel: "[4/8] update sfw/photos/sample-03.jpg",
  runProgress: {
    stage: "transfer",
    current: 4,
    total: 8,
    currentPath: "sfw/photos/sample-03.jpg",
    currentAction: "update",
    filesFound: 847,
    skipped: 3,
    bytesHashed: 0,
    fileSize: 0,
    phaseLabel: "Transferring 4 of 8",
  },
  running: true,
  screen: "run",
  sessionToken: "",
  settings: showcaseSettings,
  onCancelProfile: noop,
  onPickFolder: noop,
  onProfileFormChange: noop,
  onSubmitProfile: noop,
};

export function ShowcaseLayoutDemo() {
  return (
    <LayoutProvider>
      <LayoutRenderer {...showcaseLayoutProps} />
    </LayoutProvider>
  );
}

export function ShowcasePlanScreen() {
  return (
    <LayoutProvider>
      <LayoutRenderer
        {...showcaseLayoutProps}
        running={false}
        screen="plan"
        runProgress={{
          ...showcaseLayoutProps.runProgress,
          stage: "complete",
          phaseLabel: "Plan complete",
        }}
      />
    </LayoutProvider>
  );
}

export function ShowcasePushScreen() {
  return <ShowcaseLayoutDemo />;
}
