//! View's part of the sidebar (`ViewSidebar.tsx`), as Tidy and Sync have theirs: the folder the
//! owner opened in the location switcher every mode has, whose menu opens another, then where
//! View is inside it as a short tree. The parent is a muted step up, the folder on screen is the
//! current row, and its subfolders sit indented beneath it. In the rail, the switcher's tile and
//! Parent as an icon.

use std::path::Path;

use gpui_kit::assets::IconName;
use gpui_kit::component::menu::{PopupMenu, PopupMenuItem};
use gpui_kit::component::{
    ActiveTheme as _, Disableable as _, Icon, Sizable as _,
    button::{Button, ButtonVariants as _},
};
use gpui_kit::{
    AnyElement, Context, InteractiveElement as _, IntoElement, ParentElement as _, Role,
    SharedString, StatefulInteractiveElement as _, Styled as _, TestSupportExt as _, div,
    prelude::FluentBuilder as _, px,
};
use gpui_kit::{App, Entity};
use oriel_ui::ModeId;
use oriel_ui::layout::NavItem;
use oriel_ui::locations::{LocationItem, LocationSwitcher, location_id, shared_locations};

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
                .child(self.location_switcher(true, cx))
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

        let switcher = self.location_switcher(false, cx);
        let theme = cx.theme();
        let catalog = self.catalog.read(cx);
        let root = catalog.root().cloned();
        let children = catalog.children().clone();
        let children_loading = catalog.children_loading();

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
            .child(switcher)
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

    /// The folder the owner opened, in the location switcher every mode has: its menu lists it,
    /// the folders the other modes use (one opens here), and Open Folder….
    fn location_switcher(&self, rail: bool, cx: &mut Context<Self>) -> LocationSwitcher {
        let view = cx.entity();
        let opened = self.navigation_ceiling.clone();
        let switcher = LocationSwitcher::new(
            match &opened {
                Some(opened) => display_name(opened),
                None => "No folder open".into(),
            },
            move |menu, _, cx| folder_menu(&view, menu, cx),
        )
        .rail(rail);
        match &opened {
            Some(opened) => switcher
                .path_caption(
                    opened
                        .parent()
                        .map(|parent| parent.display().to_string())
                        .unwrap_or_default(),
                )
                .tooltip(opened.display().to_string()),
            None => switcher.caption("Open one to see it"),
        }
    }
}

/// The switcher's menu, as it is when it opens.
fn folder_menu(view: &Entity<ViewMode>, mut menu: PopupMenu, cx: &App) -> PopupMenu {
    let this = view.read(cx);
    let shell = this.shell.read(cx);
    let opened = this.navigation_ceiling.clone();
    if let Some(opened) = &opened {
        let mut modes = shell.modes_using(opened).to_vec();
        if !modes.contains(&ModeId::View) {
            modes.insert(0, ModeId::View);
        }
        let (target, folder) = (view.clone(), opened.to_path_buf());
        menu = menu.item(
            LocationItem::new(location_id(opened), display_name(opened))
                .modes(&modes)
                .into_item()
                .checked(true)
                .on_click(move |_, _, cx| {
                    target.update(cx, |view, cx| view.open_folder(folder.clone(), cx));
                }),
        );
    }
    let offered = shell
        .offered_to(ModeId::View)
        .into_iter()
        .filter(|folder| opened.as_deref() != Some(folder.path()))
        .collect();
    let picker = view.clone();
    menu = shared_locations(
        menu,
        "Open one you already use",
        offered,
        move |folder, _, cx| {
            let folder = folder.to_path_buf();
            picker.update(cx, |view, cx| view.open_folder(folder, cx));
        },
    );
    let chooser = view.clone();
    menu.separator().item(
        PopupMenuItem::new("Open Folder…  ⌘O").on_click(move |_, _, cx| {
            chooser.update(cx, |view, cx| view.choose_folder(cx));
        }),
    )
}
