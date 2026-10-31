//! `lockstep-core` in Rust: what Sync does between a local archive and Pane View.
//!
//! - [`plan_sync`]: the archive against Pane View's snapshot, through the hash cache, as a plan of
//!   uploads, updates, keeps and deletes;
//! - [`push_changes`]: a plan's uploads and updates through a bounded upload queue (1 to 8 wide
//!   when asked; else [`UploadWidth`], from 3 up to 6 while more at once adds speed), each file
//!   hashed as it streams and sent with the checksum and length headers Pane View signs
//!   (plan 026);
//! - [`prune_deleted`]: a reviewed plan's deletes, each re-checked against the source folder,
//!   several at once;
//! - [`doctor`]: the source folder, the URL, the token and the snapshot endpoint, checked;
//! - [`HashCache`]: the per-source cache of SHA-256s, in lockstep-core's file format;
//! - [`PaneViewClient`]: Pane View's sync API on `reqwest`, with the request and response types
//!   built from lockstep-core's zod schemas ([`api::types`]).
//!
//! The scan and the plan's pairing are `media-index`'s, from `oriel-core-index`. Runs are futures
//! for the tokio thread of `oriel-runtime`; their file work moves to tokio's blocking threads.
//! Each run reports [`RunEvent`]s, the events lockstep-core's observer receives.
//!
//! The TypeScript package stays, since Pane View, the Lockstep CLI and Electron Oriel use it.
//! `packages/lockstep-core/src/conformance.test.ts` and `api-schema.test.ts` write
//! `apps/oriel-rs/conformance/lockstep-core/`, and this crate builds from and tests against it.

pub mod api;
mod doctor;
mod events;
mod format;
mod hash_cache;
mod plan;
mod prune;
mod push;
mod rules;
#[cfg(feature = "test-support")]
pub mod testing;
mod upload_width;

pub use api::{ApiTarget, PaneViewClient};
pub use doctor::{DoctorCheck, DoctorOptions, DoctorResult, doctor};
pub use events::{Observer, PlanCounts, RunAction, RunEvent, RunStatus, RunSummary};
pub use format::{format_count, iso_timestamp, node_error_message, parse_iso_timestamp};
pub use hash_cache::{
    CACHE_VERSION, HashCache, HashCacheEntry, HashCacheLoad, cache_root, canonical_source_root,
    hash_cache_path, load_hash_cache,
};
pub use plan::{
    HashMode, LockstepPlan, PLAN_HASH_CONCURRENCY, PlanOptions, plan_sync, select_changed_items,
    select_delete_items, select_planning_hash_paths, select_upload_update_items,
};
pub use prune::{PruneOptions, PruneResult, prune_deleted};
pub use push::{PushOptions, PushResult, UnfinalizedSyncRun, push_changes};
pub use rules::{
    DEFAULT_UPLOAD_CONCURRENCY, content_type_for_extension, resolve_hash_mode,
    resolve_local_file_path, resolve_upload_concurrency,
};
pub use upload_width::{MAX_ADAPTIVE_UPLOADS, UploadSample, UploadWidth};
