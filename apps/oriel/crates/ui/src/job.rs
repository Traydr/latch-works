//! Jobs: background work the UI observes as an entity, so a view can draw its progress while it
//! runs and show a toast when it fails, and the one place a job's progress becomes a row of the
//! activity panel ([`JobProgress::activity`]). The work itself is plain code taking a
//! [`JobReporter`]; the tokens it is stopped and paused with are `oriel_runtime`'s.

use std::any::Any;
use std::cell::RefCell;
use std::fmt;
use std::future::Future;
use std::panic::AssertUnwindSafe;
use std::rc::Rc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, Instant};

use anyhow::Context as _;
use futures::channel::{mpsc, oneshot};
use futures::future::{self, Either};
use futures::{FutureExt as _, StreamExt as _};
use gpui_kit::{App, AppContext as _, Context, Entity, EventEmitter, SharedString, Task};
use oriel_runtime::{CancelToken, Cancelled, PauseToken, panic_message};

use crate::activity::{ActivityJob, JobState};

/// How far a job has got: `done` of `total` in the phase named `phase`. A total of 0 means the
/// phase's size is not known yet. It also says whether the job is paused, waits for its turn, or
/// runs in the background, which the activity panel shows as "Paused", queued and "In the
/// background".
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct JobProgress {
    phase: SharedString,
    done: u64,
    total: u64,
    paused: bool,
    waiting: bool,
    background: bool,
    item: Option<SharedString>,
    /// In thousandths, which also keeps a redraw from following every frame.
    item_thousandths: Option<u16>,
    /// The part of the step on [`Self::item`] under way, such as "Encoding".
    stage: Option<SharedString>,
    /// How far that part has got, in thousandths, when it says.
    stage_thousandths: Option<u16>,
    /// When the item, or its part, began: what the time left is reckoned from.
    since: Option<Instant>,
    /// The owner stopped the job and it is winding down.
    stopping: bool,
    /// The work has come to rest for a pause, at a checkpoint.
    paused_here: bool,
    /// The part of the step under way is in-process work a pause does not stop, such as a copy.
    runs_through_pause: bool,
}

/// How long a part runs before the time it has left is reckoned: the first moments of an encode
/// say little about its pace.
const TIME_LEFT_AFTER: Duration = Duration::from_secs(5);

impl JobProgress {
    /// What one long step works on now, such as the video being encoded.
    pub fn item(&self) -> Option<&SharedString> {
        self.item.as_ref()
    }

    /// How far that step has got, from 0 to 1, when it can say.
    pub fn item_share(&self) -> Option<f32> {
        self.item_thousandths.map(|share| f32::from(share) / 1000.)
    }

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
    /// stepped aside for work the owner asked for. It goes on by itself.
    pub fn is_waiting(&self) -> bool {
        self.waiting
    }

    /// Whether the job is background work, which runs only while nothing the owner asked for
    /// waits; its card is drawn muted, "In the background".
    pub fn is_background(&self) -> bool {
        self.background
    }

    /// The part of the step on [`Self::item`] under way, such as "Reading the original".
    pub fn stage(&self) -> Option<&SharedString> {
        self.stage.as_ref()
    }

    /// Whether the owner stopped the job and it has yet to wind down.
    pub fn is_stopping(&self) -> bool {
        self.stopping
    }

    /// "Encoding · 47% · about 3 min left": the part of the step under way, how far it has got
    /// and, once it has run long enough to tell, how long it has left at `now`.
    pub fn stage_detail(&self, now: Instant) -> Option<String> {
        // A named part says only its own share: the encode's last share is no measure of the
        // check or the move that follow it.
        let share = match (&self.stage, self.stage_thousandths) {
            (Some(_), share) => share.map(|share| f32::from(share) / 1000.),
            (None, _) => self.item_share().filter(|_| self.item.is_some()),
        };
        let mut parts: Vec<String> = Vec::new();
        if let Some(stage) = &self.stage {
            parts.push(stage.to_string());
        }
        if let Some(share) = share {
            parts.push(format!("{}%", percent(share)));
            if let Some(left) = self.time_left(share, now) {
                parts.push(left);
            }
        }
        (!parts.is_empty()).then(|| parts.join(" · "))
    }

    /// "about 3 min left", from how long the part has run and how far it has got.
    fn time_left(&self, share: f32, now: Instant) -> Option<String> {
        if self.paused || !(0.01..1.).contains(&share) {
            return None;
        }
        let elapsed = now.checked_duration_since(self.since?)?;
        if elapsed < TIME_LEFT_AFTER {
            return None;
        }
        let left = elapsed.as_secs_f64() * f64::from(1. - share) / f64::from(share);
        Some(time_left(Duration::from_secs_f64(left)))
    }

    /// The file name of [`Self::item`], which is a path.
    pub fn item_name(&self) -> Option<&str> {
        let item = self.item.as_deref()?;
        Some(item.rsplit(['/', '\\']).next().unwrap_or(item))
    }

    /// Whether the owner paused the job while a tool works on through its file because it
    /// cannot be stopped where it is ([`oriel_runtime::tools_suspend`] false), so the job is not
    /// yet paused.
    ///
    /// Paused work is at rest once it waits at a checkpoint, waits for its turn, or (asked for,
    /// where tools stop where they are) has its file's tool held. Until then what it had in hand
    /// finishes: stills encoding, a background analysis's files, a tool on Windows, a copy or a
    /// move that runs through a pause ([`JobReporter::set_runs_through_pause`]).
    pub fn is_pausing(&self) -> bool {
        let held_tool = oriel_runtime::tools_suspend()
            && !self.background
            && self.item.is_some()
            && !self.runs_through_pause;
        self.paused && !self.stopping && !self.paused_here && !self.waiting && !held_tool
    }

    /// "Pausing after this file · 47%", while [`Self::is_pausing`].
    pub fn pausing_after(&self) -> Option<String> {
        if !self.is_pausing() {
            return None;
        }
        Some(match (self.item.is_some(), self.item_share()) {
            (true, Some(share)) => format!("Pausing after this file · {}%", percent(share)),
            (true, None) => "Pausing after this file".to_owned(),
            (false, _) => "Pausing once the work in hand is done".to_owned(),
        })
    }

    /// The share done, counting the step in flight as far as it says it has got, from 0 to 1;
    /// `None` while the total is unknown. The switcher's ring and the panel's bar both read this.
    pub fn fraction_with_item(&self) -> Option<f32> {
        if self.total == 0 {
            return None;
        }
        let item = self.item_share().unwrap_or(0.);
        Some(((self.done.min(self.total) as f32 + item) / self.total as f32).clamp(0., 1.))
    }

    /// The job as the activity panel lists it under `key`: its phase (or `name` before it has
    /// one), where it is, its counts, the file in flight, and which controls apply. Work waiting
    /// for its turn has nothing to pause yet; every job can be stopped.
    pub fn activity(&self, key: impl Into<SharedString>, name: &SharedString) -> ActivityJob {
        let label = if self.phase.is_empty() {
            name.clone()
        } else {
            self.phase.clone()
        };
        let still_going = self.pausing_after();
        let state = if still_going.is_some() || self.stopping {
            JobState::Running
        } else if self.paused {
            JobState::Paused
        } else if self.waiting {
            JobState::Queued
        } else if self.background {
            JobState::Background
        } else {
            JobState::Running
        };
        let share = self.item_share().filter(|_| self.total > 0);
        let mut job = ActivityJob::new(key, label);
        if share.is_some()
            && let Some(fraction) = self.fraction_with_item()
        {
            job = job.progress(fraction);
        }
        if let Some(name) = self.item_name() {
            job = job.item(name.to_owned());
        }
        let detail = if self.stopping {
            Some("Stopping… what is done stays done".to_owned())
        } else {
            still_going.or_else(|| self.stage_detail(Instant::now()))
        };
        if let Some(detail) = detail {
            job = job.detail(detail);
        }
        job.state(state)
            .counts(self.done, self.total)
            .pausable(state != JobState::Queued && !self.stopping)
            .stoppable(!self.stopping)
    }
}

/// A share as whole percent, rounded down, as a step's progress is shown.
fn percent(share: f32) -> f32 {
    (share * 100.).floor()
}

/// "about 40 s left", "about 3 min left", "about 1 h 20 min left": rounded, as a guess is.
fn time_left(left: Duration) -> String {
    let seconds = left.as_secs();
    let minutes = seconds.div_ceil(60);
    if seconds < 60 {
        let tens = seconds.div_ceil(10).max(1) * 10;
        format!("about {tens} s left")
    } else if minutes < 60 {
        format!("about {minutes} min left")
    } else if minutes.is_multiple_of(60) {
        format!("about {} h left", minutes / 60)
    } else {
        format!("about {} h {} min left", minutes / 60, minutes % 60)
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
        let pause = PauseToken::holding(&token);
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
                                    stopping: job.token.is_cancelled(),
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

    /// [`Job::start`] for blocking work: `work` runs on a thread of its own called `thread`, so it
    /// may wait on files, tools and locks without holding up an executor.
    pub fn run_blocking<F>(
        name: impl Into<SharedString>,
        thread: &str,
        cx: &mut App,
        work: F,
    ) -> Entity<Self>
    where
        F: FnOnce(JobReporter) -> anyhow::Result<T> + Send + 'static,
    {
        let thread = thread.to_owned();
        Self::start(name, cx, move |reporter| {
            let (reply, answer) = oneshot::channel();
            let spawned = std::thread::Builder::new().name(thread).spawn(move || {
                let outcome = std::panic::catch_unwind(AssertUnwindSafe(|| work(reporter)));
                let _ = reply.send(outcome);
            });
            async move {
                spawned.context("starting a worker thread")?;
                match answer
                    .await
                    .context("a worker thread stopped without an answer")?
                {
                    Ok(outcome) => outcome,
                    Err(payload) => std::panic::resume_unwind(payload),
                }
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
            stopping: false,
            paused_here: false,
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

impl<T: Clone + 'static> Job<T> {
    /// Resolves with the job's value or its error once it finishes, or at once if it has. The
    /// future holds what listens to the job, so it must be awaited where it was made (a task of
    /// the app's).
    pub fn finished(
        job: &Entity<Self>,
        cx: &mut App,
    ) -> impl Future<Output = Result<T, JobError>> + 'static {
        let (sender, receiver) = oneshot::channel();
        let done = match job.read(cx).status() {
            JobStatus::Running => None,
            JobStatus::Succeeded(value) => Some(Ok(value.clone())),
            JobStatus::Failed(error) => Some(Err(error.clone())),
        };
        let sender = RefCell::new(match done {
            Some(outcome) => {
                let _ = sender.send(outcome);
                None
            }
            None => Some(sender),
        });
        let subscription = cx.subscribe(job, move |job, event: &JobEvent, cx| {
            let outcome = match event {
                JobEvent::Succeeded => job.read(cx).value().cloned().ok_or(JobError::Cancelled),
                JobEvent::Failed(error) => Err(error.clone()),
            };
            if let Some(sender) = sender.borrow_mut().take() {
                let _ = sender.send(outcome);
            }
        });
        async move {
            let _listening = subscription;
            receiver.await.unwrap_or(Err(JobError::Cancelled))
        }
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
            self.progress.stopping = true;
            cx.notify();
        }
    }

    /// Whether the owner paused the job and it has not finished.
    pub fn is_paused(&self) -> bool {
        self.is_running() && self.pause.is_paused()
    }

    /// Asks the job to wait at its next checkpoint. The step in flight finishes first. Work that never checks for a pause runs on.
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

/// A job whatever its value, for an owner that pauses, stops and reports jobs of several kinds
/// alike. Clones refer to the same job.
#[derive(Clone)]
pub struct AnyJob(Rc<dyn ErasedJob>);

trait ErasedJob {
    fn name(&self, cx: &App) -> SharedString;
    fn progress(&self, cx: &App) -> JobProgress;
    fn is_running(&self, cx: &App) -> bool;
    fn error(&self, cx: &App) -> Option<JobError>;
    fn set_paused(&self, paused: bool, cx: &mut App);
    fn cancel(&self, cx: &mut App);
}

impl<T: 'static> ErasedJob for Entity<Job<T>> {
    fn name(&self, cx: &App) -> SharedString {
        self.read(cx).name.clone()
    }

    fn progress(&self, cx: &App) -> JobProgress {
        self.read(cx).progress.clone()
    }

    fn is_running(&self, cx: &App) -> bool {
        self.read(cx).is_running()
    }

    fn error(&self, cx: &App) -> Option<JobError> {
        self.read(cx).error().cloned()
    }

    fn set_paused(&self, paused: bool, cx: &mut App) {
        self.update(cx, |job, cx| job.set_paused(paused, cx));
    }

    fn cancel(&self, cx: &mut App) {
        self.update(cx, |job, cx| job.cancel(cx));
    }
}

impl<T: 'static> From<Entity<Job<T>>> for AnyJob {
    fn from(job: Entity<Job<T>>) -> Self {
        Self(Rc::new(job))
    }
}

impl AnyJob {
    pub fn name(&self, cx: &App) -> SharedString {
        self.0.name(cx)
    }

    pub fn progress(&self, cx: &App) -> JobProgress {
        self.0.progress(cx)
    }

    pub fn is_running(&self, cx: &App) -> bool {
        self.0.is_running(cx)
    }

    /// Why the job did not finish, once it has ended so.
    pub fn error(&self, cx: &App) -> Option<JobError> {
        self.0.error(cx)
    }

    pub fn set_paused(&self, paused: bool, cx: &mut App) {
        self.0.set_paused(paused, cx);
    }

    pub fn cancel(&self, cx: &mut App) {
        self.0.cancel(cx);
    }

    /// The job as the activity panel lists it; see [`JobProgress::activity`].
    pub fn activity(&self, key: impl Into<SharedString>, cx: &App) -> ActivityJob {
        self.progress(cx).activity(key, &self.name(cx))
    }
}

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

    /// Names what a long step works on, and how far it has got when it can say.
    pub fn set_item(&self, item: Option<(&str, Option<f32>)>) {
        let (name, share) = match item {
            Some((name, share)) => (Some(SharedString::from(name.to_owned())), share),
            None => (None, None),
        };
        self.report(|progress| {
            // Another file, or none, starts afresh: its parts are its own.
            if progress.item != name {
                progress.stage = None;
                progress.stage_thousandths = None;
                progress.runs_through_pause = false;
                progress.since = name.is_some().then(Instant::now);
            }
            progress.item = name;
            progress.item_thousandths = share.map(thousandths);
        });
    }

    /// Says the part of the step under way is in-process work that runs on through a pause, such
    /// as a copy, so the job reads "Pausing" rather than "Paused" until it ends.
    pub fn set_runs_through_pause(&self, on: bool) {
        self.report(|progress| progress.runs_through_pause = on);
    }

    /// Says the work has come to rest for a pause, or goes on; see [`JobProgress::is_pausing`].
    pub fn set_paused_here(&self, here: bool) {
        self.report(|progress| progress.paused_here = here);
    }

    /// Names the part of the step on the item under way and how far it has got when it can say;
    /// see [`JobProgress::stage`]. A new part starts the clock its time left is reckoned by.
    pub fn set_stage(&self, stage: Option<(&str, Option<f32>)>) {
        let (label, share) = match stage {
            Some((label, share)) => (Some(SharedString::from(label.to_owned())), share),
            None => (None, None),
        };
        self.report(|progress| {
            if progress.stage != label {
                progress.since = Some(Instant::now());
            }
            progress.stage = label;
            progress.stage_thousandths = share.map(thousandths);
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
        if !self.pause.is_paused() {
            return self.token.check();
        }
        let _at_rest = AtRest::new(self);
        self.pause.wait_blocking(&self.token)
    }

    /// The async checkpoint: resolves once the job is not paused, or with `Err(Cancelled)` once
    /// it is cancelled.
    pub fn resumed(&self) -> impl Future<Output = Result<(), Cancelled>> + Send + 'static {
        let reporter = self.clone();
        let waiting = self.pause.resumed(&self.token);
        async move {
            // Dropped mid-wait, the future still says the work goes on.
            let _at_rest = reporter.pause.is_paused().then(|| AtRest::new(&reporter));
            waiting.await
        }
    }

    /// Says the job waits for its turn (true) or works again (false); see
    /// [`JobProgress::is_waiting`].
    pub fn set_waiting(&self, waiting: bool) {
        self.report(|progress| progress.waiting = waiting);
    }

    /// Says the job is background work (true) or work the owner asked for (false); see
    /// [`JobProgress::is_background`].
    pub fn set_background(&self, background: bool) {
        self.pause.set_background(background);
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

/// The work at rest for a pause until dropped.
struct AtRest(JobReporter);

impl AtRest {
    fn new(reporter: &JobReporter) -> Self {
        reporter.set_paused_here(true);
        Self(reporter.clone())
    }
}

impl Drop for AtRest {
    fn drop(&mut self) {
        self.0.set_paused_here(false);
    }
}

fn thousandths(share: f32) -> u16 {
    (share.clamp(0., 1.) * 1000.) as u16
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

#[cfg(test)]
mod tests {
    use super::*;

    fn encoding(share: f32, since: Instant) -> JobProgress {
        JobProgress {
            phase: "Shrinking videos".into(),
            done: 2,
            total: 5,
            item: Some("clips/holiday.mp4".into()),
            item_thousandths: Some(thousandths(share)),
            stage: Some("Encoding".into()),
            stage_thousandths: Some(thousandths(share)),
            since: Some(since),
            ..JobProgress::default()
        }
    }

    #[test]
    fn a_long_step_says_its_file_its_part_and_the_time_it_has_left() {
        let since = Instant::now();
        let job = encoding(0.25, since);
        // Too soon to tell its pace.
        assert_eq!(
            job.stage_detail(since + Duration::from_secs(1)).as_deref(),
            Some("Encoding · 25%")
        );
        assert_eq!(
            job.stage_detail(since + Duration::from_secs(60)).as_deref(),
            Some("Encoding · 25% · about 3 min left")
        );
        let row = job.activity("change-1", &"Tidy up".into());
        assert_eq!(
            row.current_item().map(|item| item.as_ref()),
            Some("holiday.mp4")
        );
        assert_eq!(row.summary(), "Shrinking videos 2 of 5");

        // A part with a share of its own says that share, and leaves the bar to the step.
        let reading = JobProgress {
            stage: Some("Reading the original".into()),
            stage_thousandths: Some(400),
            item_thousandths: None,
            ..encoding(0., since)
        };
        assert_eq!(
            reading.stage_detail(since).as_deref(),
            Some("Reading the original · 40%")
        );
        assert_eq!(
            reading.activity("change-1", &"Tidy up".into()).ratio(),
            Some(2. / 5.)
        );

        // A part with no share of its own says none: the encode's last share is not its own.
        let checking = JobProgress {
            stage: Some("Checking the result".into()),
            stage_thousandths: None,
            ..encoding(0.98, since)
        };
        assert_eq!(
            checking
                .stage_detail(since + Duration::from_secs(60))
                .as_deref(),
            Some("Checking the result")
        );
    }

    #[test]
    fn time_left_is_rounded_as_a_guess_is() {
        assert_eq!(time_left(Duration::from_secs(3)), "about 10 s left");
        assert_eq!(time_left(Duration::from_secs(41)), "about 50 s left");
        assert_eq!(time_left(Duration::from_secs(150)), "about 3 min left");
        assert_eq!(time_left(Duration::from_secs(3_545)), "about 1 h left");
        assert_eq!(time_left(Duration::from_secs(3_600)), "about 1 h left");
        assert_eq!(
            time_left(Duration::from_secs(4_810)),
            "about 1 h 21 min left"
        );
    }

    #[test]
    fn paused_work_says_pausing_until_it_has_come_to_rest() {
        let since = Instant::now();
        let name: SharedString = "Tidy up".into();
        // Background work's tools finish their file.
        let background = JobProgress {
            paused: true,
            background: true,
            ..encoding(0.5, since)
        };
        let row = background.activity("analysis-1", &name);
        assert_eq!(row.job_state(), JobState::Running);
        assert_eq!(row.caption(), "Pausing after this file · 50%");

        // Work with no file named, such as stills, until it reaches its checkpoint.
        let stills = JobProgress {
            paused: true,
            item: None,
            item_thousandths: None,
            stage: None,
            ..encoding(0., since)
        };
        assert_eq!(
            stills.activity("change-1", &name).caption(),
            "Pausing once the work in hand is done"
        );
        let at_rest = JobProgress {
            paused_here: true,
            ..stills
        };
        assert_eq!(
            at_rest.activity("change-1", &name).job_state(),
            JobState::Paused
        );
    }

    #[test]
    fn a_stopped_job_says_it_is_stopping_and_offers_no_controls() {
        let job = JobProgress {
            stopping: true,
            ..encoding(0.5, Instant::now())
        };
        let row = job.activity("change-1", &"Tidy up".into());
        assert_eq!(row.job_state(), JobState::Running);
        assert_eq!(row.caption(), "Stopping… what is done stays done");
        assert_eq!(row, row.clone().pausable(false).stoppable(false));
    }
}
