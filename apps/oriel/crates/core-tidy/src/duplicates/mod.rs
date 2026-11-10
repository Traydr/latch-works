//! Duplicate sets and the copy each keeps.

pub mod dismissals;
pub mod keeper;
pub mod queries;
pub mod sets;

pub use dismissals::{Dismissals, add_dismissal, list_dismissals, remove_dismissal};
pub use queries::{compute_similar_clusters, fingerprint_coverage};
pub use sets::{
    ComputedSet, PageRequest, build_duplicate_sets, checking_sets, duplicate_totals, open_sets,
    page_duplicate_sets, pairs_to_compare, removals_for, stills_to_print,
};
