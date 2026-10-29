//! `media-index` in Rust, and View's media index.
//!
//! - [`scan`]: `scanArchive`, the archive scan Sync plans from: archive-relative items, the
//!   system folders and junk files skipped, symlinks never followed, read and hashed through
//!   the bounded pools of plan 035.
//! - [`sync_plan`]: `createSyncPlan`, what a push uploads, updates, keeps and deletes.
//! - [`catalog`]: View's scan of a folder (Electron Oriel's `CatalogRuntime`), which streams
//!   batches of absolute-path items to the gallery and records them in the index.
//! - [`media_index`]: View's SQLite index, in the schema and `user_version` of Electron Oriel's
//!   `mediaIndexService.ts`, so either app can open the other's file.
//!
//! The TypeScript package stays, since Pane View, the Lockstep CLI and Electron Oriel use it.
//! `packages/media-index/src/conformance.test.ts` writes vectors to
//! `apps/oriel-rs/conformance/media-index/`, and this crate's tests check the Rust against them.

pub mod catalog;
pub mod media_index;
mod pool;
pub mod scan;
pub mod sync_plan;

pub use catalog::{
    CatalogEvent, CatalogFilters, CatalogItem, CatalogMediaType, CatalogScan, list_folder_children,
};
pub use media_index::{IndexedRow, MEDIA_INDEX_FILE_NAME, MediaIndex, MediaIndexStats};
pub use scan::{
    ArchiveFileFingerprint, HashArchiveItems, ScanArchive, ScanArchiveProgress, ScanArchiveResult,
    SkipReason, SkippedArchiveEntry, escapes_root, fingerprints_match, hash_file_contents,
    locale_compare, modified_ms,
};
pub use sync_plan::{
    RemoteEntrySnapshot, SyncPlan, SyncPlanAction, SyncPlanItem, create_sync_plan,
};
