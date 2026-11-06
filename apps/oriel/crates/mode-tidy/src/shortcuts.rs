//! Tidy's shortcut sheet (`components/ShortcutSheet.tsx`): every key Tidy answers to, in three
//! columns.

use gpui_kit::{App, Window};
use oriel_ui::shortcuts::{SHEET_KEY, SHELL_KEYS, ShortcutGroup, open_sheet};

use crate::quick_look::QUICK_LOOK_LABEL;

const EVERYWHERE: ShortcutGroup = (
    "Everywhere",
    &[
        ("Overview", "⌥⌘1", None),
        ("Duplicates", "⌥⌘2", None),
        ("Convert", "⌥⌘3", None),
        ("Clean up", "⌥⌘4", None),
        ("Library", "⌥⌘5", None),
        ("History", "⌥⌘6", None),
        ("Holding", "⌥⌘7", None),
        SHELL_KEYS[1],
        ("Add folder", "⌘O", None),
        ("Rescan", "⌘R", None),
        ("Find", "⌘F", None),
        ("Undo", "⌘Z", None),
        ("Run the page's main action", "⌘↩", None),
        SHELL_KEYS[2],
        SHEET_KEY,
        SHELL_KEYS[0],
    ],
);

const OVERVIEW: ShortcutGroup = (
    "Overview",
    &[
        ("Move between rows", "↑ ↓", None),
        ("Open a row", "↩", None),
    ],
);

const DUPLICATES: ShortcutGroup = (
    "Duplicates",
    &[
        ("Keep the suggestion", "↩", None),
        ("Keep only this one", "1–9", Some("(or click it)")),
        ("Keep this one as well", "⇧1–9", None),
        ("Keep all", "N", None),
        ("Skip", "S", None),
        ("Previous", "K", None),
        ("Move between versions", "← →", None),
        ("Next line of versions", "PgDn", None),
        ("Look closer", "Space", None),
        ("Pause or play a video", "Click", None),
        ("Flip versions", "← →", None),
        ("Keep the one shown", "↩", None),
        ("Actual size", "Z", None),
        (QUICK_LOOK_LABEL, "⌘Y", None),
        ("Show in Finder", "⇧⌘R", None),
        ("Sound on or off", "M", None),
        ("Prefer this folder", "P", None),
    ],
);

const LIBRARY: ShortcutGroup = (
    "Library",
    &[
        ("Search", "/", None),
        ("Move", "↑ ↓", None),
        ("Extend", "⇧↑ ⇧↓", None),
        (QUICK_LOOK_LABEL, "Space", None),
        ("Rename", "↩", None),
        ("Select all", "⌘A", None),
        ("Move to holding", "⌘⌫", None),
        ("Move to…", "⇧⌘M", None),
        ("Show in Finder", "⇧⌘R", None),
        ("Inspector", "I", None),
        ("Clear selection", "Esc", None),
    ],
);

const HOLDING: ShortcutGroup = (
    "Holding",
    &[
        ("Restore", "⌘⌫", None),
        ("Empty to Trash", "⇧⌘⌫", None),
        ("Select all", "⌘A", None),
    ],
);

const HISTORY: ShortcutGroup = (
    "History",
    &[
        ("Move", "↑ ↓", None),
        ("Expand and collapse", "→ ←", None),
        ("Undo", "U", None),
    ],
);

const COLUMNS: &[&[ShortcutGroup]] = &[
    &[EVERYWHERE, OVERVIEW],
    &[DUPLICATES],
    &[LIBRARY, HOLDING, HISTORY],
];

/// Opens the sheet over the window.
pub fn open(window: &mut Window, cx: &mut App) {
    open_sheet(COLUMNS, None, window, cx);
}
