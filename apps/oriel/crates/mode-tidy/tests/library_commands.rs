//! A command moves the files it was shown and no others: the file that slides into their place is
//! not a target until the owner chooses it, and in the Library the arrows still go on from there.

mod support;

use std::time::Duration;

use gpui_kit::base::test_support::snapshots;
use gpui_kit::test::TestWindowExt as _;
use gpui_kit::{AppContext as _, ElementId, Entity, TestAppContext};
use oriel_core_tidy::contract::FileId;
use oriel_mode_tidy::{LibraryPage, TidyPage};
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

async fn open_library(cx: &mut TestAppContext, session: &Session) {
    add_archive(cx, session).await;
    go(cx, session, TidyPage::Library);
    settle(cx, session).await;
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

/// So too in the grid, and with the selection bar's button.
#[gpui_kit::test]
async fn a_second_press_in_the_grid_moves_no_other_file(cx: &mut TestAppContext) {
    if !media_ready() {
        return;
    }
    let session = launch_changing(cx, "second-press-grid");
    open_library(cx, &session).await;
    click(cx, &session, "library-mode-grid");
    settle(cx, &session).await;
    let tile = cx.update_window(session.handle, |_, window, _| {
        snapshots(window)
            .iter()
            .filter_map(|element| match element.path().last() {
                Some(ElementId::NamedInteger(name, _)) if name == "library-tile" => {
                    Some(element.path().last().unwrap().clone())
                }
                _ => None,
            })
            .nth(3)
    });
    click(cx, &session, tile.unwrap().expect("the grid draws tiles"));
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

    // A press too soon for anyone to have read the tile that came under the pointer.
    let next = held_tiles(cx)[0];
    restore(cx, next);
    wait_for_change(cx, &session).await;
    assert_eq!(held_files(&session).len(), 2, "a second file came back");

    // Once the owner has had time to see what is there, it works.
    std::thread::sleep(Duration::from_millis(450));
    let next = held_tiles(cx)[0];
    restore(cx, next);
    wait_for_change(cx, &session).await;
    assert_eq!(held_files(&session).len(), 1);
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
