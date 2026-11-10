//! View's keys: the actions the viewer, the comic reader and the folder list share, their key
//! table, and the shortcut sheet made of every part's table.

use oriel_ui::shortcuts::{KeyTable, Sheet};

use crate::folder_overlay::FOLDER_KEYS;
use crate::gallery::GALLERY_KEYS;
use crate::player::VIDEO_KEYS;

gpui_kit::actions!(
    view_overlay,
    [
        /// The next item or page (→ or `e`).
        Next,
        /// The previous item or page (← or `q`).
        Previous,
        /// Back to the gallery (Escape).
        Close
    ]
);

/// The viewer's and the comic reader's keys.
pub(crate) const OVERLAY_KEYS: KeyTable = oriel_ui::key_table!("Viewer and comic reader" {
    "Previous or next" => ["left" => Previous, "right" => Next, "q" => Previous, "e" => Next],
    "Close" => ["escape" => Close],
});

pub(crate) const SHEET: Sheet = Sheet {
    everywhere: &[],
    columns: &[
        &[GALLERY_KEYS.group],
        &[OVERLAY_KEYS.group, VIDEO_KEYS.group, FOLDER_KEYS.group],
    ],
    note: None,
};
