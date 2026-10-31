//! Tidy's sidebar (`components/Sidebar.tsx`): the folder on screen with its menu, the pages in
//! order under "To do" and "Archive" with their counts, and Holding at the foot. What runs shows
//! in the shell's activity panel, at the window's bottom right.

use std::path::Path;

use gpui_kit::component::button::ButtonVariant;
use gpui_kit::component::menu::{PopupMenu, PopupMenuItem};
use gpui_kit::component::{ActiveTheme as _, Icon, WindowExt as _};
use gpui_kit::{
    AnyElement, App, Entity, FontWeight, InteractiveElement as _, IntoElement, ParentElement as _,
    SharedString, StatefulInteractiveElement as _, Styled as _, TestSupportExt as _, Window, div,
    prelude::FluentBuilder as _, px,
};
use oriel_core_tidy::contract::{OptimizeCategory, Root, Tidy};
use oriel_ui::ModeId;
use oriel_ui::layout::NavItem;
use oriel_ui::locations::{LocationItem, LocationSwitcher, location_id, shared_locations};

use crate::format;
use crate::pages::TidyPage;
use crate::state::TidyState;

/// The files Convert would change, without the extension fixes Clean up makes.
pub fn convert_count(tidy: &Tidy) -> i64 {
    tidy.convert
        .categories
        .iter()
        .filter(|entry| {
            !matches!(
                entry.category,
                OptimizeCategory::RenameAvif | OptimizeCategory::RenameMp4
            )
        })
        .map(|entry| entry.files)
        .sum()
}

/// Everything Clean up would do: silent soundtracks, junk, empty folders and wrong extensions.
pub fn cleanup_count(tidy: &Tidy) -> i64 {
    tidy.silent_tracks.files
        + tidy.cleanup.junk
        + tidy.cleanup.empty_folders
        + tidy.cleanup.extensions
}

fn counted(count: i64) -> Option<String> {
    (count > 0).then(|| format::count(count))
}

fn nav_item(
    state: &Entity<TidyState>,
    page: TidyPage,
    count: Option<String>,
    rail: bool,
    cx: &App,
) -> NavItem {
    let current = state.read(cx).page() == page;
    let tooltip = match page.shortcut() {
        Some(shortcut) => format!("{}  {shortcut}", page.label()),
        None => page.label().to_string(),
    };
    let target = state.clone();
    let item = NavItem::new(
        SharedString::from(page.item_id()),
        Icon::new(page.icon()),
        page.label(),
    )
    .rail(rail)
    .current(current)
    .tooltip(tooltip)
    .on_click(move |_, _, cx| target.update(cx, |state, cx| state.go(page, cx)));
    match count {
        Some(count) => item.trailing(
            div()
                .id(SharedString::from(format!("tidy-badge-{}", page.key())))
                .test_support()
                .aria_label(SharedString::from(count.clone()))
                .flex_shrink_0()
                .text_xs()
                .text_color(cx.theme().muted_foreground)
                .child(count),
        ),
        None => item,
    }
}

fn group_label(label: &'static str, rail: bool, cx: &App) -> AnyElement {
    let theme = cx.theme();
    if rail {
        return div()
            .my_3()
            .h(px(1.))
            .w(px(32.))
            .bg(theme.sidebar_border)
            .into_any_element();
    }
    div()
        .px(px(10.))
        .pt_5()
        .pb(px(6.))
        .text_xs()
        .font_weight(FontWeight::MEDIUM)
        .text_color(theme.muted_foreground)
        .child(label)
        .into_any_element()
}

/// The folder on screen and its menu (the location switcher every mode has): Tidy's folders, the
/// folders the other modes use, then Add Folder…, Rescan, Show in Finder and Forget.
fn root_switcher(state: &Entity<TidyState>, root: Option<&Root>, rail: bool) -> AnyElement {
    let menu_state = state.clone();
    let switcher = LocationSwitcher::new(
        root.map_or_else(
            || SharedString::from("No folder yet"),
            |root| SharedString::from(root.name.clone()),
        ),
        move |menu, _, cx| folder_menu(&menu_state, menu, cx),
    )
    .rail(rail);
    match root {
        Some(root) => switcher
            .caption(format!(
                "{} · {}",
                format::plural(root.file_count, "file"),
                format::bytes(root.total_bytes as f64)
            ))
            .tooltip(root.path.clone()),
        None => switcher.caption("Add one to tidy it"),
    }
    .into_any_element()
}

/// The switcher's menu, as it is when it opens.
fn folder_menu(state: &Entity<TidyState>, mut menu: PopupMenu, cx: &App) -> PopupMenu {
    let current = state.read(cx);
    let shell = current.shell.read(cx);
    let root_id = current.root_id();
    for candidate in current.roots() {
        let target = state.clone();
        let id = candidate.id;
        let path = Path::new(&candidate.path);
        let mut modes = shell.modes_using(path).to_vec();
        if !modes.contains(&ModeId::Tidy) {
            modes.insert(0, ModeId::Tidy);
        }
        menu = menu.item(
            LocationItem::new(location_id(path), candidate.name.clone())
                .modes(&modes)
                .into_item()
                .checked(Some(id) == root_id)
                .on_click(move |_, _, cx| {
                    target.update(cx, |state, cx| state.select_root(id, cx));
                }),
        );
    }
    let picker = state.clone();
    menu = shared_locations(
        menu,
        "Tidy one you already use",
        shell.offered_to(ModeId::Tidy),
        move |folder, window, cx| {
            crate::links::offer(&picker, folder.to_path_buf(), window, cx);
        },
    );
    let (add, rescan) = (state.clone(), state.clone());
    menu = menu
        .separator()
        .item(
            PopupMenuItem::new("Add Folder…  ⌘O").on_click(move |_, window, cx| {
                crate::open_add_folder(&add, window, cx);
            }),
        );
    let Some(root) = current.root() else {
        return menu;
    };
    let path = root.path.clone();
    let forget = state.clone();
    let (name, root_id) = (root.name.clone(), root.id);
    menu.item(
        PopupMenuItem::new("Rescan  ⌘R").on_click(move |_, window, cx| {
            rescan.update(cx, |state, cx| {
                if let Some(root_id) = state.root_id() {
                    state.start_scan(root_id, window, cx);
                }
            });
        }),
    )
    .item(
        PopupMenuItem::new("Show in Finder").on_click(move |_, _, cx| {
            cx.reveal_path(Path::new(&path));
        }),
    )
    .separator()
    .item(
        PopupMenuItem::new(format!("Forget “{name}”…")).on_click(move |_, window, cx| {
            confirm_forget(&forget, root_id, name.clone(), window, cx);
        }),
    )
}

/// Forgetting a folder loses its catalog and undo history, so a sheet says so first.
fn confirm_forget(
    state: &Entity<TidyState>,
    root_id: i64,
    name: String,
    window: &mut Window,
    cx: &mut App,
) {
    let state = state.clone();
    window.open_alert_dialog(cx, move |alert, _, _| {
        let state = state.clone();
        alert
            .title(format!("Forget “{name}”?"))
            .description(
                "Tidy forgets this folder's catalog and undo history, and moves what it holds \
                 for this folder to the Trash. The folder itself is not touched.",
            )
            .confirm()
            .ok_text("Forget")
            .ok_variant(ButtonVariant::Danger)
            .cancel_text("Cancel")
            .on_ok(move |_, window, cx| {
                state.update(cx, |state, cx| state.forget_root(root_id, window, cx));
                true
            })
    });
}

/// The folder's switcher and the pages, below the mode switcher.
pub fn navigation(state: &Entity<TidyState>, rail: bool, cx: &App) -> AnyElement {
    let current = state.read(cx);
    let tidy = current.overview.data();
    let root = current.root().cloned();
    let duplicates =
        tidy.and_then(|tidy| counted(tidy.duplicates.similar.sets + tidy.duplicates.exact.sets));
    let convert = tidy.and_then(|tidy| counted(convert_count(tidy)));
    let cleanup = tidy.and_then(|tidy| counted(cleanup_count(tidy)));
    // What AV1 would save, not a count: shrinking is optional, and Tidy up leaves it out.
    let shrink = tidy.filter(|tidy| tidy.shrink.files > 0).map(|tidy| {
        format!(
            "~{}",
            format::bytes((tidy.shrink.bytes - tidy.shrink.estimated_bytes) as f64)
        )
    });
    div()
        .flex()
        .flex_col()
        .w_full()
        .child(root_switcher(state, root.as_ref(), rail))
        .child(
            div()
                .flex()
                .flex_col()
                .w_full()
                .gap_0p5()
                .px_2()
                .pt_3()
                .when(rail, |this| this.items_center())
                .child(nav_item(state, TidyPage::Overview, None, rail, cx))
                .child(group_label("To do", rail, cx))
                .child(nav_item(state, TidyPage::Duplicates, duplicates, rail, cx))
                .child(nav_item(state, TidyPage::Convert, convert, rail, cx))
                .child(nav_item(state, TidyPage::CleanUp, cleanup, rail, cx))
                .child(nav_item(state, TidyPage::Shrink, shrink, rail, cx))
                .child(group_label("Archive", rail, cx))
                .child(nav_item(state, TidyPage::Library, None, rail, cx))
                .child(nav_item(state, TidyPage::History, None, rail, cx)),
        )
        .into_any_element()
}

/// The job running, then Holding, above the shell's Settings.
pub fn footer(state: &Entity<TidyState>, rail: bool, _: &mut Window, cx: &App) -> AnyElement {
    let current = state.read(cx);
    let holding = current
        .holding
        .data()
        .filter(|holding| holding.total > 0)
        .map(|holding| format::bytes(holding.total_bytes));
    div()
        .flex()
        .flex_col()
        .w_full()
        .gap_0p5()
        .when(rail, |this| this.items_center())
        .child(nav_item(state, TidyPage::Holding, holding, rail, cx))
        .into_any_element()
}
