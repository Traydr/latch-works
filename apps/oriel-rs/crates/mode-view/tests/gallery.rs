//! Electron Oriel's `e2e/tests/frame-view/gallery.spec.ts`, case by case, as GPUI Kit headless
//! UI tests on a fixture archive shaped like the e2e suite's (`e2e/src/fixture.ts`): the same
//! folders and names, and modified times in the same permuted order, so date order is neither
//! name order nor the order the files were written.
//!
//! The tests open View alone in a window, with its Settings section drawn in place of the
//! gallery when a case needs it, as the shell draws it. Videos are made with the pinned ffmpeg;
//! the cases that need them say so and skip without it.

use std::cell::RefCell;
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::sync::Arc;
use std::time::{Duration, UNIX_EPOCH};

use gpui_kit::test::TestEventExt as _;
use gpui_kit::test::TestWindowExt as _;
use gpui_kit::{
    AnyWindowHandle, AppContext as _, Bounds, Context, ElementId, Entity, ImageSource, IntoElement,
    ParentElement as _, Render, Role, ScrollDelta, Styled as _, TestAppContext, Window,
    WindowBounds, WindowOptions, div, point, px, size,
};
use oriel_core_domain::{GallerySortMode, NamedPath, SortableMediaItem, compare_by_name};
use oriel_core_paths::DataRoot;
use oriel_media::still::{Still, WebpSettings};
use oriel_mode_view::browser::Tile;
use oriel_mode_view::gallery::{CAPTION_ID, HOVER_DELAY};
use oriel_mode_view::listing::MediaEntry;
use oriel_mode_view::thumbnails::Thumbnail;
use oriel_mode_view::{CapsulePanel, CapsulePlayer, Listing, ViewEvent, ViewMode, viewer};
use oriel_ui::{LocalStorage, ModeActivity, ModeId, ShellState};

/// `FIXTURE_EPOCH_MS`: 2026-01-01T12:00:00Z.
const FIXTURE_EPOCH_MS: u64 = 1_767_268_800_000;

#[derive(Clone, Copy, Debug, PartialEq)]
enum Kind {
    Image,
    Gif,
    Video,
    Pdf,
}

#[derive(Clone, Debug)]
struct FixtureItem {
    path: String,
    kind: Kind,
    mtime_minutes: u64,
}

impl FixtureItem {
    fn name(&self) -> &str {
        self.path.rsplit('/').next().unwrap()
    }

    fn parent(&self) -> &str {
        self.path.rsplit_once('/').map_or("", |(parent, _)| parent)
    }

    fn mtime_ms(&self) -> f64 {
        (FIXTURE_EPOCH_MS + self.mtime_minutes * 60_000) as f64
    }
}

/// The ordering rules compare names and paths; the fixture's own paths stand in for the
/// absolute ones, which share their prefix.
struct Named<'a>(&'a FixtureItem, String);

impl NamedPath for Named<'_> {
    fn name(&self) -> &str {
        self.0.name()
    }

    fn path(&self) -> &str {
        &self.1
    }
}

impl SortableMediaItem for Named<'_> {
    fn mtime_ms(&self) -> f64 {
        self.0.mtime_ms()
    }
}

/// `fixture.ts`'s manifest, less the folder the management spec deletes.
fn fixture_items() -> Vec<FixtureItem> {
    let mut ordered: Vec<(String, Kind)> = [
        ("root-image.png", Kind::Image),
        ("comics/alpha/1.jpg", Kind::Image),
        ("comics/alpha/2.jpg", Kind::Image),
        ("comics/alpha/10.jpg", Kind::Image),
        ("comics/alpha/A.jpg", Kind::Image),
        ("comics/alpha/b.jpg", Kind::Image),
        ("comics/beta/page-1.png", Kind::Image),
        ("comics/beta/page-2.png", Kind::Image),
        ("comics/beta/page-3.png", Kind::Image),
        ("comics/beta/anim.gif", Kind::Gif),
        ("comics/nested/inner/inner-1.png", Kind::Image),
        ("comics/nested/inner/inner-2.png", Kind::Image),
        ("comics/nested/inner/inner-3.png", Kind::Image),
        ("videos/clip-a.mp4", Kind::Video),
        ("videos/clip-b.mp4", Kind::Video),
        ("mixed/photo-1.jpg", Kind::Image),
        ("mixed/photo-2.jpg", Kind::Image),
        ("mixed/photo-3.jpg", Kind::Image),
        ("mixed/reel.mp4", Kind::Video),
        ("docs/guide.pdf", Kind::Pdf),
        ("docs/100%_done_1.png", Kind::Image),
        ("docs/100%_done_2.png", Kind::Image),
        ("unicode/\u{dc}n\u{ef}code.jpg", Kind::Image),
        ("unicode/zebra.jpg", Kind::Image),
    ]
    .map(|(path, kind)| (path.to_string(), kind))
    .to_vec();
    for ix in 1..=70 {
        ordered.push((format!("bulk/bulk-{ix:03}.png"), Kind::Image));
    }

    // `mtimePermutation`: a fixed shuffle of the manifest's order.
    let count = ordered.len();
    let mut minutes: Vec<u64> = (0..count as u64).collect();
    let mut state: u32 = 0x9e37_79b9;
    for index in (1..count).rev() {
        state = state.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
        let swap = (state % (index as u32 + 1)) as usize;
        minutes.swap(index, swap);
    }
    ordered
        .into_iter()
        .zip(minutes)
        .map(|((path, kind), mtime_minutes)| FixtureItem {
            path,
            kind,
            mtime_minutes,
        })
        .collect()
}

/// A folder of its own under the temp folder, emptied first.
fn scratch(test: &str) -> PathBuf {
    let folder = std::env::temp_dir()
        .join("oriel-mode-view-gallery-tests")
        .join(format!("{test}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&folder);
    std::fs::create_dir_all(&folder).unwrap();
    folder
}

/// A small WebP still of one colour. ImageIO reads a file by its content, so it stands in for
/// every still extension.
fn still_bytes(shade: u8) -> Vec<u8> {
    let (width, height) = (64u32, 36u32);
    let bgra = [shade, 128, 255 - shade, 255].repeat((width * height) as usize);
    Still::from_bgra(width, height, bgra, true)
        .unwrap()
        .encode_webp(WebpSettings::lossy(80., 0))
        .unwrap()
}

/// A 4 s clip from the pinned ffmpeg, or `None` without it.
fn make_clip(path: &Path) -> Option<()> {
    let tools = oriel_tools::MediaTools::locate().ok()?;
    let output = std::process::Command::new(tools.ffmpeg())
        .args([
            "-hide_banner",
            "-loglevel",
            "error",
            "-f",
            "lavfi",
            "-i",
            "testsrc2=size=320x180:rate=25",
            "-t",
            "4",
            "-pix_fmt",
            "yuv420p",
            "-c:v",
            "libx264",
            "-y",
        ])
        .arg(path)
        .output()
        .ok()?;
    output.status.success().then_some(())
}

struct Fixture {
    root: PathBuf,
    archive: PathBuf,
    items: Vec<FixtureItem>,
    videos: bool,
}

impl Fixture {
    fn new(test: &str) -> Self {
        let root = scratch(test);
        let archive = root.join("archive");
        let items = fixture_items();
        let mut videos = true;
        for (ix, item) in items.iter().enumerate() {
            let path = archive.join(&item.path);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            match item.kind {
                Kind::Image | Kind::Gif => {
                    std::fs::write(&path, still_bytes((ix * 37 % 256) as u8)).unwrap();
                }
                Kind::Video => {
                    if make_clip(&path).is_none() {
                        videos = false;
                        std::fs::write(&path, b"not a video").unwrap();
                    }
                }
                Kind::Pdf => std::fs::write(&path, b"%PDF-1.4").unwrap(),
            }
            let modified = UNIX_EPOCH + Duration::from_millis(item.mtime_ms() as u64);
            std::fs::File::options()
                .write(true)
                .open(&path)
                .unwrap()
                .set_modified(modified)
                .unwrap();
        }
        // View resolves the folder it opens, and the temp folder is behind a symlink on macOS.
        let archive = std::fs::canonicalize(archive).unwrap();
        Self {
            root,
            archive,
            items,
            videos,
        }
    }

    fn absolute(&self, path: &str) -> PathBuf {
        if path.is_empty() {
            self.archive.clone()
        } else {
            self.archive.join(path)
        }
    }

    /// The items View lists (no PDFs), directly in `folder` or in its subtree.
    fn in_scope(&self, folder: &str, recursive: bool) -> Vec<&FixtureItem> {
        self.items
            .iter()
            .filter(|item| item.kind != Kind::Pdf)
            .filter(|item| {
                let parent = item.parent();
                if recursive {
                    folder.is_empty()
                        || parent == folder
                        || parent.starts_with(&format!("{folder}/"))
                } else {
                    parent == folder
                }
            })
            .collect()
    }

    /// `sortFixtureItems`: the documented ordering rules, on the fixture's own records.
    fn sorted(&self, folder: &str, mode: GallerySortMode) -> Vec<PathBuf> {
        let mut items: Vec<Named<'_>> = self
            .in_scope(folder, false)
            .into_iter()
            .map(|item| {
                Named(
                    item,
                    self.absolute(&item.path).to_string_lossy().into_owned(),
                )
            })
            .collect();
        let by_date = |a: &Named<'_>, b: &Named<'_>| a.mtime_ms().total_cmp(&b.mtime_ms());
        match mode {
            GallerySortMode::NameAsc => items.sort_by(compare_by_name),
            GallerySortMode::NameDesc => items.sort_by(|a, b| compare_by_name(b, a)),
            GallerySortMode::DateNewest => {
                items.sort_by(|a, b| by_date(b, a).then_with(|| compare_by_name(a, b)));
            }
            GallerySortMode::DateOldest => {
                items.sort_by(|a, b| by_date(a, b).then_with(|| compare_by_name(a, b)));
            }
            GallerySortMode::Random => unreachable!("random has no fixed order"),
        }
        items
            .iter()
            .map(|item| self.absolute(&item.0.path))
            .collect()
    }
}

/// View, with its Settings section drawn in place of the gallery while `settings` is set, as the
/// shell draws the section on its Settings page.
struct Harness {
    view: Entity<ViewMode>,
    settings: bool,
}

impl Render for Harness {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        if self.settings {
            let section = self
                .view
                .update(cx, |view, cx| view.settings_section(window, cx));
            div().size_full().child(section).into_any_element()
        } else {
            self.view.clone().into_any_element()
        }
    }
}

struct Session {
    handle: AnyWindowHandle,
    harness: Entity<Harness>,
    view: Entity<ViewMode>,
    shell: Entity<ShellState>,
}

fn launch(cx: &mut TestAppContext, data: &Path) -> Session {
    cx.update(|cx| {
        gpui_kit::init(cx);
        oriel_ui::theme::init(cx);
    });
    let data = DataRoot::at(data.to_path_buf()).unwrap();
    let mut parts = None;
    let (handle, _) = cx.update(|cx| {
        gpui_kit::open_window(
            WindowOptions {
                window_bounds: Some(WindowBounds::Windowed(Bounds::new(
                    Default::default(),
                    size(px(1320.), px(860.)),
                ))),
                ..Default::default()
            },
            cx,
            |window, cx| {
                let shell = cx.new(|cx| ShellState::new(ModeId::View, false, cx));
                let view = cx.new(|cx| ViewMode::with_data(&shell, &data, window, cx));
                let harness = cx.new(|_| Harness {
                    view: view.clone(),
                    settings: false,
                });
                parts = Some((harness.clone(), view, shell));
                harness
            },
        )
        .expect("open the test window")
    });
    let (harness, view, shell) = parts.unwrap();
    Session {
        handle,
        harness,
        view,
        shell,
    }
}

/// Lets the background work (the scan, its batches, thumbnails, decodes) finish and draws the
/// result.
fn settle(cx: &mut TestAppContext, session: &Session) {
    for _ in 0..8 {
        cx.run_until_parked();
        cx.update_window(session.handle, |_, window, cx| window.render_frame(cx))
            .unwrap();
    }
}

fn click(cx: &mut TestAppContext, session: &Session, id: impl Into<ElementId>) {
    let id = id.into();
    cx.update_window(session.handle, |_, window, cx| window.click(id, cx))
        .unwrap();
    settle(cx, session);
}

fn double_click(cx: &mut TestAppContext, session: &Session, id: impl Into<ElementId>) {
    let id = id.into();
    cx.update_window(session.handle, |_, window, cx| window.double_click(id, cx))
        .unwrap();
    settle(cx, session);
}

fn press(cx: &mut TestAppContext, session: &Session, key: &'static str) {
    cx.update_window(session.handle, |_, window, cx| window.press(key, cx))
        .unwrap();
    settle(cx, session);
}

/// The label of the element `id`, if it is on screen.
fn label(cx: &mut TestAppContext, session: &Session, id: &'static str) -> Option<String> {
    cx.update_window(session.handle, |_, window, _| {
        window
            .try_find(id)
            .and_then(|element| element.label().map(str::to_owned))
    })
    .unwrap()
}

/// Opens `folder` through the toolbar's Open button and the system's folder picker, and waits
/// for the scan.
fn open_folder(cx: &mut TestAppContext, session: &Session, folder: &Path) {
    cx.update_window(session.handle, |_, window, cx| {
        window.render_frame(cx);
        window.click("open-folder", cx);
    })
    .unwrap();
    assert!(cx.did_prompt_for_paths());
    let chosen = folder.to_path_buf();
    cx.simulate_path_prompt_response(move |options| {
        assert!(options.directories && !options.files);
        Some(vec![chosen])
    });
    settle(cx, session);
}

/// The paths of the gallery's tiles, in the order it shows them.
fn tile_paths(cx: &mut TestAppContext, session: &Session) -> Vec<PathBuf> {
    cx.update(|cx| {
        session
            .view
            .read(cx)
            .gallery()
            .read(cx)
            .tiles()
            .iter()
            .map(|tile| match tile {
                Tile::Folder { path, .. } => path.to_path_buf(),
                Tile::Comic { comic, .. } => comic.folder_path().to_path_buf(),
                Tile::Media { media, .. } => media.path().to_path_buf(),
            })
            .collect()
    })
}

fn tile_id(path: &Path) -> ElementId {
    ElementId::Path(Arc::from(path))
}

fn viewer_label(cx: &mut TestAppContext, session: &Session) -> Option<String> {
    label(cx, session, "viewer")
}

#[gpui_kit::test]
fn opens_a_folder_lists_its_children_and_recurses_on_demand(cx: &mut TestAppContext) {
    let fixture = Fixture::new("children");
    let session = launch(cx, &fixture.root.join("data"));
    open_folder(cx, &session, &fixture.archive);

    // The six top-level folders, then the one item at the top.
    assert_eq!(
        label(cx, &session, "gallery-folders").as_deref(),
        Some("6 folders")
    );
    assert_eq!(
        label(cx, &session, "gallery-count").as_deref(),
        Some("1 items")
    );
    let tiles = tile_paths(cx, &session);
    assert_eq!(tiles.len(), 7);
    assert_eq!(tiles.last(), Some(&fixture.absolute("root-image.png")));

    click(cx, &session, "recursive");
    let everything = fixture.in_scope("", true).len();
    assert_eq!(
        label(cx, &session, "gallery-count"),
        Some(format!("{everything} items"))
    );
    assert_eq!(tile_paths(cx, &session).len(), everything);
    assert_eq!(label(cx, &session, "gallery-folders"), None);
}

#[gpui_kit::test]
fn excluding_a_root_child_drops_its_subtree_from_the_recursive_scan(cx: &mut TestAppContext) {
    let fixture = Fixture::new("exclude");
    let session = launch(cx, &fixture.root.join("data"));
    open_folder(cx, &session, &fixture.archive);
    click(cx, &session, "recursive");
    let everything = fixture.in_scope("", true).len();
    assert_eq!(
        label(cx, &session, "gallery-count"),
        Some(format!("{everything} items"))
    );

    click(cx, &session, "folders");
    let bulk = fixture.absolute("bulk").to_string_lossy().into_owned();
    let toggle = oriel_mode_view::folder_overlay::exclude_id(&bulk);
    cx.update_window(session.handle, |_, window, _| {
        assert_eq!(window.find(toggle.clone()).label(), Some("Included"));
    })
    .unwrap();
    click(cx, &session, toggle.clone());
    cx.update_window(session.handle, |_, window, _| {
        assert_eq!(window.find(toggle.clone()).label(), Some("Excluded"));
    })
    .unwrap();
    click(cx, &session, "close-folder-browser");

    let without_bulk = fixture
        .in_scope("", true)
        .iter()
        .filter(|item| !item.path.starts_with("bulk/"))
        .count();
    assert_eq!(
        label(cx, &session, "gallery-count"),
        Some(format!("{without_bulk} items"))
    );
    // The exclusion is the opened folder's, in the settings file.
    cx.update(|cx| {
        let settings = session.view.read(cx).settings();
        let preferences = settings.root_preferences(Some(&fixture.archive.to_string_lossy()));
        assert_eq!(
            preferences.excluded_root_child_paths,
            std::slice::from_ref(&bulk)
        );
    });
    let file =
        std::fs::read_to_string(fixture.root.join("data/view/frame-view-settings.json")).unwrap();
    assert!(file.contains("\"excludedRootChildPaths\": [\n"), "{file}");
}

#[gpui_kit::test]
fn filters_hide_videos_and_images(cx: &mut TestAppContext) {
    let fixture = Fixture::new("filters");
    let session = launch(cx, &fixture.root.join("data"));
    open_folder(cx, &session, &fixture.absolute("mixed"));
    let mixed = fixture.in_scope("mixed", false);
    assert_eq!(tile_paths(cx, &session).len(), mixed.len());

    let show_settings = |cx: &mut TestAppContext, settings: bool| {
        cx.update(|cx| {
            session.harness.update(cx, |harness, cx| {
                harness.settings = settings;
                cx.notify();
            });
        });
        settle(cx, &session);
    };
    show_settings(cx, true);
    click(cx, &session, "show-videos");
    show_settings(cx, false);
    let stills = mixed.iter().filter(|item| item.kind != Kind::Video).count();
    assert_eq!(tile_paths(cx, &session).len(), stills);

    show_settings(cx, true);
    click(cx, &session, "show-videos");
    click(cx, &session, "show-images");
    show_settings(cx, false);
    let videos = mixed.iter().filter(|item| item.kind == Kind::Video).count();
    assert_eq!(tile_paths(cx, &session).len(), videos);
    cx.update(|cx| {
        let filters = &session.view.read(cx).settings().filters;
        assert!(!filters.show_images && filters.show_videos);
    });
}

#[gpui_kit::test]
fn a_fresh_scan_lands_in_the_configured_sort_order(cx: &mut TestAppContext) {
    let fixture = Fixture::new("fresh-order");
    let session = launch(cx, &fixture.root.join("data"));
    open_folder(cx, &session, &fixture.absolute("comics/alpha"));
    assert_eq!(
        tile_paths(cx, &session),
        fixture.sorted("comics/alpha", GallerySortMode::NameAsc)
    );
}

#[gpui_kit::test]
fn each_sort_matches_the_shared_ordering_rules(cx: &mut TestAppContext) {
    let fixture = Fixture::new("sorts");
    let session = launch(cx, &fixture.root.join("data"));
    open_folder(cx, &session, &fixture.absolute("comics/alpha"));
    for (mode, id, label_text) in [
        (GallerySortMode::NameDesc, "sort-name-desc", "Z-A"),
        (GallerySortMode::DateNewest, "sort-date-newest", "Newest"),
        (GallerySortMode::DateOldest, "sort-date-oldest", "Oldest"),
        (GallerySortMode::NameAsc, "sort-name-asc", "A-Z"),
    ] {
        click(cx, &session, "sort");
        assert!(label(cx, &session, "sort-menu").is_some(), "the menu opens");
        click(cx, &session, "gallery");
        assert_eq!(
            label(cx, &session, "sort-menu"),
            None,
            "a press elsewhere closes it"
        );
        click(cx, &session, "sort");
        click(cx, &session, id);
        assert_eq!(label(cx, &session, "sort-menu"), None, "the menu closes");
        assert_eq!(
            tile_paths(cx, &session),
            fixture.sorted("comics/alpha", mode),
            "{label_text}"
        );
        cx.update(|cx| assert_eq!(session.view.read(cx).settings().sort_mode, mode));
    }
}

#[gpui_kit::test]
fn random_is_a_permutation_and_shuffle_changes_it(cx: &mut TestAppContext) {
    let fixture = Fixture::new("random");
    let session = launch(cx, &fixture.root.join("data"));
    open_folder(cx, &session, &fixture.absolute("bulk"));
    cx.update_window(session.handle, |_, window, _| {
        assert!(
            window.try_find("shuffle").is_none(),
            "Shuffle shows only for Random"
        );
    })
    .unwrap();
    click(cx, &session, "sort");
    click(cx, &session, "sort-random");

    let first = tile_paths(cx, &session);
    let mut expected: Vec<PathBuf> = fixture
        .in_scope("bulk", false)
        .iter()
        .map(|item| fixture.absolute(&item.path))
        .collect();
    let mut sorted = first.clone();
    sorted.sort();
    expected.sort();
    assert_eq!(sorted, expected, "a permutation of the folder");
    assert_ne!(first, fixture.sorted("bulk", GallerySortMode::NameAsc));

    click(cx, &session, "shuffle");
    assert_ne!(tile_paths(cx, &session), first, "Shuffle changes the order");
}

#[gpui_kit::test]
fn every_image_tile_renders_a_thumbnail(cx: &mut TestAppContext) {
    let fixture = Fixture::new("thumbnails");
    let session = launch(cx, &fixture.root.join("data"));
    open_folder(cx, &session, &fixture.absolute("comics/alpha"));

    let thumbnails = fixture.root.join("data/view/frame-view/thumbnails");
    let written = std::fs::read_dir(&thumbnails)
        .unwrap()
        .filter(|file| {
            file.as_ref()
                .is_ok_and(|file| file.path().extension().is_some_and(|ext| ext == "webp"))
        })
        .count();
    assert_eq!(written, 5);
    cx.update(|cx| {
        let gallery = session.view.read(cx).gallery().read(cx);
        assert_eq!(gallery.thumbnails().read(cx).stats().generated(), 5);
        assert!(
            gallery.is_drawn_complete(),
            "a tile is still on its placeholder"
        );
    });
    cx.update_window(session.handle, |_, window, _| {
        // Four 256 × 144 tiles to a row at this width.
        let first = window
            .find(tile_id(&fixture.absolute("comics/alpha/1.jpg")))
            .bounds();
        assert_eq!((first.size.width, first.size.height), (px(256.), px(144.)));
    })
    .unwrap();
}

/// The titles of the fact groups Diagnostics shows.
fn diagnostics_groups(cx: &mut TestAppContext, session: &Session) -> Vec<&'static str> {
    cx.update(|cx| {
        session
            .view
            .read(cx)
            .diagnostics(cx)
            .facts
            .iter()
            .map(|group| group.title)
            .collect()
    })
}

#[gpui_kit::test]
fn performance_monitoring_keeps_the_thumbnail_timings_diagnostics_shows(cx: &mut TestAppContext) {
    let fixture = Fixture::new("diagnostics");
    let session = launch(cx, &fixture.root.join("data"));
    // Tall enough for the whole Settings section, Diagnostics at its foot, to be on screen.
    cx.simulate_window_resize(session.handle, size(px(1320.), px(4000.)));
    assert!(!diagnostics_groups(cx, &session).contains(&"Timings"));

    flip_setting(cx, &session, "performance-monitoring");
    open_folder(cx, &session, &fixture.absolute("comics/alpha"));
    assert!(diagnostics_groups(cx, &session).contains(&"Timings"));
    cx.update(|cx| {
        let gallery = session.view.read(cx).gallery().read(cx);
        let timings = gallery.thumbnails().read(cx).diagnostics().timings.unwrap();
        // Each of the five stills was made once, and asked for once.
        assert_eq!(timings.generation.count, 5);
        assert_eq!(timings.end_to_end.count, 5);
        assert_eq!(timings.disk_hit.count, 0);
        let report = session.view.read(cx).diagnostics_report(cx);
        assert!(
            report.contains("\nTimings\nDisk hit: 0 ms average"),
            "{report}"
        );
        assert!(report.contains("\nRecent thumbnail events\n"), "{report}");
    });

    // The details list the same groups, and turning monitoring off drops the timings.
    flip_setting(cx, &session, "diagnostics-show");
    cx.update(|cx| {
        session.harness.update(cx, |harness, cx| {
            harness.settings = true;
            cx.notify();
        });
    });
    settle(cx, &session);
    assert_eq!(
        label(cx, &session, "diagnostics-details").as_deref(),
        Some("Diagnostics details")
    );
    click(cx, &session, "performance-monitoring");
    assert!(!diagnostics_groups(cx, &session).contains(&"Timings"));
}

#[gpui_kit::test]
fn video_tiles_get_a_frame_from_ffmpeg(cx: &mut TestAppContext) {
    let fixture = Fixture::new("video-thumbnails");
    if !fixture.videos {
        eprintln!("skipped: no pinned ffmpeg (cargo run -p oriel-tools --bin fetch-media-tools)");
        return;
    }
    let session = launch(cx, &fixture.root.join("data"));
    open_folder(cx, &session, &fixture.absolute("videos"));
    cx.update(|cx| {
        let gallery = session.view.read(cx).gallery().read(cx);
        let thumbnails = gallery.thumbnails().read(cx);
        for media in gallery.media().iter() {
            assert!(
                matches!(thumbnails.thumbnail(media), Thumbnail::Ready(_)),
                "{} has no frame",
                media.name()
            );
        }
        assert_eq!(thumbnails.stats().video_failures(), 0);
    });
}

#[gpui_kit::test]
fn double_click_opens_the_viewer_the_arrows_step_and_escape_closes(cx: &mut TestAppContext) {
    let fixture = Fixture::new("viewer");
    let session = launch(cx, &fixture.root.join("data"));
    open_folder(cx, &session, &fixture.absolute("comics/alpha"));
    let order: Vec<String> = tile_paths(cx, &session)
        .iter()
        .map(|path| path.file_name().unwrap().to_string_lossy().into_owned())
        .collect();

    double_click(
        cx,
        &session,
        tile_id(&fixture.absolute("comics/alpha").join(&order[0])),
    );
    assert_eq!(
        viewer_label(cx, &session),
        Some(format!("Viewer for {}", order[0]))
    );
    cx.update(|cx| {
        let viewer = session
            .view
            .read(cx)
            .viewer()
            .expect("the viewer is open")
            .read(cx);
        assert!(viewer.is_current_ready(), "the still is decoded");
    });
    // The File menu's Open Folder… and Refresh stay lit over the viewer, as in Electron Oriel.
    cx.update_window(session.handle, |_, window, cx| {
        assert!(window.is_action_available(&oriel_ui::commands::OpenFolder, cx));
        assert!(window.is_action_available(&oriel_ui::commands::Refresh, cx));
    })
    .unwrap();
    press(cx, &session, "right");
    assert_eq!(
        viewer_label(cx, &session),
        Some(format!("Viewer for {}", order[1]))
    );
    click(cx, &session, "viewer-next");
    assert_eq!(
        viewer_label(cx, &session),
        Some(format!("Viewer for {}", order[2]))
    );
    press(cx, &session, "left");
    assert_eq!(
        viewer_label(cx, &session),
        Some(format!("Viewer for {}", order[1]))
    );

    // Stepping wraps, as `loopViewerNavigation` does by default.
    press(cx, &session, "left");
    press(cx, &session, "left");
    assert_eq!(
        viewer_label(cx, &session),
        Some(format!("Viewer for {}", order[order.len() - 1]))
    );
    press(cx, &session, "e");
    assert_eq!(
        viewer_label(cx, &session),
        Some(format!("Viewer for {}", order[0]))
    );

    let viewer = cx.update(|cx| session.view.read(cx).viewer().unwrap().downgrade());
    press(cx, &session, "escape");
    assert_eq!(viewer_label(cx, &session), None);
    cx.run_until_parked();
    assert!(viewer.upgrade().is_none(), "the closed viewer is released");
    cx.update(|cx| assert_eq!(session.view.read(cx).gallery().read(cx).selected(), Some(0)));
}

#[gpui_kit::test]
fn without_loop_navigation_the_viewer_stops_at_the_ends(cx: &mut TestAppContext) {
    let fixture = Fixture::new("no-loop");
    let session = launch(cx, &fixture.root.join("data"));
    open_folder(cx, &session, &fixture.absolute("unicode"));
    cx.update(|cx| {
        session.harness.update(cx, |harness, cx| {
            harness.settings = true;
            cx.notify();
        });
    });
    settle(cx, &session);
    click(cx, &session, "loop-viewer-navigation");
    cx.update(|cx| {
        session.harness.update(cx, |harness, cx| {
            harness.settings = false;
            cx.notify();
        });
    });
    settle(cx, &session);

    let order = tile_paths(cx, &session);
    double_click(cx, &session, tile_id(&order[1]));
    press(cx, &session, "right");
    let last = order[1].file_name().unwrap().to_string_lossy().into_owned();
    assert_eq!(
        viewer_label(cx, &session),
        Some(format!("Viewer for {last}"))
    );
}

/// Turns the switch `id` on View's Settings section over, as the e2e's `setToggle` does.
fn flip_setting(cx: &mut TestAppContext, session: &Session, id: &'static str) {
    cx.update(|cx| {
        session.harness.update(cx, |harness, cx| {
            harness.settings = true;
            cx.notify();
        });
    });
    settle(cx, session);
    click(cx, session, id);
    cx.update(|cx| {
        session.harness.update(cx, |harness, cx| {
            harness.settings = false;
            cx.notify();
        });
    });
    settle(cx, session);
}

/// Waits, in real time, for what a real video engine does on its own threads.
fn wait_until(
    cx: &mut TestAppContext,
    session: &Session,
    mut ready: impl FnMut(&mut TestAppContext) -> bool,
) -> bool {
    for _ in 0..250 {
        if ready(cx) {
            return true;
        }
        std::thread::sleep(Duration::from_millis(20));
        settle(cx, session);
    }
    ready(cx)
}

fn player(cx: &mut TestAppContext, session: &Session) -> Entity<CapsulePlayer> {
    cx.update(|cx| {
        session
            .view
            .read(cx)
            .viewer()
            .and_then(|viewer| viewer.read(cx).player().cloned())
            .expect("the video plays in the capsule player")
    })
}

fn read_player<T>(
    cx: &mut TestAppContext,
    session: &Session,
    read: impl FnOnce(&CapsulePlayer) -> T,
) -> T {
    let player = player(cx, session);
    cx.update(|cx| read(player.read(cx)))
}

/// `gallery.spec.ts`'s capsule case, with what its chrome has beyond it: a video opens in the
/// capsule player, without autoplay; skip, back, mute from the volume panel, and play or pause.
/// Then the level, the speed menu, 4 held for 2×, ← stepping to the next video with the volume
/// and speed kept, and Show in Tidy. A real engine plays the clip; the test reads the player's
/// own state, never a frame.
#[gpui_kit::test]
fn a_video_opens_in_the_capsule_player_seek_skip_mute_and_play_or_pause(cx: &mut TestAppContext) {
    let fixture = Fixture::new("player");
    if !fixture.videos {
        eprintln!("skipped: no pinned ffmpeg (cargo run -p oriel-tools --bin fetch-media-tools)");
        return;
    }
    let session = launch(cx, &fixture.root.join("data"));
    flip_setting(cx, &session, "autoplay-videos");
    cx.update(|cx| assert!(!session.view.read(cx).settings().autoplay_videos));

    open_folder(cx, &session, &fixture.absolute("videos"));
    double_click(
        cx,
        &session,
        tile_id(&fixture.absolute("videos/clip-a.mp4")),
    );
    assert_eq!(
        viewer_label(cx, &session).as_deref(),
        Some("Viewer for clip-a.mp4")
    );
    cx.update(|cx| {
        let viewer = session.view.read(cx).viewer().unwrap().read(cx);
        assert!(!viewer.options().autoplay);
    });
    assert!(
        read_player(cx, &session, |player| !player.is_playing()),
        "autoplay is off"
    );
    assert_eq!(
        read_player(cx, &session, |player| player.path().to_path_buf()),
        fixture.absolute("videos/clip-a.mp4")
    );
    let error = read_player(cx, &session, |player| {
        player.error().map(ToString::to_string)
    });
    assert_eq!(error, None, "the clip plays here");
    for (id, name) in [
        ("skip-back", "Back 5 seconds"),
        ("play-pause", "Play"),
        ("skip-forward", "Forward 5 seconds"),
        ("volume", "Volume"),
        ("speed", "Playback speed"),
    ] {
        assert_eq!(label(cx, &session, id).as_deref(), Some(name));
    }
    assert!(
        wait_until(cx, &session, |cx| read_player(cx, &session, |player| {
            player.duration().is_some()
        })),
        "the engine reads the clip's length"
    );

    // The clips are 4 s long, so a 5 s skip lands just short of the end, and back 5 s at the
    // start (`commitSeek`'s clamp).
    let position = |cx: &mut TestAppContext| {
        let player = player(cx, &session);
        cx.update(|cx| player.read(cx).position())
    };
    press(cx, &session, "3");
    assert!(
        position(cx) >= Duration::from_millis(3500),
        "{:?}",
        position(cx)
    );
    assert!(
        position(cx) < Duration::from_secs(4),
        "short of the end, so it does not loop"
    );
    click(cx, &session, "skip-back");
    assert!(
        position(cx) < Duration::from_millis(500),
        "{:?}",
        position(cx)
    );

    // Mute and unmute from the volume panel, kept as Electron Oriel keeps them.
    click(cx, &session, "volume");
    assert_eq!(
        read_player(cx, &session, CapsulePlayer::panel),
        Some(CapsulePanel::Volume)
    );
    assert_eq!(label(cx, &session, "volume-level").as_deref(), Some("100%"));
    assert_eq!(label(cx, &session, "mute").as_deref(), Some("Mute"));
    click(cx, &session, "mute");
    assert!(read_player(cx, &session, CapsulePlayer::is_muted));
    assert_eq!(label(cx, &session, "mute").as_deref(), Some("Unmute"));
    assert_eq!(label(cx, &session, "volume-level").as_deref(), Some("0%"));
    cx.update(|cx| assert_eq!(LocalStorage::get(cx, viewer::MUTED_KEY), Some("1")));
    click(cx, &session, "mute");
    assert!(!read_player(cx, &session, CapsulePlayer::is_muted));

    // A press a quarter of the way up the level sets it there.
    let panel = cx
        .update_window(session.handle, |_, window, _| {
            window.find("volume-panel").bounds()
        })
        .unwrap();
    // The track starts below the border, the top padding and half the thumb: 1 + 12 + 7 px.
    let quarter = point(panel.size.width / 2., px(20. + 112. * 0.75));
    cx.update_window(session.handle, |_, window, cx| {
        window.click_at("volume-panel", quarter, cx);
    })
    .unwrap();
    settle(cx, &session);
    let volume = read_player(cx, &session, CapsulePlayer::volume);
    assert!((volume - 0.25).abs() < 0.03, "the level is {volume}");
    cx.update(|cx| {
        let kept: f32 = LocalStorage::get(cx, viewer::VOLUME_KEY)
            .unwrap()
            .parse()
            .unwrap();
        assert_eq!(kept, volume);
    });

    // Play and pause, from the capsule and the keys.
    click(cx, &session, "play-pause");
    assert!(read_player(cx, &session, CapsulePlayer::is_playing));
    assert_eq!(label(cx, &session, "play-pause").as_deref(), Some("Pause"));
    click(cx, &session, "play-pause");
    assert!(!read_player(cx, &session, CapsulePlayer::is_playing));
    press(cx, &session, "space");
    assert!(read_player(cx, &session, CapsulePlayer::is_playing));
    press(cx, &session, "2");
    assert!(!read_player(cx, &session, CapsulePlayer::is_playing));

    // The speed menu, fastest first; a pick closes it.
    click(cx, &session, "speed");
    assert_eq!(
        read_player(cx, &session, CapsulePlayer::panel),
        Some(CapsulePanel::Speed)
    );
    let speeds: Vec<String> = cx
        .update_window(session.handle, |_, window, _| {
            [
                "speed-2",
                "speed-1.5",
                "speed-1.25",
                "speed-1",
                "speed-0.75",
                "speed-0.5",
            ]
            .iter()
            .map(|id| window.find(*id).label().unwrap().to_owned())
            .collect()
        })
        .unwrap();
    assert_eq!(speeds, ["2×", "1.5×", "1.25×", "1×", "0.75×", "0.5×"]);
    click(cx, &session, "speed-1.5");
    assert_eq!(read_player(cx, &session, CapsulePlayer::speed), 1.5);
    assert_eq!(read_player(cx, &session, CapsulePlayer::panel), None);

    // 4 held plays at 2×, and letting go goes back to the speed picked.
    cx.update_window(session.handle, |_, window, cx| {
        window.key_down("4", false, cx)
    })
    .unwrap();
    settle(cx, &session);
    cx.update_window(session.handle, |_, window, cx| {
        window.key_down("4", true, cx)
    })
    .unwrap();
    settle(cx, &session);
    assert!(read_player(cx, &session, CapsulePlayer::is_holding_speed));
    assert_eq!(read_player(cx, &session, CapsulePlayer::speed), 2.);
    assert_eq!(
        label(cx, &session, "held-speed").as_deref(),
        Some("Playing at 2×")
    );
    cx.update_window(session.handle, |_, window, cx| window.key_up("4", cx))
        .unwrap();
    settle(cx, &session);
    assert!(!read_player(cx, &session, CapsulePlayer::is_holding_speed));
    assert_eq!(read_player(cx, &session, CapsulePlayer::speed), 1.5);
    assert_eq!(label(cx, &session, "held-speed"), None);

    // → steps to the next item, as in Electron Oriel's viewer, and the next video starts with
    // the level and speed the last one had, and loops as "Loop videos" says.
    press(cx, &session, "right");
    assert_eq!(
        viewer_label(cx, &session).as_deref(),
        Some("Viewer for clip-b.mp4")
    );
    assert_eq!(read_player(cx, &session, CapsulePlayer::speed), 1.5);
    assert_eq!(read_player(cx, &session, CapsulePlayer::volume), volume);
    assert!(!read_player(cx, &session, CapsulePlayer::is_muted));
    assert!(read_player(cx, &session, CapsulePlayer::is_looping));

    // Another mode on screen pauses the video, as Electron Oriel pauses a hidden mode's media,
    // and it is still paused back in View.
    press(cx, &session, "space");
    assert!(read_player(cx, &session, CapsulePlayer::is_playing));
    for mode in [ModeId::Tidy, ModeId::View] {
        cx.update(|cx| session.shell.update(cx, |shell, cx| shell.go(mode, cx)));
        settle(cx, &session);
    }
    assert!(!read_player(cx, &session, CapsulePlayer::is_playing));

    // Show in Tidy asks the app to hand the file to Tidy.
    let asked = Rc::new(RefCell::new(Vec::new()));
    let _subscription = cx.update(|cx| {
        let asked = asked.clone();
        cx.subscribe(&session.view, move |_, event: &ViewEvent, _| {
            asked.borrow_mut().push(event.clone());
        })
    });
    click(cx, &session, "viewer-show-in-tidy");
    assert_eq!(
        *asked.borrow(),
        [ViewEvent::ShowInTidy(fixture.absolute("videos/clip-b.mp4"))]
    );

    press(cx, &session, "escape");
    assert_eq!(viewer_label(cx, &session), None);
}

/// `e` held down steps on as fast as the key repeats, past stills and a video, and never stalls:
/// each repeat lands one item on, with no time for a decode between, and the viewer ends where
/// the steps say, its still drawn. A step from a video to a still once dropped the video's
/// player with the keys, and the next `e` reached nothing.
#[gpui_kit::test]
fn holding_e_steps_past_stills_and_a_video_without_stalling(cx: &mut TestAppContext) {
    let fixture = Fixture::new("hold-e");
    if !fixture.videos {
        eprintln!("skipped: no pinned ffmpeg (cargo run -p oriel-tools --bin fetch-media-tools)");
        return;
    }
    let session = launch(cx, &fixture.root.join("data"));
    open_folder(cx, &session, &fixture.absolute("mixed"));
    let order = tile_paths(cx, &session);
    assert!(
        order.iter().any(|path| path.ends_with("reel.mp4")) && order.len() > 2,
        "stills and a video: {order:?}"
    );
    double_click(cx, &session, tile_id(&order[0]));

    let steps = order.len() * 4 + 1;
    cx.update_window(session.handle, |_, window, cx| {
        window.key_down("e", false, cx);
        for _ in 1..steps {
            window.key_down("e", true, cx);
        }
        window.key_up("e", cx);
    })
    .unwrap();
    let last = order[steps % order.len()]
        .file_name()
        .unwrap()
        .to_string_lossy();
    assert_eq!(
        viewer_label(cx, &session),
        Some(format!("Viewer for {last}")),
        "every repeat stepped"
    );
    settle(cx, &session);
    cx.update(|cx| {
        let viewer = session.view.read(cx).viewer().unwrap().read(cx);
        assert!(viewer.is_current_ready(), "the item shows");
    });
    // And the keys still reach it.
    press(cx, &session, "e");
    let next = order[(steps + 1) % order.len()]
        .file_name()
        .unwrap()
        .to_string_lossy();
    assert_eq!(
        viewer_label(cx, &session),
        Some(format!("Viewer for {next}"))
    );
}

/// `useViewerChromeIdle`: the viewer's controls fade after 2.5 s left alone and a key brings them
/// back; a paused video keeps them.
#[gpui_kit::test]
fn the_viewer_controls_fade_when_left_alone_but_stay_over_a_paused_video(cx: &mut TestAppContext) {
    let fixture = Fixture::new("chrome");
    let session = launch(cx, &fixture.root.join("data"));
    open_folder(cx, &session, &fixture.absolute("comics/alpha"));
    let first = tile_paths(cx, &session)[0].clone();
    double_click(cx, &session, tile_id(&first));
    let chrome = |cx: &mut TestAppContext| {
        cx.update(|cx| {
            session
                .view
                .read(cx)
                .viewer()
                .unwrap()
                .read(cx)
                .is_chrome_visible()
        })
    };
    assert!(chrome(cx));
    assert!(label(cx, &session, "viewer-close").is_some());
    cx.executor()
        .advance_clock(viewer::CHROME_IDLE + Duration::from_millis(100));
    settle(cx, &session);
    assert!(!chrome(cx), "a still's controls fade");
    assert_eq!(label(cx, &session, "viewer-close"), None);
    press(cx, &session, "right");
    assert!(
        chrome(cx),
        "a key brings them back, one bound to a step too"
    );
    press(cx, &session, "escape");

    if !fixture.videos {
        return;
    }
    flip_setting(cx, &session, "autoplay-videos");
    open_folder(cx, &session, &fixture.absolute("videos"));
    double_click(
        cx,
        &session,
        tile_id(&fixture.absolute("videos/clip-a.mp4")),
    );
    cx.executor().advance_clock(viewer::CHROME_IDLE * 2);
    settle(cx, &session);
    assert!(chrome(cx), "a paused video keeps its controls");
    assert!(label(cx, &session, "play-pause").is_some());
}

/// `MediaTile`'s hover: a video tile plays under the pointer, muted and looping by default, and
/// stops when the pointer leaves; with "Autoplay video on hover" off it does not. The tile's
/// caption has the video's picture size from ffprobe, and the header the folder's name.
#[gpui_kit::test]
fn a_video_tile_plays_under_the_pointer_and_stops_when_it_leaves(cx: &mut TestAppContext) {
    let fixture = Fixture::new("hover");
    if !fixture.videos {
        eprintln!("skipped: no pinned ffmpeg (cargo run -p oriel-tools --bin fetch-media-tools)");
        return;
    }
    let session = launch(cx, &fixture.root.join("data"));
    open_folder(cx, &session, &fixture.absolute("videos"));
    // The folder is named once, by its name alone.
    assert_eq!(
        label(cx, &session, "top-bar-title").as_deref(),
        Some("videos")
    );
    assert_eq!(label(cx, &session, "top-bar-meta"), None);
    let clip = fixture.absolute("videos/clip-a.mp4");
    let gallery = cx.update(|cx| session.view.read(cx).gallery().clone());
    let probed = wait_until(cx, &session, |cx| {
        cx.update(|cx| {
            let gallery = gallery.read(cx);
            gallery
                .media()
                .iter()
                .find(|entry| MediaEntry::path(entry).as_ref() == clip.as_path())
                .and_then(|entry| gallery.video_probe(entry))
                .is_some_and(|probe| probe.width == Some(320) && probe.height == Some(180))
        })
    });
    assert!(probed, "ffprobe reads the size the caption shows");

    let preview = |cx: &mut TestAppContext| {
        cx.update(|cx| {
            gallery.read(cx).preview().map(|(path, preview)| {
                let preview = preview.read(cx);
                (path.to_path_buf(), preview.is_muted(), preview.is_looping())
            })
        })
    };
    cx.update_window(session.handle, |_, window, cx| {
        window.hover(tile_id(&clip), cx)
    })
    .unwrap();
    settle(cx, &session);
    assert_eq!(preview(cx), None, "it waits for the pointer to rest");
    cx.executor()
        .advance_clock(HOVER_DELAY + Duration::from_millis(50));
    settle(cx, &session);
    assert_eq!(preview(cx), Some((clip.clone(), true, true)));

    cx.update_window(session.handle, |_, window, cx| {
        window.hover("open-folder", cx)
    })
    .unwrap();
    settle(cx, &session);
    assert_eq!(preview(cx), None, "the pointer left the tile");

    // Sound on: the next preview plays with it.
    flip_setting(cx, &session, "preview-audio");
    cx.update_window(session.handle, |_, window, cx| {
        window.hover(tile_id(&clip), cx)
    })
    .unwrap();
    cx.executor()
        .advance_clock(HOVER_DELAY + Duration::from_millis(50));
    settle(cx, &session);
    assert_eq!(preview(cx), Some((clip.clone(), false, true)));

    // Opening the viewer stops it.
    double_click(cx, &session, tile_id(&clip));
    assert_eq!(preview(cx), None);
    press(cx, &session, "escape");

    flip_setting(cx, &session, "autoplay-on-hover");
    cx.update_window(session.handle, |_, window, cx| {
        window.hover("open-folder", cx)
    })
    .unwrap();
    cx.update_window(session.handle, |_, window, cx| {
        window.hover(tile_id(&clip), cx)
    })
    .unwrap();
    cx.executor()
        .advance_clock(HOVER_DELAY + Duration::from_millis(50));
    settle(cx, &session);
    assert_eq!(preview(cx), None, "autoplay on hover is off");
    cx.update(|cx| assert_eq!(gallery.read(cx).hovered_video(), None));
}

/// `MediaTile`'s hover caption: the tile under the pointer shows its name and size over the
/// bottom of its picture, and no other tile shows one, the pointer moving from tile to tile or
/// off the grid.
#[gpui_kit::test]
fn only_the_tile_under_the_pointer_shows_its_caption(cx: &mut TestAppContext) {
    let fixture = Fixture::new("caption");
    let session = launch(cx, &fixture.root.join("data"));
    open_folder(cx, &session, &fixture.absolute("comics/alpha"));
    let caption = |cx: &mut TestAppContext| {
        cx.update_window(session.handle, |_, window, _| {
            window.try_find(CAPTION_ID).map(|caption| caption.bounds())
        })
        .unwrap()
    };
    let tile = |cx: &mut TestAppContext, path: &Path| {
        cx.update_window(session.handle, |_, window, _| {
            window.find(tile_id(path)).bounds()
        })
        .unwrap()
    };
    assert_eq!(caption(cx), None, "no tile is under the pointer");

    for name in ["1.jpg", "2.jpg"] {
        let path = fixture.absolute(&format!("comics/alpha/{name}"));
        cx.update_window(session.handle, |_, window, cx| {
            window.hover(tile_id(&path), cx)
        })
        .unwrap();
        settle(cx, &session);
        let shown = caption(cx).expect("the tile under the pointer shows its caption");
        let tile = tile(cx, &path);
        let (inside, corner) = (shown.origin, shown.bottom_right());
        assert!(
            inside.x >= tile.origin.x
                && inside.y >= tile.origin.y
                && corner.x <= tile.bottom_right().x
                && corner.y <= tile.bottom_right().y,
            "{name}'s caption {shown:?} is over its tile {tile:?}"
        );
    }

    cx.update_window(session.handle, |_, window, cx| {
        window.hover("open-folder", cx)
    })
    .unwrap();
    settle(cx, &session);
    assert_eq!(caption(cx), None, "the pointer left the grid");
}

#[gpui_kit::test]
fn comic_mode_groups_leaf_folders_and_the_reader_opens_one(cx: &mut TestAppContext) {
    let fixture = Fixture::new("comics");
    let session = launch(cx, &fixture.root.join("data"));
    open_folder(cx, &session, &fixture.absolute("comics"));
    click(cx, &session, "comic");

    assert_eq!(
        label(cx, &session, "gallery-count").as_deref(),
        Some("3 comics")
    );
    assert_eq!(
        tile_paths(cx, &session),
        ["comics/alpha", "comics/beta", "comics/nested/inner"].map(|path| fixture.absolute(path))
    );
    let alpha = format!("comic:{}", fixture.absolute("comics/alpha").display());
    double_click(cx, &session, ElementId::Name(alpha.into()));
    assert_eq!(
        label(cx, &session, "comic-reader").as_deref(),
        Some("Comic reader for alpha")
    );
    assert_eq!(
        label(cx, &session, "comic-page-count").as_deref(),
        Some("1/5 pages")
    );
    press(cx, &session, "right");
    assert_eq!(
        label(cx, &session, "comic-page-count").as_deref(),
        Some("2/5 pages")
    );
    cx.update(|cx| {
        let reader = session.view.read(cx).comic_reader().unwrap().read(cx);
        assert!(reader.is_page_ready(1), "the page in view is decoded");
    });
    assert_eq!(
        label(cx, &session, "comic-scroll-top").as_deref(),
        Some("Scroll to top")
    );
    assert_eq!(
        label(cx, &session, "comic-reveal").as_deref(),
        Some("Reveal in folder")
    );
    click(cx, &session, "comic-close");
    assert_eq!(label(cx, &session, "comic-reader"), None);

    // Comic mode is the folder's, kept across scans; turning Recursive off turns it off.
    cx.update(|cx| assert!(session.view.read(cx).comic_mode(cx)));
    click(cx, &session, "recursive");
    cx.update(|cx| assert!(!session.view.read(cx).comic_mode(cx)));
    assert_eq!(
        label(cx, &session, "gallery-folders").as_deref(),
        Some("3 folders")
    );
}

/// The role and the name VoiceOver reads for the element `id`.
fn role_and_name(
    cx: &mut TestAppContext,
    session: &Session,
    id: impl Into<ElementId>,
) -> (Option<Role>, Option<String>) {
    let id = id.into();
    cx.update_window(session.handle, |_, window, _| {
        let element = window.find(id);
        (element.role(), element.label().map(str::to_owned))
    })
    .unwrap()
}

#[gpui_kit::test]
fn voiceover_reads_views_sidebar_and_icon_buttons_by_name(cx: &mut TestAppContext) {
    let fixture = Fixture::new("names");
    let session = launch(cx, &fixture.root.join("data"));
    open_folder(cx, &session, &fixture.absolute("comics"));
    let named = |name: &str| (Some(Role::Button), Some(name.to_owned()));

    assert_eq!(
        role_and_name(cx, &session, "view-sidebar"),
        (Some(Role::Navigation), Some("View".to_owned()))
    );
    assert_eq!(
        role_and_name(cx, &session, "location-switcher"),
        named("comics")
    );
    let alpha = fixture.absolute("comics/alpha");
    click(
        cx,
        &session,
        ElementId::Name(format!("sidebar-folder:{}", alpha.display()).into()),
    );
    assert_eq!(
        role_and_name(cx, &session, "sidebar-up"),
        named("Up to comics")
    );

    // The viewer's icon buttons are read by what they do.
    let first = tile_paths(cx, &session)[0].clone();
    double_click(cx, &session, tile_id(&first));
    for (id, name) in [
        ("viewer-copy-path", "Copy path"),
        ("viewer-reveal", "Reveal in folder"),
        ("viewer-show-in-tidy", "Show in Tidy"),
        ("viewer-fullscreen", "Fullscreen"),
        ("viewer-close", "Close"),
    ] {
        assert_eq!(role_and_name(cx, &session, id), named(name), "{id}");
    }
    press(cx, &session, "escape");

    // The rail's icons keep their names.
    session.shell.update(cx, |shell, cx| shell.toggle_rail(cx));
    settle(cx, &session);
    assert_eq!(
        role_and_name(cx, &session, "view-sidebar"),
        (Some(Role::Navigation), Some("View".to_owned()))
    );
    assert_eq!(
        role_and_name(cx, &session, "location-switcher"),
        named("comics")
    );
    assert_eq!(
        role_and_name(cx, &session, "sidebar-parent"),
        named("Up to the parent folder")
    );
}

#[gpui_kit::test]
fn a_relaunch_restores_the_remembered_folder(cx: &mut TestAppContext) {
    let fixture = Fixture::new("relaunch");
    let data = fixture.root.join("data");
    let session = launch(cx, &data);
    open_folder(cx, &session, &fixture.absolute("unicode"));
    assert_eq!(tile_paths(cx, &session).len(), 2);
    cx.update_window(session.handle, |_, window, _| window.remove_window())
        .unwrap();
    cx.run_until_parked();

    let session = launch(cx, &data);
    settle(cx, &session);
    let mut tiles = tile_paths(cx, &session);
    tiles.sort();
    let mut expected: Vec<PathBuf> = fixture
        .in_scope("unicode", false)
        .iter()
        .map(|item| fixture.absolute(&item.path))
        .collect();
    expected.sort();
    assert_eq!(tiles, expected);
}

#[gpui_kit::test]
fn folders_open_from_their_tiles_and_step_back_up_to_the_opened_one(cx: &mut TestAppContext) {
    let fixture = Fixture::new("steps");
    let session = launch(cx, &fixture.root.join("data"));
    open_folder(cx, &session, &fixture.absolute("comics"));
    let nested = fixture.absolute("comics/nested");
    double_click(
        cx,
        &session,
        ElementId::Name(format!("folder:{}", nested.display()).into()),
    );
    cx.update(|cx| {
        assert_eq!(
            session.view.read(cx).folder(cx).as_deref(),
            Some(nested.as_path())
        )
    });
    assert_eq!(
        label(cx, &session, "gallery-folders").as_deref(),
        Some("1 folders")
    );

    // The next sibling folder, then up: the folder stepped out of is selected again.
    click(cx, &session, "previous-folder");
    let beta = fixture.absolute("comics/beta");
    cx.update(|cx| {
        assert_eq!(
            session.view.read(cx).folder(cx).as_deref(),
            Some(beta.as_path())
        )
    });
    click(cx, &session, "parent-folder");
    cx.update(|cx| {
        let view = session.view.read(cx);
        assert_eq!(
            view.folder(cx).as_deref(),
            Some(fixture.absolute("comics").as_path())
        );
        assert_eq!(
            view.gallery()
                .read(cx)
                .selected_key()
                .map(|key| key.to_string()),
            Some(format!("folder:{}", beta.display()))
        );
    });
    // The opened folder is the top: no parent above it.
    cx.update(|cx| assert!(session.view.read(cx).gallery().read(cx).listing() == &Listing::Listed));
    cx.update_window(session.handle, |_, window, _| {
        let parent = window.find("parent-folder");
        assert_eq!(
            parent.disabled(),
            Some(true),
            "View does not step above the opened folder"
        );
    })
    .unwrap();
}

/// `useGalleryKeyboardNavigation`: the arrows wrap past either end of the list, with ⇧ held too,
/// and ⇧S opens the first folder when the tile selected is not one. Escape closes the sort menu,
/// as `GalleryToolbar` listens for it.
#[gpui_kit::test]
fn the_gallery_keys_wrap_at_the_ends_and_shift_s_finds_a_folder(cx: &mut TestAppContext) {
    let fixture = Fixture::new("wrap");
    let session = launch(cx, &fixture.root.join("data"));
    open_folder(cx, &session, &fixture.archive);
    let tiles = tile_paths(cx, &session);
    let selected = |cx: &mut TestAppContext| {
        cx.update(|cx| session.view.read(cx).gallery().read(cx).selected_index())
    };
    click(
        cx,
        &session,
        ElementId::Name(format!("folder:{}", tiles[0].display()).into()),
    );
    assert_eq!(selected(cx), Some(0));
    press(cx, &session, "left");
    assert_eq!(
        selected(cx),
        Some(tiles.len() - 1),
        "← on the first tile selects the last"
    );
    press(cx, &session, "shift-right");
    assert_eq!(
        selected(cx),
        Some(0),
        "→ on the last wraps, with ⇧ held too"
    );

    click(cx, &session, "sort");
    assert_eq!(label(cx, &session, "sort-menu").as_deref(), Some("Sort"));
    press(cx, &session, "escape");
    assert_eq!(label(cx, &session, "sort-menu"), None);

    // The last tile is the folder's one image, so ⇧S opens the first folder.
    press(cx, &session, "a");
    assert_eq!(selected(cx), Some(tiles.len() - 1));
    press(cx, &session, "shift-s");
    cx.update(|cx| {
        assert_eq!(
            session.view.read(cx).folder(cx).as_deref(),
            Some(tiles[0].as_path())
        )
    });
}

/// The reader's top bar fades when left alone, as the viewer's does, and a key brings it back.
#[gpui_kit::test]
fn the_comic_readers_top_bar_fades_when_left_alone(cx: &mut TestAppContext) {
    let fixture = Fixture::new("reader-chrome");
    let session = launch(cx, &fixture.root.join("data"));
    open_folder(cx, &session, &fixture.absolute("comics"));
    click(cx, &session, "comic");
    let alpha = format!("comic:{}", fixture.absolute("comics/alpha").display());
    double_click(cx, &session, ElementId::Name(alpha.into()));
    let chrome = |cx: &mut TestAppContext| {
        cx.update(|cx| {
            session
                .view
                .read(cx)
                .comic_reader()
                .unwrap()
                .read(cx)
                .is_chrome_visible()
        })
    };
    assert!(chrome(cx));
    cx.executor()
        .advance_clock(viewer::CHROME_IDLE + Duration::from_millis(100));
    settle(cx, &session);
    assert!(!chrome(cx), "the top bar fades");
    assert_eq!(label(cx, &session, "comic-close"), None);
    press(cx, &session, "right");
    assert!(chrome(cx), "a key brings it back");
    assert_eq!(
        label(cx, &session, "comic-page-count").as_deref(),
        Some("2/5 pages")
    );
}

#[gpui_kit::test]
fn the_index_records_each_scan_and_the_shell_sees_the_work(cx: &mut TestAppContext) {
    let fixture = Fixture::new("index");
    let session = launch(cx, &fixture.root.join("data"));
    cx.update(|cx| {
        session.view.update(cx, |view, cx| {
            view.open_folder(fixture.absolute("mixed"), cx);
        });
        assert_eq!(
            session.shell.read(cx).activity(ModeId::View),
            Some(ModeActivity::Working),
            "a running scan shows on the switcher"
        );
    });
    settle(cx, &session);
    cx.update(|cx| assert_eq!(session.shell.read(cx).activity(ModeId::View), None));

    let index = futures::executor::block_on(oriel_core_index::MediaIndex::open_in(
        &fixture.root.join("data/view"),
    ))
    .unwrap();
    let rows = futures::executor::block_on(index.rows()).unwrap();
    assert_eq!(rows.len(), fixture.in_scope("mixed", false).len());
    assert!(
        rows.iter()
            .all(|row| row.root_path == fixture.absolute("mixed").to_string_lossy())
    );
}

/// The shell hands View the paths the system opens with the app; a file opens in the viewer
/// once its folder's scan has listed it (`links.spec.ts`' hand-over, View's side).
#[gpui_kit::test]
fn a_file_handed_to_view_opens_in_the_viewer_after_its_folder_scans(cx: &mut TestAppContext) {
    let fixture = Fixture::new("hand-over");
    let session = launch(cx, &fixture.root.join("data"));
    let file = fixture.absolute("comics/alpha/10.jpg");
    cx.update_window(session.handle, |_, window, cx| {
        session
            .view
            .update(cx, |view, cx| view.open_path(file.clone(), window, cx));
    })
    .unwrap();
    settle(cx, &session);
    cx.update(|cx| {
        assert_eq!(
            session.view.read(cx).folder(cx).as_deref(),
            Some(fixture.absolute("comics/alpha").as_path())
        );
    });
    assert_eq!(
        viewer_label(cx, &session).as_deref(),
        Some("Viewer for 10.jpg")
    );
}

#[gpui_kit::test]
fn escape_returns_to_the_same_scroll_position(cx: &mut TestAppContext) {
    let fixture = Fixture::new("scroll");
    let session = launch(cx, &fixture.root.join("data"));
    open_folder(cx, &session, &fixture.absolute("bulk"));
    cx.update_window(session.handle, |_, window, cx| {
        window.scroll(
            "gallery",
            ScrollDelta::Pixels(point(px(0.), px(-1000.))),
            cx,
        );
    })
    .unwrap();
    settle(cx, &session);
    let offset = |cx: &mut TestAppContext| {
        cx.update(|cx| {
            session
                .view
                .read(cx)
                .gallery()
                .read(cx)
                .scroll_handle()
                .0
                .borrow()
                .base_handle
                .offset()
        })
    };
    let scrolled = offset(cx);
    assert!(
        scrolled.y < px(-500.),
        "the wheel scrolled the grid: {scrolled:?}"
    );

    // Row 8 (items 32 to 35) is in view 1000 px down.
    let order = tile_paths(cx, &session);
    double_click(cx, &session, tile_id(&order[33]));
    press(cx, &session, "right");
    press(cx, &session, "escape");
    assert_eq!(viewer_label(cx, &session), None);
    assert_eq!(offset(cx), scrolled, "the grid is where it was");
    cx.update(|cx| {
        assert_eq!(
            session.view.read(cx).gallery().read(cx).selected(),
            Some(34)
        )
    });
}

/// The gallery's thumbnails go through its own bounded cache. An `img()` that misses it keeps
/// its decoded image in the App's asset cache for good, which is how scrolling 20,000 tiles once
/// held 11 GB.
#[gpui_kit::test]
fn scrolled_thumbnails_stay_out_of_the_apps_asset_cache(cx: &mut TestAppContext) {
    let fixture = Fixture::new("bounded");
    let session = launch(cx, &fixture.root.join("data"));
    open_folder(cx, &session, &fixture.absolute("bulk"));
    for _ in 0..3 {
        cx.update_window(session.handle, |_, window, cx| {
            window.scroll("gallery", ScrollDelta::Pixels(point(px(0.), px(-700.))), cx);
        })
        .unwrap();
        settle(cx, &session);
    }
    cx.update(|cx| {
        let gallery = session.view.read(cx).gallery().read(cx);
        let thumbnails = gallery.thumbnails().read(cx);
        let ready: Vec<_> = gallery
            .media()
            .iter()
            .filter_map(|media| match thumbnails.thumbnail(media) {
                Thumbnail::Ready(path) => Some(path),
                _ => None,
            })
            .collect();
        assert!(
            ready.len() > 40,
            "only {} thumbnails were made",
            ready.len()
        );
        for path in ready {
            assert!(
                !ImageSource::from(path.clone()).is_asset_cached(cx),
                "{} is in the App's asset cache",
                path.display()
            );
        }
    });
}

/// A row partly in view at either edge is drawn with its thumbnail, at the bottom too, where the
/// grid's rows scroll under the floating toolbar: GPUI's list counts its rows down to its padded
/// bottom only, and a row whose top was in that room showed as background until it scrolled up.
#[gpui_kit::test]
fn a_row_half_in_view_at_either_edge_is_drawn_with_its_thumbnails(cx: &mut TestAppContext) {
    let fixture = Fixture::new("edge-rows");
    let session = launch(cx, &fixture.root.join("data"));
    open_folder(cx, &session, &fixture.absolute("bulk"));
    let gallery = cx.update(|cx| session.view.read(cx).gallery().clone());
    let area = cx
        .update_window(session.handle, |_, window, _| {
            window.find("gallery").bounds()
        })
        .unwrap();

    // Four 256 × 144 tiles to a row, 154 px apart, under the grid's 16 px top inset. Row 8 is
    // scrolled to show its top half at the gallery's bottom edge.
    let (stride, inset, row) = (154., 16., 8);
    let height = f32::from(area.size.height);
    let scroll_top = inset + row as f32 * stride - (height - 77.);
    assert!(
        scroll_top > 0.,
        "the gallery is taller than the test assumes"
    );
    cx.update(|cx| {
        let handle = gallery
            .read(cx)
            .scroll_handle()
            .0
            .borrow()
            .base_handle
            .clone();
        handle.set_offset(point(px(0.), px(-scroll_top)));
    });
    settle(cx, &session);

    let order = tile_paths(cx, &session);
    let top_row = ((scroll_top - inset) / stride).floor() as usize;
    assert!(
        inset + top_row as f32 * stride < scroll_top,
        "the top row is only partly in view"
    );
    cx.update(|cx| {
        let gallery = gallery.read(cx);
        assert_eq!(gallery.drawn_rows(), top_row..row + 1);
        assert!(gallery.is_drawn_complete(), "a drawn tile has no picture");
        let thumbnails = gallery.thumbnails().read(cx);
        for media in &gallery.media()[row * 4..row * 4 + 4] {
            assert!(
                matches!(thumbnails.thumbnail(media), Thumbnail::Ready(_)),
                "{} has no thumbnail",
                media.path().display()
            );
        }
    });
    cx.update_window(session.handle, |_, window, _| {
        for (edge, row) in [("top", top_row), ("bottom", row)] {
            for path in &order[row * 4..row * 4 + 4] {
                let tile = window.try_find(tile_id(path));
                let tile = tile.unwrap_or_else(|| panic!("the {edge} row's {path:?} is not drawn"));
                let top = f32::from(tile.bounds().origin.y - area.origin.y);
                let expected = inset + row as f32 * stride - scroll_top;
                assert!(
                    (top - expected).abs() < 0.5,
                    "the {edge} row is at {top}, not {expected}"
                );
            }
        }
    })
    .unwrap();
}
