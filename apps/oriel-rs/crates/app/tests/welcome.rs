//! Electron Oriel's `e2e/tests/oriel/welcome.spec.ts` as a GPUI test: the first start's welcome
//! sets one folder up for View and Tidy, then shows no more. Oriel RS's Tidy works only inside
//! its sandbox, so the case first chooses a folder outside it, where "Tidy it" is off and says
//! why, then changes to one inside.

mod support;

use std::path::Path;

use gpui_kit::test::TestWindowExt as _;
use gpui_kit::{AppContext as _, TestAppContext};
use oriel_core_paths::DataRoot;
use oriel_ui::ModeId;

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
