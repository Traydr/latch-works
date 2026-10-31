//! The shell's cases from Electron Oriel's e2e shell spec, as GPUI tests: it
//! starts in View and switches modes from the switcher and the menu, reopens in the mode it
//! showed last, keeps View's folder while another mode shows, and has one Settings page at the
//! section of the mode on screen. Then what the shell adds around them that is worth pinning:
//! the window's state round trip, quitting while work runs, the activity marks, every mode's jobs
//! in one place, and the names VoiceOver reads.

use std::cell::Cell;
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::time::Duration;

use gpui_kit::component::ActiveTheme as _;
use gpui_kit::test::TestWindowExt as _;
use gpui_kit::{
    Action, AnyWindowHandle, App, AppContext as _, Bounds, Entity, Focusable as _, OwnedMenuItem,
    Role, TestAppContext, VisualTestContext, WindowBounds, WindowOptions, px, size,
};
use oriel::quit::QuitPlatform;
use oriel::shell::Shell;
use oriel_core_paths::DataRoot;
use oriel_media::still::{Still, WebpSettings};
use oriel_mode_tidy::TidyPage;
use oriel_ui::{
    ActivityJob, JobCommand, JobControl, JobState, LocalStorage, ModeActivity, ModeId, Toast,
    ToastExt as _,
};

/// A folder of its own under the temp folder, emptied first.
fn scratch(test: &str) -> PathBuf {
    let folder = std::env::temp_dir()
        .join("oriel-shell-tests")
        .join(format!("{test}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&folder);
    std::fs::create_dir_all(&folder).unwrap();
    folder
}

/// Stands in for hiding and quitting the app, which the test platform cannot do.
#[derive(Default)]
struct Recorder {
    hides: Cell<usize>,
    quits: Cell<usize>,
}

impl QuitPlatform for Recorder {
    fn hide(&self, _: &mut App) {
        self.hides.set(self.hides.get() + 1);
    }

    fn quit(&self, _: &mut App) {
        self.quits.set(self.quits.get() + 1);
    }
}

struct Opened {
    handle: AnyWindowHandle,
    shell: Entity<Shell>,
    platform: Rc<Recorder>,
}

/// GPUI Kit, the store of preferences in `data`'s shell folder, the theme and the keys, as the
/// app starts them.
fn start(cx: &mut TestAppContext, data: &DataRoot) {
    data.create_folders().unwrap();
    cx.update(|cx| {
        gpui_kit::init(cx);
        LocalStorage::init(LocalStorage::open(&data.shell()), cx);
        oriel_ui::theme::init(cx);
        oriel::actions::init(cx);
    });
}

fn open_shell(cx: &mut TestAppContext, data: &DataRoot) -> Opened {
    let platform = Rc::new(Recorder::default());
    let (handle, shell) = cx.update(|cx| {
        let platform: Rc<dyn QuitPlatform> = platform.clone();
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
    Opened {
        handle,
        shell,
        platform,
    }
}

fn frame(cx: &mut TestAppContext, handle: AnyWindowHandle) {
    cx.run_until_parked();
    cx.update_window(handle, |_, window, cx| window.render_frame(cx))
        .unwrap();
}

fn press(cx: &mut TestAppContext, handle: AnyWindowHandle, key: &str) {
    cx.update_window(handle, |_, window, cx| window.press(key, cx))
        .unwrap();
    frame(cx, handle);
}

fn click(cx: &mut TestAppContext, handle: AnyWindowHandle, id: &'static str) {
    cx.update_window(handle, |_, window, cx| window.click(id, cx))
        .unwrap();
    frame(cx, handle);
}

fn mode(opened: &Opened, cx: &mut TestAppContext) -> ModeId {
    cx.update(|cx| opened.shell.read(cx).state().read(cx).mode())
}

fn title(cx: &mut TestAppContext, handle: AnyWindowHandle) -> Option<String> {
    VisualTestContext::from_window(handle, cx).window_title()
}

/// The action behind `item` in the menu bar's `menu`, and whether the item is checked.
fn menu_item(cx: &mut TestAppContext, menu: &str, item: &str) -> (Box<dyn Action>, bool) {
    cx.update(|cx| {
        let menus = cx.get_menus().expect("the menu bar is set");
        let found = menus
            .iter()
            .find(|each| each.name.as_ref() == menu)
            .unwrap_or_else(|| panic!("no {menu} menu"));
        found
            .items
            .iter()
            .find_map(|each| match each {
                OwnedMenuItem::Action {
                    name,
                    action,
                    checked,
                    ..
                } if name == item => Some((action.boxed_clone(), *checked)),
                _ => None,
            })
            .unwrap_or_else(|| panic!("no {item} in the {menu} menu"))
    })
}

/// Chooses `item` from the menu bar's `menu`, as a click on it would.
fn choose_from_menu(cx: &mut TestAppContext, handle: AnyWindowHandle, menu: &str, item: &str) {
    let (action, _) = menu_item(cx, menu, item);
    cx.update_window(handle, |_, window, cx| window.dispatch_action(action, cx))
        .unwrap();
    frame(cx, handle);
}

fn label_of(cx: &mut TestAppContext, handle: AnyWindowHandle, id: &'static str) -> Option<String> {
    cx.update_window(handle, |_, window, _| {
        window
            .try_find(id)
            .and_then(|element| element.label().map(str::to_owned))
    })
    .unwrap()
}

fn is_drawn(cx: &mut TestAppContext, handle: AnyWindowHandle, id: &'static str) -> bool {
    cx.update_window(handle, |_, window, _| window.try_find(id).is_some())
        .unwrap()
}

#[gpui_kit::test]
fn starts_in_view_and_switches_modes_from_the_switcher_and_the_menu(cx: &mut TestAppContext) {
    let data = DataRoot::at(scratch("switches").join("data")).unwrap();
    start(cx, &data);
    let opened = open_shell(cx, &data);
    let handle = opened.handle;

    assert_eq!(mode(&opened, cx), ModeId::View);
    assert_eq!(title(cx, handle).as_deref(), Some("View – Oriel"));

    click(cx, handle, "mode-Tidy");
    assert_eq!(mode(&opened, cx), ModeId::Tidy);
    assert!(is_drawn(cx, handle, "tidy-Overview"));

    choose_from_menu(cx, handle, "View", "Sync");
    assert_eq!(mode(&opened, cx), ModeId::Sync);
    assert_eq!(title(cx, handle).as_deref(), Some("Sync – Oriel"));
    assert!(
        !is_drawn(cx, handle, "tidy-Overview"),
        "Tidy is drawn while hidden"
    );

    // The menu's check mark follows the mode the window shows.
    let checked: Vec<&str> = ["View", "Tidy", "Sync"]
        .into_iter()
        .filter(|item| menu_item(cx, "View", item).1)
        .collect();
    assert_eq!(checked, ["Sync"]);

    // ⌘1–3 switch too, and the menu holds the mode's own File items.
    for (key, expected) in [
        ("cmd-2", ModeId::Tidy),
        ("cmd-3", ModeId::Sync),
        ("cmd-1", ModeId::View),
    ] {
        press(cx, handle, key);
        assert_eq!(mode(&opened, cx), expected, "after {key}");
    }
    menu_item(cx, "File", "Open Folder…");
    press(cx, handle, "cmd-2");
    menu_item(cx, "File", "Add Folder…");
    menu_item(cx, "View", "Library");
}

#[gpui_kit::test]
fn every_menu_item_of_the_mode_on_screen_is_lit(cx: &mut TestAppContext) {
    let data = DataRoot::at(scratch("menus-lit").join("data")).unwrap();
    start(cx, &data);
    let opened = open_shell(cx, &data);
    let handle = opened.handle;

    // Each mode as it comes on screen from another, before anything in it is clicked.
    for (key, expected) in [
        ("cmd-2", ModeId::Tidy),
        ("cmd-3", ModeId::Sync),
        ("cmd-1", ModeId::View),
    ] {
        press(cx, handle, key);
        assert_eq!(mode(&opened, cx), expected);
        let greyed: Vec<String> = cx
            .update_window(handle, |_, window, cx| {
                let menus = cx.get_menus().expect("the menu bar is set");
                menus
                    .iter()
                    .flat_map(|menu| {
                        menu.items.iter().filter_map(|item| match item {
                            // A text field's own commands (Cut, Copy, Paste…) are lit only while
                            // one has focus, as in any Mac app.
                            OwnedMenuItem::Action {
                                name,
                                action,
                                os_action: None,
                                ..
                            } => Some((format!("{} › {name}", menu.name), action.boxed_clone())),
                            _ => None,
                        })
                    })
                    // On the focused element's path, or app-wide.
                    .filter(|(_, action)| {
                        !window.is_action_available(action.as_ref(), cx)
                            && !cx.is_action_available(action.as_ref())
                    })
                    .map(|(name, _)| name)
                    .collect()
            })
            .unwrap();
        assert!(greyed.is_empty(), "greyed in {expected:?}: {greyed:?}");
    }
}

#[gpui_kit::test]
fn folds_the_sidebar_to_the_rail_and_back(cx: &mut TestAppContext) {
    let data = DataRoot::at(scratch("rail").join("data")).unwrap();
    start(cx, &data);
    let opened = open_shell(cx, &data);
    let handle = opened.handle;
    let rail =
        |cx: &mut TestAppContext| cx.update(|cx| opened.shell.read(cx).state().read(cx).rail());
    assert!(!rail(cx));

    press(cx, handle, "cmd-\\");
    assert!(rail(cx));
    // The rail's switcher keeps the modes' names for VoiceOver.
    assert_eq!(label_of(cx, handle, "mode-Sync").as_deref(), Some("Sync"));

    click(cx, handle, "toggle-sidebar");
    assert!(!rail(cx));
}

#[gpui_kit::test]
fn reopens_in_the_mode_it_showed_last_with_its_sidebar_and_theme(cx: &mut TestAppContext) {
    let data = DataRoot::at(scratch("reopens").join("data")).unwrap();
    start(cx, &data);
    let first = open_shell(cx, &data);
    press(cx, first.handle, "cmd-3");
    press(cx, first.handle, "cmd-\\");
    click(cx, first.handle, "settings-item");
    click(cx, first.handle, "settings-section-general");
    click(cx, first.handle, "theme-dark");
    cx.update_window(first.handle, |_, window, _| window.remove_window())
        .unwrap();
    cx.run_until_parked();

    let stored = std::fs::read_to_string(data.shell().join("local-storage.json")).unwrap();
    let stored: serde_json::Value = serde_json::from_str(&stored).unwrap();
    assert_eq!(stored["oriel.mode"], "sync");
    assert_eq!(stored["oriel.sidebar"], "rail");
    assert_eq!(stored["oriel.theme"], "dark");

    // A second start reads the file again, as the app does.
    cx.update(|cx| {
        LocalStorage::init(LocalStorage::open(&data.shell()), cx);
        oriel_ui::theme::init(cx);
    });
    let second = open_shell(cx, &data);
    assert_eq!(mode(&second, cx), ModeId::Sync);
    assert_eq!(title(cx, second.handle).as_deref(), Some("Sync – Oriel"));
    assert!(cx.update(|cx| second.shell.read(cx).state().read(cx).rail()));
    assert!(cx.update(|cx| cx.theme().mode.is_dark()));
}

#[gpui_kit::test]
fn a_hidden_mode_keeps_its_page_and_draws_nothing(cx: &mut TestAppContext) {
    let data = DataRoot::at(scratch("hidden").join("data")).unwrap();
    start(cx, &data);
    let opened = open_shell(cx, &data);
    let handle = opened.handle;
    let page =
        |cx: &mut TestAppContext| cx.update(|cx| opened.shell.read(cx).tidy().read(cx).page());

    assert!(
        !is_drawn(cx, handle, "tidy-Library"),
        "Tidy is drawn while hidden"
    );
    press(cx, handle, "cmd-2");
    click(cx, handle, "tidy-Library");
    assert_eq!(page(cx), TidyPage::Library);

    press(cx, handle, "cmd-1");
    assert!(!is_drawn(cx, handle, "tidy-Library"));
    press(cx, handle, "cmd-2");
    assert_eq!(mode(&opened, cx), ModeId::Tidy);
    assert_eq!(page(cx), TidyPage::Library);
}

/// A small WebP still of one color at `path`.
fn write_still(path: &Path, shade: u8) {
    let (width, height) = (32u32, 18u32);
    let bgra = [shade, 128, 255 - shade, 255].repeat((width * height) as usize);
    let still = Still::from_bgra(width, height, bgra, true).unwrap();
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(
        path,
        still.encode_webp(WebpSettings::lossy(80., 0)).unwrap(),
    )
    .unwrap();
}

#[gpui_kit::test]
fn view_keeps_its_folder_while_another_mode_shows(cx: &mut TestAppContext) {
    let root = scratch("keeps-folder");
    let archive = root.join("archive");
    for ix in 0..3 {
        write_still(&archive.join(format!("still-{ix}.webp")), ix * 60);
    }
    let data = DataRoot::at(root.join("data")).unwrap();
    start(cx, &data);
    let opened = open_shell(cx, &data);
    let handle = opened.handle;

    // A folder handed to the app, from Tidy: View shows it.
    press(cx, handle, "cmd-2");
    cx.update_window(handle, |_, window, cx| {
        opened
            .shell
            .update(cx, |shell, cx| shell.open_in_view(&archive, window, cx));
    })
    .unwrap();
    assert_eq!(mode(&opened, cx), ModeId::View);
    let shown = |cx: &mut TestAppContext| {
        cx.update(|cx| {
            let view = opened.shell.read(cx).view().read(cx);
            (
                view.folder(cx).map(|folder| folder.to_path_buf()),
                view.gallery().read(cx).media().len(),
            )
        })
    };
    // View scans on threads of its own, so give them real time.
    for _ in 0..500 {
        frame(cx, handle);
        if shown(cx).1 == 3 {
            break;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    let real = std::fs::canonicalize(&archive).unwrap();
    assert_eq!(shown(cx), (Some(real.clone()), 3));
    let tile = gpui_kit::ElementId::Path(real.join("still-0.webp").into());
    let tile_drawn = |cx: &mut TestAppContext| {
        cx.update_window(handle, |_, window, _| {
            window.try_find(tile.clone()).is_some()
        })
        .unwrap()
    };
    assert!(tile_drawn(cx));

    press(cx, handle, "cmd-2");
    assert!(!tile_drawn(cx), "View's tiles are drawn while Tidy shows");
    press(cx, handle, "cmd-1");
    assert_eq!(shown(cx), (Some(real), 3));
    assert!(tile_drawn(cx));
}

/// Waits, in real time, for View to show `folder` with its scan done: View scans on threads of
/// its own.
fn wait_for_view_folder(cx: &mut TestAppContext, opened: &Opened, folder: &Path) {
    let shown = |cx: &mut TestAppContext| {
        cx.update(|cx| {
            let view = opened.shell.read(cx).view().read(cx);
            let scanned =
                view.catalog().read(cx).state() == oriel_mode_view::catalog::ScanState::Done;
            (view.folder(cx).map(|folder| folder.to_path_buf()), scanned)
        })
    };
    for _ in 0..500 {
        frame(cx, opened.handle);
        if shown(cx) == (Some(folder.to_path_buf()), true) {
            return;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    assert_eq!(shown(cx), (Some(folder.to_path_buf()), true));
}

#[gpui_kit::test]
fn reopens_on_the_page_it_showed_last_with_view_able_to_step_back_up(cx: &mut TestAppContext) {
    let root = scratch("reopens-page");
    let archive = root.join("archive");
    write_still(&archive.join("cover.webp"), 0);
    for ix in 0..2 {
        write_still(&archive.join(format!("comics/page-{ix}.webp")), ix * 90);
    }
    let archive = std::fs::canonicalize(&archive).unwrap();
    let comics = archive.join("comics");
    let data = DataRoot::at(root.join("data")).unwrap();
    start(cx, &data);
    let first = open_shell(cx, &data);

    // View opens the archive and steps into its subfolder; Tidy shows its Library.
    cx.update_window(first.handle, |_, window, cx| {
        first
            .shell
            .update(cx, |shell, cx| shell.open_in_view(&archive, window, cx));
    })
    .unwrap();
    wait_for_view_folder(cx, &first, &archive);
    let comics_item = format!("sidebar-folder:{}", comics.display());
    cx.update_window(first.handle, |_, window, cx| {
        window.click(gpui_kit::ElementId::Name(comics_item.into()), cx)
    })
    .unwrap();
    wait_for_view_folder(cx, &first, &comics);
    press(cx, first.handle, "cmd-2");
    click(cx, first.handle, "tidy-Library");
    cx.update_window(first.handle, |_, window, _| window.remove_window())
        .unwrap();
    cx.run_until_parked();

    // A second start reads the stored state again, as the app does.
    cx.update(|cx| LocalStorage::init(LocalStorage::open(&data.shell()), cx));
    let second = open_shell(cx, &data);
    assert_eq!(mode(&second, cx), ModeId::Tidy);
    assert_eq!(title(cx, second.handle).as_deref(), Some("Tidy – Oriel"));
    assert_eq!(
        cx.update(|cx| second.shell.read(cx).tidy().read(cx).page()),
        TidyPage::Library
    );

    // View is back in the subfolder, and the folder opened above it is still the top.
    press(cx, second.handle, "cmd-1");
    wait_for_view_folder(cx, &second, &comics);
    click(cx, second.handle, "sidebar-up");
    wait_for_view_folder(cx, &second, &archive);
    assert!(
        !is_drawn(cx, second.handle, "sidebar-up"),
        "View stepped above the folder the owner opened"
    );
}

#[gpui_kit::test]
fn one_settings_page_at_the_section_of_the_mode_on_screen(cx: &mut TestAppContext) {
    let data = DataRoot::at(scratch("settings").join("data")).unwrap();
    start(cx, &data);
    let opened = open_shell(cx, &data);
    let handle = opened.handle;
    let heading = |cx: &mut TestAppContext| label_of(cx, handle, "settings-title");

    // View's sidebar item opens View's section.
    click(cx, handle, "settings-item");
    assert_eq!(heading(cx).as_deref(), Some("View"));

    // General holds the one theme, applied at once.
    click(cx, handle, "settings-section-general");
    assert_eq!(heading(cx).as_deref(), Some("General"));
    assert_eq!(label_of(cx, handle, "theme").as_deref(), Some("Theme"));
    click(cx, handle, "theme-dark");
    assert!(cx.update(|cx| cx.theme().mode.is_dark()));
    click(cx, handle, "theme-light");
    assert!(!cx.update(|cx| cx.theme().mode.is_dark()));

    click(cx, handle, "settings-back");
    assert!(!is_drawn(cx, handle, "settings-back"));
    assert!(is_drawn(cx, handle, "settings-item"));

    // ⌘, opens the section of whichever mode shows.
    press(cx, handle, "cmd-3");
    choose_from_menu(cx, handle, "Oriel", "Settings…");
    assert_eq!(heading(cx).as_deref(), Some("Sync"));
    press(cx, handle, "escape");
    assert!(!is_drawn(cx, handle, "settings-back"));
    press(cx, handle, "cmd-,");
    assert_eq!(heading(cx).as_deref(), Some("Sync"));

    // Choosing another mode's section shows that mode underneath; Escape closes Settings.
    click(cx, handle, "settings-section-tidy");
    assert_eq!(heading(cx).as_deref(), Some("Tidy"));
    assert_eq!(title(cx, handle).as_deref(), Some("Tidy – Oriel"));
    press(cx, handle, "escape");
    assert!(!is_drawn(cx, handle, "settings-back"));
    assert_eq!(mode(&opened, cx), ModeId::Tidy);
    assert!(is_drawn(cx, handle, "tidy-Overview"));
}

#[gpui_kit::test]
fn remembers_the_window_size_and_position(cx: &mut TestAppContext) {
    let data = DataRoot::at(scratch("window").join("data")).unwrap();
    start(cx, &data);
    let opened = open_shell(cx, &data);

    cx.simulate_window_resize(opened.handle, size(px(1500.), px(940.)));
    cx.executor().advance_clock(Duration::from_millis(300));
    cx.run_until_parked();

    let text = std::fs::read_to_string(data.shell().join("window-state.json"))
        .expect("the window state is written a moment after a resize");
    assert_eq!(
        text,
        r#"{"bounds":{"x":0,"y":0,"width":1500,"height":940},"maximized":false}"#
    );
    // The next window opens where this one was.
    let options = cx.update(|cx| oriel::main_window_options(&data, cx));
    assert_eq!(
        options.window_bounds,
        Some(WindowBounds::Windowed(Bounds::new(
            Default::default(),
            size(px(1500.), px(940.))
        )))
    );
}

#[gpui_kit::test]
fn quitting_waits_for_running_work_with_the_window_hidden(cx: &mut TestAppContext) {
    let data = DataRoot::at(scratch("quit").join("data")).unwrap();
    start(cx, &data);
    let opened = open_shell(cx, &data);
    let handle = opened.handle;
    let platform = opened.platform.clone();
    let state = cx.update(|cx| opened.shell.read(cx).state().clone());
    let report = |cx: &mut TestAppContext, activity| {
        state.update(cx, |state, cx| {
            state.set_activity(ModeId::Sync, activity, cx)
        });
        cx.run_until_parked();
    };

    // A scan does not hold the quit up.
    report(cx, Some(ModeActivity::Working));
    press(cx, handle, "cmd-q");
    assert_eq!((platform.hides.get(), platform.quits.get()), (0, 1));

    // A push does: ⌘Q hides the window, and the app quits when the push ends.
    let holds = |cx: &mut TestAppContext| {
        cx.update(|cx| opened.shell.read(cx).quit().read(cx).holds_quit())
    };
    assert!(!holds(cx));
    report(cx, Some(ModeActivity::Progress(0.3)));
    // The system's own quits (the Dock's Quit, logging out) read this to wait too.
    assert!(holds(cx));
    press(cx, handle, "cmd-q");
    assert!(!holds(cx), "a second quit while hidden must go ahead");
    assert_eq!((platform.hides.get(), platform.quits.get()), (1, 1));
    assert!(cx.update(|cx| opened.shell.read(cx).quit().read(cx).is_waiting()));
    report(cx, Some(ModeActivity::Progress(0.8)));
    assert_eq!(platform.quits.get(), 1);
    report(cx, None);
    assert_eq!(platform.quits.get(), 2);

    // Closing the window while a push runs hides it instead; bringing it back calls the quit
    // off, and quitting again meanwhile quits at once.
    report(cx, Some(ModeActivity::Progress(0.5)));
    let closed = VisualTestContext::from_window(handle, cx).simulate_close();
    assert!(!closed, "the window closed while a push ran");
    assert_eq!(platform.hides.get(), 2);
    cx.update_window(handle, |_, window, cx| {
        opened
            .shell
            .update(cx, |shell, cx| shell.show_window(window, cx));
    })
    .unwrap();
    assert!(!cx.update(|cx| opened.shell.read(cx).quit().read(cx).is_waiting()));
    report(cx, None);
    assert_eq!(platform.quits.get(), 2, "a called-off quit happened anyway");

    report(cx, Some(ModeActivity::Progress(0.5)));
    press(cx, handle, "cmd-q");
    press(cx, handle, "cmd-q");
    assert_eq!((platform.hides.get(), platform.quits.get()), (3, 3));

    // With nothing running, closing the window goes ahead.
    report(cx, None);
    assert!(VisualTestContext::from_window(handle, cx).simulate_close());
}

#[gpui_kit::test]
fn the_switcher_shows_the_work_of_modes_not_on_screen(cx: &mut TestAppContext) {
    let data = DataRoot::at(scratch("activity").join("data")).unwrap();
    start(cx, &data);
    let opened = open_shell(cx, &data);
    let handle = opened.handle;
    let state = cx.update(|cx| opened.shell.read(cx).state().clone());
    state.update(cx, |state, cx| {
        state.set_activity(ModeId::Tidy, Some(ModeActivity::Progress(0.4)), cx);
        state.set_activity(ModeId::Sync, Some(ModeActivity::Working), cx);
        state.set_activity(ModeId::View, Some(ModeActivity::Working), cx);
    });
    frame(cx, handle);

    let description = |cx: &mut TestAppContext, id: &'static str| {
        cx.update_window(handle, |_, window, _| {
            window.find(id).description().map(str::to_owned)
        })
        .unwrap()
    };
    assert_eq!(
        description(cx, "mode-Tidy").as_deref(),
        Some("Tidy · 40% done")
    );
    assert_eq!(
        description(cx, "mode-Sync").as_deref(),
        Some("Sync · working")
    );
    // The mode on screen shows no mark of its own.
    assert_eq!(description(cx, "mode-View"), None);
    assert!(is_drawn(cx, handle, "mode-Tidy-activity"));
    assert!(!is_drawn(cx, handle, "mode-View-activity"));

    // The rail draws the marks too; going to the mode clears its own.
    press(cx, handle, "cmd-\\");
    assert!(is_drawn(cx, handle, "mode-Tidy-activity"));
    press(cx, handle, "cmd-2");
    assert!(!is_drawn(cx, handle, "mode-Tidy-activity"));
    assert!(is_drawn(cx, handle, "mode-View-activity"));
}

#[gpui_kit::test]
fn every_modes_jobs_show_in_one_place_at_the_bottom_right(cx: &mut TestAppContext) {
    let data = DataRoot::at(scratch("jobs").join("data")).unwrap();
    start(cx, &data);
    let opened = open_shell(cx, &data);
    let handle = opened.handle;
    let jobs = cx.update(|cx| opened.shell.read(cx).state().read(cx).jobs().clone());
    let commands = Rc::new(std::cell::RefCell::new(Vec::new()));
    let _listening = cx.update(|cx| {
        let commands = commands.clone();
        cx.subscribe(&jobs, move |_, command: &JobCommand, _| {
            commands.borrow_mut().push((
                command.mode(),
                command.key().to_owned(),
                command.control(),
            ));
        })
    });
    let publish = |cx: &mut TestAppContext, mode, list: Vec<ActivityJob>| {
        jobs.update(cx, |jobs, cx| jobs.set_jobs(mode, list, cx));
        frame(cx, handle);
    };
    // Nothing runs, so nothing shows.
    assert!(!is_drawn(cx, handle, "activity-indicator"));

    publish(
        cx,
        ModeId::View,
        vec![ActivityJob::new("scan", "Scanning Pictures").pausable(true)],
    );
    publish(
        cx,
        ModeId::Sync,
        vec![
            ActivityJob::new("run", "Pushing")
                .progress(0.4)
                .detail("1 GB of 2.5 GB · 0:30 left")
                .stoppable(true),
        ],
    );
    publish(
        cx,
        ModeId::Tidy,
        vec![
            ActivityJob::new("queued-0", "Clean up")
                .state(JobState::Queued)
                .stoppable(true),
        ],
    );
    // Collapsed: the work that runs first, and how much more runs and waits.
    assert_eq!(
        label_of(cx, handle, "activity-indicator").as_deref(),
        Some("View · Scanning Pictures · 1 more running · 1 queued")
    );
    assert_eq!(
        label_of(cx, handle, "activity-indicator-queued").as_deref(),
        Some("1 queued")
    );
    // In every mode, and over Settings too.
    press(cx, handle, "cmd-3");
    assert!(is_drawn(cx, handle, "activity-indicator"));
    press(cx, handle, "cmd-,");
    assert!(is_drawn(cx, handle, "activity-indicator"));
    press(cx, handle, "escape");

    // Open: every job, running first, each with the controls it takes.
    click(cx, handle, "activity-indicator");
    assert!(is_drawn(cx, handle, "activity-panel"));
    assert_eq!(
        label_of(cx, handle, "activity-sync-run-state").as_deref(),
        Some("1 GB of 2.5 GB · 0:30 left")
    );
    assert_eq!(
        label_of(cx, handle, "activity-tidy-queued-0-state").as_deref(),
        Some("Queued")
    );
    assert!(!is_drawn(cx, handle, "activity-sync-run-pause"));
    click(cx, handle, "activity-view-scan-pause");
    click(cx, handle, "activity-sync-run-stop");
    click(cx, handle, "activity-tidy-queued-0-stop");
    assert_eq!(
        *commands.borrow(),
        [
            (ModeId::View, "scan".to_owned(), JobControl::Pause),
            (ModeId::Sync, "run".to_owned(), JobControl::Stop),
            (ModeId::Tidy, "queued-0".to_owned(), JobControl::Stop),
        ]
    );

    // Once every mode is idle, nothing shows, and the next work starts collapsed.
    for mode in ModeId::ALL {
        publish(cx, mode, Vec::new());
    }
    assert!(!is_drawn(cx, handle, "activity-panel"));
    assert!(!is_drawn(cx, handle, "activity-indicator"));
    publish(cx, ModeId::Sync, vec![ActivityJob::new("run", "Planning")]);
    assert!(is_drawn(cx, handle, "activity-indicator"));
    assert!(!is_drawn(cx, handle, "activity-panel"));
}

#[gpui_kit::test]
fn voiceover_reads_the_switcher_the_sidebar_and_the_top_bar_by_name(cx: &mut TestAppContext) {
    let data = DataRoot::at(scratch("names").join("data")).unwrap();
    start(cx, &data);
    let opened = open_shell(cx, &data);
    let handle = opened.handle;
    press(cx, handle, "cmd-2");

    cx.update_window(handle, |_, window, _| {
        let switcher = window.find("mode-switcher");
        assert_eq!(
            (switcher.role(), switcher.label()),
            (Some(Role::Navigation), Some("Mode"))
        );
        for (id, name) in [
            ("mode-View", "View"),
            ("mode-Tidy", "Tidy"),
            ("mode-Sync", "Sync"),
        ] {
            let button = window.find(id);
            assert_eq!(
                (button.role(), button.label()),
                (Some(Role::Button), Some(name))
            );
        }
        let library = window.find("tidy-Library");
        assert_eq!(
            (library.role(), library.label(), library.selected()),
            (Some(Role::Button), Some("Library"), Some(false))
        );
        assert_eq!(window.find("tidy-Overview").selected(), Some(true));
        let settings = window.find("settings-item");
        assert_eq!(settings.label(), Some("Settings"));

        let top_bar = window.find("top-bar");
        assert_eq!(
            (top_bar.role(), top_bar.label()),
            (Some(Role::Toolbar), Some("Overview"))
        );
        let heading = window.find("top-bar-title");
        assert_eq!(heading.role(), Some(Role::Heading));
        assert_eq!(
            window.find("toggle-sidebar").label(),
            Some("Compact sidebar")
        );
    })
    .unwrap();
}

#[gpui_kit::test]
fn about_names_the_version_and_the_licences_the_app_carries(cx: &mut TestAppContext) {
    let root = scratch("about");
    let data = DataRoot::at(root.join("data")).unwrap();
    start(cx, &data);
    let opened = open_shell(cx, &data);
    let handle = opened.handle;

    choose_from_menu(cx, handle, "Oriel", "About Oriel");
    assert_eq!(
        label_of(cx, handle, "about-version"),
        Some(format!("Version {}", oriel::about::VERSION))
    );
    // A development build carries no notices, and says where the bundle keeps them.
    assert!(is_drawn(cx, handle, "about-licences"));
    assert!(!is_drawn(cx, handle, "about-show-licences"));
    click(cx, handle, "about-ok");
    assert!(!is_drawn(cx, handle, "about-version"));

    // The bundle's index, as `xtask bundle` writes it, is listed with each licence.
    let licenses = root.join("licenses");
    std::fs::create_dir_all(&licenses).unwrap();
    std::fs::write(
        licenses.join("index.json"),
        r#"{"app":"Oriel","version":"0.0.1","notices":[
            {"folder":"oriel","name":"Oriel","version":"0.0.1","licence":"MIT"},
            {"folder":"media-tools","name":"ffmpeg and ffprobe","version":"9.0.2",
             "licence":"GPL-3.0-or-later"}]}"#,
    )
    .unwrap();
    cx.update_window(handle, |_, window, cx| {
        let index = oriel::about::LicenceIndex::read(&licenses);
        oriel::about::show(index, window, cx);
    })
    .unwrap();
    frame(cx, handle);
    cx.update_window(handle, |_, window, _| {
        let list = window.find("about-licences");
        assert_eq!(
            (list.role(), list.label()),
            (Some(Role::List), Some("Licences"))
        );
        assert_eq!(
            window.find(("about-licence", 1usize)).label(),
            Some("ffmpeg and ffprobe 9.0.2: GPL-3.0-or-later")
        );
        assert_eq!(
            window.find("about-show-licences").label(),
            Some("Show Licences")
        );
    })
    .unwrap();
}

#[gpui_kit::test]
fn a_new_toast_replaces_the_one_showing(cx: &mut TestAppContext) {
    let data = DataRoot::at(scratch("toasts").join("data")).unwrap();
    start(cx, &data);
    let opened = open_shell(cx, &data);
    let handle = opened.handle;
    let count = |cx: &mut TestAppContext| {
        cx.update_window(handle, |_, window, cx| {
            gpui_kit::component::WindowExt::notifications(window, cx).len()
        })
        .unwrap()
    };

    cx.update_window(handle, |_, window, cx| {
        window.show_toast(
            Toast::done("Moved 3 files to holding").action("Undo", |_, _| {}),
            cx,
        );
    })
    .unwrap();
    frame(cx, handle);
    assert_eq!(count(cx), 1);
    cx.update_window(handle, |_, window, cx| {
        window.show_toast(
            Toast::error("Undo failed").detail("The file is open elsewhere."),
            cx,
        );
    })
    .unwrap();
    frame(cx, handle);
    assert_eq!(count(cx), 1);
}

#[gpui_kit::test]
fn the_keyboard_reaches_the_switcher_and_presses_it(cx: &mut TestAppContext) {
    let data = DataRoot::at(scratch("keyboard").join("data")).unwrap();
    start(cx, &data);
    let opened = open_shell(cx, &data);
    let handle = opened.handle;

    press(cx, handle, "tab");
    press(cx, handle, "tab");
    let focused = cx
        .update_window(handle, |_, window, _| window.find("mode-Tidy").focused())
        .unwrap();
    assert_eq!(focused, Some(true), "Tab goes to the switcher, in order");
    press(cx, handle, "space");
    assert_eq!(mode(&opened, cx), ModeId::Tidy);

    // The keys still reach the shell once the button pressed is no longer drawn.
    press(cx, handle, "cmd-3");
    assert_eq!(mode(&opened, cx), ModeId::Sync);
}
