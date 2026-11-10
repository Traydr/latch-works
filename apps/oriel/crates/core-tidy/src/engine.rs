//! The engine the Tidy UI talks to: its roots and settings, the queries behind Overview, the
//! Library and Duplicates, the scan and the analysis, and (in [`changes`]) every change to the
//! archive with its history and holding.
//!
//! Work is blocking: each operation runs on the caller's thread, its passes on worker threads
//! below it, and reports through a [`Progress`]; the catalog's calls go to the catalog's SQLite
//! thread. Queries return futures and never wait for the queue.
//!
//! One piece of work runs at a time (see [`schedule`]): scans, changes and analysis the owner
//! asked for run in the order asked, and background analysis runs behind them, stepping aside
//! when such work arrives and carrying on after. A piece of work is paused through its
//! progress's pause token and stopped through its cancel token.

mod changes;
mod schedule;

pub use changes::{
    Applied, FollowUp, FollowUpReport, Performed, PlanFailed, Restored, TidiedUp, TidyStep, Undone,
};

use schedule::{Priority, Scheduler};

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock, PoisonError};

use anyhow::{Context as _, bail};
use futures::channel::oneshot;
use oriel_core_paths::DataRoot;
use oriel_runtime::release_free_memory;
use rusqlite::Connection;

use crate::catalog::details::{
    answers_wait_to_be_read, forget_outdated_details, forget_unread, prints_wait_for_libvips,
};
use crate::catalog::files::{
    delete_unseen_files, file_facets, get_file_records, list_empty_folders, list_file_ids,
    list_files, list_folders, record_convertible, replace_empty_folders, roots_of_files,
    selection_summary, upsert_walked_files,
};
use crate::catalog::roots::{
    add_root, find_root, list_roots, mark_scanned, read_settings, remove_root, resolve_root_folder,
    write_settings,
};
use crate::catalog::state::{CatalogState, ScratchWrites, print_generation, prints_changed};
use crate::catalog::tidy::catalog_tidy;
use crate::catalog::{Catalog, now_ms};
use crate::contract::{
    CleanupCounts, DuplicateDismissal, DuplicateKind, DuplicateScope, DuplicateSetPage,
    DuplicateSetRequest, DuplicateTotalsByKind, FileFacets, FileFilter, FileFlag, FileId,
    FileIdList, FilePage, FileQuery, FileRow, OptimizeSummary, Root, RootId, SelectionSummary,
    Settings, ShrinkSummary, SimilarityLevel, Tidy,
};
use crate::duplicates::{
    ComputedSet, Dismissals, PageRequest, add_dismissal, build_duplicate_sets, checking_sets,
    compute_similar_clusters, duplicate_totals, fingerprint_coverage, list_dismissals, open_sets,
    page_duplicate_sets, pairs_to_compare, remove_dismissal, stills_to_print,
};
use crate::optimize::candidates::skip_counts;
use crate::optimize::{
    CandidateScan, extension_fixes, find_optimize_candidates, find_shrink_candidates,
    summarize_candidates,
};
use crate::passes::detail::{run_comparison_pass, run_detail_pass};
use crate::passes::fingerprint::{pending_fingerprints, run_fingerprint_pass};
use crate::passes::hash::run_hash_pass;
use crate::passes::loudness::{pending_loudness, run_loudness_pass};
use crate::passes::probe::run_probe_pass;
use crate::passes::sniff::run_sniff_pass;
use crate::passes::{Media, PassContext, Progress};
use crate::scan::walk_root;
use crate::similarity::SimilarCluster;

/// Work the engine has queued, in the order it was asked for, to run on a thread of the
/// caller's with [`Queued::run`]. Dropped unrun, it leaves the queue.
#[must_use = "dropping queued work takes it off the queue"]
pub struct Queued<T>(QueuedWork<T>);

type Work<T> = Box<dyn FnOnce(&dyn Progress) -> anyhow::Result<T> + Send>;

enum QueuedWork<T> {
    Done(T),
    Work(Work<T>),
}

impl<T> Queued<T> {
    fn done(value: T) -> Self {
        Self(QueuedWork::Done(value))
    }

    fn work(work: impl FnOnce(&dyn Progress) -> anyhow::Result<T> + Send + 'static) -> Self {
        Self(QueuedWork::Work(Box::new(work)))
    }

    /// Waits for its turn and does the work on the calling thread, reporting to `progress` and
    /// stopping or pausing as its tokens say. Never call it from an executor.
    pub fn run(self, progress: &dyn Progress) -> anyhow::Result<T> {
        match self.0 {
            QueuedWork::Done(value) => Ok(value),
            QueuedWork::Work(work) => work(progress),
        }
    }
}

/// Why an operation on a root that has been forgotten fails.
const NO_ROOT: &str = "That root is no longer configured.";

/// Tiles Shrink shows for the batch that runs next.
const SHRINK_PREVIEW_ROWS: usize = 60;

/// What a scan did.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct ScanReport {
    pub files: usize,
    pub empty_folders: usize,
    /// Symlinks and other non-regular entries, never followed.
    pub skipped_entries: usize,
    /// Files the catalog had that the walk did not see again.
    pub removed: usize,
    /// Background analysis is due after the scan (background analysis on, and files that need
    /// fingerprints or loudness, or pairs it could not read), for the caller to run with
    /// [`AnalysisKind::CatchingUp`].
    pub analysis_due: bool,
}

/// What an analysis did.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct AnalysisReport {
    /// Files that needed a fingerprint when it started.
    pub fingerprints: i64,
    /// Stills of similar sets offered to the detail pass, with Spot variants on.
    pub detail_candidates: usize,
    /// Videos whose soundtrack needed measuring when it started.
    pub soundtracks: i64,
}

/// Why an analysis runs, which says when it runs and whether it has anything to do.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum AnalysisKind {
    /// After a change or a setting: in the background, when work is left.
    AfterChange,
    /// Tidy started or a scan ended: in the background, when analysis is due, which also asks
    /// again about pairs it could not read. It does all [`Self::AfterChange`] does.
    CatchingUp,
    /// The owner asked ("Check now"): it runs, as asked-for work.
    AskedFor,
}

/// Scans and background analyses waiting for their turn, so asking again for one that waits
/// joins it rather than queueing another.
#[derive(Default)]
struct Waiting {
    scans: HashSet<RootId>,
    analyses: HashMap<RootId, AnalysisKind>,
}

/// Settings after a change, and whether the roots need analysing again for it: background
/// analysis turned on, or Spot variants or the similarity level changed, which makes new sets.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SettingsUpdate {
    pub settings: Settings,
    pub analyze: bool,
}

/// Duplicate sets as last computed, kept while nothing in the catalog changed.
struct SetCache {
    state: CatalogState,
    root_id: Option<RootId>,
    level: SimilarityLevel,
    sets: Arc<Vec<ComputedSet>>,
}

/// Similar clusters as last computed for a root and level, kept while no print was made or
/// dropped for good (see [`crate::catalog::state`]): a file resolved away since simply drops out
/// of its cluster when sets are built. This is not only speed: a set a Convert is rewriting stays
/// one set through the change, its files' prints being gone until the analysis after it, where
/// clusters made afresh would break it up under the owner.
struct ClusterCache {
    prints: (i64, i64),
    clusters: Arc<Vec<SimilarCluster>>,
}

/// The roots whose convertible files a Library query reads.
enum LibraryRoots<'a> {
    /// None: the query neither filters nor counts by them.
    Unread,
    /// A root's, or every root's.
    Root(Option<RootId>),
    /// Those of the roots these files are in.
    OfFiles(&'a [FileId]),
}

impl LibraryRoots<'_> {
    fn filtered_by(filter: &FileFilter) -> Self {
        if filter.flags.contains(&FileFlag::Convertible) {
            Self::Root(filter.root_id)
        } else {
            Self::Unread
        }
    }
}

/// A result worked out from the catalog alone, kept with the state the catalog was in once it
/// was made, for as long as the catalog stays in that state.
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
    waiting: Mutex<Waiting>,
    /// The memory Convert's encodes share, its changes' and its estimates' alike.
    encode_budget: crate::plans::encode_budget::EncodeBudget,
    scan_counter: Mutex<i64>,
    /// The writes to the catalog connection's own tables, which change nothing in the catalog.
    scratch: ScratchWrites,
    sets: Mutex<Option<SetCache>>,
    clusters: Mutex<HashMap<(Option<RootId>, SimilarityLevel), ClusterCache>>,
    /// Where each root's held files go.
    places: crate::plans::holding::HoldingPlaces,
    /// What the pinned ffmpeg and libavif can encode, asked once.
    capabilities: OnceLock<crate::contract::EncoderCapabilities>,
    /// Convert's estimates per root and category, kept while the category holds the same files.
    estimates: Mutex<HashMap<(RootId, crate::contract::OptimizeCategory), changes::CachedEstimate>>,
    /// What finding Convert's candidates gives, per root: Overview's numbers, and that the
    /// Library's convertible files are recorded. Overview is asked for about three times a
    /// decision, each read 37 ms on 40,000 files without this. Any change to the catalog makes them
    /// be found again. The candidates themselves are not kept.
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

/// Runs blocking work on a thread of its own and resolves with what it returns.
fn on_thread<T, W>(
    name: &str,
    work: W,
) -> impl Future<Output = anyhow::Result<T>> + Send + use<T, W>
where
    T: Send + 'static,
    W: FnOnce() -> anyhow::Result<T> + Send + 'static,
{
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
    /// Opens the engine on the data root's catalog, with the tools [`Media::locate`] finds.
    pub async fn open(data: DataRoot) -> anyhow::Result<Self> {
        let catalog = data.tidy_catalog();
        Self::open_with(data, catalog, Media::locate()).await
    }

    /// Opens the engine on a catalog of its own, with the tools given; for tests and tools.
    /// Holding stays where the data root keeps it.
    pub async fn open_with(
        data: DataRoot,
        catalog_path: PathBuf,
        media: Media,
    ) -> anyhow::Result<Self> {
        if let Some(folder) = catalog_path.parent() {
            std::fs::create_dir_all(folder)
                .with_context(|| format!("creating {}", folder.display()))?;
        }
        let catalog = Catalog::open(catalog_path).await?;
        // Held files keep their place when the data folder moves, and a change a crash stopped
        // halfway is cancelled, its temp files removed, so its finished steps can be undone.
        let followed = data.tidy();
        catalog
            .call(move |connection| {
                crate::plans::holding::follow_data_folder(connection, &followed)?;
                crate::plans::journal::recover_interrupted_plans(connection)?;
                Ok(())
            })
            .await?;
        let places = crate::plans::holding::HoldingPlaces::new(&data);
        Ok(Self {
            inner: Arc::new(Inner {
                catalog,
                data,
                media,
                scheduler: Scheduler::default(),
                waiting: Mutex::default(),
                encode_budget: crate::plans::encode_budget::EncodeBudget::for_this_machine(),
                scan_counter: Mutex::new(now_ms()),
                scratch: ScratchWrites::default(),
                sets: Mutex::new(None),
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

    /// Runs a query on the catalog's thread with the engine at hand.
    fn query<R, Q>(&self, query: Q) -> impl Future<Output = anyhow::Result<R>> + Send + use<R, Q>
    where
        R: Send + 'static,
        Q: FnOnce(&Inner, &mut Connection) -> anyhow::Result<R> + Send + 'static,
    {
        let inner = self.inner.clone();
        self.inner
            .catalog
            .call(move |connection| query(&inner, connection))
    }

    // Roots and settings.

    pub fn roots(&self) -> impl Future<Output = anyhow::Result<Vec<Root>>> + Send + use<> {
        self.query(|_, connection| list_roots(connection))
    }

    /// Adds a folder as a root, refusing one that is missing, a file or overlapping another root,
    /// and in a sandboxed run one outside the sandbox. Scanning it is the caller's next step
    /// ([`TidyEngine::start_scan`]).
    pub fn add_root(
        &self,
        folder: &Path,
    ) -> impl Future<Output = anyhow::Result<Root>> + Send + use<> {
        let resolved = resolve_root_folder(&self.inner.data, folder);
        self.query(move |_, connection| add_root(connection, &resolved?))
    }

    /// Says whether [`Self::remove_root`] would refuse a root now, for a caller with something to
    /// do first that cannot be taken back, as Forget's emptying of holding. It waits for nothing.
    pub fn check_root_removable(&self, root_id: RootId) -> anyhow::Result<()> {
        Ok(self.inner.scheduler.check_removable(root_id)?)
    }

    /// Forgets a root and its catalog rows. Files on disk are untouched. It is refused while a
    /// scan, a change or an asked-for analysis of the root waits or runs; background analysis of
    /// it is stopped first, since it is only worth finishing for a root that stays.
    pub fn remove_root(
        &self,
        root_id: RootId,
    ) -> impl Future<Output = anyhow::Result<Vec<Root>>> + Send + use<> {
        let inner = self.inner.clone();
        // Not on the catalog's thread: stopping waits for the analysis to let go of its turn,
        // and the item it has in flight may still write to the catalog.
        on_thread("tidy remove root", move || {
            inner.scheduler.stop_work_on(root_id)?;
            inner.catalog.blocking(move |connection| {
                remove_root(connection, root_id)?;
                list_roots(connection)
            })
        })
    }

    pub fn settings(&self) -> impl Future<Output = anyhow::Result<Settings>> + Send + use<> {
        self.query(|_, connection| read_settings(connection))
    }

    /// Stores new settings and says whether the roots need analysing for them: when background
    /// analysis is turned on, and when Spot variants or the similarity level changed.
    pub fn update_settings(
        &self,
        settings: Settings,
    ) -> impl Future<Output = anyhow::Result<SettingsUpdate>> + Send + use<> {
        self.query(move |_, connection| {
            let before = read_settings(connection)?;
            write_settings(connection, &settings)?;
            // New sets may have AVIFs to read before they offer anything, Spot variants on or off.
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
    ) -> impl Future<Output = anyhow::Result<bool>> + Send + use<> {
        self.query(move |inner, connection| inner.analysis_due_in(connection, root_id))
    }

    /// Overview's numbers for a root: duplicates, conversions, Shrink, silent soundtracks,
    /// clean-up, what needs a look, and how far analysis has come.
    pub fn overview(
        &self,
        root_id: RootId,
    ) -> impl Future<Output = anyhow::Result<Tidy>> + Send + use<> {
        self.query(move |inner, connection| inner.overview(connection, root_id))
    }

    /// One page of the Library, with its filters, search, folder and sort.
    pub fn list_files(
        &self,
        query: FileQuery,
    ) -> impl Future<Output = anyhow::Result<FilePage>> + Send + use<> {
        self.query(move |inner, connection| {
            let roots = LibraryRoots::filtered_by(&query.filter);
            inner.library(connection, roots, |connection| {
                list_files(connection, &query)
            })
        })
    }

    /// Every matching file's id, in path order, up to [`crate::contract::MAX_BULK_FILES`].
    pub fn list_file_ids(
        &self,
        filter: FileFilter,
    ) -> impl Future<Output = anyhow::Result<FileIdList>> + Send + use<> {
        self.query(move |inner, connection| {
            let roots = LibraryRoots::filtered_by(&filter);
            inner.library(connection, roots, |connection| {
                list_file_ids(connection, &filter)
            })
        })
    }

    /// The filter menu's counts.
    pub fn file_facets(
        &self,
        filter: FileFilter,
    ) -> impl Future<Output = anyhow::Result<FileFacets>> + Send + use<> {
        self.query(move |inner, connection| {
            // Its counts include the convertible files'.
            let roots = LibraryRoots::Root(filter.root_id);
            inner.library(connection, roots, |connection| {
                file_facets(connection, &filter)
            })
        })
    }

    pub fn get_files(
        &self,
        ids: Vec<FileId>,
    ) -> impl Future<Output = anyhow::Result<Vec<FileRow>>> + Send + use<> {
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
    ) -> impl Future<Output = anyhow::Result<SelectionSummary>> + Send + use<> {
        self.query(move |inner, connection| {
            let roots = LibraryRoots::OfFiles(&ids);
            inner.library(connection, roots, |connection| {
                selection_summary(connection, &ids)
            })
        })
    }

    pub fn list_folders(
        &self,
        root_id: RootId,
    ) -> impl Future<Output = anyhow::Result<Vec<String>>> + Send + use<> {
        self.query(move |_, connection| list_folders(connection, root_id))
    }

    pub fn list_empty_folders(
        &self,
        root_id: RootId,
    ) -> impl Future<Output = anyhow::Result<Vec<String>>> + Send + use<> {
        self.query(move |_, connection| list_empty_folders(connection, root_id))
    }

    /// Duplicate sets, most bytes to reclaim first, with the counts Duplicates' queue shows.
    pub fn duplicate_sets(
        &self,
        request: DuplicateSetRequest,
    ) -> impl Future<Output = anyhow::Result<DuplicateSetPage>> + Send + use<> {
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

    /// Marks files as not duplicates of each other, so a set made only of them stays hidden.
    pub fn dismiss_duplicate_set(
        &self,
        ids: Vec<FileId>,
    ) -> impl Future<Output = anyhow::Result<i64>> + Send + use<> {
        self.query(move |_, connection| add_dismissal(connection, &ids, None))
    }

    pub fn restore_duplicate_set(
        &self,
        dismissal_id: i64,
    ) -> impl Future<Output = anyhow::Result<()>> + Send + use<> {
        self.query(move |_, connection| remove_dismissal(connection, dismissal_id))
    }

    /// The sets marked as not duplicates by hand under a root, newest first, for History.
    pub fn list_dismissals(
        &self,
        root_id: RootId,
        limit: usize,
    ) -> impl Future<Output = anyhow::Result<Vec<DuplicateDismissal>>> + Send + use<> {
        self.query(move |_, connection| list_dismissals(connection, root_id, limit))
    }

    /// What Convert would change under a root.
    pub fn optimize_summary(
        &self,
        root_id: RootId,
    ) -> impl Future<Output = anyhow::Result<OptimizeSummary>> + Send + use<> {
        self.query(move |inner, connection| {
            let removable = inner.removable_copies(connection, root_id)?;
            let mut summary =
                summarize_candidates(&inner.candidates(connection, root_id)?, &removable);
            inner.attach_estimates(connection, root_id, &mut summary)?;
            Ok(summary)
        })
    }

    /// What Shrink would re-encode under a root.
    pub fn shrink_summary(
        &self,
        root_id: RootId,
    ) -> impl Future<Output = anyhow::Result<ShrinkSummary>> + Send + use<> {
        self.query(move |_, connection| {
            let scan = find_shrink_candidates(connection, root_id)?;
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

    /// Scans a root, as work the owner asked for: walks it, identifies formats, reads media
    /// details and hashes what could be a duplicate. The report says when background analysis is
    /// due. A scan of a root that already waits for its turn is that scan:
    /// this one is done at once with an empty report. Stopping it ends it between files and
    /// kills a running ffprobe; pausing it waits between folders and files.
    pub fn scan(&self, root_id: RootId) -> Queued<ScanReport> {
        let Some(waiting) = self.queue_scan(root_id) else {
            return Queued::done(ScanReport::default());
        };
        let ticket = self
            .inner
            .scheduler
            .ticket(Priority::AskedFor, vec![root_id]);
        let engine = self.clone();
        Queued::work(move |progress| {
            let turn = ticket.wait(progress);
            drop(waiting);
            engine.scan_locked(root_id, &turn?)
        })
    }

    /// Analyses a root: fingerprints, the detail prints Spot variants needs, and loudness.
    /// Results are kept per file, so a stopped analysis goes on where it left off. Background
    /// analysis of a root that already waits for its turn takes this one in, the later kind
    /// winning, and this one is done at once with an empty report.
    pub fn analyze(&self, root_id: RootId, kind: AnalysisKind) -> Queued<AnalysisReport> {
        let priority = match kind {
            AnalysisKind::AskedFor => Priority::AskedFor,
            AnalysisKind::AfterChange | AnalysisKind::CatchingUp => Priority::Background,
        };
        let waiting = if priority == Priority::Background {
            match self.queue_analysis(root_id, kind) {
                Some(waiting) => Some(waiting),
                None => return Queued::done(AnalysisReport::default()),
            }
        } else {
            None
        };
        let ticket = self.inner.scheduler.ticket(priority, vec![root_id]);
        let engine = self.clone();
        Queued::work(move |progress| {
            let turn = ticket.wait(progress);
            // Joined while it waited, it does what the latest asked.
            let kind = waiting.map_or(kind, WaitingAnalysis::kind);
            let turn = turn?;
            // Paused while it waited for its turn, it waits before it starts.
            turn.checkpoint()?;
            if kind != AnalysisKind::AskedFor {
                let inner = engine.inner.clone();
                let due = engine
                    .inner
                    .catalog
                    .blocking(move |connection| match kind {
                        AnalysisKind::CatchingUp => inner.analysis_due_in(connection, root_id),
                        _ => inner.analysis_left_in(connection, root_id),
                    })?;
                if !due {
                    return Ok(AnalysisReport::default());
                }
            }
            engine.analyze_locked(root_id, &turn)
        })
    }

    /// Makes background analysis of a root that waits, runs or stepped aside into asked-for
    /// work, as "Check now" does while one is queued; says whether there was any. It carries on
    /// as it was, no longer stepping aside (its progress stops saying background).
    pub fn promote_analysis(&self, root_id: RootId) -> bool {
        self.inner.scheduler.promote(root_id)
    }

    /// Notes a scan of `root_id` as waiting, or `None` when one already waits.
    fn queue_scan(&self, root_id: RootId) -> Option<WaitingScan> {
        let mut waiting = self
            .inner
            .waiting
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        waiting.scans.insert(root_id).then(|| WaitingScan {
            inner: self.inner.clone(),
            root_id,
        })
    }

    /// Notes a background analysis of `root_id` as waiting, or joins the one that waits and
    /// returns `None`.
    fn queue_analysis(&self, root_id: RootId, kind: AnalysisKind) -> Option<WaitingAnalysis> {
        let mut waiting = self
            .inner
            .waiting
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        match waiting.analyses.get_mut(&root_id) {
            Some(queued) => {
                *queued = (*queued).max(kind);
                None
            }
            None => {
                waiting.analyses.insert(root_id, kind);
                Some(WaitingAnalysis {
                    inner: self.inner.clone(),
                    root_id,
                })
            }
        }
    }

    /// [`Self::scan`] with the turn held.
    fn scan_locked(&self, root_id: RootId, progress: &dyn Progress) -> anyhow::Result<ScanReport> {
        let inner = &self.inner;
        let root = inner.admit(root_id)?;
        let root_path = PathBuf::from(&root.path);
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
        let walked = walk_root(
            &root_path,
            |batch| {
                catalog.blocking(move |connection| {
                    upsert_walked_files(connection, root_id, scan_id, &batch)
                })
            },
            |files, _| progress.done(files as u64),
            || progress.checkpoint(),
        )
        .and_then(|summary| {
            let empty = summary.empty_folders.clone();
            let removed = inner.catalog.blocking(move |connection| {
                let removed = delete_unseen_files(connection, root_id, scan_id)?;
                replace_empty_folders(connection, root_id, &empty)?;
                Ok(removed)
            })?;
            Ok((summary, removed))
        });
        // A walk stopped partway has dropped prints too.
        inner
            .catalog
            .blocking(|connection| prints_changed(connection))?;
        let (summary, removed) = walked?;
        let pass = inner.pass_context(Some(root_id), progress);
        run_sniff_pass(&pass)?;
        run_probe_pass(&pass)?;
        run_hash_pass(&pass)?;
        inner
            .catalog
            .blocking(move |connection| mark_scanned(connection, root_id))?;

        Ok(ScanReport {
            files: summary.files,
            empty_folders: summary.empty_folders.len(),
            skipped_entries: summary.skipped_entries,
            removed,
            analysis_due: inner.analysis_due(root_id)?,
        })
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
            // Spot variants compares the stills of the sets those fingerprints made.
            let this = self.inner.clone();
            let stills: Vec<FileId> = inner.catalog.blocking(move |connection| {
                let settings = read_settings(connection)?;
                // Before the stills are worked out: sets whose prints all failed count as variants,
                // whose stills are not offered for prints, so they would never be asked again.
                if this.media.loaded_vips().is_some() {
                    forget_unread(connection, root_id)?;
                }
                if !settings.spot_variants {
                    return Ok(Vec::new());
                }
                forget_outdated_details(connection, root_id)?;
                let sets = this.duplicate_sets(connection, Some(root_id), settings.similarity)?;
                Ok(stills_to_print(&sets, &Dismissals::load(connection)?))
            })?;
            if !stills.is_empty() {
                run_detail_pass(&pass, &stills)?;
            }
            self.compare_closer(root_id, &pass)?;
            run_loudness_pass(&pass)?;
            Ok(stills.len())
        })();
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
            asked = pairs;
        }
    }
}

/// A scan noted as waiting until its turn comes, or it is stopped first.
struct WaitingScan {
    inner: Arc<Inner>,
    root_id: RootId,
}

impl Drop for WaitingScan {
    fn drop(&mut self) {
        self.inner
            .waiting
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .scans
            .remove(&self.root_id);
    }
}

/// A background analysis noted as waiting until its turn comes, or it is stopped first.
struct WaitingAnalysis {
    inner: Arc<Inner>,
    root_id: RootId,
}

impl WaitingAnalysis {
    /// What it was last asked to do, once its turn has come.
    fn kind(self) -> AnalysisKind {
        let kind = self
            .inner
            .waiting
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .analyses
            .get(&self.root_id)
            .copied();
        kind.unwrap_or(AnalysisKind::AfterChange)
    }
}

impl Drop for WaitingAnalysis {
    fn drop(&mut self) {
        self.inner
            .waiting
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .analyses
            .remove(&self.root_id);
    }
}

impl Inner {
    /// The root with this id, refused when it is gone or, in a sandboxed run, outside the
    /// sandbox: the one gate every operation that touches a root's files goes through.
    fn admit(&self, root_id: RootId) -> anyhow::Result<Root> {
        let root = self
            .catalog
            .blocking(move |connection| find_root(connection, root_id))?
            .context(NO_ROOT)?;
        if !self.data.admits_tidy_root(Path::new(&root.path)) {
            bail!(
                "{} is outside Tidy's sandbox, so Tidy leaves it alone.",
                root.path
            );
        }
        Ok(root)
    }

    /// Whether analysis of a root is due: background analysis
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

    /// The similar clusters under a root at a level; see [`ClusterCache`].
    fn similar_clusters(
        &self,
        connection: &Connection,
        root_id: Option<RootId>,
        level: SimilarityLevel,
    ) -> anyhow::Result<Arc<Vec<SimilarCluster>>> {
        let prints = self.print_state(connection)?;
        let key = (root_id, level);
        let mut cache = self.clusters.lock().unwrap_or_else(PoisonError::into_inner);
        cache.retain(|_, cached| cached.prints == prints);
        if let Some(cached) = cache.get(&key) {
            return Ok(cached.clusters.clone());
        }
        drop(cache);
        let clusters = Arc::new(compute_similar_clusters(connection, root_id, level)?);
        self.clusters
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .insert(
                key,
                ClusterCache {
                    prints,
                    clusters: clusters.clone(),
                },
            );
        Ok(clusters)
    }

    /// The fingerprints' generation, with what other connections wrote.
    fn print_state(&self, connection: &Connection) -> anyhow::Result<(i64, i64)> {
        let state = self.scratch.state(connection)?;
        Ok((print_generation(connection)?, state.data_version()))
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
        let state = self.scratch.state(connection)?;
        if let Some(cached) = self
            .sets
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .as_ref()
            .filter(|cached| {
                cached.state == state && cached.root_id == root_id && cached.level == level
            })
        {
            return Ok(cached.sets.clone());
        }
        let settings = read_settings(connection)?;
        let clusters = self.similar_clusters(connection, root_id, level)?;
        let sets = Arc::new(build_duplicate_sets(
            connection, root_id, &settings, &clusters,
        )?);
        *self.sets.lock().unwrap_or_else(PoisonError::into_inner) = Some(SetCache {
            state,
            root_id,
            level,
            sets: sets.clone(),
        });
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

    /// The result `make` gives for `key`, made again only when the catalog changed since it was
    /// last made. One whose making saw another connection write is not kept.
    fn kept<K: std::hash::Hash + Eq, T: Clone>(
        &self,
        cache: &Mutex<HashMap<K, Kept<T>>>,
        key: K,
        connection: &mut Connection,
        make: impl FnOnce(&mut Connection) -> anyhow::Result<T>,
    ) -> anyhow::Result<T> {
        let before = self.scratch.state(connection)?;
        if let Some(kept) = cache
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .get(&key)
            .filter(|kept| kept.state == before)
        {
            return Ok(kept.value.clone());
        }
        let value = make(connection)?;
        let after = self.scratch.state(connection)?;
        if after.data_version() == before.data_version() {
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
        let files: Vec<_> = scan
            .candidates
            .iter()
            .map(|candidate| (candidate.record.id, candidate.category))
            .collect();
        self.scratch.uncounted(connection, |connection| {
            record_convertible(connection, root_id, &files)
        })?;
        // The Library's convertible files are these until the catalog changes.
        let state = self.scratch.state(connection)?;
        self.convertible
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .insert(root_id, Kept { state, value: () });
        Ok(scan)
    }

    /// Runs a Library query with the convertible files of the roots it reads recorded first, which
    /// its Convertible filter and counts read.
    fn library<R>(
        &self,
        connection: &mut Connection,
        roots: LibraryRoots,
        query: impl FnOnce(&Connection) -> anyhow::Result<R>,
    ) -> anyhow::Result<R> {
        match roots {
            LibraryRoots::Unread => {}
            LibraryRoots::Root(root_id) => self.prepare_convertible(connection, root_id)?,
            LibraryRoots::OfFiles(ids) => {
                for root_id in roots_of_files(connection, ids)? {
                    self.prepare_convertible(connection, Some(root_id))?;
                }
            }
        }
        query(connection)
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
        let mut tidy = self.kept(&self.overviews, root_id, connection, |connection| {
            self.make_overview(connection, root_id)
        })?;
        self.attach_estimates(connection, root_id, &mut tidy.convert)?;
        Ok(tidy)
    }

    fn make_overview(&self, connection: &mut Connection, root_id: RootId) -> anyhow::Result<Tidy> {
        let settings = read_settings(connection)?;
        let sets = self.duplicate_sets(connection, Some(root_id), settings.similarity)?;
        let open = open_sets(&sets, &Dismissals::load(connection)?, DuplicateScope::All);
        let removable = self.removable_copies(connection, root_id)?;
        let scan = self.candidates(connection, root_id)?;
        let catalog = catalog_tidy(connection, root_id)?;
        let shrink = find_shrink_candidates(connection, root_id)?;
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
