//! A file's size, times and identity as Node's `fs.stat` gives them, on every platform, so the
//! catalogs hold what Electron Oriel's hold.
//!
//! On Unix this is `std::os::unix::fs::MetadataExt` as it is. On Windows, [`MetadataExt`] gives
//! the same names from Windows' own metadata, and [`dev_ino`] reads the volume serial number and
//! the file index, which libuv reports as `st_dev` and `st_ino` there, so hard links to one file
//! share both as they do on Unix.

use std::fs::Metadata;
use std::path::Path;

#[cfg(unix)]
pub use std::os::unix::fs::MetadataExt;

/// The device and inode of `path`, whose metadata is `metadata`: hard links to one file share
/// both.
#[cfg(unix)]
pub fn dev_ino(_path: &Path, metadata: &Metadata) -> (u64, u64) {
    (metadata.dev(), metadata.ino())
}

/// The volume serial number and the file index of `path`, as libuv's `st_dev` and `st_ino`.
/// std reads both for its own metadata, but keeps them behind an unstable feature, so this opens
/// the file once more, for its attributes only and sharing everything, as libuv does. A file
/// that cannot be opened reads `(0, 0)`.
#[cfg(windows)]
pub fn dev_ino(path: &Path, _metadata: &Metadata) -> (u64, u64) {
    windows::dev_ino(path).unwrap_or((0, 0))
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
        BY_HANDLE_FILE_INFORMATION, FILE_FLAG_BACKUP_SEMANTICS, FILE_SHARE_DELETE, FILE_SHARE_READ,
        FILE_SHARE_WRITE, GetFileInformationByHandle,
    };

    /// 100-nanosecond intervals from 1601 to 1970, where a `FILETIME` and Unix time meet.
    const EPOCH_DIFFERENCE: i64 = 116_444_736_000_000_000;
    const TICKS_PER_SECOND: i64 = 10_000_000;

    /// A `FILETIME` as Unix seconds and the nanoseconds past them.
    fn split(filetime: u64) -> (i64, i64) {
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
        /// The last write time. libuv's `st_ctime` is NTFS's change time, which std does not
        /// read; it differs only after a change to the attributes alone.
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

    pub(super) fn dev_ino(path: &Path) -> Option<(u64, u64)> {
        let file = OpenOptions::new()
            .access_mode(0)
            .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
            // Folders open only with backup semantics.
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS)
            .open(path)
            .ok()?;
        // SAFETY: plain data, filled by the call on success.
        let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
        // SAFETY: a live handle, and a struct of the size the call writes.
        let ok = unsafe { GetFileInformationByHandle(file.as_raw_handle(), &raw mut info) };
        (ok != 0).then(|| {
            (
                u64::from(info.dwVolumeSerialNumber),
                (u64::from(info.nFileIndexHigh) << 32) | u64::from(info.nFileIndexLow),
            )
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
