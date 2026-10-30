//! Oriel RS: Oriel's View, Tidy and Sync modes in one native window, on GPUI Kit, with no Node
//! process (plan 063). It keeps its own data in `~/.latch-works/oriel-rs`.

pub mod about;
pub mod actions;
mod check;
mod dock;
mod general;
pub mod menus;
pub mod open_paths;
pub mod quit;
pub mod shell;
mod terminate;
pub mod welcome;
pub mod window_state;

pub use general::theme_button_id;

use std::path::PathBuf;

use futures::StreamExt as _;
use gpui_kit::component::TitleBar;
use gpui_kit::{
    App, AppContext as _, Bounds, Entity, Global, TitlebarOptions, WeakEntity, WindowBounds,
    WindowHandle, WindowOptions, point, px, size,
};
use oriel_core_paths::DataRoot;
use oriel_ui::LocalStorage;

use crate::shell::Shell;
use crate::window_state::{Placement, Screen, WindowState};

const APP_NAME: &str = "Oriel RS";

/// The one window, for the system's requests that come without one: reopening the app, and
/// paths it hands over.
struct MainWindow {
    handle: WindowHandle<gpui_kit::base::Root>,
    shell: WeakEntity<Shell>,
}

impl Global for MainWindow {}

/// Starts the app: its data folder, GPUI Kit, the stored preferences, the theme, the keys, the
/// window and its menus, and the paths the system hands it.
pub fn run() {
    let data = DataRoot::from_environment().expect("Oriel RS needs a data folder");
    data.create_folders()
        .expect("Oriel RS could not create its data folder");

    // macOS hands over paths (a drop on the Dock icon, Open With, a second launch) before the
    // window exists as well as after, so they wait in a channel for it.
    let (opened, mut to_open) = futures::channel::mpsc::unbounded::<Vec<PathBuf>>();
    let app = gpui_kit::application().with_assets(oriel_ui::OrielAssets);
    app.on_open_urls(move |urls| {
        let paths = open_paths::from_urls(&urls);
        if !paths.is_empty() {
            opened.unbounded_send(paths).ok();
        }
    });
    // A click on the Dock icon, or launching the app again, brings the window back.
    app.on_reopen(|cx| {
        with_main_window(cx, |shell, window, cx| shell.show_window(window, cx));
    });

    app.run(move |cx| {
        gpui_kit::init(cx);
        // Sync's HTTP runs on a tokio thread of its own, started once here rather than at the
        // first push.
        oriel_mode_sync::start_http(cx).expect("Oriel RS could not start its HTTP thread");
        LocalStorage::init(LocalStorage::open(&data.shell()), cx);
        oriel_ui::theme::init(cx);
        actions::init(cx);
        menus::prepare();
        let shell = open_main_window(data, cx);

        // The system's own quits (the Dock icon's Quit, logging out) wait for work as ⌘Q does.
        let (quit_requests, mut quit_requested) = futures::channel::mpsc::unbounded::<()>();
        terminate::install(shell.read(cx).quit().read(cx).hold(), quit_requests);
        cx.spawn(async move |cx| {
            while quit_requested.next().await.is_some() {
                cx.update(quit::QuitGuard::request_global);
            }
        })
        .detach();

        let executable = std::env::current_exe().unwrap_or_default();
        if let Some(path) = open_paths::from_args(std::env::args_os().skip(1), &executable) {
            with_main_window(cx, move |shell, window, cx| {
                shell.open_in_view(&path, window, cx)
            });
        }
        cx.spawn(async move |cx| {
            while let Some(paths) = to_open.next().await {
                cx.update(|cx| {
                    for path in paths {
                        with_main_window(cx, |shell, window, cx| {
                            shell.open_in_view(&path, window, cx);
                        });
                    }
                });
            }
        })
        .detach();
        cx.activate(true);
    });
}

fn with_main_window(
    cx: &mut App,
    f: impl FnOnce(&mut Shell, &mut gpui_kit::Window, &mut gpui_kit::Context<Shell>),
) {
    let Some(main) = cx.try_global::<MainWindow>() else {
        return;
    };
    let (handle, shell) = (main.handle, main.shell.clone());
    handle
        .update(cx, |_, window, cx| {
            shell.update(cx, |shell, cx| f(shell, window, cx)).ok();
        })
        .ok();
}

/// The window's options, as Electron Oriel's window: where it was last, on the display it was on,
/// else 1320 × 860 centred, at least 960 × 640, the window buttons inset in a transparent title
/// bar.
pub fn main_window_options(data: &DataRoot, cx: &mut App) -> WindowOptions {
    let saved = WindowState::read(&data.shell());
    let (display_id, bounds) = match WindowState::placement(saved.as_ref(), &Screen::all(cx)) {
        Placement::On { display, bounds } => (display, bounds),
        Placement::Centered(width, height) => (
            None,
            Bounds::centered(None, size(px(width), px(height)), cx),
        ),
    };
    let maximized = saved.is_some_and(|state| state.is_maximized());
    WindowOptions {
        window_bounds: Some(if maximized {
            WindowBounds::Maximized(bounds)
        } else {
            WindowBounds::Windowed(bounds)
        }),
        window_min_size: Some(size(px(960.), px(640.))),
        display_id,
        titlebar: Some(TitlebarOptions {
            title: Some(Shell::title(stored_mode(cx)).into()),
            appears_transparent: true,
            traffic_light_position: Some(point(px(16.), px(18.))),
        }),
        app_id: Some("dev.traydr.latchworks.oriel-rs".into()),
        // GPUI caps an inactive window at 30 frames a second by default, so a video playing
        // behind another app's window would drop to about 24 fps. Nothing requests frames while
        // idle, so lifting the cap costs nothing at rest.
        inactive_frame_interval: None,
        ..TitleBar::window_options()
    }
}

fn stored_mode(cx: &App) -> oriel_ui::ModeId {
    LocalStorage::get(cx, shell::MODE_KEY)
        .and_then(oriel_ui::ModeId::from_key)
        .unwrap_or(oriel_ui::ModeId::View)
}

fn open_main_window(data: DataRoot, cx: &mut App) -> Entity<Shell> {
    let options = main_window_options(&data, cx);
    let (handle, shell) = gpui_kit::open_window(options, cx, |window, cx| {
        let shell = cx.new(|cx| Shell::new(data, window, cx));
        let opened = shell.clone();
        window.defer(cx, move |window, cx| {
            if window.focused(cx).is_none() {
                opened.read(cx).initial_focus(cx).focus(window, cx);
            }
        });
        shell
    })
    .expect("Oriel RS could not open its window");
    if let Some(handle) = handle.downcast::<gpui_kit::base::Root>() {
        cx.set_global(MainWindow {
            handle,
            shell: shell.downgrade(),
        });
    }
    shell
}
