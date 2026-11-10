//! What a run reports as it goes, as lockstep-core's run events, and the summary it ends with.

use std::sync::Arc;
use std::time::SystemTime;

use serde::{Deserialize, Serialize};

use crate::scan::ScanArchiveProgress;
use crate::sync_plan::{PlanCounts, SyncPlanAction};

/// Which run: Sync's four buttons.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RunAction {
    Plan,
    Push,
    Prune,
    Doctor,
}

impl RunAction {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Plan => "plan",
            Self::Push => "push",
            Self::Prune => "prune",
            Self::Doctor => "doctor",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RunStatus {
    Cancelled,
    Completed,
    Failed,
}

impl RunStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Cancelled => "cancelled",
            Self::Completed => "completed",
            Self::Failed => "failed",
        }
    }
}

/// How a run ended.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RunSummary {
    pub action: RunAction,
    pub completed_at: SystemTime,
    pub status: RunStatus,
    /// What a push sent or a prune deleted.
    pub applied: usize,
    pub failed: usize,
    /// Prune only: planned deletes left alone because the file is back in the source folder.
    pub skipped: Option<usize>,
    pub message: Option<String>,
    pub plan_counts: Option<PlanCounts>,
}

impl RunSummary {
    fn ended(action: RunAction, status: RunStatus, plan_counts: Option<PlanCounts>) -> Self {
        Self {
            action,
            completed_at: SystemTime::now(),
            status,
            applied: 0,
            failed: 0,
            skipped: None,
            message: None,
            plan_counts,
        }
    }

    /// A plan that was made.
    pub fn planned(counts: PlanCounts) -> Self {
        Self::ended(RunAction::Plan, RunStatus::Completed, Some(counts))
    }

    /// A push or prune whose plan held nothing for it.
    pub(crate) fn nothing_to_do(action: RunAction, counts: PlanCounts) -> Self {
        Self {
            message: Some(format!("Nothing to {}.", action.as_str())),
            ..Self::ended(action, RunStatus::Completed, Some(counts))
        }
    }

    /// The doctor's checks, all passed or not.
    pub(crate) fn checked(ok: bool) -> Self {
        let status = if ok {
            RunStatus::Completed
        } else {
            RunStatus::Failed
        };
        Self {
            failed: usize::from(!ok),
            message: Some(
                if ok {
                    "All checks passed."
                } else {
                    "Some checks failed."
                }
                .to_owned(),
            ),
            ..Self::ended(RunAction::Doctor, status, None)
        }
    }

    /// A push or prune that ran its items.
    pub(crate) fn ran(
        action: RunAction,
        status: RunStatus,
        plan_counts: PlanCounts,
        (applied, failed, skipped): (usize, usize, Option<usize>),
        message: Option<String>,
    ) -> Self {
        Self {
            applied,
            failed,
            skipped,
            message,
            ..Self::ended(action, status, Some(plan_counts))
        }
    }
}

/// One thing a run reports, `LockstepRunEvent`.
#[derive(Clone, Debug, PartialEq)]
pub enum RunEvent {
    Complete(RunSummary),
    ItemFailure {
        action: SyncPlanAction,
        /// Size of the local file, when the item uploads one.
        bytes: Option<u64>,
        current: usize,
        error: String,
        path: String,
        total: usize,
    },
    ItemSkipped {
        action: SyncPlanAction,
        current: usize,
        path: String,
        reason: String,
        total: usize,
    },
    ItemStart {
        action: SyncPlanAction,
        bytes: Option<u64>,
        current: usize,
        path: String,
        total: usize,
    },
    ItemSuccess {
        action: SyncPlanAction,
        bytes: Option<u64>,
        current: usize,
        path: String,
        total: usize,
    },
    /// Sent once a push or prune knows its work list, before the first item starts.
    ItemsQueued {
        action: RunAction,
        total: usize,
        total_bytes: u64,
    },
    ScanProgress(ScanArchiveProgress),
    Status(String),
}

/// Where a run sends its events. It is called from the run's threads, so it must be quick; Sync
/// forwards them to the window through a channel.
pub type Observer = Arc<dyn Fn(RunEvent) + Send + Sync>;

pub(crate) fn emit(observer: Option<&Observer>, event: RunEvent) {
    if let Some(observer) = observer {
        observer(event);
    }
}

pub(crate) fn status(observer: Option<&Observer>, message: impl Into<String>) {
    emit(observer, RunEvent::Status(message.into()));
}
