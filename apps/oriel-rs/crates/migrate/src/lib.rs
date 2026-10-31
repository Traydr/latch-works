//! The import of Electron Oriel's data into Oriel RS (plan 063, decision 17).
//!
//! Electron Oriel keeps its data under `~/.latch-works` (`oriel`, `frame-view`, `glazier`,
//! `lockstep`, `lockstep.json`, `hash-cache`), in the same formats Oriel RS writes, so most of the
//! import is a copy into the matching folder of Oriel RS's own root; the window's preferences,
//! which Electron keeps in Chromium's LevelDB, and Tidy's holding places are converted. The
//! import only reads Electron Oriel's data, so Electron Oriel keeps working beside Oriel RS:
//! - files are copied with `std::fs::copy`, which clones on APFS;
//! - SQLite files are never opened where they are, since even a read-only connection may write
//!   the `-shm` file: they are copied with their log and opened as copies;
//! - Chromium's LevelDB is read as files, never opened as a database;
//! - nothing is read while Electron Oriel or an old app runs ([`ElectronData::running`]).
//!
//! On the Oriel RS side, [`import`] stages every area while the app runs, and [`finish_pending`]
//! puts them in place at the next start, moving what Oriel RS had aside, never deleting it.

mod files;
mod import;
pub mod leveldb;
mod report;
mod source;
mod sqlite;
mod survey;

pub use files::{Progress, Size};
pub use import::{STAGING, TIDY_USER_VERSION, finish_pending, import, import_now, pending};
pub use report::{Area, AreaReport, REPORT_FILE, Report, Tokens, bytes, count};
pub use source::{ElectronData, IMPORT_FROM_VARIABLE, Owners, Platform};
pub use survey::Survey;
