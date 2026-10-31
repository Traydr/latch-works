//! View's top bar, the one Tidy and Sync have (`GalleryHeader.tsx`): the folder's name, once (the
//! owner asked for it alone, rather than beside a "parent / folder" line that named it again);
//! then the scan's status once it is done, what the folder holds, the selection's place, and the
//! folder steps (Parent, Prev Folder, Next Folder) at the toolbar's normal size.

use gpui_kit::assets::IconName;
use gpui_kit::component::{
    ActiveTheme as _, Disableable as _, Icon,
    button::{Button, ButtonVariants as _},
};
use gpui_kit::{
    App, Context, InteractiveElement as _, IntoElement, ParentElement as _, Role, SharedString,
    StatefulInteractiveElement as _, Styled as _, TestSupportExt as _, div, px,
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

        // The scan's status after an error, and for a while after it is done. While it runs it
        // is in the shell's activity panel, with the rest of the app's work.
        let state = catalog.state();
        let ready = state == ScanState::Done
            && catalog
                .finished_at()
                .is_some_and(|finished| finished.elapsed() < READY_STATUS_FOR);
        if root.is_some() && (state == ScanState::Error || ready) {
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
            // Medium, GPUI Kit's normal size: a 32 px target with a 16 px icon, as the sidebar's
            // toggle at the bar's other end. The small ones were too fine a target.
            bar = bar
                .trailing(
                    Button::new("parent-folder")
                        .ghost()
                        .icon(Icon::new(IconName::ArrowUp))
                        .label("Parent")
                        .tooltip("Open the parent folder")
                        .disabled(parent.is_none())
                        .on_click(cx.listener(|this, _, _, cx| this.open_parent_folder(cx))),
                )
                .trailing(
                    Button::new("previous-folder")
                        .ghost()
                        .icon(Icon::new(IconName::ChevronLeft))
                        .label("Prev Folder")
                        .tooltip("Open the previous sibling folder")
                        .disabled(previous.is_none())
                        .on_click(cx.listener(|this, _, _, cx| this.open_sibling_folder(-1, cx))),
                )
                .trailing(
                    Button::new("next-folder")
                        .ghost()
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
