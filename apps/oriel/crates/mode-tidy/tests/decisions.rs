//! What stands between a stray press and a file moved: a press outside an open menu or popover only
//! closes it, keys belong to the menu while it is open, an Undo that did not finish is still the
//! next Undo, and a decision with a failed step says so.

mod support;

use std::time::Duration;

use gpui_kit::base::GlobalState;
use gpui_kit::test::TestWindowExt as _;
use gpui_kit::{AppContext as _, TestAppContext};
use oriel_mode_tidy::{TidyPage, last_toast};
use support::*;

/// Past the moment after a new set arrives in which a click on it does nothing.
fn past_the_arming_delay() {
    std::thread::sleep(Duration::from_millis(450));
}

/// The Duplicates page on similar sets, with the ids of the first two versions on the stage.
async fn on_a_set(cx: &mut TestAppContext, session: &Session) -> (u64, u64) {
    add_archive(cx, session).await;
    go(cx, session, TidyPage::Duplicates);
    settle(cx, session).await;
    // A set of stills: a click on a video's picture plays it.
    for index in 0..8usize {
        let stills = cx.read(|cx| {
            let rows = session.tidy.read(cx).duplicates().read(cx).rows();
            rows.len() >= 2 && rows.iter().all(|row| row.file.duration_ms.is_none())
        });
        if stills {
            break;
        }
        click(cx, session, ("set-row", index + 1));
        settle(cx, session).await;
    }
    past_the_arming_delay();
    let ids = stage_ids(cx, session);
    assert!(ids.len() >= 2, "{ids:?}");
    (ids[0], ids[1])
}

fn stage_ids(cx: &mut TestAppContext, session: &Session) -> Vec<u64> {
    cx.read(|cx| {
        session
            .tidy
            .read(cx)
            .duplicates()
            .read(cx)
            .rows()
            .iter()
            .map(|row| row.file.id as u64)
            .collect()
    })
}

fn popup_open(cx: &mut TestAppContext) -> bool {
    cx.read(GlobalState::is_in_deferred_context)
}

fn right_click(cx: &mut TestAppContext, session: &Session, id: (&'static str, u64)) {
    cx.update_window(session.handle, |_, window, cx| {
        window.render_frame(cx);
        window.right_click(id, cx);
    })
    .unwrap();
    cx.run_until_parked();
    render(cx, session);
}

/// The set is still there, and nothing moved.
fn nothing_decided(cx: &mut TestAppContext, session: &Session, stage: &[u64]) {
    assert_eq!(held_files(session), Vec::<String>::new());
    assert_eq!(stage_ids(cx, session), stage);
}

#[gpui_kit::test]
async fn clicking_a_tile_to_close_a_menu_only_closes_it(cx: &mut TestAppContext) {
    if !media_ready() {
        return;
    }
    let session = launch_changing(cx, "press-menu");
    let (first, second) = on_a_set(cx, &session).await;
    let stage = stage_ids(cx, &session);
    click(cx, &session, ("version-menu", first));
    assert!(popup_open(cx), "the menu is open");

    click(cx, &session, ("version", second));
    settle(cx, &session).await;
    assert!(!popup_open(cx), "the press closed it");
    nothing_decided(cx, &session, &stage);

    // That press was the menu's: the next is the owner's.
    click(cx, &session, ("version", second));
    wait_for_change(cx, &session).await;
    assert!(!held_files(&session).is_empty());
}

#[gpui_kit::test]
async fn clicking_a_tile_to_close_a_popover_only_closes_it(cx: &mut TestAppContext) {
    if !media_ready() {
        return;
    }
    let session = launch_changing(cx, "press-popover");
    let (_, second) = on_a_set(cx, &session).await;
    let stage = stage_ids(cx, &session);
    click(cx, &session, "duplicates-matching");
    assert!(popup_open(cx), "the popover is open");
    click(cx, &session, ("version", second));
    settle(cx, &session).await;
    assert!(!popup_open(cx));
    nothing_decided(cx, &session, &stage);
}

#[gpui_kit::test]
async fn clicking_a_tile_to_close_a_right_click_menu_only_closes_it(cx: &mut TestAppContext) {
    if !media_ready() {
        return;
    }
    let session = launch_changing(cx, "press-context");
    let (first, second) = on_a_set(cx, &session).await;
    let stage = stage_ids(cx, &session);
    right_click(cx, &session, ("version", first));
    click(cx, &session, ("version", second));
    settle(cx, &session).await;
    nothing_decided(cx, &session, &stage);
}

/// The same on identical copies' rows, and on another page's button that changes files.
#[gpui_kit::test]
async fn clicking_a_copy_row_to_close_a_menu_only_closes_it(cx: &mut TestAppContext) {
    if !media_ready() {
        return;
    }
    let session = launch_changing(cx, "press-copy");
    add_archive(cx, &session).await;
    go(cx, &session, TidyPage::Duplicates);
    settle(cx, &session).await;
    click(cx, &session, "scope-exact");
    settle(cx, &session).await;
    click(cx, &session, ("set-row", 0usize));
    settle(cx, &session).await;
    past_the_arming_delay();
    let stage = stage_ids(cx, &session);
    click(cx, &session, ("version-menu", stage[0]));
    assert!(popup_open(cx), "the menu is open");
    click(cx, &session, ("version", stage[1]));
    settle(cx, &session).await;
    nothing_decided(cx, &session, &stage);

    click(cx, &session, ("version", stage[1]));
    wait_for_change(cx, &session).await;
    assert!(!held_files(&session).is_empty());
}

#[gpui_kit::test]
async fn clicking_convert_to_close_its_options_only_closes_them(cx: &mut TestAppContext) {
    if !media_ready() {
        return;
    }
    let session = launch_changing(cx, "press-convert");
    add_archive(cx, &session).await;
    go(cx, &session, TidyPage::Convert);
    settle(cx, &session).await;
    click(cx, &session, "convert-options");
    assert!(popup_open(cx), "the menu is open");
    click(cx, &session, "convert-run");
    settle(cx, &session).await;
    assert!(held_files(&session).is_empty(), "nothing converted");
    click(cx, &session, "convert-run");
    wait_for_change(cx, &session).await;
    assert!(cx.read(last_toast).unwrap().starts_with("Converted"));
}

/// A press inside a popover is the popover's, and is not taken for one outside it.
#[gpui_kit::test]
async fn a_press_inside_a_menu_still_works(cx: &mut TestAppContext) {
    if !media_ready() {
        return;
    }
    let session = launch_changing(cx, "press-inside");
    add_archive(cx, &session).await;
    go(cx, &session, TidyPage::Convert);
    settle(cx, &session).await;
    click(cx, &session, "convert-options");
    assert!(popup_open(cx));
    press(cx, &session, "down");
    press(cx, &session, "enter");
    settle(cx, &session).await;
    assert!(!popup_open(cx), "the item ran, and the menu closed");
}

/// Digits, N and Enter while a menu is open are not the page's.
#[gpui_kit::test]
async fn keys_do_not_decide_a_set_under_an_open_menu(cx: &mut TestAppContext) {
    if !media_ready() {
        return;
    }
    let session = launch_changing(cx, "keys-menu");
    let (first, _) = on_a_set(cx, &session).await;
    let stage = stage_ids(cx, &session);
    click(cx, &session, ("version-menu", first));
    assert!(popup_open(cx), "the menu is open");
    for key in ["2", "n", "s"] {
        press(cx, &session, key);
        settle(cx, &session).await;
        assert!(popup_open(cx), "{key} left the menu open");
        nothing_decided(cx, &session, &stage);
    }
    press(cx, &session, "escape");
    settle(cx, &session).await;
    assert!(!popup_open(cx));
    // With it closed, the same key decides.
    past_the_arming_delay();
    press(cx, &session, "2");
    wait_for_change(cx, &session).await;
    assert!(!held_files(&session).is_empty());
}

#[gpui_kit::test]
async fn keys_do_not_decide_a_set_under_an_open_popover(cx: &mut TestAppContext) {
    if !media_ready() {
        return;
    }
    let session = launch_changing(cx, "keys-popover");
    let (_, _) = on_a_set(cx, &session).await;
    let stage = stage_ids(cx, &session);
    click(cx, &session, "duplicates-matching");
    assert!(popup_open(cx), "the popover is open");
    for key in ["2", "n"] {
        press(cx, &session, key);
        settle(cx, &session).await;
        nothing_decided(cx, &session, &stage);
    }
}

/// Keeps the set on screen and moves on, twice, so there are two plans to undo.
async fn two_decisions(cx: &mut TestAppContext, session: &Session) -> (Vec<String>, Vec<String>) {
    add_archive(cx, session).await;
    go(cx, session, TidyPage::Duplicates);
    settle(cx, session).await;
    click(cx, session, "scope-exact");
    settle(cx, session).await;
    click(cx, session, ("set-row", 0usize));
    settle(cx, session).await;
    press(cx, session, "enter");
    wait_for_change(cx, session).await;
    let older = held_files(session);
    assert!(!older.is_empty());
    click(cx, session, "scope-similar");
    settle(cx, session).await;
    press(cx, session, "enter");
    wait_for_change(cx, session).await;
    let newer: Vec<String> = held_files(session)
        .into_iter()
        .filter(|file| !older.contains(file))
        .collect();
    assert!(!newer.is_empty());
    (older, newer)
}

/// A stopped Undo has not finished: the next one is still that plan, not the one before it.
#[gpui_kit::test]
async fn undo_again_after_a_stopped_undo_is_the_same_plan(cx: &mut TestAppContext) {
    if !media_ready() {
        return;
    }
    let session = launch_changing(cx, "undo-stopped");
    let (older, newer) = two_decisions(cx, &session).await;
    cx.update_window(session.handle, |_, window, cx| {
        session.state.update(cx, |state, cx| {
            state.undo_last(window, cx);
            state.stop_change(cx);
        });
    })
    .unwrap();
    wait_for_change(cx, &session).await;

    undo(cx, &session);
    wait_for_change(cx, &session).await;
    let held = held_files(&session);
    assert!(
        older.iter().all(|file| held.contains(file)),
        "the older plan was undone instead"
    );
    assert!(newer.iter().all(|file| !held.contains(file)), "{held:?}");
}

/// One file of the decision cannot move: the owner reads that, not "Kept".
#[cfg(unix)]
#[gpui_kit::test]
async fn a_decision_with_a_failed_step_says_so(cx: &mut TestAppContext) {
    use std::os::unix::fs::PermissionsExt as _;

    if !media_ready() {
        return;
    }
    let session = launch_changing(cx, "failed-step");
    add_archive(cx, &session).await;
    let source = session.archive.join("photos/forest.png");
    for folder in ["fr-a", "fr-b", "fr-c", "fr-d"] {
        let dir = session.archive.join(folder);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::copy(&source, dir.join("fr-copy.png")).unwrap();
    }
    cx.update_window(session.handle, |_, window, cx| {
        session.state.update(cx, |state, cx| {
            let root = state.root_id().unwrap();
            state.start_scan(root, window, cx);
        });
    })
    .unwrap();
    wait_for_change(cx, &session).await;
    go(cx, &session, TidyPage::Duplicates);
    settle(cx, &session).await;
    click(cx, &session, "scope-exact");
    settle(cx, &session).await;
    let position = set_with(cx, &session, "fr-copy.png");
    click(cx, &session, ("set-row", position));
    settle(cx, &session).await;

    let locked = session.archive.join("fr-d");
    std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o555)).unwrap();
    press(cx, &session, "enter");
    wait_for_change(cx, &session).await;
    std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o755)).unwrap();

    let toast = cx.read(last_toast).unwrap();
    assert!(!toast.starts_with("Kept"), "{toast}");
    assert!(toast.starts_with("Resolved"), "{toast}");
    assert!(
        !held_files(&session).is_empty(),
        "the steps that could move did"
    );
    // Its Undo is still there, on ⌘Z as on the toast.
    undo(cx, &session);
    wait_for_change(cx, &session).await;
    assert!(held_files(&session).is_empty());
}
