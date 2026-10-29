//! View's top bar, the one Tidy and Sync have (`GalleryHeader.tsx`): the folder's name and where
//! it is ("parent / folder", cut from the start when long so the folder's name stays); then the
//! scan's status, what the folder holds, the selection's place, and the folder steps (Parent,
//! Prev Folder, Next Folder).

use std::path::Path;

use gpui_kit::assets::IconName;
use gpui_kit::component::{
    ActiveTheme as _, Disableable as _, Icon, Sizable as _,
    button::{Button, ButtonVariants as _},
};
use gpui_kit::{
    App, Context, InteractiveElement as _, IntoElement, ParentElement as _, Role, SharedString,
    StatefulInteractiveElement as _, Styled as _, TestSupportExt as _, div,
    prelude::FluentBuilder as _, px,
};
use oriel_ui::TopBar;

use crate::ViewMode;
use crate::browser::Tile;
use crate::catalog::{READY_STATUS_FOR, ScanState};
use crate::gallery::display_name;

/// A neutral pill in the top bar (`lw-badge lw-badge-neutral`), named for tests and VoiceOver by
/// its text.
fn pill(id: &'static str, text: SharedString, cx: &App) -> impl IntoElement {
    let theme = cx.theme();
    div()
        .id(id)
        .role(Role::Status)
        .test_support()
        .aria_label(text.clone())
        .flex_shrink_0()
        .px_2()
        .py(px(2.))
        .rounded_full()
        .bg(theme.muted)
        .text_xs()
        .text_color(theme.muted_foreground)
        .child(text)
}

/// `currentFolderPathLabel`: the folder's parent and its name, "Pictures / 2024", or the name
/// alone for a folder with no parent.
pub(crate) fn folder_caption(folder: &Path) -> String {
    let name = display_name(folder);
    match folder.parent() {
        Some(parent) => format!("{} / {name}", display_name(parent)),
        None => name,
    }
}

impl ViewMode {
    pub(crate) fn render_top_bar(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let catalog = self.catalog.read(cx);
        let gallery = self.gallery.read(cx);
        let root = catalog.root().cloned();
        let title = root
            .as_deref()
            .map(display_name)
            .unwrap_or_else(|| "View".to_string());
        let mut bar = TopBar::new(&self.shell, title);
        if let Some(root) = root.as_deref() {
            bar = bar.meta(folder_caption(root));
        }

        // The scan's status: while it runs, after an error, and for a while after it is done.
        let state = catalog.state();
        let ready = state == ScanState::Done
            && catalog
                .finished_at()
                .is_some_and(|finished| finished.elapsed() < READY_STATUS_FOR);
        if root.is_some() && (state == ScanState::Loading || state == ScanState::Error || ready) {
            let scanning = state == ScanState::Loading;
            let text: SharedString = match catalog.message_path() {
                Some(path) => format!("{}: {path}", catalog.message()).into(),
                None => catalog.message().clone(),
            };
            let theme = cx.theme();
            bar = bar.trailing(
                div()
                    .id("scan-status")
                    .role(Role::Status)
                    .test_support()
                    .aria_label(catalog.message().clone())
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap(px(6.))
                    .min_w_0()
                    .max_w(px(320.))
                    .px_2()
                    .py(px(2.))
                    .rounded_full()
                    .bg(theme.muted)
                    .text_xs()
                    .text_color(theme.muted_foreground)
                    .when(scanning, |this| {
                        this.child(
                            div()
                                .flex_shrink_0()
                                .size(px(6.))
                                .rounded_full()
                                .bg(gpui_kit::rgb(0xf59e0b)),
                        )
                    })
                    .child(div().truncate().child(text)),
            );
        }

        let folders = gallery
            .tiles()
            .iter()
            .filter(|tile| matches!(tile, Tile::Folder { .. }))
            .count();
        let comics = gallery
            .tiles()
            .iter()
            .filter(|tile| matches!(tile, Tile::Comic { .. }))
            .count();
        let items = gallery
            .tiles()
            .iter()
            .filter(|tile| matches!(tile, Tile::Media { .. }))
            .count();
        if root.is_some() {
            if folders > 0 {
                bar = bar.trailing(pill(
                    "gallery-folders",
                    format!("{folders} folders").into(),
                    cx,
                ));
            }
            let count: SharedString = if comics > 0 {
                format!("{comics} comics").into()
            } else {
                format!("{items} items").into()
            };
            bar = bar.trailing(pill("gallery-count", count, cx));
            if let Some(selected) = gallery.selected_index() {
                bar = bar.trailing(pill(
                    "gallery-position",
                    format!("{}/{}", selected + 1, gallery.tiles().len()).into(),
                    cx,
                ));
            }

            let parent = self.parent_folder(cx);
            let previous = self.sibling_folder(-1, cx);
            let next = self.sibling_folder(1, cx);
            bar = bar
                .trailing(
                    Button::new("parent-folder")
                        .ghost()
                        .small()
                        .icon(Icon::new(IconName::ArrowUp))
                        .label("Parent")
                        .tooltip("Open the parent folder")
                        .disabled(parent.is_none())
                        .on_click(cx.listener(|this, _, _, cx| this.open_parent_folder(cx))),
                )
                .trailing(
                    Button::new("previous-folder")
                        .ghost()
                        .small()
                        .icon(Icon::new(IconName::ChevronLeft))
                        .label("Prev Folder")
                        .tooltip("Open the previous sibling folder")
                        .disabled(previous.is_none())
                        .on_click(cx.listener(|this, _, _, cx| this.open_sibling_folder(-1, cx))),
                )
                .trailing(
                    Button::new("next-folder")
                        .ghost()
                        .small()
                        .label("Next Folder")
                        .icon(Icon::new(IconName::ChevronRight))
                        .tooltip("Open the next sibling folder")
                        .disabled(next.is_none())
                        .on_click(cx.listener(|this, _, _, cx| this.open_sibling_folder(1, cx))),
                );
        }
        bar
    }
}
