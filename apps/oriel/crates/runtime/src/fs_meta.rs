//! A file's size, times and identity as Node's `fs.stat` gives them, on every platform, and a
//! folder's entries with them.
//!
//! On Unix this is `std::os::unix::fs::MetadataExt` as it is. On Windows, [`MetadataExt`] gives
//! the same names from Windows' own metadata, but std's metadata has neither NTFS's change time
//! nor the file's identity, so those come from the path: [`change_time`] reads the change time
//! libuv reports as `st_ctime`, [`dev_ino`] the volume serial number and the file index it
//! reports as `st_dev` and `st_ino` (hard links to one file share both, as they do on Unix), and
//! [`identity`] reads all of them with one open.
//!
//! [`read_entries`] reads a folder: each name, what it is as `readdir` types it, and a file's
//! [`FileStat`] when the read gave it. On macOS one `getattrlistbulk` call reads many entries with
//! each file's size and times, which spares a scan a `stat` per file, most of its time on a folder
//! of thousands of stills. Elsewhere it is `readdir`, and the scans state each file themselves.

#[cfg(target_os = "macos")]
mod bulk;

use std::ffi::OsString;
use std::fs::Metadata;
use std::io;
use std::path::Path;
use std::time::UNIX_EPOCH;

#[cfg(unix)]
pub use std::os::unix::fs::MetadataExt;

/// What a file's metadata does not carry on every platform: its device and inode, and its change
/// time as whole seconds and the nanoseconds past them.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Identity {
    pub dev: u64,
    pub ino: u64,
    pub ctime: i64,
    pub ctime_nsec: i64,
}

/// The device and inode of `path`, whose metadata is `metadata`: hard links to one file share
/// both.
#[cfg(unix)]
pub fn dev_ino(_path: &Path, metadata: &Metadata) -> (u64, u64) {
    (metadata.dev(), metadata.ino())
}

/// Node's `ctime` of `path`, whose metadata is `metadata`, as seconds and nanoseconds.
#[cfg(unix)]
pub fn change_time(_path: &Path, metadata: &Metadata) -> (i64, i64) {
    (metadata.ctime(), metadata.ctime_nsec())
}

/// [`dev_ino`] and [`change_time`] together.
#[cfg(unix)]
pub fn identity(_path: &Path, metadata: &Metadata) -> Identity {
    Identity {
        dev: metadata.dev(),
        ino: metadata.ino(),
        ctime: metadata.ctime(),
        ctime_nsec: metadata.ctime_nsec(),
    }
}

/// The volume serial number and the file index of `path`, as libuv's `st_dev` and `st_ino`.
/// std reads both for its own metadata, but keeps them behind an unstable feature, so this opens
/// the file once more, for its attributes only and sharing everything, as libuv does. A file
/// that cannot be opened reads `(0, 0)`.
#[cfg(windows)]
pub fn dev_ino(path: &Path, _metadata: &Metadata) -> (u64, u64) {
    windows::read(path, true)
        .and_then(|read| read.dev_ino)
        .unwrap_or((0, 0))
}

/// NTFS's change time of `path`, libuv's `st_ctime`: it moves when the file's data or its
/// attributes change, where the last write time moves with the data only. std does not read it,
/// so this opens the file for its attributes, sharing everything. A file that cannot be opened
/// reads its last write time from `metadata`.
#[cfg(windows)]
pub fn change_time(path: &Path, metadata: &Metadata) -> (i64, i64) {
    windows::read(path, false)
        .map(|read| read.ctime)
        .unwrap_or_else(|| (metadata.mtime(), metadata.mtime_nsec()))
}

/// [`dev_ino`] and [`change_time`] with one open of the file.
#[cfg(windows)]
pub fn identity(path: &Path, metadata: &Metadata) -> Identity {
    let read = windows::read(path, true);
    let (dev, ino) = read.and_then(|read| read.dev_ino).unwrap_or((0, 0));
    let (ctime, ctime_nsec) = read.map_or_else(
        || (metadata.mtime(), metadata.mtime_nsec()),
        |read| read.ctime,
    );
    Identity {
        dev,
        ino,
        ctime,
        ctime_nsec,
    }
}

/// Node's `mtimeMs`: whole seconds in milliseconds plus the nanoseconds as a fraction, summed in
/// that order so the same file gives the same float. A time before 1970 reads 0.
pub fn modified_ms(metadata: &Metadata) -> f64 {
    metadata
        .modified()
        .ok()
        .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
        .map_or(0.0, |since| {
            since.as_secs() as f64 * 1e3 + f64::from(since.subsec_nanos()) / 1e6
        })
}

/// What `fs.stat` says of a regular file: the length of its data, and its modification and change
/// times as `mtimeMs` and `ctimeMs`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct FileStat {
    pub size: u64,
    pub modified_ms: f64,
    /// `None` where it was not read: [`FileStat::of`] on Windows.
    pub changed_ms: Option<f64>,
}

impl FileStat {
    /// The facts `metadata` holds, which on Windows lack the change time.
    pub fn of(metadata: &Metadata) -> Self {
        #[cfg(unix)]
        let changed_ms = Some(metadata.ctime() as f64 * 1e3 + metadata.ctime_nsec() as f64 / 1e6);
        #[cfg(not(unix))]
        let changed_ms = None;
        Self {
            size: metadata.len(),
            modified_ms: modified_ms(metadata),
            changed_ms,
        }
    }

    /// The facts of the file at `path`, whose metadata is `metadata`, with its change time on
    /// every platform: on Windows NTFS's, which takes a read of the file itself
    /// ([`change_time`]).
    pub fn with_change_time(path: &Path, metadata: &Metadata) -> Self {
        let (seconds, nanoseconds) = change_time(path, metadata);
        Self {
            changed_ms: Some(seconds as f64 * 1e3 + nanoseconds as f64 / 1e6),
            ..Self::of(metadata)
        }
    }
}

/// What an entry is, as `readdir`'s type tells it, without following a symlink.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EntryKind {
    File,
    Folder,
    /// A symlink, a socket or anything else.
    Other,
}

#[derive(Debug)]
pub struct DirEntry {
    pub name: OsString,
    pub kind: EntryKind,
    /// A file's facts, when the read gave them.
    pub stat: Option<FileStat>,
}

/// A folder's entries in its own order, which on APFS and HFS+ is `readdir`'s.
#[cfg(target_os = "macos")]
pub fn read_entries(folder: &Path) -> io::Result<impl Iterator<Item = io::Result<DirEntry>>> {
    Ok(bulk::read(folder)?.into_iter().map(Ok))
}

#[cfg(not(target_os = "macos"))]
pub fn read_entries(folder: &Path) -> io::Result<impl Iterator<Item = io::Result<DirEntry>>> {
    Ok(std::fs::read_dir(folder)?.map(|entry| {
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

#[cfg(windows)]
pub use windows::MetadataExt;

#[cfg(windows)]
mod windows {
    use std::fs::{Metadata, OpenOptions};
    use std::os::windows::fs::{MetadataExt as _, OpenOptionsExt as _};
    use std::os::windows::io::AsRawHandle as _;
    use std::path::Path;

    use windows_sys::Win32::Storage::FileSystem::{
        BY_HANDLE_FILE_INFORMATION, FILE_BASIC_INFO, FILE_FLAG_BACKUP_SEMANTICS,
        FILE_READ_ATTRIBUTES, FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE, FileBasicInfo,
        GetFileInformationByHandle, GetFileInformationByHandleEx,
    };

    /// 100-nanosecond intervals from 1601 to 1970, where a `FILETIME` and Unix time meet.
    const EPOCH_DIFFERENCE: i64 = 116_444_736_000_000_000;
    const TICKS_PER_SECOND: i64 = 10_000_000;

    /// A `FILETIME` as Unix seconds and the nanoseconds past them, as libuv's
    /// `uv__filetime_to_timespec` gives them.
    pub(super) fn split(filetime: u64) -> (i64, i64) {
        let ticks = filetime as i64 - EPOCH_DIFFERENCE;
        (
            ticks.div_euclid(TICKS_PER_SECOND),
            ticks.rem_euclid(TICKS_PER_SECOND) * 100,
        )
    }

    /// The Unix names the catalogs read, from Windows' metadata.
    pub trait MetadataExt {
        fn size(&self) -> u64;
        fn mtime(&self) -> i64;
        fn mtime_nsec(&self) -> i64;
        /// The last write time, the nearest std's metadata has. libuv's `st_ctime` is NTFS's
        /// change time, which differs after a change to the attributes alone: whatever must
        /// match Node's `ctime` reads [`super::change_time`] instead.
        fn ctime(&self) -> i64;
        fn ctime_nsec(&self) -> i64;
    }

    impl MetadataExt for Metadata {
        fn size(&self) -> u64 {
            self.file_size()
        }

        fn mtime(&self) -> i64 {
            split(self.last_write_time()).0
        }

        fn mtime_nsec(&self) -> i64 {
            split(self.last_write_time()).1
        }

        fn ctime(&self) -> i64 {
            self.mtime()
        }

        fn ctime_nsec(&self) -> i64 {
            self.mtime_nsec()
        }
    }

    /// What one open of a file read.
    #[derive(Clone, Copy)]
    pub(super) struct Read {
        pub(super) ctime: (i64, i64),
        /// Read only when asked for.
        pub(super) dev_ino: Option<(u64, u64)>,
    }

    /// Opens `path` for its attributes only, sharing everything as libuv does, so a file another
    /// program has open still reads, and reads its change time and, with `with_identity`, its
    /// volume serial number and file index.
    pub(super) fn read(path: &Path, with_identity: bool) -> Option<Read> {
        let file = OpenOptions::new()
            .access_mode(FILE_READ_ATTRIBUTES)
            .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
            // Folders open only with backup semantics.
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS)
            .open(path)
            .ok()?;
        let handle = file.as_raw_handle();
        // SAFETY: plain data, filled by the call on success.
        let mut basic: FILE_BASIC_INFO = unsafe { std::mem::zeroed() };
        // SAFETY: a live handle, and a buffer of the size the call is told.
        let ok = unsafe {
            GetFileInformationByHandleEx(
                handle,
                FileBasicInfo,
                (&raw mut basic).cast(),
                size_of::<FILE_BASIC_INFO>() as u32,
            )
        };
        if ok == 0 {
            return None;
        }
        let dev_ino = with_identity
            .then(|| {
                // SAFETY: plain data, filled by the call on success.
                let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
                // SAFETY: a live handle, and a struct of the size the call writes.
                let ok = unsafe { GetFileInformationByHandle(handle, &raw mut info) };
                (ok != 0).then(|| {
                    (
                        u64::from(info.dwVolumeSerialNumber),
                        (u64::from(info.nFileIndexHigh) << 32) | u64::from(info.nFileIndexLow),
                    )
                })
            })
            .flatten();
        Some(Read {
            ctime: split(basic.ChangeTime as u64),
            dev_ino,
        })
    }

    #[cfg(test)]
    mod tests {
        #[test]
        fn splits_a_filetime_at_the_unix_epoch() {
            assert_eq!(super::split(116_444_736_000_000_000), (0, 0));
            assert_eq!(super::split(116_444_736_012_345_678), (1, 234_567_800));
            assert_eq!(super::split(116_444_735_990_000_000), (-1, 0));
        }
    }
}
