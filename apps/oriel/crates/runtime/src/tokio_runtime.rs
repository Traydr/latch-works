//! A tokio runtime on a thread of its own. GPUI has its own executors, and HTTP clients such as
//! `reqwest` need tokio's reactor, so their futures run here and GPUI awaits the result.

use std::fmt;
use std::future::Future;
use std::io;
use std::pin::Pin;
use std::task::{Context, Poll};
use std::thread::JoinHandle;
use std::time::Duration;

use futures::channel::oneshot;
use gpui_kit::Global;

use crate::cancel::Cancelled;
use crate::panic_message;

/// How long dropping the runtime waits for tokio's blocking threads, such as DNS lookups, before
/// it stops waiting. Its tasks are cancelled at once.
const SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(1);

/// A current-thread tokio runtime, driven by a thread of its own. Futures go to it through
/// [`TokioHandle::spawn`] from any thread. Dropping it cancels what still runs and stops the
/// thread. The app keeps one as a GPUI global.
pub struct TokioRuntime {
    handle: TokioHandle,
    shutdown: Option<oneshot::Sender<()>>,
    thread: Option<JoinHandle<()>>,
}

impl TokioRuntime {
    /// Starts the runtime on a new thread called `name`.
    pub fn start(name: &str) -> io::Result<Self> {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .thread_name(format!("{name} (blocking)"))
            .build()?;
        let handle = TokioHandle(runtime.handle().clone());
        let (shutdown, stopped) = oneshot::channel::<()>();
        let thread = std::thread::Builder::new()
            .name(name.to_owned())
            .spawn(move || {
                // Spawned tasks run while this thread is inside `block_on`, until the owner asks
                // it to stop by sending or by dropping the sender.
                runtime.block_on(async {
                    let _ = stopped.await;
                });
                runtime.shutdown_timeout(SHUTDOWN_TIMEOUT);
            })?;
        Ok(Self {
            handle,
            shutdown: Some(shutdown),
            thread: Some(thread),
        })
    }

    pub fn handle(&self) -> TokioHandle {
        self.handle.clone()
    }

    /// [`TokioHandle::spawn`] on this runtime.
    pub fn spawn<Fut>(&self, future: Fut) -> TokioTask<Fut::Output>
    where
        Fut: Future + Send + 'static,
        Fut::Output: Send + 'static,
    {
        self.handle.spawn(future)
    }
}

impl Drop for TokioRuntime {
    fn drop(&mut self) {
        if let Some(shutdown) = self.shutdown.take() {
            let _ = shutdown.send(());
        }
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

impl fmt::Debug for TokioRuntime {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("TokioRuntime").finish_non_exhaustive()
    }
}

impl Global for TokioRuntime {}

/// Spawns futures on a [`TokioRuntime`] from any thread. Cheap to clone.
#[derive(Clone, Debug)]
pub struct TokioHandle(tokio::runtime::Handle);

impl TokioHandle {
    /// Runs `future` on the runtime's thread. The returned task is an ordinary future, so GPUI's
    /// executors (or any other) can await it; dropping it aborts `future` at its next await.
    pub fn spawn<Fut>(&self, future: Fut) -> TokioTask<Fut::Output>
    where
        Fut: Future + Send + 'static,
        Fut::Output: Send + 'static,
    {
        TokioTask {
            join: Some(self.0.spawn(future)),
        }
    }
}

/// A future running on a [`TokioRuntime`]. It resolves to the future's output, or to an error
/// when the future panicked or the runtime stopped first; the latter is [`Cancelled`].
#[must_use = "dropping the task aborts it; call `detach` to let it run"]
pub struct TokioTask<T> {
    join: Option<tokio::task::JoinHandle<T>>,
}

impl<T> TokioTask<T> {
    /// Lets the future run to completion with nobody awaiting it.
    pub fn detach(mut self) {
        // Dropping a tokio join handle detaches its task; only this type's own drop aborts.
        self.join.take();
    }
}

impl<T> Future for TokioTask<T> {
    type Output = anyhow::Result<T>;

    fn poll(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output> {
        let join = self.join.as_mut().expect("a detached task is never polled");
        Pin::new(join).poll(cx).map(|result| {
            result.map_err(|error| {
                if error.is_panic() {
                    anyhow::anyhow!("panicked: {}", panic_message(error.into_panic()))
                } else {
                    anyhow::Error::new(Cancelled)
                }
            })
        })
    }
}

impl<T> Drop for TokioTask<T> {
    fn drop(&mut self) {
        if let Some(join) = self.join.take() {
            join.abort();
        }
    }
}
