//! A redraw asked for while a frame is being drawn. A canvas measures its bounds during a draw, and
//! GPUI's `cx.notify()` and `window.refresh()` only wake the window outside one, so what depends on
//! the measure would stay stale until some other input drew a frame: Library's columns kept their
//! old widths after the inspector opened until the pointer moved.

use gpui_kit::{WeakEntity, Window};

/// Draws `view` again in the next frame, with what this frame measured.
pub fn notify_next_frame<T: 'static>(view: WeakEntity<T>, window: &Window) {
    window.on_next_frame(move |_, cx| {
        view.update(cx, |_, cx| cx.notify()).ok();
    });
}

/// Draws the whole window again in the next frame.
pub fn refresh_next_frame(window: &Window) {
    window.on_next_frame(|window, _| window.refresh());
}
