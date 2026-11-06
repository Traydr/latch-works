//! The engine the Tidy UI talks to, after glazier-core's `engine/engine.ts`: its roots and
//! settings, the scan and the analysis as `oriel-runtime` jobs, the queries behind Overview,
//! the Library and Duplicates, and (in [`changes`]) every change to the archive with its history
//! and holding.
//!
//! The work itself is synchronous and runs on a thread of its own, its passes on worker threads
//! below it; the catalog's calls go to the catalog's SQLite thread. Jobs report their phase and
//! how far it has got through [`Job`]'s progress, which is what the shell's "Working" dot
//! follows: the UI forwards it, the engine never touches the shell.
//!
//! One piece of work runs at a time, as glazier-core's queue runs one job at a time (see
//! [`schedule`]): scans, changes and analysis the owner asked for run in the order asked, and
//! background analysis runs behind them, stepping aside when such work arrives and carrying on
//! after. A job can be paused ([`Job::pause`]) and stopped; queries never wait for the queue.

mod changes;
mod schedule;

pub use changes::{
    Applied, FollowUp, FollowUpReport, Performed, TidiedUp, Undone, still_concurrency,
};

use schedule::{Priority, Scheduler};

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock, PoisonError};

use anyhow::{Context as _, bail};
use futures::channel::oneshot;
use gpui_kit::{App, Entity};
use oriel_core_paths::DataRoot;
use oriel_runtime::{Job, JobReporter, release_free_memory};
use oriel_tools::MediaTools;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};

use crate::catalog::files::{
    delete_unseen_files, file_facets, filter_needs_convertible, get_file_records,
    list_empty_folders, list_file_ids, list_files, list_folders, record_convertible,
    replace_empty_folders, roots_of_files, selection_summary, upsert_walked_files,
};
use crate::catalog::roots::{
    add_root, find_root, list_roots, mark_scanned, read_settings, remove_root, resolve_root_folder,
    write_settings,
};
use crate::catalog::tidy::catalog_tidy;
use crate::catalog::{CATALOG_FILE_NAME, Catalog, now_ms};
use crate::contract::{
    CleanupCounts, DuplicateDismissal, DuplicateKind, DuplicateScope, DuplicateSetPage,
    DuplicateSetRequest, DuplicateTotalsByKind, FileFacets, FileFilter, FileId, FileIdList,
    FilePage, FileQuery, FileRow, OptimizeSummary, Root, RootId, SelectionSummary, Settings,
    ShrinkSummary, SimilarityLevel, Tidy,
};
use crate::duplicates::{
    ComputedSet, Dismissals, PageRequest, add_dismissal, build_duplicate_sets, checking_sets,
    compute_similar_clusters, duplicate_totals, fingerprint_coverage, list_dismissals, open_sets,
    page_duplicate_sets, pairs_to_compare, remove_dismissal, stills_to_print,
};
use crate::optimize::candidates::skip_counts;
use crate::optimize::{
    CandidateScan, ShrinkScan, extension_fixes, find_optimize_candidates, find_shrink_candidates,
    summarize_candidates,
};
use crate::passes::detail::{
    answers_wait_to_be_read, forget_outdated_details, forget_unread, prints_wait_for_libvips,
    run_comparison_pass, run_detail_pass,
};
use crate::passes::fingerprint::{pending_fingerprints, run_fingerprint_pass};
use crate::passes::hash::run_hash_pass;
use crate::passes::loudness::{pending_loudness, run_loudness_pass};
use crate::passes::probe::run_probe_pass;
use crate::passes::sniff::run_sniff_pass;
use crate::passes::{Media, PassContext, Progress};
use crate::scan::walk_root;
use crate::similarity::{SimilarCluster, Vips};

/// Tiles Shrink shows for the batch that runs next.
const SHRINK_PREVIEW_ROWS: usize = 60;

/// What a scan did.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanReport {
    pub files: usize,
    pub empty_folders: usize,
    /// Symlinks and other non-regular entries, never followed.
    pub skipped_entries: usize,
    /// Files the catalog had that the walk did not see again.
    pub removed: usize,
    /// The background analysis that followed, when [`TidyEngine::start_scan`] ran it.
    pub analysis: Option<AnalysisReport>,
    /// The background analysis glazier-core queues after a scan (background analysis on, and
    /// files that need fingerprints or loudness, or pairs it could not read), for the caller to
    /// start with [`TidyEngine::start_catch_up_analysis`]; empty when the job ran it.
    pub follow_up: FollowUp,
}

/// What an analysis did.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalysisReport {
    /// Files that needed a fingerprint when it started.
    pub fingerprints: i64,
    /// Stills of similar sets offered to the detail pass, with Spot variants on.
    pub detail_candidates: usize,
    /// Videos whose soundtrack needed measuring when it started.
    pub soundtracks: i64,
}

/// Settings after a change, and whether the roots need analysing again for it: background
/// analysis turned on, or Spot variants on with sets that need prints.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SettingsUpdate {
    pub settings: Settings,
    pub analyze: bool,
}

/// Duplicate sets as last computed, kept while nothing in the catalog changed.
struct SetCache {
    generation: u64,
    root_id: Option<RootId>,
    level: SimilarityLevel,
    sets: Arc<Vec<ComputedSet>>,
}

/// Similar clusters as last computed for a root and level, kept while no fingerprint changed.
struct ClusterCache {
    fingerprints: u64,
    clusters: Arc<Vec<SimilarCluster>>,
}

/// Where the catalog stands: two equal states have no change to the catalog between them. Every
/// write goes through the catalog's one connection, which counts the rows it changes, and SQLite
/// says when another connection wrote; the engine's own counters go with them.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct CatalogState {
    changes: u64,
    data_version: i64,
    generation: u64,
    fingerprints: u64,
}

/// A result worked out from the catalog alone, kept with the state the catalog was in once it
/// was made (its own writes included), for as long as the catalog stays in that state.
struct Kept<T> {
    state: CatalogState,
    value: T,
}

struct Inner {
    catalog: Catalog,
    data: DataRoot,
    media: Media,
    /// One piece of work at a time, asked-for work first.
    scheduler: Scheduler,
    scan_counter: Mutex<i64>,
    /// Bumped whenever the engine changes the catalog, so a cached result computed across a
    /// change is not kept.
    generation: AtomicU64,
    sets: Mutex<Option<SetCache>>,
    /// Bumped whenever fingerprints may have changed: a walk drops those of changed files, the
    /// fingerprint pass writes them. Only fingerprints change the clusters, so they survive every
    /// other change, as glazier-core's `clusterCache` does: a file resolved away since simply
    /// drops out of its cluster when sets are built. This is not only speed: a set a Convert is
    /// rewriting stays one set through the change, its files' prints being gone until the analysis
    /// after it, where clusters made afresh would break it up under the owner.
    fingerprints: AtomicU64,
    clusters: Mutex<HashMap<(Option<RootId>, SimilarityLevel), ClusterCache>>,
    /// Where each root's held files go.
    places: crate::plans::holding::HoldingPlaces,
    /// What the pinned ffmpeg and libavif can encode, asked once.
    capabilities: OnceLock<crate::contract::EncoderCapabilities>,
    /// Convert's estimates per root and category, kept while the category holds the same files.
    estimates: Mutex<HashMap<(RootId, crate::contract::OptimizeCategory), changes::CachedEstimate>>,
    /// What finding Convert's candidates gives, per root: Overview's numbers, and that the
    /// Library's convertible files are recorded. Overview is asked for about three times a
    /// decision, each read 37 ms on 40,000 files without this. Any change to the catalog, an
    /// analysis writing its prints or a change applied, makes them be found again. The candidates
    /// themselves are not kept.
    overviews: Mutex<HashMap<RootId, Kept<Tidy>>>,
    convertible: Mutex<HashMap<RootId, Kept<()>>>,
}

/// Tidy's engine. Clones share one catalog and one queue of work.
#[derive(Clone)]
pub struct TidyEngine {
    inner: Arc<Inner>,
}

impl std::fmt::Debug for TidyEngine {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TidyEngine")
            .field("catalog", &self.inner.catalog.path())
            .field("media", &self.inner.media)
            .finish_non_exhaustive()
    }
}

impl Media {
    /// The app's own tools: libvips by [`crate::similarity::locate_libvips`] (8.18.x only), and
    /// the pinned ffmpeg and ffprobe by [`MediaTools::locate`]. One that cannot be found is left
    /// out, with a warning, and the passes that need it wait. libvips is loaded the first time
    /// something decodes a picture (a scan, an analysis, a change), not as Tidy opens.
    pub fn locate() -> Media {
        let vips = match Vips::locate_deferred() {
            Ok((vips, _, _)) => Some(Arc::new(vips)),
            Err(error) => {
                log::warn!("Tidy runs without libvips: {error}");
                None
            }
        };
        let (ffmpeg, ffprobe) = match MediaTools::locate() {
            Ok(tools) => (
                Some(tools.ffmpeg().to_path_buf()),
                Some(tools.ffprobe().to_path_buf()),
            ),
            Err(error) => {
                log::warn!("Tidy runs without ffmpeg and ffprobe: {error}");
                (None, None)
            }
        };
        Media {
            vips,
            ffmpeg,
            ffprobe,
        }
    }
}

/// Runs blocking work on a thread of its own and resolves with what it returns.
fn on_thread<T: Send + 'static>(
    name: &str,
    work: impl FnOnce() -> anyhow::Result<T> + Send + 'static,
) -> impl Future<Output = anyhow::Result<T>> + Send + 'static {
    let (reply, answer) = oneshot::channel();
    let spawned = std::thread::Builder::new()
        .name(name.to_owned())
        .spawn(move || {
            let _ = reply.send(work());
        });
    async move {
        spawned.context("starting Tidy's worker thread")?;
        answer
            .await
            .context("Tidy's worker thread stopped without an answer")?
    }
}

impl TidyEngine {
    /// Opens the engine on `DataRoot::tidy()/catalog.sqlite`, with the tools [`Media::locate`]
    /// finds.
    pub async fn open(data: DataRoot) -> anyhow::Result<Self> {
        let catalog = data.tidy().join(CATALOG_FILE_NAME);
        Self::open_with(data, catalog, Media::locate()).await
    }

    /// Opens the engine on a catalog of its own, with the tools given; for tests and tools.
    pub async fn open_with(
        data: DataRoot,
        catalog_path: PathBuf,
        media: Media,
    ) -> anyhow::Result<Self> {
        if let Some(folder) = catalog_path.parent() {
            std::fs::create_dir_all(folder)
                .with_context(|| format!("creating {}", folder.display()))?;
        }
        let data_dir = catalog_path
            .parent()
            .map_or_else(|| data.tidy(), Path::to_path_buf);
        let catalog = Catalog::open(catalog_path).await?;
        // Held files keep their place when the data folder moves, and a change a crash stopped
        // halfway is cancelled, its temp files removed, so its finished steps can be undone.
        let followed = data_dir.clone();
        catalog
            .call(move |connection| {
                crate::plans::holding::follow_data_folder(connection, &followed)?;
                crate::plans::journal::recover_interrupted_plans(connection)?;
                Ok(())
            })
            .await?;
        // The owner's run holds a root on another volume on that volume, as glazier-core does; a
        // sandboxed one keeps every held file in its own data folder.
        let places = crate::plans::holding::HoldingPlaces::new(data_dir)
            .on_volumes(!data.is_sandboxed())
            .sandboxed_in(data.is_sandboxed().then(|| data.clone()));
        Ok(Self {
            inner: Arc::new(Inner {
                catalog,
                data,
                media,
                scheduler: Scheduler::default(),
                scan_counter: Mutex::new(now_ms()),
                generation: AtomicU64::new(0),
                sets: Mutex::new(None),
                fingerprints: AtomicU64::new(0),
                clusters: Mutex::new(HashMap::new()),
                places,
                capabilities: OnceLock::new(),
                estimates: Mutex::new(HashMap::new()),
                overviews: Mutex::new(HashMap::new()),
                convertible: Mutex::new(HashMap::new()),
            }),
        })
    }

    pub fn catalog(&self) -> &Catalog {
        &self.inner.catalog
    }

    pub fn media(&self) -> &Media {
        &self.inner.media
    }

    pub fn data_root(&self) -> &DataRoot {
        &self.inner.data
    }

    /// Runs a query on the catalog's thread with the engine at hand.
    fn query<R: Send + 'static>(
        &self,
        query: impl FnOnce(&Inner, &mut Connection) -> anyhow::Result<R> + Send + 'static,
    ) -> impl Future<Output = anyhow::Result<R>> + Send + 'static {
        let inner = self.inner.clone();
        self.inner
            .catalog
            .call(move |connection| query(&inner, connection))
    }

    // Roots and settings.

    pub fn roots(&self) -> impl Future<Output = anyhow::Result<Vec<Root>>> + Send + 'static {
        self.query(|_, connection| list_roots(connection))
    }

    /// Adds a folder as a root, refusing one that is missing, a file or overlapping another root,
    /// and in a sandboxed run one outside the sandbox. Scanning it is the caller's next step
    /// ([`TidyEngine::start_scan`]).
    pub fn add_root(
        &self,
        folder: impl AsRef<Path>,
    ) -> impl Future<Output = anyhow::Result<Root>> + Send + 'static {
        let resolved = resolve_root_folder(&self.inner.data, folder.as_ref());
        self.query(move |inner, connection| {
            let root = add_root(connection, &resolved?)?;
            inner.changed();
            Ok(root)
        })
    }

    /// Says whether [`Self::remove_root`] would refuse a root now, for a caller with something to
    /// do first that cannot be taken back, as Forget's emptying of holding. It waits for nothing.
    pub fn check_root_removable(&self, root_id: RootId) -> anyhow::Result<()> {
        Ok(self.inner.scheduler.check_removable(root_id)?)
    }

    /// Forgets a root and its catalog rows. Files on disk are untouched. As glazier-core's
    /// `removeRoot`, it is refused while a scan, a change or an asked-for analysis of the root
    /// waits or runs; background
    /// analysis of it is stopped first, since it is only worth finishing for a root that stays.
    pub fn remove_root(
        &self,
        root_id: RootId,
    ) -> impl Future<Output = anyhow::Result<Vec<Root>>> + Send + 'static {
        let inner = self.inner.clone();
        // Not on the catalog's thread: stopping waits for the analysis to let go of its turn,
        // and the item it has in flight may still write to the catalog.
        on_thread("tidy remove root", move || {
            inner.scheduler.stop_work_on(root_id)?;
            let removed = inner.clone();
            inner.catalog.blocking(move |connection| {
                remove_root(connection, root_id)?;
                removed.fingerprints_changed();
                removed.changed();
                list_roots(connection)
            })
        })
    }

    pub fn settings(&self) -> impl Future<Output = anyhow::Result<Settings>> + Send + 'static {
        self.query(|_, connection| read_settings(connection))
    }

    /// Stores new settings and says whether the roots need analysing for them, as glazier-core's
    /// `updateSettings` queues analysis: when background analysis is turned on, and when Spot
    /// variants is on and the sets it needs prints for may have changed.
    pub fn update_settings(
        &self,
        settings: Settings,
    ) -> impl Future<Output = anyhow::Result<SettingsUpdate>> + Send + 'static {
        self.query(move |inner, connection| {
            let before = read_settings(connection)?;
            write_settings(connection, &settings)?;
            inner.changed();
            // With Spot variants off too, new sets may have AVIFs to read before they offer anything.
            let new_sets = before.spot_variants != settings.spot_variants
                || before.similarity != settings.similarity;
            let analyze = (settings.auto_analyze && !before.auto_analyze) || new_sets;
            Ok(SettingsUpdate { settings, analyze })
        })
    }

    // Overview, the Library and Duplicates.

    /// Whether a root has analysis to catch up on when Tidy starts, such as prints an older
    /// version made, which sets cannot compare until they are made again.
    pub fn analysis_due(
        &self,
        root_id: RootId,
    ) -> impl Future<Output = anyhow::Result<bool>> + Send + 'static {
        self.query(move |inner, connection| inner.analysis_due_in(connection, root_id))
    }

    /// Overview's numbers for a root: duplicates, conversions, Shrink, silent soundtracks,
    /// clean-up, what needs a look, and how far analysis has come (glazier-core's `tidy`).
    pub fn overview(
        &self,
        root_id: RootId,
    ) -> impl Future<Output = anyhow::Result<Tidy>> + Send + 'static {
        self.query(move |inner, connection| inner.overview(connection, root_id))
    }

    /// One page of the Library, with glazier-core's filters, search, folder and sort.
    pub fn list_files(
        &self,
        query: FileQuery,
    ) -> impl Future<Output = anyhow::Result<FilePage>> + Send + 'static {
        self.query(move |inner, connection| {
            if filter_needs_convertible(&query.filter) {
                inner.prepare_convertible(connection, query.filter.root_id)?;
            }
            list_files(connection, &query)
        })
    }

    /// Every matching file's id, in path order, up to [`crate::contract::MAX_BULK_FILES`].
    pub fn list_file_ids(
        &self,
        filter: FileFilter,
    ) -> impl Future<Output = anyhow::Result<FileIdList>> + Send + 'static {
        self.query(move |inner, connection| {
            if filter_needs_convertible(&filter) {
                inner.prepare_convertible(connection, filter.root_id)?;
            }
            list_file_ids(connection, &filter)
        })
    }

    /// The filter menu's counts.
    pub fn file_facets(
        &self,
        filter: FileFilter,
    ) -> impl Future<Output = anyhow::Result<FileFacets>> + Send + 'static {
        self.query(move |inner, connection| {
            inner.prepare_convertible(connection, filter.root_id)?;
            file_facets(connection, &filter)
        })
    }

    pub fn get_files(
        &self,
        ids: Vec<FileId>,
    ) -> impl Future<Output = anyhow::Result<Vec<FileRow>>> + Send + 'static {
        self.query(move |_, connection| {
            Ok(get_file_records(connection, &ids)?
                .iter()
                .map(|record| record.to_file_row())
                .collect())
        })
    }

    pub fn selection_summary(
        &self,
        ids: Vec<FileId>,
    ) -> impl Future<Output = anyhow::Result<SelectionSummary>> + Send + 'static {
        self.query(move |inner, connection| {
            for root_id in roots_of_files(connection, &ids)? {
                inner.prepare_convertible(connection, Some(root_id))?;
            }
            selection_summary(connection, &ids)
        })
    }

    pub fn list_folders(
        &self,
        root_id: RootId,
    ) -> impl Future<Output = anyhow::Result<Vec<String>>> + Send + 'static {
        self.query(move |_, connection| list_folders(connection, root_id))
    }

    pub fn list_empty_folders(
        &self,
        root_id: RootId,
    ) -> impl Future<Output = anyhow::Result<Vec<String>>> + Send + 'static {
        self.query(move |_, connection| list_empty_folders(connection, root_id))
    }

    /// Duplicate sets, most bytes to reclaim first, with the counts Duplicates' queue shows.
    pub fn duplicate_sets(
        &self,
        request: DuplicateSetRequest,
    ) -> impl Future<Output = anyhow::Result<DuplicateSetPage>> + Send + 'static {
        self.query(move |inner, connection| {
            let computed = inner.duplicate_sets(connection, request.root_id, request.level)?;
            let mut page = page_duplicate_sets(
                &computed,
                &Dismissals::load(connection)?,
                PageRequest {
                    scope: request.scope,
                    dismissed: request.dismissed,
                    offset: request.offset,
                    limit: request.limit,
                },
            );
            let coverage = fingerprint_coverage(connection, request.root_id)?;
            page.fingerprinted = coverage.fingerprinted;
            page.fingerprintable = coverage.fingerprintable;
            Ok(page)
        })
    }

    /// The similar groups fingerprints make under a root (or every root) at a level, before
    /// they are joined with identical copies into duplicate sets.
    pub fn similar_groups(
        &self,
        root_id: Option<RootId>,
        level: SimilarityLevel,
    ) -> impl Future<Output = anyhow::Result<Vec<SimilarCluster>>> + Send + 'static {
        self.query(move |inner, connection| {
            Ok(inner
                .similar_clusters(connection, root_id, level)?
                .as_ref()
                .clone())
        })
    }

    /// Marks files as not duplicates of each other, so a set made only of them stays hidden.
    pub fn dismiss_duplicate_set(
        &self,
        ids: Vec<FileId>,
    ) -> impl Future<Output = anyhow::Result<i64>> + Send + 'static {
        self.query(move |inner, connection| {
            let dismissal = add_dismissal(connection, &ids, None)?;
            inner.changed();
            Ok(dismissal)
        })
    }

    pub fn restore_duplicate_set(
        &self,
        dismissal_id: i64,
    ) -> impl Future<Output = anyhow::Result<()>> + Send + 'static {
        self.query(move |inner, connection| {
            remove_dismissal(connection, dismissal_id)?;
            inner.changed();
            Ok(())
        })
    }

    /// The sets marked as not duplicates by hand under a root, newest first, for History.
    pub fn list_dismissals(
        &self,
        root_id: RootId,
        limit: usize,
    ) -> impl Future<Output = anyhow::Result<Vec<DuplicateDismissal>>> + Send + 'static {
        self.query(move |_, connection| list_dismissals(connection, root_id, limit))
    }

    /// What Convert would change under a root.
    pub fn optimize_summary(
        &self,
        root_id: RootId,
    ) -> impl Future<Output = anyhow::Result<OptimizeSummary>> + Send + 'static {
        self.query(move |inner, connection| {
            let removable = inner.removable_copies(connection, root_id)?;
            Ok(summarize_candidates(
                &inner.candidates(connection, root_id)?,
                &removable,
            ))
        })
    }

    /// What Shrink would re-encode under a root.
    pub fn shrink_summary(
        &self,
        root_id: RootId,
    ) -> impl Future<Output = anyhow::Result<ShrinkSummary>> + Send + 'static {
        self.query(move |inner, connection| {
            let scan = inner.shrink_scan(connection, root_id)?;
            Ok(ShrinkSummary {
                items: scan.candidates.iter().map(|c| c.item.clone()).collect(),
                preview: scan
                    .candidates
                    .iter()
                    .take(SHRINK_PREVIEW_ROWS)
                    .map(|c| c.record.to_file_row())
                    .collect(),
                skipped: skip_counts(&scan.skipped),
                speed_measured: scan.speed_measured,
            })
        })
    }

    // The work.

    /// Scans a root on a job, as work the owner asked for: walks it, identifies formats, reads
    /// media details and hashes what could be a duplicate. Background analysis is not part of it:
    /// the report's `follow_up` says when it is due, for
    /// [`TidyEngine::start_background_analysis`], so it runs as a job of its own, as
    /// glazier-core queues it. Cancelling the job stops it between files and kills a running
    /// ffprobe; pausing it waits between folders and files.
    pub fn start_scan_only(&self, root_id: RootId, cx: &mut App) -> Entity<Job<ScanReport>> {
        let engine = self.clone();
        Job::start("Scanning", cx, move |reporter: JobReporter| {
            on_thread("tidy scan", move || {
                engine.scan_blocking(root_id, &reporter)
            })
        })
    }

    /// [`TidyEngine::start_scan_only`], then the background analysis it calls for, on the same
    /// job: the analysis takes a background turn, so it steps aside for asked-for work, and the
    /// job's progress says background meanwhile. Glazier-core's two jobs as one, for a caller
    /// that tracks one job per scan; the report carries the analysis and no follow-up.
    pub fn start_scan(&self, root_id: RootId, cx: &mut App) -> Entity<Job<ScanReport>> {
        let engine = self.clone();
        Job::start("Scanning", cx, move |reporter: JobReporter| {
            on_thread("tidy scan", move || {
                let mut report = engine.scan_blocking(root_id, &reporter)?;
                for root_id in std::mem::take(&mut report.follow_up).analyze {
                    report.analysis = Some(engine.catch_up_blocking(root_id, &reporter)?);
                }
                Ok(report)
            })
        })
    }

    /// Analyses a root on a job as work the owner asked for ("Check now"), as glazier-core's
    /// similar and sound jobs do: fingerprints, the detail prints Spot variants needs, and
    /// loudness. Results are kept per file, so a stopped analysis goes on where it left off.
    pub fn start_analysis(&self, root_id: RootId, cx: &mut App) -> Entity<Job<AnalysisReport>> {
        self.start_analysis_with(root_id, AnalysisStart::AskedFor, cx)
    }

    /// [`TidyEngine::start_analysis`] in the background, as glazier-core queues it after a scan,
    /// a change or a settings change: it runs only while no asked-for work waits, steps aside
    /// when some arrives (its progress says it waits), and goes on after.
    pub fn start_background_analysis(
        &self,
        root_id: RootId,
        cx: &mut App,
    ) -> Entity<Job<AnalysisReport>> {
        self.start_analysis_with(root_id, AnalysisStart::AfterChange, cx)
    }

    /// [`TidyEngine::start_background_analysis`] when Tidy starts or a scan ends, the times it asks
    /// again about pairs it could not read. After every decision a damaged file would ask each time.
    pub fn start_catch_up_analysis(
        &self,
        root_id: RootId,
        cx: &mut App,
    ) -> Entity<Job<AnalysisReport>> {
        self.start_analysis_with(root_id, AnalysisStart::CatchingUp, cx)
    }

    fn start_analysis_with(
        &self,
        root_id: RootId,
        start: AnalysisStart,
        cx: &mut App,
    ) -> Entity<Job<AnalysisReport>> {
        let engine = self.clone();
        Job::start(
            "Finding similar versions",
            cx,
            move |reporter: JobReporter| {
                on_thread("tidy analysis", move || {
                    engine.analyze_with(root_id, start, &reporter)
                })
            },
        )
    }

    /// Makes background analysis of a root that waits, runs or stepped aside into asked-for
    /// work, as "Check now" does while one is queued; says whether there was any. Its job carries
    /// on as it was, now no longer stepping aside (its progress stops saying background).
    pub fn promote_analysis(&self, root_id: RootId) -> bool {
        self.inner.scheduler.promote(root_id)
    }

    /// How many jobs wait for their turn, for the job card's "2 more queued".
    pub fn queued_jobs(&self) -> usize {
        self.inner.scheduler.waiting()
    }

    /// [`TidyEngine::start_scan`]'s work, on the calling thread. Never call it from an executor.
    pub fn scan_blocking(
        &self,
        root_id: RootId,
        progress: &dyn Progress,
    ) -> anyhow::Result<ScanReport> {
        let inner = &self.inner;
        let turn = inner
            .scheduler
            .take_turn(Priority::AskedFor, vec![root_id], progress)?;
        let progress: &dyn Progress = &turn;
        // However the scan ends, what was cached before it is stale.
        let _changed = ChangedOnDrop(inner);
        let root = inner
            .catalog
            .blocking(move |connection| find_root(connection, root_id))?
            .context("That root is no longer configured.")?;
        let root_path = PathBuf::from(&root.path);
        if !inner.data.admits_tidy_root(&root_path) {
            bail!(
                "{} is outside Tidy's sandbox, so Tidy does not scan it.",
                root.path
            );
        }
        if !root_path.is_dir() {
            bail!("{} is not available. Is its drive connected?", root.path);
        }
        let scan_id = {
            let mut counter = inner
                .scan_counter
                .lock()
                .unwrap_or_else(PoisonError::into_inner);
            *counter = now_ms().max(*counter + 1);
            *counter
        };

        let walking = format!("Walking {}", root.name);
        progress.phase(&walking, 0);
        let catalog = inner.catalog.clone();
        let summary = walk_root(
            &root_path,
            |batch| {
                catalog.blocking(move |connection| {
                    upsert_walked_files(connection, root_id, scan_id, &batch)
                })
            },
            |files, _| progress.done(files as u64),
            || progress.checkpoint(),
        )?;
        let empty = summary.empty_folders.clone();
        let removed = inner.catalog.blocking(move |connection| {
            let removed = delete_unseen_files(connection, root_id, scan_id)?;
            replace_empty_folders(connection, root_id, &empty)?;
            Ok(removed)
        })?;
        // A file whose bytes changed lost its fingerprint in the walk.
        inner.fingerprints_changed();
        inner.changed();

        let pass = inner.pass_context(Some(root_id), progress);
        run_sniff_pass(&pass)?;
        run_probe_pass(&pass)?;
        inner.changed();
        run_hash_pass(&pass)?;
        inner
            .catalog
            .blocking(move |connection| mark_scanned(connection, root_id))?;
        inner.changed();

        Ok(ScanReport {
            files: summary.files,
            empty_folders: summary.empty_folders.len(),
            skipped_entries: summary.skipped_entries,
            removed,
            analysis: None,
            follow_up: FollowUp {
                rescan: Vec::new(),
                analyze: if inner.analysis_due(root_id)? {
                    vec![root_id]
                } else {
                    Vec::new()
                },
            },
        })
    }

    /// [`TidyEngine::start_analysis`]'s work, on the calling thread. Never call it from an
    /// executor.
    pub fn analyze_blocking(
        &self,
        root_id: RootId,
        progress: &dyn Progress,
    ) -> anyhow::Result<AnalysisReport> {
        self.analyze_with(root_id, AnalysisStart::AskedFor, progress)
    }

    /// [`TidyEngine::start_background_analysis`]'s work, on the calling thread.
    pub fn analyze_in_background_blocking(
        &self,
        root_id: RootId,
        progress: &dyn Progress,
    ) -> anyhow::Result<AnalysisReport> {
        self.analyze_with(root_id, AnalysisStart::AfterChange, progress)
    }

    /// [`TidyEngine::start_catch_up_analysis`]'s work, on the calling thread.
    pub fn catch_up_blocking(
        &self,
        root_id: RootId,
        progress: &dyn Progress,
    ) -> anyhow::Result<AnalysisReport> {
        self.analyze_with(root_id, AnalysisStart::CatchingUp, progress)
    }

    fn analyze_with(
        &self,
        root_id: RootId,
        start: AnalysisStart,
        progress: &dyn Progress,
    ) -> anyhow::Result<AnalysisReport> {
        let priority = match start {
            AnalysisStart::AskedFor => Priority::AskedFor,
            AnalysisStart::AfterChange | AnalysisStart::CatchingUp => Priority::Background,
        };
        let turn = self
            .inner
            .scheduler
            .take_turn(priority, vec![root_id], progress)?;
        // Paused while it waited for its turn, it waits before it starts.
        turn.checkpoint()?;
        if start != AnalysisStart::AskedFor {
            let inner = self.inner.clone();
            let due = self.inner.catalog.blocking(move |connection| match start {
                AnalysisStart::CatchingUp => inner.analysis_due_in(connection, root_id),
                _ => inner.analysis_left_in(connection, root_id),
            })?;
            if !due {
                return Ok(AnalysisReport::default());
            }
        }
        self.analyze_locked(root_id, &turn)
    }

    fn analyze_locked(
        &self,
        root_id: RootId,
        progress: &dyn Progress,
    ) -> anyhow::Result<AnalysisReport> {
        let inner = &self.inner;
        let (fingerprints, soundtracks) = inner.catalog.blocking(move |connection| {
            Ok((
                pending_fingerprints(connection, root_id)?,
                pending_loudness(connection, root_id)?,
            ))
        })?;
        let pass = inner.pass_context(Some(root_id), progress);
        let outcome = (|| -> anyhow::Result<usize> {
            run_fingerprint_pass(&pass)?;
            inner.fingerprints_changed();
            inner.changed();
            // Spot variants compares the stills of the sets those fingerprints made.
            let this = self.inner.clone();
            let stills: Vec<FileId> = inner.catalog.blocking(move |connection| {
                let settings = read_settings(connection)?;
                // Before the stills are worked out: sets whose prints all failed count as variants,
                // whose stills are not offered for prints, so they would never be asked again.
                if this.media.loaded_vips().is_some() {
                    forget_unread(connection, root_id)?;
                }
                this.changed();
                if !settings.spot_variants {
                    return Ok(Vec::new());
                }
                forget_outdated_details(connection, root_id)?;
                this.changed();
                let sets = this.duplicate_sets(connection, Some(root_id), settings.similarity)?;
                Ok(stills_to_print(&sets, &Dismissals::load(connection)?))
            })?;
            if !stills.is_empty() {
                run_detail_pass(&pass, &stills)?;
            }
            inner.changed();
            self.compare_closer(root_id, &pass)?;
            run_loudness_pass(&pass)?;
            Ok(stills.len())
        })();
        // A stopped fingerprint pass wrote some too.
        inner.fingerprints_changed();
        inner.changed();
        // The decodes' buffers would otherwise stay with the process, a gigabyte after the
        // 21k fixture.
        release_free_memory();
        Ok(AnalysisReport {
            fingerprints,
            detail_candidates: outcome?,
            soundtracks,
        })
    }

    /// Takes a closer look at the pairs that are waiting for one. Each answer can make a version
    /// join a picture rather than head one, which changes what the versions after it meet, so
    /// this goes round until nothing waits. Every read stores an answer, even one that fails, so
    /// the same pairs asked twice can only mean their files keep changing, and those wait for the
    /// analysis the change calls for.
    fn compare_closer(&self, root_id: RootId, pass: &PassContext<'_>) -> anyhow::Result<()> {
        let mut asked = Vec::new();
        loop {
            let this = self.inner.clone();
            let pairs: Vec<(FileId, FileId)> = self.inner.catalog.blocking(move |connection| {
                let settings = read_settings(connection)?;
                let sets = this.duplicate_sets(connection, Some(root_id), settings.similarity)?;
                Ok(pairs_to_compare(&sets, &Dismissals::load(connection)?))
            })?;
            if pairs.is_empty() || pairs == asked {
                return Ok(());
            }
            run_comparison_pass(pass, &pairs)?;
            self.inner.changed();
            asked = pairs;
        }
    }
}

/// Why an analysis is starting, which says whether it has anything to do.
#[derive(Clone, Copy, PartialEq, Eq)]
enum AnalysisStart {
    /// The owner asked: it runs.
    AskedFor,
    /// A change or a setting: in the background, when work is left.
    AfterChange,
    /// Tidy started or a scan ended: in the background, when analysis is due, which also asks again
    /// about pairs it could not read.
    CatchingUp,
}

/// Marks the catalog changed when dropped, so a scan stopped halfway leaves nothing stale cached.
struct ChangedOnDrop<'a>(&'a Inner);

impl Drop for ChangedOnDrop<'_> {
    fn drop(&mut self) {
        self.0.changed();
    }
}

impl Inner {
    fn changed(&self) {
        self.generation.fetch_add(1, Ordering::AcqRel);
    }

    fn fingerprints_changed(&self) {
        self.fingerprints.fetch_add(1, Ordering::AcqRel);
    }

    /// Whether glazier-core's `queueAnalysis` would queue analysis of a root: background analysis
    /// is on, and files need fingerprints, or loudness when ffmpeg is there to measure it, or sets
    /// are held until Spot variants has compared them, since an older version made their prints
    /// or the analysis that was comparing them stopped.
    fn analysis_due_in(&self, connection: &Connection, root_id: RootId) -> anyhow::Result<bool> {
        if !read_settings(connection)?.auto_analyze {
            return Ok(false);
        }
        // Answers a pair got only because it could not be read count here, when Tidy starts or a
        // scan ends, but not after each decision, where a damaged file would ask every time.
        Ok(self.analysis_left_in(connection, root_id)?
            || (answers_wait_to_be_read(connection, root_id)?
                && self.media.loaded_vips().is_some()))
    }

    /// Whether an analysis of a root would find anything to do: every decision starts one in the
    /// background, and one with nothing to do would still have every page read the catalog again.
    fn analysis_left_in(&self, connection: &Connection, root_id: RootId) -> anyhow::Result<bool> {
        let settings = read_settings(connection)?;
        let has_ffmpeg = self.media.ffmpeg.is_some();
        if pending_fingerprints(connection, root_id)? > 0
            || (has_ffmpeg && pending_loudness(connection, root_id)? > 0)
        {
            return Ok(true);
        }
        if settings.spot_variants
            && prints_wait_for_libvips(connection)?
            && self.media.loaded_vips().is_some()
        {
            return Ok(true);
        }
        let sets = self.duplicate_sets(connection, Some(root_id), settings.similarity)?;
        Ok(checking_sets(&sets, &Dismissals::load(connection)?))
    }

    fn analysis_due(self: &Arc<Self>, root_id: RootId) -> anyhow::Result<bool> {
        let this = self.clone();
        self.catalog
            .blocking(move |connection| this.analysis_due_in(connection, root_id))
    }

    /// The similar clusters under a root at a level, cached while no fingerprint changed.
    fn similar_clusters(
        &self,
        connection: &Connection,
        root_id: Option<RootId>,
        level: SimilarityLevel,
    ) -> anyhow::Result<Arc<Vec<SimilarCluster>>> {
        let fingerprints = self.fingerprints.load(Ordering::Acquire);
        let key = (root_id, level);
        let mut cache = self.clusters.lock().unwrap_or_else(PoisonError::into_inner);
        cache.retain(|_, cached| cached.fingerprints == fingerprints);
        if let Some(cached) = cache.get(&key) {
            return Ok(cached.clusters.clone());
        }
        drop(cache);
        let clusters = Arc::new(compute_similar_clusters(connection, root_id, level)?);
        // Fingerprints written while these were compared make them stale at once.
        if self.fingerprints.load(Ordering::Acquire) == fingerprints {
            self.clusters
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .insert(
                    key,
                    ClusterCache {
                        fingerprints,
                        clusters: clusters.clone(),
                    },
                );
        }
        Ok(clusters)
    }

    fn pass_context<'a>(
        &'a self,
        root_id: Option<RootId>,
        progress: &'a dyn Progress,
    ) -> PassContext<'a> {
        PassContext {
            catalog: &self.catalog,
            media: &self.media,
            root_id,
            progress,
        }
    }

    /// The duplicate sets under a root at a level, before dismissals, cached while the catalog
    /// stays as it is.
    fn duplicate_sets(
        &self,
        connection: &Connection,
        root_id: Option<RootId>,
        level: SimilarityLevel,
    ) -> anyhow::Result<Arc<Vec<ComputedSet>>> {
        let generation = self.generation.load(Ordering::Acquire);
        if let Some(cached) = self
            .sets
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .as_ref()
            .filter(|cached| {
                cached.generation == generation
                    && cached.root_id == root_id
                    && cached.level == level
            })
        {
            return Ok(cached.sets.clone());
        }
        let settings = read_settings(connection)?;
        let clusters = self.similar_clusters(connection, root_id, level)?;
        let sets = Arc::new(build_duplicate_sets(
            connection, root_id, &settings, &clusters,
        )?);
        if self.generation.load(Ordering::Acquire) == generation {
            *self.sets.lock().unwrap_or_else(PoisonError::into_inner) = Some(SetCache {
                generation,
                root_id,
                level,
                sets: sets.clone(),
            });
        }
        Ok(sets)
    }

    /// The files the open duplicate sets' suggestions would remove. Convert and Shrink would save
    /// on these too, but the duplicates' totals count them whole, so savings shown beside those
    /// totals must not count them again.
    fn removable_copies(
        &self,
        connection: &Connection,
        root_id: RootId,
    ) -> anyhow::Result<HashSet<FileId>> {
        let settings = read_settings(connection)?;
        let sets = self.duplicate_sets(connection, Some(root_id), settings.similarity)?;
        let dismissals = Dismissals::load(connection)?;
        Ok(open_sets(&sets, &dismissals, DuplicateScope::All)
            .into_iter()
            .flat_map(|entry| entry.removable.iter().copied())
            .collect())
    }

    /// Where the catalog stands now, for [`Kept`] results.
    fn catalog_state(&self, connection: &Connection) -> anyhow::Result<CatalogState> {
        Ok(CatalogState {
            changes: connection.total_changes(),
            data_version: connection.query_row("PRAGMA data_version", [], |row| row.get(0))?,
            generation: self.generation.load(Ordering::Acquire),
            fingerprints: self.fingerprints.load(Ordering::Acquire),
        })
    }

    /// The result `make` gives for `key`, made again only when the catalog changed since it was
    /// last made. One made while the engine's counters moved is not kept.
    fn kept<K: std::hash::Hash + Eq, T: Clone>(
        &self,
        cache: &Mutex<HashMap<K, Kept<T>>>,
        key: K,
        connection: &mut Connection,
        make: impl FnOnce(&mut Connection) -> anyhow::Result<T>,
    ) -> anyhow::Result<T> {
        let before = self.catalog_state(connection)?;
        if let Some(kept) = cache
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .get(&key)
            .filter(|kept| kept.state == before)
        {
            return Ok(kept.value.clone());
        }
        let value = make(connection)?;
        let after = self.catalog_state(connection)?;
        if (after.data_version, after.generation, after.fingerprints)
            == (before.data_version, before.generation, before.fingerprints)
        {
            cache.lock().unwrap_or_else(PoisonError::into_inner).insert(
                key,
                Kept {
                    state: after,
                    value: value.clone(),
                },
            );
        }
        Ok(value)
    }

    /// Convert's candidates under a root, recorded as the Library's convertible files.
    fn candidates(
        &self,
        connection: &mut Connection,
        root_id: RootId,
    ) -> anyhow::Result<CandidateScan> {
        let scan = find_optimize_candidates(connection, root_id)?;
        let ids: Vec<FileId> = scan.candidates.iter().map(|c| c.record.id).collect();
        record_convertible(connection, root_id, &ids)?;
        // The Library's convertible files are these until the catalog changes.
        let state = self.catalog_state(connection)?;
        self.convertible
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .insert(root_id, Kept { state, value: () });
        Ok(scan)
    }

    fn shrink_scan(&self, connection: &Connection, root_id: RootId) -> anyhow::Result<ShrinkScan> {
        find_shrink_candidates(connection, root_id)
    }

    /// Records the convertible files of a root (or every root) for Library queries.
    fn prepare_convertible(
        &self,
        connection: &mut Connection,
        root_id: Option<RootId>,
    ) -> anyhow::Result<()> {
        let roots = match root_id {
            Some(root_id) => vec![root_id],
            None => list_roots(connection)?.iter().map(|root| root.id).collect(),
        };
        for root_id in roots {
            self.kept(&self.convertible, root_id, connection, |connection| {
                self.candidates(connection, root_id).map(drop)
            })?;
        }
        Ok(())
    }

    fn overview(&self, connection: &mut Connection, root_id: RootId) -> anyhow::Result<Tidy> {
        self.kept(&self.overviews, root_id, connection, |connection| {
            self.make_overview(connection, root_id)
        })
    }

    fn make_overview(&self, connection: &mut Connection, root_id: RootId) -> anyhow::Result<Tidy> {
        let settings = read_settings(connection)?;
        let sets = self.duplicate_sets(connection, Some(root_id), settings.similarity)?;
        let open = open_sets(&sets, &Dismissals::load(connection)?, DuplicateScope::All);
        let removable = self.removable_copies(connection, root_id)?;
        let scan = self.candidates(connection, root_id)?;
        let catalog = catalog_tidy(connection, root_id)?;
        let shrink = self.shrink_scan(connection, root_id)?;
        let extensions = extension_fixes(connection, root_id, &scan.candidates)?.len() as i64;
        Ok(Tidy {
            files: catalog.files,
            bytes: catalog.bytes,
            last_scan_at: catalog.last_scan_at,
            duplicates: DuplicateTotalsByKind {
                exact: duplicate_totals(
                    open.iter()
                        .copied()
                        .filter(|entry| entry.set.kind == DuplicateKind::Exact),
                ),
                similar: duplicate_totals(
                    open.iter()
                        .copied()
                        .filter(|entry| entry.set.kind == DuplicateKind::Similar),
                ),
            },
            convert: summarize_candidates(&scan, &removable),
            shrink: shrink.totals(&removable),
            silent_tracks: catalog.silent_tracks,
            cleanup: CleanupCounts {
                junk: catalog.junk,
                empty_folders: catalog.empty_folders,
                extensions,
            },
            attention: catalog.attention,
            analysis: catalog.analysis,
        })
    }
}
