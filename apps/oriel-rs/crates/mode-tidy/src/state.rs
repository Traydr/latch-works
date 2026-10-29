//! What every Tidy page shares, as Electron Oriel's `EngineProvider` and `NavigationProvider` hold
//! it: the engine, its roots and settings, the folder on screen, the page, the scans and analyses
//! running, and a version that moves whenever the catalog changes, so the pages read again.
//!
//! Pages observe this entity. They never touch the engine's jobs themselves: a scan, an analysis
//! or a change starts here, and its progress reaches the shell's switcher from here.

use std::collections::{BTreeSet, HashMap, HashSet};
use std::path::PathBuf;

use gpui_kit::{App, AppContext as _, Context, Entity, SharedString, Subscription, Task, Window};
use oriel_core_paths::DataRoot;
use oriel_core_tidy::contract::{
    AudioState, DuplicateScope, FileFlag, FileFormat, FileKind, OptimizeCategory, Root, RootId,
    Settings, Tidy,
};
use oriel_core_tidy::{AnalysisReport, ScanReport, TidyEngine};
use oriel_runtime::{Job, JobEvent};
use oriel_ui::{LocalStorage, ModeActivity, ModeId, ShellState, Toast};

use crate::actions::{RunningChange, UndoEntry};
use crate::changes::{Changes, HoldingList, PlanSummary};
use crate::loaded::Loaded;
use crate::pages::TidyPage;

/// Electron Oriel's `localStorage` key for the page Tidy showed last.
pub const VIEW_KEY: &str = "oriel.tidy.view";
/// The folder Tidy showed last.
pub const ROOT_KEY: &str = "oriel.tidy.root";
/// Convert's switches, shared by Convert's Options and Overview's Tidy up.
pub const CONVERT_GROUPS_KEY: &str = "glazier.convert-groups";

/// A starting filter for the Library, set when another page links to a set of files.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct LibraryPreset {
    pub kinds: Vec<FileKind>,
    pub formats: Vec<FileFormat>,
    pub audio_states: Vec<AudioState>,
    pub flags: Vec<FileFlag>,
    pub search: String,
    pub dir: Option<String>,
}

/// Convert's three switches (`CONVERT_GROUPS`); videos cover both lossless and re-encoded moves
/// to MP4.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum ConvertGroup {
    Pictures,
    Animations,
    Videos,
}

impl ConvertGroup {
    pub const ALL: [ConvertGroup; 3] = [
        ConvertGroup::Pictures,
        ConvertGroup::Animations,
        ConvertGroup::Videos,
    ];

    pub fn key(self) -> &'static str {
        match self {
            ConvertGroup::Pictures => "pictures",
            ConvertGroup::Animations => "animations",
            ConvertGroup::Videos => "videos",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            ConvertGroup::Pictures => "Pictures → AVIF",
            ConvertGroup::Animations => "Animations → MP4",
            ConvertGroup::Videos => "Videos → MP4",
        }
    }

    pub fn categories(self) -> &'static [OptimizeCategory] {
        match self {
            ConvertGroup::Pictures => &[OptimizeCategory::StillToAvif],
            ConvertGroup::Animations => &[OptimizeCategory::AnimationToMp4],
            ConvertGroup::Videos => &[OptimizeCategory::VideoRemux, OptimizeCategory::VideoConvert],
        }
    }

    pub fn nouns(self) -> (&'static str, &'static str) {
        match self {
            ConvertGroup::Pictures => ("picture", "pictures"),
            ConvertGroup::Animations => ("animation", "animations"),
            ConvertGroup::Videos => ("video", "videos"),
        }
    }

    pub fn target(self) -> &'static str {
        match self {
            ConvertGroup::Pictures => "AVIF",
            _ => "MP4",
        }
    }

    /// The files and bytes a group would convert (`groupTotals`).
    pub fn totals(self, tidy: &Tidy) -> (i64, i64) {
        tidy.convert
            .categories
            .iter()
            .filter(|entry| self.categories().contains(&entry.category))
            .fold((0, 0), |(files, bytes), entry| {
                (files + entry.files, bytes + entry.bytes)
            })
    }
}

/// Whether the engine is open.
enum Engine {
    Opening(#[allow(dead_code)] Task<()>),
    Ready(TidyEngine),
    Failed(SharedString),
}

/// A scan or an analysis of one root, and what watches it.
pub struct Running<T> {
    pub root_id: RootId,
    pub job: Entity<Job<T>>,
    _subscriptions: Vec<Subscription>,
}

/// A scan or analysis that failed, for the sidebar's card until it is dismissed.
#[derive(Clone, Debug, PartialEq)]
pub struct FailedWork {
    pub label: SharedString,
    pub message: SharedString,
}

/// What the Library, Duplicates and the search were asked to open with.
#[derive(Default)]
pub struct Requests {
    /// A Library filter, with a number that moves each time, so the same preset applies again.
    pub library: Option<(u64, LibraryPreset)>,
    pub duplicates: Option<DuplicateScope>,
    pub search: bool,
}

pub struct TidyState {
    pub(crate) shell: Entity<ShellState>,
    data: DataRoot,
    engine: Engine,
    pub(crate) changes: Changes,
    roots: Vec<Root>,
    settings: Option<Settings>,
    root_id: Option<RootId>,
    page: TidyPage,
    catalog_version: u64,
    /// Overview's numbers for the folder on screen; the sidebar's counts read them too.
    pub(crate) overview: Loaded<Tidy>,
    /// The first of holding, for its size in the sidebar and on Overview.
    pub(crate) holding: Loaded<HoldingList>,
    scan: Option<Running<ScanReport>>,
    analysis: Option<Running<AnalysisReport>>,
    pub(crate) change: Option<RunningChange>,
    failed: Option<FailedWork>,
    pub(crate) undo: Vec<UndoEntry>,
    /// The newest finished plan started from each place in the UI (`resultFor`).
    pub(crate) results: HashMap<SharedString, PlanSummary>,
    requests: Requests,
    request_number: u64,
    convert_groups: BTreeSet<ConvertGroup>,
    /// Convert's estimates, by root, category and the files they cover: the size after as a
    /// share of before, or `None` when the estimate failed or sampled nothing.
    ratios: HashMap<String, Option<f64>>,
    pending_ratios: HashSet<String>,
}

/// An estimate of a set of files' size after converting, or why there is none yet.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Estimate {
    Pending,
    Unknown,
    Known { before: f64, after: f64 },
}

impl Estimate {
    /// Size after converting as a share of before (`estimateRatio`).
    pub fn ratio(self) -> Option<f64> {
        match self {
            Estimate::Known { before, after } if before > 0. => Some(after / before),
            _ => None,
        }
    }

    /// "1.7 MB → about 700 KB", or what stands in for it (`describeEstimate`).
    pub fn describe(self, bytes: f64) -> String {
        match self {
            Estimate::Pending => format!("{} → estimating…", crate::format::bytes(bytes)),
            Estimate::Unknown => format!("{} → size unknown", crate::format::bytes(bytes)),
            Estimate::Known { after, .. } => format!(
                "{} → about {}",
                crate::format::bytes(bytes),
                crate::format::bytes(after)
            ),
        }
    }
}

impl TidyState {
    /// Opens the engine over `data` in the background; the pages show "Starting…" until it is.
    pub fn new(
        shell: &Entity<ShellState>,
        data: DataRoot,
        changes: Changes,
        cx: &mut Context<Self>,
    ) -> Self {
        let page = LocalStorage::get(cx, VIEW_KEY)
            .and_then(TidyPage::from_key)
            .unwrap_or(TidyPage::Overview);
        let convert_groups = read_convert_groups(cx);
        let opening = {
            let data = data.clone();
            cx.spawn(async move |this, cx| {
                let opened = cx
                    .background_spawn(
                        async move { futures::executor::block_on(TidyEngine::open(data)) },
                    )
                    .await;
                this.update(cx, |this, cx| this.engine_opened(opened, cx))
                    .ok();
            })
        };
        Self {
            shell: shell.clone(),
            data,
            engine: Engine::Opening(opening),
            changes,
            roots: Vec::new(),
            settings: None,
            root_id: None,
            page,
            catalog_version: 0,
            overview: Loaded::default(),
            holding: Loaded::default(),
            scan: None,
            analysis: None,
            change: None,
            failed: None,
            undo: Vec::new(),
            results: HashMap::new(),
            requests: Requests::default(),
            request_number: 0,
            convert_groups,
            ratios: HashMap::new(),
            pending_ratios: HashSet::new(),
        }
    }

    fn engine_opened(&mut self, opened: anyhow::Result<TidyEngine>, cx: &mut Context<Self>) {
        match opened {
            Ok(engine) => {
                self.engine = Engine::Ready(engine.clone());
                cx.spawn(async move |this, cx| {
                    let (roots, settings) = (
                        crate::loaded::engine_call(engine.roots(), cx).await,
                        crate::loaded::engine_call(engine.settings(), cx).await,
                    );
                    this.update(cx, |this, cx| {
                        match (roots, settings) {
                            (Ok(roots), Ok(settings)) => {
                                this.settings = Some(settings);
                                let stored = LocalStorage::get(cx, ROOT_KEY)
                                    .and_then(|id| id.parse::<RootId>().ok());
                                this.set_roots(roots, stored, cx);
                            }
                            (Err(error), _) | (_, Err(error)) => {
                                this.engine = Engine::Failed(format!("{error:#}").into());
                            }
                        }
                        cx.notify();
                    })
                    .ok();
                })
                .detach();
            }
            Err(error) => {
                log::error!("Tidy's engine did not open: {error:#}");
                self.engine = Engine::Failed(format!("{error:#}").into());
            }
        }
        cx.notify();
    }

    pub fn data(&self) -> &DataRoot {
        &self.data
    }

    pub fn engine(&self) -> Option<&TidyEngine> {
        match &self.engine {
            Engine::Ready(engine) => Some(engine),
            _ => None,
        }
    }

    /// Whether the engine has answered with its roots and settings.
    pub fn is_ready(&self) -> bool {
        self.engine().is_some() && self.settings.is_some()
    }

    /// Why the engine could not open, when it could not.
    pub fn engine_error(&self) -> Option<&SharedString> {
        match &self.engine {
            Engine::Failed(error) => Some(error),
            _ => None,
        }
    }

    pub fn roots(&self) -> &[Root] {
        &self.roots
    }

    pub fn root_id(&self) -> Option<RootId> {
        self.root_id
    }

    /// The folder on screen.
    pub fn root(&self) -> Option<&Root> {
        let id = self.root_id?;
        self.roots.iter().find(|root| root.id == id)
    }

    /// Overview's numbers for the folder on screen, once read.
    pub fn overview(&self) -> Option<&Tidy> {
        self.overview.data()
    }

    pub fn settings(&self) -> Option<&Settings> {
        self.settings.as_ref()
    }

    pub fn page(&self) -> TidyPage {
        self.page
    }

    /// Moves whenever the catalog may have changed.
    pub fn catalog_version(&self) -> u64 {
        self.catalog_version
    }

    pub fn scan(&self) -> Option<&Running<ScanReport>> {
        self.scan.as_ref()
    }

    pub fn analysis(&self) -> Option<&Running<AnalysisReport>> {
        self.analysis.as_ref()
    }

    /// Whether a scan of `root_id` runs.
    pub fn is_scanning(&self, root_id: RootId) -> bool {
        self.scan
            .as_ref()
            .is_some_and(|scan| scan.root_id == root_id)
    }

    /// Whether any scan, analysis or change runs.
    pub fn is_busy(&self) -> bool {
        self.scan.is_some() || self.analysis.is_some() || self.change.is_some()
    }

    pub fn failed_work(&self) -> Option<&FailedWork> {
        self.failed.as_ref()
    }

    pub fn dismiss_failed_work(&mut self, cx: &mut Context<Self>) {
        if self.failed.take().is_some() {
            cx.notify();
        }
    }

    pub fn convert_groups(&self) -> &BTreeSet<ConvertGroup> {
        &self.convert_groups
    }

    pub fn set_convert_group(&mut self, group: ConvertGroup, on: bool, cx: &mut Context<Self>) {
        let changed = if on {
            self.convert_groups.insert(group)
        } else {
            self.convert_groups.remove(&group)
        };
        if changed {
            let keys: Vec<&str> = self
                .convert_groups
                .iter()
                .map(|group| group.key())
                .collect();
            let text = serde_json::to_string(&keys).unwrap_or_else(|_| "[]".into());
            LocalStorage::set(cx, CONVERT_GROUPS_KEY, &text);
            cx.notify();
        }
    }

    /// The categories Convert and Tidy up run, from the switches on.
    pub fn convert_categories(&self) -> Vec<OptimizeCategory> {
        self.convert_groups
            .iter()
            .flat_map(|group| group.categories().iter().copied())
            .collect()
    }

    // Navigation.

    pub fn go(&mut self, page: TidyPage, cx: &mut Context<Self>) {
        if self.page != page {
            self.page = page;
            LocalStorage::set(cx, VIEW_KEY, page.key());
            cx.notify();
        }
    }

    /// Opens the Library filtered to `preset`.
    pub fn open_library(&mut self, preset: LibraryPreset, cx: &mut Context<Self>) {
        self.request_number += 1;
        self.requests.library = Some((self.request_number, preset));
        self.go(TidyPage::Library, cx);
        cx.notify();
    }

    /// Opens Duplicates on a tab: similar versions, or identical copies.
    pub fn open_duplicates(&mut self, scope: DuplicateScope, cx: &mut Context<Self>) {
        self.requests.duplicates = Some(scope);
        self.go(TidyPage::Duplicates, cx);
        cx.notify();
    }

    /// ⌘F: the Library, with its search focused.
    pub fn request_search(&mut self, cx: &mut Context<Self>) {
        self.requests.search = true;
        self.go(TidyPage::Library, cx);
        cx.notify();
    }

    pub fn library_request(&self) -> Option<&(u64, LibraryPreset)> {
        self.requests.library.as_ref()
    }

    pub fn take_duplicates_request(&mut self) -> Option<DuplicateScope> {
        self.requests.duplicates.take()
    }

    pub fn take_search_request(&mut self) -> bool {
        std::mem::take(&mut self.requests.search)
    }

    // Roots.

    /// Shows `root_id`, remembered for the next launch.
    pub fn select_root(&mut self, root_id: RootId, cx: &mut Context<Self>) {
        if self.root_id == Some(root_id) || !self.roots.iter().any(|root| root.id == root_id) {
            return;
        }
        self.root_id = Some(root_id);
        LocalStorage::set(cx, ROOT_KEY, &root_id.to_string());
        self.overview.clear();
        self.holding.clear();
        self.changed(cx);
    }

    /// Takes a new list of roots, keeping the one on screen while it is still there.
    fn set_roots(&mut self, roots: Vec<Root>, prefer: Option<RootId>, cx: &mut Context<Self>) {
        self.roots = roots;
        let keep = prefer
            .or(self.root_id)
            .filter(|id| self.roots.iter().any(|root| root.id == *id));
        let next = keep.or_else(|| self.roots.first().map(|root| root.id));
        if next != self.root_id {
            self.root_id = next;
            if let Some(id) = next {
                LocalStorage::set(cx, ROOT_KEY, &id.to_string());
            }
            self.overview.clear();
            self.holding.clear();
        }
        self.changed(cx);
    }

    /// Reads the roots again (their counts change with every scan).
    pub fn reload_roots(&mut self, cx: &mut Context<Self>) {
        let Some(engine) = self.engine().cloned() else {
            return;
        };
        cx.spawn(async move |this, cx| {
            let roots = crate::loaded::engine_call(engine.roots(), cx).await;
            this.update(cx, |this, cx| match roots {
                Ok(roots) => this.set_roots(roots, None, cx),
                Err(error) => log::warn!("Tidy could not list its folders: {error:#}"),
            })
            .ok();
        })
        .detach();
    }

    /// Adds `folder` as a root, shows it on Overview and scans it. A folder outside the sandbox,
    /// or one that overlaps another root, is refused with a toast saying why.
    pub fn add_folder(&mut self, folder: PathBuf, window: &mut Window, cx: &mut Context<Self>) {
        let Some(engine) = self.engine().cloned() else {
            return;
        };
        cx.spawn_in(window, async move |this, cx| {
            let added = engine.add_root(&folder).await;
            let roots = crate::loaded::engine_call(engine.roots(), cx).await;
            this.update_in(cx, |this, window, cx| match added {
                Ok(root) => {
                    if let Ok(roots) = roots {
                        this.set_roots(roots, Some(root.id), cx);
                    }
                    this.go(TidyPage::Overview, cx);
                    this.start_scan(root.id, window, cx);
                }
                Err(error) => crate::widgets::show_toast(
                    window,
                    Toast::error("Tidy can't add that folder").detail(format!("{error:#}")),
                    cx,
                ),
            })
            .ok();
        })
        .detach();
    }

    /// Forgets a root and its catalog rows; the folder itself is untouched. What holding keeps for
    /// it goes to the Trash first, and the root stays if any of it cannot.
    pub fn forget_root(&mut self, root_id: RootId, window: &mut Window, cx: &mut Context<Self>) {
        let Some(engine) = self.engine().cloned() else {
            return;
        };
        let name = self
            .roots
            .iter()
            .find(|root| root.id == root_id)
            .map(|root| root.name.clone())
            .unwrap_or_default();
        let emptied = self.changes.empty_holding(&engine, root_id);
        cx.spawn_in(window, async move |this, cx| {
            let emptied = emptied.await;
            // Without the executor nothing can be held, so there is nothing to keep the root for.
            let kept = match &emptied {
                Ok(result) => !result.failed.is_empty(),
                Err(error) => !crate::changes::is_not_yet(error),
            };
            if kept {
                this.update_in(cx, |_, window, cx| {
                    crate::widgets::show_toast(
                        window,
                        Toast::error(format!(
                            "Kept “{name}”: some held files could not go to the Trash."
                        )),
                        cx,
                    );
                })
                .ok();
                return;
            }
            let roots = engine.remove_root(root_id).await;
            this.update_in(cx, |this, window, cx| match roots {
                Ok(roots) => this.set_roots(roots, None, cx),
                Err(error) => crate::widgets::show_toast(
                    window,
                    Toast::error("Something went wrong").detail(format!("{error:#}")),
                    cx,
                ),
            })
            .ok();
        })
        .detach();
    }

    // Scans and analyses.

    /// Scans a root on the engine's job, unless one already runs.
    pub fn start_scan(&mut self, root_id: RootId, window: &mut Window, cx: &mut Context<Self>) {
        if self.scan.is_some() {
            return;
        }
        let Some(engine) = self.engine().cloned() else {
            return;
        };
        let job = engine.start_scan(root_id, cx);
        self.failed = None;
        let subscriptions = self.watch(&job, window, cx, |this| &mut this.scan);
        self.scan = Some(Running {
            root_id,
            job,
            _subscriptions: subscriptions,
        });
        self.report_activity(cx);
        cx.notify();
    }

    /// Fingerprints, detail prints and loudness for a root ("Check now"), unless an analysis
    /// already runs.
    pub fn start_analysis(&mut self, root_id: RootId, window: &mut Window, cx: &mut Context<Self>) {
        if self.analysis.is_some() {
            return;
        }
        let Some(engine) = self.engine().cloned() else {
            return;
        };
        let job = engine.start_analysis(root_id, cx);
        let subscriptions = self.watch(&job, window, cx, |this| &mut this.analysis);
        self.analysis = Some(Running {
            root_id,
            job,
            _subscriptions: subscriptions,
        });
        self.report_activity(cx);
        cx.notify();
    }

    /// Follows a scan or analysis: its phases move the catalog's version, so the pages show what
    /// it has found so far, and its end clears its slot and reads the roots again.
    fn watch<T: Send + 'static>(
        &mut self,
        job: &Entity<Job<T>>,
        window: &mut Window,
        cx: &mut Context<Self>,
        slot: fn(&mut Self) -> &mut Option<Running<T>>,
    ) -> Vec<Subscription> {
        let mut phase = SharedString::default();
        vec![
            cx.observe(job, move |this, job, cx| {
                let now = job.read(cx).progress().phase().clone();
                if now != phase {
                    phase = now;
                    this.changed(cx);
                }
                cx.notify();
            }),
            cx.subscribe_in(job, window, move |this, job, event: &JobEvent, _, cx| {
                let name = job.read(cx).name().clone();
                *slot(this) = None;
                if let JobEvent::Failed(error) = event
                    && !error.is_cancelled()
                {
                    this.failed = Some(FailedWork {
                        label: name,
                        message: error.message(),
                    });
                }
                this.report_activity(cx);
                this.reload_roots(cx);
            }),
        ]
    }

    /// Stops the scan or analysis running; what it finished stays.
    pub fn stop_work(&mut self, cx: &mut Context<Self>) {
        if let Some(scan) = &self.scan {
            scan.job.update(cx, |job, cx| job.cancel(cx));
        } else if let Some(analysis) = &self.analysis {
            analysis.job.update(cx, |job, cx| job.cancel(cx));
        }
    }

    /// Tells the shell what Tidy is doing: a ring while a change runs, a dot while a scan or an
    /// analysis does (`jobActivity`).
    pub(crate) fn report_activity(&mut self, cx: &mut Context<Self>) {
        let activity = if let Some(change) = &self.change {
            Some(ModeActivity::Progress(change.fraction(cx)))
        } else if self.scan.is_some() || self.analysis.is_some() {
            Some(ModeActivity::Working)
        } else {
            None
        };
        self.shell.update(cx, |shell, cx| {
            shell.set_activity(ModeId::Tidy, activity, cx);
        });
    }

    // Settings.

    /// Stores new settings; the pages read again, and an analysis starts when they need one.
    pub fn update_settings(
        &mut self,
        settings: Settings,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(engine) = self.engine().cloned() else {
            return;
        };
        // Shown at once, so a switch does not spring back while the engine stores it.
        self.settings = Some(settings.clone());
        cx.notify();
        cx.spawn_in(window, async move |this, cx| {
            let update = engine.update_settings(settings).await;
            this.update_in(cx, |this, window, cx| match update {
                Ok(update) => {
                    this.settings = Some(update.settings);
                    this.changed(cx);
                    if update.analyze
                        && let Some(root_id) = this.root_id
                    {
                        this.start_analysis(root_id, window, cx);
                    }
                }
                Err(error) => crate::widgets::show_toast(
                    window,
                    Toast::error("Something went wrong").detail(format!("{error:#}")),
                    cx,
                ),
            })
            .ok();
        })
        .detach();
    }

    /// The catalog may have changed: every page reads again, and so do Overview's numbers and
    /// holding's size.
    pub fn changed(&mut self, cx: &mut Context<Self>) {
        self.catalog_version += 1;
        self.refresh_shared(cx);
        cx.notify();
    }

    fn refresh_shared(&mut self, cx: &mut Context<Self>) {
        let (Some(engine), Some(root_id)) = (self.engine().cloned(), self.root_id) else {
            return;
        };
        self.overview.load_then(
            engine.overview(root_id),
            |this| &mut this.overview,
            Self::want_estimates,
            cx,
        );
        let request = crate::changes::HoldingRequest {
            root_id,
            offset: 0,
            limit: 1,
        };
        let holding = self.changes.list_holding(&engine, request);
        self.holding.load(holding, |this| &mut this.holding, cx);
    }
}

impl TidyState {
    fn ratio_key(root_id: RootId, category: OptimizeCategory, files: i64, bytes: i64) -> String {
        format!("{root_id}:{category}:{files}:{bytes}")
    }

    /// Asks for an estimate of each category Overview counts that has none yet. Each converts a
    /// small sample once; the engine caches them as well.
    fn want_estimates(&mut self, cx: &mut Context<Self>) {
        let (Some(root_id), Some(tidy)) = (self.root_id, self.overview.data()) else {
            return;
        };
        let wanted: Vec<(OptimizeCategory, String)> = tidy
            .convert
            .categories
            .iter()
            .filter(|entry| entry.files > 0)
            .map(|entry| {
                let key = Self::ratio_key(root_id, entry.category, entry.files, entry.bytes);
                (entry.category, key)
            })
            .filter(|(_, key)| !self.ratios.contains_key(key) && !self.pending_ratios.contains(key))
            .collect();
        for (category, key) in wanted {
            self.pending_ratios.insert(key.clone());
            let Some(engine) = self.engine().cloned() else {
                return;
            };
            let estimate = self.changes.estimate_optimize(&engine, root_id, category);
            cx.spawn(async move |this, cx| {
                let ratio = match estimate.await {
                    Ok(estimate) if estimate.sampled > 0 => Some(estimate.ratio),
                    _ => None,
                };
                this.update(cx, |this, cx| {
                    this.pending_ratios.remove(&key);
                    this.ratios.insert(key, ratio);
                    cx.notify();
                })
                .ok();
            })
            .detach();
        }
    }

    /// What converting `categories` would leave, summed; a category that failed makes the sum
    /// unknown (`useConvertEstimates`).
    pub fn estimate(&self, categories: &[OptimizeCategory]) -> Estimate {
        let (Some(root_id), Some(tidy)) = (self.root_id, self.overview.data()) else {
            return Estimate::Pending;
        };
        let (mut before, mut after, mut pending, mut unknown) = (0., 0., false, false);
        for entry in &tidy.convert.categories {
            if !categories.contains(&entry.category) || entry.files == 0 {
                continue;
            }
            before += entry.bytes as f64;
            let key = Self::ratio_key(root_id, entry.category, entry.files, entry.bytes);
            match self.ratios.get(&key) {
                None => pending = true,
                Some(None) => unknown = true,
                Some(Some(ratio)) => after += entry.bytes as f64 * ratio,
            }
        }
        if unknown {
            Estimate::Unknown
        } else if pending {
            Estimate::Pending
        } else {
            Estimate::Known { before, after }
        }
    }
}

/// The switches Convert last had on, all three at first (`readGroups`).
fn read_convert_groups(cx: &App) -> BTreeSet<ConvertGroup> {
    let stored = LocalStorage::get(cx, CONVERT_GROUPS_KEY)
        .and_then(|text| serde_json::from_str::<Vec<String>>(text).ok());
    match stored {
        Some(keys) => ConvertGroup::ALL
            .into_iter()
            .filter(|group| keys.iter().any(|key| key == group.key()))
            .collect(),
        None => ConvertGroup::ALL.into_iter().collect(),
    }
}
