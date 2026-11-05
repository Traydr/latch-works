//! A command moves the files it was shown and no others: the file that slides into their place is
//! not a target until the owner chooses it, and in the Library the arrows still go on from there.

mod support;

use std::time::Duration;

use gpui_kit::base::test_support::snapshots;
use gpui_kit::test::TestWindowExt as _;
use gpui_kit::{AppContext as _, ElementId, Entity, Modifiers, TestAppContext};
use oriel_core_tidy::contract::FileId;
use oriel_mode_tidy::{LibraryPage, TidyPage, last_quick_look};
use support::*;

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

/// Whether the row at `index` has been read.
fn row_read(cx: &mut TestAppContext, session: &Session, index: usize) -> bool {
    let library = library(cx, session);
    cx.read(|cx| {
        library
            .read(cx)
            .table()
            .read(cx)
            .delegate()
            .row(index)
            .is_some()
    })
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

/// More than two pages of files, for [`add_files`].
const MANY: usize = 460;

/// Adds `count` files to the archive, whose names say where they belong.
fn add_files(session: &Session, count: usize) {
    let picture = session.archive.join("photos/sunset-small.jpg");
    let folder = session.archive.join("many");
    std::fs::create_dir_all(&folder).unwrap();
    for number in 0..count {
        std::fs::copy(&picture, folder.join(format!("{number:04}.jpg"))).unwrap();
    }
}

fn name_at(cx: &mut TestAppContext, session: &Session, index: usize) -> String {
    let library = library(cx, session);
    cx.read(|cx| {
        library
            .read(cx)
            .table()
            .read(cx)
            .delegate()
            .row(index)
            .unwrap_or_else(|| panic!("no file at {index}"))
            .name
            .clone()
    })
}

/// The row the many files start at, as the archive's own folders sort around them.
fn first_of_many(cx: &mut TestAppContext, session: &Session) -> usize {
    let library = library(cx, session);
    cx.read(|cx| {
        library
            .read(cx)
            .table()
            .read(cx)
            .delegate()
            .loaded_rows()
            .iter()
            .position(|row| row.name == "0000.jpg")
            .expect("the many files sort on the first page")
    })
}

/// Puts the cursor on `index`, wherever it is, and waits for its row.
async fn go_to_row(cx: &mut TestAppContext, session: &Session, index: usize) {
    let library = library(cx, session);
    cx.update(|cx| {
        let table = library.read(cx).table().clone();
        table.update(cx, |table, cx| table.set_selected_row(index, cx));
    });
    wait_for_chosen(cx, session).await;
}

/// Waits until one file is chosen and the cursor's row is that file.
async fn wait_for_chosen(cx: &mut TestAppContext, session: &Session) {
    let library = library(cx, session);
    wait_for(cx, session, "the cursor's file", move |cx| {
        let library = library.read(cx);
        let table = library.table().read(cx);
        table
            .selected_row()
            .and_then(|index| table.delegate().row(index))
            .is_some_and(|row| library.selection(cx) == [row.id])
    })
    .await;
}

/// The name of the file the cursor is on, which is the one selected.
fn chosen_name(cx: &mut TestAppContext, session: &Session) -> String {
    let index = cursor(cx, session).expect("a cursor");
    assert_eq!(selection(cx, session), [id_at(cx, session, index)]);
    name_at(cx, session, index)
}

fn numbered(number: usize) -> String {
    format!("{number:04}.jpg")
}

/// Pressing "Move to holding" again, once the list has read itself again, holds nothing more.
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

/// Esc and the bar's Clear moved no file: the cursor stays on it, so the Inspector still shows it
/// and an arrow goes on from it as usual, by a line in the grid.
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

    // Several chosen, in the list, and cleared from the bar: ↓ does not jump them.
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
    let held_tiles = |cx: &mut TestAppContext| {
        cx.update_window(session.handle, |_, window, cx| {
            window.render_frame(cx);
            snapshots(window)
                .iter()
                .filter_map(|element| match element.path().last() {
                    Some(ElementId::NamedInteger(name, id)) if name == "held" => Some(*id),
                    _ => None,
                })
                .collect::<Vec<_>>()
        })
        .unwrap()
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
    restore(cx, tiles[0]);
    wait_for(cx, &session, "the restore", |_| {
        held_files(&session).len() == 2
    })
    .await;
    render(cx, &session);

    // A press too soon for anyone to have read the tile that came under the pointer. A machine
    // this busy can take longer over it than the wait lasts, when it rightly works.
    let next = held_tiles(cx)[0];
    restore(cx, next);
    let in_time = cx.read(|cx| session.tidy.read(cx).holding().read(cx).armed());
    wait_for_change(cx, &session).await;
    let held = held_files(&session).len();
    if in_time {
        assert_eq!(held, 2, "a second file came back");
    }

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

/// ⌘⌫ pressed twice moves one file; the arrows then choose the next, one at a time, without
/// skipping the file that took the moved one's place, or going back to the top.
#[gpui_kit::test]
async fn the_arrows_go_on_from_a_held_file(cx: &mut TestAppContext) {
    if !media_ready() {
        return;
    }
    let session = launch_changing(cx, "arrows-after-hold");
    open_library(cx, &session).await;
    click(cx, &session, ("library-row", 3usize));
    settle(cx, &session).await;
    let (before, after) = (id_at(cx, &session, 2), id_at(cx, &session, 4));

    press(cx, &session, "secondary-backspace");
    press(cx, &session, "secondary-backspace");
    wait_for_change(cx, &session).await;
    assert_eq!(held_files(&session).len(), 1, "a second file moved");
    assert_eq!(selection(cx, &session), Vec::<FileId>::new());

    press(cx, &session, "down");
    assert_eq!(selection(cx, &session), vec![after]);
    let beyond = id_at(cx, &session, 4);
    press(cx, &session, "secondary-backspace");
    wait_for_change(cx, &session).await;
    assert_eq!(held_files(&session).len(), 2);

    press(cx, &session, "down");
    assert_eq!(selection(cx, &session), vec![beyond]);
    press(cx, &session, "secondary-backspace");
    // Before the list has read itself again, the file on its way is not chosen a second time.
    press(cx, &session, "up");
    assert_eq!(selection(cx, &session), vec![before]);
    wait_for_change(cx, &session).await;
    assert_eq!(held_files(&session).len(), 3);
}

/// An arrow goes on from a moved file to the next one across a page's end, where the next page
/// has not been read: it does not go back to a file already passed.
#[gpui_kit::test]
async fn the_arrow_after_the_last_row_read_goes_on(cx: &mut TestAppContext) {
    if !media_ready() {
        return;
    }
    let session = launch_changing(cx, "arrow-at-page-end");
    add_files(&session, MANY);
    open_library(cx, &session).await;
    let first = first_of_many(cx, &session);
    let number = |index: usize| index - first;
    click(cx, &session, ("library-row", 0usize));
    go_to_row(cx, &session, 199).await;
    assert!(!row_read(cx, &session, 200), "the next page is unread");
    let number_199 = number(199);
    assert_eq!(chosen_name(cx, &session), numbered(number_199));

    press(cx, &session, "secondary-backspace");
    wait_for_change(cx, &session).await;
    press(cx, &session, "down");
    wait_for_chosen(cx, &session).await;
    assert_eq!(chosen_name(cx, &session), numbered(number_199 + 1));

    // The same at the next page's end, the arrow pressed before the list has read itself again.
    go_to_row(cx, &session, 399).await;
    assert!(!row_read(cx, &session, 400), "the next page is unread");
    let name = chosen_name(cx, &session);
    let number_399: usize = name[..4].parse().unwrap();
    press(cx, &session, "secondary-backspace");
    press(cx, &session, "down");
    wait_for_change(cx, &session).await;
    wait_for_chosen(cx, &session).await;
    assert_eq!(chosen_name(cx, &session), numbered(number_399 + 1));
    assert_eq!(cursor(cx, &session), Some(399));
    assert_eq!(held_files(&session).len(), 2);
}

/// ⌘⌫ and an arrow, round after round, past the first page and across pages' ends, both ways: each
/// round moves one file and chooses the next, whether the arrow comes before or after the list has
/// read itself again.
#[gpui_kit::test]
async fn the_arrows_and_hold_keep_their_rhythm_across_pages(cx: &mut TestAppContext) {
    if !media_ready() {
        return;
    }
    let session = launch_changing(cx, "rhythm-across-pages");
    add_files(&session, MANY);
    open_library(cx, &session).await;
    click(cx, &session, ("library-row", 0usize));
    let first = first_of_many(cx, &session);

    // Down, from before the first page's end to past it, the arrow after the list has settled.
    let start = 195;
    go_to_row(cx, &session, start).await;
    let mut held = 0;
    for number in start - first..start - first + 10 {
        assert_eq!(chosen_name(cx, &session), numbered(number));
        press(cx, &session, "secondary-backspace");
        wait_for_change(cx, &session).await;
        held += 1;
        assert_eq!(held_files(&session).len(), held);
        press(cx, &session, "down");
        wait_for_chosen(cx, &session).await;
    }

    // Up, from page 1 across the same end, the arrow before it has read itself again. The files
    // above are the ones not moved yet, from 194 back.
    let at = cursor(cx, &session).unwrap();
    assert_eq!(at, start);
    let mut number = start - first - 1;
    press(cx, &session, "up");
    wait_for_chosen(cx, &session).await;
    for _ in 0..10 {
        assert_eq!(chosen_name(cx, &session), numbered(number));
        press(cx, &session, "secondary-backspace");
        press(cx, &session, "up");
        wait_for_change(cx, &session).await;
        wait_for_chosen(cx, &session).await;
        held += 1;
        assert_eq!(held_files(&session).len(), held);
        number -= 1;
    }

    // Deep in page 1, where the first page's reading again leaves the rows on screen to be read.
    go_to_row(cx, &session, 299).await;
    let name = chosen_name(cx, &session);
    let mut number: usize = name[..4].parse().unwrap();
    for _ in 0..6 {
        assert_eq!(chosen_name(cx, &session), numbered(number));
        press(cx, &session, "secondary-backspace");
        wait_for_change(cx, &session).await;
        held += 1;
        assert_eq!(held_files(&session).len(), held);
        press(cx, &session, "down");
        wait_for_chosen(cx, &session).await;
        assert_eq!(cursor(cx, &session), Some(299));
        number += 1;
    }

    // ↓ before the list reads itself again, then a plain ↓ after: the cursor has followed its file
    // up a row, so the second skips nothing.
    press(cx, &session, "secondary-backspace");
    press(cx, &session, "down");
    wait_for_change(cx, &session).await;
    wait_for_chosen(cx, &session).await;
    held += 1;
    number += 1;
    assert_eq!(held_files(&session).len(), held);
    assert_eq!(chosen_name(cx, &session), numbered(number));
    assert_eq!(cursor(cx, &session), Some(299));
    press(cx, &session, "down");
    wait_for_chosen(cx, &session).await;
    assert_eq!(chosen_name(cx, &session), numbered(number + 1));
    press(cx, &session, "secondary-backspace");
    wait_for_change(cx, &session).await;
    held += 1;

    // The grid, across the first page's end: an arrow from the gap goes one file on, not a line.
    click(cx, &session, "library-mode-grid");
    settle(cx, &session).await;
    click_tile(cx, &session, 0);
    go_to_row(cx, &session, 195).await;
    let name = chosen_name(cx, &session);
    let from: usize = name[..4].parse().unwrap();
    for number in from..from + 8 {
        assert_eq!(chosen_name(cx, &session), numbered(number));
        press(cx, &session, "secondary-backspace");
        wait_for_change(cx, &session).await;
        held += 1;
        assert_eq!(held_files(&session).len(), held);
        press(cx, &session, "down");
        wait_for_chosen(cx, &session).await;
    }
}
