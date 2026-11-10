//! What Convert and Shrink would change, which Overview counts: the archive policy's candidates
//! and Shrink's AV1 estimate.

pub mod candidates;
pub mod shrink;

pub use candidates::{
    CandidateScan, OptimizeCandidate, extension_fixes, find_optimize_candidates,
    summarize_candidates,
};
pub use shrink::find_shrink_candidates;
