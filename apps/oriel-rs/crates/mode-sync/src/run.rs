//! A run as the page shows it, from Electron Oriel's `useLockstepController.ts`, `run-metrics.ts`,
//! `run-lifecycle.ts` and `run-formatters.ts`: the events a run reports folded into progress,
//! each item's state for the plan tree, the run log, the throughput, and when Prune may run.

use std::collections::HashMap;
use std::time::Instant;

use oriel_core_index::ScanArchiveProgress;
use oriel_core_sync::{PlanCounts, RunAction, RunEvent, RunStatus};

/// Lines the run log keeps; older ones scroll away.
const LOG_LINES: usize = 200;

/// How far back the current throughput and the time left look.
const RATE_WINDOW_MS: f64 = 10_000.0;

/// Spans kept per run; older neighbours merge so a long push stays cheap to chart.
const MAX_SPANS: usize = 1500;

/// What one item of a push or prune has come to.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ItemState {
    Active,
    Done,
    Skipped(String),
    Failed(String),
}

impl ItemState {
    /// Done or skipped: the item needs nothing more.
    pub fn is_settled(&self) -> bool {
        matches!(self, Self::Done | Self::Skipped(_))
    }
}

/// Where the run is.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RunPhase {
    Idle,
    Preparing,
    Items,
    Done,
    Cancelled,
    Error,
}

/// One pushed item's bytes and when it moved them, in milliseconds since the run started.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct TransferSpan {
    pub from: f64,
    pub to: f64,
    pub bytes: f64,
}

/// A run's progress, `RunProgressState`.
#[derive(Clone, Debug)]
pub struct RunProgress {
    pub kind: Option<RunAction>,
    pub phase: RunPhase,
    pub started_at: Option<Instant>,
    /// When the work list was known, in milliseconds since `started_at`.
    pub queued_at: Option<f64>,
    pub ended_at: Option<f64>,
    pub item_total: usize,
    pub pushed: usize,
    pub failed: usize,
    pub skipped: usize,
    pub bytes_total: u64,
    pub bytes_done: u64,
    pub bytes_failed: u64,
    pub scan_files_found: usize,
    pub bytes_hashed: u64,
    pub spans: Vec<TransferSpan>,
    pub failure_times: Vec<f64>,
}

impl Default for RunProgress {
    fn default() -> Self {
        Self {
            kind: None,
            phase: RunPhase::Idle,
            started_at: None,
            queued_at: None,
            ended_at: None,
            item_total: 0,
            pushed: 0,
            failed: 0,
            skipped: 0,
            bytes_total: 0,
            bytes_done: 0,
            bytes_failed: 0,
            scan_files_found: 0,
            bytes_hashed: 0,
            spans: Vec::new(),
            failure_times: Vec::new(),
        }
    }
}

/// The run on screen: its progress, its label, its log, and each item's state.
#[derive(Clone, Debug, Default)]
pub struct RunState {
    pub running: bool,
    pub label: String,
    pub logs: Vec<String>,
    pub progress: RunProgress,
    pub item_states: HashMap<String, ItemState>,
    item_started_at: HashMap<String, f64>,
    last_logged_scan: Option<String>,
}

impl RunState {
    /// A new run of `kind`, labelled until its first event.
    pub fn begin(&mut self, kind: RunAction, label: &str) {
        *self = Self {
            running: true,
            label: label.to_owned(),
            logs: vec![label.to_owned()],
            progress: RunProgress {
                kind: Some(kind),
                phase: RunPhase::Preparing,
                started_at: Some(Instant::now()),
                ..RunProgress::default()
            },
            ..Self::default()
        };
    }

    /// Milliseconds since the run started.
    pub fn now_ms(&self) -> f64 {
        self.progress
            .started_at
            .map_or(0.0, |started| started.elapsed().as_secs_f64() * 1000.0)
    }

    fn log(&mut self, line: String) {
        self.logs.push(line);
        if self.logs.len() > LOG_LINES + 1 {
            let excess = self.logs.len() - LOG_LINES - 1;
            self.logs.drain(..excess);
        }
    }

    /// Folds one event in, as `applyRunEvent` does. A push or prune plans first and reports that
    /// plan's completion too; only the run's own completion ends it.
    pub fn apply(&mut self, event: RunEvent) {
        let now = self.now_ms();
        match event {
            RunEvent::Status(message) => {
                self.label = message.clone();
                self.log(message);
            }
            RunEvent::ScanProgress(progress) => {
                let (message, key) = match &progress {
                    ScanArchiveProgress::Hashing {
                        path, files_found, ..
                    } => (
                        format!("Hashing {path} ({files_found} files)"),
                        format!("hashing:{path}"),
                    ),
                    ScanArchiveProgress::Scanning {
                        files_found,
                        skipped,
                        path,
                    } => (
                        format!("Scanning ({files_found} files, {skipped} skipped)"),
                        format!("scanning:{}", path.as_deref().unwrap_or("")),
                    ),
                };
                match progress {
                    ScanArchiveProgress::Hashing {
                        files_found,
                        bytes_hashed,
                        ..
                    } => {
                        self.progress.scan_files_found = files_found;
                        self.progress.bytes_hashed = bytes_hashed;
                    }
                    ScanArchiveProgress::Scanning { files_found, .. } => {
                        self.progress.scan_files_found = files_found;
                    }
                }
                self.label = message.clone();
                if self.last_logged_scan.as_deref() != Some(key.as_str()) {
                    self.last_logged_scan = Some(key);
                    self.log(message);
                }
            }
            RunEvent::ItemsQueued {
                total, total_bytes, ..
            } => {
                self.item_states.clear();
                self.item_started_at.clear();
                let progress = &mut self.progress;
                progress.phase = RunPhase::Items;
                progress.item_total = total;
                progress.bytes_total = total_bytes;
                progress.bytes_done = 0;
                progress.bytes_failed = 0;
                progress.queued_at = Some(now);
                progress.spans.clear();
                progress.failure_times.clear();
            }
            RunEvent::ItemStart { path, total, .. } => {
                self.item_started_at.insert(path.clone(), now);
                self.item_states.insert(path, ItemState::Active);
                self.progress.phase = RunPhase::Items;
                self.progress.item_total = total;
            }
            RunEvent::ItemSuccess {
                action,
                bytes,
                current,
                path,
                total,
            } => {
                self.log(format!("[{current}/{total}] {action} {path}"));
                let from = self.item_started_at.remove(&path).unwrap_or(now);
                self.item_states.insert(path, ItemState::Done);
                let bytes = bytes.unwrap_or(0);
                let progress = &mut self.progress;
                progress.pushed += 1;
                progress.bytes_done += bytes;
                if bytes > 0 {
                    append_span(
                        &mut progress.spans,
                        TransferSpan {
                            from,
                            to: now,
                            bytes: bytes as f64,
                        },
                    );
                }
            }
            RunEvent::ItemSkipped {
                current,
                path,
                reason,
                total,
                ..
            } => {
                self.log(format!("[{current}/{total}] skipped {path}: {reason}"));
                self.item_states.insert(path, ItemState::Skipped(reason));
                self.progress.skipped += 1;
            }
            RunEvent::ItemFailure {
                bytes,
                current,
                error,
                path,
                total,
                ..
            } => {
                self.log(format!("[{current}/{total}] failed {path}: {error}"));
                self.item_states.insert(path, ItemState::Failed(error));
                self.progress.failed += 1;
                self.progress.bytes_failed += bytes.unwrap_or(0);
                self.progress.failure_times.push(now);
                let excess = self.progress.failure_times.len().saturating_sub(500);
                self.progress.failure_times.drain(..excess);
            }
            RunEvent::Cancelled => {
                self.label = "Run cancelled.".to_owned();
                self.progress.phase = RunPhase::Cancelled;
                self.progress.ended_at = Some(now);
            }
            RunEvent::Complete(summary) => {
                let own = self.progress.kind == Some(summary.action);
                if !own {
                    return;
                }
                self.label = summary.message.clone().unwrap_or_else(|| {
                    format!("{} {}", summary.action.as_str(), summary.status.as_str())
                });
                let progress = &mut self.progress;
                progress.phase = if summary.status == RunStatus::Cancelled {
                    RunPhase::Cancelled
                } else {
                    RunPhase::Done
                };
                progress.failed = summary.failed;
                progress.pushed = summary.pushed;
                progress.ended_at = Some(now);
            }
        }
    }

    /// Ends the run when its request returned.
    pub fn finish(&mut self, phase: RunPhase, label: Option<String>) {
        self.running = false;
        if let Some(label) = label {
            self.label = label;
        }
        if !matches!(self.progress.phase, RunPhase::Cancelled | RunPhase::Done)
            || phase == RunPhase::Error
        {
            self.progress.phase = phase;
        }
        if self.progress.ended_at.is_none() {
            self.progress.ended_at = Some(self.now_ms());
        }
    }

    /// The share done, by bytes once a push or prune has its list, by items before that.
    pub fn ratio(&self) -> Option<f32> {
        let progress = &self.progress;
        if progress.phase == RunPhase::Done {
            return Some(1.0);
        }
        if progress.bytes_total > 0 {
            return Some(
                ((progress.bytes_done + progress.bytes_failed) as f64 / progress.bytes_total as f64)
                    as f32,
            );
        }
        if progress.item_total > 0 {
            return Some(
                (progress.pushed + progress.failed + progress.skipped) as f32
                    / progress.item_total as f32,
            );
        }
        None
    }

    /// Bytes per second near the run's end (`currentRate`), or its average once it has ended.
    pub fn rate(&self) -> f64 {
        let now = self.progress.ended_at.unwrap_or_else(|| self.now_ms());
        let since = self.progress.queued_at.unwrap_or(now);
        if !self.running {
            let seconds = (now - since) / 1000.0;
            return if seconds > 0.0 {
                self.progress.bytes_done as f64 / seconds
            } else {
                0.0
            };
        }
        current_rate(now, since, &self.progress.spans)
    }

    /// Milliseconds left at the current rate, or `None` with nothing to go on.
    pub fn remaining_ms(&self) -> Option<f64> {
        let progress = &self.progress;
        if progress.bytes_total > 0 {
            let remaining =
                progress.bytes_total as f64 - (progress.bytes_done + progress.bytes_failed) as f64;
            return estimate_remaining_ms(remaining, self.rate());
        }
        let processed = progress.pushed + progress.failed + progress.skipped;
        if processed == 0 {
            return None;
        }
        let queued_for = self.now_ms() - progress.queued_at.unwrap_or(0.0);
        Some((progress.item_total - processed) as f64 * queued_for / processed as f64)
    }
}

/// The part of `span`'s bytes moved between `from` and `to`, at a steady rate.
fn bytes_within(span: &TransferSpan, from: f64, to: f64) -> f64 {
    let duration = span.to - span.from;
    if duration <= 0.0 {
        return if span.from >= from && span.from < to {
            span.bytes
        } else {
            0.0
        };
    }
    let overlap = span.to.min(to) - span.from.max(from);
    if overlap > 0.0 {
        span.bytes * overlap / duration
    } else {
        0.0
    }
}

/// `currentRate`: bytes per second over the ten seconds up to the latest finished item, counting
/// from no earlier than `since`; once nothing has finished for a whole window, up to `now`.
pub fn current_rate(now: f64, since: f64, spans: &[TransferSpan]) -> f64 {
    let latest = spans.iter().fold(since, |latest, span| latest.max(span.to));
    let window_end = if now - latest > RATE_WINDOW_MS {
        now
    } else {
        latest
    };
    let window_start = since.max(window_end - RATE_WINDOW_MS);
    let seconds = (window_end - window_start) / 1000.0;
    if seconds <= 0.0 {
        return 0.0;
    }
    spans
        .iter()
        .map(|span| bytes_within(span, window_start, window_end))
        .sum::<f64>()
        / seconds
}

/// `estimateRemainingMs`.
pub fn estimate_remaining_ms(remaining_bytes: f64, bytes_per_second: f64) -> Option<f64> {
    if remaining_bytes <= 0.0 {
        Some(0.0)
    } else if bytes_per_second <= 0.0 {
        None
    } else {
        Some(remaining_bytes / bytes_per_second * 1000.0)
    }
}

/// `throughputSeries`: the run's throughput as `buckets` evenly spaced rates.
pub fn throughput_series(
    buckets: usize,
    started_at: f64,
    ended_at: f64,
    spans: &[TransferSpan],
) -> Vec<f64> {
    let bucket_ms = (ended_at - started_at).max(1000.0) / buckets as f64;
    let mut rates = vec![0.0; buckets];
    for span in spans {
        let first = ((span.from - started_at) / bucket_ms).floor().max(0.0) as usize;
        let last = (((span.to - started_at) / bucket_ms).floor() as usize).min(buckets - 1);
        for (index, rate) in rates.iter_mut().enumerate().take(last + 1).skip(first) {
            let bucket_start = started_at + index as f64 * bucket_ms;
            *rate +=
                bytes_within(span, bucket_start, bucket_start + bucket_ms) / (bucket_ms / 1000.0);
        }
    }
    rates
}

/// `appendSpan`: keeps at most `MAX_SPANS`, merging neighbours pairwise when full.
fn append_span(spans: &mut Vec<TransferSpan>, span: TransferSpan) {
    if spans.len() >= MAX_SPANS {
        let merged: Vec<TransferSpan> = spans
            .chunks(2)
            .map(|pair| match pair {
                [a, b] => TransferSpan {
                    from: a.from.min(b.from),
                    to: a.to.max(b.to),
                    bytes: a.bytes + b.bytes,
                },
                [a] => *a,
                _ => unreachable!("chunks of two"),
            })
            .collect();
        *spans = merged;
    }
    spans.push(span);
}

/// Whether Prune may run, and if not, why (`pruneAvailability`). Prune deletes exactly what the
/// reviewed plan lists, once, and waits for that plan's push when it has one: a moved file is a
/// delete and an upload, and the old path should go only once the new one has landed.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PruneAvailability {
    Enabled { delete_count: usize },
    Disabled { reason: &'static str },
}

pub fn prune_availability(
    plan: Option<(&str, PlanCounts)>,
    pruned_plan_id: Option<&str>,
    push_completed: bool,
) -> PruneAvailability {
    let Some((plan_id, counts)) = plan else {
        return PruneAvailability::Disabled {
            reason: "Run Plan first. Prune deletes only what a reviewed plan lists.",
        };
    };
    if Some(plan_id) == pruned_plan_id {
        return PruneAvailability::Disabled {
            reason: "This plan's deletes were already sent to Prune. Run Plan again to prune more.",
        };
    }
    if counts.delete == 0 {
        return PruneAvailability::Disabled {
            reason: "The reviewed plan has no remote deletes.",
        };
    }
    if counts.to_push() > 0 && !push_completed {
        return PruneAvailability::Disabled {
            reason: "Push this plan's uploads and updates first; Prune unlocks when the push \
                     completes.",
        };
    }
    PruneAvailability::Enabled {
        delete_count: counts.delete,
    }
}

/// "3 remote entries", "1 remote entry".
pub fn describe_remote_entries(count: usize) -> String {
    format!(
        "{count} remote {}",
        if count == 1 { "entry" } else { "entries" }
    )
}

/// `formatClock`: "0:41" or "1:02:05".
pub fn format_clock(ms: f64) -> String {
    let total = (ms / 1000.0).round().max(0.0) as u64;
    let (hours, minutes, seconds) = (total / 3600, total % 3600 / 60, total % 60);
    if hours > 0 {
        format!("{hours}:{minutes:02}:{seconds:02}")
    } else {
        format!("{minutes}:{seconds:02}")
    }
}

/// `formatAgo`: "just now", "4m ago", "2h ago", "3d ago".
pub fn format_ago(at_ms: i64, now_ms: i64) -> String {
    let minutes = (now_ms - at_ms).div_euclid(60_000);
    if minutes < 1 {
        "just now".to_owned()
    } else if minutes < 60 {
        format!("{minutes}m ago")
    } else if minutes / 60 < 24 {
        format!("{}h ago", minutes / 60)
    } else {
        format!("{}d ago", minutes / 60 / 24)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prune_waits_for_the_plans_push_and_runs_once() {
        let counts = PlanCounts {
            delete: 2,
            keep: 1,
            update: 0,
            upload: 1,
        };
        assert!(matches!(
            prune_availability(None, None, false),
            PruneAvailability::Disabled { .. }
        ));
        assert!(matches!(
            prune_availability(Some(("p", counts)), None, false),
            PruneAvailability::Disabled { reason } if reason.starts_with("Push this plan's")
        ));
        assert_eq!(
            prune_availability(Some(("p", counts)), None, true),
            PruneAvailability::Enabled { delete_count: 2 }
        );
        assert!(matches!(
            prune_availability(Some(("p", counts)), Some("p"), true),
            PruneAvailability::Disabled { reason } if reason.contains("Run Plan again")
        ));
    }

    #[test]
    fn rates_spread_bytes_over_their_transfer() {
        let spans = [TransferSpan {
            from: 0.0,
            to: 2000.0,
            bytes: 2000.0,
        }];
        assert_eq!(current_rate(2000.0, 0.0, &spans), 1000.0);
        assert_eq!(estimate_remaining_ms(1000.0, 1000.0), Some(1000.0));
        assert_eq!(estimate_remaining_ms(10.0, 0.0), None);
        let series = throughput_series(4, 0.0, 2000.0, &spans);
        assert_eq!(series, vec![1000.0; 4]);
    }

    #[test]
    fn formats_clocks_and_ages() {
        assert_eq!(format_clock(41_000.0), "0:41");
        assert_eq!(format_clock(3_725_000.0), "1:02:05");
        assert_eq!(format_ago(0, 30_000), "just now");
        assert_eq!(format_ago(0, 4 * 60_000), "4m ago");
        assert_eq!(format_ago(0, 3 * 3_600_000), "3h ago");
        assert_eq!(format_ago(0, 50 * 3_600_000), "2d ago");
    }
}
