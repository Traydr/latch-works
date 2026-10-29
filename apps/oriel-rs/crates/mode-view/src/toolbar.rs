//! View's floating bottom bar (`GalleryToolbar.tsx`, `SortMenu.tsx`), in plan 057's order with
//! its visible labels and names: Open · Folders | Recursive · Comic · Sort · (Shuffle) | Refresh.
//! Recursive and Comic need a folder; Folders shows a dot while the folder has excluded
//! children; Refresh reads "Refreshing" while a scan runs.

use gpui_kit::assets::IconName;
use gpui_kit::component::{
    ActiveTheme as _, Disableable as _, Icon, Selectable as _,
    button::{Button, ButtonVariants as _},
};
use gpui_kit::{
    App, Context, InteractiveElement as _, IntoElement, MouseButton, ParentElement as _, Role,
    SharedString, StatefulInteractiveElement as _, Styled as _, TestSupportExt as _, div,
    prelude::FluentBuilder as _, px,
};
use oriel_core_domain::GallerySortMode;

use crate::ViewMode;

/// The sort menu's choices and their labels, in `SORT_OPTIONS`' order.
pub(crate) const SORT_OPTIONS: [(GallerySortMode, &str); 5] = [
    (GallerySortMode::NameAsc, "A-Z"),
    (GallerySortMode::NameDesc, "Z-A"),
    (GallerySortMode::DateNewest, "Newest"),
    (GallerySortMode::DateOldest, "Oldest"),
    (GallerySortMode::Random, "Random"),
];

/// The id of a sort choice's row, for tests: `sort-name-asc` and so on.
pub fn sort_option_id(mode: GallerySortMode) -> SharedString {
    let name = match mode {
        GallerySortMode::NameAsc => "name-asc",
        GallerySortMode::NameDesc => "name-desc",
        GallerySortMode::DateNewest => "date-newest",
        GallerySortMode::DateOldest => "date-oldest",
        GallerySortMode::Random => "random",
    };
    format!("sort-{name}").into()
}

fn separator(cx: &App) -> impl IntoElement {
    div()
        .mx(px(2.))
        .h(px(20.))
        .w(px(1.))
        .flex_shrink_0()
        .bg(cx.theme().border)
}

impl ViewMode {
    pub(crate) fn render_toolbar(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let catalog = self.catalog.read(cx);
        let has_folder = catalog.root().is_some();
        let refreshing = catalog.is_scanning();
        let preferences = self.current_preferences(cx);
        let comic = preferences.comic_mode;
        let recursive = self.recursive || comic;
        let excludes = !preferences.excluded_root_child_paths.is_empty();
        let sort_mode = self.settings.settings().sort_mode;
        let sort_label = SORT_OPTIONS
            .iter()
            .find(|(mode, _)| *mode == sort_mode)
            .map_or("A-Z", |(_, label)| label);
        let menu = self
            .sort_menu_open
            .then(|| self.render_sort_menu(sort_mode, cx).into_any_element());
        let theme = cx.theme();

        let folders = div()
            .relative()
            .child(
                Button::new("folders")
                    .ghost()
                    .icon(Icon::new(IconName::Folders))
                    .label("Folders")
                    .tooltip(if excludes {
                        "Browse subfolders (some are excluded)"
                    } else {
                        "Browse subfolders"
                    })
                    .disabled(!has_folder)
                    .on_click(cx.listener(|this, _, window, cx| {
                        this.open_folder_overlay(window, cx);
                    })),
            )
            .when(excludes, |this| {
                this.child(
                    div()
                        .absolute()
                        .top_1()
                        .right_1()
                        .size(px(6.))
                        .rounded_full()
                        .bg(theme.primary),
                )
            });

        let sort = div()
            .relative()
            .child(
                Button::new("sort")
                    .ghost()
                    .icon(Icon::new(IconName::ArrowUpDown))
                    .label(sort_label)
                    .tooltip("Sort")
                    .selected(self.sort_menu_open)
                    .on_click(cx.listener(|this, _, _, cx| {
                        this.sort_menu_open = !this.sort_menu_open;
                        cx.notify();
                    })),
            )
            .children(menu);

        div()
            .absolute()
            .bottom(px(20.))
            .left_0()
            .right_0()
            .flex()
            .justify_center()
            .child(
                div()
                    .id("view-toolbar")
                    .role(Role::Toolbar)
                    .test_support()
                    .aria_label("Gallery")
                    // Above the sort menu's backdrop, presses here are the toolbar's alone.
                    .occlude()
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap_1()
                    .p(px(6.))
                    .rounded(theme.radius_lg)
                    .bg(theme.popover)
                    .border_1()
                    .border_color(theme.border)
                    .shadow_lg()
                    .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                    .child(
                        Button::new("open-folder")
                            .ghost()
                            .icon(Icon::new(IconName::FolderOpen))
                            .label("Open")
                            .tooltip("Open a folder")
                            .on_click(cx.listener(|this, _, _, cx| this.choose_folder(cx))),
                    )
                    .child(folders)
                    .child(separator(cx))
                    .child(
                        Button::new("recursive")
                            .ghost()
                            .icon(Icon::new(IconName::ListTree))
                            .label("Recursive")
                            .tooltip(if has_folder {
                                "Recursive browsing"
                            } else {
                                "Open a folder to enable recursive browsing"
                            })
                            .selected(recursive)
                            .toggled(recursive)
                            .disabled(!has_folder)
                            .on_click(cx.listener(move |this, _, _, cx| {
                                this.set_recursive(!recursive, cx);
                            })),
                    )
                    .child(
                        Button::new("comic")
                            .ghost()
                            .icon(Icon::new(IconName::Image))
                            .label("Comic")
                            .tooltip(if has_folder {
                                "Comic grouping"
                            } else {
                                "Open a folder for comic grouping"
                            })
                            .selected(comic)
                            .toggled(comic)
                            .disabled(!has_folder)
                            .on_click(cx.listener(move |this, _, _, cx| {
                                this.set_comic_mode(!comic, cx);
                            })),
                    )
                    .child(sort)
                    .when(sort_mode == GallerySortMode::Random, |this| {
                        this.child(
                            Button::new("shuffle")
                                .ghost()
                                .icon(Icon::new(IconName::Shuffle))
                                .label("Shuffle")
                                .tooltip("Shuffle again")
                                .on_click(cx.listener(|this, _, _, cx| this.shuffle(cx))),
                        )
                    })
                    .child(separator(cx))
                    .child(
                        Button::new("refresh")
                            .ghost()
                            .icon(Icon::new(IconName::RefreshCcw))
                            .label(if refreshing { "Refreshing" } else { "Refresh" })
                            .tooltip("Refresh")
                            .disabled(refreshing || !has_folder)
                            .on_click(cx.listener(|this, _, _, cx| this.refresh(cx))),
                    ),
            )
    }

    /// The sort choices, above the Sort button, the current one checked.
    fn render_sort_menu(
        &self,
        current: GallerySortMode,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let theme = cx.theme();
        div()
            .id("sort-menu")
            .role(Role::Menu)
            .test_support()
            .aria_label("Sort")
            .occlude()
            .absolute()
            .bottom(px(44.))
            .left_0()
            .min_w(px(176.))
            .p_1()
            .flex()
            .flex_col()
            .rounded(theme.radius_lg)
            .bg(theme.popover)
            .border_1()
            .border_color(theme.border)
            .shadow_lg()
            .children(SORT_OPTIONS.map(|(mode, label)| {
                let checked = mode == current;
                div()
                    .id(sort_option_id(mode))
                    .role(Role::MenuItemRadio)
                    .test_support()
                    .aria_label(label)
                    .aria_selected(checked)
                    .flex()
                    .flex_row()
                    .items_center()
                    .justify_between()
                    .h(px(30.))
                    .px_2()
                    .rounded(theme.radius)
                    .text_size(px(13.))
                    .text_color(theme.popover_foreground)
                    .hover(|style| style.bg(theme.accent))
                    .child(label)
                    .child(
                        Icon::new(IconName::Check)
                            .size(px(14.))
                            .text_color(theme.primary)
                            .when(!checked, |icon| icon.invisible()),
                    )
                    .on_click(cx.listener(move |this, _, _, cx| this.set_sort_mode(mode, cx)))
            }))
    }
}
