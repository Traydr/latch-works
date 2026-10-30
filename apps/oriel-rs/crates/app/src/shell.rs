//! The window's root: the shell's state, the three modes, and the one Settings page. Only the
//! mode on screen is drawn; the others keep their state in their entities.
//!
//! The shell does for every mode what Electron Oriel's main process and `ShellProvider` do: the
//! window's title and the menu bar follow the mode; the mode, the sidebar's form and the window's
//! bounds are remembered; the Dock shows running work; closing the window waits for it; and paths
//! the system hands the app open in View.
//!
//! It also links the modes. Each mode says what it wants of another with an event (View's Show
//! in Tidy, Tidy's Open in View and Sync this folder, Sync's Open in View and Tidy this folder),
//! and the shell shows the other mode and hands the file or folder over (`handOff`). The folders
//! each mode works on are gathered on the shell's state, for the others' empty states to offer.
//! On the owner's first start the welcome sets one folder up for them all.

use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::time::Duration;

use gpui_kit::component::WindowExt as _;
use gpui_kit::{
    AppContext as _, Bounds, Context, Entity, FocusHandle, Focusable, InteractiveElement as _,
    IntoElement, ParentElement as _, Pixels, Render, Styled as _, Subscription, Task, Window,
    WindowBounds, div, px,
};
use oriel_core_paths::DataRoot;
use oriel_mode_sync::{SyncEvent, SyncMode};
use oriel_mode_tidy::{NotYet, TidyEvent, TidyMode};
use oriel_mode_view::{ViewEvent, ViewMode};
use oriel_ui::commands::shell_key_context;
use oriel_ui::settings::SettingsFrame;
use oriel_ui::{
    HandOff, KnownFolder, LocalStorage, ModeId, SettingsSection, ShellState, Toast, ToastExt as _,
};

use crate::actions::{
    About, CloseSettings, CloseWindow, Minimize, OpenSettings, SETTINGS_CONTEXT, ShowSync,
    ShowTidy, ShowView, ToggleFullScreen, ToggleRail, Zoom,
};
use crate::general::GeneralSettings;
use crate::quit::{QuitGuard, QuitPlatform, SystemQuit};
use crate::welcome::{Welcome, WelcomeEvent, WelcomeModes};
use crate::window_state::WindowState;
use crate::{about, dock, menus, welcome, window_state};

/// Where the mode shown last is kept, Electron Oriel's `localStorage` key.
pub const MODE_KEY: &str = "oriel.mode";
/// Where the sidebar's form is kept: `rail` or `full`.
pub const SIDEBAR_KEY: &str = "oriel.sidebar";

/// How long the window's bounds must stay put before they are written, as Electron Oriel waits.
const SAVE_WINDOW_DELAY: Duration = Duration::from_millis(250);

/// What fills the window: a mode, or the Settings page over it.
#[derive(Clone, Copy, PartialEq)]
enum Drawn {
    Mode(ModeId),
    Settings,
}

/// What the shell last did for the state, so it acts only on what changed.
#[derive(Clone, Copy, PartialEq)]
struct Applied {
    mode: ModeId,
    rail: bool,
    /// The Dock's progress, in whole percent.
    progress: Option<u32>,
}

pub struct Shell {
    data: DataRoot,
    state: Entity<ShellState>,
    view: Entity<ViewMode>,
    tidy: Entity<TidyMode>,
    sync: Entity<SyncMode>,
    quit: Entity<QuitGuard>,
    focus_handle: FocusHandle,
    settings_focus: FocusHandle,
    /// Where each hidden mode's focus was when it was last on screen.
    mode_focus: [Option<FocusHandle>; 3],
    /// What the last frame drew: a mode, or Settings.
    drawn: Option<Drawn>,
    applied: Applied,
    /// The window's state as it is now, written a moment after it last changed and on close.
    window_state: Option<WindowState>,
    /// The bounds the window had when last neither maximised nor full screen, which a maximised
    /// window keeps for when it is restored.
    normal_bounds: Option<Bounds<Pixels>>,
    save_window: Option<Task<()>>,
    /// What the modes last said they work on: View's folder, Tidy's, Sync's. The known folders
    /// are gathered again only when this changes, or when another mode comes on screen.
    folder_sources: Option<[Vec<PathBuf>; 3]>,
    /// The first start's welcome while it shows, and whether its dialog is open yet.
    welcome: Option<(Entity<Welcome>, bool, Subscription)>,
    /// `ORIEL_RS_ABOUT=1` asked for the About dialog at start, which opens once the window draws.
    about_at_start: bool,
    _subscriptions: Vec<Subscription>,
}

impl Shell {
    /// The app's shell over `data`: the modes as the environment configures them (View opens
    /// `ORIEL_RS_OPEN`, the Phase 0 spikes run when asked), quitting for real.
    pub fn new(data: DataRoot, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let mut this = Self::build(data, Rc::new(SystemQuit), true, window, cx);
        crate::check::apply_from_environment(&this.state, cx);
        this.about_at_start = crate::check::about_from_environment();
        if welcome::allowed_from_environment() {
            this.offer_welcome(window, cx);
        }
        this
    }

    /// A shell over `data` alone, as tests open it: View opens nothing at start, and `quit`
    /// stands in for hiding and quitting the app.
    pub fn with_data(
        data: DataRoot,
        quit: Rc<dyn QuitPlatform>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        Self::build(data, quit, false, window, cx)
    }

    fn build(
        data: DataRoot,
        quit: Rc<dyn QuitPlatform>,
        from_environment: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let mode = LocalStorage::get(cx, MODE_KEY)
            .and_then(ModeId::from_key)
            .unwrap_or(ModeId::View);
        let rail = LocalStorage::get(cx, SIDEBAR_KEY) == Some("rail");
        let state = cx.new(|_| ShellState::new(mode, rail));
        let view = if from_environment {
            cx.new(|cx| ViewMode::new(&state, window, cx))
        } else {
            cx.new(|cx| ViewMode::with_data(&state, &data, window, cx))
        };
        let tidy = if from_environment {
            cx.new(|cx| TidyMode::new(&state, window, cx))
        } else {
            cx.new(|cx| TidyMode::with_data(&state, &data, Rc::new(NotYet), window, cx))
        };
        let sync = if from_environment {
            cx.new(|cx| SyncMode::new(&state, window, cx))
        } else {
            cx.new(|cx| SyncMode::with_data(&state, &data, window, cx))
        };
        let quit = QuitGuard::install(&state, quit, cx);
        let tidy_state = tidy.read(cx).state().clone();

        let subscriptions = vec![
            cx.observe_in(&state, window, |this, _, window, cx| {
                this.apply_state(window, cx);
            }),
            cx.observe_window_appearance(window, |_, window, cx| {
                oriel_ui::theme::follow_system_appearance(window, cx);
            }),
            cx.observe_window_bounds(window, |this, window, cx| {
                this.note_window_bounds(window, cx);
                this.save_window_soon(cx);
            }),
            // However the window comes back (the Dock icon, ⌘-Tab, a file opened with the app),
            // a quit waiting for work is called off.
            cx.observe_window_activation(window, |this, window, cx| {
                if window.is_window_active() {
                    this.quit.update(cx, |quit, cx| quit.cancel(cx));
                }
            }),
            cx.on_app_quit(|this, _| {
                this.write_window_state();
                async {}
            }),
            // What the modes ask of each other.
            cx.subscribe_in(
                &view,
                window,
                |this, _, event: &ViewEvent, window, cx| match event {
                    ViewEvent::ShowInTidy(file) => {
                        this.hand_off(ModeId::Tidy, HandOff::File(file.clone()), window, cx);
                    }
                },
            ),
            cx.subscribe_in(
                &tidy,
                window,
                |this, _, event: &TidyEvent, window, cx| match event {
                    TidyEvent::OpenInView(path) => {
                        this.hand_off(ModeId::View, HandOff::File(path.clone()), window, cx);
                    }
                    TidyEvent::SyncFolder(folder) => {
                        this.hand_off(ModeId::Sync, HandOff::Folder(folder.clone()), window, cx);
                    }
                },
            ),
            cx.subscribe_in(
                &sync,
                window,
                |this, _, event: &SyncEvent, window, cx| match event {
                    SyncEvent::OpenInView(folder) => {
                        this.hand_off(ModeId::View, HandOff::Folder(folder.clone()), window, cx);
                    }
                    SyncEvent::TidyFolder(folder) => {
                        this.hand_off(ModeId::Tidy, HandOff::Folder(folder.clone()), window, cx);
                    }
                },
            ),
            // The folders each mode works on, for the others to offer.
            cx.observe(&view, |this, _, cx| this.gather_folders(false, cx)),
            cx.observe(&tidy_state, |this, _, cx| this.gather_folders(false, cx)),
            cx.observe(&sync, |this, _, cx| this.gather_folders(false, cx)),
        ];
        let shell = cx.weak_entity();
        window.on_window_should_close(cx, move |window, cx| {
            shell
                .update(cx, |shell, cx| shell.allows_close(window, cx))
                .unwrap_or(true)
        });

        let applied = Applied {
            mode,
            rail,
            progress: None,
        };
        let mut this = Self {
            normal_bounds: WindowState::read(&data.shell()).map(|state| state.bounds()),
            data,
            state,
            view,
            tidy,
            sync,
            quit,
            focus_handle: cx.focus_handle(),
            settings_focus: cx.focus_handle(),
            mode_focus: Default::default(),
            drawn: None,
            applied,
            window_state: None,
            save_window: None,
            folder_sources: None,
            welcome: None,
            about_at_start: false,
            _subscriptions: subscriptions,
        };
        this.show_mode(mode, window, cx);
        this.gather_folders(true, cx);
        this
    }

    pub fn state(&self) -> &Entity<ShellState> {
        &self.state
    }

    pub fn view(&self) -> &Entity<ViewMode> {
        &self.view
    }

    pub fn tidy(&self) -> &Entity<TidyMode> {
        &self.tidy
    }

    pub fn sync(&self) -> &Entity<SyncMode> {
        &self.sync
    }

    pub fn quit(&self) -> &Entity<QuitGuard> {
        &self.quit
    }

    /// The window's title for `mode`: "View – Oriel RS", as Electron Oriel's "View – Oriel".
    pub fn title(mode: ModeId) -> String {
        format!("{} – {}", mode.label(), crate::APP_NAME)
    }

    /// Shows `path` in View, as Electron Oriel's `openInView` does for a path the system hands
    /// the app: a folder opens as it is, a file through its folder and then in the viewer. The
    /// window comes forward.
    pub fn open_in_view(&mut self, path: &Path, window: &mut Window, cx: &mut Context<Self>) {
        let path = path.to_path_buf();
        self.view
            .update(cx, |view, cx| view.open_path(path, window, cx));
        self.state
            .update(cx, |state, cx| state.go(ModeId::View, cx));
        self.show_window(window, cx);
    }

    /// Shows `target` in mode `to`, as Electron Oriel's `handOff` does: View opens a file in its
    /// viewer (once its folder is listed) or a folder; Tidy and Sync take it themselves. A path
    /// that is no longer there is not shown, and a toast says so.
    pub fn hand_off(
        &mut self,
        to: ModeId,
        target: HandOff,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        match to {
            ModeId::View => {
                let path = target.path().to_path_buf();
                if path.exists() {
                    self.open_in_view(&path, window, cx);
                } else {
                    window.show_toast(
                        Toast::error("View could not open it").detail(path.display().to_string()),
                        cx,
                    );
                }
            }
            ModeId::Tidy => {
                self.go(ModeId::Tidy, cx);
                self.tidy
                    .update(cx, |tidy, cx| tidy.show_hand_off(target, window, cx));
            }
            ModeId::Sync => {
                self.go(ModeId::Sync, cx);
                self.sync
                    .update(cx, |sync, cx| sync.show_hand_off(target, window, cx));
            }
        }
    }

    /// Shows the first start's welcome over the window, unless the owner has been through it
    /// (`WelcomeGate`). The app offers it at launch; tests ask for it.
    pub fn offer_welcome(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.welcome.is_some() || welcome::welcomed(&self.data) {
            return;
        }
        let modes = WelcomeModes {
            view: self.view.clone(),
            tidy: self.tidy.clone(),
            sync: self.sync.clone(),
        };
        let (state, data) = (self.state.clone(), self.data.clone());
        let entity = cx.new(|cx| Welcome::new(&state, data, modes, window, cx));
        let subscription = cx.subscribe_in(
            &entity,
            window,
            |this, _, event: &WelcomeEvent, window, cx| match event {
                WelcomeEvent::Finished => this.finish_welcome(window, cx),
            },
        );
        self.welcome = Some((entity, false, subscription));
        cx.notify();
    }

    /// The welcome on screen, while it shows.
    pub fn welcome(&self) -> Option<&Entity<Welcome>> {
        self.welcome.as_ref().map(|(welcome, _, _)| welcome)
    }

    /// The welcome is done: it shows no more, and View is on screen (`finish`).
    fn finish_welcome(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.welcome.take().is_none() {
            return;
        }
        welcome::mark_welcomed(&self.data);
        window.close_dialog(cx);
        self.go(ModeId::View, cx);
    }

    /// Opens the welcome's dialog once the window draws, since the window's root holds dialogs.
    fn open_welcome_dialog(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some((welcome, opened, _)) = &mut self.welcome else {
            return;
        };
        if *opened {
            return;
        }
        *opened = true;
        let welcome = welcome.clone();
        cx.defer_in(window, move |_, window, cx| {
            window.open_dialog(cx, move |dialog, _, _| {
                dialog
                    .w(px(520.))
                    .centered()
                    .close_button(false)
                    .overlay_closable(false)
                    .keyboard(false)
                    .child(welcome.clone())
            });
        });
    }

    /// Gathers the folders the modes work on onto the shell's state (`knownFolders`), when what
    /// the modes say changed, or always when `force`: a folder since moved or deleted is not
    /// offered, so another look at the disk is due when a mode comes on screen.
    fn gather_folders(&mut self, force: bool, cx: &mut Context<Self>) {
        let sources = [
            self.view.read(cx).opened_folder().into_iter().collect(),
            self.tidy
                .read(cx)
                .state()
                .read(cx)
                .roots()
                .iter()
                .map(|root| PathBuf::from(&root.path))
                .collect(),
            self.sync.read(cx).source_roots(),
        ];
        if !force && self.folder_sources.as_ref() == Some(&sources) {
            return;
        }
        // Symlinks resolved, so two spellings of one folder meet; one that is gone drops out.
        let resolved: Vec<Vec<PathBuf>> = sources
            .iter()
            .map(|folders| {
                folders
                    .iter()
                    .filter_map(|folder| std::fs::canonicalize(folder).ok())
                    .filter(|folder| folder.is_dir())
                    .collect()
            })
            .collect();
        let known = KnownFolder::collect(
            ModeId::ALL
                .into_iter()
                .zip(resolved.iter().map(Vec::as_slice)),
        );
        self.folder_sources = Some(sources);
        self.state
            .update(cx, |state, cx| state.set_known_folders(known, cx));
    }

    /// Brings the window forward, which also calls off a quit waiting for work to end.
    pub fn show_window(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.quit.update(cx, |quit, cx| quit.cancel(cx));
        cx.activate(true);
        window.activate_window();
    }

    /// Whether the window may close now; while work runs it hides instead, and the app quits
    /// once the work ends. The window's state is written either way.
    fn allows_close(&mut self, window: &mut Window, cx: &mut Context<Self>) -> bool {
        self.note_window_bounds(window, cx);
        self.write_window_state();
        self.quit.update(cx, |quit, cx| quit.allows_close(cx))
    }

    fn go(&mut self, mode: ModeId, cx: &mut Context<Self>) {
        self.state.update(cx, |state, cx| state.go(mode, cx));
    }

    /// Follows a change of the shell's state: the title and the menus, what is remembered, and
    /// the Dock.
    fn apply_state(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let state = self.state.read(cx);
        let now = Applied {
            mode: state.mode(),
            rail: state.rail(),
            progress: state.progress().map(|ratio| (ratio * 100.).round() as u32),
        };
        let ratio = state.progress();
        let before = self.applied;
        self.applied = now;

        if now.mode != before.mode {
            self.show_mode(now.mode, window, cx);
            LocalStorage::set(cx, MODE_KEY, now.mode.key());
            // Read again each time a mode comes on screen: a folder may have gone meanwhile.
            self.gather_folders(true, cx);
        }
        if now.rail != before.rail {
            LocalStorage::set(cx, SIDEBAR_KEY, if now.rail { "rail" } else { "full" });
        }
        if now.progress != before.progress {
            dock::show_progress(ratio);
        }
        cx.notify();
    }

    /// Keeps the keyboard with what is on screen as a mode or Settings comes and goes. Focus
    /// left on an element no longer drawn would reach nothing, not even the shell's keys. So the
    /// focus of what goes is kept for when it comes back, as a browser's tabs keep theirs, and
    /// what comes gets its own back: a mode the focus it had, or the shell's; Settings its page,
    /// where Escape goes back. A mode that takes focus itself as it comes on screen keeps it.
    ///
    /// The shell's render is where this is known: the window's rendered frame is still the last
    /// one, so whether the focused element was drawn in it tells focus left behind from focus
    /// the incoming mode took.
    fn hand_over_focus(
        &mut self,
        from: Drawn,
        to: Drawn,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let focused = window.focused(cx);
        let left_behind = match &focused {
            None => true,
            Some(focus) if *focus == self.focus_handle => true,
            Some(_) => self.focus_handle.contains_focused(window, cx),
        };
        if !left_behind {
            return;
        }
        if let (Drawn::Mode(mode), Some(focus)) = (from, focused) {
            self.mode_focus[mode.index()] = Some(focus).filter(|focus| *focus != self.focus_handle);
        }
        let target = match to {
            Drawn::Settings => Some(self.settings_focus.clone()),
            Drawn::Mode(mode) => self.mode_focus[mode.index()]
                .take()
                .or_else(|| self.own_focus(mode, cx)),
        }
        .unwrap_or_else(|| self.focus_handle.clone());
        // Not during render: the focus moves once this frame is done.
        cx.defer_in(window, move |_, window, cx| target.focus(window, cx));
    }

    /// The focus a mode takes when it comes on screen with none of its own kept: View's gallery
    /// (or its open viewer), Tidy's root, which hands it on to the page on screen, and Sync's
    /// page, so their keys (⌘L, Space) and menu commands (Open Folder…, Refresh) reach them at
    /// once, before a click.
    fn own_focus(&self, mode: ModeId, cx: &gpui_kit::App) -> Option<FocusHandle> {
        match mode {
            ModeId::View => Some(self.view.focus_handle(cx)),
            ModeId::Tidy => Some(self.tidy.focus_handle(cx)),
            ModeId::Sync => Some(self.sync.focus_handle(cx)),
        }
    }

    /// Where the keyboard starts as the window opens: in the mode on screen where it has a place
    /// of its own, else on the shell.
    pub fn initial_focus(&self, cx: &gpui_kit::App) -> FocusHandle {
        self.own_focus(self.state.read(cx).mode(), cx)
            .unwrap_or_else(|| self.focus_handle.clone())
    }

    /// The window's title and the menu bar for `mode`.
    fn show_mode(&mut self, mode: ModeId, window: &mut Window, cx: &mut Context<Self>) {
        window.set_window_title(&Self::title(mode));
        menus::set(mode, cx);
    }

    /// Notes the window's bounds as the file keeps them: GPUI reports them relative to the
    /// window's display, and the file keeps them across every display, as Electron does.
    fn note_window_bounds(&mut self, window: &mut Window, cx: &gpui_kit::App) {
        let origin = window
            .display(cx)
            .map(|display| window_state::display_origin(display.id()))
            .unwrap_or_default();
        let across_displays =
            |bounds: Bounds<Pixels>| Bounds::new(bounds.origin + origin, bounds.size);
        let maximized = window.is_maximized();
        let state = match window.window_bounds() {
            WindowBounds::Windowed(bounds) if !maximized => {
                let bounds = across_displays(bounds);
                self.normal_bounds = Some(bounds);
                WindowState::new(bounds, false)
            }
            // macOS reports a zoomed window as windowed at its zoomed size, so the size it
            // returns to is the one noted before.
            WindowBounds::Windowed(bounds) | WindowBounds::Maximized(bounds) => {
                WindowState::new(self.normal_bounds.unwrap_or(across_displays(bounds)), true)
            }
            // Electron Oriel does not keep full screen either; the window comes back at the
            // size it left full screen from.
            WindowBounds::Fullscreen(bounds) => WindowState::new(across_displays(bounds), false),
        };
        self.window_state = Some(state);
    }

    fn save_window_soon(&mut self, cx: &mut Context<Self>) {
        self.save_window = Some(cx.spawn(async move |this, cx| {
            cx.background_executor().timer(SAVE_WINDOW_DELAY).await;
            this.update(cx, |this, _| this.write_window_state()).ok();
        }));
    }

    fn write_window_state(&mut self) {
        self.save_window = None;
        if let Some(state) = &self.window_state {
            state.write(&self.data.shell());
        }
    }

    fn render_settings(
        &mut self,
        section: SettingsSection,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> impl IntoElement + use<> {
        let content = match section {
            SettingsSection::General => {
                GeneralSettings::new(self.data.root().to_path_buf()).into_any_element()
            }
            SettingsSection::Mode(ModeId::View) => self
                .view
                .update(cx, |view, cx| view.settings_section(window, cx)),
            SettingsSection::Mode(ModeId::Tidy) => self
                .tidy
                .update(cx, |tidy, cx| tidy.settings_section(window, cx)),
            SettingsSection::Mode(ModeId::Sync) => self
                .sync
                .update(cx, |sync, cx| sync.settings_section(window, cx)),
        };
        div()
            .id("settings")
            .key_context(SETTINGS_CONTEXT)
            .track_focus(&self.settings_focus)
            .size_full()
            .on_action(cx.listener(|this, _: &CloseSettings, _, cx| {
                this.state.update(cx, |state, cx| state.close_settings(cx));
            }))
            .child(SettingsFrame::new(&self.state, content))
    }
}

impl Focusable for Shell {
    fn focus_handle(&self, _: &gpui_kit::App) -> FocusHandle {
        self.focus_handle.clone()
    }
}

impl Render for Shell {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let state = self.state.read(cx);
        let mode = state.mode();
        let settings = state.settings();
        let drawn = if settings.is_some() {
            Drawn::Settings
        } else {
            Drawn::Mode(mode)
        };
        if let Some(before) = self.drawn.replace(drawn)
            && before != drawn
        {
            self.hand_over_focus(before, drawn, window, cx);
        }
        self.open_welcome_dialog(window, cx);
        if std::mem::take(&mut self.about_at_start) {
            cx.defer_in(window, |_, window, cx| {
                about::show(about::LicenceIndex::of_running_app(), window, cx);
            });
        }
        let content = match settings {
            Some(section) => self.render_settings(section, window, cx).into_any_element(),
            None => match mode {
                ModeId::View => self.view.clone().into_any_element(),
                ModeId::Tidy => self.tidy.clone().into_any_element(),
                ModeId::Sync => self.sync.clone().into_any_element(),
            },
        };

        div()
            .id("shell")
            .key_context(shell_key_context(mode))
            .track_focus(&self.focus_handle)
            .size_full()
            .on_action(cx.listener(|this, _: &ShowView, _, cx| this.go(ModeId::View, cx)))
            .on_action(cx.listener(|this, _: &ShowTidy, _, cx| this.go(ModeId::Tidy, cx)))
            .on_action(cx.listener(|this, _: &ShowSync, _, cx| this.go(ModeId::Sync, cx)))
            .on_action(cx.listener(|this, _: &ToggleRail, _, cx| {
                this.state.update(cx, |state, cx| state.toggle_rail(cx));
            }))
            .on_action(cx.listener(|this, _: &OpenSettings, _, cx| {
                this.state.update(cx, |state, cx| {
                    let mode = state.mode();
                    state.open_settings(SettingsSection::Mode(mode), cx);
                });
            }))
            .on_action(|_: &ToggleFullScreen, window, _| window.toggle_fullscreen())
            .on_action(|_: &Minimize, window, _| window.minimize_window())
            .on_action(|_: &Zoom, window, _| window.zoom_window())
            .on_action(|_: &About, window, cx| {
                about::show(about::LicenceIndex::of_running_app(), window, cx);
            })
            .on_action(cx.listener(|this, _: &CloseWindow, window, cx| {
                if this.allows_close(window, cx) {
                    window.remove_window();
                }
            }))
            .child(content)
    }
}
