//! View's shortcut sheet: the keys of the gallery, the viewer, the comic reader and the player.

use gpui_kit::{App, Window};
use oriel_ui::shortcuts::{SHEET_KEY, SHELL_KEYS, ShortcutGroup, open_sheet};

const EVERYWHERE: ShortcutGroup = (
    "Everywhere",
    &[
        SHELL_KEYS[0],
        SHELL_KEYS[1],
        ("Open a folder", "⌘O", None),
        ("Refresh", "⌘R", None),
        SHELL_KEYS[2],
        SHEET_KEY,
    ],
);

const GALLERY: ShortcutGroup = (
    "Gallery",
    &[
        ("Previous or next item", "← → A D", None),
        ("Row up or down", "↑ ↓ W S", None),
        ("Open the selected item", "↩ F", None),
        ("Open the selected folder", "⇧S", None),
        ("Parent folder", "⇧W", None),
        ("Previous or next folder", "⇧A ⇧D", None),
    ],
);

const VIEWER: ShortcutGroup = (
    "Viewer and comic reader",
    &[
        ("Previous or next", "← → Q E", None),
        ("Close", "Esc", None),
    ],
);

const VIDEO: ShortcutGroup = (
    "Video",
    &[
        ("Play or pause", "Space 2", None),
        ("Back or forward 5 seconds", "1 3", None),
        ("Mute", "M", None),
        ("Play at 2× while held", "4", None),
    ],
);

const FOLDERS: ShortcutGroup = ("Folder list", &[("Close", "Esc", None)]);

const COLUMNS: &[&[ShortcutGroup]] = &[&[EVERYWHERE, GALLERY], &[VIEWER, VIDEO, FOLDERS]];

/// Opens the sheet over the window.
pub fn open(window: &mut Window, cx: &mut App) {
    open_sheet(COLUMNS, None, window, cx);
}
