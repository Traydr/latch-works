//! The window's root: the shell's state, the modes, and the one Settings page. Only the mode on
//! screen is drawn; the others keep their state in their entities.
//!
//! The shell does for every mode alike, through [`Mode`]: the window's title and the menu bar
//! follow the mode; the mode, the sidebar's form and the window's bounds are remembered; the Dock
//! shows running work; closing the window waits for it; and paths the system hands the app open in
//! View. It passes on what one mode hands another ([`HandOffRequest`]), and gathers the folders
//! each mode works on onto the shell's state, for the others' empty states to offer. On the
//! owner's first start the welcome sets one folder up for them all.

use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::time::Duration;

use gpui_kit::component::{ActiveTheme as _, WindowExt as _};
use gpui_kit::{
    App, AppContext as _, Bounds, Context, Entity, FocusHandle, Focusable, InteractiveElement as _,
    IntoElement, KeyDownEvent, ParentElement as _, Pixels, Render, Styled as _, Subscription, Task,
    Window, div, px,
};
use oriel_core_paths::DataRoot;
use oriel_launch::{Launch, storage_keys};
use oriel_mode_sync::SyncMode;
use oriel_mode_tidy::TidyMode;
use oriel_mode_view::ViewMode;
use oriel_ui::settings::SettingsFrame;
use oriel_ui::shortcuts::{Line, ShowShortcuts};
use oriel_ui::{
    AnyMode, Foot, HandOff, HandOffRequest, KnownFolder, LocalStorage, Mode, ModeId, ModeMap,
    SettingsSection, ShellState, shell_key_context,
};

use crate::actions::{
    About, CloseSettings, CloseWindow, Minimize, OpenSettings, SETTINGS_CONTEXT, ShellCommand,
    ShowMode, ToggleFullScreen, ToggleRail, Zoom,
};
use crate::check::ShellChecks;
use crate::general::GeneralSettings;
use crate::quit::{QuitGuard, QuitPlatform};
use crate::welcome::{Welcome, WelcomeEvent};
use crate::window_state::WindowState;
use crate::{about, dock, menus, welcome, window_state};

/// The stored sidebar's form: `rail` or `full`.
const SIDEBAR_KEY: &str = "oriel.sidebar";

/// How long the window's bounds must stay put before they are written.
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
    modes: ModeMap<AnyMode>,
    quit: Entity<QuitGuard>,
    focus_handle: FocusHandle,
    settings_focus: FocusHandle,
    /// Where each hidden mode's focus was when it was last on screen.
    mode_focus: ModeMap<Option<FocusHandle>>,
    /// What the last frame drew: a mode, or Settings.
    drawn: Option<Drawn>,
    applied: Applied,
    /// The window's state as it is now, written a moment after it last changed and on close.
    window_state: Option<WindowState>,
    /// The bounds the window had when last neither maximised nor full screen, which a maximised
    /// window keeps for when it is restored.
    normal_bounds: Option<Bounds<Pixels>>,
    save_window: Option<Task<()>>,
    /// What the modes last said they work on. The known folders are gathered again only when this
    /// changes, or when another mode comes on screen.
    folder_sources: Option<ModeMap<Vec<PathBuf>>>,
    /// The first start's welcome while it shows, and whether its dialog is open yet.
    welcome: Option<(Entity<Welcome>, bool, Subscription)>,
    /// The launch's check opens the activity panel whenever work runs.
    open_activity_on_work: bool,
    pub(crate) spike: Option<crate::spike::ShellSpike>,
    _subscriptions: Vec<Subscription>,
}

impl Shell {
    /// The shell as `launch` sets it up, its modes made here and nowhere else; `quit` hides and
    /// quits the app.
    pub fn new(
        launch: &Launch,
        quit: Rc<dyn QuitPlatform>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let data = launch.data.clone();
        let mode = Self::starting_mode(launch, cx);
        let rail = LocalStorage::get(cx, SIDEBAR_KEY) == Some("rail");
        let state = cx.new(|cx| ShellState::new(mode, rail, cx));
        let modes = ModeMap::from_fn(|mode| -> AnyMode {
            match mode {
                ModeId::View => cx
                    .new(|cx| ViewMode::new(&state, launch, window, cx))
                    .into(),
                ModeId::Tidy => cx
                    .new(|cx| TidyMode::new(&state, launch, window, cx))
                    .into(),
                ModeId::Sync => cx
                    .new(|cx| SyncMode::new(&state, launch, window, cx))
                    .into(),
            }
        });
        let checks = ShellChecks::from_variables(&launch.variables);
        crate::actions::bind_mode_keys(&modes, cx);
        let quit = QuitGuard::install(&state, quit, cx);
        let jobs = state.read(cx).jobs().clone();

        let shell = cx.weak_entity();
        let mut subscriptions = vec![
            cx.observe_in(&state, window, |this, _, window, cx| {
                this.apply_state(window, cx);
            }),
            cx.subscribe_in(
                &state,
                window,
                |this, _, request: &HandOffRequest, window, cx| {
                    this.modes[request.to].show_hand_off(request.target.clone(), window, cx);
                },
            ),
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
                // A child outlives its parent, so a long encode would run on after a forced quit.
                oriel_tools::kill_running_tools();
                async {}
            }),
            // What every mode is doing, drawn once at the window's bottom right.
            cx.observe(&jobs, |this, jobs, cx| {
                if this.open_activity_on_work && !jobs.read(cx).is_idle() {
                    jobs.update(cx, |jobs, cx| jobs.set_open(true, cx));
                }
                cx.notify();
            }),
        ];
        // The folders each mode works on, for the others to offer.
        subscriptions.extend(modes.values().map(|mode| {
            let shell = shell.clone();
            mode.observe(
                move |cx| {
                    shell
                        .update(cx, |this, cx| this.gather_folders(false, cx))
                        .ok();
                },
                cx,
            )
        }));
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
            normal_bounds: WindowState::read(&data.window_state()).map(|state| state.bounds()),
            data,
            state,
            modes,
            quit,
            focus_handle: cx.focus_handle(),
            settings_focus: cx.focus_handle(),
            mode_focus: ModeMap::default(),
            drawn: None,
            applied,
            window_state: None,
            save_window: None,
            folder_sources: None,
            welcome: None,
            open_activity_on_work: checks.activity_panel,
            spike: crate::spike::ShellSpike::open(&launch.variables),
            _subscriptions: subscriptions,
        };
        this.show_mode(mode, window, cx);
        this.gather_folders(true, cx);
        crate::check::apply(&checks, &this.state, cx);
        crate::check::play_script(&checks, &this.state, window, cx);
        if this.spike.is_some() {
            crate::spike::start(&launch.variables, window, cx);
        }
        if welcome::allowed(&this.data, checks.welcome) {
            this.offer_welcome(window, cx);
        }
        this
    }

    pub fn state(&self) -> &Entity<ShellState> {
        &self.state
    }

    /// The mode `M`.
    pub fn mode<M: Mode>(&self) -> &Entity<M> {
        self.modes[M::ID]
            .downcast()
            .expect("each mode is the type its id names")
    }

    pub fn quit(&self) -> &Entity<QuitGuard> {
        &self.quit
    }

    /// The mode the window opens in: View for a launch that opens a path, else the mode last
    /// shown.
    pub fn starting_mode(launch: &Launch, cx: &App) -> ModeId {
        if launch.open.is_some() {
            return ModeId::View;
        }
        LocalStorage::get(cx, storage_keys::MODE)
            .and_then(ModeId::from_key)
            .unwrap_or(ModeId::View)
    }

    /// The window's title for `mode`: "View – Oriel".
    pub fn title(mode: ModeId) -> String {
        format!("{} – {}", mode.label(), oriel_core_paths::APP_NAME)
    }

    /// Shows `path`, which the system hands the app, in View: a folder opens as it is, a file
    /// through its folder and then in the viewer. The window comes forward.
    pub fn open_in_view(&mut self, path: &Path, window: &mut Window, cx: &mut Context<Self>) {
        let path = path.to_path_buf();
        let target = if path.is_dir() {
            HandOff::Folder(path)
        } else {
            HandOff::File(path)
        };
        self.modes[ModeId::View].show_hand_off(target, window, cx);
        self.show_window(window, cx);
    }

    /// Shows the first start's welcome over the window, unless the owner has been through it.
    /// The app offers it at launch; tests ask for it.
    pub fn offer_welcome(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.welcome.is_some() || welcome::welcomed(&self.data) {
            return;
        }
        let (state, data, modes) = (self.state.clone(), self.data.clone(), self.modes.clone());
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

    /// The welcome is done: it shows no more, and View is on screen.
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
            window.open_dialog(cx, move |dialog, _, cx| {
                dialog
                    .w(px(680.))
                    .centered()
                    .bg(cx.theme().popover)
                    .close_button(false)
                    .overlay_closable(false)
                    .keyboard(false)
                    .child(welcome.clone())
            });
        });
    }

    /// Gathers the folders the modes work on onto the shell's state, when what the modes say
    /// changed, or always when `force`: a folder since moved or deleted is not offered, so another
    /// look at the disk is due when a mode comes on screen.
    fn gather_folders(&mut self, force: bool, cx: &mut Context<Self>) {
        let sources = ModeMap::from_fn(|mode| self.modes[mode].folders(cx));
        if !force && self.folder_sources.as_ref() == Some(&sources) {
            return;
        }
        // Symlinks resolved, so two spellings of one folder meet; one that is gone drops out.
        let resolved = ModeMap::from_fn(|mode| -> Vec<PathBuf> {
            sources[mode]
                .iter()
                .filter_map(|folder| oriel_runtime::paths::canonicalize(folder).ok())
                .filter(|folder| folder.is_dir())
                .collect()
        });
        let known = KnownFolder::collect(
            resolved
                .iter()
                .map(|(mode, folders)| (mode, folders.as_slice())),
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
            rail: state.rail_choice(),
            progress: state.progress().map(|ratio| (ratio * 100.).round() as u32),
        };
        let ratio = state.progress();
        let before = self.applied;
        self.applied = now;

        if now.mode != before.mode {
            self.show_mode(now.mode, window, cx);
            LocalStorage::set(cx, storage_keys::MODE, now.mode.key());
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
            self.mode_focus[mode] = Some(focus).filter(|focus| *focus != self.focus_handle);
        }
        let target = match to {
            Drawn::Settings => Some(self.settings_focus.clone()),
            Drawn::Mode(mode) => self.mode_focus[mode]
                .take()
                .or_else(|| Some(self.modes[mode].focus_handle(cx))),
        }
        .unwrap_or_else(|| self.focus_handle.clone());
        // Not during render: the focus moves once this frame is done.
        cx.defer_in(window, move |_, window, cx| target.focus(window, cx));
    }

    /// Where the keyboard starts as the window opens: in the mode on screen.
    pub fn initial_focus(&self, cx: &gpui_kit::App) -> FocusHandle {
        self.modes[self.state.read(cx).mode()].focus_handle(cx)
    }

    /// The window's title and the menu bar for `mode`.
    fn show_mode(&mut self, mode: ModeId, window: &mut Window, cx: &mut Context<Self>) {
        window.set_window_title(&Self::title(mode));
        menus::set(mode, &self.modes[mode].commands(), cx);
    }

    /// Notes the window's bounds as the file keeps them: GPUI reports them relative to the
    /// window's display, and the file keeps them across every display, as Electron Oriel wrote
    /// them.
    fn note_window_bounds(&mut self, window: &mut Window, cx: &gpui_kit::App) {
        let origin = window
            .display(cx)
            .map(|display| window_state::display_origin(display.id()))
            .unwrap_or_default();
        let maximized = window.is_maximized();
        let state = WindowState::noting(
            window.window_bounds(),
            maximized,
            &mut self.normal_bounds,
            origin,
        );
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
            state.write(&self.data.window_state());
        }
    }

    /// Opens the shortcut sheet of the mode on screen: the keys every mode shares and its
    /// commands', then its own.
    fn show_shortcuts(&self, window: &mut Window, cx: &mut Context<Self>) {
        let mode = &self.modes[self.state.read(cx).mode()];
        let sheet = mode.sheet();
        let switch = ModeId::ALL.map(ModeId::keys).join(" ");
        let mut lines = vec![Line::new("View, Tidy, Sync", &switch)];
        lines.extend(
            mode.commands()
                .into_iter()
                .filter_map(|command| Some(Line::new(command.sheet?, command.keys?))),
        );
        lines.extend(sheet.everywhere.iter().map(Line::from_shortcut));
        lines.extend(
            crate::actions::shell_commands(cfg!(target_os = "macos"))
                .iter()
                .filter_map(ShellCommand::sheet_line),
        );
        lines.push(Line::new("Shortcuts", "?"));
        oriel_ui::shortcuts::open_sheet(lines, &sheet, window, cx);
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
            SettingsSection::Mode(mode) => self.modes[mode].settings_section(window, cx),
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
        if let Some(spike) = &mut self.spike {
            let screen = match settings {
                Some(section) => crate::spike::Screen::Settings(section),
                None => crate::spike::Screen::Mode(mode),
            };
            spike.on_render(screen, window);
        }
        self.open_welcome_dialog(window, cx);
        let width = f32::from(window.viewport_size().width);
        self.state
            .update(cx, |state, cx| state.set_window_width(width, cx));
        // What the page keeps at the window's foot, which the activity panel and toasts stand on.
        let foot = match settings {
            Some(_) => Foot::default(),
            None => self.modes[mode].foot(cx),
        };
        let jobs = self.state.read(cx).jobs().clone();
        let content = match settings {
            Some(section) => self.render_settings(section, window, cx).into_any_element(),
            None => self.modes[mode].view().into_any_element(),
        };
        let shell = div()
            .id("shell")
            .key_context(shell_key_context(mode))
            .track_focus(&self.focus_handle)
            .relative()
            .size_full()
            // ? opens the sheet from anywhere but a text field, whichever part of a mode has focus.
            .on_key_down(cx.listener(|this, event: &KeyDownEvent, window, cx| {
                if event.keystroke.key_char.as_deref() == Some("?") && !window.has_focused_input(cx)
                {
                    this.show_shortcuts(window, cx);
                    cx.stop_propagation();
                }
            }))
            .on_action(cx.listener(|this, _: &ShowShortcuts, window, cx| {
                this.show_shortcuts(window, cx);
            }))
            .on_action(cx.listener(|this, ShowMode(mode): &ShowMode, _, cx| this.go(*mode, cx)))
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
            .on_action(cx.listener(|this, _: &About, window, cx| {
                let licences = about::LicenceIndex::of_running_app();
                about::show(this.data.root(), licences, window, cx);
            }))
            .on_action(cx.listener(|this, _: &CloseWindow, window, cx| {
                if this.allows_close(window, cx) {
                    window.remove_window();
                }
            }))
            .child(content);
        oriel_ui::stand_on_foot(shell, foot, &jobs, window, cx)
    }
}
