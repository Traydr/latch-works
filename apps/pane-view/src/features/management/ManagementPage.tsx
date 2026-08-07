import { formatBytes } from "@latch-works/media-domain";
import { Link } from "@tanstack/react-router";
import { ArrowLeft, ChevronDown, ChevronRight } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { getLibrarySnapshot } from "../library/library-service";
import { CleanupJobProgress } from "./CleanupJobProgress";
import { FolderPicker } from "./FolderPicker";
import {
  useCancelAllRunningSyncRunsMutation,
  useCancelCleanupJobMutation,
  useCancelSyncRunMutation,
  useCleanupJobStatusQuery,
  useDeleteFoldersMutation,
  useManagementOverviewQuery,
  usePurgeDeletedShutterSourcesMutation,
  usePurgeSoftDeletedItemsMutation,
  useSyncRunHistoryQuery,
  useWipeLibraryMutation,
} from "./management-queries";
import { SyncRunHistoryTable } from "./SyncRunHistoryTable";

export function ManagementPage() {
  const overviewQuery = useManagementOverviewQuery();
  const [historyExpanded, setHistoryExpanded] = useState(false);
  const historyQuery = useSyncRunHistoryQuery(historyExpanded);
  const deleteFoldersMutation = useDeleteFoldersMutation();
  const purgeSoftDeletedMutation = usePurgeSoftDeletedItemsMutation();
  const purgeShutterSourcesMutation = usePurgeDeletedShutterSourcesMutation();
  const wipeMutation = useWipeLibraryMutation();
  const cancelSyncRunMutation = useCancelSyncRunMutation();
  const cancelAllSyncRunsMutation = useCancelAllRunningSyncRunsMutation();
  const cancelCleanupJobMutation = useCancelCleanupJobMutation();

  const [selectedFolders, setSelectedFolders] = useState<string[]>([]);
  const [wipeConfirm, setWipeConfirm] = useState("");
  const [syncToken, setSyncToken] = useState("");
  const [trackedJobId, setTrackedJobId] = useState<string | null>(null);
  const [shutterPurgeMessage, setShutterPurgeMessage] = useState<string | null>(null);
  const [folderSnapshot, setFolderSnapshot] = useState<Awaited<
    ReturnType<typeof getLibrarySnapshot>
  > | null>(null);
  const [folderSnapshotError, setFolderSnapshotError] = useState<string | null>(null);

  const overview = overviewQuery.data;
  const activeJobId = trackedJobId ?? overview?.activeCleanupJob?.id ?? null;
  const cleanupJobQuery = useCleanupJobStatusQuery(activeJobId);

  useEffect(() => {
    if (overview?.activeCleanupJob?.id) {
      setTrackedJobId(overview.activeCleanupJob.id);
    }
  }, [overview?.activeCleanupJob?.id]);
  const runningSyncCount = overview?.runningSyncRuns.length ?? 0;
  const maintenanceBlocked = Boolean(runningSyncCount > 0 || overview?.activeCleanupJob);
  const blockReason =
    runningSyncCount > 0
      ? runningSyncCount === 1
        ? `Sync in progress from ${overview?.runningSyncRuns[0]?.sourceRoot}.`
        : `${runningSyncCount} sync runs are still marked running.`
      : overview?.activeCleanupJob
        ? "Library cleanup is still running."
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
        label: "Soft-deleted entries",
        value: overview.library.softDeletedEntries.toLocaleString(),
      },
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

  const handlePurgeSoftDeleted = async () => {
    const count = overview?.library.softDeletedEntries ?? 0;
    if (
      !window.confirm(
        `Permanently delete ${count.toLocaleString()} soft-deleted item${count === 1 ? "" : "s"}? This cannot be undone.`,
      )
    ) {
      return;
    }

    const result = await purgeSoftDeletedMutation.mutateAsync();
    if (result.jobId) setTrackedJobId(result.jobId);
  };

  const handlePurgeShutterSources = async () => {
    if (
      !window.confirm(
        "Delete Shutter sources belonging only to soft-deleted items? Active library media is excluded.",
      )
    ) {
      return;
    }

    setShutterPurgeMessage(null);
    const result = await purgeShutterSourcesMutation.mutateAsync();
    if (result.jobId) {
      setTrackedJobId(result.jobId);
    } else {
      setShutterPurgeMessage("No deleted-item Shutter sources are waiting to be purged.");
    }
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
            finished. Use the cleanup control below or sync run history to stop stuck work.
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

        {cleanupJob ? (
          <CleanupJobProgress
            cancelError={
              cancelCleanupJobMutation.error instanceof Error
                ? cancelCleanupJobMutation.error.message
                : null
            }
            isCancelling={cancelCleanupJobMutation.isPending}
            job={cleanupJob}
            onCancel={() => cancelCleanupJobMutation.mutate(cleanupJob.id)}
          />
        ) : null}

        <section className="space-y-3" id="sync-run-history">
          <Button
            aria-controls="sync-run-history-content"
            aria-expanded={historyExpanded}
            className="h-auto gap-2 px-0 text-sm font-semibold"
            onClick={() => setHistoryExpanded((expanded) => !expanded)}
            type="button"
            variant="ghost"
          >
            {historyExpanded ? (
              <ChevronDown className="size-4" />
            ) : (
              <ChevronRight className="size-4" />
            )}
            Sync run history
          </Button>
          {historyExpanded ? (
            <div id="sync-run-history-content">
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
            </div>
          ) : null}
        </section>

        <section className="space-y-3 rounded-xl border border-border p-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h2 className="text-sm font-semibold">Delete folders</h2>
              <p className="text-sm text-muted-foreground">
                Soft-delete a folder subtree from the library index. Storage originals remain until
                deleted items are purged or the library is wiped.
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

        <section className="space-y-3 rounded-xl border border-border p-4">
          <h2 className="text-sm font-semibold">Purge deleted items</h2>
          <p className="text-sm text-muted-foreground">
            Permanently remove all soft-deleted entries and their originals from Pane View storage
            when no active entry references the same media. Shutter source IDs are retained for the
            separate cleanup action below.
          </p>
          <Button
            disabled={
              maintenanceBlocked ||
              purgeSoftDeletedMutation.isPending ||
              (overview?.library.softDeletedEntries ?? 0) === 0
            }
            onClick={() => void handlePurgeSoftDeleted()}
            type="button"
            variant="destructive"
          >
            Permanently delete {overview?.library.softDeletedEntries.toLocaleString() ?? 0} items
          </Button>
          {purgeSoftDeletedMutation.error ? (
            <p className="text-sm text-destructive">
              {purgeSoftDeletedMutation.error instanceof Error
                ? purgeSoftDeletedMutation.error.message
                : "Deleted-item cleanup failed."}
            </p>
          ) : null}
        </section>

        <section className="space-y-3 rounded-xl border border-border p-4">
          <h2 className="text-sm font-semibold">Purge deleted Shutter sources</h2>
          <p className="text-sm text-muted-foreground">
            Delete Shutter sources associated only with soft-deleted items. This can run before or
            after Pane View storage cleanup, and never targets media referenced by an active item.
          </p>
          <Button
            disabled={maintenanceBlocked || purgeShutterSourcesMutation.isPending}
            onClick={() => void handlePurgeShutterSources()}
            type="button"
            variant="destructive"
          >
            {purgeShutterSourcesMutation.isPending
              ? "Scheduling Shutter cleanup…"
              : "Purge deleted Shutter sources"}
          </Button>
          {shutterPurgeMessage ? (
            <p className="text-sm text-muted-foreground">{shutterPurgeMessage}</p>
          ) : null}
          {purgeShutterSourcesMutation.error ? (
            <p className="text-sm text-destructive">
              {purgeShutterSourcesMutation.error instanceof Error
                ? purgeShutterSourcesMutation.error.message
                : "Shutter source cleanup failed."}
            </p>
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
