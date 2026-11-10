//! The shell's cases from Electron Oriel's e2e shell spec, as GPUI tests: it
//! starts in View and switches modes from the switcher and the menu, reopens in the mode it
//! showed last, keeps View's folder while another mode shows, and has one Settings page at the
//! section of the mode on screen. Then what the shell adds around them that is worth pinning:
//! the window's state round trip, quitting while work runs, the activity marks, every mode's jobs
//! in one place, and the names VoiceOver reads.

use std::path::Path;
use std::rc::Rc;
use std::time::Duration;

use gpui_kit::component::{ActiveTheme as _, WindowExt as _};
use gpui_kit::test::TestWindowExt as _;
use gpui_kit::{
    Action, AnyWindowHandle, AppContext as _, Bounds, OwnedMenuItem, Role, TestAppContext,
    VisualTestContext, WindowBounds, px, size,
};
use oriel_core_paths::{DataRoot, Notice, NoticeIndex};
use oriel_mode_tidy::{TidyMode, TidyPage};
use oriel_mode_view::ViewMode;
use oriel_ui::{
    ActivityJob, JobCommand, JobControl, JobState, LocalStorage, ModeActivity, ModeId,
    ModeReporter, Toast, ToastExt as _, Work,
};

use crate::support::*;

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
        ("secondary-2", ModeId::Tidy),
        ("secondary-3", ModeId::Sync),
        ("secondary-1", ModeId::View),
    ] {
        press(cx, handle, key);
        assert_eq!(mode(&opened, cx), expected, "after {key}");
    }
    menu_item(cx, "File", "Open Folder…");
    press(cx, handle, "secondary-2");
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
        ("secondary-2", ModeId::Tidy),
        ("secondary-3", ModeId::Sync),
        ("secondary-1", ModeId::View),
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

    press(cx, handle, "secondary-\\");
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
    press(cx, first.handle, "secondary-3");
    press(cx, first.handle, "secondary-\\");
    click(cx, first.handle, "settings-item");
    click(cx, first.handle, "settings-section-general");
    click(cx, first.handle, "theme-dark");
    cx.update_window(first.handle, |_, window, _| window.remove_window())
        .unwrap();
    cx.run_until_parked();

    let stored = std::fs::read_to_string(data.local_storage()).unwrap();
    let stored: serde_json::Value = serde_json::from_str(&stored).unwrap();
    assert_eq!(stored["oriel.mode"], "sync");
    assert_eq!(stored["oriel.sidebar"], "rail");
    assert_eq!(stored["oriel.theme"], "dark");

    // A second start reads the file again, as the app does.
    cx.update(|cx| {
        LocalStorage::init(LocalStorage::open(&data.local_storage()), cx);
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
    let page = |cx: &mut TestAppContext| {
        cx.update(|cx| opened.shell.read(cx).mode::<TidyMode>().read(cx).page())
    };

    assert!(
        !is_drawn(cx, handle, "tidy-Library"),
        "Tidy is drawn while hidden"
    );
    press(cx, handle, "secondary-2");
    click(cx, handle, "tidy-Library");
    assert_eq!(page(cx), TidyPage::Library);

    press(cx, handle, "secondary-1");
    assert!(!is_drawn(cx, handle, "tidy-Library"));
    press(cx, handle, "secondary-2");
    assert_eq!(mode(&opened, cx), ModeId::Tidy);
    assert_eq!(page(cx), TidyPage::Library);
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
    press(cx, handle, "secondary-2");
    cx.update_window(handle, |_, window, cx| {
        opened
            .shell
            .update(cx, |shell, cx| shell.open_in_view(&archive, window, cx));
    })
    .unwrap();
    assert_eq!(mode(&opened, cx), ModeId::View);
    let shown = |cx: &mut TestAppContext| {
        cx.update(|cx| {
            let view = opened.shell.read(cx).mode::<ViewMode>().read(cx);
            (
                view.folder(cx).map(|folder| folder.to_path_buf()),
                view.gallery().read(cx).media().len(),
            )
        })
    };
    wait_until(cx, handle, "View to list the folder", |cx| shown(cx).1 == 3);
    let real = oriel_runtime::paths::canonicalize(&archive).unwrap();
    assert_eq!(shown(cx), (Some(real.clone()), 3));
    let tile = gpui_kit::ElementId::Path(real.join("still-0.webp").into());
    let tile_drawn = |cx: &mut TestAppContext| {
        cx.update_window(handle, |_, window, _| {
            window.try_find(tile.clone()).is_some()
        })
        .unwrap()
    };
    assert!(tile_drawn(cx));

    press(cx, handle, "secondary-2");
    assert!(!tile_drawn(cx), "View's tiles are drawn while Tidy shows");
    press(cx, handle, "secondary-1");
    assert_eq!(shown(cx), (Some(real), 3));
    assert!(tile_drawn(cx));
}

/// Waits, in real time, for View to show `folder` with its scan done: View scans on threads of
/// its own.
fn wait_for_view_folder(cx: &mut TestAppContext, opened: &Opened, folder: &Path) {
    let shown = |cx: &mut TestAppContext| {
        cx.update(|cx| {
            let view = opened.shell.read(cx).mode::<ViewMode>().read(cx);
            let scanned =
                view.catalog().read(cx).state() == oriel_mode_view::catalog::ScanState::Done;
            (view.folder(cx).map(|folder| folder.to_path_buf()), scanned)
        })
    };
    wait_until(cx, opened.handle, "View to show the folder scanned", |cx| {
        shown(cx) == (Some(folder.to_path_buf()), true)
    });
}

#[gpui_kit::test]
fn reopens_on_the_page_it_showed_last_with_view_able_to_step_back_up(cx: &mut TestAppContext) {
    let root = scratch("reopens-page");
    let archive = root.join("archive");
    write_still(&archive.join("cover.webp"), 0);
    for ix in 0..2 {
        write_still(&archive.join(format!("comics/page-{ix}.webp")), ix * 90);
    }
    let archive = oriel_runtime::paths::canonicalize(&archive).unwrap();
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
    press(cx, first.handle, "secondary-2");
    click(cx, first.handle, "tidy-Library");
    cx.update_window(first.handle, |_, window, _| window.remove_window())
        .unwrap();
    cx.run_until_parked();

    // A second start reads the stored state again, as the app does.
    cx.update(|cx| LocalStorage::init(LocalStorage::open(&data.local_storage()), cx));
    let second = open_shell(cx, &data);
    assert_eq!(mode(&second, cx), ModeId::Tidy);
    assert_eq!(title(cx, second.handle).as_deref(), Some("Tidy – Oriel"));
    assert_eq!(
        cx.update(|cx| second.shell.read(cx).mode::<TidyMode>().read(cx).page()),
        TidyPage::Library
    );

    // View is back in the subfolder, and the folder opened above it is still the top.
    press(cx, second.handle, "secondary-1");
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
    press(cx, handle, "secondary-3");
    // The app menu holds Settings… on macOS; File does elsewhere.
    let settings_menu = if cfg!(target_os = "macos") {
        "Oriel"
    } else {
        "File"
    };
    choose_from_menu(cx, handle, settings_menu, "Settings…");
    assert_eq!(heading(cx).as_deref(), Some("Sync"));
    press(cx, handle, "escape");
    assert!(!is_drawn(cx, handle, "settings-back"));
    press(cx, handle, "secondary-,");
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

    let text = std::fs::read_to_string(data.window_state())
        .expect("the window state is written a moment after a resize");
    assert_eq!(
        text,
        r#"{"bounds":{"x":0,"y":0,"width":1500,"height":940},"maximized":false}"#
    );
    // The next window opens where this one was.
    let options = cx.update(|cx| oriel::main_window_options(&oriel::Launch::of(data.clone()), cx));
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
    // A push holds quitting; a scan does not.
    let report = |cx: &mut TestAppContext, shown: Option<ModeActivity>| {
        let work = Work {
            shown,
            holds_quit: matches!(shown, Some(ModeActivity::Progress(_))),
            jobs: Vec::new(),
        };
        cx.update(|cx| ModeReporter::new(&state, ModeId::Sync).report(work, cx));
        cx.run_until_parked();
    };

    // A scan does not hold the quit up.
    report(cx, Some(ModeActivity::Working));
    press(cx, handle, "secondary-q");
    assert_eq!((platform.hides.get(), platform.quits.get()), (0, 1));

    // A push does: ⌘Q hides the window, and the app quits when the push ends.
    let holds = |cx: &mut TestAppContext| {
        cx.update(|cx| opened.shell.read(cx).quit().read(cx).holds_quit())
    };
    assert!(!holds(cx));
    report(cx, Some(ModeActivity::Progress(0.3)));
    // The system's own quits (the Dock's Quit, logging out) read this to wait too.
    assert!(holds(cx));
    press(cx, handle, "secondary-q");
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
    press(cx, handle, "secondary-q");
    press(cx, handle, "secondary-q");
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
    cx.update(|cx| {
        for (mode, shown) in [
            (ModeId::Tidy, ModeActivity::Progress(0.4)),
            (ModeId::Sync, ModeActivity::Working),
            (ModeId::View, ModeActivity::Working),
        ] {
            let work = Work {
                shown: Some(shown),
                ..Work::default()
            };
            ModeReporter::new(&state, mode).report(work, cx);
        }
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
    press(cx, handle, "secondary-\\");
    assert!(is_drawn(cx, handle, "mode-Tidy-activity"));
    press(cx, handle, "secondary-2");
    assert!(!is_drawn(cx, handle, "mode-Tidy-activity"));
    assert!(is_drawn(cx, handle, "mode-View-activity"));
}

#[gpui_kit::test]
fn every_modes_jobs_show_in_one_place_at_the_bottom_right(cx: &mut TestAppContext) {
    let data = DataRoot::at(scratch("jobs").join("data")).unwrap();
    start(cx, &data);
    let opened = open_shell(cx, &data);
    let handle = opened.handle;
    let state = cx.update(|cx| opened.shell.read(cx).state().clone());
    let jobs = cx.update(|cx| state.read(cx).jobs().clone());
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
        let work = Work {
            jobs: list,
            ..Work::default()
        };
        cx.update(|cx| ModeReporter::new(&state, mode).report(work, cx));
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
    // Collapsed, once it has run long enough to say: the work that runs first, and how much more
    // runs and waits.
    cx.executor().advance_clock(Duration::from_millis(300));
    cx.run_until_parked();
    assert_eq!(
        label_of(cx, handle, "activity-indicator").as_deref(),
        Some("View · Scanning Pictures · 1 more running · 1 queued")
    );
    assert_eq!(
        label_of(cx, handle, "activity-indicator-queued").as_deref(),
        Some("1 queued")
    );
    // In every mode, and over Settings too.
    press(cx, handle, "secondary-3");
    assert!(is_drawn(cx, handle, "activity-indicator"));
    press(cx, handle, "secondary-,");
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
    // Work that ends at once has its toast to say so: the indicator waits to see that it won't.
    assert!(!is_drawn(cx, handle, "activity-indicator"));
    cx.executor().advance_clock(Duration::from_millis(300));
    cx.run_until_parked();
    assert!(is_drawn(cx, handle, "activity-indicator"));
    assert!(!is_drawn(cx, handle, "activity-panel"));
}

#[gpui_kit::test]
fn voiceover_reads_the_switcher_the_sidebar_and_the_top_bar_by_name(cx: &mut TestAppContext) {
    let data = DataRoot::at(scratch("names").join("data")).unwrap();
    start(cx, &data);
    let opened = open_shell(cx, &data);
    let handle = opened.handle;
    press(cx, handle, "secondary-2");

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
fn the_app_mark_reads_once_in_every_mode_and_settings_and_takes_no_tab_stop(
    cx: &mut TestAppContext,
) {
    let data = DataRoot::at(scratch("mark").join("data")).unwrap();
    start(cx, &data);
    let opened = open_shell(cx, &data);
    let handle = opened.handle;

    let check = |cx: &mut TestAppContext| {
        cx.update_window(handle, |_, window, _| {
            let mark = window.find("app-mark");
            assert_eq!(
                (mark.role(), mark.label()),
                (Some(Role::Label), Some("Oriel"))
            );
            assert_eq!(mark.focused(), None);
        })
        .unwrap();
    };
    for mode in ["secondary-1", "secondary-2", "secondary-3"] {
        press(cx, handle, mode);
        check(cx);
    }
    click(cx, handle, "settings-item");
    check(cx);
}

/// `?` and Help › Keyboard Shortcuts open a sheet in every mode, not only in Tidy.
#[gpui_kit::test]
fn every_mode_opens_a_shortcut_sheet(cx: &mut TestAppContext) {
    let data = DataRoot::at(scratch("sheets").join("data")).unwrap();
    start(cx, &data);
    let opened = open_shell(cx, &data);
    let handle = opened.handle;
    let sheet_open = |cx: &mut TestAppContext| {
        cx.update_window(handle, |_, window, cx| window.has_active_dialog(cx))
            .unwrap()
    };
    let close = |cx: &mut TestAppContext| {
        cx.update_window(handle, |_, window, cx| window.close_dialog(cx))
            .unwrap();
        frame(cx, handle);
    };
    for mode in ["secondary-1", "secondary-2", "secondary-3"] {
        press(cx, handle, mode);
        assert!(!sheet_open(cx));
        press(cx, handle, "?");
        assert!(sheet_open(cx), "? in {mode}");
        close(cx);
        cx.update_window(handle, |_, window, cx| {
            window.dispatch_action(Box::new(oriel_ui::shortcuts::ShowShortcuts), cx);
        })
        .unwrap();
        frame(cx, handle);
        assert!(sheet_open(cx), "the Help menu's item in {mode}");
        close(cx);
    }
}

#[gpui_kit::test]
fn about_names_the_version_and_the_licences_the_app_carries(cx: &mut TestAppContext) {
    let root = scratch("about");
    let data = DataRoot::at(root.join("data")).unwrap();
    start(cx, &data);
    let opened = open_shell(cx, &data);
    let handle = opened.handle;

    // The app menu holds About on macOS; Help does elsewhere.
    let about_menu = if cfg!(target_os = "macos") {
        "Oriel"
    } else {
        "Help"
    };
    choose_from_menu(cx, handle, about_menu, "About Oriel");
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
    let notice = |folder: &str, name: &str, version: &str, licence: &str| Notice {
        folder: folder.into(),
        name: name.into(),
        version: version.into(),
        licence: licence.into(),
    };
    let index = NoticeIndex {
        app: oriel_core_paths::APP_NAME.into(),
        version: "0.0.1".into(),
        notices: vec![
            notice("oriel", "Oriel", "0.0.1", "MIT"),
            notice(
                "media-tools",
                "ffmpeg and ffprobe",
                "9.0.2",
                "GPL-3.0-or-later",
            ),
        ],
    };
    std::fs::write(
        licenses.join(oriel_core_paths::NOTICE_INDEX_FILE),
        serde_json::to_string(&index).unwrap(),
    )
    .unwrap();
    cx.update_window(handle, |_, window, cx| {
        let index = oriel::about::LicenceIndex::read(&licenses);
        oriel::about::show(&root, index, window, cx);
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
            Some("Show licences")
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
    press(cx, handle, "secondary-3");
    assert_eq!(mode(&opened, cx), ModeId::Sync);
}
