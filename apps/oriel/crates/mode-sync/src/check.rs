//! What a launch asks of Sync for a check: `ORIEL_SYNC_PLAN=1` plans the active profile at start,
//! and `ORIEL_SYNC_CHECK` sets Sync up in a real window without a server: the plan tree,
//! the run panel and the log otherwise need the local stack.
//! Everything here is made up on the spot and stays in this process: nothing goes over the network,
//! and no file is read or written except the check profile in the run's own data folder.
//!
//! - `form` opens the new-profile form;
//! - `plan` shows a pretend profile with a pretend plan;
//! - `run` shows a pretend push under way, in the shell's activity panel and on the plan's rows;
//! - `done` shows it finished, in the run panel, with a failure;
//! - `clean` shows it finished with none, which leaves Prune enabled, in the top bar and the panel;
//! - `log` shows the same with the run log open.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::SystemTime;

use gpui_kit::{Context, Window};
use oriel_core_domain::{MediaItem, MediaType};
use oriel_core_sync::{LockstepPlan, PlanCounts, RunAction, RunEvent};
use oriel_core_sync::{RemoteEntrySnapshot, SyncPlanAction, SyncPlanItem};
use oriel_launch::Launch;

use crate::profiles::ProfileInput;
use crate::run::RunPhase;
use crate::{PlanFacts, ReviewedPlan, SyncMode};

const SYNC_PLAN: &str = "ORIEL_SYNC_PLAN";
pub const SYNC_CHECK: &str = "ORIEL_SYNC_CHECK";

/// What `ORIEL_SYNC_CHECK` shows; the module's doc says each.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum SyncCheck {
    Form,
    Plan,
    Run,
    Done,
    Clean,
    Log,
}

impl SyncCheck {
    fn parse(value: &str) -> Option<Self> {
        Some(match value {
            "form" => Self::Form,
            "plan" => Self::Plan,
            "run" => Self::Run,
            "done" => Self::Done,
            "clean" => Self::Clean,
            "log" => Self::Log,
            _ => return None,
        })
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct SyncChecks {
    pub plan: bool,
    pub check: Option<SyncCheck>,
}

impl SyncChecks {
    pub(crate) fn of(launch: &Launch) -> Self {
        let check = launch.variables.get(SYNC_CHECK).and_then(|value| {
            let Some(check) = SyncCheck::parse(value) else {
                log::warn!("{SYNC_CHECK} has no check {value:?}");
                return None;
            };
            if !launch.data.is_sandboxed() {
                log::warn!("{SYNC_CHECK} runs only with ORIEL_DATA_DIR set");
                return None;
            }
            Some(check)
        });
        Self {
            plan: launch.variables.is_on(SYNC_PLAN),
            check,
        }
    }
}

/// The server a check profile names. Nothing listens there and nothing is sent.
const CHECK_SERVER: &str = "http://127.0.0.1:9";

/// The push's item that fails, when one does.
const FAILING_ITEM: usize = 5;

/// A pretend picture of `size` bytes at `path`.
fn local(path: &str, size: u64) -> MediaItem {
    let (parent, name) = path.rsplit_once('/').unwrap_or(("", path));
    MediaItem {
        id: path.to_owned(),
        path: path.to_owned(),
        parent_path: parent.to_owned(),
        name: name.to_owned(),
        extension: name.rsplit('.').next().unwrap_or("").to_owned(),
        media_type: MediaType::Image,
        size,
        mtime_ms: 0.,
        sha256: None,
        width: None,
        height: None,
        duration_ms: None,
        page_count: None,
        thumbnail_url: None,
        original_url: None,
    }
}

fn item(action: SyncPlanAction, path: String, size: u64) -> SyncPlanItem {
    let remote = RemoteEntrySnapshot {
        path: path.clone(),
        sha256: None,
        size,
    };
    SyncPlanItem {
        action,
        local: (action != SyncPlanAction::Delete).then(|| local(&path, size)),
        remote: (action != SyncPlanAction::Upload).then_some(remote),
        path,
    }
}

/// A plan of folders with uploads, updates, deletes and keeps.
fn pretend_plan(source_root: PathBuf) -> LockstepPlan {
    let mut items = Vec::new();
    for roll in 1..=6u64 {
        for picture in 1..=8u64 {
            let action = match (roll, picture) {
                (1 | 2, _) => SyncPlanAction::Upload,
                (3, 1..=3) => SyncPlanAction::Update,
                (4, 1..=2) => SyncPlanAction::Delete,
                _ => SyncPlanAction::Keep,
            };
            items.push(item(
                action,
                format!("Roll {roll}/picture-{picture}.jpg"),
                1_500_000 + roll * picture * 40_000,
            ));
        }
    }
    let total_bytes = items
        .iter()
        .filter_map(|item| item.local.as_ref().map(|local| local.size))
        .sum();
    LockstepPlan {
        counts: PlanCounts::of(&items),
        total_files: items.len(),
        total_bytes,
        items,
        skipped_entries: Vec::new(),
        source_root,
    }
}

impl SyncMode {
    /// Sets the page up as `ORIEL_SYNC_CHECK` asks, in a run with its own data folder.
    pub(crate) fn apply_check(
        &mut self,
        check: SyncCheck,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if check == SyncCheck::Form {
            self.start_create_profile(window, cx);
            return;
        }
        let source_root = self.data.sandbox();
        if self.store.active_profile().is_none() {
            let input = ProfileInput {
                name: "Check archive".to_owned(),
                api_url: CHECK_SERVER.to_owned(),
                source_root: source_root.display().to_string(),
                token: Some("check-only".to_owned()),
            };
            if let Err(error) = self.store.create(input) {
                self.error = Some(error.to_string());
                return;
            }
        }
        let Some(profile) = self.store.active_profile().cloned() else {
            return;
        };
        let plan = Arc::new(pretend_plan(source_root));
        let facts = PlanFacts::of(&plan);
        let changes: Vec<(String, u64)> = plan
            .items
            .iter()
            .filter(|item| matches!(item.action, SyncPlanAction::Upload | SyncPlanAction::Update))
            .map(|item| {
                (
                    item.path.clone(),
                    item.local.as_ref().map_or(0, |local| local.size),
                )
            })
            .collect();
        let reviewed = ReviewedPlan {
            id: "check".to_owned(),
            plan,
            profile_id: profile.id.clone(),
            api_url: profile.api_url.clone(),
            source_root: profile.source_root.clone(),
            planned_at: SystemTime::now(),
        };
        self.show_plan(reviewed, facts, cx);
        let push = match check {
            SyncCheck::Form | SyncCheck::Plan => None,
            SyncCheck::Run => Some((false, true)),
            SyncCheck::Done | SyncCheck::Log => Some((true, true)),
            SyncCheck::Clean => Some((true, false)),
        };
        if let Some((finished, fails)) = push {
            self.push_completed = check == SyncCheck::Clean;
            self.pretend_push(&changes, finished, fails, cx);
        }
        self.log_open = check == SyncCheck::Log;
        self.rebuild_rows(cx);
    }

    /// Plays a push's events into the run state: part way through while `finished` is false, and
    /// to its end when it is true, with one failure if `fails`.
    fn pretend_push(
        &mut self,
        changes: &[(String, u64)],
        finished: bool,
        fails: bool,
        cx: &mut Context<Self>,
    ) {
        self.run
            .begin(RunAction::Push, "Pushing uploads and updates...");
        let total = changes.len();
        let total_bytes = changes.iter().map(|(_, size)| size).sum();
        let mut events = vec![RunEvent::ItemsQueued {
            action: RunAction::Push,
            total,
            total_bytes,
        }];
        let reach = if finished { total } else { total / 2 };
        for (at, (path, size)) in changes.iter().take(reach).enumerate() {
            let current = at + 1;
            events.push(RunEvent::ItemStart {
                action: SyncPlanAction::Upload,
                bytes: Some(*size),
                current,
                path: path.clone(),
                total,
            });
            if at == FAILING_ITEM && fails {
                events.push(RunEvent::ItemFailure {
                    action: SyncPlanAction::Upload,
                    bytes: Some(*size),
                    current,
                    error: "The server said 503".to_owned(),
                    path: path.clone(),
                    total,
                });
            } else {
                events.push(RunEvent::ItemSuccess {
                    action: SyncPlanAction::Upload,
                    bytes: Some(*size),
                    current,
                    path: path.clone(),
                    total,
                });
            }
        }
        if !finished && let Some((path, size)) = changes.get(reach) {
            events.push(RunEvent::ItemStart {
                action: SyncPlanAction::Upload,
                bytes: Some(*size),
                current: reach + 1,
                path: path.clone(),
                total,
            });
        }
        for event in events {
            self.run.apply(event);
        }
        if finished {
            let status = if fails { "failed" } else { "completed" };
            self.run
                .finish(RunPhase::Done, Some(format!("push {status}")));
        }
        self.report_activity(cx);
    }
}
