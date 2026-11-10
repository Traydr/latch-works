//! Tidy's shortcut sheet: every key Tidy answers to, in three columns, under its commands'.

use oriel_ui::keys::REVEAL_LABEL;
use oriel_ui::shortcuts::{Sheet, ShortcutGroup};

use crate::quick_look::QUICK_LOOK_LABEL;

const OVERVIEW: ShortcutGroup = (
    "Overview",
    &[
        ("Move between rows", "up down", None),
        ("Open a row", "enter", None),
    ],
);

const DUPLICATES: ShortcutGroup = (
    "Duplicates",
    &[
        ("Keep the suggestion", "enter", None),
        ("Keep only this one", "1–9", Some("(or click it)")),
        ("Keep this one as well", "shift-1–9", None),
        ("Keep all", "n", None),
        ("Skip", "s", None),
        ("Previous", "k", None),
        ("Move between versions", "left right", None),
        ("Next line of versions", "pagedown", None),
        ("Look closer", "space", None),
        ("Pause or play a video", "click", None),
        ("Flip versions", "left right", None),
        ("Keep the one shown", "enter", None),
        ("Actual size", "z", None),
        (QUICK_LOOK_LABEL, "cmd-y", None),
        (REVEAL_LABEL, "cmd-shift-r", None),
        ("Sound on or off", "m", None),
        ("Prefer this folder", "p", None),
    ],
);

const LIBRARY: ShortcutGroup = (
    "Library",
    &[
        ("Search", "/", None),
        ("Move", "up down", None),
        ("Extend", "shift-up shift-down", None),
        (QUICK_LOOK_LABEL, "space", None),
        ("Rename", "enter", None),
        ("Select all", "cmd-a", None),
        ("Move to holding", "cmd-backspace", None),
        ("Move to…", "cmd-shift-m", None),
        (REVEAL_LABEL, "cmd-shift-r", None),
        ("Inspector", "i", None),
        ("Clear selection", "escape", None),
    ],
);

const HOLDING: ShortcutGroup = (
    "Holding",
    &[
        ("Restore", "cmd-backspace", None),
        ("Empty to Trash", "cmd-shift-backspace", None),
        ("Select all", "cmd-a", None),
    ],
);

const HISTORY: ShortcutGroup = (
    "History",
    &[
        ("Move", "up down", None),
        ("Expand and collapse", "right left", None),
        ("Undo", "u", None),
    ],
);

pub(crate) const SHEET: Sheet = Sheet {
    everywhere: &[(
        "Run the page's main action",
        crate::widgets::MAIN_ACTION_KEYS,
        None,
    )],
    columns: &[&[OVERVIEW], &[DUPLICATES], &[LIBRARY, HOLDING, HISTORY]],
    note: None,
};
