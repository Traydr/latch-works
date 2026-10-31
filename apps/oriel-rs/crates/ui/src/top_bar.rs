//! The 52 px bar at the top of a mode's content: the sidebar's compact toggle first, then the
//! page's title, then the page's own controls. VoiceOver reads it as the page's toolbar, named
//! after the page, with the title as its heading.

use gpui_kit::component::{
    ActiveTheme as _, Icon, Sizable as _,
    button::{Button, ButtonVariants as _},
};
use gpui_kit::{
    AnyElement, App, Entity, FontWeight, InteractiveElement as _, IntoElement, MouseButton,
    ParentElement, RenderOnce, Role, SharedString, StatefulInteractiveElement as _, Styled,
    TestSupportExt as _, Window, div, prelude::FluentBuilder as _, px,
};

use crate::drag::DragStrip;
use crate::shell::ShellState;

pub const TOP_BAR_HEIGHT: f32 = 52.;

#[derive(IntoElement)]
pub struct TopBar {
    shell: Entity<ShellState>,
    title: SharedString,
    meta: Option<SharedString>,
    trailing: Vec<AnyElement>,
}

impl TopBar {
    pub fn new(shell: &Entity<ShellState>, title: impl Into<SharedString>) -> Self {
        Self {
            shell: shell.clone(),
            title: title.into(),
            meta: None,
            trailing: Vec::new(),
        }
    }

    /// A quieter line beside the title, such as where a folder is (`TopBar`'s `meta`); cut from
    /// the start when long, so its end stays.
    pub fn meta(mut self, meta: impl Into<SharedString>) -> Self {
        self.meta = Some(meta.into());
        self
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
        // `SidebarToggle`'s words and icons: the sidebar compacts to the rail and expands back.
        let (toggle_label, toggle_tooltip, toggle_icon) = if rail {
            (
                "Expand sidebar",
                "Expand sidebar  ⌘\\",
                gpui_kit::assets::IconName::PanelLeftOpen,
            )
        } else {
            (
                "Compact sidebar",
                "Compact sidebar  ⌘\\",
                gpui_kit::assets::IconName::PanelLeftClose,
            )
        };

        DragStrip::new("top-bar")
            .accessible(Role::Toolbar, self.title.clone())
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
                    .icon(Icon::new(toggle_icon))
                    .accessibility_label(toggle_label)
                    .tooltip(toggle_tooltip)
                    .on_click(move |_, _, cx| shell.update(cx, |shell, cx| shell.toggle_rail(cx))),
            )
            .child(
                div()
                    .flex()
                    .flex_row()
                    .items_baseline()
                    .gap(px(10.))
                    .flex_1()
                    .min_w_0()
                    .child(
                        div()
                            .id("top-bar-title")
                            .test_support()
                            .role(Role::Heading)
                            .aria_level(1)
                            .aria_label(self.title.clone())
                            .flex_shrink_0()
                            .max_w_full()
                            .truncate()
                            .text_size(px(15.))
                            .font_weight(FontWeight::SEMIBOLD)
                            .child(self.title),
                    )
                    .when_some(self.meta, |this, meta| {
                        this.child(
                            div()
                                .id("top-bar-meta")
                                .role(Role::Label)
                                .test_support()
                                .aria_label(meta.clone())
                                .min_w_0()
                                .overflow_hidden()
                                .whitespace_nowrap()
                                .text_ellipsis_start()
                                .text_size(px(13.))
                                .text_color(cx.theme().muted_foreground)
                                .child(meta),
                        )
                    }),
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
