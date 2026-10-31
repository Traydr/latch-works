//! The one Settings page, over the whole window (Electron Oriel's `Settings.tsx`): the
//! sections on the left, Oriel's own and then one per mode, and the one showing on the right.
//! The way back sits at the sidebar's bottom left, where Settings was. A mode draws its own
//! section from [`SettingsGroup`]s of [`SettingsRow`]s, as System Settings groups them.

use gpui_kit::assets::IconName;
use gpui_kit::component::{ActiveTheme as _, Icon};
use gpui_kit::{
    AnyElement, App, Entity, FontWeight, InteractiveElement as _, IntoElement, ParentElement,
    RenderOnce, Role, SharedString, StatefulInteractiveElement as _, Styled, TestSupportExt as _,
    Window, div, prelude::FluentBuilder as _, px,
};

use crate::drag::DragStrip;
use crate::layout::{NavItem, SIDEBAR_STRIP_HEIGHT, SIDEBAR_WIDTH};
use crate::shell::{SettingsSection, ShellState};
use crate::top_bar::TOP_BAR_HEIGHT;

/// The element id of `section`'s entry in Settings' sidebar: `settings-section-general`, …
pub fn section_item_id(section: SettingsSection) -> SharedString {
    format!("settings-section-{}", section.key()).into()
}

/// The page: what the shell draws in place of the mode while Settings is open. `content` is the
/// section on screen, which the shell asks the section's owner to draw.
#[derive(IntoElement)]
pub struct SettingsFrame {
    shell: Entity<ShellState>,
    content: AnyElement,
}

impl SettingsFrame {
    pub fn new(shell: &Entity<ShellState>, content: impl IntoElement) -> Self {
        Self {
            shell: shell.clone(),
            content: content.into_any_element(),
        }
    }
}

impl RenderOnce for SettingsFrame {
    fn render(self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        let state = self.shell.read(cx);
        let current = state.settings().unwrap_or(SettingsSection::General);
        let mode = state.mode();
        let theme = cx.theme();

        let sections = SettingsSection::ALL.map(|section| {
            let shell = self.shell.clone();
            NavItem::new(
                section_item_id(section),
                Icon::new(section.icon()),
                section.label(),
            )
            .current(section == current)
            .on_click(move |_, _, cx| {
                shell.update(cx, |shell, cx| shell.open_settings(section, cx));
            })
        });
        let back = {
            let shell = self.shell.clone();
            NavItem::new(
                "settings-back",
                Icon::new(IconName::ArrowLeft),
                format!("Back to {}", mode.label()),
            )
            .tooltip("Esc")
            .on_click(move |_, _, cx| shell.update(cx, |shell, cx| shell.close_settings(cx)))
        };

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
                    .w(px(SIDEBAR_WIDTH))
                    .bg(theme.sidebar)
                    .text_color(theme.sidebar_foreground)
                    .border_r_1()
                    .border_color(theme.sidebar_border)
                    .child(
                        DragStrip::new("settings-strip")
                            .w_full()
                            .flex_shrink_0()
                            .h(px(SIDEBAR_STRIP_HEIGHT)),
                    )
                    .child(
                        div()
                            .id("settings-sections")
                            .test_support()
                            .role(Role::Navigation)
                            .aria_label("Settings sections")
                            .flex()
                            .flex_col()
                            .flex_1()
                            .min_h_0()
                            .gap_0p5()
                            .px_2()
                            .children(sections),
                    )
                    .child(div().flex_shrink_0().px_2().pt_2().pb_3().child(back)),
            )
            .child(
                div()
                    .flex()
                    .flex_col()
                    .flex_1()
                    .min_w_0()
                    .min_h_0()
                    .child(
                        DragStrip::new("settings-header")
                            .accessible(Role::Toolbar, current.label())
                            .flex()
                            .flex_row()
                            .items_center()
                            .flex_shrink_0()
                            .h(px(TOP_BAR_HEIGHT))
                            .px_5()
                            .border_b_1()
                            .border_color(theme.border)
                            .child(
                                div()
                                    .id("settings-title")
                                    .test_support()
                                    .role(Role::Heading)
                                    .aria_level(1)
                                    .aria_label(current.label())
                                    .truncate()
                                    .text_size(px(17.))
                                    .font_weight(FontWeight::SEMIBOLD)
                                    .child(current.label()),
                            ),
                    )
                    .child(
                        div()
                            // One scroll position per section.
                            .id(SharedString::from(format!(
                                "settings-content-{}",
                                current.key()
                            )))
                            .flex_1()
                            .min_h_0()
                            .overflow_y_scroll()
                            .child(
                                div()
                                    .mx_auto()
                                    .w_full()
                                    .max_w(px(640.))
                                    .px_6()
                                    .pt_6()
                                    .pb(px(112.))
                                    .child(self.content),
                            ),
                    ),
            )
    }
}

/// A titled group of rows in a card, as System Settings groups them (`SettingsGroup`).
#[derive(IntoElement)]
pub struct SettingsGroup {
    title: SharedString,
    rows: Vec<AnyElement>,
}

impl SettingsGroup {
    pub fn new(title: impl Into<SharedString>) -> Self {
        Self {
            title: title.into(),
            rows: Vec::new(),
        }
    }
}

impl ParentElement for SettingsGroup {
    fn extend(&mut self, elements: impl IntoIterator<Item = AnyElement>) {
        self.rows.extend(elements);
    }
}

impl RenderOnce for SettingsGroup {
    fn render(self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        let theme = cx.theme();
        let rows = self.rows.into_iter().enumerate().map(|(ix, row)| {
            div()
                .when(ix > 0, |this| this.border_t_1().border_color(theme.border))
                .child(row)
        });
        div()
            .flex()
            .flex_col()
            .pb_8()
            .child(
                div()
                    .px_1()
                    .pb_2()
                    .text_sm()
                    .font_weight(FontWeight::SEMIBOLD)
                    .child(self.title),
            )
            .child(
                div()
                    .flex()
                    .flex_col()
                    .overflow_hidden()
                    .rounded(theme.radius_lg)
                    .bg(theme.group_box)
                    .border_1()
                    .border_color(theme.border)
                    .children(rows),
            )
    }
}

/// A settings row: the label and its one-line description on the left, the control right
/// (`SettingsRow`).
#[derive(IntoElement)]
pub struct SettingsRow {
    label: SharedString,
    description: Option<SharedString>,
    controls: Vec<AnyElement>,
}

impl SettingsRow {
    pub fn new(label: impl Into<SharedString>) -> Self {
        Self {
            label: label.into(),
            description: None,
            controls: Vec::new(),
        }
    }

    pub fn description(mut self, description: impl Into<SharedString>) -> Self {
        self.description = Some(description.into());
        self
    }
}

impl ParentElement for SettingsRow {
    fn extend(&mut self, elements: impl IntoIterator<Item = AnyElement>) {
        self.controls.extend(elements);
    }
}

impl RenderOnce for SettingsRow {
    fn render(self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        let theme = cx.theme();
        div()
            .flex()
            .flex_row()
            .items_center()
            .gap_4()
            .min_h(px(52.))
            .px_4()
            .py(px(10.))
            .child(
                div()
                    .flex()
                    .flex_col()
                    .flex_1()
                    .min_w_0()
                    .child(div().text_size(px(13.)).child(self.label))
                    .when_some(self.description, |this, description| {
                        this.child(
                            div()
                                .mt_0p5()
                                .text_xs()
                                .text_color(theme.muted_foreground)
                                .child(description),
                        )
                    }),
            )
            .when(!self.controls.is_empty(), |this| {
                this.child(
                    div()
                        .flex()
                        .flex_row()
                        .flex_shrink_0()
                        .items_center()
                        .gap_2()
                        .children(self.controls),
                )
            })
    }
}
