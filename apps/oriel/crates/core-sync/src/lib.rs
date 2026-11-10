//! `lockstep-core` in Rust: what Sync does between a local archive and Pane View.
//!
//! - [`plan_sync`]: the archive against Pane View's snapshot, through the hash cache, as a plan of
//!   uploads, updates, keeps and deletes;
//! - [`push_changes`]: a plan's uploads and updates through a bounded upload queue, each file
//!   hashed as it streams and sent with the checksum and length headers Pane View signs
//!   (plan 026);
//! - [`prune_deleted`]: a reviewed plan's deletes, each re-checked against the source folder;
//! - [`doctor`]: the source folder, the URL, the token and the snapshot endpoint, checked;
//! - [`HashCache`]: the per-source cache of SHA-256s, in lockstep-core's file format;
//! - [`PaneViewClient`]: Pane View's sync API on `reqwest`, with the request and response types
//!   built from sync-protocol's zod schemas ([`api::types`]).
//!
//! Runs are futures for the tokio thread of `oriel-runtime`; their file work moves to tokio's
//! blocking threads. Each run reports [`RunEvent`]s and ends with a [`RunSummary`].
//!
//! The Lockstep CLI runs the TypeScript. Its conformance tests write
//! `apps/oriel/conformance/lockstep-core/`, which this crate builds from and tests against
//! (`vectors`). What core-sync does differently on purpose is in `rust_only`.

pub mod api;
mod doctor;
mod events;
mod format;
mod hash_cache;
mod plan;
mod prune;
mod push;
mod rules;
mod rust_only;
mod scan;
mod sync_plan;
mod sync_run;
#[cfg(feature = "test-support")]
pub mod testing;
#[cfg(test)]
mod vectors;

pub use api::{ApiTarget, PaneViewClient};
pub use doctor::{DoctorCheck, DoctorOptions, DoctorResult, doctor};
pub use events::{Observer, RunAction, RunEvent, RunStatus, RunSummary};
pub use hash_cache::hash_cache_path;
pub use plan::{HashMode, LockstepPlan, PlanOptions, PlanResult, plan_sync};
pub use prune::{PruneOptions, prune_deleted};
pub use push::{PushOptions, PushResult, push_changes};
pub use scan::{ScanArchiveProgress, SkipReason, SkippedArchiveEntry};
pub use sync_plan::{PlanCounts, RemoteEntrySnapshot, SyncPlanAction, SyncPlanItem};
pub use sync_run::UnfinalizedSyncRun;
