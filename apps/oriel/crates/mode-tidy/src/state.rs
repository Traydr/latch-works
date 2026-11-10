//! What every Tidy page shares: the engine, its roots and settings, the folder on screen, the
//! page, Tidy's work, and a version that moves whenever the catalog changes, so the pages read
//! again.
//!
//! Pages observe this entity. They never touch the engine's work themselves: a scan, an analysis
//! or a change starts here as a job running one of the engine's operations, and the engine's
//! queue decides when it runs. Its progress reaches the shell from here: the switcher's ring and
//! the activity panel at the window's bottom right, whose Pause, Resume and Stop come back here.

use std::cell::Cell;
use std::collections::{BTreeSet, HashSet};
use std::path::PathBuf;

use gpui_kit::{App, AppContext as _, Context, Entity, SharedString, Subscription, Task, Window};
use oriel_core_paths::DataRoot;
use oriel_core_tidy::contract::{
    AudioState, CategoryCount, DuplicateScope, EncoderCapabilities, FileFlag, FileFormat, FileKind,
    OptimizeCategory, PreferredFolder, Root, RootId, Settings, Tidy,
};
use oriel_core_tidy::contract::{HoldingList, HoldingRequest};
use oriel_core_tidy::{AnalysisKind, FollowUp, Progress, TidyEngine};
use oriel_launch::storage_keys::TIDY_VIEW;
use oriel_runtime::{CancelToken, PauseToken};
use oriel_ui::ToastExt as _;
use oriel_ui::{
    ActivityJob, AnyJob, HandOff, Job, JobCommand, JobControl, JobEvent, JobReporter, LocalStorage,
    ModeActivity, ModeId, ModeReporter, ShellState, Toast, Work,
};

use crate::actions::{Ended, RunningChange, Tidied, UndoEntry};
use crate::loaded::{Loaded, TidyClient};
use crate::pages::TidyPage;

/// Tidy's root shown last, by its id.
const ROOT_KEY: &str = "oriel.tidy.root";
/// Convert's groups the owner closed, as a JSON array, under Electron Oriel's key.
const CONVERT_GROUPS_KEY: &str = "glazier.convert-groups";

/// The keys Tidy's jobs have in the activity panel, each followed by the job's number.
const CHANGE_JOB: &str = "change-";
const SCAN_JOB: &str = "scan-";
const ANALYSIS_JOB: &str = "analysis-";

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

/// Convert's three switches; videos cover both lossless and re-encoded moves
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

    /// The kind of file the group converts, which its "and N more" opens in the Library.
    pub fn kind(self) -> FileKind {
        match self {
            ConvertGroup::Videos => FileKind::Video,
            _ => FileKind::Image,
        }
    }

    pub fn target(self) -> &'static str {
        match self {
            ConvertGroup::Pictures => "AVIF",
            _ => "MP4",
        }
    }

    /// The files and bytes a group would convert.
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

/// Whether the engine is open; while it opens, the task opening it.
enum Engine {
    Opening { _opening: Task<()> },
    Ready(TidyClient),
    Failed(SharedString),
}

/// A job's reporter as the engine's progress.
pub(crate) struct Reporting(pub JobReporter);

impl Progress for Reporting {
    fn phase(&self, label: &str, total: u64) {
        self.0.begin_phase(label.to_owned(), total);
    }

    fn done(&self, done: u64) {
        self.0.set_done(done);
    }

    fn item(&self, item: Option<(&str, Option<f32>)>) {
        self.0.set_item(item);
    }

    fn cancel_token(&self) -> Option<&CancelToken> {
        Some(self.0.cancel_token())
    }

    fn pause_token(&self) -> Option<&PauseToken> {
        Some(self.0.pause_token())
    }

    fn waiting(&self, waiting: bool) {
        self.0.set_waiting(waiting);
    }

    fn background(&self, background: bool) {
        self.0.set_background(background);
    }
}

/// What a scan or analysis job does.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum TaskKind {
    /// A scan, or a change's follow-up that rescans.
    Scan,
    /// An analysis, or a change's follow-up that only analyses.
    Analysis,
}

/// A scan or an analysis of one root, and what watches it.
pub struct Running {
    pub root_id: RootId,
    pub job: AnyJob,
    id: u64,
    kind: TaskKind,
    _subscriptions: Vec<Subscription>,
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
    shell: Entity<ShellState>,
    data: DataRoot,
    engine: Engine,
    roots: Vec<Root>,
    settings: Option<Settings>,
    /// What this machine can encode with, once ffmpeg has said.
    capabilities: Option<EncoderCapabilities>,
    /// Whether the engine was asked for them: asking runs ffmpeg and loads libavif, so it waits
    /// until Settings or the Library's menu needs them.
    capabilities_asked: bool,
    root_id: Option<RootId>,
    page: TidyPage,
    catalog_version: u64,
    /// Overview's numbers for the folder on screen; the sidebar's counts read them too.
    overview: Loaded<Tidy>,
    /// The first of holding, for its size in the sidebar and on Overview.
    holding: Loaded<HoldingList>,
    /// Scans and analyses, running or waiting for their turn, in the order asked for.
    tasks: Vec<Running>,
    /// The sidebar's count of duplicate sets while an analysis runs (`duplicate_sets_shown`).
    held_sets: Cell<Option<i64>>,
    /// Changes, running or waiting for their turn, in the order asked for: the first is the
    /// change, the rest its queue.
    pub(crate) changes: Vec<RunningChange>,
    /// Numbers Tidy's work: its jobs and their keys.
    pub(crate) next_work: u64,
    /// ⌘Z's history, oldest first.
    pub(crate) undo: Vec<UndoEntry>,
    /// How many changes have landed on `undo`, so a waiting ⌘Z can tell if one has.
    pub(crate) undo_pushed: u64,
    /// How many Undos have stopped or not finished, their entries back on `undo`.
    pub(crate) undo_returned: u64,
    /// Decisions on their way to the catalog that will add to `undo` when they get there, and
    /// whether a ⌘Z waits for them.
    pub(crate) undo_entries_coming: usize,
    pub(crate) undo_waiting: bool,
    pub(crate) next_undo_key: u64,
    pub(crate) tidied: Option<Tidied>,
    requests: Requests,
    request_number: u64,
    convert_groups: BTreeSet<ConvertGroup>,
    /// Convert's categories whose estimate for the folder on screen has been asked for and not
    /// yet landed, and those whose estimate failed since the catalog last changed.
    estimating: HashSet<OptimizeCategory>,
    estimates_failed: HashSet<OptimizeCategory>,
}

/// An estimate of a set of files' size after converting, or why there is none yet.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Estimate {
    Pending,
    Unknown,
    Known { before: f64, after: f64 },
}

impl Estimate {
    /// Size after converting as a share of before.
    pub fn ratio(self) -> Option<f64> {
        match self {
            Estimate::Known { before, after } if before > 0. => Some(after / before),
            _ => None,
        }
    }

    /// "1.7 MB → about 700 KB", or what stands in for it.
    pub fn describe(self, bytes: f64) -> String {
        match self {
            Estimate::Pending => {
                format!("{} → estimating…", oriel_core_domain::format::bytes(bytes))
            }
            Estimate::Unknown => {
                format!("{} → size unknown", oriel_core_domain::format::bytes(bytes))
            }
            Estimate::Known { after, .. } => format!(
                "{} → about {}",
                oriel_core_domain::format::bytes(bytes),
                oriel_core_domain::format::bytes(after)
            ),
        }
    }
}

impl TidyState {
    /// What the last Tidy up did, until it is taken back.
    pub fn tidied(&self) -> Option<&Tidied> {
        self.tidied.as_ref()
    }

    /// Opens the engine over `data` in the background; the pages show "Starting…" until it is.
    pub fn new(
        shell: &Entity<ShellState>,
        data: DataRoot,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let page = LocalStorage::get(cx, TIDY_VIEW)
            .and_then(TidyPage::from_key)
            .unwrap_or(TidyPage::Overview);
        let convert_groups = read_convert_groups(cx);
        let opening = {
            let data = data.clone();
            cx.spawn_in(window, async move |this, cx| {
                let opened = cx
                    .background_spawn(
                        async move { futures::executor::block_on(TidyEngine::open(data)) },
                    )
                    .await;
                this.update_in(cx, |this, window, cx| {
                    this.engine_opened(opened, window, cx);
                })
                .ok();
            })
        };
        Self {
            shell: shell.clone(),
            data,
            engine: Engine::Opening { _opening: opening },
            roots: Vec::new(),
            settings: None,
            capabilities: None,
            capabilities_asked: false,
            root_id: None,
            page,
            catalog_version: 0,
            overview: Loaded::default(),
            holding: Loaded::default(),
            tasks: Vec::new(),
            held_sets: Cell::new(None),
            changes: Vec::new(),
            next_work: 0,
            undo: Vec::new(),
            undo_pushed: 0,
            undo_returned: 0,
            undo_entries_coming: 0,
            undo_waiting: false,
            next_undo_key: 0,
            tidied: None,
            requests: Requests::default(),
            request_number: 0,
            convert_groups,
            estimating: HashSet::new(),
            estimates_failed: HashSet::new(),
        }
    }

    fn engine_opened(
        &mut self,
        opened: anyhow::Result<TidyEngine>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        match opened {
            Ok(engine) => {
                let engine = TidyClient::new(engine);
                self.engine = Engine::Ready(engine.clone());
                cx.spawn_in(window, async move |this, cx| {
                    let (roots, settings) = (
                        engine.ask(|engine| engine.roots(), cx).await,
                        engine.ask(|engine| engine.settings(), cx).await,
                    );
                    this.update_in(cx, |this, window, cx| {
                        match (roots, settings) {
                            (Ok(roots), Ok(settings)) => {
                                this.settings = Some(settings);
                                let stored = LocalStorage::get(cx, ROOT_KEY)
                                    .and_then(|id| id.parse::<RootId>().ok());
                                this.set_roots(roots, stored, cx);
                                this.check_analysis_due(window, cx);
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

    pub fn shell(&self) -> &Entity<ShellState> {
        &self.shell
    }

    pub fn data(&self) -> &DataRoot {
        &self.data
    }

    pub fn engine(&self) -> Option<&TidyClient> {
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

    /// Why Overview's numbers could not be read, when they could not.
    pub fn overview_error(&self) -> Option<&SharedString> {
        self.overview.error()
    }

    /// The first of holding for the folder on screen, for its size.
    pub fn holding_preview(&self) -> Option<&HoldingList> {
        self.holding.data()
    }

    pub fn settings(&self) -> Option<&Settings> {
        self.settings.as_ref()
    }

    /// What this machine can encode with, once known: see [`TidyState::ask_capabilities`].
    pub fn capabilities(&self) -> Option<&EncoderCapabilities> {
        self.capabilities.as_ref()
    }

    /// Asks the engine once what this machine can encode with, for Settings' Encoders row and
    /// Convert's videos.
    pub fn ask_capabilities(&mut self, cx: &mut Context<Self>) {
        if self.capabilities_asked {
            return;
        }
        let Some(capabilities) = self
            .engine()
            .map(|engine| engine.ask(|engine| engine.capabilities(), cx))
        else {
            return;
        };
        self.capabilities_asked = true;
        cx.spawn(async move |this, cx| {
            let capabilities = capabilities.await;
            this.update(cx, |this, cx| match capabilities {
                Ok(capabilities) => {
                    this.capabilities = Some(capabilities);
                    cx.notify();
                }
                Err(error) => log::warn!("Tidy could not list its encoders: {error:#}"),
            })
            .ok();
        })
        .detach();
    }

    pub fn page(&self) -> TidyPage {
        self.page
    }

    /// Moves whenever the catalog may have changed.
    pub fn catalog_version(&self) -> u64 {
        self.catalog_version
    }

    /// The first scan asked for, which runs or is next to.
    pub fn scan(&self) -> Option<&Running> {
        self.tasks.iter().find(|task| task.kind == TaskKind::Scan)
    }

    /// The count of duplicate sets for the sidebar. An analysis takes similar sets apart and finds
    /// them again as it goes, so what the catalog holds can swing from 14 to 4 and back while the
    /// sets are no different. Until it ends the count only rises, and a change the owner made
    /// starts it afresh.
    pub fn duplicate_sets_shown(&self, sets: i64) -> i64 {
        if self.analysis().is_none() {
            self.held_sets.set(None);
            return sets;
        }
        let shown = self.held_sets.get().map_or(sets, |held| held.max(sets));
        self.held_sets.set(Some(shown));
        shown
    }

    /// A change has moved sets, so the sidebar's count starts again from what the catalog holds.
    pub(crate) fn forget_held_sets(&self) {
        self.held_sets.set(None);
    }

    /// The first analysis asked for, which runs or is next to.
    pub fn analysis(&self) -> Option<&Running> {
        self.tasks
            .iter()
            .find(|task| task.kind == TaskKind::Analysis)
    }

    /// Every analysis, running or waiting for its turn, in the order asked for.
    pub fn analyses(&self) -> impl Iterator<Item = &Running> {
        self.tasks
            .iter()
            .filter(|task| task.kind == TaskKind::Analysis)
    }

    /// Whether a scan of `root_id` runs or waits.
    pub fn is_scanning(&self, root_id: RootId) -> bool {
        self.tasks
            .iter()
            .any(|task| task.kind == TaskKind::Scan && task.root_id == root_id)
    }

    /// Whether any scan, analysis or change runs or waits for its turn.
    pub fn is_busy(&self) -> bool {
        !self.tasks.is_empty() || !self.changes.is_empty()
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
            LocalStorage::set(cx, TIDY_VIEW, page.key());
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

    /// Open in View: a file in View's viewer, or a folder. The shell takes it
    /// from here.
    pub fn open_in_view(&mut self, path: impl Into<PathBuf>, cx: &mut Context<Self>) {
        let target = HandOff::File(path.into());
        self.shell
            .update(cx, |shell, cx| shell.hand_off(ModeId::View, target, cx));
    }

    /// Sync this folder: Sync shows its profile for it, or starts one.
    pub fn sync_folder(&mut self, folder: impl Into<PathBuf>, cx: &mut Context<Self>) {
        let target = HandOff::Folder(folder.into());
        self.shell
            .update(cx, |shell, cx| shell.hand_off(ModeId::Sync, target, cx));
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
        self.forget_root_reads();
        self.changed(cx);
    }

    /// Asks whether the root on screen has analysis to catch up on when Tidy starts, such as prints
    /// an older version made: Duplicates suggests one copy of a whole set until they are made again.
    fn check_analysis_due(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let (Some(engine), Some(root_id)) = (self.engine().cloned(), self.root_id) else {
            return;
        };
        cx.spawn_in(window, async move |this, cx| {
            match engine
                .ask(move |engine| engine.analysis_due(root_id), cx)
                .await
            {
                Ok(true) => {
                    this.update_in(cx, |this, window, cx| {
                        this.start_quiet_analysis(root_id, AnalysisKind::CatchingUp, window, cx);
                    })
                    .ok();
                }
                Ok(false) => {}
                Err(error) => log::warn!("Tidy could not tell whether analysis is due: {error:#}"),
            }
        })
        .detach();
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
            self.forget_root_reads();
        }
        self.changed(cx);
    }

    /// The folder on screen is another: what was read for the last one goes.
    fn forget_root_reads(&mut self) {
        self.overview.clear();
        self.holding.clear();
        self.estimating.clear();
        self.estimates_failed.clear();
    }

    /// Reads the roots again (their counts change with every scan).
    pub fn reload_roots(&mut self, cx: &mut Context<Self>) {
        let Some(engine) = self.engine().cloned() else {
            return;
        };
        cx.spawn(async move |this, cx| {
            let roots = engine.ask(|engine| engine.roots(), cx).await;
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
        let added = self.add_root(folder, window, cx);
        cx.spawn_in(window, async move |_, cx| {
            if let Err(error) = added.await {
                cx.update(|window, cx| {
                    window.show_toast(Toast::error("Tidy can't add that folder").detail(error), cx);
                })
                .ok();
            }
        })
        .detach();
    }

    /// Adds `folder` as a root, shows it on Overview and starts its scan, as [`Self::add_folder`]
    /// does, leaving why it could not to the caller (the first start's welcome lists it).
    pub fn add_root(
        &mut self,
        folder: PathBuf,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Task<Result<RootId, SharedString>> {
        let Some(engine) = self.engine().cloned() else {
            let why = self
                .engine_error()
                .cloned()
                .unwrap_or_else(|| "Tidy is still starting.".into());
            return Task::ready(Err(why));
        };
        cx.spawn_in(window, async move |this, cx| {
            let added = engine.ask(move |engine| engine.add_root(&folder), cx).await;
            let roots = engine.ask(|engine| engine.roots(), cx).await;
            let root = added.map_err(|error| SharedString::from(format!("{error:#}")))?;
            this.update_in(cx, |this, window, cx| {
                if let Ok(roots) = roots {
                    this.set_roots(roots, Some(root.id), cx);
                }
                this.go(TidyPage::Overview, cx);
                this.start_scan(root.id, window, cx);
            })
            .map_err(|_| SharedString::from("Tidy closed."))?;
            Ok(root.id)
        })
    }

    /// Forgets a root and its catalog rows; the folder itself is untouched. What holding keeps for
    /// it goes to the Trash first, in its turn behind the changes asked for before, and the root
    /// stays if any of it cannot.
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
        // Asked before holding goes to the Trash, which cannot be taken back if the root then stays.
        if let Err(error) = engine.check_root_removable(root_id) {
            let toast = Toast::error("Couldn't forget the folder").detail(format!("{error:#}"));
            window.show_toast(toast, cx);
            return;
        }
        let emptied = engine.queue(|engine| engine.empty_holding(root_id));
        let label = format!("Forget “{name}”");
        self.run_holding_work(
            label,
            emptied,
            move |_, ended, window, cx| {
                let kept = match ended {
                    Ended::Withdrawn | Ended::Stopped => return,
                    Ended::Done(result) => !result.failed.is_empty(),
                    Ended::Failed(error) => {
                        log::warn!(
                            "Tidy could not empty holding of “{name}”: {}",
                            error.message()
                        );
                        true
                    }
                };
                if kept {
                    window.show_toast(
                        Toast::error(format!(
                            "Kept “{name}”: some held files could not go to the Trash."
                        )),
                        cx,
                    );
                    return;
                }
                let roots = engine.ask(move |engine| engine.remove_root(root_id), cx);
                cx.spawn_in(window, async move |this, cx| {
                    let roots = roots.await;
                    this.update_in(cx, |this, window, cx| match roots {
                        Ok(roots) => this.set_roots(roots, None, cx),
                        Err(error) => window.show_toast(
                            Toast::error("Couldn't forget the folder").detail(format!("{error:#}")),
                            cx,
                        ),
                    })
                    .ok();
                })
                .detach();
            },
            window,
            cx,
        );
    }

    // Scans and analyses.

    /// Scans a root, unless a scan of it runs or waits already. The background analysis it calls
    /// for follows as a job of its own.
    pub fn start_scan(&mut self, root_id: RootId, window: &mut Window, cx: &mut Context<Self>) {
        if self.is_scanning(root_id) {
            return;
        }
        let Some(engine) = self.engine().cloned() else {
            return;
        };
        self.say_if_waiting_on_paused_work(window, cx);
        let scan = engine.queue(|engine| engine.scan(root_id));
        let job = Job::run_blocking("Scanning", "tidy scan", cx, move |reporter| {
            scan.run(&Reporting(reporter))
        });
        let analyze = cx.subscribe_in(
            &job,
            window,
            move |this, job, event: &JobEvent, window, cx| {
                if let (JobEvent::Succeeded, Some(report)) = (event, job.read(cx).value())
                    && report.analysis_due
                {
                    this.start_quiet_analysis(root_id, AnalysisKind::CatchingUp, window, cx);
                }
            },
        );
        self.add_task(TaskKind::Scan, root_id, job, vec![analyze], window, cx);
    }

    /// Fingerprints, detail prints and loudness for a root ("Check now"). With an analysis in the
    /// background already, that one runs as asked for from now on instead.
    pub fn start_analysis(&mut self, root_id: RootId, window: &mut Window, cx: &mut Context<Self>) {
        let Some(engine) = self.engine().cloned() else {
            return;
        };
        if self.analysis().is_some() {
            engine.promote_analysis(root_id);
            return;
        }
        self.say_if_waiting_on_paused_work(window, cx);
        self.start_quiet_analysis(root_id, AnalysisKind::AskedFor, window, cx);
    }

    /// The analysis due after a change or a settings change: it runs only while no asked-for work
    /// waits, and steps aside when some arrives. One already waiting for the root takes it in.
    pub fn start_background_analysis(
        &mut self,
        root_id: RootId,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.start_quiet_analysis(root_id, AnalysisKind::AfterChange, window, cx);
    }

    fn start_quiet_analysis(
        &mut self,
        root_id: RootId,
        kind: AnalysisKind,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(engine) = self.engine().cloned() else {
            return;
        };
        let analysis = engine.queue(|engine| engine.analyze(root_id, kind));
        let job = Job::run_blocking(
            "Finding similar versions",
            "tidy analysis",
            cx,
            move |reporter| analysis.run(&Reporting(reporter)),
        );
        self.add_task(TaskKind::Analysis, root_id, job, Vec::new(), window, cx);
    }

    /// Runs what a change left to do: its scans, in the change's place in the engine's queue,
    /// then the analysis due. One job, listed as a scan when it rescans.
    pub(crate) fn follow_up(
        &mut self,
        follow_up: FollowUp,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let (kind, root_id, name) = match (follow_up.rescan.first(), follow_up.analyze.first()) {
            (Some(root_id), _) => (TaskKind::Scan, *root_id, "Scanning"),
            (None, Some(root_id)) => (TaskKind::Analysis, *root_id, "Finding similar versions"),
            (None, None) => return,
        };
        let Some(engine) = self.engine().cloned() else {
            return;
        };
        let work = engine.queue(|engine| engine.follow_up(follow_up));
        let job = Job::run_blocking(name, "tidy follow-up", cx, move |reporter| {
            work.run(&Reporting(reporter))
        });
        self.add_task(kind, root_id, job, Vec::new(), window, cx);
    }

    /// Follows a scan or analysis job: its phases move the catalog's version, so the pages show
    /// what it has found so far, and its end takes it off the list and reads the roots again.
    fn add_task<T: Send + 'static>(
        &mut self,
        kind: TaskKind,
        root_id: RootId,
        job: Entity<Job<T>>,
        mut subscriptions: Vec<Subscription>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let id = self.next_work;
        self.next_work += 1;
        let mut phase = SharedString::default();
        subscriptions.push(cx.observe(&job, move |this, job, cx| {
            let now = job.read(cx).progress().phase().clone();
            if now != phase {
                phase = now;
                this.changed(cx);
            }
            this.report_activity(cx);
            cx.notify();
        }));
        subscriptions.push(cx.subscribe_in(
            &job,
            window,
            move |this, job, event: &JobEvent, window, cx| {
                let job = job.read(cx);
                let (name, worked) = (job.name().clone(), !job.progress().phase().is_empty());
                this.tasks.retain(|task| task.id != id);
                if let JobEvent::Failed(error) = event
                    && !error.is_cancelled()
                {
                    let toast = Toast::error(format!("{name} failed")).detail(error.message());
                    window.show_toast(toast, cx);
                }
                this.report_activity(cx);
                // What the job wrote after its last phase began shows now. Work that joined
                // another waiting for its turn wrote nothing.
                if worked {
                    this.changed(cx);
                    this.reload_roots(cx);
                }
                cx.notify();
            },
        ));
        self.tasks.push(Running {
            root_id,
            job: job.into(),
            id,
            kind,
            _subscriptions: subscriptions,
        });
        self.report_activity(cx);
        cx.notify();
    }

    /// Stops the scan or analysis running; what it finished stays. The owner asks for quiet, so
    /// what waits goes too.
    pub fn stop_work(&mut self, cx: &mut Context<Self>) {
        if let Some(task) = self.scan().or(self.analysis()) {
            let (id, job) = (task.id, task.job.clone());
            self.stop_waiting_tasks(id, cx);
            job.cancel(cx);
        }
    }

    /// Stops and lets go of every scan and analysis but `kept` that has not begun (waiting for
    /// its turn, or not yet said): it goes from the list at once, as it never ran.
    fn stop_waiting_tasks(&mut self, kept: u64, cx: &mut Context<Self>) {
        self.tasks.retain(|task| {
            let waiting = task.id != kept && task.job.progress(cx).phase().is_empty();
            if waiting {
                task.job.cancel(cx);
            }
            !waiting
        });
        self.report_activity(cx);
        cx.notify();
    }

    /// Pause, Resume or Stop pressed in the activity panel on one of Tidy's jobs. A paused job
    /// finishes the step in flight first; a stopped one keeps what it finished.
    pub fn on_job_command(&mut self, command: &JobCommand, cx: &mut Context<Self>) {
        let key = command.key();
        if let Some(index) = self
            .changes
            .iter()
            .position(|change| Self::change_key(change) == key)
        {
            match command.control() {
                // Behind the first, Stop takes it off the queue.
                JobControl::Stop => self.stop_change_at(index, index > 0, cx),
                pause => self.changes[index]
                    .job
                    .set_paused(pause == JobControl::Pause, cx),
            }
        } else if let Some((id, task)) = self
            .tasks
            .iter()
            .find(|task| Self::task_key(task) == key)
            .map(|task| (task.id, task.job.clone()))
        {
            match command.control() {
                JobControl::Stop => {
                    self.stop_waiting_tasks(id, cx);
                    task.cancel(cx);
                }
                pause => task.set_paused(pause == JobControl::Pause, cx),
            }
        }
        self.report_activity(cx);
    }

    /// A scan's or an analysis's key in the activity panel, which stays its own while it runs.
    fn task_key(task: &Running) -> String {
        match task.kind {
            TaskKind::Scan => format!("{SCAN_JOB}{}", task.id),
            TaskKind::Analysis => format!("{ANALYSIS_JOB}{}", task.id),
        }
    }

    /// A change's key in the activity panel, which stays its own while it waits and runs.
    fn change_key(change: &RunningChange) -> String {
        format!("{CHANGE_JOB}{}", change.id)
    }

    /// Whether a scan or an analysis holds the turn, paused. Paused background analysis steps
    /// aside for what the owner asks for, so it holds nothing.
    fn paused_quiet_work(&self, cx: &App) -> bool {
        self.tasks.iter().any(|task| {
            let progress = task.job.progress(cx);
            progress.is_paused() && (task.kind == TaskKind::Scan || !progress.is_background())
        })
    }

    /// What the owner just asked for waits behind paused work until they resume or stop it, which
    /// nothing else will: says so, rather than leaving a queued line in the activity panel.
    pub(crate) fn say_if_waiting_on_paused_work(
        &self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let paused_change = self
            .changes
            .first()
            .is_some_and(|change| change.job.progress(cx).is_paused());
        if paused_change || self.paused_quiet_work(cx) {
            let toast = Toast::info("Waiting for paused work")
                .detail("This goes on once that work is resumed or stopped.");
            window.show_toast(toast, cx);
        }
    }

    /// Tells the shell what Tidy is doing: on the switcher, a ring while a change runs and a dot
    /// while a scan or an analysis does; in the activity panel, every job, the changes first.
    /// Quitting waits for a change, unless it is paused, which cannot finish (one piece of work
    /// runs at a time), or waits for its turn behind a paused scan or analysis, and so has touched
    /// nothing yet.
    pub(crate) fn report_activity(&mut self, cx: &mut Context<Self>) {
        let (shown, holds_quit) = match self.changes.first() {
            Some(change) => {
                let progress = change.job.progress(cx);
                let stuck =
                    progress.is_paused() || (progress.is_waiting() && self.paused_quiet_work(cx));
                let ratio = progress.fraction_with_item().unwrap_or(0.);
                (Some(ModeActivity::Progress(ratio)), !stuck)
            }
            None if self.tasks.is_empty() => (None, false),
            None => (Some(ModeActivity::Working), false),
        };
        let jobs = self.activity_jobs(cx);
        ModeReporter::new(&self.shell, ModeId::Tidy).report(
            Work {
                shown,
                holds_quit,
                jobs,
            },
            cx,
        );
    }

    /// Tidy's jobs as the activity panel lists them: the change, the scans and analyses, then the
    /// changes queued behind the first, each as the engine says it stands.
    fn activity_jobs(&self, cx: &App) -> Vec<ActivityJob> {
        let changes = (0..self.changes.len()).filter_map(|index| {
            let change = &self.changes[index];
            if change.withdrawn(cx) {
                return None;
            }
            let key = Self::change_key(change);
            Some(if index == 0 {
                change.job.activity(key, cx)
            } else {
                // Behind another change, it is the change asked for, not yet a plan.
                ActivityJob::new(key, change.label.clone())
                    .state(oriel_ui::JobState::Queued)
                    .stoppable(true)
            })
        });
        let mut jobs: Vec<ActivityJob> = changes.collect();
        let queued = jobs.split_off(jobs.len().min(1));
        jobs.extend(
            self.tasks
                .iter()
                .map(|task| task.job.activity(Self::task_key(task), cx)),
        );
        jobs.extend(queued);
        jobs
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
        let update = engine.ask(|engine| engine.update_settings(settings), cx);
        cx.spawn_in(window, async move |this, cx| {
            let update = update.await;
            this.update_in(cx, |this, window, cx| match update {
                Ok(update) => {
                    this.settings = Some(update.settings);
                    this.changed(cx);
                    if update.analyze
                        && let Some(root_id) = this.root_id
                    {
                        this.start_background_analysis(root_id, window, cx);
                    }
                }
                Err(error) => window.show_toast(
                    Toast::error("Couldn't change the setting").detail(format!("{error:#}")),
                    cx,
                ),
            })
            .ok();
        })
        .detach();
    }

    /// Makes a folder inside the root on screen preferred for duplicate review, with a toast and
    /// ⌘Z to take it back.
    pub fn prefer_folder(&mut self, dir: String, window: &mut Window, cx: &mut Context<Self>) {
        let (Some(settings), Some(root_id)) = (self.settings.clone(), self.root_id) else {
            return;
        };
        let label = crate::labels::folder(&dir).to_owned();
        if settings
            .preferred_folders
            .iter()
            .any(|entry| entry.root_id == root_id && entry.dir == dir)
        {
            let toast = Toast::info(format!("{label} is already preferred"));
            window.show_toast(toast, cx);
            return;
        }
        let before = settings.clone();
        let mut next = settings;
        next.preferred_folders
            .push(PreferredFolder { root_id, dir });
        self.update_settings(next, window, cx);
        let restore = before.clone();
        let undo = self.push_undo(move |state, window, cx| {
            state.update_settings(restore.clone(), window, cx);
            window.show_toast(Toast::info("Undid the preferred folder"), cx);
        });
        let this = cx.entity().downgrade();
        let toast = Toast::done(format!("Preferring {label}"))
            .detail("Duplicate sets keep their copy there first.")
            .action("Undo", move |window, cx| {
                let before = before.clone();
                this.update(cx, |state, cx| {
                    state.drop_undo(undo);
                    state.update_settings(before, window, cx);
                })
                .ok();
            });
        window.show_toast(toast, cx);
    }

    /// The catalog may have changed: every page reads again, and so do Overview's numbers and
    /// holding's size.
    pub fn changed(&mut self, cx: &mut Context<Self>) {
        self.catalog_version += 1;
        self.estimates_failed.clear();
        self.read_overview(cx);
        if let (Some(engine), Some(root_id)) = (self.engine(), self.root_id) {
            let request = HoldingRequest {
                root_id,
                offset: 0,
                limit: 1,
            };
            let holding = engine.ask(|engine| engine.list_holding(request), cx);
            self.holding.load(holding, |this| &mut this.holding, cx);
        }
        cx.notify();
    }

    /// Reads Overview's numbers again, then asks for the estimates they lack.
    fn read_overview(&mut self, cx: &mut Context<Self>) {
        let (Some(engine), Some(root_id)) = (self.engine(), self.root_id) else {
            return;
        };
        let overview = engine.ask(move |engine| engine.overview(root_id), cx);
        self.overview.load_then(
            overview,
            |this| &mut this.overview,
            Self::want_estimates,
            cx,
        );
    }
}

impl TidyState {
    /// Asks for an estimate of each category Overview counts that has none yet. Each converts a
    /// small sample once and the engine keeps it, so Overview read again carries it.
    fn want_estimates(&mut self, cx: &mut Context<Self>) {
        let (Some(engine), Some(root_id), Some(tidy)) =
            (self.engine().cloned(), self.root_id, self.overview.data())
        else {
            return;
        };
        let wanted: Vec<OptimizeCategory> = tidy
            .convert
            .categories
            .iter()
            .filter(|entry| entry.files > 0 && entry.estimate.is_none())
            .map(|entry| entry.category)
            .filter(|category| {
                !self.estimating.contains(category) && !self.estimates_failed.contains(category)
            })
            .collect();
        for category in wanted {
            self.estimating.insert(category);
            let estimate = engine.ask(
                move |engine| engine.estimate_optimize(root_id, category),
                cx,
            );
            cx.spawn(async move |this, cx| {
                let estimate = estimate.await;
                this.update(cx, |this, cx| {
                    if this.root_id != Some(root_id) || !this.estimating.remove(&category) {
                        return;
                    }
                    match estimate {
                        Ok(_) => this.read_overview(cx),
                        Err(error) => {
                            log::warn!("Tidy could not estimate {category}: {error:#}");
                            this.estimates_failed.insert(category);
                            cx.notify();
                        }
                    }
                })
                .ok();
            })
            .detach();
        }
    }

    /// What converting `categories` would leave, summed; a category that failed makes the sum
    /// unknown.
    pub fn estimate(&self, categories: &[OptimizeCategory]) -> Estimate {
        self.estimate_of(categories, |entry| entry.bytes)
    }

    /// [`Self::estimate`] for what stays once the open duplicate sets' suggestions are taken: the
    /// difference is what converting would save on copies those sets would remove.
    pub fn estimate_beside_duplicates(&self, categories: &[OptimizeCategory]) -> Estimate {
        self.estimate_of(categories, |entry| entry.bytes - entry.duplicate_bytes)
    }

    fn estimate_of(
        &self,
        categories: &[OptimizeCategory],
        counted: impl Fn(&CategoryCount) -> i64,
    ) -> Estimate {
        let Some(tidy) = self.overview.data() else {
            return Estimate::Pending;
        };
        let (mut before, mut after, mut pending, mut unknown) = (0., 0., false, false);
        for entry in &tidy.convert.categories {
            if !categories.contains(&entry.category) || entry.files == 0 {
                continue;
            }
            before += counted(entry) as f64;
            match &entry.estimate {
                Some(estimate) if estimate.sampled > 0 => {
                    after += counted(entry) as f64 * estimate.ratio;
                }
                Some(_) => unknown = true,
                None if self.estimates_failed.contains(&entry.category) => unknown = true,
                None => pending = true,
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

/// The switches Convert last had on, all three at first.
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
