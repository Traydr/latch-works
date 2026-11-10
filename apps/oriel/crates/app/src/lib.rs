//! Oriel: View, Tidy and Sync in one native window, on GPUI Kit, with no Node process. It keeps
//! its data in `~/.latch-works/oriel`, or the folder `ORIEL_DATA_DIR` names.

pub mod about;
pub mod actions;
mod check;
mod dock;
mod general;
pub mod menus;
pub mod move_to_applications;
pub mod open_paths;
pub mod quit;
pub mod shell;
pub mod single_instance;
mod spike;
mod terminate;
pub mod welcome;
pub mod window_state;
#[cfg(windows)]
mod windows_frame;

pub use oriel_launch::Launch;

use std::path::PathBuf;
use std::rc::Rc;

use futures::StreamExt as _;
use gpui_kit::component::TitleBar;
use gpui_kit::{
    App, AppContext as _, Bounds, Entity, Global, TitlebarOptions, WeakEntity, WindowBounds,
    WindowHandle, WindowOptions, point, px, size,
};
use oriel_runtime::TokioRuntime;
use oriel_ui::LocalStorage;

use crate::quit::SystemQuit;
use crate::shell::Shell;
use crate::window_state::{Placement, Screen, WindowState};

/// The one window, for the system's requests that come without one: reopening the app, and
/// paths it hands over.
struct MainWindow {
    handle: WindowHandle<gpui_kit::base::Root>,
    shell: WeakEntity<Shell>,
}

impl Global for MainWindow {}

/// What the app starts before its window, in this order, for `launch`: GPUI Kit with the theme it
/// starts from, the HTTP clients' thread, whether tools suspend, the stored preferences and the
/// theme they choose, the app's keys and actions, and what the menu bar needs. The tests start
/// the same way.
pub fn init(launch: &Launch, cx: &mut App) {
    oriel_ui::theme::prepare(cx);
    gpui_kit::init(cx);
    // Started at launch, so a failure to start shows now rather than at the first push.
    TokioRuntime::shared().expect("Oriel could not start its HTTP thread");
    oriel_runtime::set_keep_running(launch.variables.is_set(check::TOOLS_KEEP_RUNNING));
    LocalStorage::init(LocalStorage::open(&launch.data.local_storage()), cx);
    oriel_ui::theme::init(cx);
    actions::init(cx);
    menus::prepare();
}

/// Starts the app: its data folder, the single instance, the window and its menus, and the paths
/// the system hands it.
pub fn run() {
    // A second start on this data folder hands its paths over and exits here.
    let executable = std::env::current_exe().unwrap_or_default();
    let launch_path = open_paths::from_args(std::env::args_os().skip(1), &executable);
    let launch = Launch::from_environment(launch_path.clone()).expect("Oriel needs a data folder");
    let data = launch.data.clone();
    data.create_folders()
        .expect("Oriel could not create its data folder");
    let instance = match single_instance::claim(&data, launch_path.as_slice()) {
        single_instance::Claim::First(instance) => instance,
        single_instance::Claim::Handed => return,
    };

    // macOS hands over paths (a drop on the Dock icon, Open With, a second launch) before the
    // window exists as well as after, so they wait in a channel for it.
    let (opened, mut to_open) = futures::channel::mpsc::unbounded::<Vec<PathBuf>>();
    instance.listen(opened.clone());
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
        init(&launch, cx);
        let shell = open_main_window(&launch, cx);
        // Started from the disk image or Downloads, the app offers to move to Applications.
        #[cfg(target_os = "macos")]
        if let Some(main) = cx.try_global::<MainWindow>() {
            move_to_applications::offer(&launch.data, &launch.variables, main.handle.into(), cx);
        }

        // The system's own quits (the Dock icon's Quit, logging out) wait for work as ⌘Q does.
        let (quit_requests, mut quit_requested) = futures::channel::mpsc::unbounded::<()>();
        terminate::install(shell.read(cx).quit().read(cx).hold(), quit_requests);
        cx.spawn(async move |cx| {
            while quit_requested.next().await.is_some() {
                cx.update(quit::QuitGuard::request_global);
            }
        })
        .detach();

        cx.spawn(async move |cx| {
            while let Some(paths) = to_open.next().await {
                cx.update(|cx| {
                    // A second launch with nothing to open asks for the window.
                    if paths.is_empty() {
                        with_main_window(cx, |shell, window, cx| shell.show_window(window, cx));
                    }
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

/// The window's options: where it was last, on the display it was on, else 1320 × 860 centred, at
/// least 960 × 640, the window buttons inset in a transparent title bar.
pub fn main_window_options(launch: &Launch, cx: &mut App) -> WindowOptions {
    let saved = WindowState::read(&launch.data.window_state());
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
            title: Some(Shell::title(Shell::starting_mode(launch, cx)).into()),
            appears_transparent: true,
            traffic_light_position: Some(point(px(16.), px(22.))),
        }),
        app_id: Some(oriel_core_paths::BUNDLE_ID.into()),
        // GPUI caps an inactive window at 30 frames a second by default, so a video playing
        // behind another app's window would drop to about 24 fps. Nothing requests frames while
        // idle, so lifting the cap costs nothing at rest.
        inactive_frame_interval: None,
        ..TitleBar::window_options()
    }
}

fn open_main_window(launch: &Launch, cx: &mut App) -> Entity<Shell> {
    let options = main_window_options(launch, cx);
    let build = |window: &mut gpui_kit::Window, cx: &mut App| {
        let shell = cx.new(|cx| Shell::new(launch, Rc::new(SystemQuit), window, cx));
        let opened = shell.clone();
        window.defer(cx, move |window, cx| {
            if window.focused(cx).is_none() {
                opened.read(cx).initial_focus(cx).focus(window, cx);
            }
        });
        shell
    };
    #[cfg(not(windows))]
    let (handle, shell) =
        gpui_kit::open_window(options, cx, build).expect("Oriel could not open its window");
    // On Windows the shell sits under the window's own title bar and menus.
    #[cfg(windows)]
    let (handle, shell) = {
        let mut built = None;
        let (handle, _) = gpui_kit::open_window(options, cx, |window, cx| {
            let shell = build(window, cx);
            built = Some(shell.clone());
            cx.new(|cx| windows_frame::WindowsFrame::new(shell, cx))
        })
        .expect("Oriel could not open its window");
        (handle, built.expect("the window built its shell"))
    };
    if let Some(handle) = handle.downcast::<gpui_kit::base::Root>() {
        cx.set_global(MainWindow {
            handle,
            shell: shell.downgrade(),
        });
    }
    shell
}
