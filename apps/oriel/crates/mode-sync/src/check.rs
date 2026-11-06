//! `ORIEL_SYNC_CHECK` sets Sync up for a check in a real window, without a server: this Mac allows
//! no scripted input, and the plan tree, the run panel and the log otherwise need the local stack.
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
use std::time::SystemTime;

use gpui_kit::{Context, Window};
use oriel_core_domain::{MediaItem, MediaType};
use oriel_core_index::{RemoteEntrySnapshot, SyncPlanAction, SyncPlanItem};
use oriel_core_sync::{LockstepPlan, PlanCounts, RunAction, RunEvent, RunStatus, RunSummary};

use crate::profiles::ProfileInput;
use crate::{PlanFacts, ReviewedPlan, SyncMode};

pub const CHECK_VARIABLE: &str = "ORIEL_SYNC_CHECK";

/// The server a check profile names. Nothing listens there and nothing is sent.
const CHECK_SERVER: &str = "http://127.0.0.1:9";

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
    let count = |action| items.iter().filter(|item| item.action == action).count();
    LockstepPlan {
        counts: PlanCounts {
            delete: count(SyncPlanAction::Delete),
            keep: count(SyncPlanAction::Keep),
            update: count(SyncPlanAction::Update),
            upload: count(SyncPlanAction::Upload),
        },
        total_files: items.len(),
        total_bytes,
        items,
        skipped: 0,
        skipped_entries: Vec::new(),
        source_root,
    }
}

impl SyncMode {
    /// Sets the page up as `ORIEL_SYNC_CHECK` asks, in a run with its own data folder.
    pub(crate) fn apply_check(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Ok(check) = std::env::var(CHECK_VARIABLE) else {
            return;
        };
        if std::env::var_os("ORIEL_DATA_DIR").is_none() {
            return;
        }
        if check == "form" {
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
        let plan = pretend_plan(source_root);
        self.plan_facts = PlanFacts::of(&plan);
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
        self.plan = Some(ReviewedPlan {
            id: "check".to_owned(),
            plan,
            profile_id: profile.id.clone(),
            api_url: profile.api_url.clone(),
            source_root: profile.source_root.clone(),
            planned_at: SystemTime::now(),
        });
        self.refresh_plan_states();
        if check != "plan" {
            self.push_completed = check == "clean";
            self.pretend_push(&changes, check != "run", check != "clean", cx);
        }
        self.log_open = check == "log";
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
            action: "push".to_owned(),
            total,
            total_bytes,
        }];
        let reach = if finished { total } else { total / 2 };
        for (at, (path, size)) in changes.iter().take(reach).enumerate() {
            let current = at + 1;
            events.push(RunEvent::ItemStart {
                action: "upload".to_owned(),
                bytes: Some(*size),
                current,
                path: path.clone(),
                total,
            });
            if at == 5 && fails {
                events.push(RunEvent::ItemFailure {
                    action: "upload".to_owned(),
                    bytes: Some(*size),
                    current,
                    error: "The server said 503".to_owned(),
                    path: path.clone(),
                    total,
                });
            } else {
                events.push(RunEvent::ItemSuccess {
                    action: "upload".to_owned(),
                    bytes: Some(*size),
                    current,
                    path: path.clone(),
                    total,
                });
            }
        }
        if !finished && let Some((path, size)) = changes.get(reach) {
            events.push(RunEvent::ItemStart {
                action: "upload".to_owned(),
                bytes: Some(*size),
                current: reach + 1,
                path: path.clone(),
                total,
            });
        }
        if finished {
            let status = if fails {
                RunStatus::Failed
            } else {
                RunStatus::Completed
            };
            let mut summary = RunSummary::now(RunAction::Push, status);
            summary.failed = usize::from(fails);
            summary.pushed = total - summary.failed;
            events.push(RunEvent::Complete(summary));
        }
        for event in events {
            self.note_item_state(&event);
            self.run.apply(event);
        }
        if finished {
            self.run.running = false;
        }
        self.report_activity(cx);
    }
}
