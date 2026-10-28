//! The window's root: the shell's state and the three modes. Only the mode on screen is drawn;
//! the others keep their state in their entities.

use gpui_kit::{
    AppContext as _, Context, Entity, FocusHandle, Focusable, InteractiveElement as _, IntoElement,
    ParentElement as _, Render, Styled as _, Subscription, Window, div,
};
use oriel_mode_sync::SyncMode;
use oriel_mode_tidy::TidyMode;
use oriel_mode_view::ViewMode;
use oriel_ui::{ModeId, ShellState};

use crate::actions::{CloseWindow, Minimize, ShowSync, ShowTidy, ShowView, ToggleRail, Zoom};

pub struct Shell {
    state: Entity<ShellState>,
    view: Entity<ViewMode>,
    tidy: Entity<TidyMode>,
    sync: Entity<SyncMode>,
    focus_handle: FocusHandle,
    _subscriptions: Vec<Subscription>,
}

impl Shell {
    pub fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
        let state = cx.new(|_| ShellState::new(ModeId::View, false));
        let view = cx.new(|cx| ViewMode::new(&state, window, cx));
        let tidy = cx.new(|cx| TidyMode::new(&state, window, cx));
        let sync = cx.new(|cx| SyncMode::new(&state, window, cx));

        let subscriptions = vec![
            cx.observe(&state, |_, _, cx| cx.notify()),
            cx.observe_window_appearance(window, |_, window, cx| {
                gpui_kit::component::Theme::sync_system_appearance(Some(window), cx);
            }),
        ];

        Self {
            state,
            view,
            tidy,
            sync,
            focus_handle: cx.focus_handle(),
            _subscriptions: subscriptions,
        }
    }

    pub fn state(&self) -> &Entity<ShellState> {
        &self.state
    }

    pub fn tidy(&self) -> &Entity<TidyMode> {
        &self.tidy
    }

    fn go(&mut self, mode: ModeId, cx: &mut Context<Self>) {
        self.state.update(cx, |state, cx| state.go(mode, cx));
    }
}

impl Focusable for Shell {
    fn focus_handle(&self, _: &gpui_kit::App) -> FocusHandle {
        self.focus_handle.clone()
    }
}

impl Render for Shell {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let mode = self.state.read(cx).mode();

        div()
            .id("shell")
            .key_context("Shell")
            .track_focus(&self.focus_handle)
            .size_full()
            .on_action(cx.listener(|this, _: &ShowView, _, cx| this.go(ModeId::View, cx)))
            .on_action(cx.listener(|this, _: &ShowTidy, _, cx| this.go(ModeId::Tidy, cx)))
            .on_action(cx.listener(|this, _: &ShowSync, _, cx| this.go(ModeId::Sync, cx)))
            .on_action(cx.listener(|this, _: &ToggleRail, _, cx| {
                this.state.update(cx, |state, cx| state.toggle_rail(cx));
            }))
            .on_action(|_: &Minimize, window, _| window.minimize_window())
            .on_action(|_: &Zoom, window, _| window.zoom_window())
            .on_action(|_: &CloseWindow, window, _| window.remove_window())
            .child(match mode {
                ModeId::View => self.view.clone().into_any_element(),
                ModeId::Tidy => self.tidy.clone().into_any_element(),
                ModeId::Sync => self.sync.clone().into_any_element(),
            })
    }
}
