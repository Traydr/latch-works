//! Electron Oriel's `e2e/tests/oriel/welcome.spec.ts` as a GPUI test: the first start's welcome
//! sets one folder up for View and Tidy, then shows no more. Oriel RS's Tidy works only inside
//! its sandbox, so the case first chooses a folder outside it, where "Tidy it" is off and says
//! why, then changes to one inside.

mod support;

use std::path::Path;

use gpui_kit::test::TestWindowExt as _;
use gpui_kit::{AppContext as _, TestAppContext};
use oriel_core_paths::DataRoot;
use oriel_migrate::{ElectronData, Owners, Platform};
use oriel_rs::welcome::ImportSource;
use oriel_ui::{ModeId, SettingsSection};

use support::*;

/// Answers the system's folder picker with `folder`, as the owner would.
fn choose(cx: &mut TestAppContext, opened: &Opened, folder: &Path) {
    click(cx, opened.handle, "welcome-choose-folder");
    assert!(cx.did_prompt_for_paths(), "Choose Folder… asks the system");
    let folder = folder.to_path_buf();
    cx.simulate_path_prompt_response(move |options| {
        assert!(options.directories && !options.files);
        Some(vec![folder])
    });
    frame(cx, opened.handle);
}

fn offer_welcome(cx: &mut TestAppContext, opened: &Opened) {
    cx.update_window(opened.handle, |_, window, cx| {
        opened
            .shell
            .update(cx, |shell, cx| shell.offer_welcome(window, cx));
    })
    .unwrap();
    frame(cx, opened.handle);
}

#[gpui_kit::test]
fn the_first_starts_welcome_sets_one_folder_up_for_view_and_tidy_then_shows_no_more(
    cx: &mut TestAppContext,
) {
    let root = scratch("welcome");
    let archive = root.join("archive");
    write_archive(&archive);
    let data = DataRoot::at(root.join("data")).unwrap();
    start(cx, &data);
    let opened = open_shell(cx, &data);
    let handle = opened.handle;
    offer_welcome(cx, &opened);

    assert_eq!(
        label_of(cx, handle, "welcome").as_deref(),
        Some("Welcome to Oriel RS")
    );
    assert!(is_drawn(cx, handle, "welcome-skip"));

    // A folder outside the sandbox: View may open it, Tidy may not, and the welcome says why.
    let outside = std::fs::canonicalize(env!("CARGO_MANIFEST_DIR")).unwrap();
    choose(cx, &opened, &outside);
    let tidy_it = |cx: &mut TestAppContext| {
        cx.update_window(handle, |_, window, _| {
            let switch = window.find("welcome-tidy-it");
            (switch.checked(), switch.disabled().unwrap_or(false))
        })
        .unwrap()
    };
    assert_eq!(tidy_it(cx), (Some(false), true));
    assert!(!is_drawn(cx, handle, "welcome-skip"));

    // The archive, inside the temp folder, which the sandbox admits: Tidy it is on.
    choose(cx, &opened, &archive);
    assert_eq!(
        label_of(cx, handle, "welcome-folder-path").as_deref(),
        Some(archive.to_string_lossy().as_ref())
    );
    assert_eq!(tidy_it(cx), (Some(true), false));
    // Tidy's catalog opens in the background; Start waits for it either way.
    wait_until(cx, handle, "Tidy's engine", |cx| {
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
    });
    click(cx, handle, "welcome-start");

    // It lands in View, scanning the folder, and Tidy has it too.
    wait_until(cx, handle, "the welcome to close", |cx| {
        cx.update(|cx| opened.shell.read(cx).welcome().is_none())
    });
    assert!(!is_drawn(cx, handle, "welcome"));
    assert_eq!(mode(&opened, cx), ModeId::View);
    assert_eq!(title(cx, handle).as_deref(), Some("View – Oriel RS"));
    wait_until(cx, handle, "View to list the archive", |cx| {
        view_shows(&opened, &archive, cx)
    });
    assert_eq!(heading(cx, handle).as_deref(), Some("archive"));
    assert!(is_drawn(
        cx,
        handle,
        media_tile(&archive.join("root-image.webp"))
    ));
    press(cx, handle, "cmd-2");
    wait_until(cx, handle, "Tidy's folder", |cx| {
        label_of(cx, handle, "tidy-root-switcher").as_deref() == Some("archive")
    });
    assert!(data.shell().join("welcomed").exists());

    // The next start shows no welcome.
    cx.update_window(handle, |_, window, _| window.remove_window())
        .unwrap();
    cx.run_until_parked();
    let second = open_shell(cx, &data);
    offer_welcome(cx, &second);
    assert!(cx.update(|cx| second.shell.read(cx).welcome().is_none()));
    assert!(!is_drawn(cx, second.handle, "welcome"));
}

#[gpui_kit::test]
fn skipping_the_welcome_sets_nothing_up_and_shows_it_no_more(cx: &mut TestAppContext) {
    let root = scratch("welcome-skip");
    let data = DataRoot::at(root.join("data")).unwrap();
    start(cx, &data);
    let opened = open_shell(cx, &data);
    offer_welcome(cx, &opened);
    assert!(is_drawn(cx, opened.handle, "welcome"));

    click(cx, opened.handle, "welcome-skip");
    assert!(cx.update(|cx| opened.shell.read(cx).welcome().is_none()));
    assert!(!is_drawn(cx, opened.handle, "welcome"));
    assert_eq!(mode(&opened, cx), ModeId::View);
    assert!(data.shell().join("welcomed").exists());
    assert!(cx.update(|cx| opened.shell.read(cx).view().read(cx).folder(cx).is_none()));
}

/// Electron Oriel's data as it writes it, under a stand-in home: the window, its preferences in
/// Chromium's LevelDB (the migrate crate's fixture, which Electron wrote), View's settings with
/// its folder, a Sync profile and its hash cache.
fn electron_home(root: &Path, archive: &Path) -> std::path::PathBuf {
    let home = root.join("home");
    let latch_works = home.join(".latch-works");
    let oriel = latch_works.join("oriel");
    let leveldb = oriel.join("Local Storage/leveldb");
    std::fs::create_dir_all(&leveldb).unwrap();
    let fixture =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../migrate/tests/fixtures/local-storage");
    for entry in std::fs::read_dir(fixture).unwrap() {
        let entry = entry.unwrap();
        std::fs::copy(entry.path(), leveldb.join(entry.file_name())).unwrap();
    }
    std::fs::write(
        oriel.join("window-state.json"),
        r#"{"bounds":{"x":0,"y":0,"width":1400,"height":900},"maximized":false}"#,
    )
    .unwrap();
    let view = latch_works.join("frame-view");
    std::fs::create_dir_all(&view).unwrap();
    std::fs::write(
        view.join("frame-view-settings.json"),
        serde_json::json!({
            "version": 3,
            "settings": { "lastFolderPath": archive },
            "windowBounds": null,
            "windowMaximized": false,
        })
        .to_string(),
    )
    .unwrap();
    let lockstep = latch_works.join("lockstep");
    std::fs::create_dir_all(&lockstep).unwrap();
    std::fs::write(
        lockstep.join("lockstep-settings.json"),
        serde_json::json!({
            "activeProfileId": "p1",
            "profiles": [{ "apiUrl": "http://127.0.0.1:3000", "id": "p1", "name": "archive",
                           "sourceRoot": archive }],
        })
        .to_string(),
    )
    .unwrap();
    std::fs::create_dir_all(latch_works.join("hash-cache/v1")).unwrap();
    std::fs::write(latch_works.join("hash-cache/v1/0f1e.json"), "{}").unwrap();
    home
}

fn import_from(cx: &mut TestAppContext, home: &Path) {
    let source = ElectronData::under(home, &Owners::default(), false, Platform::CURRENT);
    cx.update(|cx| cx.set_global(ImportSource(Some(source))));
}

#[gpui_kit::test]
fn the_welcome_offers_electron_oriels_data_first_and_imports_it(cx: &mut TestAppContext) {
    let root = scratch("welcome-import");
    let archive = root.join("archive");
    write_archive(&archive);
    let home = electron_home(&root, &archive);
    let data = DataRoot::at(root.join("data")).unwrap();
    start(cx, &data);
    import_from(cx, &home);
    let opened = open_shell(cx, &data);
    let handle = opened.handle;
    offer_welcome(cx, &opened);

    // What was found comes first, as counts; the folder picker waits behind Start Fresh.
    wait_until(cx, handle, "the look at Electron Oriel's data", |cx| {
        is_drawn(cx, handle, "import-start")
    });
    let found = label_of(cx, handle, "import-found").unwrap();
    assert!(found.contains("View: Its folder and settings"), "{found}");
    assert!(found.contains("Sync: 1 profile"), "{found}");
    assert!(!is_drawn(cx, handle, "welcome-choose-folder"));
    assert!(is_drawn(cx, handle, "import-start-fresh"));

    click(cx, handle, "import-start");
    wait_until(cx, handle, "the import", |cx| {
        is_drawn(cx, handle, "import-summary")
    });
    let summary = label_of(cx, handle, "import-summary").unwrap();
    assert!(
        summary.contains("Window and preferences: the window's size and place, 9 preferences"),
        "{summary}"
    );
    assert!(summary.contains("Sync: 1 profile"), "{summary}");
    assert!(is_drawn(cx, handle, "import-restart"));
    // Staged, and put in place at the next start, before anything opens its files.
    assert!(oriel_migrate::pending(&data));
    assert!(
        !data.shell().join("local-storage.json").exists() || {
            let text = std::fs::read_to_string(data.shell().join("local-storage.json")).unwrap();
            !text.contains("glazier.library.mode")
        }
    );
    let report = oriel_migrate::finish_pending(&data).unwrap();
    assert!(report.failed().next().is_none(), "{report:#?}");
    let storage = std::fs::read_to_string(data.shell().join("local-storage.json")).unwrap();
    assert!(
        storage.contains("\"glazier.library.mode\":\"grid\""),
        "{storage}"
    );
    assert!(data.view().join("frame-view-settings.json").is_file());
    assert!(data.sync().join("lockstep-settings.json").is_file());
    assert!(data.shell().join("migration.json").is_file());

    // Later closes the welcome, which shows no more.
    click(cx, handle, "import-later");
    assert!(cx.update(|cx| opened.shell.read(cx).welcome().is_none()));
    assert!(data.shell().join("welcomed").exists());
}

#[gpui_kit::test]
fn start_fresh_turns_the_welcome_to_its_folder_picker(cx: &mut TestAppContext) {
    let root = scratch("welcome-fresh");
    let archive = root.join("archive");
    write_archive(&archive);
    let home = electron_home(&root, &archive);
    let data = DataRoot::at(root.join("data")).unwrap();
    start(cx, &data);
    import_from(cx, &home);
    let opened = open_shell(cx, &data);
    offer_welcome(cx, &opened);
    wait_until(
        cx,
        opened.handle,
        "the look at Electron Oriel's data",
        |cx| is_drawn(cx, opened.handle, "import-start-fresh"),
    );
    click(cx, opened.handle, "import-start-fresh");
    assert!(!is_drawn(cx, opened.handle, "import"));
    assert!(is_drawn(cx, opened.handle, "welcome-choose-folder"));
    assert!(is_drawn(cx, opened.handle, "welcome-skip"));
    assert!(!oriel_migrate::pending(&data));
}

#[gpui_kit::test]
fn settings_imports_again_and_says_what_moves_aside(cx: &mut TestAppContext) {
    let root = scratch("settings-import");
    let archive = root.join("archive");
    write_archive(&archive);
    let home = electron_home(&root, &archive);
    let data = DataRoot::at(root.join("data")).unwrap();
    start(cx, &data);
    import_from(cx, &home);
    // Oriel RS has preferences of its own already.
    std::fs::write(
        data.shell().join("local-storage.json"),
        r#"{"oriel.theme":"dark"}"#,
    )
    .unwrap();
    let opened = open_shell(cx, &data);
    let handle = opened.handle;
    cx.update(|cx| {
        let state = opened.shell.read(cx).state().clone();
        state.update(cx, |state, cx| {
            state.open_settings(SettingsSection::General, cx)
        });
    });
    frame(cx, handle);
    click(cx, handle, "import-electron-oriel");
    wait_until(cx, handle, "the look at Electron Oriel's data", |cx| {
        is_drawn(cx, handle, "import-start")
    });
    assert_eq!(
        label_of(cx, handle, "import-moves-aside").as_deref(),
        Some(
            "Oriel RS's own preferences and View data move to a before-import folder in its \
             data folder. Nothing is deleted."
        )
    );
    assert!(is_drawn(cx, handle, "import-cancel"));
    assert!(!is_drawn(cx, handle, "import-start-fresh"));
    click(cx, handle, "import-cancel");
    assert!(!is_drawn(cx, handle, "import"));
    assert!(!oriel_migrate::pending(&data));
}
