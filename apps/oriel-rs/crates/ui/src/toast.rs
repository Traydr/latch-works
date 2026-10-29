//! Toasts: the result of what the owner just did, one at a time, at the bottom of the window, as
//! Electron Oriel's `ToastViewport` shows them. A new toast replaces the one showing. They go
//! through GPUI Kit's notifications, which the window's root draws.
//!
//! ```ignore
//! window.show_toast(Toast::done("Moved 3 files to holding").action("Undo", undo), cx);
//! ```

use std::rc::Rc;

use gpui_kit::component::notification::{Notification, NotificationType};
use gpui_kit::component::{Sizable as _, WindowExt as _, button::Button};
use gpui_kit::{Anchor, App, SharedString, Window};

/// What a toast reports: done (a check), an error, or a note.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum ToastTone {
    #[default]
    Done,
    Error,
    Info,
}

type ToastHandler = Rc<dyn Fn(&mut Window, &mut App)>;

/// One toast: a line, an optional second line, and an optional action such as Undo.
#[derive(Clone)]
pub struct Toast {
    message: SharedString,
    detail: Option<SharedString>,
    tone: ToastTone,
    action: Option<(SharedString, ToastHandler)>,
}

impl Toast {
    pub fn new(tone: ToastTone, message: impl Into<SharedString>) -> Self {
        Self {
            message: message.into(),
            detail: None,
            tone,
            action: None,
        }
    }

    /// Something finished, such as "Moved 3 files to holding".
    pub fn done(message: impl Into<SharedString>) -> Self {
        Self::new(ToastTone::Done, message)
    }

    /// Something failed, such as "Undo failed"; put the reason in [`Self::detail`]. An error stays
    /// until it is dismissed, so its reason can be read.
    pub fn error(message: impl Into<SharedString>) -> Self {
        Self::new(ToastTone::Error, message)
    }

    /// A note, such as "Nothing to undo".
    pub fn info(message: impl Into<SharedString>) -> Self {
        Self::new(ToastTone::Info, message)
    }

    /// A second, smaller line.
    pub fn detail(mut self, detail: impl Into<SharedString>) -> Self {
        self.detail = Some(detail.into());
        self
    }

    /// A button on the toast, such as Undo; pressing it runs `run` and dismisses the toast.
    pub fn action(
        mut self,
        label: impl Into<SharedString>,
        run: impl Fn(&mut Window, &mut App) + 'static,
    ) -> Self {
        self.action = Some((label.into(), Rc::new(run)));
        self
    }

    pub fn message(&self) -> &SharedString {
        &self.message
    }

    pub fn tone(&self) -> ToastTone {
        self.tone
    }

    fn into_notification(self) -> Notification {
        let notification = Notification::new()
            .id::<OrielToast>()
            .with_type(match self.tone {
                ToastTone::Done => NotificationType::Success,
                ToastTone::Error => NotificationType::Error,
                ToastTone::Info => NotificationType::Info,
            })
            .placement(Anchor::BottomCenter)
            .title(self.message);
        let notification = match self.detail {
            Some(detail) => notification.message(detail),
            None => notification,
        };
        let notification = match self.action {
            Some((label, run)) => notification.action(move |_, _, _| {
                let run = run.clone();
                Button::new("toast-action")
                    .small()
                    .outline()
                    .label(label.clone())
                    .on_click(move |_, window, cx| {
                        run(window, cx);
                        window.remove_notification::<OrielToast>(cx);
                    })
            }),
            None => notification,
        };
        // An action keeps GPUI Kit's notification up; a toast with Undo still goes by itself.
        notification.autohide(self.tone != ToastTone::Error)
    }
}

/// The one id every toast shares, so a new one replaces the last.
struct OrielToast;

/// Shows toasts on a window.
pub trait ToastExt {
    fn show_toast(&mut self, toast: Toast, cx: &mut App);
    fn dismiss_toast(&mut self, cx: &mut App);
}

impl ToastExt for Window {
    fn show_toast(&mut self, toast: Toast, cx: &mut App) {
        self.push_notification(toast.into_notification(), cx);
    }

    fn dismiss_toast(&mut self, cx: &mut App) {
        self.remove_notification::<OrielToast>(cx);
    }
}
