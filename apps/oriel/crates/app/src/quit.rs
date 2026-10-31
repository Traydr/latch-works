//! Quitting, as Electron Oriel quits (plan 059, decision 2): closing the window or ⌘Q quits at
//! once, unless a mode reports [`ModeActivity::Progress`], a push or a Tidy change. Then the
//! window hides, the Dock icon keeps showing the progress, and the app quits once the work ends.
//! Quitting again meanwhile quits at once, and the window coming back (the Dock icon, a file
//! opened with the app, ⌘-Tab) calls the quit off. The system's own quit requests (the Dock
//! icon's Quit, logging out) are answered the same way (`terminate`).
//!
//! [`ModeActivity::Progress`]: oriel_ui::ModeActivity::Progress

use std::cell::Cell;
use std::rc::Rc;

use gpui_kit::{App, AppContext as _, Context, Entity, Global, Subscription, WeakEntity};
use oriel_ui::ShellState;

/// What a quit asks of the platform. The app hides and quits for real; tests record the calls,
/// since the test platform can do neither.
pub trait QuitPlatform {
    /// Takes the window off screen while the work finishes.
    fn hide(&self, cx: &mut App);
    fn quit(&self, cx: &mut App);
}

/// The running app's own hide and quit.
pub struct SystemQuit;

impl QuitPlatform for SystemQuit {
    fn hide(&self, cx: &mut App) {
        cx.hide();
    }

    fn quit(&self, cx: &mut App) {
        cx.quit();
    }
}

/// Decides when a quit happens.
pub struct QuitGuard {
    state: Entity<ShellState>,
    platform: Rc<dyn QuitPlatform>,
    waiting: bool,
    /// Whether a quit asked for now must wait: work runs and the window is not hidden for it yet.
    /// Shared with the system's own quit requests (`terminate`), which cannot borrow the app.
    holds: Rc<Cell<bool>>,
    _observe: Subscription,
}

/// The window's guard, for the app-wide Quit action.
struct ActiveQuitGuard(WeakEntity<QuitGuard>);

impl Global for ActiveQuitGuard {}

impl QuitGuard {
    /// A guard over the work `state` reports, made the app's own for ⌘Q.
    pub fn install(
        state: &Entity<ShellState>,
        platform: Rc<dyn QuitPlatform>,
        cx: &mut App,
    ) -> Entity<Self> {
        let guard = cx.new(|cx: &mut Context<Self>| Self {
            state: state.clone(),
            platform,
            waiting: false,
            holds: Rc::new(Cell::new(false)),
            _observe: cx.observe(state, |this: &mut Self, _, cx| {
                this.finish_if_idle(cx);
                this.sync_hold(cx);
            }),
        });
        cx.set_global(ActiveQuitGuard(guard.downgrade()));
        guard
    }

    /// Quits through the window's guard, or at once if there is no window.
    pub fn request_global(cx: &mut App) {
        let guard = cx
            .try_global::<ActiveQuitGuard>()
            .and_then(|active| active.0.upgrade());
        match guard {
            Some(guard) => guard.update(cx, |guard, cx| guard.request(cx)),
            None => cx.quit(),
        }
    }

    /// Whether the window is hidden, waiting for work to end before the app quits.
    pub fn is_waiting(&self) -> bool {
        self.waiting
    }

    /// Whether a quit asked for now would wait for work rather than happen.
    pub fn holds_quit(&self) -> bool {
        self.holds.get()
    }

    /// [`Self::holds_quit`], kept current for readers outside GPUI.
    pub(crate) fn hold(&self) -> Rc<Cell<bool>> {
        self.holds.clone()
    }

    fn sync_hold(&self, cx: &App) {
        self.holds
            .set(!self.waiting && self.state.read(cx).is_busy());
    }

    /// Quits now, or hides the window and quits when the work ends.
    pub fn request(&mut self, cx: &mut Context<Self>) {
        if self.waiting || !self.state.read(cx).is_busy() {
            self.platform.quit(cx);
            return;
        }
        self.waiting = true;
        self.sync_hold(cx);
        self.platform.hide(cx);
        cx.notify();
    }

    /// Whether closing the window may go ahead now. While work runs it may not: the window
    /// hides instead, and the app quits when the work ends.
    pub fn allows_close(&mut self, cx: &mut Context<Self>) -> bool {
        if !self.state.read(cx).is_busy() {
            return true;
        }
        if !self.waiting {
            self.waiting = true;
            self.sync_hold(cx);
            self.platform.hide(cx);
            cx.notify();
        }
        false
    }

    /// The window is back on screen, so the owner did not mean to leave after all.
    pub fn cancel(&mut self, cx: &mut Context<Self>) {
        if self.waiting {
            self.waiting = false;
            self.sync_hold(cx);
            cx.notify();
        }
    }

    fn finish_if_idle(&mut self, cx: &mut Context<Self>) {
        if self.waiting && !self.state.read(cx).is_busy() {
            self.waiting = false;
            self.platform.quit(cx);
        }
    }
}
