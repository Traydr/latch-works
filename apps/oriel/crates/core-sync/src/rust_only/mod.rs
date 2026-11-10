//! Where core-sync departs from lockstep-core on purpose, by the owner's decision 22 in
//! `docs/plans/063-oriel-rs.md` ("Sync: hashes 16 files at once; uploads up to 6 at once, backing
//! off when more at once stops adding speed; prune sends its deletes in parallel"). These change
//! how fast a run goes, never what it does: the hashes, the cache, the requests and the summary
//! are lockstep-core's at any width. Everything outside this module is a port of lockstep-core,
//! pinned by `conformance/lockstep-core/` where a vector exists.

mod upload_width;

pub(crate) use upload_width::{UploadSample, UploadWidth};

/// How many files a plan hashes at once, where lockstep-core hashes 4. Phase 0 measured cold hashing about 2.5 times faster at 16 on this Mac's SSD.
pub(crate) const PLAN_HASH_CONCURRENCY: usize = 16;

/// How many deletes a prune sends at once, where lockstep-core sends one at a time. None depends
/// on another: Pane View marks each file's library entry deleted on its own row, keyed by path,
/// and soft-deletes the folders left empty only when the run is finalized, after every delete.
/// The plan lists files alone, never folders, so there is no order of children and parents to
/// keep. Each delete still checks its file and the source folder just before it is sent.
pub(crate) const PRUNE_CONCURRENCY: usize = 6;
