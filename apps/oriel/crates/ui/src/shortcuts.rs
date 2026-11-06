//! The keyboard shortcut sheet each mode opens with `?` or Help › Keyboard Shortcuts: the keys it
//! answers to, in columns. The shell opens the sheet of the mode on screen.

use gpui_kit::component::{ActiveTheme as _, WindowExt as _};
use gpui_kit::{
    App, FontWeight, IntoElement, ParentElement as _, Pixels, Styled as _, Window, div,
    prelude::FluentBuilder as _, px,
};

use crate::controls::TextRole as _;

/// An action, its keys (split on spaces into caps), and an optional mouse alternative.
pub type Shortcut = (&'static str, &'static str, Option<&'static str>);

/// A titled list of shortcuts.
pub type ShortcutGroup = (&'static str, &'static [Shortcut]);

/// How wide a column of the sheet is, and the gap between columns.
const COLUMN_WIDTH: f32 = 372.;
const COLUMN_GAP: f32 = 32.;
/// What the dialog's insets take around the columns.
const DIALOG_INSET: f32 = 48.;

/// The keys every mode shares, for the top of its sheet.
pub const SHELL_KEYS: [Shortcut; 3] = [
    ("View, Tidy, Sync", "⌘1 ⌘2 ⌘3", None),
    ("Settings", "⌘,", None),
    ("Collapse the sidebar", "⌘\\", None),
];

/// Asks for the sheet.
pub const SHEET_KEY: Shortcut = ("Shortcuts", "?", None);

fn group(title: &'static str, rows: &'static [Shortcut], cx: &App) -> impl IntoElement + use<> {
    let theme = cx.theme();
    let (muted, border, radius) = (theme.muted_foreground, theme.border, theme.radius);
    div()
        .flex()
        .flex_col()
        .pb_3()
        .child(
            div()
                .mb_0p5()
                .text_caption()
                .font_weight(FontWeight::MEDIUM)
                .text_color(muted)
                .child(title),
        )
        .children(rows.iter().map(move |(action, keys, note)| {
            div()
                .flex()
                .flex_row()
                .items_center()
                .justify_between()
                .gap_4()
                .h(px(22.))
                .text_body()
                .child(div().min_w_0().truncate().child(match note {
                    Some(note) => format!("{action} {note}"),
                    None => action.to_string(),
                }))
                .child(div().flex().flex_row().flex_shrink_0().gap_1().children(
                    keys.split(' ').map(move |key| {
                        div()
                            .px(px(5.))
                            .rounded(radius)
                            .border_1()
                            .border_color(border)
                            .text_caption()
                            .child(key)
                    }),
                ))
        }))
}

/// The dialog's width: its columns', or the window's when that is less.
fn sheet_width(columns: usize, window: Pixels) -> Pixels {
    let columns = columns as f32;
    let wanted = columns * COLUMN_WIDTH + (columns - 1.) * COLUMN_GAP + DIALOG_INSET;
    window.min(px(wanted + DIALOG_INSET)) - px(DIALOG_INSET)
}

/// Opens a mode's sheet over the window, with `note` above its columns; Escape closes it.
pub fn open_sheet(
    columns: &'static [&'static [ShortcutGroup]],
    note: Option<&'static str>,
    window: &mut Window,
    cx: &mut App,
) {
    if window.has_active_dialog(cx) {
        return;
    }
    window.open_dialog(cx, move |dialog, window, cx| {
        let muted = cx.theme().muted_foreground;
        crate::dialogs::titled(dialog, "Keyboard shortcuts", cx)
            .w(sheet_width(columns.len(), window.viewport_size().width))
            .when_some(note, |this, note| {
                this.child(div().pb_3().text_body().text_color(muted).child(note))
            })
            .child(
                div()
                    .flex()
                    .flex_row()
                    .gap(px(COLUMN_GAP))
                    .children(columns.iter().map(|column| {
                        div()
                            .flex()
                            .flex_col()
                            .flex_1()
                            .min_w_0()
                            .children(column.iter().map(|(title, rows)| group(title, rows, cx)))
                    })),
            )
    });
}
