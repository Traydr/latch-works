//! One mode's window: the sidebar, with the mode switcher at its top and the mode's own navigation
//! below, beside the mode's content. Every mode's sidebar is full or the rail together, as the
//! owner last chose (`apps/oriel/src/shell/ModeLayout.tsx`).

use gpui_kit::component::{
    ActiveTheme as _, Icon, Selectable as _, Sizable as _,
    button::{Button, ButtonVariants as _},
};
use gpui_kit::{
    AnyElement, App, ClickEvent, ElementId, Entity, FontWeight, InteractiveElement as _,
    IntoElement, ParentElement, RenderOnce, SharedString, StatefulInteractiveElement as _, Styled,
    TestSupportExt as _, Window, div, prelude::FluentBuilder as _, px,
};

use crate::drag::DragStrip;
use crate::shell::{ModeId, ShellState};

/// The full sidebar's width.
pub const SIDEBAR_WIDTH: f32 = 240.;
/// The rail's width on macOS, where the window buttons sit in its top strip: at 16 px in they end
/// near 76 px, so the rail is wide enough to hold them.
pub const RAIL_WIDTH: f32 = 88.;
/// The strip above the switcher, which holds the window buttons and moves the window.
const SIDEBAR_STRIP_HEIGHT: f32 = 52.;

#[derive(IntoElement)]
pub struct ModeLayout {
    shell: Entity<ShellState>,
    navigation: Option<AnyElement>,
    children: Vec<AnyElement>,
}

impl ModeLayout {
    pub fn new(shell: &Entity<ShellState>) -> Self {
        Self {
            shell: shell.clone(),
            navigation: None,
            children: Vec::new(),
        }
    }

    /// The mode's own navigation, below the switcher.
    pub fn navigation(mut self, navigation: impl IntoElement) -> Self {
        self.navigation = Some(navigation.into_any_element());
        self
    }
}

impl ParentElement for ModeLayout {
    fn extend(&mut self, elements: impl IntoIterator<Item = AnyElement>) {
        self.children.extend(elements);
    }
}

impl RenderOnce for ModeLayout {
    fn render(self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        let rail = self.shell.read(cx).rail();
        let theme = cx.theme();

        div()
            .flex()
            .flex_row()
            .size_full()
            .min_h_0()
            .overflow_hidden()
            .bg(theme.background)
            .text_color(theme.foreground)
            .child(
                div()
                    .flex()
                    .flex_col()
                    .flex_shrink_0()
                    .h_full()
                    .w(px(if rail { RAIL_WIDTH } else { SIDEBAR_WIDTH }))
                    .when(rail, |this| this.items_center())
                    .bg(theme.sidebar)
                    .text_color(theme.sidebar_foreground)
                    .border_r_1()
                    .border_color(theme.sidebar_border)
                    .child(
                        DragStrip::new("sidebar-strip")
                            .w_full()
                            .flex_shrink_0()
                            .h(px(SIDEBAR_STRIP_HEIGHT)),
                    )
                    .child(ModeSwitcher::new(&self.shell, rail))
                    .child(
                        div()
                            .id("mode-navigation")
                            .flex()
                            .flex_col()
                            .w_full()
                            .flex_1()
                            .min_h_0()
                            .overflow_y_scroll()
                            .children(self.navigation),
                    ),
            )
            .child(
                div()
                    .relative()
                    .flex()
                    .flex_col()
                    .flex_1()
                    .min_w_0()
                    .min_h_0()
                    .children(self.children),
            )
    }
}

/// View · Tidy · Sync, at the top of every mode's sidebar: a segmented control when the sidebar is
/// full, and the three mode icons stacked when it is the rail.
#[derive(IntoElement)]
struct ModeSwitcher {
    shell: Entity<ShellState>,
    rail: bool,
}

impl ModeSwitcher {
    fn new(shell: &Entity<ShellState>, rail: bool) -> Self {
        Self {
            shell: shell.clone(),
            rail,
        }
    }
}

impl RenderOnce for ModeSwitcher {
    fn render(self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        let current = self.shell.read(cx).mode();

        if self.rail {
            return div()
                .flex()
                .flex_col()
                .items_center()
                .w_full()
                .gap_1()
                .children(ModeId::ALL.map(|mode| {
                    let shell = self.shell.clone();
                    Button::new(SharedString::from(format!("mode-{}", mode.label())))
                        .ghost()
                        .large()
                        .icon(Icon::new(mode.icon()))
                        .selected(mode == current)
                        .tooltip(format!("{}  {}", mode.label(), mode.shortcut()))
                        .on_click(move |_, _, cx| shell.update(cx, |shell, cx| shell.go(mode, cx)))
                }))
                .child(
                    div()
                        .my_3()
                        .h(px(1.))
                        .w(px(32.))
                        .bg(cx.theme().sidebar_border),
                )
                .into_any_element();
        }

        // `.lw-seg`: a 32 px track, the current mode raised on it.
        let theme = cx.theme();
        div()
            .w_full()
            .px_2()
            .pb_1()
            .child(
                div()
                    .flex()
                    .flex_row()
                    .items_center()
                    .w_full()
                    .h(px(32.))
                    .p(px(2.))
                    .gap(px(2.))
                    .rounded(theme.radius)
                    .bg(theme.tab_bar)
                    .children(ModeId::ALL.map(|mode| {
                        let shell = self.shell.clone();
                        let selected = mode == current;
                        div()
                            .id(SharedString::from(format!("mode-{}", mode.label())))
                            .test_support()
                            .flex()
                            .flex_row()
                            .flex_1()
                            .items_center()
                            .justify_center()
                            .gap(px(6.))
                            .h(px(28.))
                            .rounded(theme.radius - px(2.))
                            .text_size(px(13.))
                            .font_weight(FontWeight::MEDIUM)
                            .text_color(theme.tab_foreground)
                            .hover(|style| style.text_color(theme.tab_active_foreground))
                            .when(selected, |this| {
                                this.bg(theme.tab_active)
                                    .text_color(theme.tab_active_foreground)
                                    .shadow_xs()
                            })
                            .tooltip(move |window, cx| {
                                gpui_kit::component::tooltip::Tooltip::new(mode.shortcut())
                                    .build(window, cx)
                            })
                            .child(Icon::new(mode.icon()).size(px(14.)))
                            .child(mode.label())
                            .on_click(move |_, _, cx| {
                                shell.update(cx, |shell, cx| shell.go(mode, cx))
                            })
                    })),
            )
            .into_any_element()
    }
}

type ClickHandler = Box<dyn Fn(&ClickEvent, &mut Window, &mut App) + 'static>;

/// One entry of a mode's navigation, as `.lw-sidebar-item`: 32 px, the icon then the label, the
/// current page lifted on neutral ground. In the rail it is the icon alone, with its name as the
/// tooltip.
#[derive(IntoElement)]
pub struct NavItem {
    id: ElementId,
    icon: Icon,
    label: SharedString,
    current: bool,
    rail: bool,
    on_click: Option<ClickHandler>,
}

impl NavItem {
    pub fn new(
        id: impl Into<ElementId>,
        icon: impl Into<Icon>,
        label: impl Into<SharedString>,
    ) -> Self {
        Self {
            id: id.into(),
            icon: icon.into(),
            label: label.into(),
            current: false,
            rail: false,
            on_click: None,
        }
    }

    pub fn current(mut self, current: bool) -> Self {
        self.current = current;
        self
    }

    pub fn rail(mut self, rail: bool) -> Self {
        self.rail = rail;
        self
    }

    pub fn on_click(
        mut self,
        handler: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
    ) -> Self {
        self.on_click = Some(Box::new(handler));
        self
    }
}

impl RenderOnce for NavItem {
    fn render(self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        let theme = cx.theme();
        let label = self.label.clone();

        div()
            .id(self.id)
            .test_support()
            .flex()
            .flex_row()
            .items_center()
            .flex_shrink_0()
            .h(px(32.))
            .rounded(theme.radius)
            .gap(px(10.))
            .text_size(px(13.))
            .map(|this| {
                if self.rail {
                    this.w(px(48.)).h(px(40.)).justify_center()
                } else {
                    this.w_full().px(px(10.))
                }
            })
            .text_color(if self.current {
                theme.foreground
            } else {
                theme.sidebar_foreground
            })
            .when(self.current, |this| {
                this.bg(theme.sidebar_accent)
                    .font_weight(FontWeight::MEDIUM)
            })
            .hover(|style| style.bg(theme.sidebar_accent))
            .child(self.icon.size(px(16.)).text_color(if self.current {
                theme.foreground
            } else {
                theme.muted_foreground
            }))
            .when(!self.rail, |this| {
                this.child(div().truncate().child(self.label))
            })
            .when(self.rail, |this| {
                this.tooltip(move |window, cx| {
                    gpui_kit::component::tooltip::Tooltip::new(label.clone()).build(window, cx)
                })
            })
            .when_some(self.on_click, |this, handler| this.on_click(handler))
    }
}
