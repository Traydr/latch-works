//! Sync: profiles in the sidebar, the plan tree as the page, and push with the run panel
//! floating. Phase 4 of plan 063.

use gpui_kit::component::ActiveTheme as _;
use gpui_kit::{
    Context, Entity, IntoElement, ParentElement as _, Render, Styled as _, Subscription, Window,
    div,
};
use oriel_ui::{ModeLayout, ShellState, TopBar};

pub struct SyncMode {
    shell: Entity<ShellState>,
    _subscriptions: Vec<Subscription>,
}

impl SyncMode {
    pub fn new(shell: &Entity<ShellState>, _: &mut Window, cx: &mut Context<Self>) -> Self {
        Self {
            shell: shell.clone(),
            _subscriptions: vec![cx.observe(shell, |_, _, cx| cx.notify())],
        }
    }
}

impl Render for SyncMode {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        ModeLayout::new(&self.shell)
            .child(TopBar::new(&self.shell, "Sync"))
            .child(
                div()
                    .flex_1()
                    .min_h_0()
                    .p_4()
                    .text_color(cx.theme().muted_foreground)
                    .child("Sync comes in Phase 4."),
            )
    }
}
