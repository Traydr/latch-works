//! One sync run's life on Pane View, shared by push and prune, as lockstep-core's `sync-run.ts`:
//! open it, let the caller's queue apply the items, then finish it, which records the outcome
//! (retrying a failed attempt) and turns it into the run's summary or error.

use oriel_runtime::{CancelToken, Cancelled};

use crate::api::{PaneViewClient, types};
use crate::events::{Observer, RunAction, RunEvent, RunStatus, RunSummary, emit, status};
use crate::format::format_push_error;
use crate::plan::{LockstepPlan, planned_changes};
use crate::prune::BACK_IN_SOURCE_REASON;

/// What ended a run early: a cancel, or an error that stops every remaining item.
pub(crate) enum Interruption {
    Cancelled,
    Failed(anyhow::Error),
}

/// How a run's items went.
pub(crate) struct RunOutcome {
    pub(crate) applied: usize,
    /// How many items the run took on, after the max-changes cap.
    pub(crate) capped: usize,
    pub(crate) failed: usize,
    pub(crate) skipped: usize,
    pub(crate) interruption: Option<Interruption>,
}

impl RunOutcome {
    fn status(&self) -> RunStatus {
        match self.interruption {
            Some(Interruption::Cancelled) => RunStatus::Cancelled,
            Some(Interruption::Failed(_)) => RunStatus::Failed,
            None if self.failed > 0 => RunStatus::Failed,
            None => RunStatus::Completed,
        }
    }
}

/// Every finalization attempt failed, so Pane View still shows the run as running and blocks
/// library maintenance until it is cancelled on its management page (`UnfinalizedSyncRunError`).
#[derive(Debug)]
pub struct UnfinalizedSyncRun {
    pub action: RunAction,
    pub intended_status: RunStatus,
    pub message: String,
    pub sync_run_id: String,
    /// The run as it ended, failed, with this error as its message.
    pub summary: RunSummary,
}

impl std::fmt::Display for UnfinalizedSyncRun {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for UnfinalizedSyncRun {}

fn applied_text(action: RunAction, count: usize) -> String {
    match action {
        RunAction::Prune => format!("{count} delete(s) applied"),
        _ => format!("{count} item(s) pushed"),
    }
}

fn failed_text(action: RunAction, count: usize) -> String {
    match action {
        RunAction::Prune => format!("{count} delete(s) failed during prune"),
        _ => format!("{count} item(s) failed during push"),
    }
}

/// The request that opens a run over `plan`.
pub(crate) fn create_run_body(plan: &LockstepPlan) -> types::CreateSyncRunRequest {
    let counts = plan.counts;
    types::CreateSyncRunRequest {
        counts: types::LockstepPlanCounts {
            delete: counts.delete as f64,
            keep: counts.keep as f64,
            update: counts.update as f64,
            upload: counts.upload as f64,
        },
        source_root: plan.source_root.to_string_lossy().into_owned(),
    }
}

/// The finalize request recording how a run over `plan` ended.
pub(crate) fn outcome_body(
    action: RunAction,
    plan: &LockstepPlan,
    outcome: &RunOutcome,
) -> types::CompleteSyncRunRequest {
    let counts = plan.counts;
    let error = match &outcome.interruption {
        Some(Interruption::Cancelled) => Some("Run cancelled by user".to_owned()),
        Some(Interruption::Failed(error)) => Some(error.to_string()),
        None => (outcome.failed > 0).then(|| failed_text(action, outcome.failed)),
    };
    types::CompleteSyncRunRequest {
        counts: types::SyncRunOutcomeCounts {
            delete: counts.delete as f64,
            keep: counts.keep as f64,
            update: counts.update as f64,
            upload: counts.upload as f64,
            capped: outcome.capped as f64,
            failed: outcome.failed as f64,
            planned: planned_changes(&plan.items).len() as f64,
            pushed: outcome.applied as f64,
        },
        error,
        status: match outcome.status() {
            RunStatus::Cancelled => types::CompleteSyncRunRequestStatus::Cancelled,
            RunStatus::Completed => types::CompleteSyncRunRequestStatus::Completed,
            RunStatus::Failed => types::CompleteSyncRunRequestStatus::Failed,
        },
    }
}

/// A sync run Pane View has opened, until it is finished.
pub(crate) struct SyncRun<'a> {
    action: RunAction,
    client: &'a PaneViewClient,
    observer: Option<&'a Observer>,
    plan: &'a LockstepPlan,
    id: String,
}

impl<'a> SyncRun<'a> {
    /// A cancel does not abort creation (see `create_sync_run`); the run then applies nothing and
    /// finishes as cancelled.
    pub(crate) async fn open(
        action: RunAction,
        plan: &'a LockstepPlan,
        client: &'a PaneViewClient,
        observer: Option<&'a Observer>,
        cancel: &CancelToken,
    ) -> anyhow::Result<Self> {
        status(observer, "Creating sync run...");
        let id = client
            .create_sync_run(&create_run_body(plan), Some(cancel))
            .await?;
        Ok(Self {
            action,
            client,
            observer,
            plan,
            id,
        })
    }

    pub(crate) fn id(&self) -> &str {
        &self.id
    }

    /// Records the outcome, then returns the run's summary, or what ended it. A run left
    /// unfinalized outranks a cancel or a stopping error: it is the one the user must act on.
    pub(crate) async fn finish(self, outcome: RunOutcome) -> anyhow::Result<RunSummary> {
        let observer = self.observer;
        let finalize_error = self
            .client
            .finalize_sync_run(
                &self.id,
                &outcome_body(self.action, self.plan, &outcome),
                |error| {
                    status(
                        observer,
                        format!(
                            "Warning: failed to finalize sync run, retrying: {}",
                            format_push_error(error)
                        ),
                    );
                },
            )
            .await;
        if let Some(finalize_error) = finalize_error {
            status(
                observer,
                format!(
                    "Warning: failed to finalize sync run: {}",
                    format_push_error(&finalize_error)
                ),
            );
            return Err(self.unfinalized(&outcome, &finalize_error).into());
        }
        match outcome.interruption {
            Some(Interruption::Cancelled) => {
                emit(
                    observer,
                    RunEvent::Complete(self.summary(&outcome, RunStatus::Cancelled, None)),
                );
                Err(Cancelled.into())
            }
            Some(Interruption::Failed(error)) => Err(error),
            None => {
                let message = (self.action == RunAction::Prune && outcome.skipped > 0).then(|| {
                    format!(
                        "{} delete(s) skipped because {BACK_IN_SOURCE_REASON}.",
                        outcome.skipped
                    )
                });
                let summary = self.summary(&outcome, outcome.status(), message);
                emit(observer, RunEvent::Complete(summary.clone()));
                Ok(summary)
            }
        }
    }

    fn summary(
        &self,
        outcome: &RunOutcome,
        status: RunStatus,
        message: Option<String>,
    ) -> RunSummary {
        let skipped = (self.action == RunAction::Prune).then_some(outcome.skipped);
        RunSummary::ran(
            self.action,
            status,
            self.plan.counts,
            (outcome.applied, outcome.failed, skipped),
            message,
        )
    }

    /// Reports the run as failed, naming it so it can be cancelled in Pane View.
    fn unfinalized(
        &self,
        outcome: &RunOutcome,
        finalize_error: &anyhow::Error,
    ) -> UnfinalizedSyncRun {
        let done = applied_text(self.action, outcome.applied);
        let ending = match &outcome.interruption {
            Some(Interruption::Cancelled) => format!("Run cancelled after {done}"),
            Some(Interruption::Failed(error)) => format!("{error} Stopped after {done}"),
            None => done,
        };
        let message = format!(
            "{ending}, but sync run {} could not be finalized: {}. Pane View shows it as running \
             until it is cancelled on the management page.",
            self.id,
            format_push_error(finalize_error)
        );
        let summary = self.summary(outcome, RunStatus::Failed, Some(message.clone()));
        emit(self.observer, RunEvent::Complete(summary.clone()));
        UnfinalizedSyncRun {
            action: self.action,
            intended_status: outcome.status(),
            message,
            sync_run_id: self.id.clone(),
            summary,
        }
    }
}
