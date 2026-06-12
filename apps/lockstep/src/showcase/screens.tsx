import { ActionDock } from "../renderer/components/ActionDock";
import { AppHeader } from "../renderer/components/AppHeader";
import { AppShell } from "../renderer/components/AppShell";
import { PlanResultsView } from "../renderer/views/PlanResultsView";
import { RunProgressView } from "../renderer/views/RunProgressView";
import type { LockstepPlan, LockstepPlanItem, LockstepSettings } from "../shared/types";

export const showcaseSettings: LockstepSettings = {
  activeProfileId: "showcase-profile",
  profiles: [
    {
      apiUrl: "https://archive.example.com",
      id: "showcase-profile",
      name: "Main archive",
      sourceRoot: "/Volumes/Media/archive",
      tokenConfigured: true,
      tokenInSession: false,
      tokenUnreadable: false,
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
  sourceRoot: "/Volumes/Media/archive",
  totalBytes: 1_842_000_000,
  totalFiles: 1866,
};

function showcasePlanItems(): LockstepPlanItem[] {
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

const noop = () => undefined;

export function ShowcasePlanScreen() {
  return (
    <AppShell
      header={<AppHeader onAddProfile={noop} onProfileChange={noop} settings={showcaseSettings} />}
    >
      <PlanResultsView
        filter=""
        items={showcasePlanItems()}
        onBack={noop}
        onFilterChange={noop}
        plan={showcasePlan}
      />
      <ActionDock disabled onDoctor={noop} onPlan={noop} onPrune={noop} onPush={noop} />
    </AppShell>
  );
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

export function ShowcasePushScreen() {
  return (
    <AppShell
      header={<AppHeader onAddProfile={noop} onProfileChange={noop} settings={showcaseSettings} />}
    >
      <RunProgressView
        doctorResult={null}
        logs={pushLogs}
        onBack={noop}
        onCancel={noop}
        running
        runLabel="[4/8] update sfw/photos/sample-03.jpg"
      />
      <ActionDock disabled onDoctor={noop} onPlan={noop} onPrune={noop} onPush={noop} />
    </AppShell>
  );
}
