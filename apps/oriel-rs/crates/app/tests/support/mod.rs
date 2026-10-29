//! What the cases that drive the whole shell share: a data folder and an archive of their own
//! under the temp folder (which Tidy's sandbox admits), the shell in a test window, and waiting
//! on the modes' own threads.

// Each test binary uses part of this.
#![allow(dead_code)]

use std::cell::Cell;
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::time::{Duration, Instant};

use gpui_kit::test::TestWindowExt as _;
use gpui_kit::{
    AnyWindowHandle, App, AppContext as _, Bounds, ElementId, Entity, Focusable as _,
    TestAppContext, VisualTestContext, WindowBounds, WindowOptions, px, size,
};
use oriel_core_paths::DataRoot;
use oriel_media::still::{Still, WebpSettings};
use oriel_mode_view::catalog::ScanState;
use oriel_rs::quit::QuitPlatform;
use oriel_rs::shell::Shell;
use oriel_ui::{LocalStorage, ModeId};

/// A folder of its own under the temp folder, emptied first, with symlinks resolved (the temp
/// folder is behind one on macOS, and View and Tidy keep resolved paths).
pub fn scratch(test: &str) -> PathBuf {
    let folder = std::env::temp_dir()
        .join("oriel-rs-shell-tests")
        .join(format!("{test}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&folder);
    std::fs::create_dir_all(&folder).unwrap();
    std::fs::canonicalize(folder).unwrap()
}

/// A small WebP still of one colour at `path`.
pub fn write_still(path: &Path, shade: u8) {
    let (width, height) = (48u32, 27u32);
    let bgra = [shade, 128, 255 - shade, 255].repeat((width * height) as usize);
    let still = Still::from_bgra(width, height, bgra, true).unwrap();
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(
        path,
        still.encode_webp(WebpSettings::lossy(80., 0)).unwrap(),
    )
    .unwrap();
}

/// An archive shaped like the e2e fixture's top: a still at the top and a `bulk` folder of
/// stills, named as the spec names them.
pub fn write_archive(archive: &Path) {
    write_still(&archive.join("root-image.webp"), 10);
    for ix in 1..=3u8 {
        write_still(&archive.join(format!("bulk/bulk-{ix:03}.webp")), ix * 60);
    }
}

/// Stands in for hiding and quitting the app, which the test platform cannot do.
#[derive(Default)]
pub struct Recorder {
    pub hides: Cell<usize>,
    pub quits: Cell<usize>,
}

impl QuitPlatform for Recorder {
    fn hide(&self, _: &mut App) {
        self.hides.set(self.hides.get() + 1);
    }

    fn quit(&self, _: &mut App) {
        self.quits.set(self.quits.get() + 1);
    }
}

pub struct Opened {
    pub handle: AnyWindowHandle,
    pub shell: Entity<Shell>,
}

/// GPUI Kit, the store of preferences in `data`'s shell folder, the theme and the keys, as the
/// app starts them. Tidy's engine and View's scans run on threads of their own, so the scheduler
/// may wait for them.
pub fn start(cx: &mut TestAppContext, data: &DataRoot) {
    cx.executor().allow_parking();
    data.create_folders().unwrap();
    cx.update(|cx| {
        gpui_kit::init(cx);
        LocalStorage::init(LocalStorage::open(&data.shell()), cx);
        oriel_ui::theme::init(cx);
        oriel_rs::actions::init(cx);
    });
}

pub fn open_shell(cx: &mut TestAppContext, data: &DataRoot) -> Opened {
    let (handle, shell) = cx.update(|cx| {
        let platform: Rc<dyn QuitPlatform> = Rc::new(Recorder::default());
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
                let shell = cx.new(|cx| Shell::with_data(data.clone(), platform, window, cx));
                shell.focus_handle(cx).focus(window, cx);
                shell
            },
        )
        .expect("open the test window")
    });
    frame(cx, handle);
    Opened { handle, shell }
}

pub fn frame(cx: &mut TestAppContext, handle: AnyWindowHandle) {
    cx.run_until_parked();
    cx.update_window(handle, |_, window, cx| window.render_frame(cx))
        .unwrap();
}

/// Lets the modes' threads, their timers and the app's tasks run until `done` holds.
pub fn wait_until(
    cx: &mut TestAppContext,
    handle: AnyWindowHandle,
    what: &str,
    done: impl Fn(&mut TestAppContext) -> bool,
) {
    let deadline = Instant::now() + Duration::from_secs(120);
    loop {
        frame(cx, handle);
        if done(cx) {
            // What the change set off draws once more.
            frame(cx, handle);
            return;
        }
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        cx.executor().advance_clock(Duration::from_millis(20));
        std::thread::sleep(Duration::from_millis(10));
    }
}

pub fn press(cx: &mut TestAppContext, handle: AnyWindowHandle, key: &str) {
    cx.update_window(handle, |_, window, cx| window.press(key, cx))
        .unwrap();
    frame(cx, handle);
}

pub fn click(cx: &mut TestAppContext, handle: AnyWindowHandle, id: impl Into<ElementId>) {
    let id = id.into();
    cx.update_window(handle, |_, window, cx| {
        window.render_frame(cx);
        window.click(id, cx);
    })
    .unwrap();
    frame(cx, handle);
}

pub fn double_click(cx: &mut TestAppContext, handle: AnyWindowHandle, id: impl Into<ElementId>) {
    let id = id.into();
    cx.update_window(handle, |_, window, cx| {
        window.render_frame(cx);
        window.double_click(id, cx);
    })
    .unwrap();
    frame(cx, handle);
}

pub fn label_of(
    cx: &mut TestAppContext,
    handle: AnyWindowHandle,
    id: impl Into<ElementId>,
) -> Option<String> {
    let id = id.into();
    cx.update_window(handle, |_, window, _| {
        window
            .try_find(id)
            .and_then(|element| element.label().map(str::to_owned))
    })
    .unwrap()
}

pub fn is_drawn(
    cx: &mut TestAppContext,
    handle: AnyWindowHandle,
    id: impl Into<ElementId>,
) -> bool {
    let id = id.into();
    cx.update_window(handle, |_, window, _| window.try_find(id).is_some())
        .unwrap()
}

pub fn title(cx: &mut TestAppContext, handle: AnyWindowHandle) -> Option<String> {
    VisualTestContext::from_window(handle, cx).window_title()
}

pub fn mode(opened: &Opened, cx: &mut TestAppContext) -> ModeId {
    cx.update(|cx| opened.shell.read(cx).state().read(cx).mode())
}

/// The top bar's heading: the mode's page, or View's folder.
pub fn heading(cx: &mut TestAppContext, handle: AnyWindowHandle) -> Option<String> {
    label_of(cx, handle, "top-bar-title")
}

/// Whether View shows `folder`, with its scan done.
pub fn view_shows(opened: &Opened, folder: &Path, cx: &mut TestAppContext) -> bool {
    cx.update(|cx| {
        let view = opened.shell.read(cx).view().read(cx);
        view.folder(cx).as_deref() == Some(folder)
            && view.catalog().read(cx).state() == ScanState::Done
            && !view.gallery().read(cx).tiles().is_empty()
    })
}

/// The element id of View's tile for a folder.
pub fn folder_tile(folder: &Path) -> ElementId {
    ElementId::Name(format!("folder:{}", folder.display()).into())
}

/// The element id of View's tile for a file.
pub fn media_tile(file: &Path) -> ElementId {
    ElementId::Path(Path::new(file).into())
}
