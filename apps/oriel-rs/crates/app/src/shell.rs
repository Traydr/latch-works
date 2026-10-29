//! The window's root: the shell's state, the three modes, and the one Settings page. Only the
//! mode on screen is drawn; the others keep their state in their entities.
//!
//! The shell does for every mode what Electron Oriel's main process and `ShellProvider` do: the
//! window's title and the menu bar follow the mode; the mode, the sidebar's form and the window's
//! bounds are remembered; the Dock shows running work; closing the window waits for it; and paths
//! the system hands the app open in View.

use std::path::Path;
use std::rc::Rc;
use std::time::Duration;

use gpui_kit::component::WindowExt as _;
use gpui_kit::{
    AppContext as _, Bounds, Context, Entity, FocusHandle, Focusable, InteractiveElement as _,
    IntoElement, ParentElement as _, Pixels, Render, Styled as _, Subscription, Task, Window,
    WindowBounds, div,
};
use oriel_core_paths::DataRoot;
use oriel_mode_sync::SyncMode;
use oriel_mode_tidy::TidyMode;
use oriel_mode_view::ViewMode;
use oriel_ui::commands::shell_key_context;
use oriel_ui::settings::SettingsFrame;
use oriel_ui::{LocalStorage, ModeId, SettingsSection, ShellState};

use crate::actions::{
    About, CloseSettings, CloseWindow, Minimize, OpenSettings, SETTINGS_CONTEXT, ShowSync,
    ShowTidy, ShowView, ToggleFullScreen, ToggleRail, Zoom,
};
use crate::general::GeneralSettings;
use crate::quit::{QuitGuard, QuitPlatform, SystemQuit};
use crate::window_state::WindowState;
use crate::{dock, menus};

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
    _subscriptions: Vec<Subscription>,
}

impl Shell {
    /// The app's shell over `data`: the modes as the environment configures them (View opens
    /// `ORIEL_RS_OPEN`, the Phase 0 spikes run when asked), quitting for real.
    pub fn new(data: DataRoot, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let this = Self::build(data, Rc::new(SystemQuit), true, window, cx);
        crate::check::apply_from_environment(&this.state, cx);
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
        let tidy = cx.new(|cx| TidyMode::new(&state, window, cx));
        let sync = cx.new(|cx| SyncMode::new(&state, window, cx));
        let quit = QuitGuard::install(&state, quit, cx);

        let subscriptions = vec![
            cx.observe_in(&state, window, |this, _, window, cx| {
                this.apply_state(window, cx);
            }),
            cx.observe_window_appearance(window, |_, window, cx| {
                oriel_ui::theme::follow_system_appearance(window, cx);
            }),
            cx.observe_window_bounds(window, |this, window, cx| {
                this.note_window_bounds(window);
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
            _subscriptions: subscriptions,
        };
        this.show_mode(mode, window, cx);
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

    /// Brings the window forward, which also calls off a quit waiting for work to end.
    pub fn show_window(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.quit.update(cx, |quit, cx| quit.cancel(cx));
        cx.activate(true);
        window.activate_window();
    }

    /// Whether the window may close now; while work runs it hides instead, and the app quits
    /// once the work ends. The window's state is written either way.
    fn allows_close(&mut self, window: &mut Window, cx: &mut Context<Self>) -> bool {
        self.note_window_bounds(window);
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
            Drawn::Mode(mode) => self.mode_focus[mode.index()].take(),
        }
        .unwrap_or_else(|| self.focus_handle.clone());
        // Not during render: the focus moves once this frame is done.
        cx.defer_in(window, move |_, window, cx| target.focus(window, cx));
    }

    /// The window's title and the menu bar for `mode`.
    fn show_mode(&mut self, mode: ModeId, window: &mut Window, cx: &mut Context<Self>) {
        window.set_window_title(&Self::title(mode));
        menus::set(mode, cx);
    }

    fn note_window_bounds(&mut self, window: &mut Window) {
        let maximized = window.is_maximized();
        let state = match window.window_bounds() {
            WindowBounds::Windowed(bounds) if !maximized => {
                self.normal_bounds = Some(bounds);
                WindowState::new(bounds, false)
            }
            // macOS reports a zoomed window as windowed at its zoomed size, so the size it
            // returns to is the one noted before.
            WindowBounds::Windowed(bounds) | WindowBounds::Maximized(bounds) => {
                WindowState::new(self.normal_bounds.unwrap_or(bounds), true)
            }
            bounds @ WindowBounds::Fullscreen(_) => WindowState::from_window_bounds(bounds),
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

    fn show_about(window: &mut Window, cx: &mut gpui_kit::App) {
        window.open_alert_dialog(cx, |alert, _, _| {
            alert.title(crate::APP_NAME).description(format!(
                "Version {}. Oriel's View, Tidy and Sync on GPUI, an experiment beside Electron \
                 Oriel. It keeps its own data in ~/.latch-works/oriel-rs.",
                env!("CARGO_PKG_VERSION")
            ))
        });
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
            .on_action(|_: &About, window, cx| Self::show_about(window, cx))
            .on_action(cx.listener(|this, _: &CloseWindow, window, cx| {
                if this.allows_close(window, cx) {
                    window.remove_window();
                }
            }))
            .child(content)
    }
}
