//! The house's centred dialogs: sized for what they hold and for the window, and vertically
//! centred, so none floats small in a large window.

use gpui_kit::assets::IconName;
use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::dialog::{AlertDialog, Dialog, DialogAction, DialogClose, DialogFooter};
use gpui_kit::component::{ActiveTheme as _, Icon, WindowExt as _};
use gpui_kit::{
    AnyElement, App, Div, FontWeight, IntoElement as _, ParentElement as _, Pixels, SharedString,
    Styled as _, Window, div, px,
};

use crate::controls::{ControlSize as _, TextRole as _};

/// A confirmation's width.
pub const ALERT_WIDTH: Pixels = px(600.);

/// The width of a dialog that holds a few paragraphs, such as About.
pub const TEXT_WIDTH: Pixels = px(680.);

/// The width of a dialog with a task in it, such as the folder picker: this share of the window,
/// between these two.
pub fn task_width(window: &Window) -> Pixels {
    (window.viewport_size().width * 0.8).clamp(px(720.), px(1180.))
}

/// The height of a dialog's body with a task in it: what the window leaves after the dialog's
/// title, its footer and the space around it, between these two.
pub fn task_body_height(window: &Window) -> Pixels {
    (window.viewport_size().height - px(240.)).clamp(px(320.), px(820.))
}

/// A dialog's title in the house scale.
pub fn dialog_title(title: impl Into<SharedString>) -> Div {
    div()
        .text_heading()
        .font_weight(FontWeight::SEMIBOLD)
        .child(title.into())
}

/// A dialog in the house style: centred, on the lifted surface, so it stands off the page behind
/// it in the dark theme, with its title and a close button in the row target. GPUI Kit's own close
/// is a 24 px target, under the house's floor.
pub fn titled(dialog: Dialog, title: impl Into<SharedString>, cx: &App) -> Dialog {
    dialog
        .centered()
        .bg(cx.theme().popover)
        .close_button(false)
        .title(
            div()
                .flex()
                .flex_row()
                .items_center()
                .justify_between()
                .gap_3()
                .w_full()
                .child(dialog_title(title).flex_1().min_w_0())
                .child(
                    Button::new("dialog-close")
                        .ghost()
                        .row_size()
                        .flex_shrink_0()
                        .icon(Icon::new(IconName::Close))
                        .accessibility_label("Close")
                        .on_click(|_, window, cx| window.close_dialog(cx)),
                ),
        )
}

/// The confirmation every alert asks: its object in the title and what follows in the words,
/// with Cancel and the action named, at the house scale's size.
pub fn confirmation(
    alert: AlertDialog,
    title: impl Into<SharedString>,
    description: impl Into<SharedString>,
    action: impl Into<SharedString>,
    danger: bool,
    cx: &App,
) -> AlertDialog {
    let action: SharedString = action.into();
    let confirm = Button::new("ok").bar_size().w_full().label(action);
    let confirm = if danger {
        confirm.danger()
    } else {
        confirm.primary()
    };
    let footer: AnyElement = DialogFooter::new()
        // Each holds a button's width: the footer's commands stay at its end.
        .child(
            div()
                .min_w(px(120.))
                .child(DialogClose::new().trigger(|button: Button| {
                    button
                        .outline()
                        .quiet_edge(cx)
                        .bar_size()
                        .w_full()
                        .label("Cancel")
                })),
        )
        .child(
            div()
                .min_w(px(120.))
                .child(DialogAction::new().child(confirm)),
        )
        .into_any_element();
    alert
        .width(ALERT_WIDTH)
        .centered()
        .bg(cx.theme().popover)
        .confirm()
        .title(dialog_title(title))
        .description(div().text_body().child(description.into()))
        .footer(footer)
}
