//! The gallery's cases from Electron Oriel's `e2e/tests/frame-view/gallery.spec.ts` that Phase 0
//! has: opening a folder lists its media in order with a thumbnail for each, a double-click opens
//! the viewer, the arrows and the step buttons walk the grid's order and wrap, and Escape returns
//! to the gallery where it was.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use gpui_kit::test::TestWindowExt as _;
use gpui_kit::{
    AnyWindowHandle, AppContext as _, Bounds, ElementId, Entity, ImageSource, ScrollDelta,
    TestAppContext, WindowBounds, WindowOptions, point, px, size,
};
use oriel_core_paths::DataRoot;
use oriel_media::still::{Still, WebpSettings};
use oriel_mode_view::thumbnails::Thumbnail;
use oriel_mode_view::{Listing, ViewMode};
use oriel_ui::{ModeId, ShellState};

/// A folder of its own under the temp folder, emptied first.
fn scratch(test: &str) -> PathBuf {
    let folder = std::env::temp_dir()
        .join("oriel-mode-view-gallery-tests")
        .join(format!("{test}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&folder);
    std::fs::create_dir_all(&folder).unwrap();
    folder
}

/// A small WebP still of one color at `path`. ImageIO reads WebP, and libwebp writes it.
fn write_still(path: &Path, shade: u8) {
    let (width, height) = (64u32, 36u32);
    let bgra = [shade, 128, 255 - shade, 255].repeat((width * height) as usize);
    let still = Still::from_bgra(width, height, bgra, true).unwrap();
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(
        path,
        still.encode_webp(WebpSettings::lossy(80., 0)).unwrap(),
    )
    .unwrap();
}

/// A folder of `count` stills named `still-000.webp` on, the first few in a subfolder so the
/// listing must recurse, and a file the gallery does not show.
fn archive(test: &str, count: usize) -> (PathBuf, PathBuf) {
    let root = scratch(test);
    let archive = root.join("archive");
    for ix in 0..count {
        let folder = if ix < 2 {
            archive.join("nested")
        } else {
            archive.clone()
        };
        write_still(
            &folder.join(format!("still-{ix:03}.webp")),
            (ix * 37 % 256) as u8,
        );
    }
    std::fs::write(archive.join("notes.txt"), b"not media").unwrap();
    (root, archive)
}

fn tile(archive: &Path, ix: usize) -> ElementId {
    let folder = if ix < 2 {
        archive.join("nested")
    } else {
        archive.to_path_buf()
    };
    ElementId::Path(Arc::from(folder.join(format!("still-{ix:03}.webp"))))
}

fn open_view(cx: &mut TestAppContext, root: &Path) -> (AnyWindowHandle, Entity<ViewMode>) {
    cx.update(|cx| {
        gpui_kit::init(cx);
        oriel_ui::theme::init(cx);
    });
    let data = DataRoot::at(root.join("data")).unwrap();
    cx.update(|cx| {
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
                let shell = cx.new(|_| ShellState::new(ModeId::View, false));
                cx.new(|cx| ViewMode::with_data(&shell, &data, window, cx))
            },
        )
        .expect("open the test window")
    })
}

/// Opens `archive` through the Open button and the system's folder picker, and waits for the
/// listing and its thumbnails.
fn open_through_the_picker(cx: &mut TestAppContext, handle: AnyWindowHandle, archive: &Path) {
    cx.update_window(handle, |_, window, cx| {
        window.render_frame(cx);
        assert_eq!(
            window.find("gallery-message").label(),
            Some("Open a folder to see its gallery.")
        );
        window.click("open-folder", cx);
    })
    .unwrap();
    assert!(cx.did_prompt_for_paths());
    let chosen = archive.to_path_buf();
    cx.simulate_path_prompt_response(move |options| {
        assert!(options.directories && !options.files);
        Some(vec![chosen])
    });
    settle(cx, handle);
}

/// Lets the background work (listing, thumbnails, decodes) finish and draws the result.
fn settle(cx: &mut TestAppContext, handle: AnyWindowHandle) {
    for _ in 0..4 {
        cx.run_until_parked();
        cx.update_window(handle, |_, window, cx| window.render_frame(cx))
            .unwrap();
    }
}

fn viewer_label(cx: &mut TestAppContext, handle: AnyWindowHandle) -> Option<String> {
    cx.update_window(handle, |_, window, _| {
        window
            .try_find("viewer")
            .and_then(|viewer| viewer.label().map(str::to_owned))
    })
    .unwrap()
}

#[gpui_kit::test]
fn opens_a_folder_and_lists_its_media_with_thumbnails(cx: &mut TestAppContext) {
    let (root, archive) = archive("lists", 6);
    let (handle, view) = open_view(cx, &root);
    open_through_the_picker(cx, handle, &archive);

    let names: Vec<String> = cx.update(|cx| {
        let gallery = view.read(cx).gallery().read(cx);
        assert_eq!(*gallery.listing(), Listing::Listed);
        gallery
            .entries()
            .iter()
            .map(|entry| entry.name().to_string())
            .collect()
    });
    let expected: Vec<String> = (0..6).map(|ix| format!("still-{ix:03}.webp")).collect();
    assert_eq!(
        names, expected,
        "recursive, by name, the text file left out"
    );

    cx.update_window(handle, |_, window, _| {
        assert_eq!(window.find("gallery-count").label(), Some("6 items"));
        // Four 256 × 144 tiles to a row at this width, in the listing's order.
        let first = window.find(tile(&archive, 0)).bounds();
        let second = window.find(tile(&archive, 1)).bounds();
        let fifth = window.find(tile(&archive, 4)).bounds();
        assert_eq!((first.size.width, first.size.height), (px(256.), px(144.)));
        assert_eq!(second.top(), first.top());
        assert_eq!(second.left() - first.right(), px(10.));
        assert_eq!(fifth.left(), first.left());
        assert_eq!(fifth.top() - first.bottom(), px(10.));
    })
    .unwrap();

    // Every tile's thumbnail is made, written under View's folder, and drawn.
    let thumbnails = root.join("data/view/thumbnails");
    let written = std::fs::read_dir(&thumbnails)
        .unwrap()
        .filter(|file| {
            file.as_ref()
                .is_ok_and(|file| file.path().extension().is_some_and(|ext| ext == "webp"))
        })
        .count();
    assert_eq!(written, 6);
    cx.update(|cx| {
        let gallery = view.read(cx).gallery().read(cx);
        assert_eq!(gallery.thumbnails().read(cx).stats().generated(), 6);
        assert!(
            gallery.is_drawn_complete(),
            "a tile is still on its placeholder"
        );
    });
}

#[gpui_kit::test]
fn double_click_opens_the_viewer_the_arrows_step_and_escape_returns(cx: &mut TestAppContext) {
    let (root, archive) = archive("viewer", 5);
    let (handle, view) = open_view(cx, &root);
    open_through_the_picker(cx, handle, &archive);

    cx.update_window(handle, |_, window, cx| {
        window.double_click(tile(&archive, 1), cx)
    })
    .unwrap();
    settle(cx, handle);
    assert_eq!(
        viewer_label(cx, handle).as_deref(),
        Some("Viewer for still-001.webp")
    );
    cx.update(|cx| {
        let viewer = view.read(cx).viewer().expect("the viewer is open").read(cx);
        assert!(viewer.is_current_ready(), "the still is decoded");
    });
    cx.update_window(handle, |_, window, _| {
        assert!(
            window.try_find("gallery-count").is_none(),
            "the viewer fills the window"
        );
    })
    .unwrap();

    let step =
        |cx: &mut TestAppContext, key: Option<&'static str>, button: Option<&'static str>| {
            cx.update_window(handle, move |_, window, cx| {
                if let Some(key) = key {
                    window.press(key, cx);
                }
                if let Some(button) = button {
                    window.click(button, cx);
                }
            })
            .unwrap();
            settle(cx, handle);
            viewer_label(cx, handle)
        };
    assert_eq!(
        step(cx, Some("right"), None).as_deref(),
        Some("Viewer for still-002.webp")
    );
    assert_eq!(
        step(cx, None, Some("viewer-next")).as_deref(),
        Some("Viewer for still-003.webp")
    );
    assert_eq!(
        step(cx, Some("left"), None).as_deref(),
        Some("Viewer for still-002.webp")
    );
    // Stepping wraps, as `loopViewerNavigation` does by default.
    step(cx, Some("left"), None);
    step(cx, Some("left"), None);
    assert_eq!(
        step(cx, None, Some("viewer-previous")).as_deref(),
        Some("Viewer for still-004.webp")
    );
    assert_eq!(
        step(cx, Some("e"), None).as_deref(),
        Some("Viewer for still-000.webp")
    );

    let viewer = cx.update(|cx| view.read(cx).viewer().unwrap().downgrade());
    assert_eq!(step(cx, Some("escape"), None), None);
    cx.run_until_parked();
    // A closed viewer is released, and with it its decoded stills.
    assert!(
        viewer.upgrade().is_none(),
        "the closed viewer is still alive"
    );
    cx.update_window(handle, |_, window, _| {
        assert_eq!(window.find("gallery-count").label(), Some("5 items"));
    })
    .unwrap();
    cx.update(|cx| {
        assert!(view.read(cx).viewer().is_none());
        assert_eq!(view.read(cx).gallery().read(cx).selected(), Some(0));
    });
}

#[gpui_kit::test]
fn escape_returns_to_the_same_scroll_position(cx: &mut TestAppContext) {
    // Ninety stills: 23 rows of four, far taller than the window.
    let (root, archive) = archive("scroll", 90);
    let (handle, view) = open_view(cx, &root);
    open_through_the_picker(cx, handle, &archive);

    cx.update_window(handle, |_, window, cx| {
        window.scroll(
            "gallery",
            ScrollDelta::Pixels(point(px(0.), px(-1000.))),
            cx,
        );
    })
    .unwrap();
    settle(cx, handle);
    let offset = |cx: &mut TestAppContext| {
        cx.update(|cx| {
            view.read(cx)
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
    cx.update_window(handle, |_, window, cx| {
        window.double_click(tile(&archive, 33), cx)
    })
    .unwrap();
    settle(cx, handle);
    assert_eq!(
        viewer_label(cx, handle).as_deref(),
        Some("Viewer for still-033.webp")
    );
    cx.update_window(handle, |_, window, cx| {
        window.press("right", cx);
        window.press("escape", cx);
    })
    .unwrap();
    settle(cx, handle);

    assert_eq!(viewer_label(cx, handle), None);
    assert_eq!(offset(cx), scrolled, "the grid is where it was");
    cx.update(|cx| assert_eq!(view.read(cx).gallery().read(cx).selected(), Some(34)));
    cx.update_window(handle, |_, window, _| {
        assert!(window.find(tile(&archive, 34)).visible());
    })
    .unwrap();
}

/// The gallery's thumbnails go through its own bounded cache. An `img()` that misses it keeps
/// its decoded image in the App's asset cache for good, which is how scrolling 20,000 tiles once
/// held 11 GB.
#[gpui_kit::test]
fn scrolled_thumbnails_stay_out_of_the_apps_asset_cache(cx: &mut TestAppContext) {
    let (root, archive) = archive("bounded", 90);
    let (handle, view) = open_view(cx, &root);
    open_through_the_picker(cx, handle, &archive);
    for _ in 0..3 {
        cx.update_window(handle, |_, window, cx| {
            window.scroll("gallery", ScrollDelta::Pixels(point(px(0.), px(-700.))), cx);
        })
        .unwrap();
        settle(cx, handle);
    }

    cx.update(|cx| {
        let gallery = view.read(cx).gallery().read(cx);
        let thumbnails = gallery.thumbnails().read(cx);
        let ready: Vec<_> = (0..gallery.entries().len())
            .filter_map(|ix| match thumbnails.thumbnail(ix) {
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
