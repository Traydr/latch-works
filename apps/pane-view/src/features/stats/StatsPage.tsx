import { formatBytes } from "@latch-works/media-domain";
import { Link } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import type { ReactNode } from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  type ChartConfig,
  type DitherColor,
  Grid,
  Legend,
  Pie,
  PieChart,
  Sparkline,
  Tooltip,
  XAxis,
  YAxis,
} from "@/components/dither-kit";
import { useArchiveStatsQuery } from "./stats-queries";

const MEDIA_TYPE_COLORS: Record<string, DitherColor> = {
  gif: "pink",
  image: "blue",
  pdf: "orange",
  unknown: "grey",
  video: "purple",
};

function formatDuration(ms: number): string {
  if (ms <= 0) {
    return "0s";
  }
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours.toLocaleString()}h ${minutes}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}

function formatRate(bytesPerDay: number): string {
  return `${formatBytes(bytesPerDay)}/day`;
}

function StatCard({
  label,
  value,
  hint,
  spark,
}: {
  hint?: string;
  label: string;
  spark?: number[];
  value: string;
}) {
  return (
    <div className="rounded-xl border border-border p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs text-muted-foreground">{label}</p>
          <p className="mt-1 text-lg font-semibold tabular-nums">{value}</p>
          {hint ? <p className="mt-1 text-xs text-muted-foreground">{hint}</p> : null}
        </div>
        {spark && spark.length > 1 ? (
          <div className="h-12 w-24 shrink-0">
            <Sparkline animate bloom="aura" color="blue" data={spark} />
          </div>
        ) : null}
      </div>
    </div>
  );
}

function ChartPanel({
  title,
  description,
  children,
}: {
  children: ReactNode;
  description: string;
  title: string;
}) {
  return (
    <section className="space-y-3 rounded-xl border border-border p-4">
      <div>
        <h2 className="text-sm font-semibold">{title}</h2>
        <p className="text-sm text-muted-foreground">{description}</p>
      </div>
      <div className="h-64 w-full min-w-0">{children}</div>
    </section>
  );
}

export function StatsPage() {
  const statsQuery = useArchiveStatsQuery();
  const stats = statsQuery.data;

  const sizeSpark = stats?.sizeOverTime.map((point) => point.value) ?? [];
  const entrySpark = stats?.entriesOverTime.map((point) => point.value) ?? [];
  const growthSpark = stats?.recentGrowth.map((point) => point.bytesAdded) ?? [];

  const sizeConfig = {
    value: { color: "blue" as const, label: "Archive size" },
  } satisfies ChartConfig;

  const entryConfig = {
    value: { color: "green" as const, label: "Entries" },
  } satisfies ChartConfig;

  const growthConfig = {
    bytesAdded: { color: "orange" as const, label: "Bytes added" },
  } satisfies ChartConfig;

  const syncConfig = {
    started: { color: "blue" as const, label: "Sync runs" },
  } satisfies ChartConfig;

  const mediaTypePieData =
    stats?.byMediaType.map((row) => ({
      bytes: row.bytes,
      mediaType: row.mediaType,
    })) ?? [];

  const mediaTypeConfig = Object.fromEntries(
    mediaTypePieData.map((row) => [
      row.mediaType,
      {
        color: MEDIA_TYPE_COLORS[row.mediaType] ?? ("grey" as DitherColor),
        label: row.mediaType,
      },
    ]),
  ) satisfies ChartConfig;

  const extensionBarData =
    stats?.topExtensions.map((row) => ({
      bytes: row.bytes,
      extension: row.extension,
    })) ?? [];

  const extensionConfig = {
    bytes: { color: "purple" as const, label: "Bytes" },
  } satisfies ChartConfig;

  return (
    <main className="min-h-screen bg-background text-foreground">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-5 py-8">
        <header>
          <Link
            className="mb-2 inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground"
            to="/"
          >
            <ArrowLeft className="size-4" />
            Back to gallery
          </Link>
          <h1 className="text-2xl font-semibold">Archive stats</h1>
          <p className="text-sm text-muted-foreground">
            Fun numbers about how big the archive is, how fast it grows, and what fills it.
          </p>
        </header>

        {statsQuery.isLoading ? (
          <p className="text-sm text-muted-foreground">Crunching archive numbers…</p>
        ) : null}

        {statsQuery.error ? (
          <p className="text-sm text-destructive">
            {statsQuery.error instanceof Error
              ? statsQuery.error.message
              : "Unable to load archive stats."}
          </p>
        ) : null}

        {stats ? (
          <>
            <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <StatCard
                hint={
                  stats.totals.archiveAgeDays
                    ? `${stats.totals.archiveAgeDays.toLocaleString()} day archive span`
                    : undefined
                }
                label="Archive size"
                spark={sizeSpark}
                value={formatBytes(stats.totals.mediaObjectBytes)}
              />
              <StatCard
                hint={`${stats.totals.mediaObjectCount.toLocaleString()} unique objects`}
                label="Active entries"
                spark={entrySpark}
                value={stats.totals.activeEntries.toLocaleString()}
              />
              <StatCard
                hint={`${stats.growth.entriesPerDay.toFixed(1)} entries/day`}
                label="Growth rate"
                spark={growthSpark}
                value={formatRate(stats.growth.bytesPerDay)}
              />
              <StatCard
                hint={`Last 30 days: ${formatBytes(stats.growth.bytesLast30Days)}`}
                label="90-day projection"
                value={formatBytes(stats.growth.projectedBytesIn90Days)}
              />
            </section>

            <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <StatCard
                label="Average object"
                value={formatBytes(stats.totals.averageObjectBytes)}
              />
              <StatCard label="Folders" value={stats.totals.activeFolders.toLocaleString()} />
              <StatCard label="Collections" value={stats.totals.collections.toLocaleString()} />
              <StatCard
                hint={
                  stats.totals.softDeletedEntries > 0
                    ? `${stats.totals.softDeletedEntries.toLocaleString()} soft-deleted`
                    : "No soft-deleted entries"
                }
                label="Dedupe savings"
                value={formatBytes(stats.funFacts.dedupeSavedBytes)}
              />
            </section>

            <div className="grid gap-4 lg:grid-cols-2">
              <ChartPanel
                description="Cumulative original storage from object created dates (last 90 days)."
                title="Size over time"
              >
                {stats.sizeOverTime.length > 1 ? (
                  <AreaChart bloom="aura" config={sizeConfig} data={stats.sizeOverTime}>
                    <Grid />
                    <XAxis dataKey="label" />
                    <YAxis />
                    <Tooltip labelKey="label" />
                    <Area dataKey="value" variant="gradient" />
                  </AreaChart>
                ) : (
                  <EmptyChart />
                )}
              </ChartPanel>

              <ChartPanel
                description="Cumulative active library entries by first-seen date."
                title="Entries over time"
              >
                {stats.entriesOverTime.length > 1 ? (
                  <AreaChart bloom="aura" config={entryConfig} data={stats.entriesOverTime}>
                    <Grid />
                    <XAxis dataKey="label" />
                    <YAxis />
                    <Tooltip labelKey="label" />
                    <Area dataKey="value" variant="hatched" />
                  </AreaChart>
                ) : (
                  <EmptyChart />
                )}
              </ChartPanel>

              <ChartPanel
                description="Bytes ingested per day over the last 30 days."
                title="Daily growth"
              >
                {stats.recentGrowth.some((row) => row.bytesAdded > 0) ? (
                  <BarChart bloom="aura" config={growthConfig} data={stats.recentGrowth}>
                    <Grid />
                    <XAxis dataKey="label" />
                    <YAxis />
                    <Tooltip labelKey="label" />
                    <Bar dataKey="bytesAdded" variant="gradient" />
                  </BarChart>
                ) : (
                  <EmptyChart />
                )}
              </ChartPanel>

              <ChartPanel
                description="Sync runs started each day over the last 90 days."
                title="Sync activity"
              >
                {stats.syncActivity.some((row) => row.started > 0) ? (
                  <BarChart bloom="aura" config={syncConfig} data={stats.syncActivity}>
                    <Grid />
                    <XAxis dataKey="label" />
                    <YAxis />
                    <Tooltip labelKey="label" />
                    <Bar dataKey="started" variant="gradient" />
                  </BarChart>
                ) : (
                  <EmptyChart />
                )}
              </ChartPanel>

              <ChartPanel
                description="Share of original storage by media type."
                title="Storage by type"
              >
                {mediaTypePieData.length > 0 ? (
                  <PieChart
                    bloom="aura"
                    config={mediaTypeConfig}
                    data={mediaTypePieData}
                    dataKey="bytes"
                    innerRadius={0.55}
                    nameKey="mediaType"
                  >
                    <Legend align="center" isClickable />
                    <Tooltip />
                    <Pie variant="gradient" />
                  </PieChart>
                ) : (
                  <EmptyChart />
                )}
              </ChartPanel>

              <ChartPanel
                description="Top extensions by original bytes stored."
                title="Top extensions"
              >
                {extensionBarData.length > 0 ? (
                  <BarChart bloom="aura" config={extensionConfig} data={extensionBarData}>
                    <Grid />
                    <XAxis dataKey="extension" />
                    <YAxis />
                    <Tooltip labelKey="extension" />
                    <Bar dataKey="bytes" variant="hatched" />
                  </BarChart>
                ) : (
                  <EmptyChart />
                )}
              </ChartPanel>
            </div>

            <section className="space-y-3 rounded-xl border border-border p-4">
              <div>
                <h2 className="text-sm font-semibold">Fun facts</h2>
                <p className="text-sm text-muted-foreground">
                  Odd corners of the archive that are still somehow useful.
                </p>
              </div>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                <FunFact
                  label="Largest object"
                  value={
                    stats.funFacts.largestObjectBytes > 0
                      ? `${formatBytes(stats.funFacts.largestObjectBytes)}${
                          stats.funFacts.largestObjectExtension
                            ? ` (${stats.funFacts.largestObjectExtension})`
                            : ""
                        }`
                      : "—"
                  }
                />
                <FunFact
                  label="Total video runtime"
                  value={formatDuration(stats.funFacts.totalVideoDurationMs)}
                />
                <FunFact
                  label="PDF pages indexed"
                  value={stats.funFacts.totalPdfPages.toLocaleString()}
                />
                <FunFact label="Images & gifs" value={stats.funFacts.imageCount.toLocaleString()} />
                <FunFact
                  label="Average megapixels"
                  value={
                    stats.funFacts.averageImageMegapixels == null
                      ? "—"
                      : `${stats.funFacts.averageImageMegapixels.toFixed(1)} MP`
                  }
                />
                <FunFact
                  label="Entries added (30d)"
                  value={stats.growth.entriesLast30Days.toLocaleString()}
                />
              </div>
            </section>

            <section className="space-y-3 rounded-xl border border-border p-4">
              <div>
                <h2 className="text-sm font-semibold">Busiest folders</h2>
                <p className="text-sm text-muted-foreground">
                  Active folders ranked by entry count.
                </p>
              </div>
              {stats.topFolders.length === 0 ? (
                <p className="text-sm text-muted-foreground">No folders with entries yet.</p>
              ) : (
                <ul className="divide-y divide-border">
                  {stats.topFolders.map((folder) => (
                    <li
                      className="flex items-center justify-between gap-3 py-2 text-sm"
                      key={folder.path}
                    >
                      <div className="min-w-0">
                        <p className="truncate font-medium">{folder.name}</p>
                        <p className="truncate font-mono text-xs text-muted-foreground">
                          {folder.path}
                        </p>
                      </div>
                      <p className="shrink-0 tabular-nums text-muted-foreground">
                        {folder.entryCount.toLocaleString()}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="grid gap-3 sm:grid-cols-2">
              <div className="rounded-xl border border-border p-4 text-sm">
                <p className="text-xs text-muted-foreground">Oldest object</p>
                <p className="mt-1 font-medium">
                  {stats.totals.oldestObjectAt
                    ? new Date(stats.totals.oldestObjectAt).toLocaleString()
                    : "—"}
                </p>
              </div>
              <div className="rounded-xl border border-border p-4 text-sm">
                <p className="text-xs text-muted-foreground">Newest object</p>
                <p className="mt-1 font-medium">
                  {stats.totals.newestObjectAt
                    ? new Date(stats.totals.newestObjectAt).toLocaleString()
                    : "—"}
                </p>
              </div>
            </section>
          </>
        ) : null}
      </div>
    </main>
  );
}

function FunFact({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-muted/40 p-3 ring-1 ring-inset ring-border">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 font-medium tabular-nums">{value}</p>
    </div>
  );
}

function EmptyChart() {
  return (
    <div className="flex h-full items-center justify-center rounded-lg bg-muted/30 text-sm text-muted-foreground">
      Not enough history yet
    </div>
  );
}
