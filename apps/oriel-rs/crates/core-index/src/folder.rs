//! A folder's entries as both scans read them, View's ([`crate::catalog`]) and Sync's
//! ([`crate::scan`]): each name, what it is as `readdir` types it, and a file's `stat` facts when
//! the read gave them.
//!
//! On macOS one `getattrlistbulk` call reads many entries with each file's size and times
//! ([`bulk`]), which spares a scan a `stat` per file, most of its time on a folder of thousands of
//! stills. Elsewhere it is `readdir`, and the scans state each file themselves.

#[cfg(target_os = "macos")]
mod bulk;

use std::ffi::OsString;
use std::fs;
use std::io;
use std::path::Path;

use crate::scan::modified_ms;

/// What an entry is, as `readdir`'s type tells it, without following a symlink.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum EntryKind {
    File,
    Folder,
    /// A symlink, a socket or anything else the scans leave out.
    Other,
}

/// What `fs.stat` says of a regular file, as Node reads it: the length of its data, and its
/// modification and change times as `mtimeMs` and `ctimeMs` (whole seconds in milliseconds plus
/// the nanoseconds as a fraction).
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct FileStat {
    pub(crate) size: u64,
    pub(crate) modified_ms: f64,
    /// `None` where the platform has no change time.
    pub(crate) changed_ms: Option<f64>,
}

impl FileStat {
    pub(crate) fn of(metadata: &fs::Metadata) -> Self {
        Self {
            size: metadata.len(),
            modified_ms: modified_ms(metadata),
            changed_ms: change_time_ms(metadata),
        }
    }
}

#[cfg(unix)]
fn change_time_ms(metadata: &fs::Metadata) -> Option<f64> {
    use std::os::unix::fs::MetadataExt as _;
    Some(metadata.ctime() as f64 * 1e3 + metadata.ctime_nsec() as f64 / 1e6)
}

#[cfg(not(unix))]
fn change_time_ms(_: &fs::Metadata) -> Option<f64> {
    None
}

/// One entry of a folder.
#[derive(Debug)]
pub(crate) struct DirEntry {
    pub(crate) name: OsString,
    pub(crate) kind: EntryKind,
    /// A file's facts, when the read gave them; the scan states the file itself otherwise.
    pub(crate) stat: Option<FileStat>,
}

/// A folder's entries in its own order, which on APFS and HFS+ is `readdir`'s.
#[cfg(target_os = "macos")]
pub(crate) fn read_entries(
    folder: &Path,
) -> io::Result<impl Iterator<Item = io::Result<DirEntry>>> {
    Ok(bulk::read(folder)?.into_iter().map(Ok))
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn read_entries(
    folder: &Path,
) -> io::Result<impl Iterator<Item = io::Result<DirEntry>>> {
    Ok(fs::read_dir(folder)?.map(|entry| {
        let entry = entry?;
        let file_type = entry.file_type()?;
        let kind = if file_type.is_dir() {
            EntryKind::Folder
        } else if file_type.is_file() {
            EntryKind::File
        } else {
            EntryKind::Other
        };
        Ok(DirEntry {
            name: entry.file_name(),
            kind,
            stat: None,
        })
    }))
}
