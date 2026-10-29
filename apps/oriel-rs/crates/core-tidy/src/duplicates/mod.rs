//! Duplicate sets and the copy each keeps, from glazier-core's `duplicates/`.

pub mod dismissals;
pub mod keeper;
pub mod queries;
pub mod sets;

pub use dismissals::{Dismissals, add_dismissal, remove_dismissal};
pub use keeper::{KeeperCandidate, compare_keepers, keep_reason, rank_keepers};
pub use queries::{FingerprintCoverage, compute_similar_clusters, fingerprint_coverage};
pub use sets::{
    ComputedSet, PageRequest, build_duplicate_sets, duplicate_totals, open_sets,
    page_duplicate_sets, removals_for,
};
