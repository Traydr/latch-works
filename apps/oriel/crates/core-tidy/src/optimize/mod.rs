//! What Convert and Shrink would change, which Overview counts: the archive policy's candidates
//! and Shrink's AV1 estimate. Changing the files is Phase 6.

pub mod candidates;
pub mod shrink;

pub use candidates::{
    CandidateHolds, CandidateScan, OptimizeCandidate, extension_fixes, find_optimize_candidates,
    summarize_candidates,
};
pub use shrink::{
    EncodeSpeed, EncodeTiming, ShrinkScan, encode_speed, expected_share, find_shrink_candidates,
};
