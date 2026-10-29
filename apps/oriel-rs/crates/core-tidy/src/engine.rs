//! The engine the Tidy UI talks to, after glazier-core's `engine/engine.ts`: its roots and
//! settings, the scan and the analysis as `oriel-runtime` jobs, the queries behind Overview,
//! the Library and Duplicates, and (in [`changes`]) every change to the archive with its history
//! and holding.
//!
//! The work itself is synchronous and runs on a thread of its own, its passes on worker threads
//! below it; the catalog's calls go to the catalog's SQLite thread. Jobs report their phase and
//! how far it has got through [`Job`]'s progress, which is what the shell's "Working" dot
//! follows: the UI forwards it, the engine never touches the shell. One piece of work runs at a
//! time, as glazier-core's queue runs one job at a time, so a scan and an analysis of one root
//! never interleave.

mod changes;

pub use changes::{
    Applied, FollowUp, FollowUpReport, Performed, TidiedUp, Undone, still_concurrency,
};

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock, PoisonError};

use anyhow::{Context as _, bail};
use futures::channel::oneshot;
use gpui_kit::{App, Entity};
use oriel_core_paths::DataRoot;
use oriel_runtime::{Job, JobReporter};
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
    CleanupCounts, DuplicateKind, DuplicateScope, DuplicateSetPage, DuplicateSetRequest,
    DuplicateTotalsByKind, FileFacets, FileFilter, FileId, FileIdList, FilePage, FileQuery,
    FileRow, OptimizeSummary, Root, RootId, SelectionSummary, Settings, ShrinkSummary,
    SimilarityLevel, Tidy,
};
use crate::duplicates::{
    ComputedSet, Dismissals, PageRequest, add_dismissal, build_duplicate_sets,
    compute_similar_clusters, duplicate_totals, fingerprint_coverage, open_sets,
    page_duplicate_sets, remove_dismissal,
};
use crate::optimize::candidates::skip_counts;
use crate::optimize::{
    CandidateHolds, CandidateScan, ShrinkScan, extension_fixes, find_optimize_candidates,
    find_shrink_candidates, summarize_candidates,
};
use crate::passes::detail::run_detail_pass;
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
    /// The analysis that followed, when background analysis is on.
    pub analysis: Option<AnalysisReport>,
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

struct Inner {
    catalog: Catalog,
    data: DataRoot,
    media: Media,
    /// One piece of work at a time.
    work: Mutex<()>,
    scan_counter: Mutex<i64>,
    /// Bumped whenever the engine changes the catalog, so a cached result computed across a
    /// change is not kept.
    generation: AtomicU64,
    sets: Mutex<Option<SetCache>>,
    /// Where each root's held files go.
    places: crate::plans::holding::HoldingPlaces,
    /// Whether the pinned ffmpeg has SVT-AV1, asked once.
    svt_av1: OnceLock<bool>,
    /// Convert's estimates per root and category, kept while the category holds the same files.
    estimates: Mutex<HashMap<(RootId, crate::contract::OptimizeCategory), changes::CachedEstimate>>,
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
    /// out, with a warning, and the passes that need it wait.
    pub fn locate() -> Media {
        let vips = match Vips::open_located() {
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
        Ok(Self {
            inner: Arc::new(Inner {
                catalog,
                data,
                media,
                work: Mutex::new(()),
                scan_counter: Mutex::new(now_ms()),
                generation: AtomicU64::new(0),
                sets: Mutex::new(None),
                places: crate::plans::holding::HoldingPlaces::new(data_dir),
                svt_av1: OnceLock::new(),
                estimates: Mutex::new(HashMap::new()),
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

    /// Adds a folder as a root, refusing one outside Tidy's sandbox or overlapping another root.
    /// Scanning it is the caller's next step ([`TidyEngine::start_scan`]).
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

    /// Forgets a root and its catalog rows. Files on disk are untouched.
    pub fn remove_root(
        &self,
        root_id: RootId,
    ) -> impl Future<Output = anyhow::Result<Vec<Root>>> + Send + 'static {
        self.query(move |inner, connection| {
            remove_root(connection, root_id)?;
            inner.changed();
            list_roots(connection)
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
            let new_sets = !before.spot_variants || before.similarity != settings.similarity;
            let analyze = (settings.auto_analyze && !before.auto_analyze)
                || (settings.spot_variants && new_sets);
            Ok(SettingsUpdate { settings, analyze })
        })
    }

    // Overview, the Library and Duplicates.

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
        self.query(move |_, connection| compute_similar_clusters(connection, root_id, level))
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

    /// What Convert would change under a root.
    pub fn optimize_summary(
        &self,
        root_id: RootId,
    ) -> impl Future<Output = anyhow::Result<OptimizeSummary>> + Send + 'static {
        self.query(move |inner, connection| {
            Ok(summarize_candidates(
                &inner.candidates(connection, root_id)?,
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

    /// Scans a root on a job: walks it, identifies formats, reads media details and hashes what
    /// could be a duplicate, then, with background analysis on, fingerprints, compares similar
    /// stills for Spot variants and measures soundtracks. Cancelling the job stops it between
    /// files and kills a running ffmpeg.
    pub fn start_scan(&self, root_id: RootId, cx: &mut App) -> Entity<Job<ScanReport>> {
        let engine = self.clone();
        Job::start("Scanning", cx, move |reporter: JobReporter| {
            on_thread("tidy scan", move || {
                engine.scan_blocking(root_id, &reporter)
            })
        })
    }

    /// Analyses a root on a job, as glazier-core's similar and sound jobs do: fingerprints, the
    /// detail prints Spot variants needs, and loudness.
    pub fn start_analysis(&self, root_id: RootId, cx: &mut App) -> Entity<Job<AnalysisReport>> {
        let engine = self.clone();
        Job::start(
            "Finding similar versions",
            cx,
            move |reporter: JobReporter| {
                on_thread("tidy analysis", move || {
                    engine.analyze_blocking(root_id, &reporter)
                })
            },
        )
    }

    /// [`TidyEngine::start_scan`]'s work, on the calling thread. Never call it from an executor.
    pub fn scan_blocking(
        &self,
        root_id: RootId,
        progress: &dyn Progress,
    ) -> anyhow::Result<ScanReport> {
        let inner = &self.inner;
        let _work = inner.work.lock().unwrap_or_else(PoisonError::into_inner);
        // However the scan ends, what was cached before it is stale.
        let _changed = ChangedOnDrop(inner);
        progress.check()?;
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
            || progress.check(),
        )?;
        let empty = summary.empty_folders.clone();
        let removed = inner.catalog.blocking(move |connection| {
            let removed = delete_unseen_files(connection, root_id, scan_id)?;
            replace_empty_folders(connection, root_id, &empty)?;
            Ok(removed)
        })?;
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

        let settings = inner
            .catalog
            .blocking(|connection| read_settings(connection))?;
        let analysis = if settings.auto_analyze {
            Some(self.analyze_locked(root_id, progress)?)
        } else {
            None
        };
        Ok(ScanReport {
            files: summary.files,
            empty_folders: summary.empty_folders.len(),
            skipped_entries: summary.skipped_entries,
            removed,
            analysis,
        })
    }

    /// [`TidyEngine::start_analysis`]'s work, on the calling thread. Never call it from an
    /// executor.
    pub fn analyze_blocking(
        &self,
        root_id: RootId,
        progress: &dyn Progress,
    ) -> anyhow::Result<AnalysisReport> {
        let _work = self
            .inner
            .work
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        progress.check()?;
        self.analyze_locked(root_id, progress)
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
            inner.changed();
            // Spot variants compares the stills of the sets those fingerprints made.
            let this = self.inner.clone();
            let stills: Vec<FileId> = inner.catalog.blocking(move |connection| {
                let settings = read_settings(connection)?;
                if !settings.spot_variants {
                    return Ok(Vec::new());
                }
                let sets = this.duplicate_sets(connection, Some(root_id), settings.similarity)?;
                let dismissals = Dismissals::load(connection)?;
                Ok(open_sets(&sets, &dismissals, DuplicateScope::All)
                    .into_iter()
                    .filter(|entry| entry.set.kind == DuplicateKind::Similar)
                    .flat_map(|entry| entry.file_ids.iter().copied())
                    .collect())
            })?;
            if !stills.is_empty() {
                run_detail_pass(&pass, &stills)?;
            }
            inner.changed();
            run_loudness_pass(&pass)?;
            Ok(stills.len())
        })();
        inner.changed();
        Ok(AnalysisReport {
            fingerprints,
            detail_candidates: outcome?,
            soundtracks,
        })
    }
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
        let clusters = compute_similar_clusters(connection, root_id, level)?;
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

    /// What Convert and Shrink leave alone for now: members of open similar sets at the current
    /// level, and, while background analysis will check them, files not yet fingerprinted.
    fn candidate_holds(
        &self,
        connection: &Connection,
        root_id: RootId,
    ) -> anyhow::Result<CandidateHolds> {
        let settings = read_settings(connection)?;
        let sets = self.duplicate_sets(connection, Some(root_id), settings.similarity)?;
        let similar = open_sets(
            &sets,
            &Dismissals::load(connection)?,
            DuplicateScope::Similar,
        );
        Ok(CandidateHolds {
            reviewing: similar
                .iter()
                .flat_map(|entry| entry.file_ids.iter().copied())
                .collect(),
            wait_for_fingerprints: settings.auto_analyze,
        })
    }

    fn candidates(
        &self,
        connection: &mut Connection,
        root_id: RootId,
    ) -> anyhow::Result<CandidateScan> {
        let holds = self.candidate_holds(connection, root_id)?;
        let scan = find_optimize_candidates(connection, root_id, &holds)?;
        let ids: Vec<FileId> = scan.candidates.iter().map(|c| c.record.id).collect();
        record_convertible(connection, root_id, &ids)?;
        Ok(scan)
    }

    fn shrink_scan(&self, connection: &Connection, root_id: RootId) -> anyhow::Result<ShrinkScan> {
        let holds = self.candidate_holds(connection, root_id)?;
        find_shrink_candidates(connection, root_id, &holds)
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
            self.candidates(connection, root_id)?;
        }
        Ok(())
    }

    fn overview(&self, connection: &mut Connection, root_id: RootId) -> anyhow::Result<Tidy> {
        let settings = read_settings(connection)?;
        let sets = self.duplicate_sets(connection, Some(root_id), settings.similarity)?;
        let open = open_sets(&sets, &Dismissals::load(connection)?, DuplicateScope::All);
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
            convert: summarize_candidates(&scan),
            shrink: shrink.totals(),
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
