//! Tidy's sidebar: the folder on screen with its menu, the pages in
//! order under "To do" and "Archive" with their counts, and Holding at the foot. What runs shows
//! in the shell's activity panel, at the window's bottom right.

use std::path::Path;

use gpui_kit::component::menu::PopupMenu;
use gpui_kit::component::{ActiveTheme as _, Icon, WindowExt as _};
use gpui_kit::{
    AnyElement, App, Entity, FontWeight, InteractiveElement as _, IntoElement, ParentElement as _,
    SharedString, StatefulInteractiveElement as _, Styled as _, TestSupportExt as _, Window, div,
    prelude::FluentBuilder as _, px,
};
use oriel_core_domain::format;
use oriel_core_tidy::contract::{OptimizeCategory, Root, Tidy};
use oriel_ui::ModeId;
use oriel_ui::TextRole as _;
use oriel_ui::layout::NavItem;
use oriel_ui::locations::{LocationItem, LocationSwitcher, location_id, shared_locations};

use crate::pages::{PageGroup, TidyPage};
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
    tidy.silent_tracks.files + tidy.cleanup.count()
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
    let tooltip = match page.keys() {
        Some(keys) => oriel_ui::keys::labelled(page.label(), keys),
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
                .text_caption()
                .text_color(cx.theme().muted_foreground)
                .child(count),
        ),
        None => item,
    }
}

fn group_label(label: &'static str, rail: bool, window: &Window, cx: &App) -> AnyElement {
    let theme = cx.theme();
    if rail {
        return div()
            .when(oriel_ui::layout::is_short_rail(window), |this| this.my_1())
            .when(!oriel_ui::layout::is_short_rail(window), |this| this.my_3())
            .h(px(1.))
            .w(px(32.))
            .bg(theme.sidebar_border)
            .into_any_element();
    }
    div()
        .px(px(10.))
        .pt_5()
        .pb(px(6.))
        .text_caption()
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
    let shell = current.shell().read(cx);
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
    menu = menu.separator().item(
        oriel_ui::menu_row(oriel_ui::keys::labelled(
            "Add folder…",
            crate::ADD_FOLDER_KEYS,
        ))
        .on_click(move |_, window, cx| {
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
        oriel_ui::menu_row(oriel_ui::keys::labelled("Rescan", crate::RESCAN_KEYS)).on_click(
            move |_, window, cx| {
                rescan.update(cx, |state, cx| {
                    if let Some(root_id) = state.root_id() {
                        state.start_scan(root_id, window, cx);
                    }
                });
            },
        ),
    )
    .item(
        oriel_ui::menu_row(oriel_ui::keys::REVEAL_LABEL).on_click(move |_, _, cx| {
            cx.reveal_path(Path::new(&path));
        }),
    )
    .separator()
    .item(
        oriel_ui::menu_row(format!("Forget “{name}”…")).on_click(move |_, window, cx| {
            oriel_ui::locations::focus_switcher(window, cx);
            confirm_forget(&forget, root_id, name.clone(), window, cx);
        }),
    )
}

/// Forgetting a folder loses its catalog and undo history, so a sheet says so first.
pub(crate) fn confirm_forget(
    state: &Entity<TidyState>,
    root_id: i64,
    name: String,
    window: &mut Window,
    cx: &mut App,
) {
    let state = state.clone();
    window.open_alert_dialog(cx, move |alert, _, cx| {
        let state = state.clone();
        oriel_ui::dialogs::confirmation(
            alert,
            format!("Forget “{name}”?"),
            "Tidy forgets this folder's catalog and undo history, and moves what it holds for \
             this folder to the Trash. The folder itself is not touched.",
            "Forget",
            true,
            cx,
        )
        .on_ok(move |_, window, cx| {
            state.update(cx, |state, cx| state.forget_root(root_id, window, cx));
            true
        })
    });
}

/// What a page's sidebar item says after its name: how much work it has, or what holding keeps.
fn badge(state: &TidyState, page: TidyPage) -> Option<String> {
    match page {
        TidyPage::Duplicates => {
            let tidy = state.overview()?;
            counted(
                state.duplicate_sets_shown(
                    tidy.duplicates.similar.sets + tidy.duplicates.exact.sets,
                ),
            )
        }
        TidyPage::Convert => counted(convert_count(state.overview()?)),
        TidyPage::CleanUp => counted(cleanup_count(state.overview()?)),
        // What AV1 would save, not a count: shrinking is optional, and Tidy up leaves it out.
        TidyPage::Shrink => state
            .overview()
            .filter(|tidy| tidy.shrink.files > 0)
            .map(|tidy| {
                format!(
                    "~{}",
                    format::bytes((tidy.shrink.bytes - tidy.shrink.estimated_bytes) as f64)
                )
            }),
        TidyPage::Holding => state
            .holding_preview()
            .filter(|holding| holding.total > 0)
            .map(|holding| format::bytes(holding.total_bytes)),
        TidyPage::Overview | TidyPage::Library | TidyPage::History => None,
    }
}

/// The items of the pages in `groups`, in the sidebar's order, each group but the first under
/// its heading.
fn page_items(
    state: &Entity<TidyState>,
    groups: &[PageGroup],
    rail: bool,
    window: &Window,
    cx: &App,
) -> Vec<AnyElement> {
    let current = state.read(cx);
    let mut items = Vec::new();
    let mut last_group = None;
    for page in TidyPage::ALL
        .into_iter()
        .filter(|page| groups.contains(&page.group()))
    {
        let group = page.group();
        if last_group.is_some_and(|last| last != group)
            && let Some(label) = group.label()
        {
            items.push(group_label(label, rail, window, cx));
        }
        last_group = Some(group);
        items.push(nav_item(state, page, badge(current, page), rail, cx).into_any_element());
    }
    items
}

/// The folder's switcher and the pages, below the mode switcher.
pub fn navigation(state: &Entity<TidyState>, rail: bool, window: &Window, cx: &App) -> AnyElement {
    let root = state.read(cx).root().cloned();
    let short_rail = rail && oriel_ui::layout::is_short_rail(window);
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
                .when(short_rail, |this| this.pt_1())
                .when(!short_rail, |this| this.pt_3())
                .when(rail, |this| this.items_center())
                .children(page_items(
                    state,
                    &[PageGroup::Home, PageGroup::ToDo, PageGroup::Archive],
                    rail,
                    window,
                    cx,
                )),
        )
        .into_any_element()
}

/// Holding, above the shell's Settings.
pub fn footer(state: &Entity<TidyState>, rail: bool, window: &mut Window, cx: &App) -> AnyElement {
    div()
        .flex()
        .flex_col()
        .w_full()
        .gap_0p5()
        .when(rail, |this| this.items_center())
        .children(page_items(state, &[PageGroup::Foot], rail, window, cx))
        .into_any_element()
}
