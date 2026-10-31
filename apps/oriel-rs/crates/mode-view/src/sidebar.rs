//! View's part of the sidebar (`ViewSidebar.tsx`), as Tidy and Sync have theirs: the folder the
//! owner opened, which opens another, then where View is inside it as a short tree. The parent is
//! a muted step up, the folder on screen is the current row, and its subfolders sit indented
//! beneath it. In the rail, Open and Parent as icons.

use std::path::Path;

use gpui_kit::assets::IconName;
use gpui_kit::component::{
    ActiveTheme as _, Disableable as _, Icon, Sizable as _,
    button::{Button, ButtonVariants as _},
};
use gpui_kit::{
    AnyElement, Context, InteractiveElement as _, IntoElement, ParentElement as _, Role,
    SharedString, StatefulInteractiveElement as _, Styled as _, TestSupportExt as _, div,
    prelude::FluentBuilder as _, px,
};
use oriel_ui::layout::NavItem;

use crate::ViewMode;
use crate::gallery::display_name;

/// A row's left padding at a depth of the folder tree, 14 px a level.
fn indent(depth: usize) -> f32 {
    depth as f32 * 14.
}

impl ViewMode {
    pub(crate) fn render_navigation(&self, cx: &mut Context<Self>) -> AnyElement {
        let rail = self.shell.read(cx).rail();
        let parent = self.parent_folder(cx);
        if rail {
            return div()
                .id("view-sidebar")
                .role(Role::Navigation)
                .test_support()
                .aria_label("View")
                .flex()
                .flex_col()
                .items_center()
                .gap_1()
                .w_full()
                .child(
                    Button::new("sidebar-open-folder")
                        .ghost()
                        .large()
                        .icon(Icon::new(IconName::FolderOpen))
                        .tooltip("Open a folder  ⌘O")
                        .accessibility_label("Open a folder")
                        .on_click(cx.listener(|this, _, _, cx| this.choose_folder(cx))),
                )
                .child(
                    Button::new("sidebar-parent")
                        .ghost()
                        .large()
                        .icon(Icon::new(IconName::ArrowUp))
                        .tooltip(match &parent {
                            Some(parent) => format!("Up to {}", display_name(parent)),
                            None => "Up a folder".into(),
                        })
                        .accessibility_label("Up to the parent folder")
                        .disabled(parent.is_none())
                        .on_click(cx.listener(|this, _, _, cx| this.open_parent_folder(cx))),
                )
                .into_any_element();
        }

        let theme = cx.theme();
        let opened = self.navigation_ceiling.clone();
        let catalog = self.catalog.read(cx);
        let root = catalog.root().cloned();
        let children = catalog.children().clone();
        let children_loading = catalog.children_loading();

        // A button, so Tab reaches it and Return or Space presses it, as Electron Oriel's is.
        let opened_button = gpui_kit::base::Button::new("sidebar-open-folder")
            .accessibility_label("Open a folder")
            .flex()
            .flex_row()
            .items_center()
            .justify_start()
            .gap(px(10.))
            .h(px(52.))
            .mx_2()
            .px_2()
            .rounded(theme.radius_lg)
            .hover(|style| style.bg(theme.sidebar_accent))
            .child(
                div()
                    .flex()
                    .flex_shrink_0()
                    .items_center()
                    .justify_center()
                    .size(px(32.))
                    .rounded(theme.radius_lg)
                    .bg(theme.background)
                    .border_1()
                    .border_color(theme.border)
                    .child(Icon::new(IconName::FolderOpen).size(px(16.))),
            )
            .child(
                div()
                    .flex()
                    .flex_col()
                    .flex_1()
                    .min_w_0()
                    .child(
                        div()
                            .truncate()
                            .text_size(px(13.))
                            .font_weight(gpui_kit::FontWeight::SEMIBOLD)
                            .child(match &opened {
                                Some(opened) => display_name(opened),
                                None => "No folder open".into(),
                            }),
                    )
                    .child(
                        // Where the folder is, cut from the start when long so the nearest
                        // folders stay (`StartTruncate`).
                        div()
                            .overflow_hidden()
                            .whitespace_nowrap()
                            .when(opened.is_some(), |this| this.text_ellipsis_start())
                            .when(opened.is_none(), |this| this.text_ellipsis())
                            .text_xs()
                            .text_color(theme.muted_foreground)
                            .child(match &opened {
                                Some(opened) => opened
                                    .parent()
                                    .map(|parent| parent.display().to_string())
                                    .unwrap_or_default(),
                                None => "Open one to see it".into(),
                            }),
                    ),
            )
            .on_click(cx.listener(|this, _, _, cx| this.choose_folder(cx)));

        let mut list = div().flex().flex_col().gap(px(2.)).px_2().pb_2();
        if let Some(root) = &root {
            let upward = parent.clone();
            let depth = usize::from(upward.is_some());
            if let Some(upward) = upward {
                let name = display_name(&upward);
                list = list.child(
                    NavItem::new("sidebar-up", Icon::new(IconName::ArrowUp), name.clone())
                        .accessibility_label(format!("Up to {name}"))
                        .on_click(cx.listener(|this, _, _, cx| this.open_parent_folder(cx))),
                );
            }
            list = list.child(
                div().pl(px(indent(depth))).child(
                    NavItem::new(
                        "sidebar-current",
                        Icon::new(IconName::FolderOpen),
                        display_name(root),
                    )
                    .current(true),
                ),
            );
            for child in children.iter() {
                let path = Path::new(&child.path).to_path_buf();
                list = list.child(
                    div().pl(px(indent(depth + 1))).child(
                        NavItem::new(
                            SharedString::from(format!("sidebar-folder:{}", child.path)),
                            Icon::new(IconName::Folder),
                            child.name.clone(),
                        )
                        .on_click(cx.listener(move |this, _, _, cx| {
                            this.navigate_to_folder(path.clone(), None, cx);
                        })),
                    ),
                );
            }
            if children.is_empty() {
                list = list.child(
                    div()
                        .pl(px(indent(depth + 1) + 10.))
                        .py(px(6.))
                        .text_xs()
                        .text_color(theme.muted_foreground)
                        .child(if children_loading {
                            "Looking for subfolders…"
                        } else {
                            "No subfolders"
                        }),
                );
            }
        }

        div()
            .id("view-sidebar")
            .role(Role::Navigation)
            .test_support()
            .aria_label("View")
            .flex()
            .flex_col()
            .w_full()
            .child(opened_button)
            .when(root.is_some(), |this| {
                this.child(
                    div()
                        .px(px(18.))
                        .pt_4()
                        .pb(px(6.))
                        .text_xs()
                        .font_weight(gpui_kit::FontWeight::MEDIUM)
                        .text_color(theme.muted_foreground)
                        .child("Folders"),
                )
                .child(list)
            })
            .into_any_element()
    }
}
