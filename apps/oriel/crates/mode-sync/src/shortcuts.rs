//! Sync's shortcut sheet. Sync is worked with its buttons, so it has few keys, and says so.

use oriel_ui::shortcuts::{Sheet, ShortcutGroup};

const SYNC: ShortcutGroup = ("Sync", &[("Filter the plan", "/", None)]);

pub(crate) const SHEET: Sheet = Sheet {
    everywhere: &[],
    columns: &[&[SYNC]],
    note: Some("Sync is worked with its buttons, so it has only these keys."),
};
