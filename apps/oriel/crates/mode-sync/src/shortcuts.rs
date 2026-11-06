//! Sync's shortcut sheet. Sync is worked with its buttons, so it has few keys, and says so.

use gpui_kit::{App, Window};
use oriel_ui::shortcuts::{SHEET_KEY, SHELL_KEYS, ShortcutGroup, open_sheet};

const EVERYWHERE: ShortcutGroup = (
    "Everywhere",
    &[SHELL_KEYS[0], SHELL_KEYS[1], SHELL_KEYS[2], SHEET_KEY],
);

const SYNC: ShortcutGroup = (
    "Sync",
    &[
        ("Filter the plan", "/", None),
        ("Show or hide the run log", "⌘L", None),
    ],
);

const COLUMNS: &[&[ShortcutGroup]] = &[&[EVERYWHERE, SYNC]];

/// Opens the sheet over the window.
pub fn open(window: &mut Window, cx: &mut App) {
    open_sheet(
        COLUMNS,
        Some("Sync is worked with its buttons, so it has only these keys."),
        window,
        cx,
    );
}
