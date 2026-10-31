//! What a run reports as it goes, as lockstep-core's `LockstepRunEvent`s, and the summary it ends
//! with, which Sync saves on the profile as its last run.

use std::sync::Arc;

use oriel_core_index::ScanArchiveProgress;
use serde::{Deserialize, Serialize};

use crate::format::iso_timestamp;

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

/// A plan's counts, `LockstepPlanCounts`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct PlanCounts {
    pub delete: usize,
    pub keep: usize,
    pub update: usize,
    pub upload: usize,
}

impl PlanCounts {
    /// What a push would send: the uploads and the updates.
    pub fn to_push(&self) -> usize {
        self.upload + self.update
    }

    /// Everything that is not a keep.
    pub fn changes(&self) -> usize {
        self.upload + self.update + self.delete
    }
}

/// How a run ended, `LockstepRunSummary`. The field names and order are the TypeScript's, since
/// the profile's settings file stores it as `lastRun`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunSummary {
    pub action: RunAction,
    pub completed_at: String,
    pub failed: usize,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plan_counts: Option<PlanCounts>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub profile_id: Option<String>,
    pub pushed: usize,
    /// Prune only: planned deletes left alone because the file is back in the source folder.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub skipped: Option<usize>,
    pub status: RunStatus,
}

impl RunSummary {
    /// A summary completed now.
    pub fn now(action: RunAction, status: RunStatus) -> Self {
        Self {
            action,
            completed_at: iso_timestamp(std::time::SystemTime::now()),
            failed: 0,
            message: None,
            plan_counts: None,
            profile_id: None,
            pushed: 0,
            skipped: None,
            status,
        }
    }
}

/// One thing a run reports, `LockstepRunEvent`. `action` on the item events is a plan action
/// (`upload`, `update`, `delete`) or `push`.
#[derive(Clone, Debug, PartialEq)]
pub enum RunEvent {
    Cancelled,
    Complete(RunSummary),
    ItemFailure {
        action: String,
        /// Size of the local file, when the item uploads one.
        bytes: Option<u64>,
        current: usize,
        error: String,
        path: String,
        total: usize,
    },
    ItemSkipped {
        action: String,
        current: usize,
        path: String,
        reason: String,
        total: usize,
    },
    ItemStart {
        action: String,
        bytes: Option<u64>,
        current: usize,
        path: String,
        total: usize,
    },
    ItemSuccess {
        action: String,
        bytes: Option<u64>,
        current: usize,
        path: String,
        total: usize,
    },
    /// Sent once a run knows its work list, before the first item starts.
    ItemsQueued {
        action: String,
        total: usize,
        total_bytes: u64,
    },
    ScanProgress(ScanArchiveProgress),
    Status(String),
}

/// Where a run sends its events. It is called from the run's threads, so it must be quick; Sync
/// forwards them to the window through a channel.
pub type Observer = Arc<dyn Fn(RunEvent) + Send + Sync>;

/// Sends to an observer that may be absent.
pub(crate) fn emit(observer: Option<&Observer>, event: RunEvent) {
    if let Some(observer) = observer {
        observer(event);
    }
}

pub(crate) fn status(observer: Option<&Observer>, message: impl Into<String>) {
    emit(observer, RunEvent::Status(message.into()));
}
