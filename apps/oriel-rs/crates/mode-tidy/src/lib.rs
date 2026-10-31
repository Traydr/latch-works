//! Tidy: Overview is home. Duplicates, Convert and Clean up are the work, in the order it is best
//! done, and Shrink is the optional AV1 re-encode after them; Library and History are the
//! archive; Holding sits at the foot of the sidebar. As Electron Oriel's Tidy mode draws them
//! (`apps/oriel/src/modes/tidy/renderer`), on `oriel-core-tidy`'s engine.
//!
//! [`TidyMode`] is the mode's root: the sidebar, the page on screen, the shell's Tidy commands
//! (Add Folder…, Rescan, Undo, Select All, Find, the pages on ⌥⌘1–7, the shortcut sheet) and the
//! folder picker. What the pages share lives in [`TidyState`]; changes to files go through
//! [`changes::TidyChanges`], whose implementation the app hands in. What Tidy hands the other
//! modes, and takes from them, goes through the shell as [`TidyEvent`]s and
//! [`TidyMode::show_hand_off`] ([`links`]).
//!
//! Tidy changes files in any folder the owner adds, as Electron Oriel's does (plan 063, decision
//! 18). A sandboxed run (`ORIEL_RS_DATA_DIR` set, for checks and agents) keeps to roots under
//! `DataRoot::sandbox()` or the temp folder, and its folder picker and welcome say so.

mod actions;
pub mod changes;
mod check;
mod cleanup;
mod convert;
pub mod duplicates;
mod folder_picker;
pub mod format;
mod history;
mod holding;
pub mod library;
pub mod links;
mod loaded;
mod overview;
mod page_spike;
mod pages;
mod quick_look;
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

pub use actions::{PerformOptions, TidyStep};
pub use changes::{Changes, EngineChanges, NotYet, TidyChanges};
pub use duplicates::DuplicatesPage;
pub use folder_picker::{FolderPicker, PickOptions};
pub use library::{LibraryMenu, LibraryMode, LibraryPage, MenuChoice, last_menu};
pub use links::TidyEvent;
pub use overview::OverviewPage;
pub use pages::TidyPage;
pub use quick_look::{QUICK_LOOK_LABEL, last_quick_look};
pub use state::{LibraryPreset, TidyState};
pub use synthetic::{LibraryColumn, LibraryDelegate, LibraryRow, SyntheticLibrary, synthetic_rows};
pub use widgets::last_toast;

use std::path::PathBuf;
use std::rc::Rc;
use std::time::Instant;

use gpui_kit::assets::IconName;
use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::{ActiveTheme as _, Icon, Sizable as _, WindowExt as _};
use gpui_kit::{
    AnyElement, AnyView, AppContext as _, Context, Entity, EventEmitter, ExternalPaths,
    FocusHandle, Focusable, FontWeight, InteractiveElement as _, IntoElement, KeyDownEvent,
    ParentElement as _, Render, Styled as _, Subscription, Window, div, px,
};
use oriel_core_paths::DataRoot;
use oriel_ui::{HandOff, ModeId, ModeLayout, OfferedFolders, ShellState, TopBar, commands};

use crate::cleanup::CleanupPage;
use crate::convert::ConvertPage;
use crate::history::HistoryPage;
use crate::holding::HoldingPage;
use crate::shrink::ShrinkPage;
use crate::thumbs::Thumbs;

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
    /// Phase 0's Library of synthetic rows, shown in place of the catalog's only when the spike
    /// asks for it (`ORIEL_RS_SPIKE_LIBRARY`).
    spike: Option<Entity<SyntheticLibrary>>,
    /// The pages spike, when `ORIEL_RS_SPIKE_TIDY` asks for it.
    page_spike: Option<page_spike::PageSpike>,
    /// The page on screen, as the state last said.
    page: TidyPage,
    /// Tidy's own Settings section, which keeps a folder picker's answer.
    settings: Entity<settings::SettingsSection>,
    /// What another mode handed Tidy before its engine had listed its folders.
    pending_hand_off: Option<HandOff>,
    _subscriptions: Vec<Subscription>,
}

impl EventEmitter<TidyEvent> for TidyMode {}

impl TidyMode {
    /// Tidy for the shell, keeping its catalog in this run's data folder (`ORIEL_RS_DATA_DIR`, or
    /// `~/.latch-works/oriel-rs`), changing files through the engine's executor. With the variable
    /// set, the engine refuses any root outside the sandbox.
    pub fn new(shell: &Entity<ShellState>, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let data = DataRoot::from_environment().expect("Oriel RS needs a data folder");
        let mut tidy = Self::with_data(shell, &data, Rc::new(EngineChanges), window, cx);
        tidy.page_spike = page_spike::PageSpike::from_environment();
        tidy.spike = spike::requested_rows().map(|count| {
            let started = Instant::now();
            let rows = synthetic_rows(count);
            let measured = spike::LibrarySpike::from_environment(started.elapsed());
            shell.update(cx, |shell, cx| shell.go(ModeId::Tidy, cx));
            cx.new(|cx| SyntheticLibrary::new(rows, measured, window, cx))
        });
        if tidy.spike.is_some() {
            tidy.state
                .update(cx, |state, cx| state.go(TidyPage::Library, cx));
        }
        let state = tidy.state.clone();
        if let Some(subscription) = check::apply_from_environment(&state, window, cx) {
            tidy._subscriptions.push(subscription);
        }
        tidy
    }

    /// Tidy keeping its catalog under `data`, changing files through `changes`.
    pub fn with_data(
        shell: &Entity<ShellState>,
        data: &DataRoot,
        changes: Changes,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let state = cx.new(|cx| TidyState::new(shell, data.clone(), changes, cx));
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
            // The pages' Open in View and Sync this folder go to the shell.
            cx.subscribe(&state, |_, _, event: &TidyEvent, cx| cx.emit(event.clone())),
            // Pause, Resume and Stop from the shell's activity panel.
            cx.subscribe_in(
                &shell.read(cx).jobs().clone(),
                window,
                |this, _, command: &oriel_ui::JobCommand, window, cx| {
                    this.state
                        .update(cx, |state, cx| state.on_job_command(command, window, cx));
                },
            ),
            // A hand-off that came while the engine started is shown once its folders are in.
            cx.observe_in(&state, window, |this, state, window, cx| {
                if state.read(cx).is_ready()
                    && let Some(target) = this.pending_hand_off.take()
                {
                    links::take(&state, target, window, cx);
                }
            }),
            // Tidy takes the keys when it comes on screen, so its commands and page keys reach it.
            // Leaving the screen, it pauses Duplicates' video, as Electron Oriel pauses a hidden
            // mode's media.
            cx.observe_in(shell, window, |this, shell, window, cx| {
                let shell = shell.read(cx);
                if shell.mode() == ModeId::Tidy && shell.settings().is_none() {
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
                        if this.shell.read(cx).mode() == ModeId::Tidy {
                            this.focus_page(window, cx);
                        }
                    }
                }
            }),
        ];
        let page = state.read(cx).page();
        Self {
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
            pending_hand_off: None,
            _subscriptions: subscriptions,
        }
    }

    /// Shows what another mode handed Tidy (Show in Tidy, Tidy this folder): the folder of
    /// Tidy's that holds it, at the Library filtered to it; a folder none holds is added, once
    /// the owner agrees for a file's (`useHandOff`, `showHandOff`). Waits for the engine to list
    /// its folders first.
    pub fn show_hand_off(&mut self, target: HandOff, window: &mut Window, cx: &mut Context<Self>) {
        if self.state.read(cx).is_ready() {
            links::take(&self.state, target, window, cx);
        } else {
            self.pending_hand_off = Some(target);
        }
    }

    /// This mode's section of the one Settings page (⌘,).
    pub fn settings_section(&mut self, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        self.settings
            .update(cx, |section, cx| section.render_section(window, cx))
    }

    pub fn state(&self) -> &Entity<TidyState> {
        &self.state
    }

    pub fn overview(&self) -> &Entity<OverviewPage> {
        &self.overview
    }

    pub fn duplicates(&self) -> &Entity<DuplicatesPage> {
        &self.duplicates
    }

    pub fn library(&self) -> &Entity<LibraryPage> {
        &self.library
    }

    /// Phase 0's synthetic Library, when the spike runs.
    pub fn spike_library(&self) -> Option<&Entity<SyntheticLibrary>> {
        self.spike.as_ref()
    }

    /// The page on screen.
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

    fn go(&mut self, page: TidyPage, cx: &mut Context<Self>) {
        self.state.update(cx, |state, cx| state.go(page, cx));
    }

    fn on_key_down(&mut self, event: &KeyDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        // ? opens the shortcut sheet from anywhere but a text field.
        if event.keystroke.key_char.as_deref() == Some("?") && !window.has_focused_input(cx) {
            shortcuts::open(window, cx);
            cx.stop_propagation();
        }
    }

    fn render_welcome(&self, cx: &mut Context<Self>) -> AnyElement {
        let theme = cx.theme();
        let data = self.state.read(cx).data();
        // Only a sandboxed run says where Tidy may work; the owner's takes any folder.
        let rule = data.is_sandboxed().then(|| links::sandbox_rule(data));
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
                            .primary()
                            .large()
                            .mt_6()
                            .label("Choose folder…")
                            .child(widgets::key_hint("⌘O"))
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
                            .text_xs()
                            .text_color(theme.muted_foreground)
                            .child(Icon::new(IconName::Lock).size(px(14.)).flex_shrink_0())
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
        if unfocused && self.shell.read(cx).mode() == ModeId::Tidy {
            self.focus_page(window, cx);
        }
        let rail = self.shell.read(cx).rail();
        let navigation = sidebar::navigation(&self.state, rail, cx);
        let footer = sidebar::footer(&self.state, rail, window, cx);
        let content = self.render_content(cx);
        let _ = &self.thumbs;

        div()
            .id("tidy")
            .track_focus(&self.focus)
            .size_full()
            .on_key_down(cx.listener(Self::on_key_down))
            .on_action(cx.listener(|this, _: &commands::AddFolder, window, cx| {
                this.choose_folder(window, cx);
            }))
            .on_action(cx.listener(|this, _: &commands::Rescan, window, cx| {
                this.state.update(cx, |state, cx| {
                    if let Some(root_id) = state.root_id() {
                        state.start_scan(root_id, window, cx);
                    }
                });
            }))
            .on_action(cx.listener(|this, _: &commands::UndoChange, window, cx| {
                // A text field keeps ⌘Z for its own undo.
                if window.has_focused_input(cx) {
                    cx.propagate();
                    return;
                }
                this.state
                    .update(cx, |state, cx| state.undo_last(window, cx));
            }))
            .on_action(
                cx.listener(|this, _: &commands::SelectAllItems, window, cx| {
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
                }),
            )
            .on_action(cx.listener(|this, _: &commands::Find, _, cx| {
                this.state.update(cx, |state, cx| state.request_search(cx));
            }))
            .on_action(cx.listener(|_, _: &commands::ShowShortcuts, window, cx| {
                shortcuts::open(window, cx);
            }))
            .on_action(cx.listener(|this, _: &commands::ShowOverview, _, cx| {
                this.go(TidyPage::Overview, cx);
            }))
            .on_action(cx.listener(|this, _: &commands::ShowDuplicates, _, cx| {
                this.go(TidyPage::Duplicates, cx);
            }))
            .on_action(cx.listener(|this, _: &commands::ShowConvert, _, cx| {
                this.go(TidyPage::Convert, cx);
            }))
            .on_action(cx.listener(|this, _: &commands::ShowCleanUp, _, cx| {
                this.go(TidyPage::CleanUp, cx);
            }))
            .on_action(cx.listener(|this, _: &commands::ShowLibrary, _, cx| {
                this.go(TidyPage::Library, cx);
            }))
            .on_action(cx.listener(|this, _: &commands::ShowHistory, _, cx| {
                this.go(TidyPage::History, cx);
            }))
            .on_action(cx.listener(|this, _: &commands::ShowHolding, _, cx| {
                this.go(TidyPage::Holding, cx);
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
