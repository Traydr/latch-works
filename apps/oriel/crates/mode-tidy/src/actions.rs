//! Changes as the owner makes them, after Electron Oriel's `lib/actions.tsx`: a change runs as a
//! job through [`crate::changes::TidyChanges`], is reported in a toast that offers Undo, and goes
//! on ⌘Z's history. Tidy up runs several plans one after another as one change with one Undo.
//!
//! One change runs at a time. A change asked for while another runs waits in Tidy's queue, which
//! the activity panel at the window's bottom right lists as queued, and starts when the one before
//! it has been reported; Stop in the panel takes it off the queue.
//!
//! While a change runs the shell shows its ring and quitting waits for it; the catalog's version
//! moves when it ends, so every page reads again, and the roots the change asks to scan or
//! analyse again are.

use std::cell::RefCell;
use std::rc::Rc;
use std::time::{Duration, Instant};

use futures::channel::oneshot;
use gpui_kit::{
    App, AsyncWindowContext, Context, Entity, SharedString, Subscription, Task, WeakEntity, Window,
};
use oriel_core_tidy::contract::{AudioState, FileFilter, FileKind, RootId};
use oriel_core_tidy::plans::planner::PlanRequestError;
use oriel_runtime::{Job, JobError, JobEvent, JobProgress, JobStatus};
use oriel_ui::{Toast, ToastExt as _};

use crate::changes::{
    Applied, FollowUp, PlanId, PlanKind, PlanListRequest, PlanPreview, PlanRequest, PlanStatus,
    PlanSummary, Undone, can_undo, is_not_yet, job_error,
};
use crate::format;
use crate::state::TidyState;
use crate::widgets::show_toast;

/// The most entries ⌘Z remembers, as Electron Oriel's history keeps 50.
const UNDO_LIMIT: usize = 50;

/// How often the pages read again while a change runs.
const READ_AGAIN_WHILE_CHANGING: Duration = Duration::from_secs(2);

/// Runs once a change is undone, however that happens (its toast's Undo, ⌘Z), to show it again.
pub type OnUndone = Rc<dyn Fn(&mut Window, &mut App)>;

/// What the last Tidy up did, as its own plans measured it.
pub struct Tidied {
    pub root_id: RootId,
    /// The bytes the folder lost, which wait in holding until it is emptied.
    pub saved: i64,
    pub plan_ids: Vec<PlanId>,
}

/// The file a running change is on.
pub struct RunningFile {
    pub rel_path: String,
    pub name: String,
    pub share: Option<f32>,
    /// The owner paused the change and the tool has stopped where it is.
    pub paused: bool,
    /// The owner paused the change and the tool, which cannot be stopped, works on to the file's end.
    pub pausing: bool,
}

/// Runs with a finished plan.
pub type OnDone = Rc<dyn Fn(&PlanSummary, &mut Window, &mut App)>;

type UndoRun = Rc<dyn Fn(&mut TidyState, &mut Window, &mut Context<TidyState>)>;

/// Something the owner did that ⌘Z can take back.
#[derive(Clone)]
pub struct UndoEntry {
    /// The plans it reverses, so undoing one of them another way drops the entry.
    plan_ids: Vec<PlanId>,
    run: UndoRun,
}

/// How a change reports itself.
#[derive(Clone, Default)]
pub struct PerformOptions {
    /// Ties the result to a place in the UI, such as an Overview row, so it can show it.
    pub source: Option<SharedString>,
    /// No toast unless something failed: the page shows the result itself, as the duplicate
    /// queue does. An undo of it is quiet too.
    pub quiet: bool,
    pub on_undone: Option<OnUndone>,
    /// What an undo calls the change, where its own toast called it something plainer than the
    /// plan's title: "Kept 1 of 4".
    pub undo_name: Option<String>,
    /// Runs with the finished plan, before its toast, for a page that shows the result itself.
    pub on_done: Option<OnDone>,
    /// Runs when nothing ran: the change failed, was stopped, or is not available.
    pub on_failed: Option<OnUndone>,
}

impl PerformOptions {
    pub fn from(source: &'static str) -> Self {
        Self {
            source: Some(source.into()),
            ..Self::default()
        }
    }
}

/// One step of Tidy up: a request known before the run, or the silent videos listed once the
/// steps before have run.
#[derive(Clone, Debug)]
pub enum TidyStep {
    Planned(PlanRequest),
    SilentVideos(RootId),
}

enum ChangeJob {
    Perform(Entity<Job<Applied>>),
    Undo(Entity<Job<Undone>>),
}

/// The change running now: drafting while it has no job yet, then applying or undoing.
pub struct RunningChange {
    pub source: Option<SharedString>,
    /// What the plan running does; `None` for an undo.
    pub kind: Option<PlanKind>,
    job: Option<ChangeJob>,
    /// Stop was pressed while the plan was drafted, before there was a job to stop.
    stop_asked: bool,
    _subscriptions: Vec<Subscription>,
}

/// Where the change a page started is.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ChangeStatus {
    Running,
    /// Waiting in the queue for the change before it to finish.
    Queued,
}

type StartChange = Box<dyn FnOnce(&mut TidyState, &mut Window, &mut Context<TidyState>)>;

/// A change asked for while another held the turn: it starts when its turn comes, unless Stop
/// takes it off the queue first.
pub struct QueuedChange {
    pub(crate) id: u64,
    /// What the activity panel calls it until it runs, such as "Convert".
    pub label: SharedString,
    pub source: Option<SharedString>,
    start: StartChange,
    /// Runs if it leaves the queue without running, as `PerformOptions::on_failed` does.
    on_dropped: Option<OnUndone>,
    /// It is an Undo, which adds no new change to ⌘Z's history; one that stops puts its own back.
    undoes: bool,
}

/// What asks for the changes' turn: a change, which may add to ⌘Z's history, with what runs if it
/// leaves the queue without running; or an Undo.
enum Turn {
    Change(Option<OnUndone>),
    Undo,
}

/// What a queued change is called before its plan names it.
fn queued_label(kind: PlanKind) -> &'static str {
    match kind {
        PlanKind::Hold => "Move to holding",
        PlanKind::Move => "Move files",
        PlanKind::Rename => "Rename",
        PlanKind::FixExtension => "Fix extensions",
        PlanKind::Optimize => "Convert",
        PlanKind::Reencode => "Re-encode videos",
        PlanKind::StripAudio => "Remove silent soundtracks",
        PlanKind::ResolveDuplicates => "Resolve duplicates",
        PlanKind::CleanJunk => "Clean junk",
        PlanKind::RemoveEmptyFolders => "Remove empty folders",
        PlanKind::Cleanup => "Clean up",
        PlanKind::ShrinkVideos => "Shrink videos",
    }
}

impl RunningChange {
    /// Whether its plan is drafted and its job runs, so it can be paused.
    pub fn has_job(&self) -> bool {
        self.job.is_some()
    }

    pub fn progress(&self, cx: &App) -> JobProgress {
        match &self.job {
            Some(ChangeJob::Perform(job)) => job.read(cx).progress().clone(),
            Some(ChangeJob::Undo(job)) => job.read(cx).progress().clone(),
            None => JobProgress::default(),
        }
    }

    pub fn name(&self, cx: &App) -> SharedString {
        match &self.job {
            Some(ChangeJob::Perform(job)) => job.read(cx).name().clone(),
            Some(ChangeJob::Undo(job)) => job.read(cx).name().clone(),
            None => "Starting".into(),
        }
    }

    pub fn fraction(&self, cx: &App) -> f32 {
        self.progress(cx).fraction().unwrap_or(0.)
    }

    pub fn cancel(&self, cx: &mut App) {
        match &self.job {
            Some(ChangeJob::Perform(job)) => job.update(cx, |job, cx| job.cancel(cx)),
            Some(ChangeJob::Undo(job)) => job.update(cx, |job, cx| job.cancel(cx)),
            None => {}
        }
    }

    /// Pauses or resumes the change at its next step (`pauseJob`).
    pub fn set_paused(&self, paused: bool, cx: &mut App) {
        match &self.job {
            Some(ChangeJob::Perform(job)) => job.update(cx, |job, cx| job.set_paused(paused, cx)),
            Some(ChangeJob::Undo(job)) => job.update(cx, |job, cx| job.set_paused(paused, cx)),
            None => {}
        }
    }
}

/// What a finished job left: its value, or why there is none.
type Finished<T> = Result<T, JobError>;

/// A change that did not finish: why, and its plan when its job ran and failed part way, having
/// perhaps done some of its steps, which Undo takes back (`job.state === "failed"`).
struct Unfinished {
    error: JobError,
    plan: Option<PlanSummary>,
}

impl From<JobError> for Unfinished {
    fn from(error: JobError) -> Self {
        Self { error, plan: None }
    }
}

/// A channel that answers once `job` finishes, and the subscription that feeds it. A job that has
/// already finished answers at once: its event has gone, and a quick change can finish before the
/// task that started it comes back here.
fn when_finished<T: Clone + Send + 'static>(
    job: &Entity<Job<T>>,
    cx: &mut App,
) -> (oneshot::Receiver<Finished<T>>, Subscription) {
    let (sender, receiver) = oneshot::channel();
    let finished = match job.read(cx).status() {
        JobStatus::Running => None,
        JobStatus::Succeeded(value) => Some(Ok(value.clone())),
        JobStatus::Failed(error) => Some(Err(error.clone())),
    };
    let sender = match finished {
        Some(outcome) => {
            let _ = sender.send(outcome);
            None
        }
        None => Some(sender),
    };
    let sender = RefCell::new(sender);
    let subscription = cx.subscribe(job, move |job, event: &JobEvent, cx| {
        let outcome = match event {
            JobEvent::Succeeded => match job.read(cx).value() {
                Some(value) => Ok(value.clone()),
                None => Err(JobError::Cancelled),
            },
            JobEvent::Failed(error) => Err(error.clone()),
        };
        if let Some(sender) = sender.borrow_mut().take() {
            let _ = sender.send(outcome);
        }
    });
    (receiver, subscription)
}

fn job_message(error: &JobError) -> String {
    match error {
        JobError::Cancelled => "Stopped".into(),
        JobError::Failed(error) => format!("{error:#}"),
    }
}

/// Why the engine would not draft a change, in its own words, such as a file at hand that has gone
/// since it was chosen.
fn refusal(error: &JobError) -> Option<String> {
    let JobError::Failed(error) = error else {
        return None;
    };
    error
        .chain()
        .find_map(|cause| cause.downcast_ref::<PlanRequestError>())
        .map(ToString::to_string)
}

fn is_not_available(error: &JobError) -> bool {
    matches!(error, JobError::Failed(error) if is_not_yet(error))
}

/// The numbers under a plan's title: what it saved or held, and what it left out
/// (`describePlan`).
pub fn describe_plan(plan: &PlanSummary) -> String {
    let conversion = matches!(
        plan.kind,
        PlanKind::Optimize | PlanKind::Reencode | PlanKind::StripAudio
    );
    let mut parts = Vec::new();
    if conversion && plan.bytes_before > 0 {
        parts.push(format!(
            "{} → {}",
            format::bytes(plan.bytes_before as f64),
            format::bytes(plan.bytes_after as f64)
        ));
    } else if plan.held.files > 0 {
        parts.push(format!(
            "{} to holding · {}",
            format::plural(plan.held.files, "file"),
            format::bytes(plan.held.bytes as f64)
        ));
    }
    if plan.skipped > 0 {
        parts.push(if conversion {
            format!("{} kept as is", plan.skipped)
        } else {
            format!("{} skipped", plan.skipped)
        });
    }
    if plan.failed > 0 {
        parts.push(format!("{} failed", plan.failed));
    }
    if plan.undone > 0 {
        parts.push(if plan.status == PlanStatus::Undone {
            "undone".into()
        } else {
            format!("{} undone", plan.undone)
        });
    }
    parts.join(" · ")
}

impl TidyState {
    /// The file the running change is on, if it says, for its tile to show: what it is doing, how
    /// far it has got, and whether it is paused.
    pub fn running_file(&self, cx: &App) -> Option<RunningFile> {
        let progress = self.change.as_ref()?.progress(cx);
        Some(RunningFile {
            rel_path: progress.item()?.to_string(),
            name: progress
                .item()?
                .rsplit('/')
                .next()
                .unwrap_or_default()
                .to_owned(),
            share: progress.item_share(),
            paused: progress.is_paused() && oriel_tools::tools_suspend(),
            pausing: progress.is_paused() && !oriel_tools::tools_suspend(),
        })
    }

    /// The running change started from `source`, if any (`jobFor`).
    pub fn change_for(&self, source: &str) -> Option<&RunningChange> {
        self.change
            .as_ref()
            .filter(|change| change.source.as_deref() == Some(source))
    }

    /// The newest finished plan started from `source` this session (`resultFor`).
    pub fn result_for(&self, source: &str) -> Option<&PlanSummary> {
        self.results.get(source)
    }

    /// Whether a change runs, or holds the turn between the steps of one; another waits in the
    /// queue.
    pub fn is_changing(&self) -> bool {
        self.change_turn || self.change.is_some()
    }

    /// Stops the change running; finished steps stay done and can be undone. A change still
    /// drafting its plan stops as soon as its job starts.
    pub fn stop_change(&mut self, cx: &mut Context<Self>) {
        if let Some(change) = &mut self.change {
            change.stop_asked = true;
            change.cancel(cx);
        }
    }

    /// Where the change started from `source` is: running, or queued behind another.
    pub fn change_status(&self, source: &str) -> Option<ChangeStatus> {
        if self.change_for(source).is_some() {
            return Some(ChangeStatus::Running);
        }
        self.queue
            .iter()
            .any(|queued| queued.source.as_deref() == Some(source))
            .then_some(ChangeStatus::Queued)
    }

    /// Starts a change at once when none holds the turn, else queues it behind the others.
    fn when_free(
        &mut self,
        label: impl Into<SharedString>,
        source: Option<SharedString>,
        turn: Turn,
        start: impl FnOnce(&mut TidyState, &mut Window, &mut Context<TidyState>) + 'static,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.say_if_waiting_on_paused_work(window, cx);
        let (undoes, on_dropped) = match turn {
            Turn::Change(on_dropped) => (false, on_dropped),
            Turn::Undo => (true, None),
        };
        if !self.change_turn {
            self.change_turn = true;
            self.turn_undoes = undoes;
            start(self, window, cx);
            return;
        }
        let id = self.next_queued;
        self.next_queued += 1;
        self.queue.push_back(QueuedChange {
            id,
            label: label.into(),
            source,
            start: Box::new(start),
            on_dropped,
            undoes,
        });
        self.report_activity(cx);
        cx.notify();
    }

    /// Whether a change runs, or waits to. Its Undo may need what is in holding, so holding stays
    /// until it has ended.
    pub(crate) fn holding_may_be_needed(&self) -> bool {
        self.change_turn || !self.queue.is_empty()
    }

    /// The change holding the turn has been reported: the next in the queue starts.
    fn release_turn(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.change_turn = false;
        if let Some(next) = self.queue.pop_front() {
            self.change_turn = true;
            self.turn_undoes = next.undoes;
            (next.start)(self, window, cx);
        }
        self.report_activity(cx);
        cx.notify();
    }

    /// Takes the queued change `id` off the queue without running it.
    pub(crate) fn drop_queued(&mut self, id: u64, window: &mut Window, cx: &mut Context<Self>) {
        let Some(index) = self.queue.iter().position(|queued| queued.id == id) else {
            return;
        };
        if let Some(queued) = self.queue.remove(index)
            && let Some(on_dropped) = queued.on_dropped
        {
            window.defer(cx, move |window, cx| on_dropped(window, cx));
        }
        self.report_activity(cx);
        cx.notify();
    }

    /// Drafts and applies `request`, tracking it as the running change; answers with the draft
    /// and what applying it did, once it is done.
    fn start_perform(
        &mut self,
        request: PlanRequest,
        source: Option<SharedString>,
        cx: &mut Context<Self>,
    ) -> Task<Result<(PlanPreview, Applied), Unfinished>> {
        let Some(engine) = self.engine().cloned() else {
            return Task::ready(Err(job_error(anyhow::anyhow!(
                "Tidy's catalog is not open"
            ))
            .into()));
        };
        let kind = request.kind();
        let performing = self.changes.perform(&engine, request, cx);
        self.change = Some(RunningChange {
            source,
            kind: Some(kind),
            job: None,
            stop_asked: false,
            _subscriptions: Vec::new(),
        });
        self.report_activity(cx);
        cx.notify();
        cx.spawn(async move |this, cx| {
            let (preview, job) = performing.await.map_err(job_error)?;
            let finished = this
                .update(cx, |this, cx| {
                    let (finished, subscription) = when_finished(&job, cx);
                    let mut read_at = Instant::now();
                    let observing = cx.observe(&job, move |this, job, cx| {
                        // Files change step by step, and a long run must not leave the pages
                        // showing ones that have gone until it ends.
                        if job.read(cx).progress().done() > 0
                            && read_at.elapsed() >= READ_AGAIN_WHILE_CHANGING
                        {
                            read_at = Instant::now();
                            this.changed(cx);
                        }
                        this.report_activity(cx);
                        cx.notify();
                    });
                    if let Some(change) = &mut this.change {
                        change.job = Some(ChangeJob::Perform(job));
                        change._subscriptions = vec![subscription, observing];
                        if change.stop_asked {
                            change.cancel(cx);
                        }
                    }
                    // The job may have said it waits for its turn before anything observed it, and
                    // behind a paused scan it says nothing more.
                    this.report_activity(cx);
                    finished
                })
                .map_err(job_error)?;
            match finished.await.unwrap_or(Err(JobError::Cancelled)) {
                Ok(applied) => Ok((preview, applied)),
                Err(error @ JobError::Failed(_)) => {
                    let plan = this
                        .update(cx, |this, _| {
                            let engine = this.engine().cloned()?;
                            Some(this.changes.get_plan(&engine, preview.plan_id))
                        })
                        .ok()
                        .flatten();
                    let plan = match plan {
                        Some(plan) => plan.await.ok(),
                        None => None,
                    };
                    Err(Unfinished { error, plan })
                }
                Err(error) => Err(error.into()),
            }
        })
    }

    fn start_undo(&mut self, plan_id: PlanId, cx: &mut Context<Self>) -> Task<Finished<Undone>> {
        let Some(engine) = self.engine().cloned() else {
            return Task::ready(Err(job_error(anyhow::anyhow!(
                "Tidy's catalog is not open"
            ))));
        };
        let job = self.changes.undo_plan(&engine, plan_id, cx);
        let (finished, subscription) = when_finished(&job, cx);
        let observing = cx.observe(&job, |this, _, cx| {
            this.report_activity(cx);
            cx.notify();
        });
        self.change = Some(RunningChange {
            source: None,
            kind: None,
            job: Some(ChangeJob::Undo(job)),
            stop_asked: false,
            _subscriptions: vec![subscription, observing],
        });
        self.report_activity(cx);
        cx.notify();
        cx.spawn(async move |_, _| finished.await.unwrap_or(Err(JobError::Cancelled)))
    }

    /// The running change ended: the catalog may have changed.
    fn change_ended(&mut self, cx: &mut Context<Self>) {
        self.change = None;
        self.forget_held_sets();
        self.report_activity(cx);
        self.changed(cx);
        self.reload_roots(cx);
    }

    /// Scans or analyses again the roots a change asks for.
    fn follow_up(&mut self, follow_up: &FollowUp, window: &mut Window, cx: &mut Context<Self>) {
        for root_id in &follow_up.rescan {
            self.rescan_after_change(*root_id, window, cx);
        }
        // A scan's end sees to the analysis of its root.
        for root_id in &follow_up.analyze {
            if !follow_up.rescan.contains(root_id) {
                self.start_background_analysis(*root_id, window, cx);
            }
        }
    }

    /// Runs a plan, at once or after the changes queued before it, and reports it with a toast
    /// that offers Undo (`perform`). What the plan left out is in the toast's detail.
    pub fn perform(
        &mut self,
        request: PlanRequest,
        options: PerformOptions,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let label = queued_label(request.kind());
        let (source, on_dropped) = (options.source.clone(), options.on_failed.clone());
        self.when_free(
            label,
            source,
            Turn::Change(on_dropped),
            move |this, window, cx| this.perform_now(request, options, window, cx),
            window,
            cx,
        );
    }

    fn perform_now(
        &mut self,
        request: PlanRequest,
        options: PerformOptions,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let finished = self.start_perform(request, options.source.clone(), cx);
        cx.spawn_in(window, async move |this, cx| {
            let outcome = finished.await;
            this.update_in(cx, |this, window, cx| {
                this.change_ended(cx);
                this.announce(outcome, &options, window, cx);
                this.release_turn(window, cx);
            })
            .ok();
        })
        .detach();
    }

    fn announce(
        &mut self,
        outcome: Result<(PlanPreview, Applied), Unfinished>,
        options: &PerformOptions,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let (preview, applied) = match outcome {
            Ok(outcome) => outcome,
            Err(Unfinished { error, plan }) => {
                // After this update, so the page may read the state.
                if let Some(on_failed) = options.on_failed.clone() {
                    window.defer(cx, move |window, cx| on_failed(window, cx));
                }
                let toast = match (error, plan) {
                    (JobError::Cancelled, _) => Toast::info("Stopped"),
                    (error, Some(plan)) => self.failed_toast(plan, &error, options, cx),
                    (error, None) => match refusal(&error) {
                        Some(reason) => Toast::error(reason),
                        None => Toast::error("That didn't work").detail(job_message(&error)),
                    },
                };
                show_toast(window, toast, cx);
                return;
            }
        };
        self.follow_up(&applied.follow_up, window, cx);
        let plan = applied.plan;
        if let Some(on_done) = options.on_done.clone() {
            let plan = plan.clone();
            window.defer(cx, move |window, cx| on_done(&plan, window, cx));
        }
        if let Some(source) = &options.source {
            self.results.insert(source.clone(), plan.clone());
        }
        let undoable = can_undo(&plan);
        if undoable {
            let entry_plan = plan.clone();
            // ⌘Z says what it undid, even where the toast's own Undo needs no words.
            let entry_options = PerformOptions {
                quiet: false,
                ..options.clone()
            };
            self.push_entry(UndoEntry {
                plan_ids: vec![plan.id],
                run: Rc::new(move |this, window, cx| {
                    this.undo_plan(entry_plan.clone(), entry_options.clone(), window, cx);
                }),
            });
        }
        if options.quiet && plan.failed == 0 {
            return;
        }
        let detail: Vec<String> = std::iter::once(describe_plan(&plan))
            .chain(preview.warnings.iter().cloned())
            .filter(|part| !part.is_empty())
            .collect();
        // A stopped change says how far it got; its finished steps stay done and can be undone.
        let message = if plan.status == PlanStatus::Cancelled {
            format!(
                "Stopped after {} of {}",
                format::count(plan.done),
                format::count(plan.steps)
            )
        } else {
            plan.title.clone()
        };
        let mut toast = if plan.failed > 0 {
            Toast::error(message)
        } else if plan.done == 0 {
            // A check mark would say it worked.
            Toast::info(message)
        } else {
            Toast::done(message)
        };
        if !detail.is_empty() {
            toast = toast.detail(detail.join(" · "));
        }
        if undoable {
            toast = self.undo_action(toast, plan, options.clone(), cx);
        }
        show_toast(window, toast, cx);
    }

    /// A change whose job failed part way: "‹title›, with errors", with what went wrong and an
    /// Undo for the steps it did, which ⌘Z takes back too (`announce`).
    fn failed_toast(
        &mut self,
        plan: PlanSummary,
        error: &JobError,
        options: &PerformOptions,
        cx: &mut Context<Self>,
    ) -> Toast {
        if let Some(source) = &options.source {
            self.results.insert(source.clone(), plan.clone());
        }
        let toast = Toast::error(format!("{}, with errors", plan.title)).detail(job_message(error));
        if !can_undo(&plan) {
            return toast;
        }
        let (entry_plan, entry_options) = (plan.clone(), options.clone());
        self.push_entry(UndoEntry {
            plan_ids: vec![plan.id],
            run: Rc::new(move |this, window, cx| {
                this.undo_plan(entry_plan.clone(), entry_options.clone(), window, cx);
            }),
        });
        self.undo_action(toast, plan, options.clone(), cx)
    }

    /// A toast's Undo for `plan`.
    fn undo_action(
        &self,
        toast: Toast,
        plan: PlanSummary,
        options: PerformOptions,
        cx: &mut Context<Self>,
    ) -> Toast {
        let this = cx.entity().downgrade();
        toast.action("Undo", move |window, cx| {
            let (plan, options) = (plan.clone(), options.clone());
            this.update(cx, |this, cx| this.undo_plan(plan, options, window, cx))
                .ok();
        })
    }

    /// Undoes a plan, at once or after the changes queued before it, says so unless
    /// `options.quiet`, and runs `options.on_undone` once it is.
    pub fn undo_plan(
        &mut self,
        plan: PlanSummary,
        options: PerformOptions,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        // A toast still offering Undo for this would be out of date at once.
        window.dismiss_toast(cx);
        let label = format!("Undo “{}”", plan.title);
        self.when_free(
            label,
            None,
            Turn::Undo,
            move |this, window, cx| this.undo_plan_now(plan, options, window, cx),
            window,
            cx,
        );
    }

    fn undo_plan_now(
        &mut self,
        plan: PlanSummary,
        options: PerformOptions,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.forget_plans(&[plan.id]);
        // What did not finish is still the next Undo, not the plan before it.
        let unfinished = {
            let (plan, options) = (plan.clone(), options.clone());
            UndoEntry {
                plan_ids: vec![plan.id],
                run: Rc::new(move |this, window, cx| {
                    this.undo_plan(plan.clone(), options.clone(), window, cx);
                }),
            }
        };
        let finished = self.start_undo(plan.id, cx);
        cx.spawn_in(window, async move |this, cx| {
            let outcome = finished.await;
            this.update_in(cx, |this, window, cx| {
                this.change_ended(cx);
                match outcome {
                    Ok(undone) if undone.complete => {
                        this.follow_up(&undone.follow_up, window, cx);
                        if let Some(on_undone) = options.on_undone.clone() {
                            window.defer(cx, move |window, cx| on_undone(window, cx));
                        }
                        if !options.quiet {
                            let name = options.undo_name.as_ref().unwrap_or(&plan.title);
                            let toast = Toast::info(format!("Undid “{name}”"));
                            show_toast(window, toast, cx);
                        }
                    }
                    Ok(undone) => {
                        this.return_entry(unfinished);
                        // The steps that did come back have changed under the catalog.
                        this.follow_up(&undone.follow_up, window, cx);
                        show_toast(
                            window,
                            Toast::error("Undo did not finish")
                                .detail(undone.message.unwrap_or_default()),
                            cx,
                        );
                    }
                    // Stopped before its turn came: nothing was touched.
                    Err(error) if error.is_cancelled() => {
                        this.return_entry(unfinished);
                        let toast = Toast::info("Undo stopped").detail("Undo again to finish it.");
                        show_toast(window, toast, cx);
                    }
                    Err(error) => {
                        this.return_entry(unfinished);
                        show_toast(
                            window,
                            Toast::error("Undo failed").detail(job_message(&error)),
                            cx,
                        );
                    }
                }
                this.release_turn(window, cx);
            })
            .ok();
        })
        .detach();
    }

    /// Runs Tidy up's steps one after another, each drafted once the one before has finished, and
    /// reports them as one change with one Undo (`performAll`). A step that turns out to have
    /// nothing to do is skipped.
    /// `label` names it in the activity panel while it waits ("Tidy up"); `title` reports it.
    pub fn perform_all(
        &mut self,
        label: &'static str,
        steps: Vec<TidyStep>,
        title: String,
        source: &'static str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.when_free(
            label,
            Some(source.into()),
            Turn::Change(None),
            move |this, window, cx| this.perform_all_now(steps, title, source, window, cx),
            window,
            cx,
        );
    }

    fn perform_all_now(
        &mut self,
        steps: Vec<TidyStep>,
        title: String,
        source: &'static str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let this = cx.entity().downgrade();
        cx.spawn_in(window, async move |_, cx| {
            let (plans, notes, follow_up) = run_steps(&this, steps, source, cx).await;
            this.update_in(cx, |this, window, cx| {
                this.follow_up(&follow_up, window, cx);
                this.announce_all(plans, notes, title, source, window, cx);
                this.release_turn(window, cx);
            })
            .ok();
        })
        .detach();
    }

    fn announce_all(
        &mut self,
        plans: Vec<PlanSummary>,
        notes: Vec<String>,
        title: String,
        source: &'static str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if let Some(last) = plans.last() {
            self.results.insert(source.into(), last.clone());
        }
        let undoable: Vec<PlanSummary> = plans
            .iter()
            .filter(|plan| can_undo(plan))
            .cloned()
            .collect();
        let held: i64 = plans.iter().map(|plan| plan.held.bytes).sum();
        let before: i64 = plans.iter().map(|plan| plan.bytes_before).sum();
        let after: i64 = plans.iter().map(|plan| plan.bytes_after).sum();
        let mut summary = Vec::new();
        if before > after {
            summary.push(format!("{} out", format::bytes((before - after) as f64)));
        }
        // What Tidy up itself measured, for Overview to go on saying once the toast has gone.
        if source == crate::overview::TIDY_SOURCE {
            self.tidied = self.root_id().map(|root_id| Tidied {
                root_id,
                saved: (before - after).max(0),
                plan_ids: plans.iter().map(|plan| plan.id).collect(),
            });
        }
        if held > 0 {
            summary.push(format!("{} in holding", format::bytes(held as f64)));
        }
        summary.extend(notes.iter().cloned());

        let undo_all: UndoRun = {
            let (undoable, title) = (undoable.clone(), title.clone());
            Rc::new(move |this, window, cx| {
                this.undo_all(undoable.clone(), title.clone(), window, cx);
            })
        };
        if !undoable.is_empty() {
            self.push_entry(UndoEntry {
                plan_ids: undoable.iter().map(|plan| plan.id).collect(),
                run: undo_all.clone(),
            });
        }
        let message = if plans.is_empty() && notes.is_empty() {
            "Nothing to tidy".to_string()
        } else if plans.is_empty() {
            "That didn't work".to_string()
        } else if before > after {
            format!("{title} · {}", format::bytes((before - after) as f64))
        } else {
            title
        };
        let mut toast = if !notes.is_empty() {
            Toast::error(message)
        } else if plans.is_empty() {
            Toast::info(message)
        } else {
            Toast::done(message)
        };
        if !summary.is_empty() {
            toast = toast.detail(summary.join(" · "));
        }
        if !undoable.is_empty() {
            let this = cx.entity().downgrade();
            toast = toast.action("Undo", move |window, cx| {
                let run = undo_all.clone();
                this.update(cx, |this, cx| run(this, window, cx)).ok();
            });
        }
        show_toast(window, toast, cx);
    }

    /// Undoes plans newest first, as one Undo.
    pub(crate) fn undo_all(
        &mut self,
        plans: Vec<PlanSummary>,
        title: String,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let label = format!("Undo “{title}”");
        self.when_free(
            label,
            None,
            Turn::Undo,
            move |this, window, cx| this.undo_all_now(plans, title, window, cx),
            window,
            cx,
        );
    }

    fn undo_all_now(
        &mut self,
        plans: Vec<PlanSummary>,
        title: String,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let ids: Vec<PlanId> = plans.iter().map(|plan| plan.id).collect();
        self.forget_plans(&ids);
        // What did not finish is still the next Undo, not the change before it.
        let unfinished = {
            let (plans, title) = (plans.clone(), title.clone());
            UndoEntry {
                plan_ids: ids,
                run: Rc::new(move |this, window, cx| {
                    this.undo_all(plans.clone(), title.clone(), window, cx);
                }),
            }
        };
        let this = cx.entity().downgrade();
        cx.spawn_in(window, async move |_, cx| {
            let mut failure = None;
            let mut stopped = false;
            let mut follow_up = FollowUp::default();
            for plan in plans.iter().rev() {
                let Ok(finished) = this.update(cx, |this, cx| this.start_undo(plan.id, cx)) else {
                    return;
                };
                let outcome = finished.await;
                this.update(cx, |this, cx| this.change_ended(cx)).ok();
                match outcome {
                    Ok(undone) if undone.complete => {
                        follow_up.rescan.extend(undone.follow_up.rescan);
                        follow_up.analyze.extend(undone.follow_up.analyze);
                    }
                    Ok(undone) => {
                        // The steps that did come back have changed under the catalog.
                        follow_up.rescan.extend(undone.follow_up.rescan);
                        follow_up.analyze.extend(undone.follow_up.analyze);
                        failure = Some(undone.message.unwrap_or_default());
                        break;
                    }
                    Err(error) if error.is_cancelled() => {
                        stopped = true;
                        break;
                    }
                    Err(error) => {
                        failure = Some(job_message(&error));
                        break;
                    }
                }
            }
            this.update_in(cx, |this, window, cx| {
                this.follow_up(&follow_up, window, cx);
                let toast = match failure {
                    None if stopped => {
                        this.return_entry(unfinished);
                        Toast::info("Undo stopped").detail("Undo again to finish it.")
                    }
                    None => Toast::info(format!("Undid “{title}”")),
                    Some(message) => {
                        this.return_entry(unfinished);
                        Toast::error("Undo did not finish").detail(message)
                    }
                };
                show_toast(window, toast, cx);
                this.release_turn(window, cx);
            })
            .ok();
        })
        .detach();
    }

    fn push_entry(&mut self, entry: UndoEntry) {
        self.undo_pushed += 1;
        self.keep_entry(entry);
    }

    /// Puts back the entry of an Undo that stopped or did not finish: it is still the next Undo,
    /// though no new change has landed.
    fn return_entry(&mut self, entry: UndoEntry) {
        self.undo_returned += 1;
        self.keep_entry(entry);
    }

    fn keep_entry(&mut self, entry: UndoEntry) {
        if self.undo.len() >= UNDO_LIMIT {
            self.undo.remove(0);
        }
        self.undo.push(entry);
    }

    /// Adds a change that is not a plan (a dismissal, a preferred folder) to ⌘Z's history.
    /// Returns its number, for [`Self::drop_undo`] when it is undone some other way.
    pub fn push_undo(
        &mut self,
        run: impl Fn(&mut TidyState, &mut Window, &mut Context<TidyState>) + 'static,
    ) -> usize {
        let run: UndoRun = Rc::new(run);
        let key = Rc::as_ptr(&run) as *const () as usize;
        self.push_entry(UndoEntry {
            plan_ids: Vec::new(),
            run,
        });
        key
    }

    /// Takes an entry [`Self::push_undo`] added off ⌘Z's history.
    pub fn drop_undo(&mut self, key: usize) {
        self.undo
            .retain(|entry| Rc::as_ptr(&entry.run) as *const () as usize != key);
    }

    fn forget_plans(&mut self, plan_ids: &[PlanId]) {
        self.undo
            .retain(|entry| !entry.plan_ids.iter().any(|id| plan_ids.contains(id)));
        self.results.retain(|_, plan| !plan_ids.contains(&plan.id));
        // Taken back, so no longer saved.
        if self
            .tidied
            .as_ref()
            .is_some_and(|tidied| tidied.plan_ids.iter().any(|id| plan_ids.contains(id)))
        {
            self.tidied = None;
        }
    }

    /// ⌘Z: the newest change of this session, else the newest undoable plan in the journal.
    ///
    /// While a change runs or waits, the newest change is that one, which is not yet on the list:
    /// answering now would undo something older than the owner meant. So this waits its turn behind
    /// it, and then undoes only what has landed since, never reaching back into the journal. Behind
    /// Undos alone the newest change is already on the list, so it undoes that, as a second ⌘Z
    /// means. Behind an Undo that stopped or did not finish it undoes nothing: that Undo said so,
    /// and is still the next.
    pub fn undo_last(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        // What is on screen may be the Undo this answers; the result says what happened.
        window.dismiss_toast(cx);
        if self.undo_entries_coming > 0 {
            cx.spawn_in(window, async move |this, cx| {
                cx.background_executor()
                    .timer(Duration::from_millis(50))
                    .await;
                this.update_in(cx, |this, window, cx| this.undo_last(window, cx))
                    .ok();
            })
            .detach();
            return;
        }
        if self.holding_may_be_needed() {
            let pushed_before = self.undo_pushed;
            let returned_before = self.undo_returned;
            let behind_a_change = (self.change_turn && !self.turn_undoes)
                || self.queue.iter().any(|queued| !queued.undoes);
            self.when_free(
                "Undo the last change",
                None,
                Turn::Undo,
                move |this, window, cx| {
                    // The turn was kept for this; what it runs asks for the turn itself.
                    this.change_turn = false;
                    let landed = this.undo_pushed != pushed_before;
                    let returned = this.undo_returned != returned_before;
                    let next = if !returned && (landed || !behind_a_change) {
                        this.undo.pop()
                    } else {
                        None
                    };
                    match next {
                        Some(entry) => (entry.run)(this, window, cx),
                        // That Undo's toast says to undo again, unless a change has spoken since.
                        None if returned && !landed => {}
                        None => show_toast(window, Toast::info("Nothing to undo"), cx),
                    }
                    if !this.change_turn {
                        this.release_turn(window, cx);
                    }
                },
                window,
                cx,
            );
            return;
        }
        if let Some(entry) = self.undo.pop() {
            (entry.run)(self, window, cx);
            return;
        }
        let Some(engine) = self.engine().cloned() else {
            return;
        };
        let request = PlanListRequest {
            root_id: self.root_id(),
            offset: 0,
            limit: 20,
        };
        let plans = self.changes.list_plans(&engine, request);
        cx.spawn_in(window, async move |this, cx| {
            let plans = plans.await.unwrap_or_default();
            this.update_in(cx, |this, window, cx| {
                // A change begun meanwhile is now the newest.
                if this.holding_may_be_needed() {
                    this.undo_last(window, cx);
                    return;
                }
                match plans.into_iter().find(can_undo) {
                    Some(plan) => this.undo_plan(plan, PerformOptions::default(), window, cx),
                    None => show_toast(window, Toast::info("Nothing to undo"), cx),
                }
            })
            .ok();
        })
        .detach();
    }
}

/// Resolves and runs each step in turn; answers with the plans that did something, what went
/// wrong, and the roots to scan or analyse again.
async fn run_steps(
    this: &WeakEntity<TidyState>,
    steps: Vec<TidyStep>,
    source: &'static str,
    cx: &mut AsyncWindowContext,
) -> (Vec<PlanSummary>, Vec<String>, FollowUp) {
    let mut plans = Vec::new();
    let mut notes = Vec::new();
    let mut follow_up = FollowUp::default();
    for step in steps {
        let request = match step {
            TidyStep::Planned(request) => Some(request),
            TidyStep::SilentVideos(root_id) => {
                let Ok(Some(engine)) = this.read_with(cx, |this, _| this.engine().cloned()) else {
                    break;
                };
                let filter = FileFilter {
                    kinds: vec![FileKind::Video],
                    audio_states: vec![AudioState::Silent],
                    ..FileFilter::root(Some(root_id))
                };
                match engine.list_file_ids(filter).await {
                    Ok(list) if !list.ids.is_empty() => {
                        Some(PlanRequest::StripAudio { file_ids: list.ids })
                    }
                    Ok(_) => None,
                    Err(error) => {
                        notes.push(format!("{error:#}"));
                        None
                    }
                }
            }
        };
        let Some(request) = request else {
            continue;
        };
        let Ok(finished) = this.update(cx, |this, cx| {
            this.start_perform(request, Some(source.into()), cx)
        }) else {
            break;
        };
        let outcome = finished.await;
        this.update(cx, |this, cx| {
            this.change = None;
            this.changed(cx);
        })
        .ok();
        match outcome.map_err(|unfinished| (unfinished.error, unfinished.plan)) {
            Ok((_, applied)) => {
                let plan = applied.plan;
                follow_up.rescan.extend(applied.follow_up.rescan);
                follow_up.analyze.extend(applied.follow_up.analyze);
                if plan.failed > 0 {
                    notes.push(format!("{}: {} failed", plan.title, plan.failed));
                }
                if plan.steps > 0 {
                    plans.push(plan);
                }
            }
            Err((JobError::Cancelled, _)) => {
                notes.push("Stopped".into());
                break;
            }
            // A step that failed part way counts with the rest, so the one Undo takes back
            // what it did (`performAll`).
            Err((_, Some(plan))) => {
                notes.push(format!("{}: {} failed", plan.title, plan.failed));
                if plan.steps > 0 {
                    plans.push(plan);
                }
            }
            Err((error, None)) => {
                let message = job_message(&error);
                // A step whose files went in an earlier step has nothing left to do.
                if !message.contains("nothing to do") {
                    notes.push(message);
                }
                if is_not_available(&error) {
                    break;
                }
            }
        }
    }
    this.update(cx, |this, cx| {
        this.report_activity(cx);
        this.reload_roots(cx);
    })
    .ok();
    (plans, notes, follow_up)
}

#[cfg(test)]
mod tests {
    use gpui_kit::TestAppContext;

    use super::*;

    /// A quick change, such as a decision on Duplicates, can finish before the task that started
    /// it comes back to subscribe. It heard nothing then, and held every later change back until
    /// the app quit.
    #[gpui_kit::test]
    async fn a_job_that_finished_before_anyone_asked_still_answers(cx: &mut TestAppContext) {
        let done = cx.update(|cx| Job::start("quick", cx, |_| async { Ok(7) }));
        let failed =
            cx.update(|cx| Job::<i32>::start("broken", cx, |_| async { anyhow::bail!("no") }));
        cx.run_until_parked();
        cx.read(|cx| assert!(!done.read(cx).is_running() && !failed.read(cx).is_running()));

        let (mut done_answer, _done) = cx.update(|cx| when_finished(&done, cx));
        let (mut failed_answer, _failed) = cx.update(|cx| when_finished(&failed, cx));
        cx.run_until_parked();
        assert!(matches!(done_answer.try_recv(), Ok(Some(Ok(7)))));
        assert!(matches!(
            failed_answer.try_recv(),
            Ok(Some(Err(JobError::Failed(_))))
        ));
    }
}
