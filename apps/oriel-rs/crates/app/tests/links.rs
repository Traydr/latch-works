//! Electron Oriel's `e2e/tests/oriel/links.spec.ts` as a GPUI test: a folder Tidy tidies is
//! offered to View, and the modes hand files and folders on. View shows a file in Tidy, at the
//! Library filtered to it; Tidy's Inspector and Overview open a file and the whole folder in
//! View; and Tidy's Overview starts a Sync profile for its folder. Then what Oriel RS adds: Tidy
//! offers only folders inside its sandbox, and says why it cannot take one outside; and every
//! mode's location switcher offers one shared list of folders, each opened in that mode alone.

mod support;

use std::path::Path;

use gpui_kit::test::TestWindowExt as _;
use gpui_kit::{AppContext as _, TestAppContext};
use oriel_core_paths::DataRoot;
use oriel_mode_sync::Screen;
use oriel_mode_tidy::{TidyPage, last_toast};
use oriel_ui::folders::offered_folder_id;
use oriel_ui::locations::{SWITCHER_ID, location_id};
use oriel_ui::{HandOff, ModeId};

use support::*;

/// Tidy's folder, once the engine has it and its scan is done.
fn tidies(opened: &Opened, folder: &Path, cx: &mut TestAppContext) -> bool {
    cx.update(|cx| {
        let state = opened.shell.read(cx).tidy().read(cx).state().read(cx);
        state
            .root()
            .is_some_and(|root| Path::new(&root.path) == folder && root.last_scan_at.is_some())
            && !state.is_busy()
    })
}

fn tidy_ready(opened: &Opened, cx: &mut TestAppContext) -> bool {
    cx.update(|cx| {
        opened
            .shell
            .read(cx)
            .tidy()
            .read(cx)
            .state()
            .read(cx)
            .is_ready()
    })
}

#[gpui_kit::test]
fn a_folder_tidy_tidies_is_offered_to_view_and_the_modes_hand_files_and_folders_on(
    cx: &mut TestAppContext,
) {
    let root = scratch("links");
    let archive = root.join("archive");
    write_archive(&archive);
    let data = DataRoot::at(root.join("data")).unwrap();
    start(cx, &data);
    let opened = open_shell(cx, &data);
    let handle = opened.handle;

    // Tidy takes the archive and scans it.
    press(cx, handle, "cmd-2");
    wait_until(cx, handle, "Tidy's engine", |cx| tidy_ready(&opened, cx));
    let tidy = cx.update(|cx| opened.shell.read(cx).tidy().clone());
    cx.update_window(handle, |_, window, cx| {
        tidy.update(cx, |tidy, cx| tidy.add_folder(archive.clone(), window, cx));
    })
    .unwrap();
    wait_until(cx, handle, "Tidy's scan", |cx| {
        tidies(&opened, &archive, cx)
    });

    // View has no folder of its own yet, so it offers the one Tidy tidies.
    press(cx, handle, "cmd-1");
    let offered = offered_folder_id(&archive);
    assert_eq!(
        label_of(cx, handle, offered.clone()).as_deref(),
        Some("archive")
    );
    click(cx, handle, offered);
    wait_until(cx, handle, "View to list the archive", |cx| {
        view_shows(&opened, &archive, cx)
    });
    assert_eq!(heading(cx, handle).as_deref(), Some("archive"));

    // The viewer shows its file in Tidy, at the Library filtered to it.
    let bulk = archive.join("bulk");
    double_click(cx, handle, folder_tile(&bulk));
    wait_until(cx, handle, "View to list bulk", |cx| {
        view_shows(&opened, &bulk, cx)
    });
    assert_eq!(heading(cx, handle).as_deref(), Some("bulk"));
    let first = bulk.join("bulk-001.webp");
    double_click(cx, handle, media_tile(&first));
    assert_eq!(
        label_of(cx, handle, "viewer").as_deref(),
        Some("Viewer for bulk-001.webp")
    );
    click(cx, handle, "viewer-show-in-tidy");
    assert_eq!(mode(&opened, cx), ModeId::Tidy);
    assert_eq!(title(cx, handle).as_deref(), Some("Tidy – Oriel RS"));
    let library = cx.update(|cx| opened.shell.read(cx).tidy().read(cx).library().clone());
    wait_until(cx, handle, "the Library filtered to the file", |cx| {
        cx.update(|cx| library.read(cx).total(cx) == Some(1))
    });
    cx.update(|cx| {
        let tidy = opened.shell.read(cx).tidy().read(cx);
        assert_eq!(tidy.page(), TidyPage::Library);
        let library = library.read(cx);
        assert_eq!(library.search(), "bulk-001.webp");
        assert_eq!(library.filters().dir.as_deref(), Some("bulk"));
    });
    // View stays as it was underneath; close its viewer, so the next step has to open it.
    press(cx, handle, "cmd-1");
    press(cx, handle, "escape");
    assert!(!is_drawn(cx, handle, "viewer"));
    press(cx, handle, "cmd-2");

    // Tidy's Inspector opens the file in View's viewer.
    cx.update(|cx| {
        library.update(cx, |library, cx| {
            library
                .table()
                .update(cx, |table, cx| table.set_selected_row(0, cx));
        });
    });
    frame(cx, handle);
    if !is_drawn(cx, handle, "library-inspector") {
        click(cx, handle, "library-inspector-toggle");
    }
    click(cx, handle, "inspector-open-in-view");
    assert_eq!(mode(&opened, cx), ModeId::View);
    assert_eq!(title(cx, handle).as_deref(), Some("View – Oriel RS"));
    wait_until(cx, handle, "the viewer", |cx| {
        label_of(cx, handle, "viewer").is_some()
    });
    assert_eq!(
        label_of(cx, handle, "viewer").as_deref(),
        Some("Viewer for bulk-001.webp")
    );
    press(cx, handle, "escape");
    assert!(!is_drawn(cx, handle, "viewer"));

    // Tidy's Overview opens the whole folder in View.
    press(cx, handle, "cmd-2");
    click(cx, handle, "tidy-Overview");
    click(cx, handle, "overview-open-in-view");
    assert_eq!(title(cx, handle).as_deref(), Some("View – Oriel RS"));
    wait_until(cx, handle, "View to list the archive again", |cx| {
        view_shows(&opened, &archive, cx)
    });
    assert_eq!(heading(cx, handle).as_deref(), Some("archive"));

    // Tidy's Overview starts a Sync profile for the folder it tidies.
    press(cx, handle, "cmd-2");
    click(cx, handle, "overview-sync-folder");
    assert_eq!(title(cx, handle).as_deref(), Some("Sync – Oriel RS"));
    cx.update(|cx| {
        let sync = opened.shell.read(cx).sync().read(cx);
        assert_eq!(*sync.screen(), Screen::Form { editing: None });
        assert_eq!(
            sync.form_source_root(cx).as_ref(),
            archive.to_string_lossy()
        );
        assert_eq!(sync.form_name(cx).as_ref(), "archive");
    });

    // The folders each mode works on are known with the modes that use them, so Sync's empty
    // state offers View's and Tidy's folder too.
    cx.update(|cx| {
        let state = opened.shell.read(cx).state().read(cx);
        let known = state.known_folders();
        assert_eq!(known.len(), 1);
        assert_eq!(known[0].path(), archive);
        assert_eq!(known[0].modes(), [ModeId::View, ModeId::Tidy]);
        assert_eq!(state.offered_to(ModeId::Sync).len(), 1);
        assert!(state.offered_to(ModeId::View).is_empty());
    });

    // Once saved, the profile's menu opens its folder in View and in Tidy.
    cx.update_window(handle, |_, window, cx| {
        window.click("profile-api-url", cx);
        window.input("http://localhost:3000", cx);
    })
    .unwrap();
    click(cx, handle, "profile-save");
    assert!(is_drawn(cx, handle, "sync-profile-menu"));
    choose_profile_action(cx, handle, "Tidy this folder");
    assert_eq!(mode(&opened, cx), ModeId::Tidy);
    cx.update(|cx| {
        assert_eq!(
            opened.shell.read(cx).tidy().read(cx).page(),
            TidyPage::Library
        );
        let library = library.read(cx);
        assert_eq!(
            (library.search(), library.filters().dir.as_deref()),
            ("", None)
        );
    });
    press(cx, handle, "cmd-3");
    choose_profile_action(cx, handle, "Open in View");
    assert_eq!(mode(&opened, cx), ModeId::View);
    assert_eq!(heading(cx, handle).as_deref(), Some("archive"));
}

/// Chooses `action` from the profile menu (`Profile actions`), whose items are known by name.
fn choose_profile_action(cx: &mut TestAppContext, handle: gpui_kit::AnyWindowHandle, action: &str) {
    click(cx, handle, "sync-profile-menu");
    let item = cx
        .update_window(handle, |_, window, _| {
            let menu = window.within("popup-menu");
            (0..16usize).find(|ix| {
                menu.try_find(gpui_kit::ElementId::Integer(*ix as u64))
                    .is_some_and(|item| item.label() == Some(action))
            })
        })
        .unwrap()
        .unwrap_or_else(|| panic!("no {action} in the profile menu"));
    cx.update_window(handle, |_, window, cx| {
        window
            .within("popup-menu")
            .click(gpui_kit::ElementId::Integer(item as u64), cx);
    })
    .unwrap();
    frame(cx, handle);
}

#[gpui_kit::test]
fn tidy_takes_only_folders_inside_its_sandbox(cx: &mut TestAppContext) {
    let root = scratch("links-sandbox");
    let inside = root.join("archive");
    write_archive(&inside);
    let data = DataRoot::at(root.join("data")).unwrap();
    start(cx, &data);
    let opened = open_shell(cx, &data);
    let handle = opened.handle;
    wait_until(cx, handle, "Tidy's engine", |cx| tidy_ready(&opened, cx));

    // View's folder lies outside the sandbox and the temp folder (this crate's own source,
    // which View only reads), so Tidy's empty state does not offer it.
    let outside = std::fs::canonicalize(env!("CARGO_MANIFEST_DIR")).unwrap();
    assert!(!data.admits_tidy_root(&outside));
    cx.update_window(handle, |_, window, cx| {
        opened
            .shell
            .update(cx, |shell, cx| shell.open_in_view(&outside, window, cx));
    })
    .unwrap();
    wait_until(cx, handle, "View to open its folder", |cx| {
        cx.update(|cx| opened.shell.read(cx).state().read(cx).known_folders().len() == 1)
    });
    press(cx, handle, "cmd-2");
    assert!(
        is_drawn(cx, handle, "choose-folder"),
        "Tidy shows its welcome"
    );
    assert!(!is_drawn(cx, handle, offered_folder_id(&outside)));

    // Tidy this folder, for a folder outside: Tidy says why it cannot, and adds nothing.
    cx.update_window(handle, |_, window, cx| {
        opened.shell.update(cx, |shell, cx| {
            shell.hand_off(ModeId::Tidy, HandOff::Folder(outside.clone()), window, cx);
        });
    })
    .unwrap();
    frame(cx, handle);
    assert_eq!(
        cx.update(|cx| last_toast(cx)).as_deref(),
        Some("Tidy can't take “app”")
    );
    assert!(cx.update(|cx| {
        opened
            .shell
            .read(cx)
            .tidy()
            .read(cx)
            .state()
            .read(cx)
            .roots()
            .is_empty()
    }));

    // A folder inside is offered once View works on it, and one click tidies it.
    cx.update_window(handle, |_, window, cx| {
        opened
            .shell
            .update(cx, |shell, cx| shell.open_in_view(&inside, window, cx));
    })
    .unwrap();
    wait_until(cx, handle, "View to open the archive", |cx| {
        view_shows(&opened, &inside, cx)
    });
    press(cx, handle, "cmd-2");
    let offered = offered_folder_id(&inside);
    assert_eq!(
        label_of(cx, handle, offered.clone()).as_deref(),
        Some("archive")
    );
    click(cx, handle, offered);
    wait_until(cx, handle, "Tidy's scan", |cx| tidies(&opened, &inside, cx));
}

/// The bounds of the location switcher on screen, and of its menu once it is open.
fn switcher(
    cx: &mut TestAppContext,
    handle: gpui_kit::AnyWindowHandle,
) -> gpui_kit::Bounds<gpui_kit::Pixels> {
    cx.update_window(handle, |_, window, _| window.find(SWITCHER_ID).bounds())
        .unwrap()
}

/// Opens the switcher's menu and says how it reads `folder`'s row: its name and which modes use
/// it. The menu is the switcher's width, from its left edge: the sidebar's, inside its margins.
fn open_locations(
    cx: &mut TestAppContext,
    handle: gpui_kit::AnyWindowHandle,
    folder: &Path,
) -> Option<(String, String)> {
    let trigger = switcher(cx, handle);
    click(cx, handle, SWITCHER_ID);
    cx.update_window(handle, |_, window, _| {
        let menu = window.find("popup-menu").bounds();
        // The switcher's recorded bounds take in its focus line, a pixel or two out.
        let near = |a: gpui_kit::Pixels, b: gpui_kit::Pixels| (a - b).abs() <= gpui_kit::px(2.);
        assert!(
            near(menu.origin.x, trigger.origin.x) && near(menu.size.width, trigger.size.width),
            "the menu {menu:?} spans the switcher {trigger:?}"
        );
        window.try_find(location_id(folder)).map(|row| {
            (
                row.label().unwrap_or_default().to_owned(),
                row.description().unwrap_or_default().to_owned(),
            )
        })
    })
    .unwrap()
}

#[gpui_kit::test]
fn every_mode_switches_location_from_one_shared_list(cx: &mut TestAppContext) {
    let root = scratch("links-locations");
    let archive = root.join("archive");
    write_archive(&archive);
    let data = DataRoot::at(root.join("data")).unwrap();
    start(cx, &data);
    let opened = open_shell(cx, &data);
    let handle = opened.handle;

    // A folder added in Tidy is Tidy's location, in its switcher and its menu.
    press(cx, handle, "cmd-2");
    wait_until(cx, handle, "Tidy's engine", |cx| tidy_ready(&opened, cx));
    let tidy = cx.update(|cx| opened.shell.read(cx).tidy().clone());
    cx.update_window(handle, |_, window, cx| {
        tidy.update(cx, |tidy, cx| tidy.add_folder(archive.clone(), window, cx));
    })
    .unwrap();
    wait_until(cx, handle, "Tidy's scan", |cx| {
        tidies(&opened, &archive, cx)
    });
    assert_eq!(
        label_of(cx, handle, SWITCHER_ID).as_deref(),
        Some("archive")
    );
    let size = switcher(cx, handle).size;
    assert_eq!(
        open_locations(cx, handle, &archive),
        Some(("archive".into(), "In Tidy".into()))
    );
    press(cx, handle, "escape");

    // View, with no folder of its own, offers it at the same place and size; picking it opens it.
    press(cx, handle, "cmd-1");
    assert_eq!(
        label_of(cx, handle, SWITCHER_ID).as_deref(),
        Some("No folder open")
    );
    assert_eq!(switcher(cx, handle).size, size);
    assert_eq!(
        open_locations(cx, handle, &archive),
        Some(("archive".into(), "In Tidy".into()))
    );
    click(cx, handle, location_id(&archive));
    wait_until(cx, handle, "View to list the archive", |cx| {
        view_shows(&opened, &archive, cx)
    });
    assert_eq!(
        label_of(cx, handle, SWITCHER_ID).as_deref(),
        Some("archive")
    );
    assert_eq!(
        open_locations(cx, handle, &archive),
        Some(("archive".into(), "In View and Tidy".into()))
    );
    press(cx, handle, "escape");

    // Sync offers it too, and picking it starts a profile for it; Sync's selection stays its own.
    press(cx, handle, "cmd-3");
    assert_eq!(
        label_of(cx, handle, SWITCHER_ID).as_deref(),
        Some("No profile yet")
    );
    assert_eq!(switcher(cx, handle).size, size);
    assert_eq!(
        open_locations(cx, handle, &archive),
        Some(("archive".into(), "In View and Tidy".into()))
    );
    click(cx, handle, location_id(&archive));
    cx.update(|cx| {
        let sync = opened.shell.read(cx).sync().read(cx);
        assert_eq!(*sync.screen(), Screen::Form { editing: None });
        assert_eq!(
            sync.form_source_root(cx).as_ref(),
            archive.to_string_lossy()
        );
    });

    // In the rail the switcher is the same tile in every mode.
    let shell = cx.update(|cx| opened.shell.read(cx).state().clone());
    shell.update(cx, |state, cx| state.toggle_rail(cx));
    frame(cx, handle);
    let tile = switcher(cx, handle).size;
    assert!(tile.width < size.width);
    for key in ["cmd-1", "cmd-2"] {
        press(cx, handle, key);
        assert_eq!(switcher(cx, handle).size, tile, "{key}");
    }
}
