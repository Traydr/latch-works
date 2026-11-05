//! While a menu or popover is open, what the owner does next is about it. A press outside it only
//! closes it, as a native menu's does, so it cannot also press what lay under the pointer, which
//! here can move files. Keys belong to it too: its own go first, and those it does not use must not
//! bubble up to the page it was opened on, which would act on them.
//!
//! Put [`note_press`] on the root of a mode, and [`press_guard`] among its children.

use gpui_kit::base::GlobalState;
use gpui_kit::{
    App, DispatchPhase, Global, IntoElement, MouseDownEvent, Styled as _, Window, canvas, deferred,
};

#[derive(Default)]
struct Press {
    /// This press was outside an open popup, and goes no further than closing it.
    swallow: bool,
    /// The last one was. A popup still open after that does not close on a press, so the next goes
    /// through: however a popup misbehaves, it can never take every click.
    swallowed_last: bool,
}

impl Global for Press {}

/// Whether a menu or popover is open, the right-click menu included, which registers nowhere but
/// holds the keyboard's focus.
pub fn popup_open(window: &Window, cx: &App) -> bool {
    GlobalState::is_in_deferred_context(cx)
        || window
            .context_stack()
            .iter()
            .any(|context| context.contains("PopupMenu") || context.contains("PopoverContent"))
}

/// The capture-phase listener for a mode's root. Popups stop the pointer, so a press inside one
/// never gets here. It runs before any popup's own, so one closing on this press is still open.
pub fn note_press(_: &MouseDownEvent, window: &mut Window, cx: &mut App) {
    let open = popup_open(window, cx);
    let press = cx.default_global::<Press>();
    press.swallow = open && !press.swallowed_last;
    press.swallowed_last = press.swallow;
}

/// Ends a press outside a popup once the popup has had it. Drawn last of all, its capture-phase
/// listener runs after every popup's, which close on that phase, and before anything takes the
/// press on the way back up.
pub fn press_guard() -> impl IntoElement {
    deferred(
        canvas(
            |_, _, _| {},
            |_, _, window, cx| {
                // The focus path is not there to read while a frame is drawn.
                if !GlobalState::is_in_deferred_context(cx) {
                    cx.default_global::<Press>().swallowed_last = false;
                }
                window.on_mouse_event(|_: &MouseDownEvent, phase, _, cx| {
                    if phase == DispatchPhase::Capture
                        && std::mem::take(&mut cx.default_global::<Press>().swallow)
                    {
                        cx.stop_propagation();
                    }
                });
            },
        )
        .absolute()
        .size_0(),
    )
    .with_priority(usize::MAX)
}
