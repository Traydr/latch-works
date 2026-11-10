//! Sync: Lockstep as one of Oriel's modes, Phase 4 of plan 063.
//!
//! The profiles are in the sidebar; the active profile's plan is the page, as a tree of what to
//! upload, update and delete; Push and Prune run with the run panel floating over the plan's
//! lower right, and the run log (⌘L) along the bottom. The engine is `oriel-core-sync`, run on
//! the app's tokio thread; profiles and tokens are kept in `DataRoot::sync()` in the formats
//! Electron Oriel wrote ([`profiles`], [`secrets`]), and the hash cache in
//! `DataRoot::hash_cache()`.
//!
//! One run goes at a time, and a run holds the profile it started with. Plan compares sizes
//! alone, Push plans again with hashes where they tell files apart, and Prune applies the deletes
//! of the plan on screen once.
//!
//! The profile menu's Open in View and Tidy this folder go to the shell as hand-off requests; a
//! folder another mode hands Sync arrives through its `show_hand_off`.

mod check;
mod plan_tree;
mod profiles;
mod run;
mod secrets;
mod shortcuts;
mod view;

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Instant, SystemTime};

use futures::StreamExt as _;
use gpui_kit::component::input::{InputEvent, InputState};
use gpui_kit::{
    AnyElement, App, AppContext as _, Context, Entity, FocusHandle, Focusable, IntoElement as _,
    PathPromptOptions, Render, SharedString, Subscription, Task, UniformListScrollHandle, Window,
    actions,
};
use oriel_core_domain::format;
use oriel_core_paths::DataRoot;
use oriel_core_sync::SyncPlanAction;
use oriel_core_sync::{
    ApiTarget, DoctorOptions, DoctorResult, HashMode, LockstepPlan, Observer, PaneViewClient,
    PlanOptions, PruneOptions, PushOptions, RunAction, RunEvent, RunStatus, RunSummary,
    UnfinalizedSyncRun, doctor, plan_sync, prune_deleted, push_changes,
};
use oriel_launch::Launch;
use oriel_runtime::{CancelToken, Cancelled, TokioRuntime};
use oriel_ui::folders::closest_folder;
use oriel_ui::shortcuts::Sheet;
use oriel_ui::{
    ActivityJob, Command, FolderSetUp, Foot, HandOff, JobCommand, JobControl, Mode, ModeActivity,
    ModeId, ModeReporter, ShellState, Work,
};

use plan_tree::PlanRow;
use profiles::ProfilePatch;
use run::{ItemState, PathIndex, RunPhase, RunState};

pub use check::SYNC_CHECK;
pub use profiles::{LastRun, Profile, ProfileInput, ProfileStore, TokenState};
pub use run::PruneAvailability;
pub use secrets::FileSecretStorage;

/// How much of the window's foot the run log takes while it is open.
const LOG_FOOT: gpui_kit::Pixels = gpui_kit::px(276.);

/// The run's key in the shell's activity panel: Sync runs one thing at a time.
const RUN_JOB: &str = "run";

/// The run log's keys.
const RUN_LOG_KEYS: &str = oriel_ui::cmd_or_ctrl!("l");

actions!(
    sync,
    [
        /// The run log, open or closed (⌘L).
        ToggleRunLog,
        /// The plan's path filter takes the keys (/, outside a text field).
        FocusPlanFilter
    ]
);

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Screen {
    /// The active profile's plan, or the welcome before any profile.
    Workspace,
    /// The profile form: a new profile, or the one with this id.
    Form { editing: Option<String> },
}

/// The plan on screen and what it was made against, so Prune applies what the user reviewed.
#[derive(Clone, Debug)]
pub struct ReviewedPlan {
    pub id: String,
    pub plan: Arc<LockstepPlan>,
    pub profile_id: String,
    pub api_url: String,
    pub source_root: String,
    pub planned_at: SystemTime,
}

/// Which items the plan shows while a push or prune is on screen.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RunFilter {
    All,
    Remaining,
    Done,
    Failed,
}

pub(crate) struct ProfileForm {
    name: Entity<InputState>,
    api_url: Entity<InputState>,
    source_root: Entity<InputState>,
    token: Entity<InputState>,
    clear_token: bool,
}

/// One row of the plan tree as the list draws it, owned so the list can be redrawn without the
/// tree borrowed.
#[derive(Clone, Debug, PartialEq)]
pub(crate) enum RowModel {
    Folder {
        depth: usize,
        path: String,
        label: String,
        size: u64,
        item_count: usize,
        open: bool,
        /// The plan's items in this folder and below it, by their place in the plan.
        items: Arc<Vec<usize>>,
    },
    File {
        depth: usize,
        path: String,
        name: String,
        action: SyncPlanAction,
        size: Option<u64>,
        /// Its place in the plan.
        item: usize,
    },
    More {
        depth: usize,
        folder: String,
        label: String,
        hidden: usize,
    },
}

/// What the page needs of the plan on screen at each keystroke and frame, worked out once, off
/// the main thread, when the plan arrives.
#[derive(Clone, Debug)]
pub(crate) struct PlanFacts {
    /// Each item's path in lower case, for the path filter; empty for a keep, never listed.
    lower_paths: Vec<String>,
    /// Each item's [`plan_tree::TreeInput::name_rank`] among the changes; 0 for a keep.
    name_ranks: Vec<u32>,
    /// The bytes of the items of each action: their local sizes, or the remote ones.
    bytes: HashMap<SyncPlanAction, u64>,
    /// How many items are not keeps.
    pub(crate) changes: usize,
    /// The changes by path, for the run's events, which name their items by path.
    paths: Arc<PathIndex>,
}

impl PlanFacts {
    fn of(plan: &Arc<LockstepPlan>) -> Self {
        let changes: Vec<usize> = (0..plan.items.len())
            .filter(|&at| plan.items[at].action != SyncPlanAction::Keep)
            .collect();
        let ranks = plan_tree::name_order(changes.iter().map(|&at| plan.items[at].path.as_str()));
        let mut name_ranks = vec![0; plan.items.len()];
        let mut lower_paths = vec![String::new(); plan.items.len()];
        for (&at, rank) in changes.iter().zip(&ranks) {
            name_ranks[at] = *rank;
            lower_paths[at] = plan.items[at].path.to_lowercase();
        }
        let mut bytes = HashMap::new();
        for item in &plan.items {
            *bytes.entry(item.action).or_default() += item_size(item).unwrap_or(0);
        }
        Self {
            lower_paths,
            name_ranks,
            bytes,
            changes: changes.len(),
            paths: Arc::new(PathIndex::of(plan.clone(), &changes)),
        }
    }

    pub(crate) fn bytes(&self, action: SyncPlanAction) -> u64 {
        self.bytes.get(&action).copied().unwrap_or(0)
    }

    /// The bytes a push would send: the uploads' and the updates'.
    pub(crate) fn push_bytes(&self) -> u64 {
        self.bytes(SyncPlanAction::Upload) + self.bytes(SyncPlanAction::Update)
    }
}

/// The bytes an item moves or names: its local size, else its remote one.
fn item_size(item: &oriel_core_sync::SyncPlanItem) -> Option<u64> {
    item.local
        .as_ref()
        .map(|local| local.size)
        .or(item.remote.as_ref().map(|remote| remote.size))
}

pub struct SyncMode {
    shell: Entity<ShellState>,
    reporter: ModeReporter,
    data: DataRoot,
    store: ProfileStore,
    screen: Screen,
    form: ProfileForm,
    session_token: Entity<InputState>,
    filter: Entity<InputState>,
    plan: Option<ReviewedPlan>,
    plan_facts: Option<PlanFacts>,
    rows: Vec<RowModel>,
    open_overrides: HashMap<String, bool>,
    show_all_files: HashSet<String>,
    action_filter: HashSet<SyncPlanAction>,
    run_filter: RunFilter,
    show_skipped: bool,
    pruned_plan_id: Option<String>,
    push_completed: bool,
    doctor_result: Option<DoctorResult>,
    run: RunState,
    cancel: Option<CancelToken>,
    run_task: Option<Task<()>>,
    log_open: bool,
    dismissed_run: Option<Instant>,
    error: Option<String>,
    /// The question an open confirmation asks, until it is answered.
    confirmation: Option<String>,
    focus_handle: FocusHandle,
    scroll: UniformListScrollHandle,
    /// What another mode handed Sync while a run held the profile on screen.
    pending_hand_off: Option<HandOff>,
    /// How tall the token's band and the run panel were drawn last, for the window's foot, which
    /// the activity panel and toasts stand on.
    pub(crate) band_height: gpui_kit::Pixels,
    pub(crate) panel_height: gpui_kit::Pixels,
    _subscriptions: Vec<Subscription>,
}

impl SyncMode {
    /// Sync keeping its profiles under the launch's data root, set up for the checks the launch
    /// asks for.
    pub fn new(
        shell: &Entity<ShellState>,
        launch: &Launch,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let data = &launch.data;
        let checks = check::SyncChecks::of(launch);
        let reporter = ModeReporter::new(shell, ModeId::Sync);
        let (store, error) = ProfileStore::open(data);
        let input = |placeholder: &'static str,
                     masked: bool,
                     window: &mut Window,
                     cx: &mut Context<Self>| {
            cx.new(|cx| {
                InputState::new(window, cx)
                    .placeholder(placeholder)
                    .masked(masked)
            })
        };
        let form = ProfileForm {
            name: input("Local archive", false, window, cx),
            api_url: input("http://localhost:3000", false, window, cx),
            source_root: input("/path/to/archive", false, window, cx),
            token: input(SAVED_TOKEN_PLACEHOLDER, true, window, cx),
            clear_token: false,
        };
        let session_token = input(SAVED_TOKEN_PLACEHOLDER, true, window, cx);
        let filter = input("Filter paths", false, window, cx);
        let subscriptions = vec![
            cx.observe(shell, |_, _, cx| cx.notify()),
            reporter.on_command(window, cx, |this, command, _, cx| {
                this.on_job_command(command, cx);
            }),
            cx.subscribe_in(&filter, window, |this, _, event: &InputEvent, _, cx| {
                if matches!(event, InputEvent::Change) {
                    this.rebuild_rows(cx);
                }
            }),
            // Sync takes the keys when it comes on screen, so ⌘L and / reach it.
            cx.observe_in(shell, window, |this, shell, window, cx| {
                if shell.read(cx).shows(ModeId::Sync)
                    && !this.focus_handle.contains_focused(window, cx)
                {
                    this.focus_handle.focus(window, cx);
                }
            }),
        ];
        let mut sync = Self {
            shell: shell.clone(),
            reporter,
            data: data.clone(),
            store,
            screen: Screen::Workspace,
            form,
            session_token,
            filter,
            plan: None,
            plan_facts: None,
            rows: Vec::new(),
            open_overrides: HashMap::new(),
            show_all_files: HashSet::new(),
            action_filter: HashSet::new(),
            run_filter: RunFilter::All,
            show_skipped: false,
            pruned_plan_id: None,
            push_completed: false,
            doctor_result: None,
            run: RunState::default(),
            cancel: None,
            run_task: None,
            log_open: false,
            dismissed_run: None,
            error,
            confirmation: None,
            focus_handle: cx.focus_handle(),
            scroll: UniformListScrollHandle::new(),
            pending_hand_off: None,
            band_height: gpui_kit::px(0.),
            panel_height: gpui_kit::px(0.),
            _subscriptions: subscriptions,
        };
        if checks.plan {
            sync.plan_now(window, cx);
        }
        if let Some(check) = checks.check {
            sync.apply_check(check, window, cx);
        }
        sync
    }

    /// The folders Sync pushes, its profiles' sources, for the other modes to be offered.
    pub fn source_roots(&self) -> Vec<PathBuf> {
        self.store
            .profiles()
            .iter()
            .filter(|profile| !profile.source_root.is_empty())
            .map(|profile| PathBuf::from(&profile.source_root))
            .collect()
    }

    /// Shows what another mode handed Sync (Sync this folder): the profile whose source holds
    /// it, or a new profile's form with the folder and its name filled in. A run holds the
    /// profile it started with, so a hand-off during one waits for it to end.
    fn take_hand_off(&mut self, target: HandOff, window: &mut Window, cx: &mut Context<Self>) {
        if self.run_holds_profile() {
            self.pending_hand_off = Some(target);
            return;
        }
        let folder = target.folder().to_path_buf();
        let holder = closest_folder(self.store.profiles(), &folder, |profile| {
            std::path::Path::new(&profile.source_root)
        })
        .map(|profile| profile.id.clone());
        match holder {
            Some(id) => self.select_profile(&id, window, cx),
            None => self.start_create_profile_for(folder, window, cx),
        }
    }

    /// The profile menu's Open in View and Tidy this folder, for the active profile's source.
    pub(crate) fn hand_off_source(&mut self, to: ModeId, cx: &mut Context<Self>) {
        let Some(profile) = self.store.active_profile() else {
            return;
        };
        let target = HandOff::Folder(PathBuf::from(&profile.source_root));
        self.shell
            .update(cx, |shell, cx| shell.hand_off(to, target, cx));
    }

    /// Adds a profile in one step, as the first start's welcome sets Sync up: the profile, and
    /// its token kept encrypted. Says why when it cannot.
    pub fn add_profile(
        &mut self,
        input: ProfileInput,
        cx: &mut Context<Self>,
    ) -> Result<(), String> {
        self.store
            .create(input)
            .map_err(|error| error.to_string())?;
        cx.notify();
        Ok(())
    }

    pub fn form_name(&self, cx: &App) -> SharedString {
        self.form.name.read(cx).value()
    }

    pub fn form_source_root(&self, cx: &App) -> SharedString {
        self.form.source_root.read(cx).value()
    }

    /// How much of the window's foot Sync keeps for its own: the token's band, and the run panel
    /// and the log, which float over the plan's lower part.
    fn foot_height(&self) -> gpui_kit::Pixels {
        use gpui_kit::px;
        let band = match self.store.active_profile() {
            Some(profile)
                if self.store.token_state(&profile.id) != TokenState::Saved
                    || self.doctor_result.is_some() =>
            {
                self.band_height
            }
            _ => px(0.),
        };
        let panel = if self.shows_run_panel() && !self.run.running {
            self.panel_height + px(16.)
        } else {
            px(0.)
        };
        let log = if self.log_open { LOG_FOOT } else { px(0.) };
        band.max(panel).max(log)
    }

    pub fn profiles(&self) -> &ProfileStore {
        &self.store
    }

    pub fn screen(&self) -> &Screen {
        &self.screen
    }

    pub fn is_running(&self) -> bool {
        self.run.running
    }

    /// Whether a run holds the profile it started with: while it goes, no other profile may
    /// become active, and its profile may not be edited, deleted or run again.
    pub(crate) fn run_holds_profile(&self) -> bool {
        self.run.running
    }

    pub fn error(&self) -> Option<&str> {
        self.error.as_deref()
    }

    /// The question an open confirmation asks, such as Prune's "Delete 96 remote entries from …?".
    pub fn confirmation(&self) -> Option<&str> {
        self.confirmation.as_deref()
    }

    pub(crate) fn set_confirmation(&mut self, question: Option<String>, cx: &mut Context<Self>) {
        self.confirmation = question;
        cx.notify();
    }

    /// Whether Prune may run now, and if not, why.
    pub fn prune_availability(&self) -> PruneAvailability {
        run::prune_availability(
            self.plan
                .as_ref()
                .map(|reviewed| (reviewed.id.as_str(), reviewed.plan.counts)),
            self.pruned_plan_id.as_deref(),
            self.push_completed,
        )
    }

    /// The run panel shows while a run goes, and after a push or prune until closed.
    pub fn shows_run_panel(&self) -> bool {
        let item_run = matches!(
            self.run.progress.kind,
            Some(RunAction::Push | RunAction::Prune)
        );
        self.run.running
            || (item_run
                && self.run.progress.phase != RunPhase::Idle
                && self.run.progress.started_at.is_some()
                && self.run.progress.started_at != self.dismissed_run)
    }

    /// Whether the plan's rows show the run's state: a push or prune is on screen and queued.
    pub(crate) fn shows_run_state(&self) -> bool {
        self.shows_run_panel()
            && matches!(
                self.run.progress.kind,
                Some(RunAction::Push | RunAction::Prune)
            )
            && self.run.progress.queued_at.is_some()
    }

    /// What the shell shows of Sync's run: a ring once a push or prune knows its list, else a
    /// dot. A push or prune changes the server, so quitting waits for it.
    fn report_activity(&self, cx: &mut Context<Self>) {
        let changes_server = matches!(
            self.run.progress.kind,
            Some(RunAction::Push | RunAction::Prune)
        );
        let shown = self.run.running.then(|| {
            self.run
                .ratio()
                .filter(|_| changes_server)
                .map_or(ModeActivity::Working, ModeActivity::Progress)
        });
        self.reporter.report(
            Work {
                shown,
                holds_quit: self.run.running && changes_server,
                jobs: self.activity_job().into_iter().collect(),
            },
            cx,
        );
    }

    /// The run as the shell's activity panel lists it, while it runs: what it does, how far it
    /// has got, and Stop, which cancels it.
    fn activity_job(&self) -> Option<ActivityJob> {
        if !self.run.running {
            return None;
        }
        let progress = &self.run.progress;
        let item_run = matches!(progress.kind, Some(RunAction::Push | RunAction::Prune));
        let label = match progress.kind {
            Some(RunAction::Plan) => "Planning".to_owned(),
            Some(RunAction::Doctor) => "Checking connection".to_owned(),
            Some(RunAction::Push) if progress.queued_at.is_some() => "Pushing".to_owned(),
            Some(RunAction::Prune) if progress.queued_at.is_some() => "Pruning".to_owned(),
            Some(kind) => format!("Preparing {}", kind.as_str()),
            None => "Preparing run".to_owned(),
        };
        let mut job = ActivityJob::new(RUN_JOB, label).stoppable(true);
        if item_run && progress.queued_at.is_some() {
            let processed = progress.pushed + progress.failed + progress.skipped;
            let done = if progress.bytes_total > 0 {
                format!(
                    "{} of {}",
                    format::bytes(progress.bytes_done + progress.bytes_failed),
                    format::bytes(progress.bytes_total)
                )
            } else {
                format!(
                    "{} of {} items",
                    format::count(processed),
                    format::count(progress.item_total)
                )
            };
            let left = match self.run.remaining_ms() {
                Some(left) => format!("{} left", format::duration(Some(left))),
                None => "Estimating…".to_owned(),
            };
            job = job
                .progress(self.run.ratio().unwrap_or(0.))
                .detail(format!("{done} · {left}"));
        } else if progress.scan_files_found > 0 {
            job = job.detail(format!(
                "{} files · {} hashed",
                format::count(progress.scan_files_found),
                format::bytes(progress.bytes_hashed)
            ));
        } else if !self.run.label.is_empty() {
            job = job.detail(self.run.label.clone());
        }
        Some(job)
    }

    fn on_job_command(&mut self, command: &JobCommand, cx: &mut Context<Self>) {
        if command.key() == RUN_JOB && command.control() == JobControl::Stop {
            self.cancel_run(cx);
        }
    }

    /* Profiles */

    /// Opens the form for a new profile. A half-typed new profile stays across visits; an edited
    /// profile's values never carry over.
    pub fn start_create_profile(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if matches!(self.screen, Screen::Form { editing: Some(_) }) {
            self.fill_form(None, window, cx);
        }
        self.screen = Screen::Form { editing: None };
        cx.notify();
    }

    pub fn start_edit_profile(&mut self, id: &str, window: &mut Window, cx: &mut Context<Self>) {
        if self.run_holds_profile() {
            return;
        }
        let Some(profile) = self.store.profile(id).cloned() else {
            return;
        };
        self.error = None;
        self.fill_form(Some(&profile), window, cx);
        self.screen = Screen::Form {
            editing: Some(profile.id),
        };
        cx.notify();
    }

    fn fill_form(
        &mut self,
        profile: Option<&Profile>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let set = |input: &Entity<InputState>, value: &str, window: &mut Window, cx: &mut App| {
            let value = value.to_owned();
            input.update(cx, |input, cx| input.set_value(value, window, cx));
        };
        set(
            &self.form.name,
            profile.map_or("", |p| p.name.as_str()),
            window,
            cx,
        );
        set(
            &self.form.api_url,
            profile.map_or("", |p| p.api_url.as_str()),
            window,
            cx,
        );
        set(
            &self.form.source_root,
            profile.map_or("", |p| p.source_root.as_str()),
            window,
            cx,
        );
        set(&self.form.token, "", window, cx);
        self.form.clear_token = false;
        self.update_token_placeholder(profile.map(|profile| profile.id.as_str()), window, cx);
    }

    /// The token field's prompt says what an empty field does to the saved token.
    fn update_token_placeholder(&self, editing: Option<&str>, window: &mut Window, cx: &mut App) {
        let saved = editing.is_some_and(|id| self.store.token_state(id) != TokenState::None);
        let placeholder = if self.form.clear_token {
            "The saved token will be forgotten"
        } else if saved {
            "Leave blank to keep the saved token"
        } else {
            SAVED_TOKEN_PLACEHOLDER
        };
        self.form.token.update(cx, |input, cx| {
            input.set_placeholder(placeholder, window, cx)
        });
    }

    /// Fills the form's source folder, and its name when empty, from a folder another mode
    /// offers.
    pub fn start_create_profile_for(
        &mut self,
        folder: PathBuf,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.start_create_profile(window, cx);
        let name = folder
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default();
        let folder = folder.to_string_lossy().into_owned();
        self.form
            .source_root
            .update(cx, |input, cx| input.set_value(folder, window, cx));
        self.form
            .name
            .update(cx, |input, cx| input.set_value(name, window, cx));
    }

    pub fn cancel_profile_form(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if matches!(self.screen, Screen::Form { editing: Some(_) }) {
            self.fill_form(None, window, cx);
        }
        self.screen = Screen::Workspace;
        cx.notify();
    }

    pub(crate) fn set_clear_token(
        &mut self,
        clear: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.form.clear_token = clear;
        if clear {
            self.form
                .token
                .update(cx, |input, cx| input.set_value("", window, cx));
        }
        let editing = match &self.screen {
            Screen::Form { editing } => editing.clone(),
            Screen::Workspace => None,
        };
        self.update_token_placeholder(editing.as_deref(), window, cx);
        cx.notify();
    }

    pub fn submit_profile(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.error = None;
        let read = |input: &Entity<InputState>, cx: &App| input.read(cx).value().trim().to_owned();
        let name = read(&self.form.name, cx);
        let api_url = read(&self.form.api_url, cx);
        let source_root = read(&self.form.source_root, cx);
        let token = Some(read(&self.form.token, cx)).filter(|token| !token.is_empty());

        let saved = match &self.screen {
            Screen::Form { editing: Some(id) } => {
                let id = id.clone();
                let previous = self.store.profile(&id).cloned();
                let changed_token = token.is_some() || self.form.clear_token;
                self.store
                    .update(
                        &id,
                        ProfilePatch {
                            name: Some(name),
                            api_url: Some(api_url),
                            source_root: Some(source_root),
                            token,
                            clear_token: self.form.clear_token,
                        },
                    )
                    .map(|updated| {
                        let active = self.store.active_profile_id() == Some(id.as_str());
                        let moved = previous.is_none_or(|previous| {
                            previous.api_url != updated.api_url
                                || previous.source_root != updated.source_root
                        });
                        if active && moved {
                            self.clear_plan_state(cx);
                        }
                        if active && changed_token {
                            self.session_token
                                .update(cx, |input, cx| input.set_value("", window, cx));
                        }
                    })
            }
            _ => self
                .store
                .create(ProfileInput {
                    name,
                    api_url,
                    source_root,
                    token,
                })
                .map(drop),
        };
        match saved {
            Ok(()) => {
                self.fill_form(None, window, cx);
                self.screen = Screen::Workspace;
            }
            Err(error) => self.error = Some(error.to_string()),
        }
        cx.notify();
    }

    pub(crate) fn pick_source_folder(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let chosen = cx.prompt_for_paths(PathPromptOptions {
            files: false,
            directories: true,
            multiple: false,
            prompt: Some("Choose".into()),
        });
        let input = self.form.source_root.clone();
        let window_handle = window.window_handle();
        cx.spawn(async move |_, cx| {
            let Ok(Ok(Some(paths))) = chosen.await else {
                return;
            };
            let Some(folder) = paths.into_iter().next() else {
                return;
            };
            let folder = folder.to_string_lossy().into_owned();
            let _ = cx.update_window(window_handle, |_, window, cx| {
                input.update(cx, |input, cx| input.set_value(folder, window, cx));
            });
        })
        .detach();
    }

    /// Makes `id` the active profile, unless a run holds the current one.
    pub fn select_profile(&mut self, id: &str, window: &mut Window, cx: &mut Context<Self>) {
        if self.run_holds_profile() {
            return;
        }
        let changed = self.store.active_profile_id() != Some(id);
        if let Err(error) = self.store.set_active(id) {
            self.error = Some(error.to_string());
        } else if changed {
            self.reset_for_active_profile_change(window, cx);
        }
        self.screen = Screen::Workspace;
        cx.notify();
    }

    pub(crate) fn confirm_delete_profile(
        &mut self,
        id: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(profile) = self.store.profile(id).cloned() else {
            return;
        };
        if self.run_holds_profile() {
            return;
        }
        let this = cx.entity();
        let question = format!("Delete the profile \u{201c}{}\u{201d}?", profile.name);
        self.confirmation = Some(question.clone());
        view::confirm(
            &this.clone(),
            window,
            cx,
            question,
            "Its saved sync token is removed from this computer. Files in the source folder and \
             on Pane View are not touched.",
            "Delete profile",
            move |window, cx| {
                this.update(cx, |this, cx| this.delete_profile(&profile.id, window, cx));
            },
        );
    }

    pub fn delete_profile(&mut self, id: &str, window: &mut Window, cx: &mut Context<Self>) {
        if self.run_holds_profile() {
            return;
        }
        self.error = None;
        let was_active = self.store.active_profile_id() == Some(id);
        match self.store.delete(id) {
            Ok(()) => {
                if was_active {
                    self.reset_for_active_profile_change(window, cx);
                }
                if self.screen
                    == (Screen::Form {
                        editing: Some(id.to_owned()),
                    })
                {
                    self.fill_form(None, window, cx);
                    self.screen = Screen::Workspace;
                }
            }
            Err(error) => self.error = Some(error.to_string()),
        }
        cx.notify();
    }

    /// Drops the plan and the doctor's result, which describe one profile's folder and server.
    fn clear_plan_state(&mut self, cx: &mut Context<Self>) {
        self.plan = None;
        self.plan_facts = None;
        self.run.track(None);
        self.doctor_result = None;
        self.push_completed = false;
        self.action_filter.clear();
        self.run_filter = RunFilter::All;
        self.show_skipped = false;
        self.open_overrides.clear();
        self.show_all_files.clear();
        self.rebuild_rows(cx);
    }

    /// Another profile is active: nothing on screen may describe the previous one.
    fn reset_for_active_profile_change(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.clear_plan_state(cx);
        self.filter
            .update(cx, |input, cx| input.set_value("", window, cx));
        self.session_token
            .update(cx, |input, cx| input.set_value("", window, cx));
        if !self.run.running {
            self.run = RunState::default();
        }
    }

    /* Plan tree */

    /// Puts a new plan on screen, with what the page needs of it, and the filters and folders
    /// back as a new plan starts.
    fn show_plan(&mut self, reviewed: ReviewedPlan, facts: PlanFacts, cx: &mut Context<Self>) {
        self.run.track(Some(facts.paths.clone()));
        self.plan_facts = Some(facts);
        self.plan = Some(reviewed);
        self.push_completed = false;
        self.action_filter.clear();
        self.run_filter = RunFilter::All;
        self.open_overrides.clear();
        self.show_all_files.clear();
        self.rebuild_rows(cx);
    }

    /// Rebuilds the list's rows from the plan, the filters and the folders opened.
    pub(crate) fn rebuild_rows(&mut self, cx: &mut Context<Self>) {
        let (Some(reviewed), Some(facts)) = (&self.plan, &self.plan_facts) else {
            self.rows.clear();
            cx.notify();
            return;
        };
        let query = self.filter.read(cx).value().trim().to_lowercase();
        let showing_run = self.shows_run_state();
        let run = &self.run;
        let items = reviewed.plan.items.iter().enumerate().filter(|(at, item)| {
            item.action != SyncPlanAction::Keep
                && (query.is_empty() || facts.lower_paths[*at].contains(&query))
                && if showing_run {
                    let state = run.item(*at);
                    match self.run_filter {
                        RunFilter::All => true,
                        RunFilter::Done => state.is_some_and(ItemState::is_settled),
                        RunFilter::Failed => matches!(state, Some(ItemState::Failed(_))),
                        RunFilter::Remaining => {
                            matches!(state, None | Some(ItemState::Active))
                        }
                    }
                } else {
                    self.action_filter.is_empty() || self.action_filter.contains(&item.action)
                }
        });
        let tree = plan_tree::build_plan_tree(items.map(|(at, item)| plan_tree::TreeInput {
            action: item.action,
            path: &item.path,
            size: item_size(item),
            item: at,
            name_rank: facts.name_ranks[at],
        }));
        self.rows = plan_tree::flatten_plan_tree(&tree, &self.open_overrides, &self.show_all_files)
            .into_iter()
            .map(|row| match row {
                PlanRow::Folder {
                    depth,
                    folder,
                    open,
                } => RowModel::Folder {
                    depth,
                    path: folder.path.clone(),
                    label: folder.label.clone(),
                    size: folder.size,
                    item_count: folder.item_count,
                    open,
                    items: Arc::new(plan_tree::folder_items(folder)),
                },
                PlanRow::File { depth, file } => RowModel::File {
                    depth,
                    path: file.path.clone(),
                    name: file.name.clone(),
                    action: file.action,
                    size: file.size,
                    item: file.item,
                },
                PlanRow::More {
                    depth,
                    folder,
                    hidden,
                } => RowModel::More {
                    depth,
                    folder: folder.path.clone(),
                    label: folder.label.clone(),
                    hidden,
                },
            })
            .collect();
        cx.notify();
    }

    pub(crate) fn toggle_folder(&mut self, path: &str, open: bool, cx: &mut Context<Self>) {
        self.open_overrides.insert(path.to_owned(), !open);
        self.rebuild_rows(cx);
    }

    pub(crate) fn show_all_in(&mut self, folder: &str, cx: &mut Context<Self>) {
        self.show_all_files.insert(folder.to_owned());
        self.rebuild_rows(cx);
    }

    pub(crate) fn toggle_action_filter(&mut self, action: SyncPlanAction, cx: &mut Context<Self>) {
        if !self.action_filter.remove(&action) {
            self.action_filter.insert(action);
        }
        self.rebuild_rows(cx);
    }

    pub(crate) fn set_run_filter(&mut self, filter: RunFilter, cx: &mut Context<Self>) {
        self.run_filter = filter;
        self.rebuild_rows(cx);
    }

    pub(crate) fn toggle_skipped(&mut self, cx: &mut Context<Self>) {
        self.show_skipped = !self.show_skipped;
        cx.notify();
    }

    pub fn toggle_run_log(&mut self, cx: &mut Context<Self>) {
        self.log_open = !self.log_open;
        cx.notify();
    }

    pub(crate) fn dismiss_run_panel(&mut self, cx: &mut Context<Self>) {
        self.dismissed_run = self.run.progress.started_at;
        self.rebuild_rows(cx);
    }

    pub(crate) fn dismiss_doctor_result(&mut self, cx: &mut Context<Self>) {
        self.doctor_result = None;
        cx.notify();
    }

    /* Runs */

    /// The active profile's server and folder, with a token, for a run about to start: the saved
    /// token, or the one typed under the plan, which is saved (encrypted) first. None while a
    /// run holds the profile, or without a usable token.
    fn begin_run(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Option<(Profile, ApiTarget)> {
        if self.run_holds_profile() {
            return None;
        }
        let profile = self.store.active_profile()?.clone();
        if let Some(error) = self.store.key_error() {
            self.error = Some(error.to_owned());
            cx.notify();
            return None;
        }
        if self.store.token_state(&profile.id) != TokenState::Saved {
            let typed = self.session_token.read(cx).value().trim().to_owned();
            if typed.is_empty() {
                self.error = Some(
                    "Enter a sync API token for this profile before running remote operations."
                        .to_owned(),
                );
                cx.notify();
                return None;
            }
            if let Err(error) = self.store.update(
                &profile.id,
                ProfilePatch {
                    token: Some(typed),
                    ..ProfilePatch::default()
                },
            ) {
                self.error = Some(error.to_string());
                cx.notify();
                return None;
            }
            self.session_token
                .update(cx, |input, cx| input.set_value("", window, cx));
        }
        let token = self.store.api_token(&profile.id)?;
        let target = ApiTarget {
            url: profile.api_url.clone(),
            token,
        };
        Some((profile, target))
    }

    /// Plan: the source folder against Pane View's snapshot, by size, as Sync's Plan button does.
    pub fn plan_now(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some((profile, target)) = self.begin_run(window, cx) else {
            return;
        };
        let options = PlanOptions {
            source_root: PathBuf::from(&profile.source_root),
            hash_cache: self.data.hash_cache(),
            hash_mode: HashMode::None,
        };
        self.start(
            RunAction::Plan,
            "Planning sync...",
            profile.id.clone(),
            window,
            cx,
            move |observer, cancel| async move {
                let client = PaneViewClient::new(target)?;
                let planned = plan_sync(options, Some(&client), Some(&observer), &cancel).await?;
                let plan = Arc::new(planned.plan);
                let facts = PlanFacts::of(&plan);
                Ok((plan, facts, planned.summary))
            },
            move |this, (plan, facts, summary), cx| {
                this.record_last_run(&profile.id, &summary);
                let reviewed = ReviewedPlan {
                    id: uuid::Uuid::new_v4().to_string(),
                    plan,
                    profile_id: profile.id.clone(),
                    api_url: profile.api_url.clone(),
                    source_root: profile.source_root.clone(),
                    planned_at: SystemTime::now(),
                };
                this.run.finish(RunPhase::Done, None);
                this.show_plan(reviewed, facts, cx);
            },
        );
    }

    /// Push: the profile's uploads and updates, planned again with hashes where they tell files
    /// apart, through the bounded upload queue. The plan on screen is by size alone, and a push
    /// again after failures sends only what is still to send, so the push plans first, as the
    /// Lockstep CLI's does.
    pub fn push_now(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some((profile, target)) = self.begin_run(window, cx) else {
            return;
        };
        let hash_cache = self.data.hash_cache();
        let plan_options = PlanOptions {
            source_root: PathBuf::from(&profile.source_root),
            hash_cache: hash_cache.clone(),
            hash_mode: HashMode::RemoteAware,
        };
        self.start(
            RunAction::Push,
            "Pushing uploads and updates...",
            profile.id.clone(),
            window,
            cx,
            move |observer, cancel| async move {
                let client = PaneViewClient::new(target.clone())?;
                let plan = plan_sync(plan_options, Some(&client), Some(&observer), &cancel)
                    .await?
                    .plan;
                let options = PushOptions {
                    api: target,
                    hash_cache,
                    max_changes: None,
                    plan,
                    upload_concurrency: None,
                };
                push_changes(options, &client, Some(&observer), &cancel).await
            },
            move |this, pushed, cx| {
                let summary = pushed.summary;
                this.record_last_run(&profile.id, &summary);
                if summary.status == RunStatus::Completed {
                    this.push_completed = true;
                }
                this.run.finish(
                    RunPhase::Done,
                    Some(format!(
                        "Push {}: {} item(s).",
                        summary.status.as_str(),
                        summary.applied
                    )),
                );
                cx.notify();
            },
        );
    }

    pub fn confirm_prune(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let PruneAvailability::Enabled { delete_count } = self.prune_availability() else {
            return;
        };
        if self.run_holds_profile() {
            return;
        }
        let (Some(profile), Some(reviewed)) = (self.store.active_profile(), &self.plan) else {
            return;
        };
        let plan_id = reviewed.id.clone();
        let title = format!(
            "Delete {} from {}?",
            run::describe_remote_entries(delete_count),
            profile.api_url
        );
        let this = cx.entity();
        self.confirmation = Some(title.clone());
        view::confirm(
            &this.clone(),
            window,
            cx,
            title,
            "These are the deletes in the plan you reviewed; any whose file is back in the \
             source folder is skipped. This cannot be undone from Oriel.",
            "Delete",
            move |window, cx| {
                this.update(cx, |this, cx| this.prune_now(&plan_id, window, cx));
            },
        );
    }

    /// Prune: the deletes of the plan `plan_id` names, once. A second Prune needs a new Plan.
    pub fn prune_now(&mut self, plan_id: &str, window: &mut Window, cx: &mut Context<Self>) {
        if !matches!(self.prune_availability(), PruneAvailability::Enabled { .. }) {
            return;
        }
        let Some((profile, target)) = self.begin_run(window, cx) else {
            return;
        };
        let Some(reviewed) = self.plan.clone().filter(|reviewed| reviewed.id == plan_id) else {
            self.error = Some(
                "This plan is no longer current. Run Plan again and review it first.".to_owned(),
            );
            cx.notify();
            return;
        };
        // The plan is used for one Prune only, whatever the outcome.
        self.pruned_plan_id = Some(reviewed.id.clone());
        if reviewed.api_url != profile.api_url || reviewed.source_root != profile.source_root {
            self.error = Some(
                "The profile's server or source folder changed since this plan. Run Plan again."
                    .to_owned(),
            );
            cx.notify();
            return;
        }
        let options = PruneOptions {
            api: target.clone(),
            max_changes: None,
            plan: LockstepPlan::clone(&reviewed.plan),
        };
        self.start(
            RunAction::Prune,
            "Applying remote deletes...",
            profile.id.clone(),
            window,
            cx,
            move |observer, cancel| async move {
                let client = PaneViewClient::new(target)?;
                prune_deleted(options, &client, Some(&observer), &cancel).await
            },
            move |this, summary, cx| {
                this.record_last_run(&profile.id, &summary);
                let skipped = match summary.skipped {
                    Some(skipped) if skipped > 0 => {
                        format!(", {skipped} skipped (back in the source folder)")
                    }
                    _ => String::new(),
                };
                this.run.finish(
                    RunPhase::Done,
                    Some(format!(
                        "Prune {}: {} deleted{skipped}.",
                        summary.status.as_str(),
                        summary.applied
                    )),
                );
                cx.notify();
            },
        );
    }

    /// Check connection: the profile's folder, URL, token and snapshot.
    pub fn check_connection(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some((profile, target)) = self.begin_run(window, cx) else {
            return;
        };
        self.doctor_result = None;
        let options = DoctorOptions {
            source_root: Some(profile.source_root.clone()),
            api_url: Some(target.url),
            api_token: Some(target.token),
        };
        self.start(
            RunAction::Doctor,
            "Checking connection...",
            profile.id.clone(),
            window,
            cx,
            move |observer, cancel| async move {
                let result = doctor(options, Some(&observer), &cancel).await;
                cancel.check()?;
                Ok(result)
            },
            move |this, result, cx| {
                this.record_last_run(&profile.id, &result.summary);
                this.run.finish(
                    RunPhase::Done,
                    Some(
                        if result.ok {
                            "Connection check passed."
                        } else {
                            "Connection check found issues."
                        }
                        .to_owned(),
                    ),
                );
                this.doctor_result = Some(result);
                cx.notify();
            },
        );
    }

    /// Cancel: the run's token is tripped; a push or prune then finalizes its sync run as
    /// cancelled.
    pub fn cancel_run(&mut self, cx: &mut Context<Self>) {
        if let Some(cancel) = &self.cancel {
            cancel.cancel();
        }
        cx.notify();
    }

    fn record_last_run(&mut self, profile_id: &str, summary: &RunSummary) {
        if let Err(error) = self.store.record_last_run(profile_id, summary) {
            log::warn!("Sync could not save the last run: {error}");
        }
    }

    /// Runs `work` on the tokio thread for the profile `profile_id`, with an observer whose events
    /// fold into the run on screen, then `finish` with what it returned. A failure or a cancel
    /// ends the run through [`Self::fail_run`]. A hand-off that waited for the run is shown once
    /// it ends.
    #[allow(clippy::too_many_arguments)]
    fn start<T, Fut>(
        &mut self,
        kind: RunAction,
        label: &str,
        profile_id: String,
        window: &mut Window,
        cx: &mut Context<Self>,
        work: impl FnOnce(Observer, CancelToken) -> Fut,
        finish: impl FnOnce(&mut Self, T, &mut Context<Self>) + 'static,
    ) where
        T: Send + 'static,
        Fut: std::future::Future<Output = anyhow::Result<T>> + Send + 'static,
    {
        self.error = None;
        self.run.begin(kind, label);
        self.dismissed_run = None;
        let cancel = CancelToken::new();
        self.cancel = Some(cancel.clone());
        let (sender, mut events) = futures::channel::mpsc::unbounded::<RunEvent>();
        let observer: Observer = Arc::new(move |event| {
            // The window may be gone; the run then reports to no one.
            let _ = sender.unbounded_send(event);
        });
        let task = TokioRuntime::shared()
            .expect("Oriel could not start its HTTP thread")
            .spawn(work(observer, cancel.clone()));
        self.report_activity(cx);
        self.rebuild_rows(cx);

        self.run_task = Some(cx.spawn_in(window, async move |this, cx| {
            // The run's future holds the observer until it ends, so the events end with it.
            while let Some(event) = events.next().await {
                let mut batch = vec![event];
                while let Ok(event) = events.try_recv() {
                    batch.push(event);
                }
                let applied = this.update(cx, |this, cx| {
                    let queued = batch
                        .iter()
                        .any(|event| matches!(event, RunEvent::ItemsQueued { .. }));
                    for event in batch {
                        this.run.apply(event);
                    }
                    this.report_activity(cx);
                    if queued {
                        this.rebuild_rows(cx);
                    }
                    cx.notify();
                });
                if applied.is_err() {
                    return;
                }
            }
            let result = task.await.and_then(|result| result);
            let ended = this.update_in(cx, |this, window, cx| {
                this.cancel = None;
                let cancelled = cancel.is_cancelled()
                    && result
                        .as_ref()
                        .err()
                        .is_none_or(|error| error.downcast_ref::<UnfinalizedSyncRun>().is_none());
                match result {
                    Ok(_) if cancelled => {
                        this.fail_run(&profile_id, &anyhow::Error::new(Cancelled), cx);
                    }
                    Ok(value) => finish(this, value, cx),
                    Err(error) => this.fail_run(&profile_id, &error, cx),
                }
                this.report_activity(cx);
                this.rebuild_rows(cx);
                if let Some(target) = this.pending_hand_off.take() {
                    this.take_hand_off(target, window, cx);
                }
            });
            if ended.is_err() {
                log::warn!("Sync's window closed before its run ended");
            }
        }));
    }

    /// Ends a run that failed or was cancelled. The profile's last run changes only for a push or
    /// prune whose sync run could not be finalized: that failure, naming the run, is the one the
    /// user must act on. Any other failure shows on the page and leaves the last run as it was.
    fn fail_run(&mut self, profile_id: &str, error: &anyhow::Error, cx: &mut Context<Self>) {
        if error.chain().any(|cause| cause.is::<Cancelled>()) {
            self.run
                .finish(RunPhase::Cancelled, Some(run::CANCELLED_LABEL.to_owned()));
            return;
        }
        if let Some(unfinalized) = error.downcast_ref::<UnfinalizedSyncRun>() {
            self.record_last_run(profile_id, &unfinalized.summary);
        }
        let message = error.to_string();
        self.run.finish(RunPhase::Error, Some(message.clone()));
        self.error = Some(message);
        cx.notify();
    }
}

/// What a token field shows before anything is typed.
pub(crate) const SAVED_TOKEN_PLACEHOLDER: &str = "Paste the server's token";

impl Focusable for SyncMode {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus_handle.clone()
    }
}

impl Render for SyncMode {
    fn render(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> impl gpui_kit::IntoElement {
        self.render_mode(window, cx)
    }
}

impl Mode for SyncMode {
    const ID: ModeId = ModeId::Sync;

    fn commands() -> Vec<Command> {
        vec![
            Command::new(ToggleRunLog)
                .keys(RUN_LOG_KEYS)
                .sheet("Show or hide the run log"),
        ]
    }

    fn sheet() -> Sheet {
        shortcuts::SHEET
    }

    fn folders(&self, _: &App) -> Vec<PathBuf> {
        self.source_roots()
    }

    fn foot(&self, _: &App) -> Foot {
        Foot::height(self.foot_height())
    }

    /// The profiles, each opening the form, and where their tokens are kept.
    fn settings_section(&mut self, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        self.render_settings(window, cx).into_any_element()
    }

    fn show_hand_off(&mut self, target: HandOff, window: &mut Window, cx: &mut Context<Self>) {
        self.shell
            .update(cx, |shell, cx| shell.go(ModeId::Sync, cx));
        self.take_hand_off(target, window, cx);
    }

    /// A profile for the folder, named after it, when the welcome was given a server.
    fn set_up(
        &mut self,
        set_up: &FolderSetUp,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) -> Task<Result<(), SharedString>> {
        let Some(server) = &set_up.server else {
            return Task::ready(Ok(()));
        };
        let folder = &set_up.folder;
        let input = ProfileInput {
            name: folder
                .file_name()
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or_else(|| folder.display().to_string()),
            api_url: server.api_url.clone(),
            source_root: folder.to_string_lossy().into_owned(),
            token: server.token.clone(),
        };
        Task::ready(self.add_profile(input, cx).map_err(SharedString::from))
    }
}
