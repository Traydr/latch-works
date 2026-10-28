//! The app's actions and their keys. Keys reach an action through the focused element's key
//! context, so a hidden mode, which is not drawn, cannot receive them.

use gpui_kit::{App, KeyBinding, actions};

actions!(
    oriel,
    [
        /// Show View (⌘1).
        ShowView,
        /// Show Tidy (⌘2).
        ShowTidy,
        /// Show Sync (⌘3).
        ShowSync,
        /// The sidebar full or as the rail (⌘\).
        ToggleRail,
        About,
        Hide,
        HideOthers,
        ShowAll,
        Minimize,
        Zoom,
        CloseWindow,
        Quit
    ]
);

pub fn init(cx: &mut App) {
    cx.bind_keys([
        KeyBinding::new("cmd-1", ShowView, None),
        KeyBinding::new("cmd-2", ShowTidy, None),
        KeyBinding::new("cmd-3", ShowSync, None),
        KeyBinding::new("cmd-\\", ToggleRail, None),
        KeyBinding::new("cmd-h", Hide, None),
        KeyBinding::new("alt-cmd-h", HideOthers, None),
        KeyBinding::new("cmd-m", Minimize, None),
        KeyBinding::new("cmd-w", CloseWindow, None),
        KeyBinding::new("cmd-q", Quit, None),
    ]);

    cx.on_action(|_: &Quit, cx| cx.quit());
    cx.on_action(|_: &Hide, cx| cx.hide());
    cx.on_action(|_: &HideOthers, cx| cx.hide_other_apps());
    cx.on_action(|_: &ShowAll, cx| cx.unhide_other_apps());
    // One window: closing it quits, as Electron Oriel does while nothing runs (plan 059).
    cx.on_window_closed(|cx, _| {
        if cx.windows().is_empty() {
            cx.quit();
        }
    })
    .detach();
}
