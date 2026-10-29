//! Electron Oriel's Tidy cases (`e2e/tests/glazier/*.spec.ts`) as GPUI Kit headless UI tests, on
//! a copy of the archive glazier-core's differential suite scans
//! (`apps/oriel-rs/conformance/glazier-core/archive`, dates included). It holds the e2e
//! workbench's files and the Spot variants spec's pages, so its numbers are larger than the
//! specs': 26 files, four similar sets and one identical set.
//!
//! The cases that only read the archive run now. Those that change files wait for Tidy's
//! executor: they are written against [`TidyChanges`] and ignored until [`changes`] hands them
//! the implementation over `oriel-core-tidy`. The scans need libvips and the pinned ffmpeg and
//! ffprobe (`cargo run -p xtask -- vendor`, `fetch-media-tools`); without them a case says so
//! and passes.

use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::time::{Duration, SystemTime};

use gpui_kit::test::TestWindowExt as _;
use gpui_kit::{
    AnyWindowHandle, App, AppContext as _, Bounds, Context, ElementId, Entity, IntoElement,
    ParentElement as _, Render, Styled as _, TestAppContext, Window, WindowBounds, WindowOptions,
    div, px, size,
};
use oriel_core_paths::DataRoot;
use oriel_core_tidy::passes::Media;
use oriel_mode_tidy::changes::{Changes, EngineChanges, NotYet};
use oriel_mode_tidy::{TidyMode, TidyPage, TidyState, last_toast};
use oriel_ui::{ModeId, ShellState};

/// The changes the read-side cases run with: "not available yet", as the app has them until the
/// executor is trusted with files.
fn not_yet() -> Changes {
    Rc::new(NotYet)
}

/// The changes the ignored cases run with: the engine's executor.
fn executor() -> Changes {
    Rc::new(EngineChanges)
}

fn conformance() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../conformance/glazier-core")
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct Manifest {
    files: Vec<ManifestFile>,
    empty_folders: Vec<String>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ManifestFile {
    path: String,
    mtime_ms: f64,
}

/// A folder of its own under the temp folder, which Tidy's sandbox admits.
fn scratch(test: &str) -> PathBuf {
    let folder = std::env::temp_dir()
        .join("oriel-mode-tidy-tests")
        .join(format!("{test}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&folder);
    std::fs::create_dir_all(&folder).unwrap();
    std::fs::canonicalize(folder).unwrap()
}

/// The committed archive, copied with its dates and its empty folder.
fn copy_archive(target: &Path) {
    let source = conformance().join("archive");
    let manifest: Manifest =
        serde_json::from_str(&std::fs::read_to_string(conformance().join("archive.json")).unwrap())
            .unwrap();
    for folder in &manifest.empty_folders {
        std::fs::create_dir_all(target.join(folder)).unwrap();
    }
    for file in &manifest.files {
        let to = target.join(&file.path);
        std::fs::create_dir_all(to.parent().unwrap()).unwrap();
        std::fs::copy(source.join(&file.path), &to).unwrap();
        std::fs::File::options()
            .write(true)
            .open(&to)
            .unwrap()
            .set_modified(SystemTime::UNIX_EPOCH + Duration::from_millis(file.mtime_ms as u64))
            .unwrap();
    }
}

/// Whether this machine has what a scan's analysis needs.
fn media_ready() -> bool {
    let media = Media::locate();
    let ready = media.vips.is_some() && media.ffmpeg.is_some() && media.ffprobe.is_some();
    if !ready {
        eprintln!("skipped: needs libvips and the pinned ffmpeg and ffprobe");
    }
    ready
}

/// Tidy alone in a window, with its Settings section drawn in place of the page while
/// `settings` is set, as the shell draws it.
struct Harness {
    tidy: Entity<TidyMode>,
    settings: bool,
}

impl Render for Harness {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        if self.settings {
            let section = self
                .tidy
                .update(cx, |tidy, cx| tidy.settings_section(window, cx));
            div().size_full().child(section).into_any_element()
        } else {
            self.tidy.clone().into_any_element()
        }
    }
}

struct Session {
    handle: AnyWindowHandle,
    shell: Entity<ShellState>,
    tidy: Entity<TidyMode>,
    state: Entity<TidyState>,
    root: PathBuf,
    archive: PathBuf,
}

fn launch(cx: &mut TestAppContext, test: &str) -> Session {
    launch_in(cx, scratch(test), not_yet())
}

/// Tidy changing files through the engine's executor.
fn launch_changing(cx: &mut TestAppContext, test: &str) -> Session {
    launch_in(cx, scratch(test), executor())
}

/// Tidy over a data folder in `root`, with the archive copied beside it.
fn launch_in(cx: &mut TestAppContext, root: PathBuf, changes: Changes) -> Session {
    // The engine's work runs on threads of its own, so the scheduler has to be allowed to wait.
    cx.executor().allow_parking();
    cx.update(|cx| {
        gpui_kit::init(cx);
        oriel_ui::theme::init(cx);
    });
    let archive = root.join("archive");
    copy_archive(&archive);
    let data = DataRoot::at(root.join("data")).unwrap();
    data.create_folders().unwrap();
    let mut parts = None;
    let (handle, _) = cx.update(|cx| {
        gpui_kit::open_window(
            WindowOptions {
                window_bounds: Some(WindowBounds::Windowed(Bounds::new(
                    Default::default(),
                    size(px(1440.), px(900.)),
                ))),
                ..Default::default()
            },
            cx,
            |window, cx| {
                let shell = cx.new(|_| ShellState::new(ModeId::Tidy, false));
                let tidy =
                    cx.new(|cx| TidyMode::with_data(&shell, &data, changes.clone(), window, cx));
                parts = Some((tidy.clone(), shell));
                cx.new(|_| Harness {
                    tidy,
                    settings: false,
                })
            },
        )
        .expect("open the test window")
    });
    let (tidy, shell) = parts.unwrap();
    let state = cx.update(|cx| tidy.read(cx).state().clone());
    Session {
        handle,
        shell,
        tidy,
        state,
        root,
        archive,
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

fn render(cx: &mut TestAppContext, session: &Session) {
    cx.update_window(session.handle, |_, window, cx| window.render_frame(cx))
        .unwrap();
}

/// Lets the engine's threads and the app's tasks run until `done` holds.
async fn wait_for(
    cx: &mut TestAppContext,
    session: &Session,
    what: &str,
    done: impl Fn(&App) -> bool,
) {
    for _ in 0..20_000 {
        cx.run_until_parked();
        render(cx, session);
        if cx.read(|cx| done(cx)) {
            return;
        }
        cx.background_executor
            .timer(Duration::from_millis(10))
            .await;
    }
    panic!("timed out waiting for {what}");
}

/// Waits until the engine is open, nothing runs, and Overview's numbers are in.
async fn settle(cx: &mut TestAppContext, session: &Session) {
    let state = session.state.clone();
    wait_for(cx, session, "Tidy to settle", move |cx| {
        let state = state.read(cx);
        state.is_ready()
            && !state.is_busy()
            && (state.root().is_none() || state.overview().is_some())
    })
    .await;
    // The pages' own reads land after the state's.
    for _ in 0..20 {
        cx.run_until_parked();
        render(cx, session);
        cx.background_executor
            .timer(Duration::from_millis(10))
            .await;
    }
}

fn click(cx: &mut TestAppContext, session: &Session, id: impl Into<ElementId>) {
    let id = id.into();
    cx.update_window(session.handle, |_, window, cx| {
        window.render_frame(cx);
        window.click(id, cx);
    })
    .unwrap();
    cx.run_until_parked();
    render(cx, session);
}

/// Edit › Undo (⌘Z), as the shell's menu sends it to the mode on screen.
fn undo(cx: &mut TestAppContext, session: &Session) {
    cx.update_window(session.handle, |_, window, cx| {
        window.dispatch_action(Box::new(oriel_ui::commands::UndoChange), cx);
    })
    .unwrap();
    cx.run_until_parked();
    render(cx, session);
}

fn press(cx: &mut TestAppContext, session: &Session, key: &'static str) {
    cx.update_window(session.handle, |_, window, cx| window.press(key, cx))
        .unwrap();
    cx.run_until_parked();
    render(cx, session);
}

/// The label of the element `id`, if it is drawn.
fn label(cx: &mut TestAppContext, session: &Session, id: impl Into<ElementId>) -> Option<String> {
    let id = id.into();
    cx.update_window(session.handle, |_, window, _| {
        window
            .try_find(id)
            .and_then(|element| element.label().map(str::to_owned))
    })
    .unwrap()
}

fn description(
    cx: &mut TestAppContext,
    session: &Session,
    id: impl Into<ElementId>,
) -> Option<String> {
    let id = id.into();
    cx.update_window(session.handle, |_, window, _| {
        window
            .try_find(id)
            .and_then(|element| element.description().map(str::to_owned))
    })
    .unwrap()
}

/// Adds the archive as Tidy's folder and waits for its scan and analysis.
async fn add_archive(cx: &mut TestAppContext, session: &Session) {
    settle(cx, session).await;
    let archive = session.archive.clone();
    cx.update_window(session.handle, |_, window, cx| {
        session
            .tidy
            .update(cx, |tidy, cx| tidy.add_folder(archive, window, cx));
    })
    .unwrap();
    let state = session.state.clone();
    wait_for(cx, session, "the scan", move |cx| {
        let state = state.read(cx);
        state.root().is_some_and(|root| root.last_scan_at.is_some())
    })
    .await;
    settle(cx, session).await;
}

fn go(cx: &mut TestAppContext, session: &Session, page: TidyPage) {
    click(cx, session, ElementId::Name(page.item_id().into()));
    assert_eq!(cx.read(|cx| session.state.read(cx).page()), page);
}

/// Duplicates' set whose files include `name`, by its position in the queue.
fn set_with(cx: &mut TestAppContext, session: &Session, name: &str) -> usize {
    cx.read(|cx| {
        let duplicates = session.tidy.read(cx).duplicates().read(cx);
        duplicates
            .sets()
            .iter()
            .position(|set| {
                set.versions
                    .iter()
                    .flat_map(|version| version.files.iter())
                    .any(|file| file.name == name)
            })
            .unwrap_or_else(|| panic!("no set holds {name}"))
    })
}

fn kept_names(cx: &mut TestAppContext, session: &Session) -> Vec<String> {
    cx.read(|cx| {
        let mut names = session.tidy.read(cx).duplicates().read(cx).kept_names();
        names.sort();
        names
    })
}

fn file_id(cx: &mut TestAppContext, session: &Session, name: &str) -> u64 {
    cx.read(|cx| {
        session
            .tidy
            .read(cx)
            .duplicates()
            .read(cx)
            .rows()
            .iter()
            .find(|row| row.file.name == name)
            .map(|row| row.file.id as u64)
            .unwrap_or_else(|| panic!("{name} is not on the stage"))
    })
}

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

    // Its checkbox keeps the resized one as well, which makes them not duplicates, without
    // deciding the set; ⇧2 takes it back. Nothing changes on disk.
    let small = file_id(cx, &session, "sunset-small.jpg");
    click(cx, &session, ("keep-version", small));
    assert_eq!(kept_names(cx, &session), ["sunset-small.jpg", "sunset.png"]);
    let decision = cx.read(|cx| session.tidy.read(cx).duplicates().read(cx).decision());
    assert_eq!(decision.as_deref(), Some("Not duplicates"));
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
        assert!(copy_of.starts_with("A copy of"), "{name}: {copy_of}");
    }

    // The outfits wait under Variants, every version kept, until marked as not duplicates.
    click(cx, &session, "scope-variants");
    settle(cx, &session).await;
    let index = set_with(cx, &session, "outfit-a.png");
    click(cx, &session, ("set-row", index));
    assert_eq!(kept_names(cx, &session), ["outfit-a.png", "outfit-b.png"]);
    let decision = cx.read(|cx| session.tidy.read(cx).duplicates().read(cx).decision());
    assert_eq!(decision.as_deref(), Some("Not duplicates"));
    press(cx, &session, "enter");
    settle(cx, &session).await;
    assert_eq!(
        cx.read(last_toast).as_deref(),
        Some("Marked as not duplicates")
    );
    assert_eq!(counts(cx).dismissed, 1);
    assert_eq!(counts(cx).variants, 1);
}

// The cases that change files, ready for Tidy's executor.

/// Waits for the change running to finish.
async fn wait_for_change(cx: &mut TestAppContext, session: &Session) {
    let state = session.state.clone();
    wait_for(cx, session, "the change", move |cx| {
        !state.read(cx).is_busy()
    })
    .await;
    settle(cx, session).await;
}

fn held_files(session: &Session) -> Vec<String> {
    // Holding sits outside the root, in Tidy's data folder; the executor names it.
    let holding = session.root.join("data").join("tidy").join("holding");
    let mut held = Vec::new();
    let mut stack = vec![holding.clone()];
    while let Some(folder) = stack.pop() {
        for entry in std::fs::read_dir(&folder).into_iter().flatten().flatten() {
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
            } else {
                held.push(path.strip_prefix(&holding).unwrap().display().to_string());
            }
        }
    }
    held.sort();
    held
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
