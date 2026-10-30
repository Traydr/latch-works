//! Sync: Lockstep as one of Oriel RS's modes, Phase 4 of plan 063.
//!
//! The profiles are in the sidebar; the active profile's plan is the page, as a tree of what to
//! upload, update and delete; Push and Prune run with the run panel floating over the plan's
//! lower right, and the run log (⌘L) along the bottom. The engine is `oriel-core-sync`, run on
//! the app's tokio thread; profiles and tokens are kept in `DataRoot::sync()` in Electron Oriel's
//! formats ([`profiles`], [`secrets`]), and the hash cache in `DataRoot::hash_cache()`.
//!
//! As in Electron Oriel's `runService.ts`, one run goes at a time, a run holds the profile it
//! started with, Plan compares sizes alone, Push plans again with hashes where they tell files
//! apart, and Prune applies the deletes of the plan on screen once.
//!
//! The profile menu's Open in View and Tidy this folder go to the shell as [`SyncEvent`]s; a
//! folder another mode hands Sync arrives through [`SyncMode::show_hand_off`].

pub mod plan_tree;
pub mod profiles;
pub mod run;
pub mod secrets;
mod view;

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Instant, SystemTime};

use futures::StreamExt as _;
use gpui_kit::component::input::{InputEvent, InputState};
use gpui_kit::{
    AnyElement, App, AppContext as _, Context, Entity, EventEmitter, FocusHandle, Focusable,
    Global, IntoElement as _, KeyBinding, PathPromptOptions, Render, SharedString, Subscription,
    Task, UniformListScrollHandle, Window, actions,
};
use oriel_core_index::SyncPlanAction;
use oriel_core_paths::DataRoot;
use oriel_core_sync::{
    ApiTarget, DoctorOptions, DoctorResult, HashMode, LockstepPlan, Observer, PaneViewClient,
    PlanOptions, PruneOptions, PushOptions, RunAction, RunEvent, RunStatus, RunSummary,
    UnfinalizedSyncRun, cache_root, doctor, plan_sync, prune_deleted, push_changes,
};
use oriel_runtime::{CancelToken, Cancelled, TokioHandle, TokioRuntime};
use oriel_ui::folders::closest_folder;
use oriel_ui::{HandOff, ModeActivity, ModeId, ShellState};

pub use plan_tree::{PlanFolder, PlanRow};
pub use profiles::{Profile, ProfileInput, ProfilePatch, ProfileStore, TokenState};
pub use run::{ItemState, PruneAvailability, RunPhase, RunState};
pub use secrets::FileSecretStorage;

/// The key context of Sync's page.
pub const KEY_CONTEXT: &str = "Sync";

/// `ORIEL_RS_SYNC_PLAN=1` plans the active profile at start.
pub const PLAN_VARIABLE: &str = "ORIEL_RS_SYNC_PLAN";

actions!(
    sync,
    [
        /// The run log, open or closed (⌘L).
        ToggleRunLog,
        /// The plan's path filter takes the keys (/, outside a text field).
        FocusPlanFilter
    ]
);

/// Marks Sync's keys as bound, so a second window does not bind them twice.
struct SyncKeys;

impl Global for SyncKeys {}

/// Binds Sync's keys. `SyncMode::new` calls it, so the app shell need not.
pub fn init(cx: &mut App) {
    if cx.has_global::<SyncKeys>() {
        return;
    }
    cx.set_global(SyncKeys);
    // `/` reaches the plan's filter through the page's key handler instead, since a binding
    // would also take it from a text field.
    cx.bind_keys([KeyBinding::new("cmd-l", ToggleRunLog, Some(KEY_CONTEXT))]);
}

/// The name of the app's tokio thread, where Sync's HTTP runs.
pub const HTTP_THREAD: &str = "oriel-http";

/// Starts the app's tokio thread, once: `oriel_rs::run` calls it at launch, so a failure to start
/// it shows then, not at the first push. Later calls do nothing.
pub fn start_http(cx: &mut App) -> std::io::Result<()> {
    if !cx.has_global::<TokioRuntime>() {
        cx.set_global(TokioRuntime::start(HTTP_THREAD)?);
    }
    Ok(())
}

/// The app's tokio thread. The app starts it at launch; a window opened without the app's
/// start (the GPUI tests) gets it here on its first run.
fn http(cx: &mut App) -> TokioHandle {
    start_http(cx).expect("Oriel RS could not start its HTTP thread");
    cx.global::<TokioRuntime>().handle()
}

/// What Sync asks of the rest of the app: the profile menu's links to the other modes.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SyncEvent {
    /// Open in View, for the profile's source folder.
    OpenInView(PathBuf),
    /// Tidy this folder, for the profile's source folder.
    TidyFolder(PathBuf),
}

/// What the page shows.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Screen {
    /// The active profile's plan, or the welcome before any profile.
    Workspace,
    /// The profile form: a new profile, or the one with this id.
    Form { editing: Option<String> },
}

/// The plan on screen and what it was made against, so Prune applies what the user reviewed
/// (`ReviewedPlan` in `runService.ts`).
#[derive(Clone, Debug)]
pub struct ReviewedPlan {
    pub id: String,
    pub plan: LockstepPlan,
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

/// The profile form's fields.
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
        paths: Arc<Vec<String>>,
    },
    File {
        depth: usize,
        path: String,
        name: String,
        action: SyncPlanAction,
        size: Option<u64>,
    },
    More {
        depth: usize,
        folder: String,
        label: String,
        hidden: usize,
    },
}

pub struct SyncMode {
    shell: Entity<ShellState>,
    data: DataRoot,
    store: ProfileStore,
    screen: Screen,
    form: ProfileForm,
    session_token: Entity<InputState>,
    filter: Entity<InputState>,
    plan: Option<ReviewedPlan>,
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
    _subscriptions: Vec<Subscription>,
}

impl EventEmitter<SyncEvent> for SyncMode {}

impl SyncMode {
    /// Sync for the shell, keeping its profiles in this run's data folder.
    /// Plans the active profile at start when [`PLAN_VARIABLE`] is set, for runs without input
    /// (measurements and screenshots).
    pub fn new(shell: &Entity<ShellState>, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let data = DataRoot::from_environment().expect("Oriel RS needs a data folder");
        let mut sync = Self::with_data(shell, &data, window, cx);
        if std::env::var_os(PLAN_VARIABLE).is_some_and(|value| value == "1") {
            sync.plan_now(window, cx);
        }
        sync
    }

    /// Sync keeping its profiles under `data`.
    pub fn with_data(
        shell: &Entity<ShellState>,
        data: &DataRoot,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        init(cx);
        let (store, error) = ProfileStore::open(&data.sync());
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
            cx.subscribe_in(&filter, window, |this, _, event: &InputEvent, _, cx| {
                if matches!(event, InputEvent::Change) {
                    this.rebuild_rows(cx);
                }
            }),
            // Sync takes the keys when it comes on screen, so ⌘L and / reach it.
            cx.observe_in(shell, window, |this, shell, window, cx| {
                if shell.read(cx).mode() == ModeId::Sync
                    && shell.read(cx).settings().is_none()
                    && !this.focus_handle.contains_focused(window, cx)
                {
                    this.focus_handle.focus(window, cx);
                }
            }),
        ];
        Self {
            shell: shell.clone(),
            data: data.clone(),
            store,
            screen: Screen::Workspace,
            form,
            session_token,
            filter,
            plan: None,
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
            _subscriptions: subscriptions,
        }
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
    /// it, or a new profile's form with the folder and its name filled in (`useSyncHandOff`).
    /// A run holds the profile it started with, so a hand-off during one waits for it to end.
    pub fn show_hand_off(&mut self, target: HandOff, window: &mut Window, cx: &mut Context<Self>) {
        if self.run.running {
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
        let folder = PathBuf::from(&profile.source_root);
        match to {
            ModeId::View => cx.emit(SyncEvent::OpenInView(folder)),
            ModeId::Tidy => cx.emit(SyncEvent::TidyFolder(folder)),
            ModeId::Sync => {}
        }
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

    /// The new or edited profile's name, as its form shows it.
    pub fn form_name(&self, cx: &App) -> SharedString {
        self.form.name.read(cx).value()
    }

    /// The new or edited profile's source folder, as its form shows it.
    pub fn form_source_root(&self, cx: &App) -> SharedString {
        self.form.source_root.read(cx).value()
    }

    /// This mode's section of the one Settings page (⌘,): the profiles, each opening the form,
    /// and where their tokens are kept.
    pub fn settings_section(&mut self, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        self.render_settings(window, cx).into_any_element()
    }

    pub fn profiles(&self) -> &ProfileStore {
        &self.store
    }

    pub fn screen(&self) -> &Screen {
        &self.screen
    }

    pub fn plan(&self) -> Option<&ReviewedPlan> {
        self.plan.as_ref()
    }

    pub fn run_state(&self) -> &RunState {
        &self.run
    }

    pub fn is_running(&self) -> bool {
        self.run.running
    }

    pub fn error(&self) -> Option<&str> {
        self.error.as_deref()
    }

    pub fn doctor_result(&self) -> Option<&DoctorResult> {
        self.doctor_result.as_ref()
    }

    pub fn is_log_open(&self) -> bool {
        self.log_open
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

    fn report_activity(&self, cx: &mut Context<Self>) {
        let activity = self.run.running.then(|| match self.run.progress.kind {
            Some(RunAction::Push | RunAction::Prune) => self
                .run
                .ratio()
                .map_or(ModeActivity::Working, ModeActivity::Progress),
            _ => ModeActivity::Working,
        });
        // A push or prune changes the server, so even before its list is known it counts as
        // work quitting waits for.
        let activity = match (activity, self.run.progress.kind) {
            (Some(ModeActivity::Working), Some(RunAction::Push | RunAction::Prune)) => {
                Some(ModeActivity::Progress(0.0))
            }
            (activity, _) => activity,
        };
        self.shell.update(cx, |shell, cx| {
            shell.set_activity(ModeId::Sync, activity, cx)
        });
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

    /// Opens the form on a saved profile.
    pub fn start_edit_profile(&mut self, id: &str, window: &mut Window, cx: &mut Context<Self>) {
        if self.run.running {
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

    /// Saves the form: a new profile, or the edit.
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
            _ => {
                if [&name, &api_url, &source_root]
                    .iter()
                    .any(|value| value.is_empty())
                {
                    Err(anyhow::anyhow!(
                        "A profile needs a name, a Pane View API URL and a source folder."
                    ))
                } else {
                    self.store
                        .create(ProfileInput {
                            name,
                            api_url,
                            source_root,
                            token,
                        })
                        .map(drop)
                }
            }
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

    /// Asks for the source folder with the system's picker.
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
        if self.run.running {
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

    /// Asks before deleting a profile, naming it.
    pub(crate) fn confirm_delete_profile(
        &mut self,
        id: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(profile) = self.store.profile(id).cloned() else {
            return;
        };
        if self.run.running {
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

    /// Deletes a profile and its token.
    pub fn delete_profile(&mut self, id: &str, window: &mut Window, cx: &mut Context<Self>) {
        if self.run.running {
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

    /// Rebuilds the list's rows from the plan, the filters and the folders opened.
    pub(crate) fn rebuild_rows(&mut self, cx: &mut Context<Self>) {
        let Some(reviewed) = &self.plan else {
            self.rows.clear();
            cx.notify();
            return;
        };
        let query = self.filter.read(cx).value().trim().to_lowercase();
        let showing_run = self.shows_run_state();
        let states = &self.run.item_states;
        let items = reviewed.plan.items.iter().filter(|item| {
            item.action != SyncPlanAction::Keep
                && (query.is_empty() || item.path.to_lowercase().contains(&query))
                && if showing_run {
                    let state = states.get(&item.path);
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
        let tree = plan_tree::build_plan_tree(items.map(|item| {
            plan_tree::TreeInput {
                action: item.action,
                path: &item.path,
                size: item
                    .local
                    .as_ref()
                    .map(|local| local.size)
                    .or(item.remote.as_ref().map(|remote| remote.size)),
            }
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
                    paths: Arc::new(
                        plan_tree::folder_paths(folder)
                            .into_iter()
                            .map(str::to_owned)
                            .collect(),
                    ),
                },
                PlanRow::File { depth, file } => RowModel::File {
                    depth,
                    path: file.path.clone(),
                    name: file.name.clone(),
                    action: file.action,
                    size: file.size,
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

    /// The active profile's server and folder, with a token: the saved one, or the one typed
    /// under the plan, which is saved (encrypted) first, as `ensureSessionToken` does.
    fn credentials(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Option<(Profile, ApiTarget)> {
        let profile = self.store.active_profile()?.clone();
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

    fn hash_cache_root(&self) -> PathBuf {
        cache_root(&self.data.hash_cache())
    }

    /// Plan: the source folder against Pane View's snapshot, by size, as Sync's Plan button does.
    pub fn plan_now(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.run.running {
            return;
        }
        let Some((profile, target)) = self.credentials(window, cx) else {
            return;
        };
        let options = PlanOptions {
            source_root: PathBuf::from(&profile.source_root),
            hash_cache_root: self.hash_cache_root(),
            hash_mode: HashMode::None,
            directory_concurrency: None,
            file_concurrency: None,
        };
        self.start(
            RunAction::Plan,
            "Planning sync...",
            cx,
            move |observer, cancel| async move {
                let client = PaneViewClient::new(target)?;
                plan_sync(options, Some(&client), Some(&observer), &cancel).await
            },
            move |this, result, cx| {
                let plan = result?;
                let mut summary = RunSummary::now(RunAction::Plan, RunStatus::Completed);
                summary.plan_counts = Some(plan.counts);
                this.record_last_run(&profile.id, summary);
                this.plan = Some(ReviewedPlan {
                    id: uuid::Uuid::new_v4().to_string(),
                    plan,
                    profile_id: profile.id.clone(),
                    api_url: profile.api_url.clone(),
                    source_root: profile.source_root.clone(),
                    planned_at: SystemTime::now(),
                });
                this.push_completed = false;
                this.action_filter.clear();
                this.run_filter = RunFilter::All;
                this.open_overrides.clear();
                this.show_all_files.clear();
                this.run.finish(RunPhase::Done, None);
                this.rebuild_rows(cx);
                Ok(())
            },
        );
    }

    /// Push: the profile's uploads and updates, planned again with hashes where they tell files
    /// apart (`hashMode: "remote-aware"`), through the bounded upload queue.
    pub fn push_now(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.run.running {
            return;
        }
        let Some((profile, target)) = self.credentials(window, cx) else {
            return;
        };
        let options = PushOptions {
            api: target.clone(),
            source_root: PathBuf::from(&profile.source_root),
            hash_cache_root: self.hash_cache_root(),
            hash_mode: Some(HashMode::RemoteAware),
            max_changes: None,
            plan: None,
            upload_concurrency: None,
        };
        self.start(
            RunAction::Push,
            "Pushing uploads and updates...",
            cx,
            move |observer, cancel| async move {
                let client = PaneViewClient::new(target)?;
                push_changes(options, &client, Some(&observer), &cancel).await
            },
            move |this, result, cx| {
                let pushed = result?;
                let status = if pushed.failed > 0 {
                    RunStatus::Failed
                } else {
                    RunStatus::Completed
                };
                let mut summary = RunSummary::now(RunAction::Push, status);
                summary.failed = pushed.failed;
                summary.pushed = pushed.pushed;
                summary.plan_counts = Some(pushed.plan.counts);
                this.record_last_run(&profile.id, summary);
                if status == RunStatus::Completed {
                    this.push_completed = true;
                }
                this.run.finish(
                    RunPhase::Done,
                    Some(format!(
                        "Push {}: {} item(s).",
                        status.as_str(),
                        pushed.pushed
                    )),
                );
                cx.notify();
                Ok(())
            },
        );
    }

    /// Asks before pruning, naming the count and the server, as Electron Oriel's Prune does.
    pub fn confirm_prune(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let PruneAvailability::Enabled { delete_count } = self.prune_availability() else {
            return;
        };
        if self.run.running {
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
             source folder is skipped. This cannot be undone from Oriel RS.",
            "Delete",
            move |window, cx| {
                this.update(cx, |this, cx| this.prune_now(&plan_id, window, cx));
            },
        );
    }

    /// Prune: the deletes of the plan `plan_id` names, once. A second Prune needs a new Plan.
    pub fn prune_now(&mut self, plan_id: &str, window: &mut Window, cx: &mut Context<Self>) {
        if self.run.running
            || !matches!(self.prune_availability(), PruneAvailability::Enabled { .. })
        {
            return;
        }
        let Some((profile, target)) = self.credentials(window, cx) else {
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
            plan: reviewed.plan,
        };
        self.start(
            RunAction::Prune,
            "Applying remote deletes...",
            cx,
            move |observer, cancel| async move {
                let client = PaneViewClient::new(target)?;
                prune_deleted(options, &client, Some(&observer), &cancel).await
            },
            move |this, result, cx| {
                let pruned = result?;
                let status = if pruned.failed > 0 {
                    RunStatus::Failed
                } else {
                    RunStatus::Completed
                };
                let mut summary = RunSummary::now(RunAction::Prune, status);
                summary.failed = pruned.failed;
                summary.pushed = pruned.pruned;
                summary.skipped = Some(pruned.skipped);
                summary.plan_counts = Some(pruned.plan.counts);
                this.record_last_run(&profile.id, summary);
                let skipped = if pruned.skipped > 0 {
                    format!(", {} skipped (back in the source folder)", pruned.skipped)
                } else {
                    String::new()
                };
                this.run.finish(
                    RunPhase::Done,
                    Some(format!(
                        "Prune {}: {} deleted{skipped}.",
                        status.as_str(),
                        pruned.pruned
                    )),
                );
                cx.notify();
                Ok(())
            },
        );
    }

    /// Check connection: the profile's folder, URL, token and snapshot.
    pub fn check_connection(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.run.running {
            return;
        }
        let Some((profile, target)) = self.credentials(window, cx) else {
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
            "Running doctor...",
            cx,
            move |observer, cancel| async move {
                let result = doctor(options, Some(&observer), &cancel).await;
                cancel.check()?;
                Ok(result)
            },
            move |this, result, cx| {
                let result = result?;
                let mut summary = RunSummary::now(
                    RunAction::Doctor,
                    if result.ok {
                        RunStatus::Completed
                    } else {
                        RunStatus::Failed
                    },
                );
                summary.failed = usize::from(!result.ok);
                summary.message = Some(
                    if result.ok {
                        "All checks passed."
                    } else {
                        "Some checks failed."
                    }
                    .to_owned(),
                );
                this.record_last_run(&profile.id, summary);
                this.run.finish(
                    RunPhase::Done,
                    Some(
                        if result.ok {
                            "Doctor passed."
                        } else {
                            "Doctor found issues."
                        }
                        .to_owned(),
                    ),
                );
                this.doctor_result = Some(result);
                cx.notify();
                Ok(())
            },
        );
    }

    /// Cancel: the run stops, finalizing its sync run as cancelled.
    pub fn cancel_run(&mut self, cx: &mut Context<Self>) {
        if let Some(cancel) = &self.cancel {
            cancel.cancel();
        }
        cx.notify();
    }

    fn record_last_run(&mut self, profile_id: &str, summary: RunSummary) {
        if let Err(error) = self.store.record_last_run(profile_id, summary) {
            log::warn!("Sync could not save the last run: {error}");
        }
    }

    /// Runs `work` on the tokio thread with an observer whose events fold into the run on
    /// screen, then `finish` with its result. A failure or a cancel ends the run as Electron
    /// Oriel's `ownRun` does.
    fn start<T, Fut>(
        &mut self,
        kind: RunAction,
        label: &str,
        cx: &mut Context<Self>,
        work: impl FnOnce(Observer, CancelToken) -> Fut,
        finish: impl FnOnce(&mut Self, anyhow::Result<T>, &mut Context<Self>) -> anyhow::Result<()>
        + 'static,
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
            let _ = sender.unbounded_send(event);
        });
        let task = http(cx).spawn(work(observer, cancel.clone()));
        self.report_activity(cx);
        self.rebuild_rows(cx);

        self.run_task = Some(cx.spawn(async move |this, cx| {
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
            let _ = this.update(cx, |this, cx| {
                this.cancel = None;
                let cancelled = cancel.is_cancelled()
                    && result
                        .as_ref()
                        .err()
                        .is_none_or(|error| error.downcast_ref::<UnfinalizedSyncRun>().is_none());
                let outcome = if cancelled {
                    Err(anyhow::Error::new(Cancelled))
                } else {
                    finish(this, result, cx)
                };
                if let Err(error) = outcome {
                    this.fail_run(kind, &error, cx);
                }
                this.run.running = false;
                this.report_activity(cx);
                this.rebuild_rows(cx);
            });
        }));
    }

    fn fail_run(&mut self, kind: RunAction, error: &anyhow::Error, cx: &mut Context<Self>) {
        let profile_id = self.store.active_profile_id().map(str::to_owned);
        if error.chain().any(|cause| cause.is::<Cancelled>()) {
            self.run
                .finish(RunPhase::Cancelled, Some("Run cancelled.".to_owned()));
            return;
        }
        let message = error.to_string();
        if let Some(profile_id) = profile_id {
            let mut summary = RunSummary::now(kind, RunStatus::Failed);
            summary.message = Some(message.clone());
            self.record_last_run(&profile_id, summary);
        }
        self.run.finish(RunPhase::Error, Some(message.clone()));
        self.error = Some(message);
        cx.notify();
    }
}

/// What a token field shows before anything is typed.
pub(crate) const SAVED_TOKEN_PLACEHOLDER: &str = "Saved encrypted in ~/.latch-works/oriel-rs";

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
        // A hand-off that waited for a run is shown once the run has ended.
        if !self.run.running && self.pending_hand_off.is_some() {
            cx.defer_in(window, |this, window, cx| {
                if let Some(target) = this.pending_hand_off.take() {
                    this.show_hand_off(target, window, cx);
                }
            });
        }
        self.render_mode(window, cx)
    }
}
