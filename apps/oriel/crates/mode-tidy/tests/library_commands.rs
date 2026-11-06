//! A command moves the files it was shown and no others: the file that slides into their place is
//! not a target until the owner chooses it, and in the Library the arrows still go on from there.

use std::time::Duration;

use crate::support::*;
use gpui_kit::base::test_support::snapshots;
use gpui_kit::test::TestWindowExt as _;
use gpui_kit::{
    AppContext as _, ElementId, Entity, Modifiers, ScrollDelta, TestAppContext, point, px,
};
use oriel_core_tidy::contract::FileId;
use oriel_mode_tidy::{LibraryPage, TidyPage, last_quick_look, last_toast};

fn library(cx: &mut TestAppContext, session: &Session) -> Entity<LibraryPage> {
    cx.read(|cx| session.tidy.read(cx).library().clone())
}

fn selection(cx: &mut TestAppContext, session: &Session) -> Vec<FileId> {
    let library = library(cx, session);
    cx.read(|cx| library.read(cx).selection(cx))
}

fn id_at(cx: &mut TestAppContext, session: &Session, index: usize) -> FileId {
    let library = library(cx, session);
    cx.read(|cx| {
        library
            .read(cx)
            .table()
            .read(cx)
            .delegate()
            .row(index)
            .unwrap_or_else(|| panic!("no file at {index}"))
            .id
    })
}

fn drawn(cx: &mut TestAppContext, session: &Session, id: &'static str) -> bool {
    cx.update_window(session.handle, |_, window, cx| {
        window.render_frame(cx);
        window.try_find(id).is_some()
    })
    .unwrap()
}

/// Presses `id` if it is there, as a click on the same spot would.
fn press_if_drawn(cx: &mut TestAppContext, session: &Session, id: &'static str) {
    if drawn(cx, session, id) {
        click(cx, session, id);
    }
}

fn cursor(cx: &mut TestAppContext, session: &Session) -> Option<usize> {
    let library = library(cx, session);
    cx.read(|cx| library.read(cx).cursor(cx))
}

async fn open_library(cx: &mut TestAppContext, session: &Session) {
    add_archive(cx, session).await;
    go(cx, session, TidyPage::Library);
    settle(cx, session).await;
}

/// The Library with the first tile or row at hand and the Inspector closed, which is when the
/// selection bar shows for one file.
async fn one_chosen_under_the_bar(cx: &mut TestAppContext, session: &Session, grid: bool) {
    open_library(cx, session).await;
    press(cx, session, "i");
    if grid {
        click(cx, session, "library-mode-grid");
        settle(cx, session).await;
        click_tile(cx, session, 0);
    } else {
        click(cx, session, ("library-row", 0usize));
    }
    settle(cx, session).await;
}

/// Clicks the tile of the file at `index`, on the grid's first line, which is on screen.
fn click_tile(cx: &mut TestAppContext, session: &Session, index: usize) {
    let id = id_at(cx, session, index);
    click(cx, session, ("library-tile", id as u64));
}

/// Adds `count` files to the archive, whose names say where they belong.
fn add_files(session: &Session, count: usize) {
    let picture = session.archive.join("photos/sunset-small.jpg");
    let folder = session.archive.join("many");
    std::fs::create_dir_all(&folder).unwrap();
    for number in 0..count {
        std::fs::copy(&picture, folder.join(format!("{number:04}.jpg"))).unwrap();
    }
}

/// Pressing "Move to holding" again, once the list has read itself again, holds nothing more:
/// the file that slid into the place shows as no cursor and is no target. An arrow then goes on
/// from the cursor's place, as it always has.
#[gpui_kit::test]
async fn a_second_press_of_hold_moves_no_other_file(cx: &mut TestAppContext) {
    if !media_ready() {
        return;
    }
    let session = launch_changing(cx, "second-press-hold");
    open_library(cx, &session).await;
    click(cx, &session, ("library-row", 3usize));
    settle(cx, &session).await;
    click_when_drawn(cx, &session, "inspector-hold").await;
    wait_for_change(cx, &session).await;
    assert_eq!(held_files(&session).len(), 1);

    press_if_drawn(cx, &session, "inspector-hold");
    wait_for_change(cx, &session).await;
    assert_eq!(held_files(&session).len(), 1, "a second file moved");
    assert_eq!(cursor(cx, &session), None);
    assert_eq!(selection(cx, &session), Vec::<FileId>::new());

    press(cx, &session, "down");
    assert_eq!(cursor(cx, &session), Some(4));
    assert_eq!(selection(cx, &session), [id_at(cx, &session, 4)]);
}

/// So too in the grid.
#[gpui_kit::test]
async fn a_second_press_in_the_grid_moves_no_other_file(cx: &mut TestAppContext) {
    if !media_ready() {
        return;
    }
    let session = launch_changing(cx, "second-press-grid");
    open_library(cx, &session).await;
    click(cx, &session, "library-mode-grid");
    settle(cx, &session).await;
    click_tile(cx, &session, 3);
    settle(cx, &session).await;
    click_when_drawn(cx, &session, "inspector-hold").await;
    wait_for_change(cx, &session).await;
    assert_eq!(held_files(&session).len(), 1);

    press_if_drawn(cx, &session, "inspector-hold");
    wait_for_change(cx, &session).await;
    assert_eq!(held_files(&session).len(), 1, "a second file moved");
    assert_eq!(selection(cx, &session), Vec::<FileId>::new());

    press(cx, &session, "down");
    assert_eq!(selection(cx, &session).len(), 1);
}

/// A double-click on the selection bar's button, in the list and the grid: it moves the one file,
/// and its second press reaches no file under where the bar was, to select it or open it. (The
/// test platform has no way to open a file, so opening one fails the test.)
async fn double_click_on_the_bar(cx: &mut TestAppContext, test: &str, grid: bool) {
    let session = launch_changing(cx, test);
    one_chosen_under_the_bar(cx, &session, grid).await;
    let spot = centre_of(cx, &session, "selection-hold");

    double_press_at(cx, &session, spot);
    wait_for_change(cx, &session).await;
    assert_eq!(held_files(&session).len(), 1, "a second file moved");
    assert_eq!(selection(cx, &session), Vec::<FileId>::new());
    assert_eq!(cursor(cx, &session), None);
    assert!(!drawn(cx, &session, "selection-hold"));
}

#[gpui_kit::test]
async fn a_double_click_on_the_bar_moves_one_file_in_the_list(cx: &mut TestAppContext) {
    if media_ready() {
        double_click_on_the_bar(cx, "bar-twice-list", false).await;
    }
}

#[gpui_kit::test]
async fn a_double_click_on_the_bar_moves_one_file_in_the_grid(cx: &mut TestAppContext) {
    if media_ready() {
        double_click_on_the_bar(cx, "bar-twice-grid", true).await;
    }
}

/// A press on the bar is the bar's: nothing under it is chosen, so ⌘⌫ after it moves nothing. A
/// press on a file once the owner has had time to look works as usual.
#[gpui_kit::test]
async fn a_press_on_the_bar_chooses_nothing_under_it(cx: &mut TestAppContext) {
    if !media_ready() {
        return;
    }
    let session = launch_changing(cx, "bar-covers");
    open_library(cx, &session).await;
    // The bar shows while the Inspector is closed.
    press(cx, &session, "i");
    click(cx, &session, ("library-row", 3usize));
    cx.update_window(session.handle, |_, window, cx| {
        window.click_with_modifiers(("library-row", 5usize), Modifiers::secondary_key(cx), cx);
    })
    .unwrap();
    settle(cx, &session).await;
    let spot = centre_of(cx, &session, "selection-hold");

    press_at(cx, &session, spot, 1);
    wait_for_change(cx, &session).await;
    assert_eq!(held_files(&session).len(), 2);
    assert_eq!(selection(cx, &session), Vec::<FileId>::new());
    press(cx, &session, "secondary-backspace");
    wait_for_change(cx, &session).await;
    assert_eq!(held_files(&session).len(), 2, "a third file moved");

    // The toast covers where the button was by now, so a row above it stands for the rows.
    std::thread::sleep(Duration::from_millis(550));
    click(cx, &session, ("library-row", 4usize));
    assert_eq!(selection(cx, &session).len(), 1);
}

/// The wheel over the selection bar scrolls the files under it.
#[gpui_kit::test]
async fn the_wheel_over_the_bar_scrolls_the_list(cx: &mut TestAppContext) {
    if !media_ready() {
        return;
    }
    let session = launch_changing(cx, "bar-scrolls");
    one_chosen_under_the_bar(cx, &session, false).await;
    let library = library(cx, &session);
    let scrolled = |cx: &mut TestAppContext| {
        cx.read(|cx| {
            let table = library.read(cx).table().read(cx);
            let offset = table.vertical_scroll_handle.0.borrow().base_handle.offset();
            f32::from(offset.y)
        })
    };
    assert_eq!(scrolled(cx), 0.);
    cx.update_window(session.handle, |_, window, cx| {
        let down = ScrollDelta::Pixels(point(px(0.), px(-200.)));
        window.scroll("library-selection", down, cx);
    })
    .unwrap();
    render(cx, &session);
    assert!(scrolled(cx) < 0., "the list did not scroll");
}

/// Esc in the grid and the bar's Clear moved no file: the cursor stays on it, so the Inspector
/// still shows it and an arrow goes on from it as usual, by a line in the grid.
#[gpui_kit::test]
async fn clearing_the_selection_leaves_the_cursor_where_it_is(cx: &mut TestAppContext) {
    if !media_ready() {
        return;
    }
    let session = launch_changing(cx, "clear-keeps-cursor");
    open_library(cx, &session).await;
    click(cx, &session, "library-mode-grid");
    settle(cx, &session).await;
    click_tile(cx, &session, 0);
    settle(cx, &session).await;
    press(cx, &session, "escape");
    settle(cx, &session).await;
    assert_eq!(selection(cx, &session), Vec::<FileId>::new());
    assert_eq!(cursor(cx, &session), Some(0));
    assert!(drawn(cx, &session, "inspector-hold"));
    let line = cx.update_window(session.handle, |_, window, _| {
        snapshots(window)
            .iter()
            .filter(|element| {
                matches!(
                    element.path().last(),
                    Some(ElementId::NamedInteger(name, _)) if name == "library-tile"
                ) && element.bounds().origin.y < gpui_kit::px(100.)
            })
            .count()
    });
    press(cx, &session, "down");
    assert_eq!(cursor(cx, &session), line.ok());

    // Several chosen in the list and cleared from the bar, which shows with the Inspector closed:
    // ↓ goes on from the cursor.
    press(cx, &session, "i");
    click(cx, &session, "library-mode-list");
    settle(cx, &session).await;
    click(cx, &session, ("library-row", 2usize));
    press(cx, &session, "shift-down");
    press(cx, &session, "shift-down");
    settle(cx, &session).await;
    assert_eq!(selection(cx, &session).len(), 3);
    assert_eq!(cursor(cx, &session), Some(4));
    click(cx, &session, "selection-clear");
    settle(cx, &session).await;
    assert_eq!(selection(cx, &session), Vec::<FileId>::new());
    assert_eq!(cursor(cx, &session), Some(4));
    std::thread::sleep(Duration::from_millis(550));
    press(cx, &session, "down");
    assert_eq!(cursor(cx, &session), Some(5));
    assert_eq!(selection(cx, &session), [id_at(cx, &session, 5)]);

    // A press on a file away from where the bar was works at once.
    press(cx, &session, "shift-down");
    settle(cx, &session).await;
    click(cx, &session, "selection-clear");
    click(cx, &session, ("library-row", 1usize));
    assert_eq!(selection(cx, &session), [id_at(cx, &session, 1)]);
}

/// A press on the activity indicator is its own: the row under it is not chosen, for ⌘⌫ to move.
#[gpui_kit::test]
async fn a_press_on_the_activity_indicator_chooses_no_file(cx: &mut TestAppContext) {
    if !media_ready() {
        return;
    }
    let session = launch_changing(cx, "press-on-activity");
    open_library(cx, &session).await;
    press(cx, &session, "i");
    pause_a_rescan(cx, &session);
    // The indicator shows once the work has gone on for a moment.
    cx.executor().advance_clock(Duration::from_millis(350));
    cx.run_until_parked();
    render(cx, &session);
    let spot = centre_of(cx, &session, "activity-indicator");
    let a_row_under = cx
        .update_window(session.handle, |_, window, _| {
            snapshots(window).iter().any(|element| {
                matches!(
                    element.path().last(),
                    Some(ElementId::NamedInteger(name, _)) if name == "library-row"
                ) && element.bounds().contains(&spot)
            })
        })
        .unwrap();
    assert!(
        a_row_under,
        "a row has to be under the indicator for this to mean anything"
    );
    press_at(cx, &session, spot, 1);
    assert_eq!(selection(cx, &session), Vec::<FileId>::new());
    resume_the_rescan(cx, &session);
    wait_for_change(cx, &session).await;
}

/// A rescan started and paused before its first step, which holds the changes' turn.
fn pause_a_rescan(cx: &mut TestAppContext, session: &Session) {
    let state = session.state.clone();
    cx.update_window(session.handle, |_, window, cx| {
        state.update(cx, |state, cx| {
            let root_id = state.root_id().unwrap();
            state.start_scan(root_id, window, cx);
            let scan = state.scan().unwrap().job.clone();
            scan.update(cx, |job, cx| job.set_paused(true, cx));
        });
    })
    .unwrap();
    cx.run_until_parked();
    render(cx, session);
}

fn resume_the_rescan(cx: &mut TestAppContext, session: &Session) {
    cx.update(|cx| {
        session.state.update(cx, |state, cx| {
            if let Some(scan) = state.scan() {
                let scan = scan.job.clone();
                scan.update(cx, |job, cx| job.set_paused(false, cx));
            }
        });
    });
}

/// Holding's tiles: the next tile's Restore, slid under the pointer, takes no second click.
#[gpui_kit::test]
async fn a_second_click_of_restore_restores_no_other_file(cx: &mut TestAppContext) {
    if !media_ready() {
        return;
    }
    let session = launch_changing(cx, "second-press-restore");
    open_library(cx, &session).await;
    for row in [5usize, 3, 1] {
        click(cx, &session, ("library-row", row));
        settle(cx, &session).await;
        click_when_drawn(cx, &session, "inspector-hold").await;
        wait_for_change(cx, &session).await;
    }
    assert_eq!(held_files(&session).len(), 3);
    go(cx, &session, TidyPage::Holding);
    settle(cx, &session).await;
    // In reading order, so the first is where the next slides in when it goes.
    let held_tiles = |cx: &mut TestAppContext| {
        cx.update_window(session.handle, |_, window, cx| {
            window.render_frame(cx);
            let mut tiles: Vec<_> = snapshots(window)
                .iter()
                .filter_map(|element| match element.path().last() {
                    Some(ElementId::NamedInteger(name, id)) if name == "held" => {
                        let origin = element.bounds().origin;
                        Some(((f32::from(origin.y), f32::from(origin.x)), *id))
                    }
                    _ => None,
                })
                .collect();
            tiles.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap());
            tiles.into_iter().map(|(_, id)| id).collect::<Vec<_>>()
        })
        .unwrap()
    };
    let holds_press_at = |cx: &mut TestAppContext, spot| {
        cx.read(|cx| {
            let holding = session.tidy.read(cx).holding().read(cx);
            holding.holds_press_at(spot)
        })
    };
    // Its button shows while the pointer is on the tile.
    let restore = |cx: &mut TestAppContext, id: u64| {
        cx.update_window(session.handle, |_, window, cx| {
            window.hover(("held", id), cx);
            window.render_frame(cx);
            window.click(("restore-held", id), cx);
        })
        .unwrap();
        cx.run_until_parked();
    };

    let tiles = held_tiles(cx);
    assert_eq!(tiles.len(), 3);
    cx.update_window(session.handle, |_, window, cx| {
        window.hover(("held", tiles[0]), cx);
        window.render_frame(cx);
    })
    .unwrap();
    let where_restored = centre_of(cx, &session, ("restore-held", tiles[0]));
    let elsewhere = centre_of(cx, &session, ("held", tiles[2]));
    let pressed = std::time::Instant::now();
    restore(cx, tiles[0]);
    // The page hears of it after the file has moved, and arms the guard as it says so.
    wait_for(cx, &session, "the restore", |cx| {
        last_toast(cx).is_some_and(|toast| toast.starts_with("Restored"))
    })
    .await;
    assert_eq!(held_files(&session).len(), 2);
    render(cx, &session);
    // Just after, presses wait where the restored tile was, and only there.
    if pressed.elapsed() < Duration::from_millis(500) {
        assert!(holds_press_at(cx, where_restored));
    }
    assert!(!holds_press_at(cx, elsewhere));

    // A press too soon for anyone to have read the tile that came under the pointer, while one
    // on another tile works. A machine this busy can take longer over it than the wait lasts,
    // when it rightly works too.
    let tiles = held_tiles(cx);
    let (next, other) = (tiles[0], tiles[1]);
    cx.update_window(session.handle, |_, window, cx| {
        window.hover(("held", next), cx);
        window.render_frame(cx);
    })
    .unwrap();
    let spot = centre_of(cx, &session, ("restore-held", next));
    let other_tile = centre_of(cx, &session, ("held", other));
    if holds_press_at(cx, spot) {
        assert!(!holds_press_at(cx, other_tile));
    }
    restore(cx, next);
    let in_time = holds_press_at(cx, spot);
    wait_for_change(cx, &session).await;
    let held = held_files(&session).len();
    assert_eq!(held, if in_time { 2 } else { 1 }, "in time: {in_time}");

    // The second press of a double-click slow enough to outlast that does nothing either.
    std::thread::sleep(Duration::from_millis(550));
    let next = held_tiles(cx)[0];
    cx.update_window(session.handle, |_, window, cx| {
        window.hover(("held", next), cx);
        window.render_frame(cx);
    })
    .unwrap();
    let spot = centre_of(cx, &session, ("restore-held", next));
    press_at(cx, &session, spot, 2);
    wait_for_change(cx, &session).await;
    assert_eq!(
        held_files(&session).len(),
        held,
        "a double-click brought one back"
    );

    // Once the owner has had time to see what is there, it works.
    std::thread::sleep(Duration::from_millis(550));
    let next = held_tiles(cx)[0];
    restore(cx, next);
    wait_for_change(cx, &session).await;
    assert_eq!(held_files(&session).len(), held - 1);
}

/// Holding's selection bar: a double-click on its buttons reaches no tile under it, to choose it or
/// show it in Quick Look, and Restore brings back the one file chosen.
#[gpui_kit::test]
async fn a_double_click_on_holdings_bar_reaches_no_tile_under_it(cx: &mut TestAppContext) {
    if !media_ready() {
        return;
    }
    let session = launch_changing(cx, "holding-bar-twice");
    add_files(&session, 40);
    open_library(cx, &session).await;
    click(cx, &session, "library-select-all");
    wait_for(cx, &session, "every file selected", |cx| {
        let library = session.tidy.read(cx).library().read(cx);
        library.selection(cx).len() > 40
    })
    .await;
    press(cx, &session, "secondary-backspace");
    wait_for_change(cx, &session).await;
    go(cx, &session, TidyPage::Holding);
    settle(cx, &session).await;
    let chosen_tiles = |cx: &mut TestAppContext| {
        cx.update_window(session.handle, |_, window, cx| {
            window.render_frame(cx);
            snapshots(window)
                .iter()
                .filter(|element| {
                    matches!(
                        element.path().last(),
                        Some(ElementId::NamedInteger(name, _)) if name == "held"
                    ) && element.selected() == Some(true)
                })
                .count()
        })
        .unwrap()
    };
    let total = held_files(&session).len();
    let top_tile = |cx: &mut TestAppContext| {
        cx.update_window(session.handle, |_, window, cx| {
            window.render_frame(cx);
            snapshots(window)
                .iter()
                .filter_map(|element| match element.path().last() {
                    Some(ElementId::NamedInteger(name, id)) if name == "held" => {
                        Some((f32::from(element.bounds().origin.y), *id))
                    }
                    _ => None,
                })
                .min_by(|a, b| a.0.total_cmp(&b.0))
                .expect("Holding draws tiles")
                .1
        })
        .unwrap()
    };
    let tile = top_tile(cx);
    click(cx, &session, ("held", tile));
    settle(cx, &session).await;
    assert_eq!(chosen_tiles(cx), 1);

    let spot = centre_of(cx, &session, "holding-clear");
    let a_tile_under = cx
        .update_window(session.handle, |_, window, _| {
            snapshots(window).iter().any(|element| {
                matches!(
                    element.path().last(),
                    Some(ElementId::NamedInteger(name, _)) if name == "held"
                ) && element.bounds().contains(&spot)
            })
        })
        .unwrap();
    assert!(
        a_tile_under,
        "a tile has to be under the bar for this to mean anything"
    );
    double_press_at(cx, &session, spot);
    settle(cx, &session).await;
    assert_eq!(chosen_tiles(cx), 0);
    assert_eq!(last_quick_look(), None);
    // A tile away from where the bar was takes a press at once.
    click(cx, &session, ("held", tile));
    assert_eq!(chosen_tiles(cx), 1);

    std::thread::sleep(Duration::from_millis(550));
    click(cx, &session, ("held", tile));
    settle(cx, &session).await;
    let spot = centre_of(cx, &session, "holding-restore");
    double_press_at(cx, &session, spot);
    wait_for_change(cx, &session).await;
    assert_eq!(held_files(&session).len(), total - 1);
    assert_eq!(chosen_tiles(cx), 0);
    assert_eq!(last_quick_look(), None);
}

/// The cursor's row, as the list shows it, and the files a command would act on: the selection,
/// else that row's file.
fn highlight_and_targets(
    cx: &mut TestAppContext,
    session: &Session,
) -> (Option<FileId>, Vec<FileId>) {
    let library = library(cx, session);
    cx.read(|cx| {
        let library = library.read(cx);
        let table = library.table().read(cx);
        let shown = table
            .selected_row()
            .and_then(|index| table.delegate().row(index))
            .map(|row| row.id);
        let selected = library.selection(cx);
        let targets = if selected.is_empty() {
            shown.into_iter().collect()
        } else {
            selected
        };
        (shown, targets)
    })
}

/// Where a file chosen now would be in holding, under its plan's folder.
fn chosen_paths(cx: &mut TestAppContext, session: &Session, ids: &[FileId]) -> Vec<String> {
    let library = library(cx, session);
    cx.read(|cx| {
        let library = library.read(cx);
        let rows = library.table().read(cx).delegate().loaded_rows();
        ids.iter()
            .filter_map(|id| rows.iter().find(|row| row.id == *id))
            .map(|row| {
                if row.dir.is_empty() {
                    row.name.clone()
                } else {
                    format!("{}/{}", row.dir, row.name)
                }
            })
            .collect()
    })
}

/// After a command nothing is a target until the owner chooses a file. Through runs of keys before
/// and after the list reads itself again, some while holds wait their turn: until an arrow, nothing
/// shows as the cursor and the Inspector offers nothing; a row that shows as the cursor is always
/// the target; and a hold takes only files chosen when it was asked for. `ORIEL_LIBRARY_SEEDS`
/// runs more seeds.
#[gpui_kit::test]
async fn after_a_command_only_a_chosen_file_is_a_target(cx: &mut TestAppContext) {
    if !media_ready() {
        return;
    }
    let seeds: u64 = std::env::var("ORIEL_LIBRARY_SEEDS")
        .ok()
        .and_then(|seeds| seeds.parse().ok())
        .unwrap_or(1);
    let session = launch_changing(cx, "only-chosen");
    add_files(&session, 40);
    open_library(cx, &session).await;
    click(cx, &session, ("library-row", 0usize));
    let mut chosen = Vec::new();
    let mut paused = false;
    // Whether the owner has chosen a file since the last command.
    let mut choosing = true;
    for seed in 1..=seeds {
        let mut state = seed.wrapping_mul(0x9e37_79b9_7f4a_7c15) | 1;
        let mut below = |bound: u64| {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            state % bound
        };
        for step in 0..40 {
            let key = below(100);
            match key {
                0..22 => {
                    press(cx, &session, "down");
                    choosing = true;
                }
                22..36 => {
                    press(cx, &session, "up");
                    choosing = true;
                }
                36..56 => {
                    let selected = selection(cx, &session);
                    chosen.extend(chosen_paths(cx, &session, &selected));
                    press(cx, &session, "secondary-backspace");
                    if !selected.is_empty() {
                        choosing = false;
                    }
                }
                56..66 => {
                    let (_, targets) = highlight_and_targets(cx, &session);
                    if drawn(cx, &session, "inspector-hold") {
                        chosen.extend(chosen_paths(cx, &session, &targets));
                        click(cx, &session, "inspector-hold");
                        choosing = false;
                    }
                }
                66..78 => {
                    // The list's Esc takes the selection and the cursor.
                    press(cx, &session, "escape");
                    choosing = false;
                }
                78..86 if !paused => {
                    // A rescan starts only once nothing else runs.
                    wait_for_change(cx, &session).await;
                    pause_a_rescan(cx, &session);
                    paused = true;
                }
                78..86 => {
                    resume_the_rescan(cx, &session);
                    paused = false;
                }
                _ if paused => {}
                _ => wait_for_change(cx, &session).await,
            }
            let (shown, targets) = highlight_and_targets(cx, &session);
            if !choosing {
                assert_eq!(
                    (shown, targets.clone()),
                    (None, Vec::new()),
                    "seed {seed}, step {step}, key {key}: a target before the owner chose one"
                );
            }
            if let Some(shown) = shown {
                assert!(
                    targets.contains(&shown),
                    "seed {seed}, step {step}, key {key}: the cursor shows a file that is no target"
                );
            }
        }
    }
    if paused {
        resume_the_rescan(cx, &session);
    }
    wait_for_change(cx, &session).await;
    let held = held_files(&session);
    assert!(!held.is_empty());
    for path in &held {
        assert!(
            chosen.iter().any(|chosen| path.ends_with(chosen.as_str())),
            "{path} was held but never chosen"
        );
    }
}

/// ⌘⌫, ↑ and ↓ while the hold waits its turn: the cursor comes back to the file on its way, as the
/// list still shows it. ⌘⌫ on it is refused with a reason once its turn comes, and moves nothing
/// else; the cursor then shows no other file as chosen.
#[gpui_kit::test]
async fn a_file_on_its_way_to_holding_is_refused_plainly(cx: &mut TestAppContext) {
    if !media_ready() {
        return;
    }
    let session = launch_changing(cx, "on-its-way");
    open_library(cx, &session).await;
    click(cx, &session, ("library-row", 3usize));
    let going = id_at(cx, &session, 3);
    pause_a_rescan(cx, &session);
    press(cx, &session, "secondary-backspace");
    assert_eq!(cursor(cx, &session), None);
    assert!(!drawn(cx, &session, "inspector-hold"));
    // Space and Return have no file: Quick Look would open one, which the test platform cannot.
    press(cx, &session, "space");
    press(cx, &session, "enter");
    let renaming = library(cx, &session);
    assert_eq!(cx.read(|cx| renaming.read(cx).renaming()), None);
    press(cx, &session, "up");
    press(cx, &session, "down");
    assert_eq!(selection(cx, &session), [going]);
    resume_the_rescan(cx, &session);
    wait_for_change(cx, &session).await;
    // Another file is in its row now: the cursor does not show it.
    let (shown, targets) = highlight_and_targets(cx, &session);
    assert!(shown.is_none_or(|shown| targets.contains(&shown)));

    press(cx, &session, "secondary-backspace");
    wait_for_change(cx, &session).await;
    assert_eq!(held_files(&session).len(), 1);
    assert_eq!(
        cx.read(last_toast).as_deref(),
        Some("Some of these files are no longer in the catalog, so nothing changed.")
    );
}
