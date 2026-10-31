//! Electron Oriel's Tidy cases (its e2e Glazier specs) as GPUI Kit headless UI tests, on
//! a copy of the archive glazier-core's differential suite scans
//! (`apps/oriel/conformance/glazier-core/archive`, dates included). It holds the e2e
//! workbench's files and the Spot variants spec's pages, so its numbers are larger than the
//! specs': 26 files, four similar sets and one identical set.
//!
//! The cases that change files run on the engine's executor, in the temp folder. The scans need
//! libvips and the pinned ffmpeg and ffprobe (`cargo run -p xtask -- vendor`,
//! `fetch-media-tools`); without them a read-side case says so and passes.

mod support;

use std::path::{Path, PathBuf};
use std::time::Duration;

use gpui_kit::TestAppContext;
use oriel_mode_tidy::{TidyPage, last_toast};
use oriel_ui::ModeId;
use support::*;

#[gpui_kit::test]
async fn a_folder_outside_the_sandbox_is_not_offered(cx: &mut TestAppContext) {
    // A data folder outside the temp folder, whose sandbox is the only place Tidy may work.
    let root = PathBuf::from("/private/tmp/oriel-mode-tidy-tests")
        .join(format!("sandbox-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(&root).unwrap();
    let session = launch_in(cx, root, not_yet());
    settle(cx, &session).await;
    // The welcome says where Tidy works, and its picker opens on the sandbox itself, which is
    // not a folder Tidy may tidy: only the folders inside it are.
    click(cx, &session, "choose-folder");
    for _ in 0..10 {
        cx.run_until_parked();
        render(cx, &session);
        cx.background_executor
            .timer(Duration::from_millis(10))
            .await;
    }
    let note = label(cx, &session, "picker-note").expect("the picker says why");
    assert!(note.contains("sandbox"), "{note}");
    assert_eq!(
        label(cx, &session, "picker-choose").as_deref(),
        Some("Choose “sandbox”")
    );
    // The home folder is listed after the sandbox and the temp folder, as unavailable, and
    // clicking it opens nothing.
    assert_eq!(
        label(cx, &session, ("picker-place", 0usize)).as_deref(),
        Some("Sandbox")
    );
    if std::env::var_os("HOME").is_some_and(|home| Path::new(&home).is_dir()) {
        assert_eq!(
            description(cx, &session, ("picker-place", 2usize)).as_deref(),
            Some("Outside the sandbox")
        );
        click(cx, &session, ("picker-place", 2usize));
        assert_eq!(
            label(cx, &session, "picker-choose").as_deref(),
            Some("Choose “sandbox”")
        );
    }
}

#[gpui_kit::test]
async fn a_new_folder_is_scanned_and_overview_lists_what_to_do_with_it(cx: &mut TestAppContext) {
    if !media_ready() {
        return;
    }
    let session = launch(cx, "workbench");
    add_archive(cx, &session).await;
    assert_eq!(
        cx.read(|cx| session.state.read(cx).page()),
        TidyPage::Overview
    );

    let meta = label(cx, &session, "overview-meta").unwrap();
    assert!(meta.starts_with("26 files · "), "{meta}");
    // The copy of with-sound.mp4, left for review rather than Tidy up, and the similar pictures.
    let identical = label(cx, &session, "overview-identical").unwrap();
    assert!(
        identical.starts_with("1 set of identical copies"),
        "{identical}"
    );
    let similar = label(cx, &session, "overview-similar").unwrap();
    assert!(
        similar.starts_with("4 sets of similar versions"),
        "{similar}"
    );
    let silent = label(cx, &session, "overview-step-silent").unwrap();
    assert!(silent.contains("1 video"), "{silent}");
    let cleanup = label(cx, &session, "overview-step-cleanup").unwrap();
    for part in ["1 junk file", "1 empty folder", "1 wrong extension"] {
        assert!(cleanup.contains(part), "{cleanup}");
    }
    assert_eq!(
        description(cx, &session, "overview-step-convert").as_deref(),
        Some("todo")
    );
    // The sidebar counts what each page holds.
    assert_eq!(
        label(cx, &session, "tidy-badge-duplicates").as_deref(),
        Some("5")
    );
    assert_eq!(
        label(cx, &session, "tidy-badge-cleanup").as_deref(),
        Some("4")
    );
}

#[gpui_kit::test]
async fn the_resized_jpeg_is_grouped_with_the_picture_it_came_from(cx: &mut TestAppContext) {
    if !media_ready() {
        return;
    }
    let session = launch(cx, "sunset");
    add_archive(cx, &session).await;
    go(cx, &session, TidyPage::Duplicates);
    settle(cx, &session).await;
    let index = set_with(cx, &session, "sunset.png");
    click(cx, &session, ("set-row", index));

    assert_eq!(kept_names(cx, &session), ["sunset.png"]);
    let decision = cx.read(|cx| session.tidy.read(cx).duplicates().read(cx).decision());
    assert!(
        decision.as_deref().unwrap().starts_with("Keep 1"),
        "{decision:?}"
    );

    // Its checkbox keeps the resized one as well, which keeps both, without deciding the set;
    // ⇧2 takes it back. Nothing changes on disk.
    let small = file_id(cx, &session, "sunset-small.jpg");
    click(cx, &session, ("keep-version", small));
    assert_eq!(kept_names(cx, &session), ["sunset-small.jpg", "sunset.png"]);
    let decision = cx.read(|cx| session.tidy.read(cx).duplicates().read(cx).decision());
    assert_eq!(decision.as_deref(), Some("Keep both"));
    press(cx, &session, "shift-2");
    assert_eq!(kept_names(cx, &session), ["sunset.png"]);
    assert!(session.archive.join("photos/sunset-small.jpg").is_file());
}

#[gpui_kit::test]
async fn silent_tracks_are_told_apart_from_sound(cx: &mut TestAppContext) {
    if !media_ready() {
        return;
    }
    let session = launch(cx, "silent");
    add_archive(cx, &session).await;
    go(cx, &session, TidyPage::Library);
    settle(cx, &session).await;
    click(cx, &session, "library-filter");
    settle(cx, &session).await;

    // The GIF is still an image here; no-audio.mp4 and the silent test patterns lack a track.
    let none = label(cx, &session, "filter-sound-none").unwrap();
    let silent = label(cx, &session, "filter-sound-silent").unwrap();
    let sound = label(cx, &session, "filter-sound-sound").unwrap();
    assert_eq!(none, "No audio track 4");
    assert_eq!(silent, "Silent track 1");
    assert_eq!(sound, "Has sound 5");

    // Choosing one narrows the Library to it.
    click(cx, &session, "filter-sound-silent");
    settle(cx, &session).await;
    let meta = label(cx, &session, "library-meta").unwrap();
    assert!(meta.starts_with("1 of 26 files"), "{meta}");
}

#[gpui_kit::test]
async fn a_video_never_plays_out_of_sight(cx: &mut TestAppContext) {
    if !media_ready() {
        return;
    }
    let session = launch(cx, "video-sight");
    add_archive(cx, &session).await;
    go(cx, &session, TidyPage::Duplicates);
    settle(cx, &session).await;
    let index = set_with(cx, &session, "with-sound-small.mp4");
    click(cx, &session, ("set-row", index));
    let video = |cx: &mut TestAppContext| {
        cx.read(|cx| {
            let duplicates = session.tidy.read(cx).duplicates().read(cx);
            (duplicates.video_file(), duplicates.is_video_playing(cx))
        })
    };

    // Space opens the loupe, and Space again plays the version it shows; → flips to the next,
    // and the first one's player goes, sound and all.
    press(cx, &session, "space");
    press(cx, &session, "space");
    let (playing, _) = video(cx);
    assert!(playing.is_some(), "the loupe plays its video");
    assert_eq!(video(cx), (playing, true));
    press(cx, &session, "right");
    assert_eq!(video(cx), (None, false), "a flip stops the video");

    // Played again, it pauses while another mode is on screen, and is still there, paused, when
    // Tidy comes back.
    press(cx, &session, "space");
    let (playing, _) = video(cx);
    assert!(playing.is_some());
    assert_eq!(video(cx), (playing, true));
    session
        .shell
        .update(cx, |shell, cx| shell.go(ModeId::View, cx));
    cx.run_until_parked();
    assert_eq!(video(cx), (playing, false), "a hidden mode's video pauses");
    session
        .shell
        .update(cx, |shell, cx| shell.go(ModeId::Tidy, cx));
    cx.run_until_parked();
    assert_eq!(video(cx).0, playing);

    // Another page, as Duplicates unmounted, drops it.
    press(cx, &session, "space");
    go(cx, &session, TidyPage::History);
    assert_eq!(video(cx), (None, false), "another page stops the video");
}

#[gpui_kit::test]
async fn spot_variants_moves_sets_of_variants_out_of_review(cx: &mut TestAppContext) {
    if !media_ready() {
        return;
    }
    let session = launch(cx, "variants");
    add_archive(cx, &session).await;
    go(cx, &session, TidyPage::Duplicates);
    settle(cx, &session).await;
    let counts = |cx: &mut TestAppContext| {
        cx.read(|cx| {
            let duplicates = session.tidy.read(cx).duplicates().read(cx);
            duplicates.page().map(|page| page.counts).unwrap()
        })
    };

    // Off, the page's five files are one set that keeps one, and the outfits are another.
    assert_eq!(
        label(cx, &session, "scope-similar").as_deref(),
        Some("Similar 4")
    );
    assert_eq!(label(cx, &session, "scope-variants"), None);

    // Spot variants is one of the matching settings, in the top bar's popover.
    click(cx, &session, "duplicates-matching");
    click(cx, &session, "duplicates-spot-variants");
    settle(cx, &session).await;
    let on = counts(cx);
    // As glazier-core's engine counts them on this archive (`differential.json`): the resized
    // sunset turns out a variant too.
    assert_eq!((on.similar, on.variants), (2, 2), "{on:?}");
    assert_eq!(
        label(cx, &session, "scope-variants").as_deref(),
        Some("Variants 2")
    );

    // The three versions stay, from the folder that holds all of them; the other site's go,
    // each a copy of one of them.
    let index = set_with(cx, &session, "101_jp.png");
    click(cx, &session, ("set-row", index));
    assert_eq!(
        kept_names(cx, &session),
        ["101_clean.png", "101_en.png", "101_jp.png"]
    );
    for name in ["900_p0.jpg", "900_p1.png"] {
        let id = file_id(cx, &session, name);
        let copy_of = description(cx, &session, ("version", id)).unwrap();
        assert!(copy_of.starts_with("Same picture as"), "{name}: {copy_of}");
    }

    // The outfits wait under Variants, every version kept, until Return keeps both and marks
    // them as not duplicates.
    click(cx, &session, "scope-variants");
    settle(cx, &session).await;
    let index = set_with(cx, &session, "outfit-a.png");
    click(cx, &session, ("set-row", index));
    assert_eq!(kept_names(cx, &session), ["outfit-a.png", "outfit-b.png"]);
    let decision = cx.read(|cx| session.tidy.read(cx).duplicates().read(cx).decision());
    assert_eq!(decision.as_deref(), Some("Keep both"));
    press(cx, &session, "enter");
    settle(cx, &session).await;
    assert_eq!(
        cx.read(last_toast).as_deref(),
        Some("Marked as not duplicates")
    );
    assert_eq!(counts(cx).dismissed, 1);
    assert_eq!(counts(cx).variants, 1);
}

// The cases that change files.

#[gpui_kit::test]
async fn return_keeps_the_suggested_copy_and_moves_on_and_undo_brings_the_set_back(
    cx: &mut TestAppContext,
) {
    let session = launch_changing(cx, "keep");
    add_archive(cx, &session).await;
    go(cx, &session, TidyPage::Duplicates);
    settle(cx, &session).await;
    click(cx, &session, "scope-exact");
    settle(cx, &session).await;
    click(cx, &session, ("set-row", 0usize));
    // The copy-style names lose to the original.
    assert_eq!(kept_names(cx, &session), ["forest.png"]);

    press(cx, &session, "enter");
    wait_for_change(cx, &session).await;
    assert_eq!(cx.read(last_toast).as_deref(), Some("Kept forest.png"));
    let copies = [
        session.archive.join("dup/forest (1).png"),
        session.archive.join("photos/forest copy.png"),
    ];
    assert!(copies.iter().all(|copy| !copy.exists()));

    undo(cx, &session);
    wait_for_change(cx, &session).await;
    assert!(copies.iter().all(|copy| copy.is_file()));
    // The set is back in the queue, in focus.
    assert_eq!(kept_names(cx, &session), ["forest.png"]);
}

#[gpui_kit::test]
async fn convert_turns_stills_into_avif_and_video_into_mp4_keeping_dates(cx: &mut TestAppContext) {
    let session = launch_changing(cx, "convert");
    add_archive(cx, &session).await;
    go(cx, &session, TidyPage::Convert);
    settle(cx, &session).await;
    click(cx, &session, "convert-run");
    wait_for_change(cx, &session).await;
    assert!(cx.read(last_toast).unwrap().starts_with("Converted"));
    for converted in [
        "clips/talk.mp4",
        "clips/scene.mp4",
        "clips/loop.mp4",
        "clips/odd.mp4",
    ] {
        assert!(session.archive.join(converted).is_file(), "{converted}");
    }
    // The similar pictures wait for review, so they stay as they are.
    assert!(session.archive.join("photos/sunset.png").is_file());
    assert_eq!(
        label(cx, &session, "convert-empty").as_deref(),
        Some("Everything is AVIF or MP4")
    );
}

#[gpui_kit::test]
async fn clean_up_fixes_the_extension_holds_the_junk_and_removes_the_empty_folder(
    cx: &mut TestAppContext,
) {
    let session = launch_changing(cx, "cleanup");
    add_archive(cx, &session).await;
    go(cx, &session, TidyPage::CleanUp);
    settle(cx, &session).await;
    click(cx, &session, "cleanup-run-all");
    wait_for_change(cx, &session).await;
    assert!(cx.read(last_toast).unwrap().starts_with("Cleaned up"));
    assert!(session.archive.join("photos/cover.avif").is_file());
    assert!(!session.archive.join("empty").exists());
    assert!(
        held_files(&session)
            .iter()
            .any(|held| held.ends_with("._sunset.png"))
    );
    assert_eq!(
        label(cx, &session, "cleanup-empty").as_deref(),
        Some("Nothing to clean up")
    );
}

#[gpui_kit::test]
async fn tidy_up_runs_every_step_but_duplicates_as_one_change_and_one_undo_takes_it_back(
    cx: &mut TestAppContext,
) {
    let session = launch_changing(cx, "tidy-up");
    add_archive(cx, &session).await;
    click(cx, &session, "overview-tidy-up");
    wait_for_change(cx, &session).await;
    assert!(cx.read(last_toast).unwrap().starts_with("Tidied up"));
    assert!(session.archive.join("photos/cover.avif").is_file());
    assert!(!session.archive.join("empty").exists());
    // Duplicates are not a step: the identical copy waits for review.
    assert!(session.archive.join("dup/with-sound-copy.mp4").is_file());

    undo(cx, &session);
    wait_for_change(cx, &session).await;
    assert!(cx.read(last_toast).unwrap().starts_with("Undid"));
    for original in [
        "._sunset.png",
        "clips/talk.mov",
        "photos/cover.jpg",
        "empty",
    ] {
        assert!(session.archive.join(original).exists(), "{original}");
    }
}

#[gpui_kit::test]
async fn shrink_re_encodes_a_busy_video_to_av1_and_undo_restores_it(cx: &mut TestAppContext) {
    let session = launch_changing(cx, "shrink");
    add_archive(cx, &session).await;
    go(cx, &session, TidyPage::Shrink);
    settle(cx, &session).await;
    click(cx, &session, "shrink-batch-all");
    click(cx, &session, "shrink-run");
    wait_for_change(cx, &session).await;
    assert!(cx.read(last_toast).unwrap().starts_with("Shrank"));
    undo(cx, &session);
    wait_for_change(cx, &session).await;
    assert!(cx.read(last_toast).unwrap().starts_with("Undid"));
}

#[gpui_kit::test]
async fn changes_say_they_are_not_available_yet(cx: &mut TestAppContext) {
    if !media_ready() {
        return;
    }
    let session = launch(cx, "not-yet");
    add_archive(cx, &session).await;
    // Tidy up runs through the seam, which answers that the executor is not in yet; nothing on
    // disk changes, and the ring goes once the change has failed.
    click(cx, &session, "overview-tidy-up");
    wait_for_change(cx, &session).await;
    assert_eq!(cx.read(last_toast).as_deref(), Some("That didn't work"));
    assert!(session.archive.join("photos/cover.jpg").is_file());
    let activity = cx.read(|cx| session.shell.read(cx).activity(ModeId::Tidy));
    assert_eq!(activity, None);
}

#[gpui_kit::test]
async fn spot_variants_keeps_each_picture_once(cx: &mut TestAppContext) {
    let session = launch_changing(cx, "variants-keep");
    add_archive(cx, &session).await;
    go(cx, &session, TidyPage::Duplicates);
    settle(cx, &session).await;
    click(cx, &session, "duplicates-matching");
    click(cx, &session, "duplicates-spot-variants");
    settle(cx, &session).await;
    let index = set_with(cx, &session, "101_jp.png");
    click(cx, &session, ("set-row", index));

    // Return keeps the three versions from the folder that holds them all; the other site's
    // copies go to holding, and the versions kept are remembered as not duplicates.
    press(cx, &session, "enter");
    wait_for_change(cx, &session).await;
    assert_eq!(cx.read(last_toast).as_deref(), Some("Kept 3 versions"));
    assert!(!session.archive.join("pages/pixiv/900_p0.jpg").exists());
    assert!(!session.archive.join("pages/pixiv/900_p1.png").exists());
    for name in ["101_jp.png", "101_en.png", "101_clean.png"] {
        assert!(
            session.archive.join("pages/fanbox").join(name).is_file(),
            "{name}"
        );
    }
    let dismissed = cx.read(|cx| {
        let duplicates = session.tidy.read(cx).duplicates().read(cx);
        duplicates.page().map(|page| page.counts.dismissed)
    });
    assert_eq!(dismissed, Some(1));
}
