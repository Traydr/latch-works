//! The prints Tidy's similarity pass makes: the 64-bit fingerprint that finds similar sets
//! (`group.rs` compares it to its thresholds) and the detail print and closer look Spot variants
//! splits those sets with (`detail.rs`). The thresholds were tuned on the owner's library with
//! the prints Electron Oriel made, so the arithmetic keeps its steps; a change to how a print is
//! made bumps its version beside its code, and the catalog makes the old ones again.

pub mod detail;
pub mod fingerprint;
pub mod group;
mod libvips;
pub mod phash;
pub mod video_frames;

pub use detail::{
    DETAIL_VERSION, StillLook, detail_difference, detail_of_still, frames_show_variant, is_variant,
    look_at_still, look_measures, look_shows_variant, normalize_detail,
};
pub use fingerprint::{
    FINGERPRINT_VERSION, Fingerprint, FingerprintError, SAMPLE_POSITIONS, animation_frame_times,
    fingerprint_animation, fingerprint_still, fingerprint_video, fingerprint_video_with,
    is_still_print, still_print_sql, video_frame_pixels,
};
pub use group::{
    ClusterKind, DisjointSets, FingerprintedFile, SimilarCluster, group_similar_files,
    still_threshold,
};
pub use libvips::{libvips_loads, open_libvips, shared_libvips};
pub use phash::Hash64;
pub use video_frames::{
    FrameRun, fingerprint_video_in_runs, frame_run_hashes, frame_run_pixels, plan_frame_runs,
    single_frame_runs,
};
