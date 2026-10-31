//! Cooperative pausing: a token the owner pauses and resumes, and that the work waits on between
//! steps, beside the [`CancelToken`] that stops it.

use std::fmt;
use std::future::Future;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, PoisonError};

use futures::StreamExt as _;
use futures::channel::mpsc;
use futures::future::{self, Either};

use crate::cancel::{CancelToken, Cancelled};

/// Asks work to wait. Nothing is suspended by force: the work waits at its own checkpoints, with
/// [`PauseToken::wait_blocking`] on a thread of its own or [`PauseToken::resumed`] in async code,
/// so a step in flight always finishes first. Clones share one state. A cancel ends any wait at
/// once, so a paused job still stops when asked to.
#[derive(Clone, Default)]
pub struct PauseToken {
    shared: Arc<Shared>,
}

type Watcher = Arc<dyn Fn() + Send + Sync>;

#[derive(Default)]
struct Shared {
    paused: AtomicBool,
    watchers: Mutex<Watchers>,
}

#[derive(Default)]
struct Watchers {
    next_id: u64,
    list: Vec<(u64, Watcher)>,
}

impl Shared {
    /// The watchers never run under this lock, so a panic in one cannot poison it.
    fn watchers(&self) -> MutexGuard<'_, Watchers> {
        self.watchers.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

impl PauseToken {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn pause(&self) -> bool {
        self.set_paused(true)
    }

    pub fn resume(&self) -> bool {
        self.set_paused(false)
    }

    /// Pauses or resumes the work, and says whether that changed anything. Every watcher runs
    /// after a change, on this thread.
    pub fn set_paused(&self, paused: bool) -> bool {
        // The flag changes under the lock `on_change` registers under, so a watcher is either
        // registered before the change and called, or registered after and sees the new state.
        let watchers: Vec<Watcher> = {
            let watchers = self.shared.watchers();
            if self.shared.paused.swap(paused, Ordering::AcqRel) == paused {
                return false;
            }
            watchers
                .list
                .iter()
                .map(|(_, watcher)| watcher.clone())
                .collect()
        };
        for watcher in watchers {
            watcher();
        }
        true
    }

    pub fn is_paused(&self) -> bool {
        self.shared.paused.load(Ordering::Acquire)
    }

    /// Runs `callback` each time the token is paused or resumed, on the thread that did it, until
    /// the returned guard is dropped. It is how a wait on several things at once (a pause, a
    /// cancel, a queue) learns that one of them moved.
    pub fn on_change(&self, callback: impl Fn() + Send + Sync + 'static) -> PauseCallback {
        let mut watchers = self.shared.watchers();
        let id = watchers.next_id;
        watchers.next_id += 1;
        watchers.list.push((id, Arc::new(callback)));
        PauseCallback {
            shared: self.shared.clone(),
            id,
        }
    }

    /// Blocks the calling thread while the token is paused. Returns `Err(Cancelled)` as soon as
    /// `cancel` is cancelled, paused or not, and otherwise `Ok` once the work may go on. For work
    /// on a thread of its own; async code awaits [`PauseToken::resumed`].
    pub fn wait_blocking(&self, cancel: &CancelToken) -> Result<(), Cancelled> {
        cancel.check()?;
        if !self.is_paused() {
            return Ok(());
        }
        let signal = Arc::new((Mutex::new(()), Condvar::new()));
        let wake = move |signal: &(Mutex<()>, Condvar)| {
            let _held = signal.0.lock().unwrap_or_else(PoisonError::into_inner);
            signal.1.notify_all();
        };
        let on_pause = signal.clone();
        let _watching = self.on_change(move || wake(&on_pause));
        let on_cancel = signal.clone();
        let _cancelling = cancel.on_cancel(move || wake(&on_cancel));
        let mut held = signal.0.lock().unwrap_or_else(PoisonError::into_inner);
        // Checked under the lock the wakers take, so a change between the check and the wait
        // still wakes it.
        loop {
            cancel.check()?;
            if !self.is_paused() {
                return Ok(());
            }
            held = signal.1.wait(held).unwrap_or_else(PoisonError::into_inner);
        }
    }

    /// Resolves with `Ok` once the token is not paused, or with `Err(Cancelled)` once `cancel` is
    /// cancelled.
    pub fn resumed(
        &self,
        cancel: &CancelToken,
    ) -> impl Future<Output = Result<(), Cancelled>> + Send + 'static {
        let token = self.clone();
        let cancel = cancel.clone();
        async move {
            let (wake, mut wakes) = mpsc::unbounded::<()>();
            let _watching = token.on_change(move || {
                let _ = wake.unbounded_send(());
            });
            let mut cancelled = std::pin::pin!(cancel.cancelled());
            loop {
                cancel.check()?;
                if !token.is_paused() {
                    return Ok(());
                }
                if let Either::Left((None, _)) =
                    future::select(wakes.next(), cancelled.as_mut()).await
                {
                    // The watcher holds the sender until `_watching` drops, so this never ends
                    // the stream; wait for the cancel alone if it somehow does.
                    cancelled.as_mut().await;
                }
            }
        }
    }
}

impl fmt::Debug for PauseToken {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("PauseToken")
            .field("paused", &self.is_paused())
            .finish()
    }
}

/// A watcher registered with [`PauseToken::on_change`]; dropping it unregisters the watcher.
#[must_use = "dropping the guard unregisters the watcher"]
pub struct PauseCallback {
    shared: Arc<Shared>,
    id: u64,
}

impl Drop for PauseCallback {
    fn drop(&mut self) {
        self.shared.watchers().list.retain(|(id, _)| *id != self.id);
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::AtomicUsize;
    use std::time::Duration;

    use super::*;

    #[test]
    fn watchers_hear_each_change_while_registered() {
        let token = PauseToken::new();
        let heard = Arc::new(AtomicUsize::new(0));
        let counted = heard.clone();
        let watching = token.on_change(move || {
            counted.fetch_add(1, Ordering::SeqCst);
        });
        assert!(token.pause());
        assert!(!token.pause(), "pausing a paused token changes nothing");
        assert!(token.is_paused());
        assert!(token.resume());
        assert_eq!(heard.load(Ordering::SeqCst), 2);
        drop(watching);
        token.pause();
        assert_eq!(heard.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn a_blocked_wait_ends_on_resume_or_on_cancel() {
        let token = PauseToken::new();
        let cancel = CancelToken::new();
        assert_eq!(token.wait_blocking(&cancel), Ok(()), "not paused: no wait");

        token.pause();
        let resuming = token.clone();
        let thread = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(20));
            resuming.resume();
        });
        assert_eq!(token.wait_blocking(&cancel), Ok(()));
        thread.join().unwrap();

        token.pause();
        let cancelling = cancel.clone();
        let thread = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(20));
            cancelling.cancel();
        });
        assert_eq!(token.wait_blocking(&cancel), Err(Cancelled));
        assert!(token.is_paused(), "a cancel ends the wait, not the pause");
        thread.join().unwrap();
    }

    #[test]
    fn resumed_resolves_when_another_thread_resumes() {
        let token = PauseToken::new();
        let cancel = CancelToken::new();
        token.pause();
        let waiting = token.resumed(&cancel);
        let resuming = token.clone();
        let thread = std::thread::spawn(move || resuming.resume());
        assert_eq!(futures::executor::block_on(waiting), Ok(()));
        thread.join().unwrap();
    }
}
