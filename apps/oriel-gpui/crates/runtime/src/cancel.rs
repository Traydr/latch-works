//! Cooperative cancellation: a token the work checks, and callbacks for work that is blocked in
//! something that has to be interrupted, such as a child process.

use std::fmt;
use std::future::Future;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use futures::channel::oneshot;

/// The error cancelled work returns. A [`Job`](crate::Job) finds it anywhere in an error's chain
/// and finishes as cancelled rather than failed.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Cancelled;

impl fmt::Display for Cancelled {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("cancelled")
    }
}

impl std::error::Error for Cancelled {}

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
    callbacks: Mutex<Callbacks>,
}

type Callback = Box<dyn FnOnce() + Send>;

#[derive(Default)]
struct Callbacks {
    next_id: u64,
    pending: Vec<(u64, Callback)>,
}

impl Shared {
    /// The callbacks never run under this lock, so a panic in one cannot poison it; a poisoned
    /// lock still holds a consistent list.
    fn callbacks(&self) -> MutexGuard<'_, Callbacks> {
        self.callbacks
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
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
            let mut callbacks = self.shared.callbacks();
            if self.shared.cancelled.swap(true, Ordering::AcqRel) {
                return;
            }
            std::mem::take(&mut callbacks.pending)
        };
        for (_, callback) in callbacks {
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
        let mut callbacks = self.shared.callbacks();
        if self.is_cancelled() {
            drop(callbacks);
            callback();
            return CancelCallback {
                shared: None,
                id: 0,
            };
        }
        let id = callbacks.next_id;
        callbacks.next_id += 1;
        callbacks.pending.push((id, Box::new(callback)));
        CancelCallback {
            shared: Some(self.shared.clone()),
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
            shared.callbacks().pending.retain(|(id, _)| *id != self.id);
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
