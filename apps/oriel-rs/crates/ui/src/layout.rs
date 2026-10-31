//! One mode's window: the sidebar, with the mode switcher at its top, the mode's own navigation
//! below and Settings at its foot, beside the mode's content. Every mode's sidebar is full or the
//! rail together, as the owner last chose (`apps/oriel/src/shell/ModeLayout.tsx`).

use std::rc::Rc;
use std::time::Duration;

use gpui_kit::assets::IconName;
use gpui_kit::component::{ActiveTheme as _, Icon, progress::ProgressCircle};
use gpui_kit::{
    Animation, AnimationExt as _, AnyElement, App, ClickEvent, ElementId, Entity, FontWeight,
    InteractiveElement, IntoElement, MouseButton, ParentElement, RenderOnce, Role, SharedString,
    StatefulInteractiveElement as _, Styled, TestSupportExt as _, Window, div,
    prelude::FluentBuilder as _, pulsating_between, px,
};

use crate::drag::DragStrip;
use crate::segmented::{Segmented, SegmentedItem};
use crate::shell::{ModeActivity, ModeId, SettingsSection, ShellState};

/// A press on a sidebar control leaves keyboard focus where it was, as GPUI Kit's buttons do: the
/// control acts at once, Tab still reaches it, and the keys keep reaching the mode. Focus taken by
/// a press would stay on a control the next mode does not draw.
pub trait KeepsFocus: InteractiveElement + Sized {
    fn keeps_focus_on_press(self) -> Self {
        self.on_mouse_down(MouseButton::Left, |_, window, _| window.prevent_default())
    }
}

impl<T: InteractiveElement> KeepsFocus for T {}

/// The full sidebar's width.
pub const SIDEBAR_WIDTH: f32 = 240.;
/// The rail's width on macOS, where the window buttons sit in its top strip: at 16 px in they end
/// near 76 px, so the rail is wide enough to hold them.
pub const RAIL_WIDTH: f32 = 88.;
/// The strip above the switcher, which holds the window buttons and moves the window.
pub const SIDEBAR_STRIP_HEIGHT: f32 = 52.;
/// The rail's buttons: 48 px targets in the 88 px macOS rail, as Glazier's were.
const RAIL_BUTTON: f32 = 48.;

#[derive(IntoElement)]
pub struct ModeLayout {
    shell: Entity<ShellState>,
    navigation: Option<AnyElement>,
    navigation_label: Option<SharedString>,
    footer: Vec<AnyElement>,
    children: Vec<AnyElement>,
}

impl ModeLayout {
    pub fn new(shell: &Entity<ShellState>) -> Self {
        Self {
            shell: shell.clone(),
            navigation: None,
            navigation_label: None,
            footer: Vec::new(),
            children: Vec::new(),
        }
    }

    /// The mode's own navigation, below the switcher.
    pub fn navigation(mut self, navigation: impl IntoElement) -> Self {
        self.navigation = Some(navigation.into_any_element());
        self
    }

    /// What VoiceOver calls the navigation, such as "Profiles"; the mode's name by default.
    pub fn navigation_label(mut self, label: impl Into<SharedString>) -> Self {
        self.navigation_label = Some(label.into());
        self
    }

    /// An item at the sidebar's foot, above Settings, such as Tidy's Holding.
    pub fn footer(mut self, element: impl IntoElement) -> Self {
        self.footer.push(element.into_any_element());
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
        let state = self.shell.read(cx);
        let rail = state.rail();
        let mode = state.mode();
        let theme = cx.theme();
        let navigation_label = self.navigation_label.unwrap_or_else(|| mode.label().into());

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
                    .id("sidebar")
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
                            .role(Role::Navigation)
                            .aria_label(navigation_label)
                            .flex()
                            .flex_col()
                            .w_full()
                            .flex_1()
                            .min_h_0()
                            .overflow_y_scroll()
                            .children(self.navigation),
                    )
                    .child(
                        div()
                            .flex()
                            .flex_col()
                            .flex_shrink_0()
                            .w_full()
                            .gap_0p5()
                            .px_2()
                            .pt_2()
                            .pb_3()
                            .when(rail, |this| this.items_center())
                            .children(self.footer)
                            .child(SettingsItem::new(&self.shell, rail)),
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
/// full, and the three mode icons stacked when it is the rail. A mode working while another
/// shows says so on its button: a ring while a push or a change runs, a dot while a scan or an
/// analysis does.
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

/// The element id of `mode`'s switcher button: `mode-View`, `mode-Tidy`, `mode-Sync`.
pub fn mode_button_id(mode: ModeId) -> SharedString {
    format!("mode-{}", mode.label()).into()
}

impl RenderOnce for ModeSwitcher {
    fn render(self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        let state = self.shell.read(cx);
        let current = state.mode();
        // The work to show for each mode: none on the mode the owner is looking at.
        let work = ModeId::ALL.map(|mode| state.activity(mode).filter(|_| mode != current));
        let go = |mode: ModeId| {
            let shell = self.shell.clone();
            move |_: &ClickEvent, _: &mut Window, cx: &mut App| {
                shell.update(cx, |shell, cx| shell.go(mode, cx));
            }
        };
        let tooltip = |mode: ModeId| match work[mode.index()] {
            Some(activity) => format!("{}  {}", activity.describe(mode), mode.shortcut()),
            None => format!("{}  {}", mode.label(), mode.shortcut()),
        };

        if self.rail {
            let theme = cx.theme();
            return div()
                .id("mode-switcher")
                .test_support()
                .role(Role::Navigation)
                .aria_label("Mode")
                .flex()
                .flex_col()
                .items_center()
                .w_full()
                .gap_1()
                .children(ModeId::ALL.map(|mode| {
                    let selected = mode == current;
                    let activity = work[mode.index()];
                    gpui_kit::base::Button::new(mode_button_id(mode))
                        .keeps_focus_on_press()
                        .accessibility_label(mode.label())
                        .aria_selected(selected)
                        .when_some(activity, |this, activity| {
                            this.aria_description(activity.describe(mode))
                        })
                        .relative()
                        .size(px(RAIL_BUTTON))
                        .rounded(theme.radius_lg)
                        .border_2()
                        .border_color(theme.transparent)
                        .text_color(theme.sidebar_foreground)
                        .hover(|style| style.bg(theme.accent))
                        .focus_visible(|style| style.border_color(theme.ring))
                        .when(selected, |this| {
                            this.bg(theme.sidebar_accent).text_color(theme.foreground)
                        })
                        .tooltip({
                            let tooltip = SharedString::from(tooltip(mode));
                            move |window, cx| {
                                gpui_kit::component::tooltip::Tooltip::new(tooltip.clone())
                                    .build(window, cx)
                            }
                        })
                        .child(Icon::new(mode.icon()).size(px(22.)))
                        .when_some(activity, |this, activity| {
                            this.child(
                                div()
                                    .absolute()
                                    .top(px(4.))
                                    .right(px(4.))
                                    .child(ActivityMark::new(mode, activity)),
                            )
                        })
                        .on_click(go(mode))
                }))
                .child(div().my_3().h(px(1.)).w(px(32.)).bg(theme.sidebar_border))
                .into_any_element();
        }

        div()
            .id("mode-switcher")
            .test_support()
            .role(Role::Navigation)
            .aria_label("Mode")
            .w_full()
            .px_2()
            .pb_1()
            .child(
                Segmented::new("mode-segments", "Mode")
                    .fill()
                    .items(ModeId::ALL.map(|mode| {
                        let item = SegmentedItem::new(mode_button_id(mode), mode.label())
                            .icon(Icon::new(mode.icon()))
                            .selected(mode == current)
                            .tooltip(tooltip(mode))
                            .on_click(go(mode));
                        match work[mode.index()] {
                            Some(activity) => item
                                .description(activity.describe(mode))
                                .trailing(ActivityMark::new(mode, activity)),
                            None => item,
                        }
                    })),
            )
            .into_any_element()
    }
}

/// The element id of `mode`'s activity mark: `mode-Tidy-activity`.
pub fn activity_mark_id(mode: ModeId) -> SharedString {
    format!("mode-{}-activity", mode.label()).into()
}

/// A ring for work with a known end, filled as far as it has got; a dot, pulsing, for work
/// without one. Its meaning is in the switcher button's description, so it stays out of the
/// accessibility tree.
#[derive(IntoElement)]
struct ActivityMark {
    mode: ModeId,
    activity: ModeActivity,
}

impl ActivityMark {
    fn new(mode: ModeId, activity: ModeActivity) -> Self {
        Self { mode, activity }
    }
}

impl RenderOnce for ActivityMark {
    fn render(self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        let theme = cx.theme();
        let id = activity_mark_id(self.mode);
        match self.activity {
            ModeActivity::Progress(_) => div()
                .id(id)
                .test_support()
                .size(px(10.))
                .flex_shrink_0()
                .child(
                    ProgressCircle::new("ring")
                        .size_full()
                        .color(theme.primary)
                        .value(self.activity.percent() as f32),
                )
                .into_any_element(),
            ModeActivity::Working => {
                let dot = div()
                    .id(id)
                    .test_support()
                    .size(px(6.))
                    .flex_shrink_0()
                    .rounded_full()
                    .bg(theme.primary);
                if cx.reduce_motion() {
                    dot.into_any_element()
                } else {
                    dot.with_animation(
                        "pulse",
                        Animation::new(Duration::from_secs(2))
                            .repeat()
                            .with_easing(pulsating_between(0.4, 1.)),
                        |dot, delta| dot.opacity(delta),
                    )
                    .into_any_element()
                }
            }
        }
    }
}

type ClickHandler = Rc<dyn Fn(&ClickEvent, &mut Window, &mut App) + 'static>;

/// One entry of a mode's navigation, as `.lw-sidebar-item`: 32 px, the icon then the label, the
/// current page lifted on neutral ground. In the rail it is the icon alone, with its name as the
/// tooltip. It is a button: Tab reaches it, Return and Space press it, and VoiceOver reads its
/// name and whether it is the page on screen.
#[derive(IntoElement)]
pub struct NavItem {
    id: ElementId,
    icon: Icon,
    label: SharedString,
    /// What VoiceOver reads instead of the label, where the label alone says too little.
    accessibility_label: Option<SharedString>,
    current: bool,
    rail: bool,
    tooltip: Option<SharedString>,
    trailing: Option<AnyElement>,
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
            accessibility_label: None,
            current: false,
            rail: false,
            tooltip: None,
            trailing: None,
            on_click: None,
        }
    }

    /// The name VoiceOver reads, when the visible label alone says too little ("Up to Pictures"
    /// for an item labelled "Pictures").
    pub fn accessibility_label(mut self, label: impl Into<SharedString>) -> Self {
        self.accessibility_label = Some(label.into());
        self
    }

    pub fn current(mut self, current: bool) -> Self {
        self.current = current;
        self
    }

    pub fn rail(mut self, rail: bool) -> Self {
        self.rail = rail;
        self
    }

    /// The hover text, such as a shortcut; the rail shows the label when there is none.
    pub fn tooltip(mut self, tooltip: impl Into<SharedString>) -> Self {
        self.tooltip = Some(tooltip.into());
        self
    }

    /// Drawn at the item's end in the full sidebar, such as a count.
    pub fn trailing(mut self, element: impl IntoElement) -> Self {
        self.trailing = Some(element.into_any_element());
        self
    }

    pub fn on_click(
        mut self,
        handler: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
    ) -> Self {
        self.on_click = Some(Rc::new(handler));
        self
    }
}

impl RenderOnce for NavItem {
    fn render(self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        let theme = cx.theme();
        let current = self.current;
        let tooltip = self
            .tooltip
            .or_else(|| self.rail.then(|| self.label.clone()));
        let on_click = self.on_click;

        gpui_kit::base::Button::new(self.id)
            .keeps_focus_on_press()
            .accessibility_label(
                self.accessibility_label
                    .clone()
                    .unwrap_or_else(|| self.label.clone()),
            )
            .aria_selected(current)
            .relative()
            .flex_row()
            .flex_shrink_0()
            .justify_start()
            .rounded(theme.radius)
            .gap(px(10.))
            .text_size(px(13.))
            // The keyboard's focus line sits inside the item, as `.lw-sidebar-item`'s inset
            // outline does; the border is always there and only its colour changes.
            .border_2()
            .border_color(theme.transparent)
            .map(|this| {
                if self.rail {
                    this.w(px(RAIL_BUTTON)).h(px(44.)).justify_center()
                } else {
                    // Roomier than Electron Oriel's 32 px, as the owner asked of every control.
                    this.w_full().h(px(36.)).px(px(8.))
                }
            })
            .text_color(if current {
                theme.foreground
            } else {
                theme.sidebar_foreground
            })
            .hover(|style| style.bg(theme.accent))
            .focus_visible(|style| style.border_color(theme.ring))
            .when(current, |this| {
                this.bg(theme.sidebar_accent)
                    .font_weight(FontWeight::MEDIUM)
            })
            .child(self.icon.size(px(16.)).text_color(if current {
                theme.foreground
            } else {
                theme.muted_foreground
            }))
            .when(!self.rail, |this| {
                this.child(div().flex_1().min_w_0().truncate().child(self.label))
                    .children(self.trailing)
            })
            .when_some(tooltip, |this, tooltip| {
                this.tooltip(move |window, cx| {
                    gpui_kit::component::tooltip::Tooltip::new(tooltip.clone()).build(window, cx)
                })
            })
            .when_some(on_click, |this, handler| {
                this.on_click(move |event, window, cx| handler(event, window, cx))
            })
    }
}

/// Settings, at the bottom left of every mode's sidebar, full or rail: opens the one Settings
/// page at this mode's section. Settings puts its way back in the same place.
#[derive(IntoElement)]
struct SettingsItem {
    shell: Entity<ShellState>,
    rail: bool,
}

impl SettingsItem {
    fn new(shell: &Entity<ShellState>, rail: bool) -> Self {
        Self {
            shell: shell.clone(),
            rail,
        }
    }
}

impl RenderOnce for SettingsItem {
    fn render(self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        let mode = self.shell.read(cx).mode();
        let shell = self.shell;
        NavItem::new("settings-item", Icon::new(IconName::Settings), "Settings")
            .rail(self.rail)
            .tooltip("Settings  ⌘,")
            .on_click(move |_, _, cx| {
                shell.update(cx, |shell, cx| {
                    shell.open_settings(SettingsSection::Mode(mode), cx);
                });
            })
    }
}
