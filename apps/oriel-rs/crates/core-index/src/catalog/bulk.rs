//! A folder's entries with each file's size and modification time, read in a few calls through
//! macOS's `getattrlistbulk` rather than a `stat` per file. On a folder of thousands of stills that
//! is the difference between thousands of path lookups and a handful of calls, which is most of a
//! scan's time.
//!
//! The facts are the ones `stat` gives a regular file: the length of its data and its
//! modification time to the nanosecond, so a file's id and thumbnail key are the same either way.
//! A symlink is read as itself, as `readdir`'s type reads it, and the entries come in the
//! directory's own order, which on APFS and HFS+ is `readdir`'s.

use std::ffi::{CString, OsStr, c_void};
use std::io;
use std::mem::size_of;
use std::os::fd::{FromRawFd as _, OwnedFd};
use std::os::unix::ffi::OsStrExt as _;
use std::path::Path;

/// `ATTR_CMN_ERROR`, which `libc` does not define: a per-entry error code.
const ATTR_CMN_ERROR: libc::attrgroup_t = 0x2000_0000;
/// `enum vtype` in `sys/vnode.h`.
const VREG: u32 = 1;
const VDIR: u32 = 2;
/// Room for about a thousand entries a call.
const BUFFER_SIZE: usize = 128 * 1024;

/// What an entry is, as `readdir`'s type tells it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Kind {
    File,
    Folder,
    /// A symlink, a socket or anything else the scan leaves out.
    Other,
}

#[derive(Debug)]
pub(super) struct Entry {
    pub(super) name: Box<OsStr>,
    pub(super) kind: Kind,
    /// A file's size and `mtimeMs`; `None` for the rest, and for a file the call could not
    /// read, which the scan then states itself.
    pub(super) stat: Option<(u64, f64)>,
}

/// Every entry of `folder`.
pub(super) fn read(folder: &Path) -> io::Result<Vec<Entry>> {
    let path = CString::new(folder.as_os_str().as_bytes())?;
    // SAFETY: a NUL-terminated path and plain flags.
    let fd = unsafe {
        libc::open(
            path.as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC,
        )
    };
    if fd < 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: `fd` was just opened and is owned here alone.
    let fd = unsafe { OwnedFd::from_raw_fd(fd) };

    // SAFETY: `attrlist` is plain data, valid zeroed.
    let mut list: libc::attrlist = unsafe { std::mem::zeroed() };
    list.bitmapcount = libc::ATTR_BIT_MAP_COUNT;
    list.commonattr = libc::ATTR_CMN_RETURNED_ATTRS
        | ATTR_CMN_ERROR
        | libc::ATTR_CMN_NAME
        | libc::ATTR_CMN_OBJTYPE
        | libc::ATTR_CMN_MODTIME;
    list.fileattr = libc::ATTR_FILE_DATALENGTH;

    let mut buffer = vec![0u8; BUFFER_SIZE];
    let mut entries = Vec::new();
    loop {
        // SAFETY: `list` and `buffer` outlive the call, and `buffer.len()` is its size.
        let count = unsafe {
            libc::getattrlistbulk(
                std::os::fd::AsRawFd::as_raw_fd(&fd),
                (&raw mut list).cast::<c_void>(),
                buffer.as_mut_ptr().cast::<c_void>(),
                buffer.len(),
                u64::from(libc::FSOPT_PACK_INVAL_ATTRS),
            )
        };
        if count < 0 {
            let error = io::Error::last_os_error();
            if error.kind() == io::ErrorKind::Interrupted {
                continue;
            }
            return Err(error);
        }
        if count == 0 {
            return Ok(entries);
        }
        let mut at = 0;
        for _ in 0..count {
            let length = read_u32(&buffer, at)? as usize;
            entries.push(parse(&buffer[at..at + length])?);
            at += length;
        }
    }
}

/// One entry's attributes, packed in the order asked for: the returned set, the error, the
/// name's reference, the type, the time, then the file's length.
fn parse(group: &[u8]) -> io::Result<Entry> {
    let mut at = size_of::<u32>();
    let returned: libc::attribute_set_t = field(group, at)?;
    at += size_of::<libc::attribute_set_t>();
    let error = read_u32(group, at)?;
    at += size_of::<u32>();
    let name_at = at;
    let name: libc::attrreference_t = field(group, at)?;
    at += size_of::<libc::attrreference_t>();
    let kind = read_u32(group, at)?;
    at += size_of::<u32>();
    let modified: libc::timespec = field(group, at)?;
    at += size_of::<libc::timespec>();

    let start = usize::try_from(name_at as isize + name.attr_dataoffset as isize)
        .map_err(|_| malformed())?;
    let bytes = group
        .get(start..start + name.attr_length as usize)
        .ok_or_else(malformed)?;
    // The length counts the terminating NUL.
    let bytes = bytes.strip_suffix(&[0]).unwrap_or(bytes);
    let name: Box<OsStr> = OsStr::from_bytes(bytes).into();

    let kind = match kind {
        VREG => Kind::File,
        VDIR => Kind::Folder,
        _ => Kind::Other,
    };
    let readable = kind == Kind::File
        && error == 0
        && returned.commonattr & libc::ATTR_CMN_MODTIME != 0
        && returned.fileattr & libc::ATTR_FILE_DATALENGTH != 0;
    // Only a file's group carries its length.
    let stat = readable
        .then(|| field::<libc::off_t>(group, at).ok())
        .flatten()
        .map(|length| (u64::try_from(length).unwrap_or(0), modified_ms(&modified)));
    Ok(Entry { name, kind, stat })
}

/// `fs::Metadata::modified` read as `scan::modified_ms` reads it: whole seconds in milliseconds
/// plus the nanoseconds as a fraction, and 0 for a time before the epoch.
fn modified_ms(time: &libc::timespec) -> f64 {
    if time.tv_sec < 0 {
        return 0.0;
    }
    time.tv_sec as f64 * 1e3 + time.tv_nsec as f64 / 1e6
}

fn read_u32(buffer: &[u8], at: usize) -> io::Result<u32> {
    field(buffer, at)
}

/// A plain-data value at `at`, which the kernel packs at 4-byte alignment only.
fn field<T: Copy>(buffer: &[u8], at: usize) -> io::Result<T> {
    let bytes = buffer.get(at..at + size_of::<T>()).ok_or_else(malformed)?;
    // SAFETY: `bytes` holds `size_of::<T>()` bytes, and `T` is plain data from the kernel.
    Ok(unsafe { bytes.as_ptr().cast::<T>().read_unaligned() })
}

fn malformed() -> io::Error {
    io::Error::new(
        io::ErrorKind::InvalidData,
        "getattrlistbulk returned an entry shorter than its attributes",
    )
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::time::{Duration, SystemTime};

    use super::*;
    use crate::scan::modified_ms as stat_modified_ms;

    /// An entry as both reads give it.
    type Read = (Box<OsStr>, Kind, Option<(u64, f64)>);

    /// Each entry reads as `readdir` and `stat` read it: the same names in the same order, the
    /// same kinds, and a file's size and time to the nanosecond.
    #[test]
    fn reads_what_readdir_and_stat_read() {
        let folder = std::env::temp_dir()
            .join("oriel-core-index-bulk")
            .join(std::process::id().to_string());
        let _ = fs::remove_dir_all(&folder);
        fs::create_dir_all(folder.join("sub")).unwrap();
        for ix in 0..1500 {
            let path = folder.join(format!("still {ix} é.jpg"));
            fs::write(&path, vec![b'x'; ix % 97]).unwrap();
            let time = SystemTime::UNIX_EPOCH
                + Duration::new(
                    1_700_000_000 + ix as u64,
                    (ix as u32 * 7_919) % 1_000_000_000,
                );
            fs::File::options()
                .write(true)
                .open(&path)
                .unwrap()
                .set_modified(time)
                .unwrap();
        }
        std::os::unix::fs::symlink(folder.join("still 1 é.jpg"), folder.join("link.jpg")).unwrap();

        let bulk = read(&folder).unwrap();
        let std: Vec<Read> = fs::read_dir(&folder)
            .unwrap()
            .map(|entry| {
                let entry = entry.unwrap();
                let kind = entry.file_type().unwrap();
                let kind = if kind.is_file() {
                    Kind::File
                } else if kind.is_dir() {
                    Kind::Folder
                } else {
                    Kind::Other
                };
                let stat = (kind == Kind::File).then(|| {
                    let metadata = fs::metadata(entry.path()).unwrap();
                    (metadata.len(), stat_modified_ms(&metadata))
                });
                (entry.file_name().into_boxed_os_str(), kind, stat)
            })
            .collect();
        let bulk: Vec<Read> = bulk
            .into_iter()
            .map(|entry| (entry.name, entry.kind, entry.stat))
            .collect();
        assert_eq!(bulk.len(), 1502);
        assert_eq!(bulk, std);
        fs::remove_dir_all(&folder).unwrap();
    }
}
