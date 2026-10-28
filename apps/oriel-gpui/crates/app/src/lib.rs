//! Oriel GPUI: Oriel's View, Tidy and Sync modes in one native window, on GPUI Kit, with no Node
//! process (plan 063). It keeps its own data in `~/.latch-works/oriel-gpui`.

pub mod actions;
mod menus;
pub mod shell;

use gpui_kit::component::TitleBar;
use gpui_kit::{
    App, AppContext as _, Bounds, Focusable as _, TitlebarOptions, WindowBounds, WindowOptions,
    point, px, size,
};
use oriel_core_paths::DataRoot;

use crate::shell::Shell;

const APP_NAME: &str = "Oriel GPUI";

/// Starts the app: its data folder, GPUI Kit, the theme, the keys, the menus, the window.
pub fn run() {
    let data = DataRoot::from_environment().expect("Oriel GPUI needs a data folder");
    data.create_folders()
        .expect("Oriel GPUI could not create its data folder");

    gpui_kit::application()
        .with_assets(oriel_ui::OrielAssets)
        .run(move |cx| {
            gpui_kit::init(cx);
            oriel_ui::theme::init(cx);
            actions::init(cx);
            menus::init(cx);
            open_main_window(cx);
            cx.activate(true);
        });
}

/// The window's options, as Electron Oriel's first window.
pub fn main_window_options(cx: &mut App) -> WindowOptions {
    // Electron Oriel's first window: 1320 × 860, at least 960 × 640, the window buttons inset at
    // 16, 18 in a transparent title bar.
    let bounds = Bounds::centered(None, size(px(1320.), px(860.)), cx);
    WindowOptions {
        window_bounds: Some(WindowBounds::Windowed(bounds)),
        window_min_size: Some(size(px(960.), px(640.))),
        titlebar: Some(TitlebarOptions {
            title: Some(APP_NAME.into()),
            appears_transparent: true,
            traffic_light_position: Some(point(px(16.), px(18.))),
        }),
        app_id: Some("dev.traydr.latchworks.oriel-gpui".into()),
        // GPUI caps an inactive window at 30 frames a second by default, so a video playing
        // behind another app's window would drop to about 24 fps. Nothing requests frames while
        // idle, so lifting the cap costs nothing at rest.
        inactive_frame_interval: None,
        ..TitleBar::window_options()
    }
}

fn open_main_window(cx: &mut App) {
    let options = main_window_options(cx);
    gpui_kit::open_window(options, cx, |window, cx| {
        let shell = cx.new(|cx| Shell::new(window, cx));
        let focus = shell.focus_handle(cx);
        window.defer(cx, move |window, cx| {
            if window.focused(cx).is_none() {
                focus.focus(window, cx);
            }
        });
        shell
    })
    .expect("Oriel GPUI could not open its window");
}
