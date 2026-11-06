//! Electron Oriel's Tidy cases (its e2e Glazier specs) as GPUI Kit headless UI tests, on the
//! archive `oriel-test-archive` builds for each case: glazier-core's differential archive, drawn
//! and encoded at test time. It holds the e2e workbench's files and the Spot variants spec's
//! pages, so its numbers are larger than the specs': 26 files, four similar sets and one
//! identical set.
//!
//! The cases that change files run on the engine's executor, in the temp folder. The archive's
//! clips and the scans need libvips and the pinned ffmpeg and ffprobe (`cargo run -p xtask --
//! vendor`, `fetch-media-tools`); without them a read-side case says so and passes.

use std::path::{Path, PathBuf};

use crate::support::*;
use gpui_kit::test::TestWindowExt as _;
use gpui_kit::{AppContext as _, TestAppContext};
use oriel_core_tidy::contract::{FileFilter, FileQuery, FileSortColumn};
use oriel_mode_tidy::{TidyPage, last_toast};
use oriel_ui::ModeId;

#[gpui_kit::test]
async fn a_folder_outside_the_sandbox_is_not_offered(cx: &mut TestAppContext) {
    // A data folder outside the temp folder, whose sandbox is the only place Tidy may work.
    let outside_temp = if cfg!(windows) {
        PathBuf::from(env!("CARGO_TARGET_TMPDIR"))
    } else {
        PathBuf::from("/private/tmp")
    };
    let root = outside_temp
        .join("oriel-mode-tidy-tests")
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
        tick(cx);
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
        similar.starts_with("3 sets of similar versions"),
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
        Some("4")
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
    // Held down, it repeats, and a repeat changes nothing.
    // What a US keyboard sends for ⇧2: the symbol, with ⇧ cleared.
    let shift_2 = "@";
    let repeat = gpui_kit::KeyDownEvent {
        keystroke: gpui_kit::Keystroke::parse(shift_2).unwrap(),
        is_held: true,
        prefer_character_input: false,
    };
    cx.update_window(session.handle, |_, window, cx| {
        window.dispatch_event(gpui_kit::PlatformInput::KeyDown(repeat), cx);
    })
    .unwrap();
    assert_eq!(kept_names(cx, &session), ["sunset-small.jpg", "sunset.png"]);
    press(cx, &session, shift_2);
    assert_eq!(kept_names(cx, &session), ["sunset.png"]);
    assert!(session.archive.join("photos/sunset-small.jpg").is_file());

    // The first → moves on from the suggestion, to the version after it.
    let target = |cx: &mut TestAppContext| {
        cx.read(|cx| session.tidy.read(cx).duplicates().read(cx).target())
    };
    assert_eq!(target(cx), 0);
    press(cx, &session, "right");
    assert_eq!(target(cx), 1);
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

    // Spot variants is on from the start: the outfits wait under Variants, and the resized sunset
    // is a copy of the sunset.
    let on = counts(cx);
    assert_eq!((on.similar, on.variants), (3, 1), "{on:?}");
    assert_eq!(
        label(cx, &session, "scope-variants").as_deref(),
        Some("Variants 1")
    );

    // It is one of the matching settings, in the top bar's popover. Off, the page's five files
    // are one set that keeps one, and the outfits are another.
    click(cx, &session, "duplicates-matching");
    click(cx, &session, "duplicates-spot-variants");
    settle(cx, &session).await;
    assert_eq!(
        label(cx, &session, "scope-similar").as_deref(),
        Some("Similar 4")
    );
    assert_eq!(label(cx, &session, "scope-variants"), None);
    click(cx, &session, "duplicates-spot-variants");
    settle(cx, &session).await;
    assert_eq!(counts(cx).variants, 1);

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
    assert_eq!(counts(cx).variants, 0);
}

// The cases that change files.

/// ⌘Z while a Keep is still on its way means that Keep. Answering at once would take back something
/// older: the last decision on the list, or the newest plan in the journal.
#[gpui_kit::test]
async fn undo_with_a_change_under_way_waits_and_takes_back_that_change(cx: &mut TestAppContext) {
    let session = launch_changing(cx, "undo-waits");
    add_archive(cx, &session).await;
    go(cx, &session, TidyPage::Duplicates);
    settle(cx, &session).await;
    click(cx, &session, "scope-exact");
    settle(cx, &session).await;
    click(cx, &session, ("set-row", 0usize));
    assert_eq!(kept_names(cx, &session), ["forest.png"]);
    press(cx, &session, "enter");
    wait_for_change(cx, &session).await;
    let older = session.archive.join("photos/forest copy.png");
    assert!(!older.exists());

    click(cx, &session, "scope-similar");
    settle(cx, &session).await;
    click(cx, &session, ("set-row", 0usize));
    settle(cx, &session).await;
    let going: Vec<PathBuf> = cx.read(|cx| {
        let duplicates = session.tidy.read(cx).duplicates().read(cx);
        let kept = duplicates.kept();
        duplicates
            .rows()
            .iter()
            .filter(|row| !kept.contains(&row.file.id))
            .map(|row| PathBuf::from(&row.file.abs_path))
            .collect()
    });
    assert!(!going.is_empty());

    // The same moment: nothing of the Keep has landed when ⌘Z comes.
    cx.update_window(session.handle, |_, window, cx| {
        window.press("enter", cx);
        window.dispatch_action(Box::new(oriel_ui::commands::UndoChange), cx);
    })
    .unwrap();
    wait_for(cx, &session, "the waiting undo", |cx| {
        last_toast(cx).is_some_and(|toast| toast.starts_with("Undid"))
    })
    .await;
    wait_for_change(cx, &session).await;
    assert!(cx.read(last_toast).unwrap().starts_with("Undid “Kept "));
    assert!(going.iter().all(|path| path.is_file()), "{going:?}");
    assert!(!older.exists(), "the older decision stands");
}

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
    // Named as the toast it undid named it, not by the plan's title.
    assert_eq!(cx.read(last_toast).as_deref(), Some("Undid “Kept 1 of 3”"));
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
    // Members of open duplicate sets are converted like any other file.
    assert!(session.archive.join("photos/sunset.avif").is_file());
    assert!(session.archive.join("photos/forest copy.avif").is_file());
    assert_eq!(
        label(cx, &session, "convert-empty").as_deref(),
        Some("Nothing left to convert")
    );
}

#[gpui_kit::test]
async fn a_set_open_in_duplicates_follows_a_change_and_keeps_what_the_owner_chose(
    cx: &mut TestAppContext,
) {
    let session = launch_changing(cx, "open-set");
    add_archive(cx, &session).await;
    go(cx, &session, TidyPage::Duplicates);
    settle(cx, &session).await;
    let index = set_with(cx, &session, "101_en.png");
    click(cx, &session, ("set-row", index));
    let duplicates = cx.read(|cx| session.tidy.read(cx).duplicates().clone());
    let suggested = cx.read(|cx| duplicates.read(cx).kept().len());
    duplicates.update(cx, |page, cx| page.toggle_keep(1, cx));
    let (key, kept) = cx.read(|cx| {
        let page = duplicates.read(cx);
        (page.active().map(|set| set.key.clone()), page.kept())
    });
    assert!(key.is_some());
    assert_eq!(kept.len(), suggested + 1, "the owner keeps another version");

    // The change runs with the set on screen.
    go(cx, &session, TidyPage::Convert);
    settle(cx, &session).await;
    click(cx, &session, "convert-run");
    go(cx, &session, TidyPage::Duplicates);
    wait_for_change(cx, &session).await;
    settle(cx, &session).await;
    render(cx, &session);

    // The same set, with the same choice, and only files that are there.
    let (now_key, now_kept, names) = cx.read(|cx| {
        let page = duplicates.read(cx);
        let names: Vec<String> = page
            .rows()
            .iter()
            .map(|row| row.file.rel_path.clone())
            .collect();
        (page.active().map(|set| set.key.clone()), page.kept(), names)
    });
    assert_eq!(now_key, key);
    assert_eq!(now_kept, kept);
    assert!(
        names.iter().any(|name| name.ends_with("101_en.avif")),
        "{names:?}"
    );
    for name in names {
        assert!(session.archive.join(&name).is_file(), "{name}");
    }
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
    // Duplicates are not a step: the identical copy is not removed.
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

/// Grows a file behind Tidy's back and undoes the change that wrote it, which cannot then finish.
/// Only a scan can tell the catalog the file's new size, so it says whether one ran.
async fn undo_with_a_file_grown(cx: &mut TestAppContext, session: &Session, rel: &str) {
    let output = session.archive.join(rel);
    let mut grown = std::fs::read(&output).unwrap();
    grown.extend_from_slice(b"changed since");
    std::fs::write(&output, &grown).unwrap();
    undo(cx, session);
    wait_for_change(cx, session).await;
    let toast = cx.read(last_toast).unwrap();
    assert!(toast.starts_with("Undo did not finish"), "{toast}");
    let engine = cx
        .read(|cx| session.state.read(cx).engine().cloned())
        .unwrap();
    let root = cx.read(|cx| session.state.read(cx).root_id()).unwrap();
    let files = futures::executor::block_on(engine.list_files(FileQuery {
        filter: FileFilter::root(Some(root)),
        sort: FileSortColumn::Path,
        descending: false,
        offset: 0,
        limit: 500,
    }))
    .unwrap();
    let row = files.rows.iter().find(|file| file.rel_path == rel).unwrap();
    assert_eq!(
        row.size,
        grown.len() as i64,
        "nothing caught the catalog up"
    );
}

/// The steps an undo that did not finish did put back have changed under the catalog too.
#[gpui_kit::test]
async fn an_undo_that_does_not_finish_still_rescans(cx: &mut TestAppContext) {
    let session = launch_changing(cx, "partial-undo");
    add_archive(cx, &session).await;
    go(cx, &session, TidyPage::Shrink);
    settle(cx, &session).await;
    click(cx, &session, "shrink-batch-all");
    click(cx, &session, "shrink-run");
    wait_for_change(cx, &session).await;
    assert!(cx.read(last_toast).unwrap().starts_with("Shrank"));
    let held = held_files(&session);
    let name = held[0].rsplit('/').next().unwrap();
    let (stem, _) = name.rsplit_once('.').unwrap();
    undo_with_a_file_grown(cx, &session, &format!("clips/{stem}.mp4")).await;
}

/// The same, on Tidy up's Undo, which takes back several plans. Its last plan, undone first, is
/// the one that stops: no plan before it has any rescan to pass on.
#[gpui_kit::test]
async fn a_tidy_up_whose_undo_does_not_finish_still_rescans(cx: &mut TestAppContext) {
    let session = launch_changing(cx, "partial-undo-all");
    add_archive(cx, &session).await;
    click(cx, &session, "overview-tidy-up");
    wait_for_change(cx, &session).await;
    assert!(cx.read(last_toast).unwrap().starts_with("Tidied up"));
    undo_with_a_file_grown(cx, &session, "clips/talk.mp4").await;
}

/// Adds a second folder beside the archive, scanned, and returns the two roots' ids.
async fn two_roots(cx: &mut TestAppContext, session: &Session) -> (i64, i64) {
    add_archive(cx, session).await;
    let first = cx.read(|cx| session.state.read(cx).root_id()).unwrap();
    let other = session.archive.parent().unwrap().join("other");
    std::fs::create_dir_all(&other).unwrap();
    std::fs::write(other.join("note.txt"), b"another root").unwrap();
    cx.update_window(session.handle, |_, window, cx| {
        session
            .tidy
            .update(cx, |tidy, cx| tidy.add_folder(other, window, cx));
    })
    .unwrap();
    wait_for_change(cx, session).await;
    let second = cx.read(|cx| session.state.read(cx).root_id()).unwrap();
    assert_ne!(first, second);
    (first, second)
}

fn scanned_at(cx: &mut TestAppContext, session: &Session, root: i64) -> Option<i64> {
    cx.read(|cx| {
        session
            .state
            .read(cx)
            .roots()
            .iter()
            .find(|found| found.id == root)
            .and_then(|found| found.last_scan_at)
    })
}

/// A rescan a change asks for while a scan of another root runs waits its turn.
#[gpui_kit::test]
async fn a_rescan_waits_for_the_scan_running(cx: &mut TestAppContext) {
    let session = launch_changing(cx, "rescan-queue");
    let (first, second) = two_roots(cx, &session).await;
    let before = scanned_at(cx, &session, second);
    cx.update_window(session.handle, |_, window, cx| {
        session.state.update(cx, |state, cx| {
            state.start_scan(first, window, cx);
            state.rescan_after_change(second, window, cx);
        });
    })
    .unwrap();
    wait_for_change(cx, &session).await;
    assert!(
        scanned_at(cx, &session, second) > before,
        "its rescan was lost"
    );
}

/// The owner's Stop means quiet: what waited goes too.
#[gpui_kit::test]
async fn stopping_a_scan_takes_the_rescans_waiting_with_it(cx: &mut TestAppContext) {
    let session = launch_changing(cx, "rescan-stop");
    let (first, second) = two_roots(cx, &session).await;
    let before = scanned_at(cx, &session, second);
    cx.update_window(session.handle, |_, window, cx| {
        session.state.update(cx, |state, cx| {
            state.start_scan(first, window, cx);
            state.rescan_after_change(second, window, cx);
            state.stop_work(cx);
        });
    })
    .unwrap();
    wait_for_change(cx, &session).await;
    assert_eq!(scanned_at(cx, &session, second), before);
}

/// Which roots an analysis runs for, as each starts.
fn watch_analyses(
    cx: &mut TestAppContext,
    session: &Session,
) -> (
    std::rc::Rc<std::cell::RefCell<Vec<i64>>>,
    gpui_kit::Subscription,
) {
    let seen = std::rc::Rc::new(std::cell::RefCell::new(Vec::new()));
    let (noted, state) = (seen.clone(), session.state.clone());
    let watching = cx.update(|cx| {
        cx.observe(&state, move |state, cx| {
            if let Some(running) = state.read(cx).analysis() {
                let mut noted = noted.borrow_mut();
                if noted.last() != Some(&running.root_id) {
                    noted.push(running.root_id);
                }
            }
        })
    });
    (seen, watching)
}

/// Forgetting a folder stops its analysis without the owner's Stop, as here: another root's analysis
/// waiting behind it still runs.
#[gpui_kit::test]
async fn an_analysis_stopped_for_a_folder_leaves_another_roots_waiting(cx: &mut TestAppContext) {
    let session = launch_changing(cx, "analysis-queue");
    let (first, second) = two_roots(cx, &session).await;
    let (seen, _watching) = watch_analyses(cx, &session);
    cx.update_window(session.handle, |_, window, cx| {
        session.state.update(cx, |state, cx| {
            state.start_analysis(first, window, cx);
            state.start_background_analysis(second, window, cx);
            let job = state.analysis().unwrap().job.clone();
            job.update(cx, |job, cx| job.cancel(cx));
        });
    })
    .unwrap();
    wait_for_change(cx, &session).await;
    assert_eq!(*seen.borrow(), [first, second]);
}

/// The owner's Stop on an analysis takes what waited with it.
#[gpui_kit::test]
async fn stopping_an_analysis_takes_those_waiting_with_it(cx: &mut TestAppContext) {
    let session = launch_changing(cx, "analysis-stop");
    let (first, second) = two_roots(cx, &session).await;
    let (seen, _watching) = watch_analyses(cx, &session);
    cx.update_window(session.handle, |_, window, cx| {
        session.state.update(cx, |state, cx| {
            state.start_analysis(first, window, cx);
            state.start_background_analysis(second, window, cx);
            state.stop_work(cx);
        });
    })
    .unwrap();
    wait_for_change(cx, &session).await;
    assert_eq!(*seen.borrow(), [first]);
}

/// Runs the app for a moment, two seconds, with no waiting for it to be free: paused work never
/// is. It draws every tenth of a second, not every tick: a frame is what costs here.
async fn a_moment(cx: &mut TestAppContext, session: &Session) {
    for round in 0..200 {
        cx.run_until_parked();
        if round % 10 == 0 {
            render(cx, session);
        }
        tick(cx);
    }
    render(cx, session);
}

/// Lets go of what a test paused, and waits for it to end.
async fn stop_paused_work(cx: &mut TestAppContext, session: &Session) {
    cx.update_window(session.handle, |_, _, cx| {
        session.state.update(cx, |state, cx| state.stop_work(cx));
    })
    .unwrap();
    wait_for_change(cx, session).await;
}

/// Forget behind a paused analysis the owner asked for answers at once, and says what to do. Holding
/// goes to the Trash only when the folder will go: asked afterwards, it had gone already.
#[gpui_kit::test]
async fn forgetting_a_folder_with_paused_work_says_so_and_keeps_holding(cx: &mut TestAppContext) {
    let session = launch_changing(cx, "forget-paused");
    add_archive(cx, &session).await;
    click(cx, &session, "overview-tidy-up");
    wait_for_change(cx, &session).await;
    let held = held_files(&session);
    assert!(!held.is_empty());
    let root = cx.read(|cx| session.state.read(cx).root_id()).unwrap();
    cx.update_window(session.handle, |_, window, cx| {
        session.state.update(cx, |state, cx| {
            state.start_analysis(root, window, cx);
            let job = state.analysis().unwrap().job.clone();
            job.update(cx, |job, cx| job.set_paused(true, cx));
        });
    })
    .unwrap();
    a_moment(cx, &session).await;
    cx.update_window(session.handle, |_, window, cx| {
        session
            .state
            .update(cx, |state, cx| state.forget_root(root, window, cx));
    })
    .unwrap();
    a_moment(cx, &session).await;
    assert_eq!(
        cx.read(last_toast).as_deref(),
        Some("Couldn't forget the folder")
    );
    assert_eq!(held_files(&session), held, "holding stays with its folder");
    assert_eq!(cx.read(|cx| session.state.read(cx).roots().len()), 1);
    stop_paused_work(cx, &session).await;
}

/// A change waiting behind a paused scan cannot finish until the owner acts: quitting does not wait
/// for it with the window hidden, and the owner hears why it has not started. Resumed, it runs.
#[gpui_kit::test]
async fn a_change_behind_paused_work_says_so_and_does_not_hold_a_quit(cx: &mut TestAppContext) {
    let session = launch_changing(cx, "undo-behind-paused");
    add_archive(cx, &session).await;
    click(cx, &session, "overview-tidy-up");
    wait_for_change(cx, &session).await;
    let root = cx.read(|cx| session.state.read(cx).root_id()).unwrap();
    cx.update_window(session.handle, |_, window, cx| {
        session.state.update(cx, |state, cx| {
            state.start_scan(root, window, cx);
            let job = state.scan().unwrap().job.clone();
            job.update(cx, |job, cx| job.set_paused(true, cx));
        });
    })
    .unwrap();
    a_moment(cx, &session).await;
    undo(cx, &session);
    a_moment(cx, &session).await;
    assert_eq!(
        cx.read(last_toast).as_deref(),
        Some("Waiting for paused work")
    );
    assert!(cx.read(|cx| session.state.read(cx).is_busy()));
    assert!(
        !cx.read(|cx| session.shell.read(cx).is_busy()),
        "a quit would hide the window and wait for a resume nobody can press"
    );

    cx.update_window(session.handle, |_, _, cx| {
        session.state.update(cx, |state, cx| {
            let job = state.scan().unwrap().job.clone();
            job.update(cx, |job, cx| job.set_paused(false, cx));
        });
    })
    .unwrap();
    wait_for_change(cx, &session).await;
    assert!(cx.read(last_toast).unwrap().starts_with("Undid"));
}

/// The page still shows a set whose kept file changed and was scanned: Return moves nothing.
#[gpui_kit::test]
async fn return_on_a_set_gone_stale_moves_nothing(cx: &mut TestAppContext) {
    let session = launch_changing(cx, "keep-stale");
    add_archive(cx, &session).await;
    go(cx, &session, TidyPage::Duplicates);
    settle(cx, &session).await;
    click(cx, &session, "scope-exact");
    settle(cx, &session).await;
    click(cx, &session, ("set-row", 0usize));
    assert_eq!(kept_names(cx, &session), ["forest.png"]);

    let copies = [
        session.archive.join("dup/forest (1).png"),
        session.archive.join("photos/forest copy.png"),
    ];
    std::fs::write(session.archive.join("photos/forest.png"), b"something else").unwrap();
    let (engine, root) = cx.read(|cx| {
        let state = session.state.read(cx);
        (state.engine().cloned().unwrap(), state.root_id().unwrap())
    });
    engine
        .scan_blocking(root, &oriel_core_tidy::passes::Quiet::new())
        .unwrap();

    press(cx, &session, "enter");
    wait_for_change(cx, &session).await;
    assert!(copies.iter().all(|copy| copy.is_file()), "copies stay");
    assert_eq!(held_files(&session), Vec::<String>::new());
}

/// Forget empties holding as part of going: in a sandboxed run, into the run's own trash.
#[gpui_kit::test]
async fn forgetting_a_folder_sends_holding_to_the_runs_own_trash(cx: &mut TestAppContext) {
    let session = launch_changing(cx, "forget-trash");
    add_archive(cx, &session).await;
    click(cx, &session, "overview-tidy-up");
    wait_for_change(cx, &session).await;
    assert!(!held_files(&session).is_empty());
    let trash = session.root.join("data").join("sandbox-trash");
    assert!(!trash.exists());
    let root = cx.read(|cx| session.state.read(cx).root_id()).unwrap();
    cx.update_window(session.handle, |_, window, cx| {
        session
            .state
            .update(cx, |state, cx| state.forget_root(root, window, cx));
    })
    .unwrap();
    a_moment(cx, &session).await;
    assert_eq!(cx.read(|cx| session.state.read(cx).roots().len()), 0);
    assert!(held_files(&session).is_empty());
    assert!(std::fs::read_dir(&trash).unwrap().next().is_some());
}

/// Return when the file kept has changed and no scan has seen it yet: the copies stay, and the
/// toast says which file it was, not that they changed.
#[gpui_kit::test]
async fn return_says_when_it_was_the_file_kept_that_changed(cx: &mut TestAppContext) {
    let session = launch_changing(cx, "keep-kept-changed");
    add_archive(cx, &session).await;
    go(cx, &session, TidyPage::Duplicates);
    settle(cx, &session).await;
    click(cx, &session, "scope-exact");
    settle(cx, &session).await;
    click(cx, &session, ("set-row", 0usize));
    assert_eq!(kept_names(cx, &session), ["forest.png"]);
    std::fs::write(session.archive.join("photos/forest.png"), b"something else").unwrap();
    press(cx, &session, "enter");
    wait_for_change(cx, &session).await;
    assert_eq!(
        cx.read(last_toast).as_deref(),
        Some("Nothing moved: the file kept has changed since the scan")
    );
    assert!(session.archive.join("dup/forest (1).png").is_file());
}

/// An Undo waiting its turn needs what is in holding: neither Empty nor Forget takes it away.
#[gpui_kit::test]
async fn holding_stays_while_an_undo_waits(cx: &mut TestAppContext) {
    let session = launch_changing(cx, "holding-stays");
    add_archive(cx, &session).await;
    click(cx, &session, "overview-tidy-up");
    wait_for_change(cx, &session).await;
    let held = held_files(&session);
    assert!(!held.is_empty());
    let root = cx.read(|cx| session.state.read(cx).root_id()).unwrap();
    go(cx, &session, TidyPage::Holding);
    settle(cx, &session).await;
    cx.update_window(session.handle, |_, window, cx| {
        session.state.update(cx, |state, cx| {
            state.start_scan(root, window, cx);
            let job = state.scan().unwrap().job.clone();
            job.update(cx, |job, cx| job.set_paused(true, cx));
        });
    })
    .unwrap();
    a_moment(cx, &session).await;
    undo(cx, &session);
    a_moment(cx, &session).await;

    click(cx, &session, "holding-empty");
    a_moment(cx, &session).await;
    assert_eq!(
        cx.read(last_toast).as_deref(),
        Some("Holding stays for now")
    );
    cx.update_window(session.handle, |_, window, cx| {
        session
            .state
            .update(cx, |state, cx| state.forget_root(root, window, cx));
    })
    .unwrap();
    a_moment(cx, &session).await;
    assert_eq!(
        cx.read(last_toast).as_deref(),
        Some("Couldn't forget the folder")
    );
    assert_eq!(held_files(&session), held);

    cx.update_window(session.handle, |_, _, cx| {
        session.state.update(cx, |state, cx| {
            let job = state.scan().unwrap().job.clone();
            job.update(cx, |job, cx| job.set_paused(false, cx));
        });
    })
    .unwrap();
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
