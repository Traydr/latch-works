//! Cooperative cancellation: a token the work checks, and callbacks for work that is blocked in
//! something that has to be interrupted, such as a child process.

use std::fmt;
use std::future::Future;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use futures::channel::oneshot;

use crate::watchers::Watchers;

/// The error cancelled work returns. A job finds it anywhere in an error's chain and finishes as
/// cancelled rather than failed.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Cancelled;

impl fmt::Display for Cancelled {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("cancelled")
    }
}

impl std::error::Error for Cancelled {}

/// Set by [`set_keep_running`].
static KEEP_RUNNING: AtomicBool = AtomicBool::new(false);

/// Makes tools run on when their job is paused, as they do where they cannot be suspended, to
/// see what the app says then on a machine where they can. The shell calls it once at start,
/// from the launch's `ORIEL_TOOLS_KEEP_RUNNING`.
pub fn set_keep_running(on: bool) {
    KEEP_RUNNING.store(on, Ordering::Relaxed);
}

/// Whether a tool in the middle of a file stops at once when its token is held
/// ([`CancelToken::hold`]). Where it cannot, it runs to the end of that file, and the app says
/// "Pausing" until it has.
pub fn tools_suspend() -> bool {
    cfg!(unix) && !KEEP_RUNNING.load(Ordering::Relaxed)
}

/// Asks work to stop. Nothing is interrupted by force: the work calls [`CancelToken::check`]
/// between steps, awaits [`CancelToken::cancelled`], or registers [`CancelToken::on_cancel`] to
/// stop what it is blocked in. Clones share one state, and a cancelled token stays cancelled.
#[derive(Clone, Default)]
pub struct CancelToken {
    shared: Arc<Shared>,
}

#[derive(Default)]
struct Shared {
    cancelled: AtomicBool,
    callbacks: Watchers<Callback>,
    held: AtomicBool,
    hold_watchers: Watchers<HoldWatcher>,
}

type HoldWatcher = Arc<dyn Fn(bool) + Send + Sync>;

type Callback = Box<dyn FnOnce() + Send>;

/// Keeps a watcher given to [`CancelToken::on_hold`] listening; dropping it stops the watcher.
#[must_use = "dropping the guard stops the watcher"]
pub struct HoldWatch {
    shared: Arc<Shared>,
    id: u64,
}

impl Drop for HoldWatch {
    fn drop(&mut self) {
        self.shared.hold_watchers.remove(self.id);
    }
}

impl CancelToken {
    pub fn new() -> Self {
        Self::default()
    }

    /// Cancels the work. Every registered callback runs once, on this thread; later calls do
    /// nothing.
    pub fn cancel(&self) {
        // The flag is set under the lock that `on_cancel` checks it under, so a callback is
        // either registered before this takes the list or sees the flag and runs at once.
        let callbacks = {
            let mut callbacks = self.shared.callbacks.lock();
            if self.shared.cancelled.swap(true, Ordering::AcqRel) {
                return;
            }
            callbacks.take_all()
        };
        for callback in callbacks {
            callback();
        }
    }

    pub fn is_cancelled(&self) -> bool {
        self.shared.cancelled.load(Ordering::Acquire)
    }

    /// `Err(Cancelled)` once the token is cancelled, so work can stop with `?` between steps.
    pub fn check(&self) -> Result<(), Cancelled> {
        if self.is_cancelled() {
            Err(Cancelled)
        } else {
            Ok(())
        }
    }

    /// Runs `callback` when the token is cancelled, on the cancelling thread, or now if it already
    /// is. Dropping the returned guard unregisters a callback that has not run.
    pub fn on_cancel(&self, callback: impl FnOnce() + Send + 'static) -> CancelCallback {
        let mut callbacks = self.shared.callbacks.lock();
        if self.is_cancelled() {
            drop(callbacks);
            callback();
            return CancelCallback {
                shared: None,
                id: 0,
            };
        }
        let id = callbacks.add(Box::new(callback));
        CancelCallback {
            shared: Some(self.shared.clone()),
            id,
        }
    }

    /// Asks what is running under this token to hold still, or to go on. A
    /// [`PauseToken::holding`](crate::PauseToken::holding) this token sets it as its work is paused
    /// and resumed; tests of the tools set it themselves. Every watcher hears of a change, on this
    /// thread.
    pub fn hold(&self, held: bool) {
        let watchers = {
            let watchers = self.shared.hold_watchers.lock();
            if self.shared.held.swap(held, Ordering::AcqRel) == held {
                return;
            }
            watchers.snapshot()
        };
        for watcher in watchers {
            watcher(held);
        }
    }

    /// Runs `watcher` each time the token is held or let go, and now if it is held already.
    /// Dropping the returned guard stops it.
    pub fn on_hold(&self, watcher: impl Fn(bool) + Send + Sync + 'static) -> HoldWatch {
        let watcher: HoldWatcher = Arc::new(watcher);
        let (id, held) = {
            let mut watchers = self.shared.hold_watchers.lock();
            (
                watchers.add(watcher.clone()),
                self.shared.held.load(Ordering::Acquire),
            )
        };
        if held {
            watcher(true);
        }
        HoldWatch {
            shared: self.shared.clone(),
            id,
        }
    }

    /// Resolves once the token is cancelled, for async work that waits on something else and
    /// should stop waiting when asked to.
    pub fn cancelled(&self) -> impl Future<Output = ()> + Send + 'static {
        let (sender, receiver) = oneshot::channel::<()>();
        let registration = self.on_cancel(move || {
            let _ = sender.send(());
        });
        async move {
            // The registration keeps the callback, and so the sender, alive until it runs: the
            // receiver resolves only when the token is cancelled.
            let _registration = registration;
            let _ = receiver.await;
        }
    }
}

impl fmt::Debug for CancelToken {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("CancelToken")
            .field("cancelled", &self.is_cancelled())
            .finish()
    }
}

/// A callback registered with [`CancelToken::on_cancel`]; dropping it unregisters the callback if
/// it has not run.
#[must_use = "dropping the guard unregisters the callback"]
pub struct CancelCallback {
    shared: Option<Arc<Shared>>,
    id: u64,
}

impl Drop for CancelCallback {
    fn drop(&mut self) {
        if let Some(shared) = self.shared.take() {
            shared.callbacks.remove(self.id);
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::AtomicUsize;

    use super::*;

    #[test]
    fn callbacks_run_once_and_only_while_registered() {
        let token = CancelToken::new();
        let runs = Arc::new(AtomicUsize::new(0));
        let counted = runs.clone();
        let kept = token.on_cancel(move || {
            counted.fetch_add(1, Ordering::SeqCst);
        });
        let dropped = token.on_cancel(|| panic!("an unregistered callback ran"));
        drop(dropped);

        assert_eq!(token.check(), Ok(()));
        token.cancel();
        token.cancel();
        assert_eq!(runs.load(Ordering::SeqCst), 1);
        assert_eq!(token.clone().check(), Err(Cancelled));
        drop(kept);

        let counted = runs.clone();
        let _late = token.on_cancel(move || {
            counted.fetch_add(1, Ordering::SeqCst);
        });
        assert_eq!(
            runs.load(Ordering::SeqCst),
            2,
            "a late callback runs at once"
        );
    }

    #[test]
    fn cancelled_resolves_when_another_thread_cancels() {
        let token = CancelToken::new();
        let waiting = token.cancelled();
        let cancelling = token.clone();
        let thread = std::thread::spawn(move || cancelling.cancel());
        futures::executor::block_on(waiting);
        thread.join().unwrap();
        assert!(token.is_cancelled());
    }
}
