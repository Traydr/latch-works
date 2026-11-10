//! Changes as the owner makes them: each runs one of the engine's change operations as a job, is
//! reported in a toast that offers Undo, and goes on ⌘Z's history. Several plans run as one change
//! (Tidy up, Clean up's "do all") with one Undo.
//!
//! A change asked for while another runs waits its turn in the engine's queue, which the activity
//! panel at the window's bottom right lists as queued; Stop in the panel takes it off the queue.
//! While a change runs the shell shows its ring and quitting waits for it; the catalog's version
//! moves when it ends, so every page reads again, and what the change left to do (its rescans,
//! the analysis new files need) follows it in its place in the queue.

use std::rc::Rc;
use std::time::{Duration, Instant};

use futures::channel::oneshot;
use gpui_kit::{App, Context, Entity, SharedString, Subscription, Window};
use oriel_core_domain::format;
use oriel_core_tidy::contract::{
    OptimizeCategory, PlanId, PlanKind, PlanListRequest, PlanRequest, PlanStatus, PlanSummary,
};
use oriel_core_tidy::{
    Performed, PlanFailed, PlanRequestError, Queued, TidiedUp, TidyStep, Undone,
};
use oriel_ui::{AnyJob, Job, JobError, Toast, ToastExt as _};

use crate::state::{Reporting, TidyState};

/// The most entries ⌘Z remembers.
const UNDO_LIMIT: usize = 50;

/// How often the pages read again while a change runs.
const READ_AGAIN_WHILE_CHANGING: Duration = Duration::from_secs(2);

/// What a deferred ⌘Z is called in the activity panel until it knows what it takes back.
const UNDO_LAST: &str = "Undo the last change";

/// Runs once a change is undone, however that happens (its toast's Undo, ⌘Z), to show it again.
pub type OnUndone = Rc<dyn Fn(&mut Window, &mut App)>;

/// What the last Tidy up did, as its own plans measured it.
pub struct Tidied {
    pub root_id: oriel_core_tidy::contract::RootId,
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
    action: UndoAction,
}

#[derive(Clone)]
enum UndoAction {
    /// Plans, taken back by the engine as one change.
    Plans {
        plans: Vec<PlanSummary>,
        title: String,
        options: PerformOptions,
    },
    /// Something else, such as a dismissal or a preferred folder, with the number
    /// [`TidyState::push_undo`] gave it.
    Other { key: u64, run: UndoRun },
}

/// How a change reports itself.
#[derive(Clone, Default)]
pub struct PerformOptions {
    /// Ties the change to a place in the UI, such as an Overview row, whose button shows it
    /// running or queued.
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
    /// Runs when nothing ran: the change failed, was stopped, or left the queue.
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

/// A ⌘Z asked for while changes ran: it waits its turn behind them, then takes back what has
/// landed since, chosen once they have been reported.
pub(crate) struct DeferredUndo {
    /// The changes it waits to see reported.
    waits_for: Vec<u64>,
    pushed_before: u64,
    returned_before: u64,
    /// Whether any of those adds to ⌘Z's history when it lands.
    behind_a_change: bool,
    choice: Option<oneshot::Sender<Option<Vec<PlanId>>>>,
    chosen: Option<UndoEntry>,
}

/// A change running or waiting for its turn, and what watches it.
pub struct RunningChange {
    pub(crate) id: u64,
    pub source: Option<SharedString>,
    /// What the plan does; `None` for an undo.
    pub kind: Option<PlanKind>,
    /// What the activity panel calls it while it waits, such as "Convert".
    pub(crate) label: SharedString,
    /// It adds to ⌘Z's history when it lands; an Undo or a Restore does not.
    adds_to_history: bool,
    pub(crate) job: AnyJob,
    /// Stop took it off the queue: if it never got its turn it says nothing, and it is gone from
    /// the activity panel and its page at once, while its thread lets go of its place.
    dropped: bool,
    deferred: Option<DeferredUndo>,
    _subscriptions: Vec<Subscription>,
}

impl RunningChange {
    /// Stop took it off the queue before its turn came.
    pub(crate) fn withdrawn(&self, cx: &App) -> bool {
        self.dropped && self.job.progress(cx).phase().is_empty()
    }
}

/// Where the change a page started is.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ChangeStatus {
    Running,
    /// Waiting in the queue for the change before it to finish.
    Queued,
}

/// What a new change is.
struct NewChange {
    label: SharedString,
    source: Option<SharedString>,
    kind: Option<PlanKind>,
    adds_to_history: bool,
    deferred: Option<DeferredUndo>,
}

/// How a change ended, for what asked for it. A Stop once its turn had come is already said by
/// [`TidyState::run_change`].
pub(crate) enum Ended<T> {
    /// Stop took it off the queue before its turn came: it touched nothing and says nothing.
    Withdrawn,
    /// Stopped once its turn had come; what it finished stays done.
    Stopped,
    Done(T),
    /// It failed; never a Stop.
    Failed(JobError),
}

pub(crate) fn job_message(error: &JobError) -> String {
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

/// The numbers under a plan's title: what it saved or held, and what it left out.
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
        let progress = self.changes.first()?.job.progress(cx);
        Some(RunningFile {
            rel_path: progress.item()?.to_string(),
            name: progress.item_name()?.to_owned(),
            share: progress.item_share(),
            paused: progress.is_paused() && oriel_runtime::tools_suspend(),
            pausing: progress.is_pausing(),
        })
    }

    /// The running change started from `source`, if any.
    pub fn change_for(&self, source: &str) -> Option<&RunningChange> {
        self.changes
            .first()
            .filter(|change| change.source.as_deref() == Some(source))
    }

    /// Whether a change runs or waits for its turn.
    pub fn is_changing(&self) -> bool {
        !self.changes.is_empty()
    }

    /// Stops the change running; finished steps stay done and can be undone. One still waiting
    /// for its turn stops before it has touched anything.
    pub fn stop_change(&mut self, cx: &mut Context<Self>) {
        if !self.changes.is_empty() {
            self.stop_change_at(0, false, cx);
        }
    }

    /// Stops the change at `index`; `dropped` when Stop takes it off the queue behind another.
    pub(crate) fn stop_change_at(&mut self, index: usize, dropped: bool, cx: &mut Context<Self>) {
        let change = &mut self.changes[index];
        change.dropped |= dropped;
        // A ⌘Z holding the turn while it waits to choose would wait for good.
        if let Some(deferred) = &mut change.deferred {
            deferred.choice.take();
        }
        change.job.cancel(cx);
    }

    /// Where the change started from `source` is: running, or queued behind another.
    pub fn change_status(&self, source: &str, cx: &App) -> Option<ChangeStatus> {
        if self.change_for(source).is_some() {
            return Some(ChangeStatus::Running);
        }
        self.changes
            .iter()
            .any(|change| change.source.as_deref() == Some(source) && !change.withdrawn(cx))
            .then_some(ChangeStatus::Queued)
    }

    /// Lists a change's job.
    fn add_change<T: Send + 'static>(
        &mut self,
        change: NewChange,
        job: &Entity<Job<T>>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> u64 {
        self.say_if_waiting_on_paused_work(window, cx);
        let id = self.next_work;
        self.next_work += 1;
        let mut read_at = Instant::now();
        let observing = cx.observe(job, move |this, job, cx| {
            // Files change step by step, and a long run must not leave the pages showing ones
            // that have gone until it ends.
            if job.read(cx).progress().done() > 0 && read_at.elapsed() >= READ_AGAIN_WHILE_CHANGING
            {
                read_at = Instant::now();
                this.changed(cx);
            }
            this.report_activity(cx);
            cx.notify();
        });
        self.changes.push(RunningChange {
            id,
            source: change.source,
            kind: change.kind,
            label: change.label,
            adds_to_history: change.adds_to_history,
            job: job.clone().into(),
            dropped: false,
            deferred: change.deferred,
            _subscriptions: vec![observing],
        });
        self.report_activity(cx);
        cx.notify();
        id
    }

    /// Takes a finished change off the list. Unless it was withdrawn it may have changed the
    /// catalog, so every page reads again.
    fn end_change(&mut self, id: u64, cx: &mut Context<Self>) -> Option<RunningChange> {
        let index = self.changes.iter().position(|change| change.id == id)?;
        let change = self.changes.remove(index);
        if !change.withdrawn(cx) {
            self.forget_held_sets();
            self.changed(cx);
            self.reload_roots(cx);
        }
        self.report_activity(cx);
        Some(change)
    }

    /// Runs `work` as a change: it waits its turn in the engine's queue behind the changes asked
    /// for before it, shows in the activity panel, and moves the catalog's version when it ends.
    /// Then `then` reports it, with how it ended and the change as it left the list, and each ⌘Z
    /// that waited for it chooses what it takes back. A Stop once its turn had come is said here,
    /// the same for every change.
    fn run_change<T: Clone + Send + 'static>(
        &mut self,
        new: NewChange,
        work: Queued<T>,
        then: impl FnOnce(&mut Self, Ended<T>, RunningChange, &mut Window, &mut Context<Self>) + 'static,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let job = Job::run_blocking(new.label.clone(), "tidy change", cx, move |reporter| {
            work.run(&Reporting(reporter))
        });
        let id = self.add_change(new, &job, window, cx);
        let finished = Job::finished(&job, cx);
        cx.spawn_in(window, async move |this, cx| {
            let outcome = finished.await;
            this.update_in(cx, |this, window, cx| {
                if let Some(change) = this.end_change(id, cx) {
                    let ended = match outcome {
                        _ if change.withdrawn(cx) => Ended::Withdrawn,
                        Ok(value) => Ended::Done(value),
                        Err(JobError::Cancelled) => Ended::Stopped,
                        Err(error) => Ended::Failed(error),
                    };
                    if matches!(ended, Ended::Stopped) {
                        window.show_toast(Toast::info("Stopped"), cx);
                    }
                    then(this, ended, change, window, cx);
                }
                this.choose_deferred_undos(window, cx);
            })
            .ok();
        })
        .detach();
    }

    /// Runs work on holding that is not a plan (a Restore, an Empty, Forget's emptying) as a
    /// change, so an Undo queued first still finds what it needs. It adds nothing to ⌘Z's
    /// history.
    pub(crate) fn run_holding_work<T: Clone + Send + 'static>(
        &mut self,
        label: impl Into<SharedString>,
        work: Queued<T>,
        then: impl FnOnce(&mut Self, Ended<T>, &mut Window, &mut Context<Self>) + 'static,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let new = NewChange {
            label: label.into(),
            source: None,
            kind: None,
            adds_to_history: false,
            deferred: None,
        };
        self.run_change(
            new,
            work,
            move |this, ended, _, window, cx| then(this, ended, window, cx),
            window,
            cx,
        );
    }

    /// Drafts and applies a plan once its turn comes, and reports it with a toast that offers
    /// Undo. What the plan left out is in the toast's detail.
    pub fn perform(
        &mut self,
        request: PlanRequest,
        options: PerformOptions,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(engine) = self.engine().cloned() else {
            window.show_toast(Toast::error("Tidy's catalog is not open"), cx);
            return;
        };
        let kind = request.kind();
        let work = engine.queue(|engine| engine.perform(request));
        let new = NewChange {
            label: kind.label().into(),
            source: options.source.clone(),
            kind: Some(kind),
            adds_to_history: true,
            deferred: None,
        };
        self.run_change(
            new,
            work,
            move |this, ended, _, window, cx| this.announce(ended, &options, window, cx),
            window,
            cx,
        );
    }

    fn announce(
        &mut self,
        ended: Ended<Performed>,
        options: &PerformOptions,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Performed { preview, applied } = match ended {
            Ended::Done(performed) => performed,
            ended => {
                // After this update, so the page may read the state.
                if let Some(on_failed) = options.on_failed.clone() {
                    window.defer(cx, move |window, cx| on_failed(window, cx));
                }
                let Ended::Failed(error) = ended else {
                    return;
                };
                // A change that failed part way did some of its steps, which its Undo takes back.
                let failed_plan = match &error {
                    JobError::Failed(cause) => PlanFailed::plan_of(cause).cloned(),
                    JobError::Cancelled => None,
                };
                let toast = match (error, failed_plan) {
                    (error, Some(plan)) => self.failed_toast(plan, &error, options, cx),
                    (error, None) => match refusal(&error) {
                        Some(reason) => Toast::error(reason),
                        None => Toast::error("That didn't work").detail(job_message(&error)),
                    },
                };
                window.show_toast(toast, cx);
                return;
            }
        };
        self.follow_up(applied.follow_up, window, cx);
        let plan = applied.plan;
        if let Some(on_done) = options.on_done.clone() {
            let plan = plan.clone();
            window.defer(cx, move |window, cx| on_done(&plan, window, cx));
        }
        let undoable = plan.can_undo();
        if undoable {
            // ⌘Z says what it undid, even where the toast's own Undo needs no words.
            let entry_options = PerformOptions {
                quiet: false,
                ..options.clone()
            };
            self.push_entry(plans_entry(vec![plan.clone()], None, entry_options));
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
        window.show_toast(toast, cx);
    }

    /// A change whose job failed part way: "‹title›, with errors", with what went wrong and an
    /// Undo for the steps it did, which ⌘Z takes back too.
    fn failed_toast(
        &mut self,
        plan: PlanSummary,
        error: &JobError,
        options: &PerformOptions,
        cx: &mut Context<Self>,
    ) -> Toast {
        let toast = Toast::error(format!("{}, with errors", plan.title)).detail(job_message(error));
        if !plan.can_undo() {
            return toast;
        }
        self.push_entry(plans_entry(vec![plan.clone()], None, options.clone()));
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

    /// Undoes a plan once its turn comes, says so unless `options.quiet`, and runs
    /// `options.on_undone` once it is.
    pub fn undo_plan(
        &mut self,
        plan: PlanSummary,
        options: PerformOptions,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let title = plan.title.clone();
        self.undo_plans(vec![plan], title, options, window, cx);
    }

    /// Undoes plans, oldest first in `plans`, as one Undo named `title`.
    pub(crate) fn undo_all(
        &mut self,
        plans: Vec<PlanSummary>,
        title: String,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.undo_plans(plans, title, PerformOptions::default(), window, cx);
    }

    fn undo_plans(
        &mut self,
        plans: Vec<PlanSummary>,
        title: String,
        options: PerformOptions,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        // A toast still offering Undo for this would be out of date at once.
        window.dismiss_toast(cx);
        let Some(engine) = self.engine().cloned() else {
            return;
        };
        let entry = plans_entry(plans, Some(title.clone()), options);
        let ids = entry.plan_ids.clone();
        self.forget_plans(&ids);
        let work = engine.queue(|engine| engine.undo(ids));
        let new = NewChange {
            label: format!("Undo “{title}”").into(),
            source: None,
            kind: None,
            adds_to_history: false,
            deferred: None,
        };
        self.run_change(
            new,
            work,
            move |this, ended, _, window, cx| this.report_undo(ended, entry, window, cx),
            window,
            cx,
        );
    }

    /// Says how an Undo of `entry`'s plans went. What did not finish is still the next Undo, not
    /// the change before it; one that never ran is still on ⌘Z's history as it was.
    fn report_undo(
        &mut self,
        ended: Ended<Undone>,
        entry: UndoEntry,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let undone = match ended {
            Ended::Withdrawn => return self.keep_entry(entry),
            Ended::Stopped => return self.return_entry(entry),
            Ended::Done(undone) => undone,
            Ended::Failed(error) => {
                self.return_entry(entry);
                window.show_toast(Toast::error("Undo failed").detail(job_message(&error)), cx);
                return;
            }
        };
        if !undone.complete {
            self.return_entry(entry);
            // The steps that did come back have changed under the catalog.
            self.follow_up(undone.follow_up, window, cx);
            let toast =
                Toast::error("Undo did not finish").detail(undone.message.unwrap_or_default());
            window.show_toast(toast, cx);
            return;
        }
        let UndoAction::Plans { title, options, .. } = entry.action else {
            return;
        };
        self.follow_up(undone.follow_up, window, cx);
        if let Some(on_undone) = options.on_undone.clone() {
            window.defer(cx, move |window, cx| on_undone(window, cx));
        }
        if !options.quiet {
            let name = options.undo_name.as_ref().unwrap_or(&title);
            window.show_toast(Toast::info(format!("Undid “{name}”")), cx);
        }
    }

    /// Tidy up from Overview: Clean up, then silent soundtracks, then Convert in `categories`, as
    /// one change with one Undo, remembered for Overview to go on saying what it saved.
    pub fn tidy_up(
        &mut self,
        categories: Vec<OptimizeCategory>,
        title: String,
        source: &'static str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let (Some(engine), Some(root_id)) = (self.engine().cloned(), self.root_id()) else {
            return;
        };
        let work = engine.queue(|engine| engine.tidy_up(root_id, categories));
        self.run_steps("Tidy up", work, title, source, true, window, cx);
    }

    /// Runs several plans one after another as one change with one Undo, each drafted once the
    /// one before has finished. A step that turns out to have nothing to do is skipped. `label`
    /// names it in the activity panel while it waits ("Clean up"); `title` reports it.
    pub fn perform_steps(
        &mut self,
        label: &'static str,
        steps: Vec<TidyStep>,
        title: String,
        source: &'static str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(engine) = self.engine().cloned() else {
            return;
        };
        let work = engine.queue(|engine| engine.perform_steps(steps));
        self.run_steps(label, work, title, source, false, window, cx);
    }

    #[allow(clippy::too_many_arguments)]
    fn run_steps(
        &mut self,
        label: &'static str,
        work: Queued<TidiedUp>,
        title: String,
        source: &'static str,
        remember: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let new = NewChange {
            label: label.into(),
            source: Some(source.into()),
            kind: None,
            adds_to_history: true,
            deferred: None,
        };
        self.run_change(
            new,
            work,
            move |this, ended, _, window, cx| {
                let tidied = match ended {
                    Ended::Done(tidied) => tidied,
                    Ended::Failed(error) => TidiedUp {
                        plans: Vec::new(),
                        notes: vec![job_message(&error)],
                        follow_up: Default::default(),
                    },
                    Ended::Withdrawn | Ended::Stopped => return,
                };
                this.announce_all(tidied, title, remember, window, cx);
            },
            window,
            cx,
        );
    }

    fn announce_all(
        &mut self,
        tidied: TidiedUp,
        title: String,
        remember: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let TidiedUp {
            plans,
            notes,
            follow_up,
        } = tidied;
        self.follow_up(follow_up, window, cx);
        let undoable: Vec<PlanSummary> = plans
            .iter()
            .filter(|plan| plan.can_undo())
            .cloned()
            .collect();
        let held: i64 = plans.iter().map(|plan| plan.held.bytes).sum();
        let before: i64 = plans.iter().map(|plan| plan.bytes_before).sum();
        let after: i64 = plans.iter().map(|plan| plan.bytes_after).sum();
        let mut summary = Vec::new();
        if before > after {
            summary.push(format!("{} out", format::bytes((before - after) as f64)));
        }
        if remember {
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

        if !undoable.is_empty() {
            self.push_entry(plans_entry(
                undoable.clone(),
                Some(title.clone()),
                PerformOptions::default(),
            ));
        }
        let message = if plans.is_empty() && notes.is_empty() {
            "Nothing to tidy".to_string()
        } else if plans.is_empty() {
            "That didn't work".to_string()
        } else if before > after {
            format!("{title} · {}", format::bytes((before - after) as f64))
        } else {
            title.clone()
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
                let (plans, title) = (undoable.clone(), title.clone());
                this.update(cx, |this, cx| this.undo_all(plans, title, window, cx))
                    .ok();
            });
        }
        window.show_toast(toast, cx);
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

    fn run_entry(&mut self, entry: UndoEntry, window: &mut Window, cx: &mut Context<Self>) {
        match entry.action {
            UndoAction::Plans {
                plans,
                title,
                options,
            } => self.undo_plans(plans, title, options, window, cx),
            UndoAction::Other { run, .. } => run(self, window, cx),
        }
    }

    /// Adds a change that is not a plan (a dismissal, a preferred folder) to ⌘Z's history.
    /// Returns its number, for [`Self::drop_undo`] when it is undone some other way.
    pub fn push_undo(
        &mut self,
        run: impl Fn(&mut TidyState, &mut Window, &mut Context<TidyState>) + 'static,
    ) -> u64 {
        let key = self.next_undo_key;
        self.next_undo_key += 1;
        self.push_entry(UndoEntry {
            plan_ids: Vec::new(),
            action: UndoAction::Other {
                key,
                run: Rc::new(run),
            },
        });
        key
    }

    /// Takes an entry [`Self::push_undo`] added off ⌘Z's history.
    pub fn drop_undo(&mut self, key: u64) {
        self.undo.retain(
            |entry| !matches!(entry.action, UndoAction::Other { key: kept, .. } if kept == key),
        );
    }

    /// A decision is on its way to the catalog and will add to ⌘Z's history when it lands.
    pub(crate) fn expect_undo_entry(&mut self) {
        self.undo_entries_coming += 1;
    }

    /// A decision [`Self::expect_undo_entry`] announced has landed, or failed; a ⌘Z that waited
    /// for it goes on.
    pub(crate) fn undo_entry_landed(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.undo_entries_coming = self.undo_entries_coming.saturating_sub(1);
        if self.undo_entries_coming == 0 && std::mem::take(&mut self.undo_waiting) {
            self.undo_last(window, cx);
        }
    }

    fn forget_plans(&mut self, plan_ids: &[PlanId]) {
        self.undo
            .retain(|entry| !entry.plan_ids.iter().any(|id| plan_ids.contains(id)));
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
    /// only work that adds nothing to ⌘Z's history (an Undo, a Restore, an Empty, Forget's
    /// emptying) the newest change is already on the list, so it undoes that; behind an Undo, as a
    /// second ⌘Z means. Behind an Undo that stopped or did not finish it undoes nothing: that Undo
    /// said so, and is still the next.
    pub fn undo_last(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        // What is on screen may be the Undo this answers; the result says what happened.
        window.dismiss_toast(cx);
        if self.undo_entries_coming > 0 {
            self.undo_waiting = true;
            return;
        }
        if self.is_changing() {
            self.defer_undo(window, cx);
            return;
        }
        if let Some(entry) = self.undo.pop() {
            self.run_entry(entry, window, cx);
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
        let plans = engine.ask(|engine| engine.list_plans(request), cx);
        cx.spawn_in(window, async move |this, cx| {
            let plans = plans.await.unwrap_or_default();
            this.update_in(cx, |this, window, cx| {
                // A change begun meanwhile is now the newest.
                if this.is_changing() {
                    this.undo_last(window, cx);
                    return;
                }
                match plans.into_iter().find(PlanSummary::can_undo) {
                    Some(plan) => this.undo_plan(plan, PerformOptions::default(), window, cx),
                    None => window.show_toast(Toast::info("Nothing to undo"), cx),
                }
            })
            .ok();
        })
        .detach();
    }

    /// A ⌘Z behind the changes running or waiting: it takes its turn behind them in the engine's
    /// queue, and chooses what to take back once they have been reported.
    fn defer_undo(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(engine) = self.engine().cloned() else {
            return;
        };
        let (choice, chosen) = oneshot::channel::<Option<Vec<PlanId>>>();
        let work = engine.queue(|engine| {
            engine.undo_chosen(move || futures::executor::block_on(chosen).ok().flatten())
        });
        let deferred = DeferredUndo {
            waits_for: self.changes.iter().map(|change| change.id).collect(),
            pushed_before: self.undo_pushed,
            returned_before: self.undo_returned,
            behind_a_change: self.changes.iter().any(|change| change.adds_to_history),
            choice: Some(choice),
            chosen: None,
        };
        let new = NewChange {
            label: UNDO_LAST.into(),
            source: None,
            kind: None,
            adds_to_history: false,
            deferred: Some(deferred),
        };
        self.run_change(
            new,
            work,
            move |this, ended, change, window, cx| {
                // Without a choice it took back nothing, and said so when there was nothing.
                let Some(entry) = change.deferred.and_then(|deferred| deferred.chosen) else {
                    return;
                };
                let ended = match ended {
                    Ended::Done(Some(undone)) => Ended::Done(undone),
                    Ended::Done(None) | Ended::Stopped => Ended::Stopped,
                    Ended::Withdrawn => Ended::Withdrawn,
                    Ended::Failed(error) => Ended::Failed(error),
                };
                this.report_undo(ended, entry, window, cx);
            },
            window,
            cx,
        );
    }

    /// Lets each deferred ⌘Z whose changes have all been reported choose what it takes back.
    fn choose_deferred_undos(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        loop {
            let ids: Vec<u64> = self.changes.iter().map(|change| change.id).collect();
            let Some(index) = self.changes.iter().position(|change| {
                change.deferred.as_ref().is_some_and(|deferred| {
                    deferred.choice.is_some()
                        && deferred.waits_for.iter().all(|id| !ids.contains(id))
                })
            }) else {
                return;
            };
            let id = self.changes[index].id;
            let Some(deferred) = self.changes[index].deferred.take() else {
                return;
            };
            let landed = self.undo_pushed != deferred.pushed_before;
            let returned = self.undo_returned != deferred.returned_before;
            let next = if !returned && (landed || !deferred.behind_a_change) {
                self.undo.pop()
            } else {
                None
            };
            let mut deferred = deferred;
            let choice = deferred.choice.take();
            let answer = match next {
                Some(entry) if matches!(entry.action, UndoAction::Plans { .. }) => {
                    let ids = entry.plan_ids.clone();
                    self.forget_plans(&ids);
                    deferred.chosen = Some(entry);
                    Some(ids)
                }
                Some(entry) => {
                    self.run_entry(entry, window, cx);
                    None
                }
                // That Undo has said how it ended and is still the next, unless a change has
                // spoken since.
                None if returned && !landed => None,
                None => {
                    window.show_toast(Toast::info("Nothing to undo"), cx);
                    None
                }
            };
            if let Some(change) = self.changes.iter_mut().find(|change| change.id == id) {
                change.deferred = Some(deferred);
            }
            if let Some(choice) = choice {
                let _ = choice.send(answer);
            }
        }
    }
}

/// An entry that undoes `plans` (oldest first) as one change, named `title` or the one plan's
/// title.
fn plans_entry(
    plans: Vec<PlanSummary>,
    title: Option<String>,
    options: PerformOptions,
) -> UndoEntry {
    let title = title.unwrap_or_else(|| {
        plans
            .first()
            .map(|plan| plan.title.clone())
            .unwrap_or_default()
    });
    UndoEntry {
        plan_ids: plans.iter().map(|plan| plan.id).collect(),
        action: UndoAction::Plans {
            plans,
            title,
            options,
        },
    }
}
