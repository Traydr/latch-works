//! Tidy's engine (plan 063): [`TidyEngine`], and the values it takes and answers with in
//! [`contract`]. Every operation takes its place in the engine's one queue when it is asked for
//! and runs, as a [`Queued`], on the caller's thread with the caller's [`Progress`]. Inside:
//!
//! - `catalog`: the SQLite catalog on `oriel-runtime`'s SQLite thread, and the Library's queries;
//! - `scan`: walking a root, naming formats from bytes, the junk rules;
//! - `passes`: sniffing, probing (libvips and ffprobe), hashing, loudness (ffmpeg),
//!   fingerprints and detail prints, each on worker threads;
//! - `similarity`: the prints and the similar groups they make;
//! - `duplicates`: identical and similar sets, the copy each keeps, and Spot variants;
//! - `optimize`: what Convert and Shrink would change, for Overview's numbers;
//! - `plans`: the planner, the executor, holding and the journal, which change the archive;
//! - `engine`: the queue, and the operations the Tidy UI runs through it.
//!
//! Unit tests beside each rule pin it, and `tests/round_trip.rs` makes every change on an archive
//! built at test time and checks that its Undo restores it exactly.

mod catalog;
mod collation;
pub mod contract;
mod duplicates;
mod engine;
mod media;
mod optimize;
mod passes;
mod paths;
mod plans;
mod scan;
mod similarity;

pub use engine::{
    AnalysisKind, AnalysisReport, Applied, FollowUp, FollowUpReport, Performed, PlanFailed, Queued,
    Restored, ScanReport, TidiedUp, TidyEngine, TidyStep, Undone,
};
pub use passes::{Media, Progress, Quiet};
pub use paths::{relative_within, roots_overlap, sandbox_rule};
pub use plans::planner::PlanRequestError;

/// What the examples, the integration tests and xtask's measurements read from inside the engine:
/// the catalog itself, the prints, and the steps a change is made of. Not for the app.
#[doc(hidden)]
pub mod internals {
    pub use crate::catalog::rows::{FINGERPRINTABLE_SQL, to_absolute_path};
    pub use crate::catalog::{Catalog, catalog_counts};
    pub use crate::duplicates::sets::build_duplicate_sets;
    pub use crate::media::still::encode_still_to_avif;
    pub use crate::scan::sniff_file;
    pub use crate::similarity::{
        ClusterKind, DETAIL_VERSION, FINGERPRINT_VERSION, Fingerprint, Hash64, SAMPLE_POSITIONS,
        SimilarCluster, StillLook, detail_difference, detail_of_still, fingerprint_still,
        fingerprint_video, fingerprint_video_in_runs, fingerprint_video_with, frame_run_pixels,
        frames_show_variant, is_variant, look_at_still, look_measures, look_shows_variant,
        normalize_detail, open_libvips, plan_frame_runs, still_threshold, video_frame_pixels,
    };
}
