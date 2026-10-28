//! The shell's cases from Electron Oriel's `e2e/tests/oriel/shell.spec.ts` that Phase 0 has:
//! it starts in View, the keys switch modes, the sidebar folds to the rail, and a hidden mode
//! keeps its state.

use gpui_kit::test::TestWindowExt as _;
use gpui_kit::{
    AnyWindowHandle, AppContext as _, Bounds, Entity, Focusable as _, TestAppContext, WindowBounds,
    WindowOptions, px, size,
};
use oriel_mode_tidy::TidyPage;
use oriel_rs::shell::Shell;
use oriel_ui::ModeId;

fn open_shell(cx: &mut TestAppContext) -> (AnyWindowHandle, Entity<Shell>) {
    cx.update(|cx| {
        gpui_kit::init(cx);
        oriel_ui::theme::init(cx);
        oriel_rs::actions::init(cx);
    });
    let (handle, shell) = cx.update(|cx| {
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
                let shell = cx.new(|cx| Shell::new(window, cx));
                shell.focus_handle(cx).focus(window, cx);
                shell
            },
        )
        .expect("open the test window")
    });
    (handle, shell)
}

fn mode(shell: &Entity<Shell>, cx: &mut TestAppContext) -> ModeId {
    cx.update(|cx| shell.read(cx).state().read(cx).mode())
}

#[gpui_kit::test]
fn starts_in_view_and_switches_with_the_keys(cx: &mut TestAppContext) {
    let (handle, shell) = open_shell(cx);
    assert_eq!(mode(&shell, cx), ModeId::View);

    for (key, expected) in [
        ("cmd-2", ModeId::Tidy),
        ("cmd-3", ModeId::Sync),
        ("cmd-1", ModeId::View),
    ] {
        cx.update_window(handle, |_, window, cx| {
            window.render_frame(cx);
            window.press(key, cx);
        })
        .unwrap();
        assert_eq!(mode(&shell, cx), expected, "after {key}");
    }
}

#[gpui_kit::test]
fn folds_the_sidebar_to_the_rail_and_back(cx: &mut TestAppContext) {
    let (handle, shell) = open_shell(cx);
    let rail = |cx: &mut TestAppContext| cx.update(|cx| shell.read(cx).state().read(cx).rail());
    assert!(!rail(cx));

    cx.update_window(handle, |_, window, cx| {
        window.render_frame(cx);
        window.press("cmd-\\", cx);
    })
    .unwrap();
    assert!(rail(cx));

    cx.update_window(handle, |_, window, cx| window.click("toggle-sidebar", cx))
        .unwrap();
    assert!(!rail(cx));
}

#[gpui_kit::test]
fn a_hidden_mode_keeps_its_page_and_draws_nothing(cx: &mut TestAppContext) {
    let (handle, shell) = open_shell(cx);
    let page = |cx: &mut TestAppContext| cx.update(|cx| shell.read(cx).tidy().read(cx).page());

    cx.update_window(handle, |_, window, cx| {
        window.render_frame(cx);
        assert!(
            window.try_find("tidy-Library").is_none(),
            "Tidy is drawn while hidden"
        );
        window.press("cmd-2", cx);
        window.click("tidy-Library", cx);
    })
    .unwrap();
    assert_eq!(page(cx), TidyPage::Library);

    cx.update_window(handle, |_, window, cx| {
        window.press("cmd-1", cx);
        assert!(window.try_find("tidy-Library").is_none());
        window.press("cmd-2", cx);
    })
    .unwrap();
    assert_eq!(mode(&shell, cx), ModeId::Tidy);
    assert_eq!(page(cx), TidyPage::Library);
}
