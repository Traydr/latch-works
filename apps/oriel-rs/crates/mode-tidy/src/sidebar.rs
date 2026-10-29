//! Tidy's sidebar (`components/Sidebar.tsx`): the folder on screen with its menu, the pages in
//! order under "To do" and "Archive" with their counts, and at the foot the running job's card
//! and Holding.

use std::path::Path;

use gpui_kit::assets::IconName;
use gpui_kit::component::button::{Button, ButtonVariant, ButtonVariants as _};
use gpui_kit::component::menu::{DropdownMenu as _, PopupMenuItem};
use gpui_kit::component::progress::Progress;
use gpui_kit::component::spinner::Spinner;
use gpui_kit::component::{ActiveTheme as _, Icon, Sizable as _, WindowExt as _};
use gpui_kit::{
    AnyElement, App, Entity, FontWeight, InteractiveElement as _, IntoElement, ParentElement as _,
    Role, SharedString, StatefulInteractiveElement as _, Styled as _, TestSupportExt as _, Window,
    div, prelude::FluentBuilder as _, px,
};
use oriel_core_tidy::contract::{OptimizeCategory, Root, Tidy};
use oriel_ui::layout::NavItem;

use crate::format;
use crate::pages::TidyPage;
use crate::state::{TidyState, Work};

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

/// The folder on screen, and its menu: the other folders, Add Folder…, Rescan, Show in Finder,
/// Forget.
fn root_switcher(state: &Entity<TidyState>, root: &Root, rail: bool, cx: &App) -> AnyElement {
    let theme = cx.theme();
    let tile = |size: f32, icon: f32| {
        div()
            .flex()
            .flex_shrink_0()
            .items_center()
            .justify_center()
            .size(px(size))
            .rounded(theme.radius)
            .bg(theme.background)
            .border_1()
            .border_color(theme.border)
            .child(Icon::new(IconName::FolderOpen).size(px(icon)))
    };
    let trigger = Button::new("tidy-root-switcher")
        .ghost()
        .accessibility_label(SharedString::from(root.name.clone()))
        .tooltip(SharedString::from(root.path.clone()))
        .map(|button| {
            if rail {
                button.w(px(48.)).h(px(48.)).child(tile(36., 18.))
            } else {
                button.w_full().h(px(52.)).justify_start().child(
                    div()
                        .flex()
                        .flex_row()
                        .items_center()
                        .gap(px(10.))
                        .w_full()
                        .min_w_0()
                        .child(tile(32., 16.))
                        .child(
                            div()
                                .flex()
                                .flex_col()
                                .flex_1()
                                .min_w_0()
                                .items_start()
                                .child(
                                    div()
                                        .w_full()
                                        .truncate()
                                        .text_size(px(13.))
                                        .font_weight(FontWeight::SEMIBOLD)
                                        .child(root.name.clone()),
                                )
                                .child(
                                    div()
                                        .w_full()
                                        .truncate()
                                        .text_xs()
                                        .text_color(theme.muted_foreground)
                                        .child(format!(
                                            "{} · {}",
                                            format::plural(root.file_count, "file"),
                                            format::bytes(root.total_bytes as f64)
                                        )),
                                ),
                        )
                        .child(
                            Icon::new(IconName::ChevronsUpDown)
                                .size(px(14.))
                                .text_color(theme.muted_foreground),
                        ),
                )
            }
        });
    let menu_state = state.clone();
    div()
        .w_full()
        .px_2()
        .when(rail, |this| this.flex().justify_center())
        .child(trigger.dropdown_menu(move |menu, _, cx| {
            let current = menu_state.read(cx);
            let roots: Vec<Root> = current.roots().to_vec();
            let root_id = current.root_id();
            let root = current.root().cloned();
            let mut menu = menu;
            for candidate in roots {
                let target = menu_state.clone();
                let id = candidate.id;
                menu = menu.item(
                    PopupMenuItem::new(candidate.name.clone())
                        .checked(Some(id) == root_id)
                        .on_click(move |_, _, cx| {
                            target.update(cx, |state, cx| state.select_root(id, cx));
                        }),
                );
            }
            let (add, rescan) = (menu_state.clone(), menu_state.clone());
            menu = menu
                .separator()
                .item(
                    PopupMenuItem::new("Add Folder…  ⌘O").on_click(move |_, window, cx| {
                        crate::open_add_folder(&add, window, cx);
                    }),
                )
                .item(
                    PopupMenuItem::new("Rescan  ⌘R").on_click(move |_, window, cx| {
                        rescan.update(cx, |state, cx| {
                            if let Some(root_id) = state.root_id() {
                                state.start_scan(root_id, window, cx);
                            }
                        });
                    }),
                );
            if let Some(root) = root {
                let path = root.path.clone();
                let forget = menu_state.clone();
                let (name, root_id) = (root.name.clone(), root.id);
                menu = menu
                    .item(
                        PopupMenuItem::new("Show in Finder").on_click(move |_, _, cx| {
                            cx.reveal_path(Path::new(&path));
                        }),
                    )
                    .separator()
                    .item(PopupMenuItem::new(format!("Forget “{name}”…")).on_click(
                        move |_, window, cx| {
                            confirm_forget(&forget, root_id, name.clone(), window, cx);
                        },
                    ));
            }
            menu
        }))
        .into_any_element()
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
        .when_some(root, |this, root| {
            this.child(root_switcher(state, &root, rail, cx))
        })
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
        .child(activity(state, rail, cx))
        .child(nav_item(state, TidyPage::Holding, holding, rail, cx))
        .into_any_element()
}

/// The work running, with its progress and Stop; a failed scan or analysis stays until it is
/// dismissed. Nothing shows when idle, nor while the page that started a change shows its own
/// progress.
fn activity(state: &Entity<TidyState>, rail: bool, cx: &App) -> AnyElement {
    let current = state.read(cx);
    let theme = cx.theme();
    let page = current.page();
    let label_of = |progress: &oriel_runtime::JobProgress, name: SharedString| {
        if progress.phase().is_empty() {
            name
        } else {
            progress.phase().clone()
        }
    };
    let work = match current.shown_work(cx) {
        Some(Work::Change) => current.change.as_ref().and_then(|change| {
            let shown_by_page = change
                .source
                .as_deref()
                .is_some_and(|source| source.split(':').next() == Some(page.key()));
            (!shown_by_page).then(|| {
                let progress = change.progress(cx);
                (label_of(&progress, change.name(cx)), progress)
            })
        }),
        Some(Work::Scan) => current.scan().map(|scan| {
            let job = scan.job.read(cx);
            (
                label_of(job.progress(), job.name().clone()),
                job.progress().clone(),
            )
        }),
        Some(Work::Analysis) => current.analysis().map(|analysis| {
            let job = analysis.job.read(cx);
            (
                label_of(job.progress(), job.name().clone()),
                job.progress().clone(),
            )
        }),
        None => None,
    };

    if let Some((label, progress)) = work {
        let (done, total) = (progress.done(), progress.total());
        let paused = progress.is_paused();
        let queued = current.queued_work();
        let stopper = state.clone();
        let stop = Button::new("tidy-activity-stop")
            .ghost()
            .xsmall()
            .icon(Icon::new(IconName::Square))
            .accessibility_label("Stop")
            .tooltip("Stop (finished steps stay done and can be undone)")
            .on_click(move |_, _, cx| {
                stopper.update(cx, |state, cx| state.stop_shown_work(cx));
            });
        let pauser = state.clone();
        let pause = Button::new("tidy-activity-pause")
            .ghost()
            .xsmall()
            .icon(Icon::new(if paused {
                IconName::Play
            } else {
                IconName::Pause
            }))
            .accessibility_label(if paused { "Resume" } else { "Pause" })
            .tooltip(if paused { "Resume" } else { "Pause" })
            .on_click(move |_, _, cx| {
                pauser.update(cx, |state, cx| state.toggle_pause(cx));
            });
        let counts = (total > 0).then(|| {
            format!(
                "{} of {}",
                format::count(done as i64),
                format::count(total as i64)
            )
        });
        let caption: SharedString = if paused {
            "Paused".into()
        } else if queued > 0 {
            format!("{queued} more queued").into()
        } else if progress.is_background() {
            "In the background".into()
        } else {
            "Working…".into()
        };
        if rail {
            return div()
                .id("tidy-activity")
                .test_support()
                .aria_label(label.clone())
                .flex()
                .items_center()
                .justify_center()
                .size(px(48.))
                .child(if paused {
                    Icon::new(IconName::Pause)
                        .text_color(theme.muted_foreground)
                        .into_any_element()
                } else {
                    Spinner::new().small().into_any_element()
                })
                .into_any_element();
        }
        return div()
            .id("tidy-activity")
            .test_support()
            .role(Role::Status)
            .aria_label(label.clone())
            .mx_2()
            .mb_2()
            .p_3()
            .rounded(theme.radius_lg)
            .bg(theme.group_box)
            .border_1()
            .border_color(theme.border)
            .child(
                div()
                    .flex()
                    .flex_row()
                    .items_baseline()
                    .gap_2()
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .truncate()
                            .text_size(px(13.))
                            .font_weight(FontWeight::MEDIUM)
                            .child(label),
                    )
                    .when_some(counts, |this, counts| {
                        this.child(
                            div()
                                .flex_shrink_0()
                                .text_xs()
                                .text_color(theme.muted_foreground)
                                .child(counts),
                        )
                    }),
            )
            .child(
                div().mt_2().child(
                    Progress::new("tidy-activity-progress")
                        .value(if total > 0 {
                            done.min(total) as f32 / total as f32 * 100.
                        } else {
                            0.
                        })
                        .loading(total == 0 && !paused)
                        .when(progress.is_background(), |this| {
                            this.color(theme.muted_foreground)
                        }),
                ),
            )
            .child(
                div()
                    .mt(px(6.))
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap_1()
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .truncate()
                            .text_xs()
                            .text_color(theme.muted_foreground)
                            .child(caption),
                    )
                    .when(!progress.is_waiting() || paused, |this| this.child(pause))
                    .child(stop),
            )
            .into_any_element();
    }

    if let Some(failed) = current.failed_work().cloned() {
        let dismiss = state.clone();
        if rail {
            return Button::new("tidy-activity")
                .ghost()
                .icon(Icon::new(IconName::CircleAlert).text_color(theme.danger))
                .accessibility_label(SharedString::from(format!("{} failed", failed.label)))
                .tooltip(SharedString::from(format!(
                    "{} failed: {}  (click to dismiss)",
                    failed.label, failed.message
                )))
                .on_click(move |_, _, cx| {
                    dismiss.update(cx, |state, cx| state.dismiss_failed_work(cx));
                })
                .into_any_element();
        }
        return div()
            .id("tidy-activity")
            .test_support()
            .role(Role::Status)
            .aria_label(SharedString::from(format!("{} failed", failed.label)))
            .mx_2()
            .mb_2()
            .p_3()
            .rounded(theme.radius_lg)
            .bg(theme.danger.opacity(0.1))
            .text_color(theme.danger)
            .flex()
            .flex_row()
            .items_start()
            .gap_2()
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .text_size(px(13.))
                    .child(
                        div()
                            .font_weight(FontWeight::MEDIUM)
                            .child(format!("{} failed.", failed.label)),
                    )
                    .child(div().opacity(0.8).child(failed.message.clone())),
            )
            .child(
                Button::new("tidy-activity-dismiss")
                    .ghost()
                    .xsmall()
                    .icon(Icon::new(IconName::Close))
                    .accessibility_label("Dismiss")
                    .on_click(move |_, _, cx| {
                        dismiss.update(cx, |state, cx| state.dismiss_failed_work(cx));
                    }),
            )
            .into_any_element();
    }
    div().into_any_element()
}
