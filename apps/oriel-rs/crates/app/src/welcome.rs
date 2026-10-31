//! The welcome on the owner's first start, over the whole window (Electron Oriel's `Welcome.tsx`
//! and `first-run.ts`): one archive folder for View, which opens it, and for Tidy, which tidies
//! it if asked, with a Pane View server for Sync when Sync has no profile yet. Every step can be
//! skipped; it lands in View, and shows once: a `welcomed` file in the shell's folder says so.
//!
//! When Electron Oriel's data is there, the welcome first offers to import it (plan 063, decision
//! 17): what was found, as counts and sizes, with Import and Start Fresh. Settings › General runs
//! the same import at any time ([`open_import_dialog`]). The import reads Electron Oriel's data
//! on a thread of its own and stages it (`oriel-migrate`); the next start puts it in place, so
//! the window offers to restart.
//!
//! In a sandboxed run (`ORIEL_RS_DATA_DIR`) Tidy takes only folders in its sandbox, so for a
//! folder outside it "Tidy it" is off and says why.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime};

use gpui_kit::assets::IconName;
use gpui_kit::component::alert::Alert;
use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::input::{Input, InputState};
use gpui_kit::component::spinner::Spinner;
use gpui_kit::component::switch::Switch;
use gpui_kit::component::{ActiveTheme as _, Disableable as _, Icon, Sizable as _, WindowExt as _};
use gpui_kit::{
    AnyElement, App, AppContext as _, Context, Entity, EventEmitter, FontWeight, Global,
    InteractiveElement as _, IntoElement, ParentElement as _, PathPromptOptions, Render, Role,
    SharedString, StatefulInteractiveElement as _, Styled as _, Subscription, Task,
    TestSupportExt as _, Window, div, prelude::FluentBuilder as _, px,
};
use oriel_core_paths::DataRoot;
use oriel_migrate::{Area, ElectronData, Progress as ImportProgress, Report, Survey};
use oriel_mode_sync::{ProfileInput, SyncMode};
use oriel_mode_tidy::TidyMode;
use oriel_mode_view::ViewMode;
use oriel_ui::{ModeId, ShellState};

/// `ORIEL_RS_WELCOME=1` shows the welcome under `ORIEL_RS_DATA_DIR`, which otherwise never shows
/// it, as `ORIEL_WELCOME=1` does under Electron Oriel's `--user-data-dir`.
pub const WELCOME_VARIABLE: &str = "ORIEL_RS_WELCOME";

/// The file whose presence says the welcome has been seen, as Electron Oriel names it.
const WELCOMED_FILE: &str = "welcomed";

/// How long Start waits for Tidy's catalog to open before saying it has not.
const TIDY_START_LIMIT: Duration = Duration::from_secs(15);

/// Whether this run may show the welcome: always on the owner's own data, and under another data
/// folder (a check, a test) only when [`WELCOME_VARIABLE`] asks.
pub fn allowed_from_environment() -> bool {
    std::env::var_os(oriel_core_paths::DATA_DIR_VARIABLE).is_none_or(|value| value.is_empty())
        || std::env::var_os(WELCOME_VARIABLE).is_some_and(|value| value == "1")
}

/// Whether the owner has been through the welcome (`welcomed`).
pub fn welcomed(data: &DataRoot) -> bool {
    data.shell().join(WELCOMED_FILE).exists()
}

/// Notes that the welcome has been seen (`markWelcomed`): the time, as Electron Oriel writes it.
pub fn mark_welcomed(data: &DataRoot) {
    let file = data.shell().join(WELCOMED_FILE);
    let stamp = format!("{}\n", oriel_core_sync::iso_timestamp(SystemTime::now()));
    if let Err(error) = std::fs::write(&file, stamp) {
        log::warn!("Oriel RS could not note the welcome as seen: {error}");
    }
}

/// The welcome is done, by Start or Skip; the shell closes it and shows View.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WelcomeEvent {
    Finished,
}

/// The modes the welcome sets the folder up in.
pub struct WelcomeModes {
    pub view: Entity<ViewMode>,
    pub tidy: Entity<TidyMode>,
    pub sync: Entity<SyncMode>,
}

pub struct Welcome {
    shell: Entity<ShellState>,
    data: DataRoot,
    modes: WelcomeModes,
    /// Sync has no profile, so the welcome offers to connect Pane View (`needsServer`).
    needs_server: bool,
    folder: Option<PathBuf>,
    tidy_it: bool,
    sync_it: bool,
    api_url: Entity<InputState>,
    token: Entity<InputState>,
    busy: bool,
    problems: Vec<SharedString>,
    /// The offer to import Electron Oriel's data, when there may be some.
    import: Option<Entity<ImportFlow>>,
    /// The owner chose Start Fresh over the import.
    fresh: bool,
    _subscriptions: Vec<Subscription>,
}

impl EventEmitter<WelcomeEvent> for Welcome {}

impl Welcome {
    pub fn new(
        shell: &Entity<ShellState>,
        data: DataRoot,
        modes: WelcomeModes,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let needs_server = modes.sync.read(cx).source_roots().is_empty();
        let api_url =
            cx.new(|cx| InputState::new(window, cx).placeholder("https://pane.example.com"));
        let token = cx.new(|cx| {
            InputState::new(window, cx)
                .placeholder("Sync API token, saved encrypted in ~/.latch-works/oriel-rs")
                .masked(true)
        });
        let source = import_source(&data, cx);
        let mut subscriptions = Vec::new();
        let import = (source.is_some() || oriel_migrate::pending(&data)).then(|| {
            let flow =
                cx.new(|cx| ImportFlow::new(data.clone(), source, ImportPurpose::Welcome, cx));
            subscriptions.push(cx.observe(&flow, |_, _, cx| cx.notify()));
            subscriptions.push(cx.subscribe(&flow, |this, _, event, cx| match event {
                ImportEvent::StartFresh => {
                    this.fresh = true;
                    cx.notify();
                }
                ImportEvent::Close => cx.emit(WelcomeEvent::Finished),
            }));
            flow
        });
        Self {
            shell: shell.clone(),
            data,
            modes,
            needs_server,
            folder: None,
            tidy_it: true,
            sync_it: false,
            api_url,
            token,
            busy: false,
            problems: Vec::new(),
            import,
            fresh: false,
            _subscriptions: subscriptions,
        }
    }

    /// The import's offer while it shows in place of the folder, until Start Fresh or when
    /// nothing was found.
    pub fn import(&self) -> Option<&Entity<ImportFlow>> {
        self.import.as_ref()
    }

    fn offers_import(&self, cx: &App) -> bool {
        !self.fresh
            && self
                .import
                .as_ref()
                .is_some_and(|flow| flow.read(cx).offers())
    }

    /// The folder chosen, once one is.
    pub fn folder(&self) -> Option<&Path> {
        self.folder.as_deref()
    }

    /// Whether Start also has Tidy tidy the folder: asked for, and allowed by the sandbox.
    pub fn tidies(&self) -> bool {
        self.tidy_it
            && self
                .folder
                .as_deref()
                .is_some_and(|folder| self.admits(folder))
    }

    /// What Start ran into, one line each, until it is pressed again.
    pub fn problems(&self) -> &[SharedString] {
        &self.problems
    }

    fn admits(&self, folder: &Path) -> bool {
        self.data.admits_tidy_root(folder)
    }

    /// No folder any mode uses is there, so the welcome asks for one (`needsFolder`). Once one is
    /// chosen the question stays, though View then knows the folder.
    fn needs_folder(&self, cx: &App) -> bool {
        self.folder.is_some() || self.shell.read(cx).known_folders().is_empty()
    }

    /// Asks for the folder with the system's picker (`chooseArchive`).
    fn choose_folder(&mut self, cx: &mut Context<Self>) {
        let chosen = cx.prompt_for_paths(PathPromptOptions {
            files: false,
            directories: true,
            multiple: false,
            prompt: Some("Choose".into()),
        });
        cx.spawn(async move |this, cx| {
            let Ok(Ok(Some(paths))) = chosen.await else {
                return;
            };
            let Some(folder) = paths.into_iter().next() else {
                return;
            };
            this.update(cx, |this, cx| {
                this.folder = Some(folder);
                this.problems.clear();
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    /// Sets the folder up (`setUpArchive`): View opens it, Tidy adds it if asked, Sync gets a
    /// profile for it if a server was given. Anything that fails is listed, and Start reads
    /// Continue; otherwise the welcome is done.
    fn start(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(folder) = self.folder.clone().filter(|_| self.problems.is_empty()) else {
            cx.emit(WelcomeEvent::Finished);
            return;
        };
        self.busy = true;
        cx.notify();

        self.modes
            .view
            .update(cx, |view, cx| view.open_folder(folder.clone(), cx));

        let mut problems: Vec<SharedString> = Vec::new();
        let api_url = self.api_url.read(cx).value().trim().to_owned();
        if self.sync_it && self.needs_server && !api_url.is_empty() {
            let token = self.token.read(cx).value().trim().to_owned();
            let input = ProfileInput {
                name: folder_name(&folder),
                api_url,
                source_root: folder.to_string_lossy().into_owned(),
                token: Some(token).filter(|token| !token.is_empty()),
            };
            if let Err(problem) = self
                .modes
                .sync
                .update(cx, |sync, cx| sync.add_profile(input, cx))
            {
                problems.push(format!("Sync: {problem}").into());
            }
        }

        let tidy = self
            .tidies()
            .then(|| self.modes.tidy.read(cx).state().clone());
        cx.spawn_in(window, async move |this, cx| {
            if let Some(state) = tidy {
                // The catalog opens in the background at launch; give it a moment.
                let since = Instant::now();
                while cx
                    .update(|_, cx| {
                        let state = state.read(cx);
                        !state.is_ready() && state.engine_error().is_none()
                    })
                    .unwrap_or(false)
                    && since.elapsed() < TIDY_START_LIMIT
                {
                    cx.background_executor()
                        .timer(Duration::from_millis(20))
                        .await;
                }
                let added = cx.update(|window, cx| {
                    state.update(cx, |state, cx| state.add_root(folder.clone(), window, cx))
                });
                if let Ok(added) = added
                    && let Err(problem) = added.await
                {
                    problems.push(format!("Tidy: {problem}").into());
                }
            }
            this.update(cx, |this, cx| {
                this.busy = false;
                if problems.is_empty() {
                    cx.emit(WelcomeEvent::Finished);
                } else {
                    this.problems = problems;
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    /// The three modes' icons side by side, for Electron Oriel's glyphs gathering into its mark.
    fn render_mark(&self, cx: &App) -> impl IntoElement {
        let theme = cx.theme();
        div()
            .flex()
            .flex_row()
            .justify_center()
            .gap_3()
            .children(ModeId::ALL.map(|mode| {
                div()
                    .flex()
                    .items_center()
                    .justify_center()
                    .size(px(48.))
                    .rounded(theme.radius_lg)
                    .bg(theme.muted)
                    .child(
                        Icon::new(mode.icon())
                            .size(px(24.))
                            .text_color(theme.primary),
                    )
            }))
    }

    fn render_folder(&self, cx: &mut Context<Self>) -> AnyElement {
        let theme = cx.theme().clone();
        let chosen = self.folder.clone();
        let row = |id: &'static str| {
            div()
                .id(id)
                .flex()
                .flex_row()
                .items_center()
                .gap_4()
                .min_h(px(48.))
                .px_4()
                .py(px(10.))
        };
        let text = |title: &'static str, caption: SharedString| {
            div()
                .flex()
                .flex_col()
                .flex_1()
                .min_w_0()
                .text_size(px(13.))
                .child(title)
                .child(
                    div()
                        .text_xs()
                        .text_color(theme.muted_foreground)
                        .child(caption),
                )
        };
        let mut card = div()
            .mt_3()
            .flex()
            .flex_col()
            .overflow_hidden()
            .rounded(theme.radius_lg)
            .bg(theme.group_box)
            .border_1()
            .border_color(theme.border)
            .child(
                div()
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap_3()
                    .min_h(px(52.))
                    .px_4()
                    .py(px(10.))
                    .child(
                        Icon::new(IconName::FolderOpen)
                            .size(px(16.))
                            .flex_shrink_0()
                            .text_color(theme.muted_foreground),
                    )
                    .child(
                        div()
                            .flex()
                            .flex_col()
                            .flex_1()
                            .min_w_0()
                            .child(
                                div()
                                    .id("welcome-folder-name")
                                    .test_support()
                                    .truncate()
                                    .text_size(px(13.))
                                    .font_weight(FontWeight::MEDIUM)
                                    .child(
                                        chosen
                                            .as_deref()
                                            .map_or("No folder yet".into(), folder_name),
                                    ),
                            )
                            .when_some(chosen.clone(), |this, folder| {
                                let path = SharedString::from(folder.display().to_string());
                                this.child(
                                    div()
                                        .id("welcome-folder-path")
                                        .test_support()
                                        .aria_label(path.clone())
                                        .truncate()
                                        .text_xs()
                                        .text_color(theme.muted_foreground)
                                        .child(path),
                                )
                            }),
                    )
                    .child(
                        Button::new("welcome-choose-folder")
                            .outline()
                            .label(if chosen.is_some() {
                                "Change…"
                            } else {
                                "Choose Folder…"
                            })
                            .on_click(cx.listener(|this, _, _, cx| this.choose_folder(cx))),
                    ),
            );
        let Some(folder) = chosen else {
            return card.into_any_element();
        };
        let admitted = self.admits(&folder);
        let tidy_caption: SharedString = if admitted {
            "Find duplicates, formats to convert and junk.".into()
        } else {
            oriel_mode_tidy::links::sandbox_rule(&self.data).into()
        };
        card = card.child(
            row("welcome-tidy-row")
                .border_t_1()
                .border_color(theme.border)
                .child(text("Tidy it", tidy_caption))
                .child(
                    Switch::new("welcome-tidy-it")
                        .accessibility_label("Tidy it")
                        .checked(self.tidies())
                        .disabled(!admitted)
                        .on_click(cx.listener(|this, checked: &bool, _, cx| {
                            this.tidy_it = *checked;
                            cx.notify();
                        })),
                ),
        );
        if self.needs_server {
            card = card.child(
                div()
                    .flex()
                    .flex_col()
                    .border_t_1()
                    .border_color(theme.border)
                    .child(
                        row("welcome-sync-row")
                            .child(text(
                                "Sync it to Pane View",
                                "Push it to your Pane View server.".into(),
                            ))
                            .child(
                                Switch::new("welcome-sync-it")
                                    .accessibility_label("Sync it to Pane View")
                                    .checked(self.sync_it)
                                    .on_click(cx.listener(|this, checked: &bool, _, cx| {
                                        this.sync_it = *checked;
                                        cx.notify();
                                    })),
                            ),
                    )
                    .when(self.sync_it, |this| {
                        this.child(
                            div()
                                .flex()
                                .flex_col()
                                .gap_2()
                                .px_4()
                                .pb_3()
                                .child(Input::new(&self.api_url).aria_label("Pane View API URL"))
                                .child(Input::new(&self.token).aria_label("Sync API token")),
                        )
                    }),
            );
        }
        card.into_any_element()
    }
}

fn folder_name(folder: &Path) -> String {
    folder
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| folder.display().to_string())
}

impl Render for Welcome {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let import = self.import.clone().filter(|_| self.offers_import(cx));
        let needs_folder = import.is_none() && self.needs_folder(cx);
        let folder = needs_folder.then(|| self.render_folder(cx));
        let theme = cx.theme();
        let start_label = if !self.problems.is_empty() {
            "Continue"
        } else if self.busy {
            "Setting up…"
        } else {
            "Start"
        };
        div()
            .id("welcome")
            .test_support()
            .role(Role::Region)
            .aria_label("Welcome to Oriel RS")
            .flex()
            .flex_col()
            .p_4()
            .text_color(theme.foreground)
            .child(self.render_mark(cx))
            .child(
                div()
                    .mt_6()
                    .text_center()
                    .text_2xl()
                    .font_weight(FontWeight::SEMIBOLD)
                    .child("Welcome to Oriel RS"),
            )
            .child(
                div()
                    .mt_2()
                    .text_center()
                    .text_size(px(13.))
                    .text_color(theme.muted_foreground)
                    .child("View, tidy and sync your archive, in one window."),
            )
            .when_some(folder, |this, folder| {
                this.child(
                    div()
                        .mt_6()
                        .flex()
                        .flex_col()
                        .child(
                            div()
                                .text_size(px(15.))
                                .font_weight(FontWeight::SEMIBOLD)
                                .child("Choose your archive folder"),
                        )
                        .child(
                            div()
                                .mt_0p5()
                                .text_xs()
                                .text_color(theme.muted_foreground)
                                .child(
                                    "View opens it now; Tidy and Sync can take it too. Nothing \
                                     in it changes until you ask.",
                                ),
                        )
                        .child(folder),
                )
            })
            .when(!self.problems.is_empty(), |this| {
                this.child(
                    div()
                        .id("welcome-problems")
                        .test_support()
                        .role(Role::Alert)
                        .aria_label(SharedString::from(self.problems.join("\n")))
                        .mt_4()
                        .flex()
                        .flex_col()
                        .gap_1()
                        .text_size(px(13.))
                        .text_color(theme.danger)
                        .children(self.problems.iter().cloned()),
                )
            })
            .when_some(import.clone(), |this, flow| {
                this.child(div().mt_6().child(flow))
            })
            .when(import.is_none(), |this| {
                this.child(
                    div()
                        .mt_8()
                        .flex()
                        .flex_row()
                        .justify_end()
                        .gap_2()
                        .when(self.folder.is_none() && needs_folder, |this| {
                            this.child(Button::new("welcome-skip").ghost().label("Skip").on_click(
                                cx.listener(|_, _, _, cx| {
                                    cx.emit(WelcomeEvent::Finished);
                                }),
                            ))
                        })
                        .child(
                            Button::new("welcome-start")
                                .primary()
                                .large()
                                .label(start_label)
                                .disabled(self.busy)
                                .on_click(
                                    cx.listener(|this, _, window, cx| this.start(window, cx)),
                                ),
                        ),
                )
            })
    }
}

// The import of Electron Oriel's data.

/// Where the import reads Electron Oriel's data from. Tests set it; otherwise the app finds it
/// for the owner's own data root alone ([`ElectronData::for_data_root`]), so a test or a check
/// never reads the real home.
pub struct ImportSource(pub Option<ElectronData>);

impl Global for ImportSource {}

fn import_source(data: &DataRoot, cx: &App) -> Option<ElectronData> {
    match cx.try_global::<ImportSource>() {
        Some(source) => source.0.clone(),
        None => ElectronData::for_data_root(data),
    }
}

/// `ORIEL_RS_IMPORT=1` starts the welcome's import as soon as it has looked, for a check of the
/// progress and the summary, since this Mac allows no scripted clicks.
pub const IMPORT_VARIABLE: &str = "ORIEL_RS_IMPORT";

/// Where the import shows: in the welcome, with Start Fresh beside it, or in its own dialog from
/// Settings, with Cancel.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ImportPurpose {
    Welcome,
    Settings,
}

/// What the import's buttons ask of the surface it shows in.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ImportEvent {
    /// The welcome's other choice: its folder picker.
    StartFresh,
    /// Done with it, for now.
    Close,
}

enum Stage {
    Looking,
    Nothing,
    Found(Survey),
    Importing(Arc<ImportProgress>),
    Done(Report),
    /// An import is staged from before and waits for a start to put it in place.
    Waiting,
    Failed(SharedString),
}

/// The import from looking to its summary: what was found, its progress, what came over.
pub struct ImportFlow {
    data: DataRoot,
    source: Option<ElectronData>,
    purpose: ImportPurpose,
    stage: Stage,
    _work: Option<Task<()>>,
}

impl EventEmitter<ImportEvent> for ImportFlow {}

impl ImportFlow {
    pub fn new(
        data: DataRoot,
        source: Option<ElectronData>,
        purpose: ImportPurpose,
        cx: &mut Context<Self>,
    ) -> Self {
        let mut this = Self {
            data,
            source,
            purpose,
            stage: Stage::Nothing,
            _work: None,
        };
        if oriel_migrate::pending(&this.data) {
            this.stage = Stage::Waiting;
        } else {
            this.look(cx);
        }
        this
    }

    /// Whether there is something to show: data found, an import running or done.
    pub fn offers(&self) -> bool {
        !matches!(self.stage, Stage::Nothing)
    }

    /// Whether the import is copying, when its surface must stay open.
    pub fn is_importing(&self) -> bool {
        matches!(self.stage, Stage::Importing(_))
    }

    /// What was found, once looked.
    pub fn survey(&self) -> Option<&Survey> {
        match &self.stage {
            Stage::Found(survey) => Some(survey),
            _ => None,
        }
    }

    /// What came over, once done.
    pub fn report(&self) -> Option<&Report> {
        match &self.stage {
            Stage::Done(report) => Some(report),
            _ => None,
        }
    }

    /// Counts what Electron Oriel's data holds, on a thread of its own: it copies Tidy's catalog
    /// to read it.
    fn look(&mut self, cx: &mut Context<Self>) {
        let Some(source) = self.source.clone() else {
            self.stage = Stage::Nothing;
            return;
        };
        self.stage = Stage::Looking;
        let data = self.data.clone();
        let surveyed = on_thread("oriel-rs import survey", move || Survey::of(&source, &data));
        self._work = Some(cx.spawn(async move |this, cx| {
            let survey = surveyed.await;
            this.update(cx, |this, cx| {
                this.stage = match survey {
                    Some(survey) if survey.found() => Stage::Found(survey),
                    Some(_) => Stage::Nothing,
                    None => {
                        Stage::Failed("Oriel RS could not look for Electron Oriel's data.".into())
                    }
                };
                let asked = std::env::var_os(IMPORT_VARIABLE).is_some_and(|value| value == "1");
                if asked && this.purpose == ImportPurpose::Welcome {
                    this.start(cx);
                }
                cx.notify();
            })
            .ok();
        }));
        cx.notify();
    }

    /// Imports on a thread of its own, redrawing its progress until it ends.
    fn start(&mut self, cx: &mut Context<Self>) {
        let (Some(source), Stage::Found(survey)) = (self.source.clone(), &self.stage) else {
            return;
        };
        if !survey.running.is_empty() {
            return;
        }
        let progress = Arc::new(ImportProgress::default());
        self.stage = Stage::Importing(progress.clone());
        let data = self.data.clone();
        let counting = progress.clone();
        let imported = on_thread("oriel-rs import", move || {
            oriel_migrate::import(&source, &data, &counting).map_err(|error| format!("{error:#}"))
        });
        self._work = Some(cx.spawn(async move |this, cx| {
            let mut imported = std::pin::pin!(imported);
            let outcome = loop {
                let tick = cx.background_executor().timer(PROGRESS_INTERVAL);
                match futures::future::select(imported, tick).await {
                    futures::future::Either::Left((outcome, _)) => break outcome,
                    futures::future::Either::Right((_, pending)) => {
                        imported = pending;
                        if this.update(cx, |_, cx| cx.notify()).is_err() {
                            return;
                        }
                    }
                }
            };
            this.update(cx, |this, cx| {
                this.stage = match outcome {
                    Some(Ok(report)) => Stage::Done(report),
                    Some(Err(error)) => Stage::Failed(error.into()),
                    None => Stage::Failed("The import stopped before it finished.".into()),
                };
                cx.notify();
            })
            .ok();
        }));
        cx.notify();
    }

    fn close(&mut self, cx: &mut Context<Self>) {
        cx.emit(ImportEvent::Close);
    }

    fn render_found(&self, survey: &Survey, cx: &mut Context<Self>) -> AnyElement {
        let theme = cx.theme().clone();
        let rows = survey.rows();
        let summary: SharedString = rows
            .iter()
            .map(|(mode, line)| format!("{mode}: {line}"))
            .collect::<Vec<_>>()
            .join("\n")
            .into();
        let list = div()
            .id("import-found")
            .test_support()
            .role(Role::List)
            .aria_label(summary)
            .mt_3()
            .flex()
            .flex_col()
            .overflow_hidden()
            .rounded(theme.radius_lg)
            .bg(theme.group_box)
            .border_1()
            .border_color(theme.border)
            .children(rows.into_iter().enumerate().map(|(index, (mode, line))| {
                div()
                    .id(SharedString::from(format!(
                        "import-found-{}",
                        mode.to_lowercase()
                    )))
                    .role(Role::ListItem)
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap_4()
                    .min_h(px(40.))
                    .px_4()
                    .py_2()
                    .text_size(px(13.))
                    .when(index > 0, |row| row.border_t_1().border_color(theme.border))
                    .child(div().w(px(64.)).flex_shrink_0().child(mode))
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .text_color(theme.muted_foreground)
                            .child(line),
                    )
            }));
        let moves: Vec<&str> = survey
            .moves_aside(&self.data)
            .into_iter()
            .map(|area| match area {
                Area::Shell => "preferences",
                Area::View => "View data",
                Area::Tidy => "Tidy catalog",
                Area::Sync => "Sync profiles",
                Area::HashCache => "hash cache",
            })
            .collect();
        let running = (!survey.running.is_empty()).then(|| {
            SharedString::from(format!(
                "Quit {} to import its data.",
                survey.running.join(" and ")
            ))
        });
        div()
            .flex()
            .flex_col()
            .when(self.purpose == ImportPurpose::Welcome, |this| {
                this.child(
                    div()
                        .text_size(px(15.))
                        .font_weight(FontWeight::SEMIBOLD)
                        .child("Bring over Electron Oriel's data"),
                )
            })
            .child(
                div()
                    .mt_0p5()
                    .text_xs()
                    .text_color(theme.muted_foreground)
                    .child(
                        "Oriel RS copies it into its own folder. Electron Oriel keeps its data \
                         as it is.",
                    ),
            )
            .child(list)
            .when(
                !moves.is_empty() && self.purpose == ImportPurpose::Settings,
                |this| {
                    let line = SharedString::from(format!(
                        "Oriel RS's own {} move to a before-import folder in its data folder. \
                     Nothing is deleted.",
                        and_list(&moves)
                    ));
                    this.child(
                        div()
                            .id("import-moves-aside")
                            .test_support()
                            .aria_label(line.clone())
                            .mt_3()
                            .text_xs()
                            .text_color(theme.muted_foreground)
                            .child(line),
                    )
                },
            )
            .when_some(running.clone(), |this, message| {
                this.child(
                    div()
                        .mt_3()
                        .child(Alert::warning("import-running", message.clone()).title(message)),
                )
            })
            .child(
                self.buttons(cx)
                    .when(self.purpose == ImportPurpose::Welcome, |this| {
                        this.child(
                            Button::new("import-start-fresh")
                                .ghost()
                                .label("Start Fresh")
                                .on_click(
                                    cx.listener(|_, _, _, cx| cx.emit(ImportEvent::StartFresh)),
                                ),
                        )
                    })
                    .when(self.purpose == ImportPurpose::Settings, |this| {
                        this.child(
                            Button::new("import-cancel")
                                .ghost()
                                .label("Cancel")
                                .on_click(cx.listener(|this, _, _, cx| this.close(cx))),
                        )
                    })
                    .child(match running {
                        Some(_) => Button::new("import-try-again")
                            .primary()
                            .label("Try Again")
                            .on_click(cx.listener(|this, _, _, cx| this.look(cx))),
                        None => Button::new("import-start")
                            .primary()
                            .label("Import")
                            .on_click(cx.listener(|this, _, _, cx| this.start(cx))),
                    }),
            )
            .into_any_element()
    }

    fn render_importing(&self, progress: &ImportProgress, cx: &mut Context<Self>) -> AnyElement {
        let theme = cx.theme().clone();
        let (done, total) = progress.bytes();
        let phase = progress.phase();
        let phase = if phase.is_empty() {
            "Importing…".to_owned()
        } else {
            format!("{phase}…")
        };
        div()
            .flex()
            .flex_col()
            .gap_2()
            .child(
                div()
                    .text_size(px(13.))
                    .font_weight(FontWeight::MEDIUM)
                    .child(phase.clone()),
            )
            .child(
                gpui_kit::component::progress::Progress::new("import-progress")
                    .value(progress.fraction() * 100.)
                    .accessibility_label(phase),
            )
            .child(
                div()
                    .text_xs()
                    .text_color(theme.muted_foreground)
                    .child(format!(
                        "{} of {}",
                        oriel_migrate::bytes(done.min(total)),
                        oriel_migrate::bytes(total)
                    )),
            )
            .into_any_element()
    }

    fn render_done(&self, report: &Report, cx: &mut Context<Self>) -> AnyElement {
        let theme = cx.theme().clone();
        let mut lines: Vec<(SharedString, bool)> = Vec::new();
        for area in &report.areas {
            if let Some(error) = &area.error {
                lines.push((
                    format!("{} was not imported: {error}", area.area).into(),
                    true,
                ));
            } else if area.imported {
                let details = if area.details.is_empty() {
                    "nothing to bring".to_owned()
                } else {
                    area.details.join(", ")
                };
                lines.push((format!("{}: {details}", area.area).into(), false));
                for skipped in &area.skipped {
                    lines.push((format!("Left out: {skipped}").into(), false));
                }
            }
        }
        let summary: SharedString = lines
            .iter()
            .map(|(line, _)| line.to_string())
            .collect::<Vec<_>>()
            .join("\n")
            .into();
        let failed = report.failed().count();
        div()
            .flex()
            .flex_col()
            .child(
                div()
                    .text_size(px(15.))
                    .font_weight(FontWeight::SEMIBOLD)
                    .child(if failed == 0 {
                        "Imported"
                    } else {
                        "Imported in part"
                    }),
            )
            .child(
                div()
                    .id("import-summary")
                    .test_support()
                    .role(Role::List)
                    .aria_label(summary)
                    .mt_2()
                    .flex()
                    .flex_col()
                    .gap_1()
                    .text_size(px(13.))
                    .children(lines.into_iter().map(|(line, failed)| {
                        div()
                            .text_color(if failed {
                                theme.danger
                            } else {
                                theme.foreground
                            })
                            .child(line)
                    })),
            )
            .child(self.render_restart(cx))
            .into_any_element()
    }

    /// What finishes the import: a start, which puts it in place.
    fn render_restart(&self, cx: &mut Context<Self>) -> AnyElement {
        let theme = cx.theme().clone();
        let restarts = restart_allowed();
        div()
            .flex()
            .flex_col()
            .child(
                div()
                    .mt_3()
                    .text_xs()
                    .text_color(theme.muted_foreground)
                    .child(if restarts {
                        "Restart Oriel RS to open what came over."
                    } else {
                        "Quit Oriel RS and open it again to open what came over."
                    }),
            )
            .child(
                self.buttons(cx)
                    .child(
                        Button::new("import-later")
                            .ghost()
                            .label("Later")
                            .on_click(cx.listener(|this, _, _, cx| this.close(cx))),
                    )
                    .child(
                        Button::new("import-restart")
                            .primary()
                            .label(if restarts { "Restart Now" } else { "Quit" })
                            .on_click(|_, _, cx| restart(cx)),
                    ),
            )
            .into_any_element()
    }

    fn buttons(&self, _: &mut Context<Self>) -> gpui_kit::Div {
        div().mt_6().flex().flex_row().justify_end().gap_2()
    }
}

impl Render for ImportFlow {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = cx.theme().clone();
        let content = match &self.stage {
            Stage::Looking => div()
                .flex()
                .flex_row()
                .items_center()
                .gap_2()
                .text_size(px(13.))
                .text_color(theme.muted_foreground)
                .child(Spinner::new())
                .child("Looking for Electron Oriel's data…")
                .into_any_element(),
            Stage::Nothing => div()
                .flex()
                .flex_col()
                .child(
                    div()
                        .text_size(px(13.))
                        .child("Electron Oriel's data is not on this computer."),
                )
                .child(
                    self.buttons(cx).child(
                        Button::new("import-close")
                            .primary()
                            .label("Close")
                            .on_click(cx.listener(|this, _, _, cx| this.close(cx))),
                    ),
                )
                .into_any_element(),
            Stage::Found(survey) => {
                let survey = survey.clone();
                self.render_found(&survey, cx)
            }
            Stage::Importing(progress) => {
                let progress = progress.clone();
                self.render_importing(&progress, cx)
            }
            Stage::Done(report) => {
                let report = report.clone();
                self.render_done(&report, cx)
            }
            Stage::Waiting => div()
                .flex()
                .flex_col()
                .child(
                    div()
                        .text_size(px(13.))
                        .child("An import of Electron Oriel's data is waiting."),
                )
                .child(self.render_restart(cx))
                .into_any_element(),
            Stage::Failed(message) => div()
                .flex()
                .flex_col()
                .child(
                    div()
                        .id("import-failed")
                        .test_support()
                        .role(Role::Alert)
                        .aria_label(message.clone())
                        .text_size(px(13.))
                        .text_color(theme.danger)
                        .child(format!("Nothing was imported. {message}")),
                )
                .child(
                    self.buttons(cx)
                        .child(
                            Button::new("import-close")
                                .ghost()
                                .label("Close")
                                .on_click(cx.listener(|this, _, _, cx| this.close(cx))),
                        )
                        .child(
                            Button::new("import-try-again")
                                .primary()
                                .label("Try Again")
                                .on_click(cx.listener(|this, _, _, cx| this.look(cx))),
                        ),
                )
                .into_any_element(),
        };
        div()
            .id("import")
            .test_support()
            .role(Role::Region)
            .aria_label("Import from Electron Oriel")
            .flex()
            .flex_col()
            .text_color(theme.foreground)
            .child(content)
    }
}

/// How often the import's progress redraws.
const PROGRESS_INTERVAL: Duration = Duration::from_millis(100);

/// Runs `work` on a thread of its own: the import copies gigabytes, which must not hold one of
/// the background executor's threads. Resolves to `None` if the thread panicked.
fn on_thread<R: Send + 'static>(
    name: &str,
    work: impl FnOnce() -> R + Send + 'static,
) -> impl std::future::Future<Output = Option<R>> + 'static {
    let (reply, answer) = futures::channel::oneshot::channel();
    let spawned = std::thread::Builder::new()
        .name(name.to_owned())
        .spawn(move || {
            let _ = reply.send(work());
        });
    async move {
        spawned.ok()?;
        answer.await.ok()
    }
}

/// Whether Restart Now may relaunch the app: only on the owner's own data, since a relaunch
/// through the system carries none of this run's variables (`ORIEL_RS_DATA_DIR` among them).
fn restart_allowed() -> bool {
    std::env::var_os(oriel_core_paths::DATA_DIR_VARIABLE).is_none_or(|value| value.is_empty())
}

/// Restarts the app, which puts a staged import in place before anything opens its files; quits
/// instead where it may not relaunch. Either way through the quit that waits for running work.
fn restart(cx: &mut App) {
    if restart_allowed() {
        cx.restart();
    } else {
        crate::quit::QuitGuard::request_global(cx);
    }
}

fn and_list(names: &[&str]) -> String {
    match names {
        [] => String::new(),
        [one] => (*one).to_owned(),
        [rest @ .., last] => format!("{} and {last}", rest.join(", ")),
    }
}

/// Opens the import over the window, from Settings › General: what was found and what moves
/// aside, then Import. Escape and the overlay close it, except while it copies.
pub fn open_import_dialog(data: DataRoot, window: &mut Window, cx: &mut App) {
    if window.has_active_dialog(cx) {
        return;
    }
    let source = import_source(&data, cx);
    let flow = cx.new(|cx| ImportFlow::new(data, source, ImportPurpose::Settings, cx));
    window
        .subscribe(&flow, cx, |_, event: &ImportEvent, window, cx| {
            if *event == ImportEvent::Close {
                window.close_dialog(cx);
            }
        })
        .detach();
    window.open_dialog(cx, move |dialog, _, cx| {
        let busy = flow.read(cx).is_importing();
        dialog
            .title("Import from Electron Oriel")
            .w(px(480.))
            .close_button(!busy)
            .overlay_closable(!busy)
            .keyboard(!busy)
            .child(flow.clone())
    });
}
