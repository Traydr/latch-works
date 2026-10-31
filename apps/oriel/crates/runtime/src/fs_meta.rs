//! A file's size, times and identity as Node's `fs.stat` gives them, on every platform, so the
//! catalogs hold what Electron Oriel's hold.
//!
//! On Unix this is `std::os::unix::fs::MetadataExt` as it is. On Windows, [`MetadataExt`] gives
//! the same names from Windows' own metadata, but std's metadata has neither NTFS's change time
//! nor the file's identity, so those come from the path: [`change_time`] reads the change time
//! libuv reports as `st_ctime`, [`dev_ino`] the volume serial number and the file index it
//! reports as `st_dev` and `st_ino` (hard links to one file share both, as they do on Unix), and
//! [`identity`] reads all of them with one open.

use std::fs::Metadata;
use std::path::Path;

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
        /// change time, which differs after a change to the attributes alone: whatever is
        /// compared with Electron Oriel's catalogs reads [`super::change_time`] instead.
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
