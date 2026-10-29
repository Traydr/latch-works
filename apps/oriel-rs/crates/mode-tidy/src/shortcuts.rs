//! The shortcut sheet (`components/ShortcutSheet.tsx`, `?` or Help › Keyboard Shortcuts): every
//! key Tidy answers to, in three columns.

use gpui_kit::component::{ActiveTheme as _, WindowExt as _};
use gpui_kit::{App, FontWeight, IntoElement, ParentElement as _, Styled as _, Window, div, px};

/// An action, its keys (split on spaces into caps), and an optional mouse alternative.
type Shortcut = (&'static str, &'static str, Option<&'static str>);

const EVERYWHERE: (&str, &[Shortcut]) = (
    "Everywhere",
    &[
        ("Overview", "⌥⌘1", None),
        ("Duplicates", "⌥⌘2", None),
        ("Convert", "⌥⌘3", None),
        ("Clean up", "⌥⌘4", None),
        ("Library", "⌥⌘5", None),
        ("History", "⌥⌘6", None),
        ("Holding", "⌥⌘7", None),
        ("Settings", "⌘,", None),
        ("Add folder", "⌘O", None),
        ("Rescan", "⌘R", None),
        ("Find", "⌘F", None),
        ("Undo", "⌘Z", None),
        ("Run the page's main action", "⌘↩", None),
        ("Collapse the sidebar", "⌘\\", None),
        ("Shortcuts", "?", None),
        ("View, Tidy, Sync", "⌘1 ⌘2 ⌘3", None),
    ],
);

const OVERVIEW: (&str, &[Shortcut]) = ("Overview", &[("Review similar versions", "D", None)]);

const DUPLICATES: (&str, &[Shortcut]) = (
    "Duplicates",
    &[
        ("Keep the suggestion and go on", "↩", None),
        ("Keep only this one", "1–9", Some("(or click)")),
        (
            "Keep this one as well",
            "⇧1–9",
            Some("(or ⇧-click, or its checkbox)"),
        ),
        ("Keep both (not duplicates)", "N", None),
        ("Skip", "S", None),
        ("Next, previous", "J K", None),
        ("Move between versions", "← →", None),
        ("Look closer", "Space", None),
        ("Keep the one shown", "↩", None),
        ("Actual size", "Z", None),
        ("Show in Finder", "⇧⌘R", None),
        ("Sound on or off", "M", None),
        ("Prefer this folder", "P", None),
    ],
);

const LIBRARY: (&str, &[Shortcut]) = (
    "Library",
    &[
        ("Search", "/", None),
        ("Move", "↑ ↓", None),
        ("Rename", "↩", None),
        ("Select all", "⌘A", None),
        ("Move to holding", "⌘⌫", None),
        ("Move to…", "⇧⌘M", None),
        ("Show in Finder", "⇧⌘R", None),
        ("Inspector", "I", None),
        ("Clear selection", "Esc", None),
    ],
);

const HOLDING: (&str, &[Shortcut]) = (
    "Holding",
    &[
        ("Restore", "⌘⌫", None),
        ("Empty to Trash", "⇧⌘⌫", None),
        ("Select all", "⌘A", None),
    ],
);

const HISTORY: (&str, &[Shortcut]) = (
    "History",
    &[
        ("Move", "↑ ↓", None),
        ("Expand and collapse", "→ ←", None),
        ("Undo", "U", None),
    ],
);

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
                .text_xs()
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
                .h(px(24.))
                .text_size(px(13.))
                .child(div().min_w_0().truncate().child(match note {
                    Some(note) => format!("{action} {note}"),
                    None => action.to_string(),
                }))
                .child(
                    div()
                        .flex()
                        .flex_row()
                        .gap_1()
                        .children(keys.split(' ').map(move |key| {
                            div()
                                .px(px(5.))
                                .rounded(radius)
                                .border_1()
                                .border_color(border)
                                .text_xs()
                                .child(key)
                        })),
                )
        }))
}

/// Opens the sheet over the window; Escape closes it.
pub fn open(window: &mut Window, cx: &mut App) {
    if window.has_active_dialog(cx) {
        return;
    }
    window.open_dialog(cx, |dialog, _, cx| {
        let columns = [
            vec![EVERYWHERE, OVERVIEW],
            vec![DUPLICATES],
            vec![LIBRARY, HOLDING, HISTORY],
        ];
        dialog.title("Keyboard shortcuts").w(px(1120.)).child(
            div()
                .flex()
                .flex_row()
                .gap_8()
                .children(columns.into_iter().map(|column| {
                    div().flex().flex_col().flex_1().min_w_0().children(
                        column
                            .into_iter()
                            .map(|(title, rows)| group(title, rows, cx)),
                    )
                })),
        )
    });
}
