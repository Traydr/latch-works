//! The keyboard shortcut sheet each mode opens with `?` or Help › Keyboard Shortcuts: the keys it
//! answers to, in columns. The shell opens the sheet of the mode on screen.

use std::rc::Rc;

pub use gpui_kit::Action;
use gpui_kit::component::{ActiveTheme as _, WindowExt as _};
use gpui_kit::{
    App, FontWeight, IntoElement, KeyBinding, KeyBindingContextPredicate, Keystroke,
    ParentElement as _, Pixels, SharedString, Styled as _, Window, actions, div,
    prelude::FluentBuilder as _, px,
};

use crate::controls::TextRole as _;

actions!(
    shortcuts,
    [
        /// Help › Keyboard Shortcuts, and `?` outside a text field: the sheet of the mode on
        /// screen, which the shell opens.
        ShowShortcuts
    ]
);

/// A line of a mode's own: what it does, its keys as GPUI keystrokes split on spaces (each drawn
/// as a cap through [`crate::keys::display`]; anything else, such as `1–9` or `click`, as it is
/// written), and an optional mouse alternative.
pub type Shortcut = (&'static str, &'static str, Option<&'static str>);

/// A titled list of shortcuts.
pub type ShortcutGroup = (&'static str, &'static [Shortcut]);

/// A mode's sheet: the lines it adds to the first group, which the shell fills with the keys every
/// mode shares and the mode's commands', then its own groups in columns.
pub struct Sheet {
    pub everywhere: &'static [Shortcut],
    pub columns: &'static [&'static [ShortcutGroup]],
    /// A line above the columns.
    pub note: Option<&'static str>,
}

/// A key of a [`KeyTable`] and what makes the action it sends.
pub type Key = (&'static str, fn() -> Box<dyn Action>);

/// One part's keys, written once: the bindings it answers to and its group on the sheet, made with
/// [`key_table!`](crate::key_table).
pub struct KeyTable {
    pub group: ShortcutGroup,
    /// Every key, those the sheet leaves out included.
    pub keys: &'static [Key],
}

impl KeyTable {
    /// The table's bindings in `context`, but for the number row's digits: a keystroke names what
    /// a key typed, which is not a digit on every layout, so [`Self::digit_action`] reads those.
    pub fn bindings(&self, context: &str, cx: &App) -> Vec<KeyBinding> {
        let context = KeyBindingContextPredicate::parse(context).ok().map(Rc::new);
        self.keys
            .iter()
            .filter(|(keys, _)| digit(keys).is_none())
            .filter_map(|(keys, action)| {
                KeyBinding::load(keys, action(), context.clone(), false, None, cx)
                    .map_err(|error| log::error!("cannot bind {keys}: {error}"))
                    .ok()
            })
            .collect()
    }

    /// The action of the table's digit that `keystroke` pressed on the number row, without ⇧ or
    /// another modifier ([`crate::keys::digit_key`]); for a part's key-down handler to dispatch.
    pub fn digit_action(&self, keystroke: &Keystroke) -> Option<Box<dyn Action>> {
        let modifiers = &keystroke.modifiers;
        if modifiers.platform || modifiers.control || modifiers.alt || modifiers.function {
            return None;
        }
        let pressed = crate::keys::digit_key(keystroke).filter(|key| !key.shift)?;
        self.keys
            .iter()
            .find(|(keys, _)| digit(keys) == Some(pressed.digit))
            .map(|(_, action)| action())
    }
}

/// The digit a table's key is, if it is one of 1 to 9 alone.
fn digit(keys: &str) -> Option<usize> {
    keys.parse().ok().filter(|digit| (1..=9).contains(digit))
}

/// A [`KeyTable`]: a sheet group's title, then a line per label with its keys and the action each
/// sends, in the order the sheet shows them, and after `+` the keys the sheet leaves out.
///
/// ```ignore
/// const KEYS: KeyTable = oriel_ui::key_table!("Gallery" {
///     "Previous or next item" => ["left" => SelectLeft, "right" => SelectRight]
///         + ["shift-left" => SelectLeft, "shift-right" => SelectRight],
///     "Open the selected item" => ["enter" => ActivateSelected],
/// });
/// ```
#[macro_export]
macro_rules! key_table {
    ($title:literal {
        $($label:literal => [$($key:literal => $action:expr),+ $(,)?]
            $(+ [$($hidden:literal => $hidden_action:expr),+ $(,)?])?),+ $(,)?
    }) => {
        $crate::shortcuts::KeyTable {
            group: ($title, &[$(($label, concat!($($key, " "),+), None)),+]),
            keys: &[$(
                $(($key, || -> Box<dyn $crate::shortcuts::Action> { Box::new($action) }),)+
                $($(($hidden, || -> Box<dyn $crate::shortcuts::Action> {
                    Box::new($hidden_action)
                }),)+)?
            )+],
        }
    };
}

/// A line as the sheet draws it.
#[derive(Clone, Debug, PartialEq)]
pub struct Line {
    pub label: SharedString,
    pub keys: Vec<SharedString>,
}

impl Line {
    /// `label` with `keys`, keystrokes split on spaces.
    pub fn new(label: impl Into<SharedString>, keys: &str) -> Self {
        Self {
            label: label.into(),
            keys: keys
                .split(' ')
                .filter(|keys| !keys.is_empty())
                .map(|keys| crate::keys::display(keys).into())
                .collect(),
        }
    }

    pub fn from_shortcut((label, keys, note): &Shortcut) -> Self {
        let label: SharedString = match note {
            Some(note) => format!("{label} {note}").into(),
            None => (*label).into(),
        };
        Self::new(label, keys)
    }
}

/// How wide a column of the sheet is, and the gap between columns.
const COLUMN_WIDTH: f32 = 372.;
const COLUMN_GAP: f32 = 32.;
/// What the dialog's insets take around the columns.
const DIALOG_INSET: f32 = 48.;

fn group(title: SharedString, rows: Vec<Line>, cx: &App) -> impl IntoElement + use<> {
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
        .children(rows.into_iter().map(move |line| {
            div()
                .flex()
                .flex_row()
                .items_center()
                .justify_between()
                .gap_4()
                .h(px(22.))
                .text_body()
                .child(div().min_w_0().truncate().child(line.label))
                .child(div().flex().flex_row().flex_shrink_0().gap_1().children(
                    line.keys.into_iter().map(move |key| {
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

/// Opens a mode's sheet over the window, `first` heading its first column as "Everywhere";
/// Escape closes it.
pub fn open_sheet(first: Vec<Line>, sheet: &Sheet, window: &mut Window, cx: &mut App) {
    if window.has_active_dialog(cx) {
        return;
    }
    let mut columns: Vec<Vec<(SharedString, Vec<Line>)>> = sheet
        .columns
        .iter()
        .map(|column| {
            column
                .iter()
                .map(|(title, rows)| {
                    let rows = rows.iter().map(Line::from_shortcut).collect();
                    (SharedString::from(*title), rows)
                })
                .collect()
        })
        .collect();
    match columns.first_mut() {
        Some(column) => column.insert(0, ("Everywhere".into(), first)),
        None => columns.push(vec![("Everywhere".into(), first)]),
    }
    let note = sheet.note;
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
                        div().flex().flex_col().flex_1().min_w_0().children(
                            column
                                .iter()
                                .map(|(title, rows)| group(title.clone(), rows.clone(), cx)),
                        )
                    })),
            )
    });
}
