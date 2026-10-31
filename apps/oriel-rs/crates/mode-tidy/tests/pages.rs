//! Tidy's pages beyond the e2e cases, as GPUI Kit headless UI tests on the same archive: the
//! Library's selection, its grid, its rename field and its menu, Quick Look, the job card's
//! pause and queue, and Settings' encoders. Quick Look and the native menu need a real window,
//! so these check what was asked of them ([`last_quick_look`], [`last_menu`]).

mod support;

use std::path::Path;

use gpui_kit::test::TestWindowExt as _;
use gpui_kit::{AppContext as _, Entity, Focusable as _, Modifiers, TestAppContext};
use oriel_core_tidy::contract::FileId;
use oriel_mode_tidy::{
    LibraryMenu, LibraryMode, LibraryPage, MenuChoice, TidyPage, last_menu, last_quick_look,
};
use oriel_ui::LocalStorage;
use support::*;

fn library(cx: &mut TestAppContext, session: &Session) -> Entity<LibraryPage> {
    cx.read(|cx| session.tidy.read(cx).library().clone())
}

/// The Library's file at `index`, as listed.
fn file_at(cx: &mut TestAppContext, session: &Session, index: usize) -> (FileId, String) {
    let library = library(cx, session);
    cx.read(|cx| {
        let row = library
            .read(cx)
            .table()
            .read(cx)
            .delegate()
            .row(index)
            .cloned()
            .unwrap_or_else(|| panic!("no file at {index}"));
        (row.id, row.abs_path)
    })
}

/// Where `name` is listed.
fn index_of(cx: &mut TestAppContext, session: &Session, name: &str) -> usize {
    let library = library(cx, session);
    cx.read(|cx| {
        let table = library.read(cx).table().read(cx);
        let rows = table.delegate();
        (0..rows.total().unwrap_or(0))
            .find(|index| rows.row(*index).is_some_and(|row| row.name == name))
            .unwrap_or_else(|| panic!("{name} is not listed"))
    })
}

fn selection(cx: &mut TestAppContext, session: &Session) -> Vec<FileId> {
    let library = library(cx, session);
    cx.read(|cx| library.read(cx).selection(cx))
}

fn ids(cx: &mut TestAppContext, session: &Session, indexes: &[usize]) -> Vec<FileId> {
    let mut ids: Vec<FileId> = indexes
        .iter()
        .map(|index| file_at(cx, session, *index).0)
        .collect();
    ids.sort_unstable();
    ids
}

fn click_with(cx: &mut TestAppContext, session: &Session, index: usize, modifiers: Modifiers) {
    cx.update_window(session.handle, |_, window, cx| {
        window.render_frame(cx);
        window.click_with_modifiers(("library-row", index), modifiers, cx);
    })
    .unwrap();
    cx.run_until_parked();
    render(cx, session);
}

/// Puts the Library's cursor on `index`, as a click or an arrow does.
fn put_cursor(cx: &mut TestAppContext, session: &Session, index: usize) {
    let library = library(cx, session);
    cx.update(|cx| {
        library.update(cx, |library, cx| {
            library
                .table()
                .update(cx, |table, cx| table.set_selected_row(index, cx));
        });
    });
    cx.run_until_parked();
    render(cx, session);
}

async fn open_library(cx: &mut TestAppContext, session: &Session) {
    add_archive(cx, session).await;
    go(cx, session, TidyPage::Library);
    settle(cx, session).await;
}

#[gpui_kit::test]
async fn the_library_selects_as_finder_does(cx: &mut TestAppContext) {
    let session = launch(cx, "finder-selection");
    open_library(cx, &session).await;

    // A click selects one file; ⌘ adds another; ⇧ extends from the last one clicked.
    click(cx, &session, ("library-row", 0usize));
    assert_eq!(selection(cx, &session), ids(cx, &session, &[0]));
    let command = Modifiers {
        platform: true,
        ..Modifiers::default()
    };
    click_with(cx, &session, 2, command);
    assert_eq!(selection(cx, &session), ids(cx, &session, &[0, 2]));
    let shift = Modifiers {
        shift: true,
        ..Modifiers::default()
    };
    click_with(cx, &session, 4, shift);
    assert_eq!(selection(cx, &session), ids(cx, &session, &[2, 3, 4]));
    // ⇧↓ goes on from there, and the arrows alone select the one they land on.
    press(cx, &session, "shift-down");
    assert_eq!(selection(cx, &session), ids(cx, &session, &[2, 3, 4, 5]));
    press(cx, &session, "down");
    assert_eq!(selection(cx, &session), ids(cx, &session, &[6]));
    // Esc clears it.
    press(cx, &session, "escape");
    assert_eq!(selection(cx, &session), Vec::<FileId>::new());

    // The header's checkbox takes every matching file.
    click(cx, &session, "library-select-all");
    settle(cx, &session).await;
    assert_eq!(selection(cx, &session).len(), 26);
}

#[gpui_kit::test]
async fn tidy_hands_the_keys_it_is_given_to_the_page_on_screen(cx: &mut TestAppContext) {
    let session = launch(cx, "focus");
    open_library(cx, &session).await;
    let index = index_of(cx, &session, "notes.txt");
    let (_, path) = file_at(cx, &session, index);
    put_cursor(cx, &session, index);

    // As Tidy comes on screen (⌘2) with no focus of its own kept, the shell focuses Tidy, and
    // the page on screen takes the keys from there: Space reaches the Library at once.
    let tidy = session.tidy.clone();
    cx.update_window(session.handle, |_, window, cx| {
        window.blur(cx);
        let focus = tidy.read(cx).focus_handle(cx);
        window.focus(&focus, cx);
    })
    .unwrap();
    cx.run_until_parked();
    render(cx, &session);
    cx.run_until_parked();
    let library = library(cx, &session);
    let focused = cx
        .update_window(session.handle, |_, window, cx| {
            library
                .read(cx)
                .focus_handle(cx)
                .contains_focused(window, cx)
        })
        .unwrap();
    assert!(focused, "the Library has the keys");
    press(cx, &session, "space");
    assert_eq!(last_quick_look().as_deref(), Some(Path::new(&path)));
}

/// The sizes of the files listed, in order.
fn sizes(cx: &mut TestAppContext, session: &Session) -> Vec<i64> {
    let library = library(cx, session);
    cx.read(|cx| {
        let table = library.read(cx).table().read(cx);
        let rows = table.delegate();
        (0..rows.total().unwrap_or(0))
            .filter_map(|index| rows.row(index).map(|row| row.size))
            .collect()
    })
}

#[gpui_kit::test]
async fn the_library_sorts_as_electrons_headers_do(cx: &mut TestAppContext) {
    let session = launch(cx, "sort");
    open_library(cx, &session).await;
    let sort_by = |cx: &mut TestAppContext, column: usize| {
        click(cx, &session, ("icon-sort", column));
    };
    let (size, modified) = (4usize, 5usize);

    // Size starts largest first, and turns around on a second click rather than going back to
    // the catalog's order.
    sort_by(cx, size);
    settle(cx, &session).await;
    let listed = sizes(cx, &session);
    assert_eq!(listed.len(), 26);
    assert!(listed.is_sorted_by(|a, b| a >= b), "{listed:?}");
    sort_by(cx, size);
    settle(cx, &session).await;
    assert!(sizes(cx, &session).is_sorted(), "{:?}", sizes(cx, &session));
    sort_by(cx, size);
    settle(cx, &session).await;
    assert!(sizes(cx, &session).is_sorted_by(|a, b| a >= b));

    // Another column starts on its own first order, newest first for Modified.
    sort_by(cx, modified);
    settle(cx, &session).await;
    let library = library(cx, &session);
    let dates: Vec<i64> = cx.read(|cx| {
        let table = library.read(cx).table().read(cx);
        let rows = table.delegate();
        (0..26)
            .filter_map(|index| rows.row(index).map(|row| row.mtime_ms as i64))
            .collect()
    });
    assert!(dates.is_sorted_by(|a, b| a >= b), "{dates:?}");
}

#[gpui_kit::test]
async fn the_library_shows_as_a_grid_and_remembers_it(cx: &mut TestAppContext) {
    let session = launch(cx, "grid");
    open_library(cx, &session).await;
    click(cx, &session, "library-mode-grid");
    render(cx, &session);
    let library = library(cx, &session);
    assert_eq!(cx.read(|cx| library.read(cx).mode()), LibraryMode::Grid);
    assert_eq!(
        cx.read(|cx| LocalStorage::get(cx, "glazier.library.mode").map(str::to_owned)),
        Some("grid".into())
    );

    // A tile takes clicks as a row does, and ← → move between tiles.
    let (first, _) = file_at(cx, &session, 0);
    click(cx, &session, ("library-tile", first as u64));
    assert_eq!(selection(cx, &session), [first]);
    press(cx, &session, "right");
    assert_eq!(selection(cx, &session), ids(cx, &session, &[1]));
    press(cx, &session, "shift-right");
    assert_eq!(selection(cx, &session), ids(cx, &session, &[1, 2]));
    let label = label(cx, &session, ("library-tile", first as u64));
    assert!(label.is_some(), "the first tile is drawn");
}

#[gpui_kit::test]
async fn return_renames_a_file_in_place(cx: &mut TestAppContext) {
    let session = launch_changing(cx, "rename");
    open_library(cx, &session).await;
    let library = library(cx, &session);
    let index = index_of(cx, &session, "notes.txt");
    put_cursor(cx, &session, index);

    // Esc keeps the name.
    press(cx, &session, "enter");
    assert!(cx.read(|cx| library.read(cx).renaming().is_some()));
    press(cx, &session, "escape");
    assert!(cx.read(|cx| library.read(cx).renaming().is_none()));
    assert!(session.archive.join("notes.txt").is_file());

    // Return edits the name with its stem selected, and Return again renames the file.
    press(cx, &session, "enter");
    cx.update_window(session.handle, |_, window, cx| window.input("readme", cx))
        .unwrap();
    press(cx, &session, "enter");
    wait_for_change(cx, &session).await;
    assert!(cx.read(|cx| library.read(cx).renaming().is_none()));
    assert!(session.archive.join("readme.txt").is_file());
    assert!(!session.archive.join("notes.txt").exists());
}

#[gpui_kit::test]
async fn a_right_click_offers_what_applies_to_the_file(cx: &mut TestAppContext) {
    if !media_ready() {
        return;
    }
    let session = launch(cx, "menu");
    open_library(cx, &session).await;
    let index = index_of(cx, &session, "talk.mov");
    let (id, path) = file_at(cx, &session, index);
    cx.update_window(session.handle, |_, window, cx| {
        window.render_frame(cx);
        window.right_click(("library-row", index), cx);
    })
    .unwrap();
    settle(cx, &session).await;

    // The file right-clicked is selected alone, and the menu offers what it holds: a MOV to
    // move to MP4, a video to re-encode, a soundtrack to remove.
    assert_eq!(selection(cx, &session), [id]);
    let menu = last_menu();
    for line in [
        "Quick Look  Space",
        "Open in View",
        "Convert 1 to AVIF or MP4",
        "Re-encode 1 video as",
        "Rename  ↩",
        "Show only clips",
        "Move to holding  ⌘⌫",
    ] {
        assert!(menu.iter().any(|entry| entry == line), "{line}: {menu:?}");
    }
    assert!(
        menu.iter().any(|entry| entry.starts_with("  AV1")),
        "{menu:?}"
    );

    // Its Quick Look shows that file.
    cx.update_window(session.handle, |_, window, cx| {
        window.dispatch_action(Box::new(LibraryMenu(MenuChoice::QuickLook)), cx);
    })
    .unwrap();
    assert_eq!(last_quick_look().as_deref(), Some(Path::new(&path)));
}

#[gpui_kit::test]
async fn quick_look_shows_a_file_without_deciding_anything(cx: &mut TestAppContext) {
    if !media_ready() {
        return;
    }
    let session = launch(cx, "quick-look");
    open_library(cx, &session).await;
    let index = index_of(cx, &session, "forest.png");
    let (_, path) = file_at(cx, &session, index);
    put_cursor(cx, &session, index);
    press(cx, &session, "space");
    assert_eq!(last_quick_look().as_deref(), Some(Path::new(&path)));

    // In Duplicates, ⌘Y shows the version a key acts on, the suggestion here, and Space does for
    // identical copies; neither decides the set.
    go(cx, &session, TidyPage::Duplicates);
    settle(cx, &session).await;
    click(cx, &session, "scope-exact");
    settle(cx, &session).await;
    click(cx, &session, ("set-row", 0usize));
    let forest = std::fs::canonicalize(session.archive.join("photos/forest.png")).ok();
    let shown = || last_quick_look().and_then(|shown| std::fs::canonicalize(shown).ok());
    press(cx, &session, "cmd-y");
    assert_eq!(shown(), forest);
    press(cx, &session, "space");
    assert_eq!(shown(), forest);
    assert!(!cx.read(|cx| session.state.read(cx).is_busy()));
    assert!(session.archive.join("photos/forest copy.png").is_file());
}

#[gpui_kit::test]
async fn the_job_card_pauses_resumes_and_counts_what_waits(cx: &mut TestAppContext) {
    let session = launch(cx, "job-card");
    add_archive(cx, &session).await;
    let (state, engine) = cx.read(|cx| {
        let state = session.state.read(cx);
        (session.state.clone(), state.engine().cloned().unwrap())
    });
    let root_id = cx.read(|cx| state.read(cx).root_id().unwrap());
    let caption = |cx: &mut TestAppContext| label(cx, &session, "tidy-activity-caption");

    // A rescan paused before its first step keeps its turn, with background analysis behind it.
    cx.update_window(session.handle, |_, window, cx| {
        state.update(cx, |state, cx| {
            state.start_scan(root_id, window, cx);
            state.toggle_pause(cx);
            state.start_background_analysis(root_id, window, cx);
        });
    })
    .unwrap();
    render(cx, &session);
    assert_eq!(caption(cx).as_deref(), Some("Paused"));
    assert_eq!(
        label(cx, &session, "tidy-activity-pause").as_deref(),
        Some("Resume")
    );
    // Read before the app's tasks run again, since the rescan of a scanned folder ends at once.
    cx.update_window(session.handle, |_, window, cx| {
        window.render_frame(cx);
        window.click("tidy-activity-pause", cx);
    })
    .unwrap();
    render(cx, &session);
    assert_eq!(
        label(cx, &session, "tidy-activity-pause").as_deref(),
        Some("Pause")
    );
    settle(cx, &session).await;
    assert!(label(cx, &session, "tidy-activity").is_none(), "all done");

    // Work that waits for its turn says how much more is queued behind it: here behind a scan
    // the card does not show, paused while it holds the turn.
    let blocker = cx.update(|cx| engine.start_scan(root_id, cx));
    blocker.update(cx, |job, cx| job.pause(cx));
    wait_for(cx, &session, "the paused scan to take its turn", |cx| {
        blocker.read(cx).progress().phase().starts_with("Walking ")
    })
    .await;
    cx.update_window(session.handle, |_, window, cx| {
        state.update(cx, |state, cx| {
            state.start_scan(root_id, window, cx);
            state.start_analysis(root_id, window, cx);
        });
    })
    .unwrap();
    wait_for(cx, &session, "the scan to wait", |cx| {
        state
            .read(cx)
            .scan()
            .is_some_and(|scan| scan.job.read(cx).progress().is_waiting())
    })
    .await;
    assert_eq!(caption(cx).as_deref(), Some("1 more queued"));
    // Waiting work has nothing to pause.
    assert!(label(cx, &session, "tidy-activity-pause").is_none());
    blocker.update(cx, |job, cx| job.cancel(cx));
    settle(cx, &session).await;
}

#[gpui_kit::test]
async fn settings_list_the_encoders_when_one_is_missing(cx: &mut TestAppContext) {
    let session = launch(cx, "encoders");
    settle(cx, &session).await;
    // Tidy asks which encoders there are only once Settings shows them.
    assert!(cx.read(|cx| session.state.read(cx).capabilities().is_none()));
    session.harness.update(cx, |harness, cx| {
        harness.settings = true;
        cx.notify();
    });
    wait_for(cx, &session, "the encoders", |cx| {
        session.state.read(cx).capabilities().is_some()
    })
    .await;
    render(cx, &session);
    let summary = label(cx, &session, "tidy-settings-encoders").unwrap();
    let missing = !summary.ends_with("All 8 available");
    let listed =
        |cx: &mut TestAppContext| label(cx, &session, "tidy-settings-encoder-ffmpeg").is_some();
    // Open by itself only when something is missing; a click opens or closes it.
    assert_eq!(listed(cx), missing, "{summary}");
    click(cx, &session, "tidy-settings-encoders");
    assert_eq!(listed(cx), !missing, "{summary}");
}
