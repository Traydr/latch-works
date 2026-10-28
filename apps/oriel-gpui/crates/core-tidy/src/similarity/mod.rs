//! The prints Tidy's similarity pass makes, as glazier-core's `similarity/` makes them: the
//! 64-bit fingerprint that finds similar sets (`group.ts` compares it to its thresholds) and the
//! detail print Spot variants splits those sets with (`detail.ts`). Both were tuned on the owner's
//! library, so they must equal glazier-core's bit for bit; the conformance vectors in
//! `apps/oriel-gpui/conformance/fingerprints` check that they do.

pub mod detail;
pub mod fingerprint;
pub mod phash;
pub mod vips;

pub use detail::{
    DETAIL_SIZE, DETAIL_VERSION, DetailDifference, detail_difference, detail_from_grey,
    detail_of_still, is_variant, normalize_detail,
};
pub use fingerprint::{
    Fingerprint, FingerprintError, animation_frame_times, fingerprint_animation, fingerprint_still,
    fingerprint_video, sampled_pages,
};
pub use phash::{Hash64, PHASH_INPUT_SIZE, perceptual_hash};
pub use vips::{ImageProbe, Vips, VipsError};
