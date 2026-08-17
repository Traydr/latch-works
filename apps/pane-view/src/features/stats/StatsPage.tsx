import { formatBytes, type MediaType } from "@latch-works/media-domain";
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
import { bytesToMegabytes } from "./stats-chart-data";
import { useArchiveStatsQuery } from "./stats-queries";

const MEDIA_TYPE_COLORS = {
  gif: "pink",
  image: "blue",
  pdf: "orange",
  unknown: "grey",
  video: "purple",
} satisfies Record<MediaType, DitherColor>;

const SIZE_CHART_CONFIG = {
  value: { color: "blue" as const, label: "Archive size (MB)" },
} satisfies ChartConfig;

const ENTRY_CHART_CONFIG = {
  value: { color: "green" as const, label: "Entries" },
} satisfies ChartConfig;

const GROWTH_CHART_CONFIG = {
  bytesAdded: { color: "orange" as const, label: "MB added" },
} satisfies ChartConfig;

const SYNC_CHART_CONFIG = {
  started: { color: "blue" as const, label: "Sync runs" },
} satisfies ChartConfig;

const EXTENSION_CHART_CONFIG = {
  megabytes: { color: "purple" as const, label: "MB" },
} satisfies ChartConfig;

const ARCHIVE_TIMESTAMP_FORMATTER = new Intl.DateTimeFormat("en-GB", {
  dateStyle: "medium",
  timeStyle: "medium",
  timeZone: "UTC",
});

type ArchiveStats = NonNullable<ReturnType<typeof useArchiveStatsQuery>["data"]>;

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

  const sizeChartData =
    stats?.sizeOverTime.map((point) => ({
      ...point,
      value: bytesToMegabytes(point.value),
    })) ?? [];
  const recentGrowthChartData =
    stats?.recentGrowth.map((point) => ({
      ...point,
      bytesAdded: bytesToMegabytes(point.bytesAdded),
    })) ?? [];
  const sizeSpark = sizeChartData.map((point) => point.value);
  const entrySpark = stats?.entriesOverTime.map((point) => point.value) ?? [];
  const growthSpark = recentGrowthChartData.map((point) => point.bytesAdded);

  const mediaTypePieData =
    stats?.byMediaType.map((row) => ({
      megabytes: bytesToMegabytes(row.bytes),
      mediaType: row.mediaType,
    })) ?? [];

  const mediaTypeConfig = Object.fromEntries(
    mediaTypePieData.map((row) => [
      row.mediaType,
      {
        color: MEDIA_TYPE_COLORS[row.mediaType],
        label: row.mediaType,
      },
    ]),
  ) satisfies ChartConfig;

  const extensionBarData =
    stats?.topExtensions.map((row) => ({
      extension: row.extension,
      megabytes: bytesToMegabytes(row.bytes),
    })) ?? [];

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

            <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              <StatCard
                label="Average object"
                value={formatBytes(stats.totals.averageObjectBytes)}
              />
              <StatCard label="Folders" value={stats.totals.activeFolders.toLocaleString()} />
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
                description="Cumulative original storage in MB from object created dates (last 90 days)."
                title="Size over time"
              >
                {stats.sizeOverTime.length > 1 ? (
                  <AreaChart bloom="aura" config={SIZE_CHART_CONFIG} data={sizeChartData}>
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
                  <AreaChart bloom="aura" config={ENTRY_CHART_CONFIG} data={stats.entriesOverTime}>
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
                description="MB ingested per day over the last 30 days."
                title="Daily growth"
              >
                {stats.recentGrowth.some((row) => row.bytesAdded > 0) ? (
                  <BarChart bloom="aura" config={GROWTH_CHART_CONFIG} data={recentGrowthChartData}>
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
                  <BarChart bloom="aura" config={SYNC_CHART_CONFIG} data={stats.syncActivity}>
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
                description="Share of original storage in MB by media type."
                title="Storage by type"
              >
                {mediaTypePieData.length > 0 ? (
                  <PieChart
                    bloom="aura"
                    config={mediaTypeConfig}
                    data={mediaTypePieData}
                    dataKey="megabytes"
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
                description="Top extensions by original storage in MB."
                title="Top extensions"
              >
                {extensionBarData.length > 0 ? (
                  <BarChart bloom="aura" config={EXTENSION_CHART_CONFIG} data={extensionBarData}>
                    <Grid />
                    <XAxis dataKey="extension" />
                    <YAxis />
                    <Tooltip labelKey="extension" />
                    <Bar dataKey="megabytes" variant="hatched" />
                  </BarChart>
                ) : (
                  <EmptyChart />
                )}
              </ChartPanel>
            </div>

            <StatsHighlights stats={stats} />
          </>
        ) : null}
      </div>
    </main>
  );
}

function StatsHighlights({ stats }: { stats: ArchiveStats }) {
  return (
    <>
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
          <FunFact label="Images & gifs" value={stats.funFacts.imageCount.toLocaleString()} />
          <FunFact
            label="Entries added (30d)"
            value={stats.growth.entriesLast30Days.toLocaleString()}
          />
        </div>
      </section>

      <section className="space-y-3 rounded-xl border border-border p-4">
        <div>
          <h2 className="text-sm font-semibold">Busiest folders</h2>
          <p className="text-sm text-muted-foreground">Active folders ranked by entry count.</p>
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
                  <p className="truncate font-mono text-xs text-muted-foreground">{folder.path}</p>
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
        <TimestampCard label="Oldest object" value={stats.totals.oldestObjectAt} />
        <TimestampCard label="Newest object" value={stats.totals.newestObjectAt} />
      </section>
    </>
  );
}

function TimestampCard({ label, value }: { label: string; value: Date | string | null }) {
  return (
    <div className="rounded-xl border border-border p-4 text-sm">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 font-medium">
        {value ? ARCHIVE_TIMESTAMP_FORMATTER.format(new Date(value)) : "—"}
      </p>
    </div>
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
