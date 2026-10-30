//! The app's actions and their keys. Keys reach an action through the focused element's key
//! context, so a hidden mode, which is not drawn, cannot receive them.

use gpui_kit::{App, KeyBinding, actions};

use crate::quit::QuitGuard;

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
        /// The one Settings page, at the section of the mode on screen (⌘,).
        OpenSettings,
        /// Back from Settings to the mode (Escape).
        CloseSettings,
        /// The window full screen and back (⌃⌘F).
        ToggleFullScreen,
        About,
        Hide,
        HideOthers,
        ShowAll,
        Minimize,
        Zoom,
        /// Window › Bring All to Front.
        BringAllToFront,
        /// Closes the window, which quits, unless work runs that quitting waits for (⌘W).
        CloseWindow,
        /// Quits, unless work runs that quitting waits for (⌘Q).
        Quit
    ]
);

/// The key context of the Settings page, where Escape goes back.
pub const SETTINGS_CONTEXT: &str = "Settings";

/// Binds the shell's keys and the modes' menu keys, and the app-wide actions. Call before the
/// menus are set: they read their shortcuts from the keymap.
pub fn init(cx: &mut App) {
    cx.bind_keys([
        KeyBinding::new("cmd-1", ShowView, None),
        KeyBinding::new("cmd-2", ShowTidy, None),
        KeyBinding::new("cmd-3", ShowSync, None),
        KeyBinding::new("cmd-\\", ToggleRail, None),
        KeyBinding::new("cmd-,", OpenSettings, None),
        KeyBinding::new("escape", CloseSettings, Some(SETTINGS_CONTEXT)),
        KeyBinding::new("ctrl-cmd-f", ToggleFullScreen, None),
        KeyBinding::new("cmd-h", Hide, None),
        KeyBinding::new("alt-cmd-h", HideOthers, None),
        KeyBinding::new("cmd-m", Minimize, None),
        KeyBinding::new("cmd-w", CloseWindow, None),
        KeyBinding::new("cmd-q", Quit, None),
    ]);
    oriel_ui::commands::bind_keys(cx);

    cx.on_action(|_: &Quit, cx| QuitGuard::request_global(cx));
    cx.on_action(|_: &Hide, cx| cx.hide());
    cx.on_action(|_: &HideOthers, cx| cx.hide_other_apps());
    cx.on_action(|_: &ShowAll, cx| cx.unhide_other_apps());
    cx.on_action(|_: &BringAllToFront, cx| bring_all_to_front(cx));
    // One window: closing it quits, as Electron Oriel does. The window asks first whether work
    // is running that the quit must wait for (`Shell::request_close`).
    cx.on_window_closed(|cx, _| {
        if cx.windows().is_empty() {
            cx.quit();
        }
    })
    .detach();
}

/// Brings the app forward with its windows in front of every other app's, as AppKit's Window ›
/// Bring All to Front does (`arrangeInFront:`).
fn bring_all_to_front(cx: &mut App) {
    cx.activate(true);
    #[cfg(target_os = "macos")]
    if let Some(mtm) = objc2::MainThreadMarker::new() {
        objc2_app_kit::NSApplication::sharedApplication(mtm).arrangeInFront(None);
    }
}
