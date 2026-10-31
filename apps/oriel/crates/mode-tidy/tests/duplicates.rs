//! Duplicates' version tiles and History's sets marked as not duplicates, on the archive the
//! Tidy cases share (`support`): a similar set's videos play in their tiles, silent, and a
//! click on a video's picture pauses or plays it without keeping the version; "Keep all" is
//! listed in History, read from the catalog, and its Undo there brings the set back to review.

mod support;

use std::time::Duration;

use gpui_kit::TestAppContext;
use oriel_core_tidy::contract::DuplicateDismissal;
use oriel_mode_tidy::{TidyPage, last_toast};
use support::*;

fn playing_tiles(cx: &mut TestAppContext, session: &Session) -> Vec<u64> {
    cx.read(|cx| {
        let duplicates = session.tidy.read(cx).duplicates().read(cx);
        duplicates
            .playing_tiles(cx)
            .into_iter()
            .map(|id| id as u64)
            .collect()
    })
}

fn tile_players(cx: &mut TestAppContext, session: &Session) -> usize {
    cx.read(|cx| session.tidy.read(cx).duplicates().read(cx).tile_players())
}

fn active_key(cx: &mut TestAppContext, session: &Session) -> Option<String> {
    cx.read(|cx| {
        let duplicates = session.tidy.read(cx).duplicates().read(cx);
        duplicates.active().map(|set| set.key.clone())
    })
}

async fn dismissals(cx: &mut TestAppContext, session: &Session) -> Vec<DuplicateDismissal> {
    let (engine, root_id) = cx.read(|cx| {
        let state = session.state.read(cx);
        (state.engine().cloned().unwrap(), state.root_id().unwrap())
    });
    engine.list_dismissals(root_id, 50).await.unwrap()
}

#[gpui_kit::test]
async fn video_versions_play_in_their_tiles_and_a_click_on_one_pauses_it(cx: &mut TestAppContext) {
    if !media_ready() {
        return;
    }
    let session = launch(cx, "tile-videos");
    add_archive(cx, &session).await;
    go(cx, &session, TidyPage::Duplicates);
    settle(cx, &session).await;
    let index = set_with(cx, &session, "with-sound-small.mp4");
    click(cx, &session, ("set-row", index));
    let videos: Vec<u64> = cx.read(|cx| {
        let duplicates = session.tidy.read(cx).duplicates().read(cx);
        let mut ids: Vec<u64> = duplicates
            .rows()
            .iter()
            .filter(|row| row.file.kind == oriel_core_tidy::contract::FileKind::Video)
            .map(|row| row.file.id as u64)
            .collect();
        ids.sort_unstable();
        ids
    });
    assert!(!videos.is_empty());

    // On the stage, every video version plays in its tile, with no press.
    assert_eq!(playing_tiles(cx, &session), videos);
    let kept = kept_names(cx, &session);
    let key = active_key(cx, &session);

    // Past the delay that guards a new set from a double-click, a click on the picture pauses
    // that video and keeps nothing; a second plays it again.
    cx.background_executor
        .timer(Duration::from_millis(500))
        .await;
    let first = videos[0];
    click(cx, &session, ("version-picture", first));
    let playing = playing_tiles(cx, &session);
    assert!(!playing.contains(&first), "{playing:?}");
    assert_eq!(playing.len(), videos.len() - 1);
    assert_eq!(kept_names(cx, &session), kept);
    assert_eq!(
        active_key(cx, &session),
        key,
        "the set is still on the stage"
    );
    click(cx, &session, ("version-picture", first));
    assert_eq!(playing_tiles(cx, &session), videos);

    // The checkbox's chip is its hit target, and checks the box once, as the box itself does.
    let other = cx.read(|cx| {
        let duplicates = session.tidy.read(cx).duplicates().read(cx);
        let kept = duplicates.kept();
        duplicates
            .rows()
            .iter()
            .map(|row| row.file.id)
            .find(|id| !kept.contains(id))
            .unwrap() as u64
    });
    let checked = |cx: &mut TestAppContext| {
        cx.read(|cx| {
            let duplicates = session.tidy.read(cx).duplicates().read(cx);
            duplicates.kept().contains(&(other as i64))
        })
    };
    let before = checked(cx);
    click(cx, &session, ("keep-version-chip", other));
    assert_eq!(checked(cx), !before);
    click(cx, &session, ("keep-version", other));
    assert_eq!(checked(cx), before);

    // Nothing plays under the loupe, whose own player has the sound; closing it plays the
    // tiles again.
    press(cx, &session, "space");
    assert_eq!(tile_players(cx, &session), 0);
    press(cx, &session, "escape");
    assert_eq!(playing_tiles(cx, &session), videos);

    // Another page puts them away.
    go(cx, &session, TidyPage::History);
    assert_eq!(tile_players(cx, &session), 0);
}

#[gpui_kit::test]
async fn keep_all_is_listed_in_history_and_its_undo_brings_the_set_back(cx: &mut TestAppContext) {
    let session = launch_changing(cx, "dismissal-history");
    add_archive(cx, &session).await;
    go(cx, &session, TidyPage::Duplicates);
    settle(cx, &session).await;
    click(cx, &session, "scope-exact");
    settle(cx, &session).await;
    click(cx, &session, ("set-row", 0usize));
    let key = active_key(cx, &session).unwrap();

    // N keeps every copy and marks the set as not duplicates.
    press(cx, &session, "n");
    settle(cx, &session).await;
    assert_eq!(cx.read(last_toast).as_deref(), Some("Kept every copy"));

    // History reads it from the catalog, as it would after a restart.
    let listed = dismissals(cx, &session).await;
    assert_eq!(listed.len(), 1);
    let dismissal = &listed[0];
    assert!(dismissal.exact);
    go(cx, &session, TidyPage::History);
    settle(cx, &session).await;
    let entry = format!("history-dismissal-{}", dismissal.id);
    assert_eq!(
        label(cx, &session, entry.clone()).as_deref(),
        Some("Kept every copy")
    );

    // Its Undo takes the mark back: the entry goes, and the set is back to review.
    click(
        cx,
        &session,
        format!("history-undo-dismissal-{}", dismissal.id),
    );
    settle(cx, &session).await;
    assert_eq!(cx.read(last_toast).as_deref(), Some("Back in Duplicates"));
    assert!(dismissals(cx, &session).await.is_empty());
    assert_eq!(label(cx, &session, entry), None);
    go(cx, &session, TidyPage::Duplicates);
    settle(cx, &session).await;
    let back = cx.read(|cx| {
        let duplicates = session.tidy.read(cx).duplicates().read(cx);
        duplicates.sets().iter().any(|set| set.key == key)
    });
    assert!(back, "the set is in review again");
}
