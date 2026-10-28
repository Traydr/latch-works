//! The 52 px bar at the top of a mode's content: the sidebar's compact toggle first, then the
//! page's title, then the page's own controls.

use gpui_kit::component::{
    ActiveTheme as _, Icon, Sizable as _,
    button::{Button, ButtonVariants as _},
};
use gpui_kit::{
    AnyElement, App, Entity, FontWeight, InteractiveElement as _, IntoElement, MouseButton,
    ParentElement, RenderOnce, SharedString, Styled, Window, div, px,
};

use crate::drag::DragStrip;
use crate::shell::ShellState;

pub const TOP_BAR_HEIGHT: f32 = 52.;

#[derive(IntoElement)]
pub struct TopBar {
    shell: Entity<ShellState>,
    title: SharedString,
    trailing: Vec<AnyElement>,
}

impl TopBar {
    pub fn new(shell: &Entity<ShellState>, title: impl Into<SharedString>) -> Self {
        Self {
            shell: shell.clone(),
            title: title.into(),
            trailing: Vec::new(),
        }
    }

    /// A control at the bar's end, such as a page's toolbar.
    pub fn trailing(mut self, element: impl IntoElement) -> Self {
        self.trailing.push(element.into_any_element());
        self
    }
}

impl RenderOnce for TopBar {
    fn render(self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        let shell = self.shell.clone();
        let rail = self.shell.read(cx).rail();

        DragStrip::new("top-bar")
            .flex()
            .flex_row()
            .items_center()
            .flex_shrink_0()
            .h(px(TOP_BAR_HEIGHT))
            .px_3()
            .gap_2()
            .border_b_1()
            .border_color(cx.theme().border)
            .child(
                Button::new("toggle-sidebar")
                    .ghost()
                    .small()
                    .icon(Icon::new(gpui_kit::assets::IconName::PanelLeft))
                    .tooltip(if rail {
                        "Show sidebar  ⌘\\"
                    } else {
                        "Hide sidebar  ⌘\\"
                    })
                    .on_click(move |_, _, cx| shell.update(cx, |shell, cx| shell.toggle_rail(cx))),
            )
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .truncate()
                    .text_size(px(15.))
                    .font_weight(FontWeight::SEMIBOLD)
                    .child(self.title),
            )
            .child(
                div()
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap_2()
                    // The page's controls are pressable, so a press on them must not move the
                    // window.
                    .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                    .children(self.trailing),
            )
    }
}
