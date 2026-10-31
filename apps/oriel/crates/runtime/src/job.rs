//! Jobs: work that runs on GPUI's background executor and that the UI observes as an entity, so
//! a view can draw a progress ring while it runs and show a toast when it fails.

use std::any::Any;
use std::fmt;
use std::future::Future;
use std::panic::AssertUnwindSafe;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, PoisonError};

use futures::channel::mpsc;
use futures::future::{self, Either};
use futures::{FutureExt as _, StreamExt as _};
use gpui_kit::{App, AppContext as _, Context, Entity, EventEmitter, SharedString, Task};

use crate::cancel::{CancelToken, Cancelled};
use crate::panic_message;
use crate::pause::PauseToken;

/// How far a job has got: `done` of `total` in the phase named `phase`. A total of 0 means the
/// phase's size is not known yet. It also says whether the job is paused, waits for its turn, or
/// runs in the background, which is how glazier-core's job card words a job's state ("Paused",
/// "In the background", queued).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct JobProgress {
    phase: SharedString,
    done: u64,
    total: u64,
    paused: bool,
    waiting: bool,
    background: bool,
}

impl JobProgress {
    pub fn phase(&self) -> &SharedString {
        &self.phase
    }

    pub fn done(&self) -> u64 {
        self.done
    }

    pub fn total(&self) -> u64 {
        self.total
    }

    /// The share done, from 0 to 1, or `None` while the total is unknown, when a ring spins
    /// rather than fills.
    pub fn fraction(&self) -> Option<f32> {
        (self.total > 0).then(|| (self.done.min(self.total) as f64 / self.total as f64) as f32)
    }

    /// Whether the owner paused the job ([`Job::pause`]). The step in flight still finishes.
    pub fn is_paused(&self) -> bool {
        self.paused
    }

    /// Whether the job waits for its turn rather than working: queued behind other work, or
    /// stepped aside for work the owner asked for. It goes on by itself; glazier-core shows it as
    /// queued.
    pub fn is_waiting(&self) -> bool {
        self.waiting
    }

    /// Whether the job is background work, which runs only while nothing the owner asked for
    /// waits; its card is drawn muted, "In the background".
    pub fn is_background(&self) -> bool {
        self.background
    }
}

/// Why a job did not finish with a value.
#[derive(Clone, Debug)]
pub enum JobError {
    /// The job stopped because it was cancelled.
    Cancelled,
    /// The job returned an error, or panicked.
    Failed(Arc<anyhow::Error>),
}

impl JobError {
    /// Sorts an error the work returned. It is a cancel when [`Cancelled`] is anywhere in its
    /// chain, so a cancelled step wrapped in context still reads as one, or when the job had been
    /// cancelled: a tool killed on cancel fails in its own way, and that failure is the cancel.
    fn from_error(error: anyhow::Error, after_cancel: bool) -> Self {
        if after_cancel || error.chain().any(|cause| cause.is::<Cancelled>()) {
            Self::Cancelled
        } else {
            Self::Failed(Arc::new(error))
        }
    }

    fn from_panic(payload: Box<dyn Any + Send>) -> Self {
        Self::Failed(Arc::new(anyhow::anyhow!(
            "panicked: {}",
            panic_message(payload)
        )))
    }

    pub fn is_cancelled(&self) -> bool {
        matches!(self, Self::Cancelled)
    }

    /// What an error toast says: the error and its causes, outermost first.
    pub fn message(&self) -> SharedString {
        match self {
            Self::Cancelled => "Cancelled".into(),
            Self::Failed(error) => format!("{error:#}").into(),
        }
    }
}

impl fmt::Display for JobError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message())
    }
}

/// Where a job is: still running, or finished with its value or its error.
#[derive(Debug)]
pub enum JobStatus<T> {
    Running,
    Succeeded(T),
    Failed(JobError),
}

/// What a job's subscribers hear, once, when it finishes. Its value stays on the entity.
#[derive(Clone, Debug)]
pub enum JobEvent {
    Succeeded,
    Failed(JobError),
}

/// A piece of background work and where it has got, as an entity. Start one with
/// [`Job::start`]; observe it for progress, subscribe to it for [`JobEvent`]s.
///
/// The owner holds the entity. Dropping the last handle cancels the job: the token is cancelled
/// for work that checks it, and the work's future is dropped at its next await. Pausing is
/// cooperative too: the work waits at its own checkpoints ([`JobReporter::wait_while_paused`],
/// [`JobReporter::resumed`]).
pub struct Job<T> {
    name: SharedString,
    progress: JobProgress,
    status: JobStatus<T>,
    token: CancelToken,
    pause: PauseToken,
    _task: Task<()>,
}

impl<T: Send + 'static> Job<T> {
    /// Runs `work` on the background executor. It gets a [`JobReporter`] to report progress and
    /// to learn of cancellation, and returns the job's value or its error. A panic in `work`
    /// fails the job rather than the app.
    pub fn start<F, Fut>(name: impl Into<SharedString>, cx: &mut App, work: F) -> Entity<Self>
    where
        F: FnOnce(JobReporter) -> Fut + Send + 'static,
        Fut: Future<Output = anyhow::Result<T>> + Send + 'static,
    {
        let name = name.into();
        let token = CancelToken::new();
        let pause = PauseToken::new();
        let slot = Arc::new(ProgressSlot::default());
        let (wake, mut wakes) = mpsc::unbounded();
        let reporter = JobReporter {
            token: token.clone(),
            pause: pause.clone(),
            slot: slot.clone(),
            wake,
        };
        let run = AssertUnwindSafe(async move { work(reporter).await }).catch_unwind();
        let cancelled = token.clone();

        cx.new(|cx| {
            let work = cx.background_spawn(async move {
                match run.await {
                    Ok(Ok(value)) => Ok(value),
                    Ok(Err(error)) => Err(JobError::from_error(error, cancelled.is_cancelled())),
                    Err(payload) => Err(JobError::from_panic(payload)),
                }
            });
            let task = cx.spawn(async move |this, cx| {
                let mut work = std::pin::pin!(work);
                let result = loop {
                    match future::select(work.as_mut(), wakes.next()).await {
                        Either::Left((result, _)) => break result,
                        Either::Right((Some(()), _)) => {
                            let progress = slot.take();
                            let shown = this.update(cx, |job: &mut Self, cx| {
                                job.progress = JobProgress {
                                    paused: job.pause.is_paused(),
                                    ..progress
                                };
                                cx.notify();
                            });
                            if shown.is_err() {
                                return;
                            }
                        }
                        // Every reporter is gone, so no more progress comes; wait for the value.
                        Either::Right((None, _)) => break work.await,
                    }
                };
                this.update(cx, |job: &mut Self, cx| job.finish(result, slot.take(), cx))
                    .ok();
            });

            Job {
                name,
                progress: JobProgress::default(),
                status: JobStatus::Running,
                token,
                pause,
                _task: task,
            }
        })
    }

    fn finish(
        &mut self,
        result: Result<T, JobError>,
        progress: JobProgress,
        cx: &mut Context<Self>,
    ) {
        // A finished job neither waits nor is paused, whatever its last report said.
        self.progress = JobProgress {
            paused: false,
            waiting: false,
            ..progress
        };
        let event = match &result {
            Ok(_) => JobEvent::Succeeded,
            Err(error) => {
                log::info!("job {:?} did not finish: {error}", self.name);
                JobEvent::Failed(error.clone())
            }
        };
        self.status = match result {
            Ok(value) => JobStatus::Succeeded(value),
            Err(error) => JobStatus::Failed(error),
        };
        cx.emit(event);
        cx.notify();
    }
}

impl<T: 'static> Job<T> {
    pub fn name(&self) -> &SharedString {
        &self.name
    }

    pub fn progress(&self) -> &JobProgress {
        &self.progress
    }

    pub fn status(&self) -> &JobStatus<T> {
        &self.status
    }

    pub fn is_running(&self) -> bool {
        matches!(self.status, JobStatus::Running)
    }

    /// Whether cancelling was asked for while the job still runs, so a view can say "Stopping".
    pub fn is_cancelling(&self) -> bool {
        self.is_running() && self.token.is_cancelled()
    }

    pub fn value(&self) -> Option<&T> {
        match &self.status {
            JobStatus::Succeeded(value) => Some(value),
            _ => None,
        }
    }

    pub fn error(&self) -> Option<&JobError> {
        match &self.status {
            JobStatus::Failed(error) => Some(error),
            _ => None,
        }
    }

    /// Asks the job to stop. It finishes as [`JobError::Cancelled`] once the work notices, or with
    /// its value if the work completes first. A paused job stops too: the cancel ends its wait,
    /// and it no longer reads as paused.
    pub fn cancel(&mut self, cx: &mut Context<Self>) {
        if self.is_running() && !self.token.is_cancelled() {
            self.token.cancel();
            self.pause.resume();
            self.progress.paused = false;
            cx.notify();
        }
    }

    /// Whether the owner paused the job and it has not finished.
    pub fn is_paused(&self) -> bool {
        self.is_running() && self.pause.is_paused()
    }

    /// Asks the job to wait at its next checkpoint, as glazier-core's `pauseJob` does. The step in
    /// flight finishes first. Work that never checks for a pause runs on.
    pub fn pause(&mut self, cx: &mut Context<Self>) {
        self.set_paused(true, cx);
    }

    pub fn resume(&mut self, cx: &mut Context<Self>) {
        self.set_paused(false, cx);
    }

    /// Pauses or resumes a running job; a finished or stopping one stays as it is.
    pub fn set_paused(&mut self, paused: bool, cx: &mut Context<Self>) {
        if self.is_running() && !self.token.is_cancelled() && self.pause.set_paused(paused) {
            self.progress.paused = paused;
            cx.notify();
        }
    }
}

impl<T> Drop for Job<T> {
    fn drop(&mut self) {
        self.token.cancel();
    }
}

impl<T: 'static> EventEmitter<JobEvent> for Job<T> {}

/// The work's side of a [`Job`]: it reports progress and learns of cancellation and pauses.
/// Clones report to the same job, so work spread over several threads can share it.
#[derive(Clone)]
pub struct JobReporter {
    token: CancelToken,
    pause: PauseToken,
    slot: Arc<ProgressSlot>,
    wake: mpsc::UnboundedSender<()>,
}

impl JobReporter {
    /// Starts a phase: names it and sets its total (0 when unknown), with nothing done yet.
    pub fn begin_phase(&self, phase: impl Into<SharedString>, total: u64) {
        let phase = phase.into();
        self.report(|progress| {
            progress.phase = phase;
            progress.done = 0;
            progress.total = total;
        });
    }

    pub fn set_done(&self, done: u64) {
        self.report(|progress| progress.done = done);
    }

    pub fn advance(&self, by: u64) {
        self.report(|progress| progress.done = progress.done.saturating_add(by));
    }

    /// The token to hand to code that can be interrupted, such as a tool run.
    pub fn cancel_token(&self) -> &CancelToken {
        &self.token
    }

    pub fn is_cancelled(&self) -> bool {
        self.token.is_cancelled()
    }

    /// `Err(Cancelled)` once the job is cancelled, so the work can stop with `?` between steps.
    pub fn check(&self) -> Result<(), Cancelled> {
        self.token.check()
    }

    /// Resolves once the job is cancelled.
    pub fn cancelled(&self) -> impl Future<Output = ()> + Send + 'static {
        self.token.cancelled()
    }

    /// The token the owner pauses the job with, for code that waits on more than the pause.
    pub fn pause_token(&self) -> &PauseToken {
        &self.pause
    }

    pub fn is_paused(&self) -> bool {
        self.pause.is_paused()
    }

    /// A checkpoint for work on a thread of its own: blocks while the job is paused, and returns
    /// `Err(Cancelled)` once it is cancelled, paused or not.
    pub fn wait_while_paused(&self) -> Result<(), Cancelled> {
        self.pause.wait_blocking(&self.token)
    }

    /// The async checkpoint: resolves once the job is not paused, or with `Err(Cancelled)` once
    /// it is cancelled.
    pub fn resumed(&self) -> impl Future<Output = Result<(), Cancelled>> + Send + 'static {
        self.pause.resumed(&self.token)
    }

    /// Says the job waits for its turn (true) or works again (false); see
    /// [`JobProgress::is_waiting`].
    pub fn set_waiting(&self, waiting: bool) {
        self.report(|progress| progress.waiting = waiting);
    }

    /// Says the job is background work (true) or work the owner asked for (false); see
    /// [`JobProgress::is_background`].
    pub fn set_background(&self, background: bool) {
        self.report(|progress| progress.background = background);
    }

    /// Updates the latest progress and wakes the UI side unless a wake is already pending, so a
    /// job that reports per file costs the UI one update per frame it gets to run, not one per
    /// file.
    fn report(&self, update: impl FnOnce(&mut JobProgress)) {
        update(
            &mut self
                .slot
                .latest
                .lock()
                .unwrap_or_else(PoisonError::into_inner),
        );
        if !self.slot.pending.swap(true, Ordering::AcqRel) {
            let _ = self.wake.unbounded_send(());
        }
    }
}

/// The latest progress, shared between the work and the job's UI task.
#[derive(Default)]
struct ProgressSlot {
    latest: Mutex<JobProgress>,
    pending: AtomicBool,
}

impl ProgressSlot {
    /// A copy of the latest progress. The pending flag clears first, so a report that lands
    /// after the copy wakes the UI again.
    fn take(&self) -> JobProgress {
        self.pending.store(false, Ordering::Release);
        self.latest
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }
}
