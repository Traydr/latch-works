//! The 60 px bar at the top of a mode's content: the sidebar's compact toggle first, then the
//! page's title, then the page's own controls. VoiceOver reads it as the page's toolbar, named
//! after the page, with the title as its heading.

use gpui_kit::component::{
    ActiveTheme as _, Icon,
    button::{Button, ButtonVariants as _},
};
use gpui_kit::{
    AnyElement, App, Entity, FontWeight, InteractiveElement as _, IntoElement, MouseButton,
    ParentElement, RenderOnce, Role, SharedString, StatefulInteractiveElement as _, Styled,
    TestSupportExt as _, Window, div, prelude::FluentBuilder as _, px,
};

use crate::controls::ControlSize as _;
use crate::controls::TextRole as _;
use crate::drag::DragStrip;
use crate::shell::ShellState;

pub const TOP_BAR_HEIGHT: f32 = 60.;

/// A top bar narrower than this has too little room for a page's labels and quiet facts, which
/// pages then leave to icons and tooltips.
const NARROW_BAR: f32 = 780.;

/// Whether the window, less the sidebar in its form, leaves the top bar too little room for
/// labels and quiet facts.
pub fn narrow_top_bar(window: &Window, shell: &Entity<ShellState>, cx: &App) -> bool {
    let sidebar = if shell.read(cx).rail() {
        crate::layout::RAIL_WIDTH
    } else {
        crate::layout::SIDEBAR_WIDTH
    };
    f32::from(window.viewport_size().width) - sidebar < NARROW_BAR
}

#[derive(IntoElement)]
pub struct TopBar {
    shell: Entity<ShellState>,
    title: SharedString,
    meta: Option<SharedString>,
    quiet: Vec<AnyElement>,
    trailing: Vec<AnyElement>,
}

impl TopBar {
    pub fn new(shell: &Entity<ShellState>, title: impl Into<SharedString>) -> Self {
        Self {
            shell: shell.clone(),
            title: title.into(),
            meta: None,
            quiet: Vec::new(),
            trailing: Vec::new(),
        }
    }

    /// A quieter line beside the title, such as where a folder is (`TopBar`'s `meta`); cut from
    /// the start when long, so its end stays.
    pub fn meta(mut self, meta: impl Into<SharedString>) -> Self {
        self.meta = Some(meta.into());
        self
    }

    /// A quiet fact before the bar's controls, such as how many files a page has: it goes where
    /// the bar is narrow, and is cut before it would crowd them.
    pub fn quiet(mut self, element: impl IntoElement) -> Self {
        self.quiet.push(element.into_any_element());
        self
    }

    /// A control at the bar's end, such as a page's toolbar.
    pub fn trailing(mut self, element: impl IntoElement) -> Self {
        self.trailing.push(element.into_any_element());
        self
    }
}

impl RenderOnce for TopBar {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let narrow = narrow_top_bar(window, &self.shell, cx);
        let shell = self.shell.clone();
        let rail = self.shell.read(cx).rail();
        // `SidebarToggle`'s words and icons: the sidebar compacts to the rail and expands back.
        let (toggle_label, toggle_icon) = if rail {
            ("Expand sidebar", gpui_kit::assets::IconName::PanelLeftOpen)
        } else {
            (
                "Compact sidebar",
                gpui_kit::assets::IconName::PanelLeftClose,
            )
        };
        let toggle_tooltip = crate::keys::labelled(toggle_label, crate::keys::SIDEBAR);

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
                // The bar's size in the house scale, the owner having found smaller ones too small
                // beside the title.
                Button::new("toggle-sidebar")
                    .ghost()
                    .bar_size()
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
                    // Never narrower than the title, whatever the page's controls ask for.
                    .flex_1()
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
                            .text_title()
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
                                .text_sm()
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
                    .min_w_0()
                    // The page's controls are pressable, so a press on them must not move the
                    // window.
                    .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                    .when(!narrow, |this| this.children(self.quiet))
                    .children(self.trailing),
            )
    }
}
