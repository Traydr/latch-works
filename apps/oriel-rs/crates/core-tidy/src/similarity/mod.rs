//! The prints Tidy's similarity pass makes, as glazier-core's `similarity/` makes them: the
//! 64-bit fingerprint that finds similar sets (`group.rs` compares it to its thresholds) and the
//! detail print Spot variants splits those sets with (`detail.rs`). Both were tuned on the owner's
//! library, so they must equal glazier-core's bit for bit; the conformance vectors in
//! `apps/oriel-rs/conformance/fingerprints` check that they do.

pub mod detail;
pub mod fingerprint;
pub mod group;
pub mod phash;
pub mod vips;

pub use detail::{
    DETAIL_SIZE, DETAIL_VERSION, DetailDifference, detail_difference, detail_from_grey,
    detail_of_still, is_variant, normalize_detail,
};
pub use fingerprint::{
    Fingerprint, FingerprintError, SAMPLE_POSITIONS, animation_frame_times, fingerprint_animation,
    fingerprint_still, fingerprint_video, fingerprint_video_with, sampled_pages, video_frame_hash,
};
pub use group::{
    ClusterKind, DisjointSets, FingerprintedFile, SimilarCluster, group_similar_files,
    motion_threshold, still_threshold,
};
pub use phash::{Hash64, PHASH_INPUT_SIZE, perceptual_hash};
pub use vips::{
    ImageProbe, LIBVIPS_VARIABLE, LibvipsSource, Vips, VipsError, accepts_libvips_version,
    locate_libvips,
};
