//! Changes as the owner makes them, after Electron Oriel's `lib/actions.tsx`: a change runs as a
//! job through [`crate::changes::TidyChanges`], is reported in a toast that offers Undo, and goes
//! on ⌘Z's history. Tidy up runs several plans one after another as one change with one Undo.
//!
//! While a change runs the shell shows its ring and quitting waits for it; the catalog's version
//! moves when it ends, so every page reads again, and the roots the change asks to scan or
//! analyse again are.

use std::cell::RefCell;
use std::rc::Rc;

use futures::channel::oneshot;
use gpui_kit::{
    App, AsyncWindowContext, Context, Entity, SharedString, Subscription, Task, WeakEntity, Window,
};
use oriel_core_tidy::contract::{AudioState, FileFilter, FileKind, RootId};
use oriel_runtime::{Job, JobError, JobEvent, JobProgress};
use oriel_ui::Toast;

use crate::changes::{
    Applied, FollowUp, PlanId, PlanKind, PlanListRequest, PlanPreview, PlanRequest, PlanStatus,
    PlanSummary, Undone, can_undo, is_not_yet, job_error,
};
use crate::format;
use crate::state::TidyState;
use crate::widgets::show_toast;

/// The most entries ⌘Z remembers, as Electron Oriel's history keeps 50.
const UNDO_LIMIT: usize = 50;

/// Runs once a change is undone, however that happens (its toast's Undo, ⌘Z), to show it again.
pub type OnUndone = Rc<dyn Fn(&mut Window, &mut App)>;

/// Runs with a finished plan.
pub type OnDone = Rc<dyn Fn(&PlanSummary, &mut Window, &mut App)>;

type UndoRun = Rc<dyn Fn(&mut TidyState, &mut Window, &mut Context<TidyState>)>;

/// Something the owner did that ⌘Z can take back.
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
    _subscriptions: Vec<Subscription>,
}

impl RunningChange {
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

/// A channel that answers once `job` finishes, and the subscription that feeds it.
fn when_finished<T: Clone + Send + 'static>(
    job: &Entity<Job<T>>,
    cx: &mut App,
) -> (oneshot::Receiver<Finished<T>>, Subscription) {
    let (sender, receiver) = oneshot::channel();
    let sender = RefCell::new(Some(sender));
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

    /// Whether a change runs, so a page's main action waits for it.
    pub fn is_changing(&self) -> bool {
        self.change.is_some()
    }

    /// Stops the change running; finished steps stay done and can be undone.
    pub fn stop_change(&mut self, cx: &mut Context<Self>) {
        if let Some(change) = &self.change {
            change.cancel(cx);
        }
    }

    /// Drafts and applies `request`, tracking it as the running change; answers with the draft
    /// and what applying it did, once it is done.
    fn start_perform(
        &mut self,
        request: PlanRequest,
        source: Option<SharedString>,
        cx: &mut Context<Self>,
    ) -> Task<Finished<(PlanPreview, Applied)>> {
        let Some(engine) = self.engine().cloned() else {
            return Task::ready(Err(job_error(anyhow::anyhow!(
                "Tidy's catalog is not open"
            ))));
        };
        let kind = request.kind();
        let performing = self.changes.perform(&engine, request, cx);
        self.change = Some(RunningChange {
            source,
            kind: Some(kind),
            job: None,
            _subscriptions: Vec::new(),
        });
        self.report_activity(cx);
        cx.notify();
        cx.spawn(async move |this, cx| {
            let (preview, job) = performing.await.map_err(job_error)?;
            let finished = this
                .update(cx, |this, cx| {
                    let (finished, subscription) = when_finished(&job, cx);
                    let observing = cx.observe(&job, |this, _, cx| {
                        this.report_activity(cx);
                        cx.notify();
                    });
                    if let Some(change) = &mut this.change {
                        change.job = Some(ChangeJob::Perform(job));
                        change._subscriptions = vec![subscription, observing];
                    }
                    finished
                })
                .map_err(job_error)?;
            let applied = finished.await.unwrap_or(Err(JobError::Cancelled))?;
            Ok((preview, applied))
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
            _subscriptions: vec![subscription, observing],
        });
        self.report_activity(cx);
        cx.notify();
        cx.spawn(async move |_, _| finished.await.unwrap_or(Err(JobError::Cancelled)))
    }

    /// The running change ended: the catalog may have changed.
    fn change_ended(&mut self, cx: &mut Context<Self>) {
        self.change = None;
        self.report_activity(cx);
        self.changed(cx);
        self.reload_roots(cx);
    }

    /// Scans or analyses again the roots a change asks for.
    fn follow_up(&mut self, follow_up: &FollowUp, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(root_id) = follow_up.rescan.first() {
            self.start_scan(*root_id, window, cx);
        } else if let Some(root_id) = follow_up.analyze.first() {
            self.start_background_analysis(*root_id, window, cx);
        }
    }

    /// Runs a plan now and reports it with a toast that offers Undo (`perform`). What the plan
    /// left out is in the toast's detail.
    pub fn perform(
        &mut self,
        request: PlanRequest,
        options: PerformOptions,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.change.is_some() {
            if let Some(on_failed) = options.on_failed.clone() {
                window.defer(cx, move |window, cx| on_failed(window, cx));
            }
            show_toast(window, Toast::info("Another change is running"), cx);
            return;
        }
        let finished = self.start_perform(request, options.source.clone(), cx);
        cx.spawn_in(window, async move |this, cx| {
            let outcome = finished.await;
            this.update_in(cx, |this, window, cx| {
                this.change_ended(cx);
                this.announce(outcome, &options, window, cx);
            })
            .ok();
        })
        .detach();
    }

    fn announce(
        &mut self,
        outcome: Finished<(PlanPreview, Applied)>,
        options: &PerformOptions,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let (preview, applied) = match outcome {
            Ok(outcome) => outcome,
            Err(error) => {
                // After this update, so the page may read the state.
                if let Some(on_failed) = options.on_failed.clone() {
                    window.defer(cx, move |window, cx| on_failed(window, cx));
                }
                let toast = match error {
                    JobError::Cancelled => Toast::info("Stopped"),
                    error => Toast::error("That didn't work").detail(job_message(&error)),
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
            let entry_options = options.clone();
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

    /// Undoes a plan, says so unless `options.quiet`, and runs `options.on_undone` once it is.
    pub fn undo_plan(
        &mut self,
        plan: PlanSummary,
        options: PerformOptions,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.change.is_some() {
            show_toast(window, Toast::info("Another change is running"), cx);
            return;
        }
        self.forget_plans(&[plan.id]);
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
                            let toast = Toast::info(format!("Undid “{}”", plan.title));
                            show_toast(window, toast, cx);
                        }
                    }
                    Ok(undone) => show_toast(
                        window,
                        Toast::error("Undo did not finish")
                            .detail(undone.message.unwrap_or_default()),
                        cx,
                    ),
                    Err(error) => show_toast(
                        window,
                        Toast::error("Undo failed").detail(job_message(&error)),
                        cx,
                    ),
                }
            })
            .ok();
        })
        .detach();
    }

    /// Runs Tidy up's steps one after another, each drafted once the one before has finished, and
    /// reports them as one change with one Undo (`performAll`). A step that turns out to have
    /// nothing to do is skipped.
    pub fn perform_all(
        &mut self,
        steps: Vec<TidyStep>,
        title: String,
        source: &'static str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.change.is_some() {
            show_toast(window, Toast::info("Another change is running"), cx);
            return;
        }
        let this = cx.entity().downgrade();
        cx.spawn_in(window, async move |_, cx| {
            let (plans, notes, follow_up) = run_steps(&this, steps, source, cx).await;
            this.update_in(cx, |this, window, cx| {
                this.follow_up(&follow_up, window, cx);
                this.announce_all(plans, notes, title, source, window, cx);
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
        if self.change.is_some() {
            show_toast(window, Toast::info("Another change is running"), cx);
            return;
        }
        let ids: Vec<PlanId> = plans.iter().map(|plan| plan.id).collect();
        self.forget_plans(&ids);
        let this = cx.entity().downgrade();
        cx.spawn_in(window, async move |_, cx| {
            let mut failure = None;
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
                        failure = Some(undone.message.unwrap_or_default());
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
                    None => Toast::info(format!("Undid “{title}”")),
                    Some(message) => Toast::error("Undo did not finish").detail(message),
                };
                show_toast(window, toast, cx);
            })
            .ok();
        })
        .detach();
    }

    fn push_entry(&mut self, entry: UndoEntry) {
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
    }

    /// ⌘Z: the newest change of this session, else the newest undoable plan in the journal.
    pub fn undo_last(&mut self, window: &mut Window, cx: &mut Context<Self>) {
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
        match outcome {
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
            Err(JobError::Cancelled) => {
                notes.push("Stopped".into());
                break;
            }
            Err(error) => {
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
