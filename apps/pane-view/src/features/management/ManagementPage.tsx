import { formatBytes } from "@latch-works/media-domain";
import { Link } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { getLibrarySnapshot } from "../library/library-service";
import { CleanupJobProgress } from "./CleanupJobProgress";
import { FolderPicker } from "./FolderPicker";
import { LegacyDerivativeCleanupProgress } from "./LegacyDerivativeCleanupProgress";
import {
  useCancelAllRunningSyncRunsMutation,
  useCancelSyncRunMutation,
  useCleanupJobStatusQuery,
  useDeleteFoldersMutation,
  useLegacyDerivativeCleanupMutation,
  useLegacyDerivativeInventoryQuery,
  useManagementOverviewQuery,
  useSyncRunHistoryQuery,
  useWipeLibraryMutation,
} from "./management-queries";
import { SyncRunHistoryTable } from "./SyncRunHistoryTable";

export function ManagementPage() {
  const overviewQuery = useManagementOverviewQuery();
  const historyQuery = useSyncRunHistoryQuery();
  const deleteFoldersMutation = useDeleteFoldersMutation();
  const wipeMutation = useWipeLibraryMutation();
  const cancelSyncRunMutation = useCancelSyncRunMutation();
  const cancelAllSyncRunsMutation = useCancelAllRunningSyncRunsMutation();
  const legacyCleanupMutation = useLegacyDerivativeCleanupMutation();

  const [selectedFolders, setSelectedFolders] = useState<string[]>([]);
  const [wipeConfirm, setWipeConfirm] = useState("");
  const [syncToken, setSyncToken] = useState("");
  const [trackedJobId, setTrackedJobId] = useState<string | null>(null);
  const [trackedLegacyJobId, setTrackedLegacyJobId] = useState<string | null>(null);
  const [legacyCleanupConfirm, setLegacyCleanupConfirm] = useState("");
  const [legacyInventoryEnabled, setLegacyInventoryEnabled] = useState(false);
  const [folderSnapshot, setFolderSnapshot] = useState<Awaited<
    ReturnType<typeof getLibrarySnapshot>
  > | null>(null);
  const [folderSnapshotError, setFolderSnapshotError] = useState<string | null>(null);

  const overview = overviewQuery.data;
  const activeJobId = trackedJobId ?? overview?.activeCleanupJob?.id ?? null;
  const cleanupJobQuery = useCleanupJobStatusQuery(activeJobId);
  const activeLegacyJobId =
    trackedLegacyJobId ?? overview?.activeLegacyDerivativeCleanupJob?.id ?? null;
  const legacyCleanupJobQuery = useCleanupJobStatusQuery(activeLegacyJobId);
  const legacyInventoryQuery = useLegacyDerivativeInventoryQuery(legacyInventoryEnabled);
  const legacyCleanupActive = Boolean(
    activeLegacyJobId &&
      (!legacyCleanupJobQuery.data ||
        legacyCleanupJobQuery.data.status === "pending" ||
        legacyCleanupJobQuery.data.status === "running"),
  );

  useEffect(() => {
    const status = legacyCleanupJobQuery.data?.status;
    if (status === "completed" || status === "failed") {
      setLegacyInventoryEnabled(true);
      void legacyInventoryQuery.refetch();
      void overviewQuery.refetch();
    }
  }, [legacyCleanupJobQuery.data?.status, legacyInventoryQuery.refetch, overviewQuery.refetch]);

  const runningSyncCount = overview?.runningSyncRuns.length ?? 0;
  const maintenanceBlocked = Boolean(runningSyncCount > 0 || overview?.activeCleanupJob);
  const blockReason =
    runningSyncCount > 0
      ? runningSyncCount === 1
        ? `Sync in progress from ${overview?.runningSyncRuns[0]?.sourceRoot}.`
        : `${runningSyncCount} sync runs are still marked running.`
      : overview?.activeCleanupJob
        ? "Library wipe cleanup is still running."
        : null;

  const loadFolders = async () => {
    setFolderSnapshotError(null);
    try {
      const snapshot = await getLibrarySnapshot({
        data: {
          comicMode: true,
          path: "",
        },
      });
      setFolderSnapshot(snapshot);
    } catch (error) {
      setFolderSnapshotError(error instanceof Error ? error.message : "Unable to load folders.");
    }
  };

  const statCards = useMemo(() => {
    if (!overview) {
      return [];
    }

    return [
      { label: "Active entries", value: overview.library.activeEntries.toLocaleString() },
      { label: "Active folders", value: overview.library.activeFolders.toLocaleString() },
      {
        label: "Original storage",
        value: formatBytes(overview.storage.mediaObjectBytes),
      },
    ];
  }, [overview]);

  const handleDeleteFolders = async () => {
    await deleteFoldersMutation.mutateAsync(selectedFolders);
    setSelectedFolders([]);
  };

  const handleWipe = async () => {
    const result = await wipeMutation.mutateAsync({
      confirmation: wipeConfirm,
      syncToken,
    });
    setTrackedJobId(result.jobId);
    setWipeConfirm("");
    setSyncToken("");
  };

  const handleLegacyCleanup = async () => {
    const result = await legacyCleanupMutation.mutateAsync(legacyCleanupConfirm);
    setTrackedLegacyJobId(result.jobId);
    setLegacyCleanupConfirm("");
  };

  const cleanupJob = cleanupJobQuery.data;

  return (
    <main className="min-h-screen bg-background text-foreground">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-5 py-8">
        <header className="flex items-center justify-between gap-4">
          <div>
            <Link
              className="mb-2 inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground"
              to="/"
            >
              <ArrowLeft className="size-4" />
              Back to gallery
            </Link>
            <h1 className="text-2xl font-semibold">Management</h1>
            <p className="text-sm text-muted-foreground">
              Maintenance tools for folders, source storage, and library reset.
            </p>
          </div>
        </header>

        {blockReason ? (
          <section className="rounded-xl border border-amber-500/40 bg-amber-500/5 px-4 py-3 text-sm">
            {blockReason} Destructive actions are disabled until running syncs are stopped or
            finished. Use sync run history below to stop stuck runs.
          </section>
        ) : null}

        <section className="space-y-3">
          <h2 className="text-sm font-semibold">Overview</h2>
          {overviewQuery.isLoading ? (
            <p className="text-sm text-muted-foreground">Loading overview…</p>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {statCards.map((card) => (
                <div className="rounded-xl border border-border p-4" key={card.label}>
                  <p className="text-xs text-muted-foreground">{card.label}</p>
                  <p className="mt-1 text-lg font-semibold">{card.value}</p>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="space-y-4 rounded-xl border border-border p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="max-w-2xl">
              <h2 className="text-sm font-semibold text-balance">Legacy derivative storage</h2>
              <p className="text-sm text-muted-foreground text-pretty">
                Find thumbnails and previews left in Pane View storage before Shutter became the
                only rendition provider. This scan never includes originals.
              </p>
            </div>
            <Button
              disabled={legacyInventoryQuery.isFetching}
              onClick={() => {
                setLegacyInventoryEnabled(true);
                if (legacyInventoryEnabled) void legacyInventoryQuery.refetch();
              }}
              type="button"
              variant="outline"
            >
              {legacyInventoryQuery.isFetching ? "Scanning…" : "Scan legacy storage"}
            </Button>
          </div>

          {legacyInventoryQuery.error ? (
            <p className="text-sm text-destructive">
              {legacyInventoryQuery.error instanceof Error
                ? legacyInventoryQuery.error.message
                : "Unable to scan legacy storage."}
            </p>
          ) : null}

          {legacyInventoryQuery.data ? (
            <div className="grid gap-3 sm:grid-cols-3">
              {legacyInventoryQuery.data.prefixes.map((item) => (
                <div
                  className="rounded-lg bg-muted/40 p-3 ring-1 ring-inset ring-border"
                  key={item.prefix}
                >
                  <p className="font-mono text-xs text-muted-foreground">{item.prefix}</p>
                  <p className="mt-1 tabular-nums text-sm font-medium">
                    {item.count.toLocaleString()} objects · {formatBytes(item.bytes)}
                  </p>
                </div>
              ))}
              <div className="rounded-lg bg-muted/40 p-3 ring-1 ring-inset ring-border">
                <p className="text-xs text-muted-foreground">Total reclaimable</p>
                <p className="mt-1 tabular-nums text-sm font-medium">
                  {legacyInventoryQuery.data.totalCount.toLocaleString()} objects ·{" "}
                  {formatBytes(legacyInventoryQuery.data.totalBytes)}
                </p>
              </div>
            </div>
          ) : null}

          {legacyCleanupJobQuery.data ? (
            <LegacyDerivativeCleanupProgress
              job={legacyCleanupJobQuery.data}
              totalCount={legacyInventoryQuery.data?.totalCount}
            />
          ) : null}

          {legacyInventoryQuery.data && legacyInventoryQuery.data.totalCount > 0 ? (
            <div className="space-y-3 rounded-lg bg-destructive/5 p-3 ring-1 ring-inset ring-destructive/30">
              <p className="text-sm text-muted-foreground text-pretty">
                This permanently deletes only objects under <code>thumbnails/</code> and{" "}
                <code>previews/</code>. Type the confirmation phrase to continue.
              </p>
              <label className="grid gap-1 text-sm" htmlFor="legacy-derivative-confirm">
                <span>Type DELETE LEGACY DERIVATIVES to confirm</span>
                <Input
                  id="legacy-derivative-confirm"
                  onChange={(event) => setLegacyCleanupConfirm(event.target.value)}
                  value={legacyCleanupConfirm}
                />
              </label>
              <Button
                className="active:scale-[0.96] transition-transform"
                disabled={
                  legacyCleanupActive ||
                  legacyCleanupMutation.isPending ||
                  legacyCleanupConfirm !== "DELETE LEGACY DERIVATIVES"
                }
                onClick={() => void handleLegacyCleanup()}
                type="button"
                variant="destructive"
              >
                Delete legacy derivatives
              </Button>
              {legacyCleanupMutation.error ? (
                <p className="text-sm text-destructive">
                  {legacyCleanupMutation.error instanceof Error
                    ? legacyCleanupMutation.error.message
                    : "Unable to start legacy cleanup."}
                </p>
              ) : null}
            </div>
          ) : null}
        </section>

        {cleanupJob && (cleanupJob.status === "pending" || cleanupJob.status === "running") ? (
          <CleanupJobProgress job={cleanupJob} />
        ) : null}

        <section className="space-y-3">
          <h2 className="text-sm font-semibold">Sync run history</h2>
          {historyQuery.isLoading ? (
            <p className="text-sm text-muted-foreground">Loading sync history…</p>
          ) : (
            <SyncRunHistoryTable
              cancellingSyncRunId={cancelSyncRunMutation.variables ?? null}
              isCancellingAll={cancelAllSyncRunsMutation.isPending}
              onCancelAllRunning={() => void cancelAllSyncRunsMutation.mutateAsync()}
              onCancelRun={(syncRunId) => void cancelSyncRunMutation.mutateAsync(syncRunId)}
              runs={historyQuery.data ?? []}
            />
          )}
        </section>

        <section className="space-y-3 rounded-xl border border-border p-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h2 className="text-sm font-semibold">Delete folders</h2>
              <p className="text-sm text-muted-foreground">
                Soft-delete a folder subtree from the library index. Storage originals remain until
                a full wipe or manual cleanup.
              </p>
            </div>
            <Button onClick={() => void loadFolders()} type="button" variant="outline">
              Load folders
            </Button>
          </div>

          {folderSnapshotError ? (
            <p className="text-sm text-destructive">{folderSnapshotError}</p>
          ) : null}

          {folderSnapshot ? (
            <>
              <FolderPicker
                folders={folderSnapshot.allFolders}
                onChange={setSelectedFolders}
                selectedPaths={selectedFolders}
              />
              <Button
                disabled={
                  maintenanceBlocked ||
                  deleteFoldersMutation.isPending ||
                  selectedFolders.length === 0
                }
                onClick={() => void handleDeleteFolders()}
                type="button"
                variant="destructive"
              >
                Delete selected folders
              </Button>
            </>
          ) : null}
        </section>

        <section className="space-y-3 rounded-xl border border-destructive/40 p-4">
          <h2 className="text-sm font-semibold text-destructive">Danger zone</h2>
          <p className="text-sm text-muted-foreground">
            Schedule a full library wipe. The gallery empties immediately; storage and database
            cleanup continue in the background. Enter your Lockstep sync token to confirm.
          </p>
          <label className="grid gap-1 text-sm" htmlFor="wipe-library-sync-token">
            <span>Sync token</span>
            <Input
              autoComplete="off"
              id="wipe-library-sync-token"
              onChange={(event) => setSyncToken(event.target.value)}
              type="password"
              value={syncToken}
            />
          </label>
          <label className="grid gap-1 text-sm" htmlFor="wipe-library-confirm">
            <span>Type WIPE LIBRARY to confirm</span>
            <Input
              id="wipe-library-confirm"
              onChange={(event) => setWipeConfirm(event.target.value)}
              value={wipeConfirm}
            />
          </label>
          <Button
            disabled={maintenanceBlocked || wipeMutation.isPending}
            onClick={() => void handleWipe()}
            type="button"
            variant="destructive"
          >
            Wipe library
          </Button>
          {wipeMutation.error ? (
            <p className="text-sm text-destructive">
              {wipeMutation.error instanceof Error
                ? wipeMutation.error.message
                : "Library wipe failed."}
            </p>
          ) : null}
        </section>
      </div>
    </main>
  );
}
