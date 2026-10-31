//! Tidy's engine, ported from `glazier-core` (plan 063):
//!
//! - [`catalog`]: the SQLite catalog in glazier-core's schema, on `oriel-runtime`'s SQLite
//!   thread, and the Library's queries;
//! - [`scan`]: walking a root, naming formats from bytes, the junk rules;
//! - [`passes`]: sniffing, probing (libvips and ffprobe), hashing, loudness (ffmpeg),
//!   fingerprints and detail prints, each on worker threads;
//! - [`similarity`]: the prints and the similar groups they make;
//! - [`duplicates`]: identical and similar sets, the copy each keeps, and Spot variants;
//! - [`optimize`]: what Convert and Shrink would change, for Overview's numbers;
//! - [`plans`]: the planner, the executor, holding and the journal, which change the archive;
//! - [`engine`]: what the Tidy UI uses: roots, scans and analysis as `oriel-runtime` jobs, the
//!   queries behind Overview, the Library and Duplicates, and every change with its Undo.
//!
//! Every rule keeps glazier-core's names. With glazier-core gone this is the only
//! implementation: unit tests beside each rule pin it, and `tests/round_trip.rs` makes every
//! change on an archive built at test time and checks that its Undo restores it exactly.

pub mod catalog;
pub mod collation;
pub mod contract;
pub mod duplicates;
pub mod engine;
pub mod media;
pub mod number;
pub mod optimize;
pub mod passes;
pub mod plans;
pub mod scan;
pub mod similarity;

pub use engine::{
    AnalysisReport, Applied, FollowUp, FollowUpReport, Performed, ScanReport, TidiedUp, TidyEngine,
    Undone,
};
