//! Tidy: Overview is home. Duplicates, Convert and Clean up are the work, in any order, and Shrink
//! is the optional AV1 re-encode beside them; Library and History are the archive; Holding sits at
//! the foot of the sidebar, on `oriel-core-tidy`'s engine.
//!
//! [`TidyMode`] is the mode's root: the sidebar, the page on screen, Tidy's commands (Add
//! Folder…, Rescan, Undo, Select All, Find, the pages on ⌥⌘1–7) and the folder picker. What the
//! pages share lives in [`TidyState`]: every scan, analysis and change is a job running one of the
//! engine's operations, whose queue decides when each runs, and the state reports them to the
//! shell's activity panel. What Tidy hands the other modes, and takes from them, goes through the
//! shell ([`links`]).
//!
//! Tidy changes files in any folder the owner adds (plan 063, decision 18). A sandboxed run
//! (`ORIEL_DATA_DIR` set, for checks and agents) keeps to roots under `DataRoot::sandbox()` or
//! the temp folder, and its folder picker and welcome say so.

mod actions;
mod check;
mod cleanup;
mod convert;
pub mod duplicates;
mod folder_picker;
mod history;
mod holding;
mod labels;
pub mod library;
pub mod links;
mod loaded;
mod overview;
mod page_spike;
mod pages;
mod quick_look;
mod selection;
mod settings;
mod shortcuts;
mod shrink;
mod sidebar;
mod spike;
pub mod state;
mod synthetic;
mod thumbs;
mod widgets;
mod windowed;

pub use duplicates::DuplicatesPage;
pub use holding::HoldingPage;
pub use library::{LibraryMenu, LibraryMode, LibraryPage, MenuChoice, last_menu};
pub use loaded::TidyClient;
pub use pages::{ShowPage, TidyPage};
pub use quick_look::last_quick_look;
pub use state::TidyState;

use std::path::PathBuf;
use std::time::Instant;

use gpui_kit::assets::IconName;
use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::{ActiveTheme as _, Icon, WindowExt as _};
use gpui_kit::{
    AnyElement, AnyView, App, AppContext as _, Context, Entity, ExternalPaths, FocusHandle,
    Focusable, FontWeight, InteractiveElement as _, IntoElement, KeyDownEvent, ParentElement as _,
    Render, SharedString, Styled as _, Subscription, Task, Window, actions, div, px,
};
use oriel_launch::Launch;
use oriel_ui::shortcuts::Sheet;
use oriel_ui::{
    Command, ControlSize as _, FolderSetUp, Foot, HandOff, MenuSlot, Mode, ModeId, ModeLayout,
    ModeReporter, OfferedFolders, ShellState, TextRole as _, TopBar,
};

use crate::cleanup::CleanupPage;
use crate::convert::ConvertPage;
use crate::folder_picker::PickOptions;
use crate::history::HistoryPage;
use crate::overview::OverviewPage;
use crate::shrink::ShrinkPage;
use crate::synthetic::{SyntheticLibrary, synthetic_rows};
use crate::thumbs::Thumbs;

actions!(
    tidy,
    [
        /// Tidy's folder picker, to add a root.
        AddFolder,
        /// The root on screen scanned again.
        Rescan,
        /// The last change undone, or the text field's own undo when one has focus.
        UndoChange,
        /// Every file on the page selected, or the text field's text.
        SelectAllItems,
        /// The page's search.
        Find
    ]
);

pub(crate) const ADD_FOLDER_KEYS: &str = oriel_ui::cmd_or_ctrl!("o");
pub(crate) const RESCAN_KEYS: &str = oriel_ui::cmd_or_ctrl!("r");

/// Work waiting for the engine to list its folders.
type WhenReady = Box<dyn FnOnce(&mut TidyMode, &mut Window, &mut Context<TidyMode>)>;

pub struct TidyMode {
    shell: Entity<ShellState>,
    state: Entity<TidyState>,
    thumbs: Entity<Thumbs>,
    overview: Entity<OverviewPage>,
    duplicates: Entity<DuplicatesPage>,
    convert: Entity<ConvertPage>,
    cleanup: Entity<CleanupPage>,
    shrink: Entity<ShrinkPage>,
    library: Entity<LibraryPage>,
    history: Entity<HistoryPage>,
    holding: Entity<HoldingPage>,
    /// Tidy's own focus, drawn on its root whatever is on screen, so the shell can hand the keys
    /// to Tidy as it comes on screen (⌘2); Tidy passes them on to the page on screen, and keeps
    /// them while there is none (the welcome, "Starting…").
    focus: FocusHandle,
    /// The Library of synthetic rows, shown in place of the catalog's only when the spike
    /// asks for it.
    spike: Option<Entity<SyntheticLibrary>>,
    /// The pages spike, when `ORIEL_SPIKE_TIDY` asks for it.
    page_spike: Option<page_spike::PageSpike>,
    /// The page on screen, as the state last said.
    page: TidyPage,
    /// Tidy's own Settings section, which keeps a folder picker's answer.
    settings: Entity<settings::SettingsSection>,
    /// What waits for the engine to list its folders: a hand-off, the welcome's folder.
    when_ready: Vec<WhenReady>,
    _subscriptions: Vec<Subscription>,
}

impl TidyMode {
    /// Tidy keeping its catalog under the launch's data root, changing files through the engine's
    /// executor, set up for the checks and spikes the launch asks for. In a sandboxed run the
    /// engine refuses any root outside the sandbox.
    pub fn new(
        shell: &Entity<ShellState>,
        launch: &Launch,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let checks = &check::TidyChecks::from_variables(&launch.variables);
        let spikes = &launch.variables;
        let state = cx.new(|cx| TidyState::new(shell, launch.data.clone(), window, cx));
        let thumbs = cx.new(|_| Thumbs::new());
        let overview = cx.new(|cx| OverviewPage::new(&state, &thumbs, cx));
        let duplicates = cx.new(|cx| DuplicatesPage::new(&state, &thumbs, cx));
        let convert = cx.new(|cx| ConvertPage::new(&state, &thumbs, cx));
        let cleanup = cx.new(|cx| CleanupPage::new(&state, &thumbs, cx));
        let shrink = cx.new(|cx| ShrinkPage::new(&state, &thumbs, cx));
        let library = cx.new(|cx| LibraryPage::new(&state, &thumbs, window, cx));
        let history = cx.new(|cx| HistoryPage::new(&state, &thumbs, cx));
        let holding = cx.new(|cx| HoldingPage::new(&state, &thumbs, cx));
        let settings = cx.new(|_| settings::SettingsSection::new(&state));
        let focus = cx.focus_handle();
        let subscriptions = vec![
            cx.observe(shell, |_, _, cx| cx.notify()),
            cx.observe(&state, |this, state, cx| {
                this.page = state.read(cx).page();
                cx.notify();
            }),
            ModeReporter::new(shell, ModeId::Tidy).on_command(
                window,
                cx,
                |this, command, _, cx| {
                    this.state
                        .update(cx, |state, cx| state.on_job_command(command, cx));
                },
            ),
            // What came while the engine started goes on once its folders are in, or once it
            // failed to open, which then says why.
            cx.observe_in(&state, window, |this, state, window, cx| {
                let current = state.read(cx);
                if current.is_ready() || current.engine_error().is_some() {
                    for work in std::mem::take(&mut this.when_ready) {
                        work(this, window, cx);
                    }
                }
            }),
            // Tidy takes the keys when it comes on screen, so its commands and page keys reach it.
            // Leaving the screen, it pauses Duplicates' video, as a hidden mode's media pauses.
            cx.observe_in(shell, window, |this, shell, window, cx| {
                if shell.read(cx).shows(ModeId::Tidy) {
                    this.focus_page(window, cx);
                } else {
                    this.duplicates
                        .update(cx, |page, cx| page.pause_video(window, cx));
                }
            }),
            // A new page takes the keys, so the sidebar item keeps no focus while they are used.
            cx.observe_in(&state, window, {
                let mut shown = None;
                move |this, state, window, cx| {
                    let page = state.read(cx).page();
                    if shown != Some(page) {
                        shown = Some(page);
                        if this.shell.read(cx).shows(ModeId::Tidy) {
                            this.focus_page(window, cx);
                        }
                    }
                }
            }),
        ];
        let page = state.read(cx).page();
        let mut tidy = Self {
            shell: shell.clone(),
            state,
            thumbs,
            overview,
            duplicates,
            convert,
            cleanup,
            shrink,
            library,
            history,
            holding,
            focus,
            spike: None,
            page_spike: None,
            page,
            settings,
            when_ready: Vec::new(),
            _subscriptions: subscriptions,
        };
        tidy.page_spike = page_spike::PageSpike::start(spikes);
        tidy.spike = spike::requested_rows(spikes).map(|count| {
            let started = Instant::now();
            let rows = synthetic_rows(count);
            let measured = spike::LibrarySpike::start(spikes, started.elapsed());
            shell.update(cx, |shell, cx| shell.go(ModeId::Tidy, cx));
            cx.new(|cx| SyntheticLibrary::new(rows, measured, window, cx))
        });
        if tidy.spike.is_some() {
            tidy.state
                .update(cx, |state, cx| state.go(TidyPage::Library, cx));
        }
        let state = tidy.state.clone();
        if let Some(subscription) = check::apply(checks, &state, window, cx) {
            tidy._subscriptions.push(subscription);
        }
        tidy
    }

    /// Runs `work` once the engine has listed its folders, or has failed to open.
    fn when_ready(
        &mut self,
        work: impl FnOnce(&mut Self, &mut Window, &mut Context<Self>) + 'static,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let state = self.state.read(cx);
        if state.is_ready() || state.engine_error().is_some() {
            work(self, window, cx);
        } else {
            self.when_ready.push(Box::new(work));
        }
    }

    pub fn state(&self) -> &Entity<TidyState> {
        &self.state
    }

    pub fn duplicates(&self) -> &Entity<DuplicatesPage> {
        &self.duplicates
    }

    pub fn library(&self) -> &Entity<LibraryPage> {
        &self.library
    }

    pub fn holding(&self) -> &Entity<HoldingPage> {
        &self.holding
    }

    pub fn page(&self) -> TidyPage {
        self.page
    }

    pub fn show(&mut self, page: TidyPage, cx: &mut Context<Self>) {
        self.state.update(cx, |state, cx| state.go(page, cx));
    }

    /// Adds `folder` as a root and scans it, as a folder chosen in the picker is.
    pub fn add_folder(&mut self, folder: PathBuf, window: &mut Window, cx: &mut Context<Self>) {
        self.state
            .update(cx, |state, cx| state.add_folder(folder, window, cx));
    }

    /// Opens Tidy's folder picker to add a root (Add Folder…, ⌘O).
    pub fn choose_folder(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        open_add_folder(&self.state, window, cx);
    }

    fn focus_page(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let target = self
            .page_view(cx)
            .map(|(_, focus)| focus)
            .unwrap_or_else(|| self.focus.clone());
        if !target.contains_focused(window, cx) {
            cx.defer_in(window, move |_, window, cx| target.focus(window, cx));
        }
    }

    /// The page on screen and its focus, once there is a folder to show.
    fn page_view(&self, cx: &gpui_kit::App) -> Option<(AnyView, FocusHandle)> {
        let state = self.state.read(cx);
        if !state.is_ready() || state.root().is_none() {
            return None;
        }
        Some(match state.page() {
            TidyPage::Library if self.spike.is_some() => {
                let spike = self.spike.as_ref()?;
                (spike.clone().into(), self.focus.clone())
            }
            TidyPage::Overview => view(&self.overview, cx),
            TidyPage::Duplicates => view(&self.duplicates, cx),
            TidyPage::Convert => view(&self.convert, cx),
            TidyPage::CleanUp => view(&self.cleanup, cx),
            TidyPage::Shrink => view(&self.shrink, cx),
            TidyPage::Library => view(&self.library, cx),
            TidyPage::History => view(&self.history, cx),
            TidyPage::Holding => view(&self.holding, cx),
        })
    }

    fn on_key_down(&mut self, event: &KeyDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        // It is the open menu's, or nothing's; the page must not act on it behind the menu.
        if oriel_ui::popups::popup_open(window, cx) {
            return;
        }
        if oriel_ui::keys::command_held(&event.keystroke.modifiers)
            && event.keystroke.key == "enter"
        {
            self.run_main_action(window, cx);
            cx.stop_propagation();
            return;
        }
        // Tab can leave focus on a sidebar row, outside the page, whose number keys still mean
        // what they say on the page.
        if oriel_ui::keys::digit_key(&event.keystroke).is_some()
            && self.state.read(cx).page() == pages::TidyPage::Duplicates
            && window.focused(cx).is_some_and(|focused| focused.tab_stop)
            && !window.has_focused_input(cx)
            && !self
                .duplicates
                .read(cx)
                .focus_handle(cx)
                .contains_focused(window, cx)
        {
            self.duplicates
                .update(cx, |page, cx| page.on_key_down(event, window, cx));
        }
    }

    /// ⌘↩: the main action of the page on screen, where it has one.
    fn run_main_action(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        match self.state.read(cx).page() {
            TidyPage::Overview => self
                .overview
                .update(cx, |page, cx| page.tidy_up(window, cx)),
            TidyPage::Convert => self.convert.update(cx, |page, cx| page.convert(window, cx)),
            TidyPage::CleanUp => self
                .cleanup
                .update(cx, |page, cx| page.clean_up(window, cx)),
            TidyPage::Shrink => self.shrink.update(cx, |page, cx| page.shrink(window, cx)),
            _ => {}
        }
    }

    fn render_welcome(&self, cx: &mut Context<Self>) -> AnyElement {
        let theme = cx.theme();
        let data = self.state.read(cx).data();
        // Only a sandboxed run says where Tidy may work; the owner's takes any folder.
        let rule = data
            .is_sandboxed()
            .then(|| oriel_core_tidy::sandbox_rule(data));
        div()
            .flex()
            .flex_1()
            .min_h_0()
            .items_center()
            .justify_center()
            .p_10()
            .pb(px(100.))
            .on_drop(cx.listener(|this, paths: &ExternalPaths, window, cx| {
                for path in paths.paths() {
                    this.add_folder(path.clone(), window, cx);
                }
            }))
            .child(
                div()
                    .id("tidy-welcome")
                    .flex()
                    .flex_col()
                    .items_center()
                    .w(px(480.))
                    .max_w_full()
                    .px_10()
                    .py_12()
                    .rounded(theme.radius_lg * 1.5)
                    .border_2()
                    .border_dashed()
                    .border_color(theme.border)
                    .text_center()
                    .child(
                        Icon::new(ModeId::Tidy.icon())
                            .size(px(48.))
                            .text_color(theme.primary),
                    )
                    .child(
                        div()
                            .mt_4()
                            .text_xl()
                            .font_weight(FontWeight::SEMIBOLD)
                            .child("Choose your media archive"),
                    )
                    .child(
                        div()
                            .mt_2()
                            .max_w(px(360.))
                            .text_sm()
                            .text_color(theme.muted_foreground)
                            .child(
                                "Tidy finds duplicates, converts files to AVIF and MP4, and \
                                 cleans up junk. Every change can be undone.",
                            ),
                    )
                    .child(
                        Button::new("choose-folder")
                            .page_size()
                            .primary()
                            .mt_6()
                            .label("Choose folder…")
                            .child(widgets::key_hint(ADD_FOLDER_KEYS))
                            .on_click(cx.listener(|this, _, window, cx| {
                                this.choose_folder(window, cx);
                            })),
                    )
                    .child(widgets::caption("or drop a folder here", cx).mt_3())
                    .children(self.render_offered(cx))
                    .children(rule.map(|rule| {
                        div()
                            .mt_6()
                            .flex()
                            .flex_row()
                            .items_start()
                            .gap_2()
                            .text_left()
                            .text_caption()
                            .text_color(theme.muted_foreground)
                            .child(Icon::new(IconName::Lock).size(px(16.)).flex_shrink_0())
                            .child(div().flex_1().min_w_0().child(rule))
                    })),
            )
            .into_any_element()
    }

    /// The folders View and Sync work on, offered while Tidy has none of its own. A sandboxed run
    /// offers only folders inside the sandbox; the note under them says so.
    fn render_offered(&self, cx: &gpui_kit::App) -> Option<OfferedFolders> {
        let data = self.state.read(cx).data().clone();
        let folders: Vec<_> = self
            .shell
            .read(cx)
            .offered_to(ModeId::Tidy)
            .into_iter()
            .filter(|folder| data.admits_tidy_root(folder.path()))
            .collect();
        if folders.is_empty() {
            return None;
        }
        let state = self.state.clone();
        Some(
            OfferedFolders::new("tidy-offered-folders", folders).on_choose(
                move |folder, window, cx| {
                    let folder = folder.path().to_path_buf();
                    state.update(cx, |state, cx| state.add_folder(folder, window, cx));
                },
            ),
        )
    }

    fn render_content(&self, cx: &mut Context<Self>) -> AnyElement {
        if let Some((view, _)) = self.page_view(cx) {
            return div()
                .flex()
                .flex_col()
                .flex_1()
                .min_h_0()
                .child(view)
                .into_any_element();
        }
        let state = self.state.read(cx);
        let title = state.page().label();
        let body = if let Some(error) = state.engine_error() {
            widgets::empty_state(
                "tidy-engine-error",
                Some(IconName::TriangleAlert),
                "Tidy's catalog did not open",
                Some(error.clone().into_any_element()),
                Vec::new(),
                cx,
            )
            .into_any_element()
        } else if !state.is_ready() {
            widgets::empty_state("tidy-starting", None, "Starting…", None, Vec::new(), cx)
                .into_any_element()
        } else {
            self.render_welcome(cx)
        };
        div()
            .id("tidy-start")
            .flex()
            .flex_col()
            .flex_1()
            .min_h_0()
            .child(TopBar::new(&self.shell, title))
            .child(body)
            .into_any_element()
    }
}

fn view<T: Render + Focusable>(page: &Entity<T>, cx: &gpui_kit::App) -> (AnyView, FocusHandle) {
    (page.clone().into(), page.read(cx).focus_handle(cx))
}

impl Render for TidyMode {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        if let Some(mut spike) = self.page_spike.take() {
            spike.on_frame(self, window, cx);
            self.page_spike = Some(spike);
        }
        // Keys and the menu's commands reach the page on screen when nothing else has focus, as
        // after a launch, and when the shell hands Tidy the keys as it comes on screen (⌘2).
        let unfocused = window.focused(cx).is_none() || self.focus.is_focused(window);
        if unfocused && self.shell.read(cx).shows(ModeId::Tidy) {
            self.focus_page(window, cx);
        }
        let rail = self.shell.read(cx).rail();
        let navigation = sidebar::navigation(&self.state, rail, window, cx);
        let footer = sidebar::footer(&self.state, rail, window, cx);
        let content = self.render_content(cx);

        div()
            .id("tidy")
            .track_focus(&self.focus)
            .size_full()
            .on_key_down(cx.listener(Self::on_key_down))
            .capture_any_mouse_down(oriel_ui::popups::note_press)
            .child(oriel_ui::popups::press_guard())
            .on_action(cx.listener(|this, _: &AddFolder, window, cx| {
                this.choose_folder(window, cx);
            }))
            .on_action(cx.listener(|this, _: &Rescan, window, cx| {
                this.state.update(cx, |state, cx| {
                    if let Some(root_id) = state.root_id() {
                        state.start_scan(root_id, window, cx);
                    }
                });
            }))
            .on_action(cx.listener(|this, _: &UndoChange, window, cx| {
                // A text field keeps ⌘Z for its own undo.
                if window.has_focused_input(cx) {
                    cx.propagate();
                    return;
                }
                // It would move files back behind an open menu.
                if oriel_ui::popups::popup_open(window, cx) {
                    return;
                }
                this.state
                    .update(cx, |state, cx| state.undo_last(window, cx));
            }))
            .on_action(cx.listener(|this, _: &SelectAllItems, window, cx| {
                if window.has_focused_input(cx) {
                    cx.propagate();
                    return;
                }
                match this.state.read(cx).page() {
                    TidyPage::Library => this
                        .library
                        .update(cx, |library, cx| library.select_all(window, cx)),
                    TidyPage::Holding => this
                        .holding
                        .update(cx, |holding, cx| holding.select_all(cx)),
                    _ => {}
                }
            }))
            .on_action(cx.listener(|this, _: &Find, _, cx| {
                this.state.update(cx, |state, cx| state.request_search(cx));
            }))
            .on_action(cx.listener(|this, ShowPage(page): &ShowPage, _, cx| {
                this.show(*page, cx);
            }))
            .child(
                ModeLayout::new(&self.shell)
                    .navigation(navigation)
                    .navigation_label("Tidy")
                    .footer(footer)
                    .child(content),
            )
    }
}

/// Tidy's root, which the shell focuses as Tidy comes on screen; the page on screen takes the
/// keys from there. The Library's synthetic spike has none of its own and keeps Tidy's.
impl Focusable for TidyMode {
    fn focus_handle(&self, _: &gpui_kit::App) -> FocusHandle {
        self.focus.clone()
    }
}

/// Opens Tidy's folder picker to add a root (Add Folder…, ⌘O): beside the folder on screen,
/// inside the sandbox.
pub(crate) fn open_add_folder(
    state: &Entity<TidyState>,
    window: &mut Window,
    cx: &mut gpui_kit::App,
) {
    let current = state.read(cx);
    let data = current.data().clone();
    let root = current.root().map(|root| PathBuf::from(&root.path));
    let options = PickOptions {
        title: "Choose a folder to tidy".into(),
        action: "Choose".into(),
        start: root
            .as_ref()
            .and_then(|root| root.parent().map(PathBuf::from)),
        select: root,
        within: None,
        sandbox: data.is_sandboxed().then_some(data),
    };
    let state = state.clone();
    folder_picker::open(options, window, cx, move |folder, window, cx| {
        state.update(cx, |state, cx| state.add_folder(folder, window, cx));
    });
}

impl Mode for TidyMode {
    const ID: ModeId = ModeId::Tidy;

    fn commands() -> Vec<Command> {
        let mut commands = vec![
            Command::new(AddFolder)
                .menu(MenuSlot::File, "Add Folder…")
                .keys(ADD_FOLDER_KEYS)
                .sheet("Add folder"),
            Command::new(Rescan)
                .menu(MenuSlot::File, "Rescan")
                .keys(RESCAN_KEYS)
                .sheet("Rescan"),
            Command::new(UndoChange)
                .menu(MenuSlot::Undo, "Undo")
                .keys(oriel_ui::cmd_or_ctrl!("z"))
                .sheet("Undo"),
            Command::new(SelectAllItems)
                .menu(MenuSlot::SelectAll, "Select All")
                .keys(oriel_ui::cmd_or_ctrl!("a")),
            Command::new(Find)
                .menu(MenuSlot::Edit, "Find")
                .keys(oriel_ui::cmd_or_ctrl!("f"))
                .sheet("Find"),
        ];
        commands.extend(TidyPage::ALL.into_iter().filter_map(|page| {
            Some(
                Command::new(ShowPage(page))
                    .menu(MenuSlot::View, page.label())
                    .keys(page.keys()?)
                    .sheet(page.label()),
            )
        }));
        commands
    }

    fn sheet() -> Sheet {
        shortcuts::SHEET
    }

    fn folders(&self, cx: &App) -> Vec<PathBuf> {
        self.state
            .read(cx)
            .roots()
            .iter()
            .map(|root| PathBuf::from(&root.path))
            .collect()
    }

    /// What the page on screen keeps at the foot for its own commands.
    fn foot(&self, cx: &App) -> Foot {
        match self.state.read(cx).page() {
            TidyPage::Duplicates => {
                let page = self.duplicates.read(cx);
                Foot {
                    height: px(page.foot_height()),
                    toast_slot: page.toast_slot(),
                    activity_room: page.activity_room(),
                }
            }
            TidyPage::Library => Foot::height(px(self.library.read(cx).foot_height(cx))),
            TidyPage::Holding => Foot::height(px(self.holding.read(cx).foot_height())),
            _ => Foot::default(),
        }
    }

    fn settings_section(&mut self, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        self.settings
            .update(cx, |section, cx| section.render_section(window, cx))
    }

    /// Shows what another mode handed Tidy (Show in Tidy, Tidy this folder): the folder of
    /// Tidy's that holds it, at the Library filtered to it; a folder none holds is added, once
    /// the owner agrees for a file's. Waits for the engine to list its folders first.
    fn show_hand_off(&mut self, target: HandOff, window: &mut Window, cx: &mut Context<Self>) {
        self.shell
            .update(cx, |shell, cx| shell.go(ModeId::Tidy, cx));
        self.when_ready(
            move |this, window, cx| links::take(&this.state, target, window, cx),
            window,
            cx,
        );
    }

    /// Adds the folder as a root and scans it, once the engine has listed its folders.
    fn set_up(
        &mut self,
        set_up: &FolderSetUp,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Task<Result<(), SharedString>> {
        if !set_up.tidy {
            return Task::ready(Ok(()));
        }
        let (added, adding) = futures::channel::oneshot::channel();
        let folder = set_up.folder.clone();
        self.when_ready(
            move |this, window, cx| {
                let task = this
                    .state
                    .update(cx, |state, cx| state.add_root(folder, window, cx));
                added.send(task).ok();
            },
            window,
            cx,
        );
        cx.spawn(async move |_, _| {
            let task = adding
                .await
                .map_err(|_| SharedString::from("Tidy closed."))?;
            task.await.map(|_| ())
        })
    }
}
