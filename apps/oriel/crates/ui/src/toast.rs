//! Toasts: the result of what the owner just did, one at a time, at the bottom right of the
//! window. A new toast replaces the one showing. They go through GPUI Kit's notifications, which
//! the window's root draws.
//!
//! A toast never covers a command. A page with room among its commands, as Duplicates' decision
//! bar has, keeps a slot there, and a toast of one line sits in it beside the button just pressed,
//! covering nothing. Anywhere else [`dock_toasts`] stands it at the window's right on what the page
//! keeps at its foot: a floating toolbar, the player, and the activity panel with them.
//!
//! ```ignore
//! window.show_toast(Toast::done("Moved 3 files to holding").action("Undo", undo), cx);
//! ```

use std::rc::Rc;
use std::time::{Duration, Instant};

use gpui_kit::assets::IconName;
use gpui_kit::component::notification::Notification;
use gpui_kit::component::tooltip::Tooltip;
use gpui_kit::component::{ActiveTheme as _, Icon, Theme, WindowExt as _, button::Button};
use gpui_kit::{
    Anchor, App, Bounds, FontWeight, Global, InteractiveElement as _, IntoElement as _,
    ParentElement as _, Pixels, SharedString, Size, StatefulInteractiveElement as _, Styled as _,
    TestSupportExt as _, Window, div, prelude::FluentBuilder as _, px,
};

use crate::arming::Arming;
use crate::controls::{ControlSize as _, TextRole as _};

/// A toast's width: room for a name on one line beside Undo.
pub const TOAST_WIDTH: Pixels = px(400.);

/// A toast's width in a narrow window, where it would otherwise fill the stage.
const NARROW_TOAST_WIDTH: Pixels = px(340.);

/// A window narrower than this takes the narrow toast.
const NARROW_WINDOW: f32 = 1120.;

/// The space between a toast and the window's right edge, and the window's foot.
pub const TOAST_MARGIN: Pixels = px(16.);

/// What a character of a toast's words takes in a slot, and what its mark, insets and action take
/// beside them when snug.
const SLOT_CHAR: f32 = 7.5;
const SLOT_WITH_ACTION: Pixels = px(106.);
const SLOT_WITHOUT_ACTION: Pixels = px(50.);

/// How far a toast keeps left of the panel's Pause and Stop, which take about this much of the
/// panel's right end, when it takes the place of the panel.
const PANEL_CONTROLS: Pixels = px(100.);

/// How soon after the panel closes a toast counts as taking its place.
const TAKES_PANELS_PLACE: Duration = Duration::from_secs(2);

/// The space between a toast and what it stands on.
const TOAST_STANDING: Pixels = px(8.);

/// A toast of one line's width away from a slot: enough for its few words and Undo.
const ONE_LINE_WIDTH: Pixels = px(320.);

/// The least room a slot among a page's commands can hold a toast of one line in: a few words and
/// Undo.
const SLOT_LEAST: Pixels = px(190.);

/// A slot narrower than this takes a smaller mark with less space around it.
const SLOT_SNUG: Pixels = px(240.);

/// A toast's width in a slot, which has no need of more, and its space from what is beside it.
const SLOT_WIDTH: Pixels = px(300.);
const SLOT_MARGIN: Pixels = px(4.);

/// The most letters of a message a snug slot holds beside the mark.
const SNUG_WITH_MARK: usize = 12;

/// How long a new toast may still move to a slot, which a page just opened takes a few frames to
/// measure.
const SLOT_SETTLES_IN: Duration = Duration::from_secs(1);

/// A toast of one line's height: Undo, and the card's padding and rule.
const ONE_LINE_HEIGHT: Pixels = px(46.);

/// The most lines a toast's second line takes.
const DETAIL_LINES: usize = 2;

/// The most lines the first line of a toast that reports a fault takes.
const MESSAGE_LINES: usize = 2;

/// The longest word a toast shows whole: a file's name can run far past a line, and GPUI cuts
/// such a word off at the toast's edge rather than wrap it.
const LONGEST_WORD: usize = 28;

/// `text` with each word past [`LONGEST_WORD`] cut in its middle, so a name keeps its start and
/// its extension.
fn shortened(text: &str) -> String {
    text.split(' ')
        .map(|word| {
            let letters: Vec<char> = word.chars().collect();
            if letters.len() <= LONGEST_WORD {
                return word.to_string();
            }
            let tail = LONGEST_WORD / 3;
            let head = LONGEST_WORD - tail - 1;
            let start: String = letters[..head].iter().collect();
            let end: String = letters[letters.len() - tail..].iter().collect();
            format!("{start}…{end}")
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// Sets toasts' margin, once at start: the theme keeps it for every window.
pub fn init(cx: &mut App) {
    let notification = &mut Theme::global_mut(cx).notification;
    notification.width = TOAST_WIDTH;
    notification.margins.right = TOAST_MARGIN;
    notification.margins.bottom = TOAST_MARGIN;
}

/// Where toasts go, as the shell last worked it out, and whether the toast on screen takes one
/// line, which can go in a slot.
#[derive(Clone, Copy, Default)]
struct ToastDock {
    standing: Pixels,
    window: Size<Pixels>,
    slot: Option<Bounds<Pixels>>,
    one_line: bool,
    /// Whether the toast on screen sits in the slot.
    in_slot: bool,
    /// When the toast on screen showed, for how long the page may still be finding its slot.
    shown_at: Option<Instant>,
    /// What a slot must hold of the toast on screen for its words to show whole.
    needs: Pixels,
    /// When the open activity panel last closed because its work ended.
    panel_closed_at: Option<Instant>,
    /// Whether the toast on screen took the place of that panel.
    clear_of_panel: bool,
}

impl Global for ToastDock {}

impl ToastDock {
    /// A toast stays where it first showed for its life, not jumping as the page's commands change
    /// their words: it leaves the slot only when that stops holding it, and comes to one only in
    /// its first moments, while a page just opened is still measuring its slot.
    fn settled(mut self) -> Self {
        let fits = self.one_line
            && self.slot.is_some_and(|slot| {
                slot.size.width >= SLOT_LEAST.max(self.needs + SLOT_MARGIN * 2.)
            });
        let settling = self
            .shown_at
            .is_some_and(|shown| shown.elapsed() < SLOT_SETTLES_IN);
        self.in_slot = fits && (self.in_slot || settling);
        self
    }

    fn apply(self, cx: &mut App) {
        let window_width = f32::from(self.window.width);
        let notification = &mut Theme::global_mut(cx).notification;
        if let Some(slot) = self.slot.filter(|_| self.in_slot) {
            // Centred in the slot's height, at the slot's right, clear of what is beside it.
            let height = slot.size.height;
            notification.width = (slot.size.width - SLOT_MARGIN * 2.).min(SLOT_WIDTH);
            notification.margins.right = self.window.width - slot.right() + SLOT_MARGIN;
            notification.margins.bottom =
                self.window.height - slot.bottom() + (height - ONE_LINE_HEIGHT) / 2.;
            return;
        }
        // Its action keeps out of the column the panel's Pause and Stop were just in, where a
        // pointer may still be resting, aimed at them.
        notification.margins.right = if self.clear_of_panel {
            TOAST_MARGIN + PANEL_CONTROLS
        } else {
            TOAST_MARGIN
        };
        notification.margins.bottom = if self.standing > px(0.) {
            self.standing + TOAST_STANDING
        } else {
            TOAST_MARGIN
        };
        notification.width = if self.one_line {
            ONE_LINE_WIDTH
        } else if window_width < NARROW_WINDOW {
            NARROW_TOAST_WIDTH
        } else {
            TOAST_WIDTH
        };
    }

    /// The width of the slot the toast sits in, if it does.
    fn slot_width(&self) -> Option<Pixels> {
        self.slot
            .filter(|_| self.in_slot)
            .map(|slot| slot.size.width)
    }

    /// Whether the toast sits in a slot that wants its parts closer together.
    fn snug(&self) -> bool {
        self.slot_width().is_some_and(|width| width < SLOT_SNUG)
    }
}

/// Stands toasts on what the page keeps at the window's foot, `standing` tall from the window's
/// bottom edge, at the width the window can spare; or, for a toast of one line, in `slot`, room a
/// page keeps free among its commands, where it covers nothing at all. The shell calls this as it
/// draws, before the root draws the toasts.
pub fn dock_toasts(
    standing: Pixels,
    window: Size<Pixels>,
    slot: Option<Bounds<Pixels>>,
    cx: &mut App,
) {
    let current = cx.try_global::<ToastDock>().copied().unwrap_or_default();
    let dock = ToastDock {
        standing,
        window,
        slot,
        ..current
    }
    .settled();
    cx.set_global(dock);
    dock.apply(cx);
}

fn note_toast(one_line: bool, needs: Pixels, cx: &mut App) {
    let mut dock = cx.try_global::<ToastDock>().copied().unwrap_or_default();
    dock.one_line = one_line;
    dock.needs = needs;
    dock.in_slot = false;
    dock.shown_at = Some(Instant::now());
    dock.clear_of_panel = dock
        .panel_closed_at
        .is_some_and(|closed| closed.elapsed() < TAKES_PANELS_PLACE);
    let dock = dock.settled();
    cx.set_global(dock);
    if dock.window.width > px(0.) {
        dock.apply(cx);
    }
}

/// The open activity panel has just closed because its work ended; a toast that follows takes its
/// place.
pub(crate) fn note_panel_closed(cx: &mut App) {
    let mut dock = cx.try_global::<ToastDock>().copied().unwrap_or_default();
    dock.panel_closed_at = Some(Instant::now());
    cx.set_global(dock);
}

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
    brief: Option<SharedString>,
    stays: bool,
}

impl Toast {
    pub fn new(tone: ToastTone, message: impl Into<SharedString>) -> Self {
        Self {
            message: message.into(),
            detail: None,
            tone,
            action: None,
            brief: None,
            stays: false,
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

    /// The few words that say it on the toast's one line, the message's own being longer than the
    /// room there; the hover text has the message whole.
    pub fn brief(mut self, brief: impl Into<SharedString>) -> Self {
        self.brief = Some(brief.into());
        self
    }

    /// Keeps the toast up until it is dismissed, as an error stays.
    pub fn stays(mut self) -> Self {
        self.stays = true;
        self
    }

    pub fn message(&self) -> &SharedString {
        &self.message
    }

    pub fn tone(&self) -> ToastTone {
        self.tone
    }

    /// How wide a slot must be for this toast's words and action, at a generous reckoning.
    fn needs_in_slot(&self) -> Pixels {
        let words = self.brief.as_ref().unwrap_or(&self.message).chars().count();
        px(words as f32 * SLOT_CHAR)
            + if self.action.is_some() {
                SLOT_WITH_ACTION
            } else {
                SLOT_WITHOUT_ACTION
            }
    }

    /// What just went well, with its Undo, or with nothing more to say, takes one line: the owner
    /// knows what they just did, so the rest can wait in the hover text. A fault keeps its reason
    /// in sight.
    fn takes_one_line(&self) -> bool {
        self.tone != ToastTone::Error && (self.action.is_some() || self.detail.is_none())
    }

    fn into_notification(self, cx: &App) -> Notification {
        let stays = self.stays || self.tone == ToastTone::Error;
        let tone = self.tone;
        // Its edge takes its tone's colour, so a toast among a page's commands reads as what just
        // happened, not as one more of them.
        let edge = match tone {
            ToastTone::Done => cx.theme().success,
            ToastTone::Error => cx.theme().danger,
            ToastTone::Info => cx.theme().info,
        }
        .opacity(0.5);
        let one_line = self.takes_one_line();
        let (full, detail, action) = (self.message, self.detail, self.action);
        let shown = match self.brief.filter(|_| one_line) {
            Some(brief) => brief,
            None => SharedString::from(shortened(&full)),
        };
        let hover = if one_line {
            match &detail {
                Some(detail) => Some(SharedString::from(format!("{full}\n{detail}"))),
                None => Some(full.clone()),
            }
        } else {
            (shown != full).then_some(full)
        };
        let detail = detail.filter(|_| !one_line);
        let long_for_snug = shown.chars().count() > SNUG_WITH_MARK;
        // It can appear under a pointer aimed at what was there before it: the end of a run closes
        // the activity panel and puts Undo where Stop was, and a late click on Stop must not undo
        // the whole run.
        let mut arming = Arming::default();
        arming.arm(cx);
        Notification::new()
            .id::<OrielToast>()
            .placement(Anchor::BottomRight)
            .when(one_line, |this| this.py_1p5().px_3().border_color(edge))
            // The body is drawn here rather than by the notification, which draws its words and
            // its action a size smaller than the house scale's, and its icon level with neither.
            // An action of its own would also keep the toast up; a toast with Undo still goes by
            // itself.
            .content(move |_, _, cx| {
                let dock = cx.try_global::<ToastDock>();
                let snug = dock.is_some_and(ToastDock::snug);
                let theme = cx.theme();
                let muted = theme.muted_foreground;
                let (icon, color) = match tone {
                    ToastTone::Done => (IconName::CircleCheck, theme.success),
                    ToastTone::Error => (IconName::CircleX, theme.danger),
                    ToastTone::Info => (IconName::Info, theme.info),
                };
                div()
                    .id("toast")
                    .test_support()
                    .flex()
                    .flex_row()
                    .items_center()
                    .when(snug, |this| this.gap_1p5())
                    .when(!snug, |this| this.gap_2p5())
                    // Clear of the hover cross GPUI Kit draws in the corner.
                    .when(snug, |this| this.pr_1())
                    .when(!snug, |this| this.pr_3())
                    .when_some(hover.clone(), |this, hover| {
                        this.tooltip(move |window, cx| {
                            Tooltip::new(hover.clone()).build(window, cx)
                        })
                    })
                    // In a snug slot the mark gives way to a message too long to sit beside it: the
                    // number is the one fact it has.
                    .when(!snug || !long_for_snug, |this| {
                        this.child(
                            Icon::new(icon)
                                .when(snug, |icon| icon.size_4())
                                .when(!snug, |icon| icon.size_5())
                                .flex_shrink_0()
                                .text_color(color),
                        )
                    })
                    .child(
                        div()
                            .flex()
                            .flex_col()
                            .flex_1()
                            .min_w_0()
                            .gap_0p5()
                            .child(
                                div()
                                    // Its number is the one fact it has, so a snug slot takes the
                                    // next size down sooner than cut it.
                                    .when(snug, |this| this.text_sm())
                                    .when(!snug, |this| this.text_body())
                                    .font_weight(FontWeight::MEDIUM)
                                    .map(|this| {
                                        if one_line {
                                            this.truncate()
                                        } else {
                                            this.line_clamp(MESSAGE_LINES).text_ellipsis()
                                        }
                                    })
                                    .child(shown.clone()),
                            )
                            .when_some(detail.clone(), |this, detail| {
                                this.child(
                                    div()
                                        .text_sm()
                                        .text_color(muted)
                                        .line_clamp(DETAIL_LINES)
                                        .text_ellipsis()
                                        .child(detail),
                                )
                            }),
                    )
                    .when_some(action.clone(), |this, (label, run)| {
                        this.child(
                            Button::new("toast-action")
                                .row_size()
                                .outline()
                                .quiet_edge(cx)
                                .flex_shrink_0()
                                .when(snug, |button| button.px_2())
                                .label(label)
                                .on_click(move |_, window, cx| {
                                    if arming.holds(cx) {
                                        return;
                                    }
                                    run(window, cx);
                                    window.remove_notification::<OrielToast>(cx);
                                }),
                        )
                    })
                    .into_any_element()
            })
            .autohide(!stays)
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
        #[cfg(feature = "test-support")]
        cx.set_global(LastToast(toast.message().clone()));
        note_toast(toast.takes_one_line(), toast.needs_in_slot(), cx);
        let notification = toast.into_notification(cx);
        self.push_notification(notification, cx);
    }

    fn dismiss_toast(&mut self, cx: &mut App) {
        self.remove_notification::<OrielToast>(cx);
    }
}

/// The last toast shown, kept for checks: GPUI Kit's notifications do not say what they read.
#[cfg(feature = "test-support")]
struct LastToast(SharedString);

#[cfg(feature = "test-support")]
impl Global for LastToast {}

/// What the last toast shown said.
#[cfg(feature = "test-support")]
pub fn last_toast(cx: &App) -> Option<SharedString> {
    cx.try_global::<LastToast>().map(|last| last.0.clone())
}

#[cfg(test)]
mod tests {
    use super::shortened;

    #[test]
    fn a_word_too_long_for_a_toast_keeps_its_start_and_extension() {
        assert_eq!(
            shortened("Moved 3 files to holding"),
            "Moved 3 files to holding"
        );
        let name = format!("a-very-long-name-{}-end.png", "x".repeat(100));
        let shown = shortened(&format!("Moved {name} to holding"));
        assert!(shown.starts_with("Moved a-very-long-name-"), "{shown}");
        assert!(shown.ends_with("-end.png to holding"), "{shown}");
        assert!(shown.chars().count() < 60, "{shown}");
    }
}
