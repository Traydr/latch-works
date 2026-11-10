//! The overlays' chrome that fades: the viewer's controls and the comic reader's top bar go after
//! [`CHROME_IDLE`] without the pointer moving or a key (a scroll too, in the reader), taking the
//! pointer with them, and come back with any of them.

use std::time::{Duration, Instant};

use gpui_kit::{Context, Focusable, Subscription, Task, Window};

/// How long the chrome stays without the pointer moving or a key.
pub const CHROME_IDLE: Duration = Duration::from_millis(2500);

/// An overlay whose chrome fades.
pub(crate) trait Fading: Focusable + Sized + 'static {
    fn fade(&mut self) -> &mut ChromeFade;

    /// Whether the chrome stays for now, whatever the pointer does: a paused video keeps the
    /// viewer's.
    fn pinned(&self) -> bool {
        false
    }

    /// The chrome came or went.
    fn shown(&mut self, visible: bool, cx: &mut Context<Self>);
}

pub(crate) struct ChromeFade {
    visible: bool,
    /// When the pointer last moved or a key was pressed, on the executor's clock, which a test
    /// can move on.
    last_activity: Instant,
    /// Waits out [`CHROME_IDLE`] from the last activity.
    idle: Option<Task<()>>,
    /// Every key brings the chrome back, the overlay's own too.
    _keys: Subscription,
}

impl ChromeFade {
    pub(crate) fn new<T: Fading>(cx: &mut Context<T>) -> Self {
        Self {
            visible: true,
            last_activity: cx.background_executor().now(),
            idle: None,
            _keys: on_any_key(cx, reveal::<T>),
        }
    }

    pub(crate) fn is_visible(&self) -> bool {
        self.visible
    }

    /// Stops the wait, so the chrome stays: View left the screen, and the pointer must never be
    /// hidden over another mode. [`reveal`] starts it again.
    pub(crate) fn stop(&mut self) {
        self.idle = None;
    }
}

/// The chrome shows, and fades again once left alone for [`CHROME_IDLE`], unless it is pinned.
pub(crate) fn reveal<T: Fading>(host: &mut T, window: &mut Window, cx: &mut Context<T>) {
    host.fade().last_activity = cx.background_executor().now();
    if !host.fade().visible {
        host.fade().visible = true;
        host.shown(true, cx);
    }
    if host.fade().idle.is_some() || host.pinned() {
        return;
    }
    let idle = cx.spawn_in(window, async move |this, cx| {
        loop {
            let Ok(wait) = this.update(cx, |this, cx| {
                let idle = cx
                    .background_executor()
                    .now()
                    .saturating_duration_since(this.fade().last_activity);
                CHROME_IDLE.saturating_sub(idle)
            }) else {
                return;
            };
            if wait.is_zero() {
                break;
            }
            cx.background_executor().timer(wait).await;
        }
        this.update(cx, |this, cx| {
            this.fade().idle = None;
            if !this.pinned() {
                this.fade().visible = false;
                this.shown(false, cx);
                oriel_ui::cursor::hide_pointer_until_it_moves();
            }
        })
        .ok();
    });
    host.fade().idle = Some(idle);
}

/// Whether the chrome is pinned changed: pinned, it shows and stays; unpinned, it fades again.
pub(crate) fn pin_changed<T: Fading>(host: &mut T, window: &mut Window, cx: &mut Context<T>) {
    if host.pinned() {
        host.fade().stop();
        if !host.fade().visible {
            host.fade().visible = true;
            host.shown(true, cx);
        }
    } else {
        reveal(host, window, cx);
    }
}

/// Calls `reveal` on the overlay for every key pressed while focus is inside it, before the key
/// does anything else. A key listener would miss the keys bound to actions, which GPUI hands to
/// the action alone.
fn on_any_key<T: Focusable + 'static>(
    cx: &mut Context<T>,
    reveal: fn(&mut T, &mut Window, &mut Context<T>),
) -> Subscription {
    let entity = cx.entity().downgrade();
    cx.intercept_keystrokes(move |_, window, cx| {
        let Some(entity) = entity.upgrade() else {
            return;
        };
        if entity
            .read(cx)
            .focus_handle(cx)
            .contains_focused(window, cx)
        {
            entity.update(cx, |this, cx| reveal(this, window, cx));
        }
    })
}
