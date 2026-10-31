//! Copying, measuring and naming, for the import. Every copy reads its source and writes only
//! under Oriel RS's own folder.

use std::fs::{self, File, FileTimes};
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

/// How far an import has got, shared with the window that shows it.
#[derive(Debug, Default)]
pub struct Progress {
    done: AtomicU64,
    total: AtomicU64,
    phase: Mutex<String>,
}

impl Progress {
    /// The bytes copied so far, of those there are to copy.
    pub fn bytes(&self) -> (u64, u64) {
        (
            self.done.load(Ordering::Relaxed),
            self.total.load(Ordering::Relaxed),
        )
    }

    /// The share done, from 0 to 1.
    pub fn fraction(&self) -> f32 {
        let (done, total) = self.bytes();
        if total == 0 {
            0.
        } else {
            (done as f64 / total as f64).min(1.) as f32
        }
    }

    /// What the import is doing now, such as "Copying Tidy's held files".
    pub fn phase(&self) -> String {
        self.phase
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
    }

    pub(crate) fn begin(&self, phase: &str) {
        *self
            .phase
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = phase.to_owned();
    }

    pub(crate) fn expect(&self, bytes: u64) {
        self.total.fetch_add(bytes, Ordering::Relaxed);
    }

    pub(crate) fn add(&self, bytes: u64) {
        self.done.fetch_add(bytes, Ordering::Relaxed);
    }
}

/// How many files a folder holds, and their bytes.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Size {
    pub files: u64,
    pub bytes: u64,
}

impl Size {
    pub(crate) fn add(&mut self, other: Size) {
        self.files += other.files;
        self.bytes += other.bytes;
    }
}

/// The files under `folder` and their bytes; nothing when it is not there. Links are not
/// followed.
pub fn tree_size(folder: &Path) -> Size {
    let mut size = Size::default();
    let Ok(listing) = fs::read_dir(folder) else {
        return size;
    };
    for entry in listing.flatten() {
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        if kind.is_dir() {
            size.add(tree_size(&entry.path()));
        } else if kind.is_file() {
            size.files += 1;
            size.bytes += entry.metadata().map_or(0, |metadata| metadata.len());
        }
    }
    size
}

/// Copies one file with its times, as the archive's dates matter to Tidy and the caches' to their
/// pruning. `std::fs::copy` clones on APFS, so a large file costs no time or space.
pub fn copy_file(from: &Path, to: &Path, progress: &Progress) -> io::Result<u64> {
    if let Some(parent) = to.parent() {
        fs::create_dir_all(parent)?;
    }
    let metadata = fs::metadata(from)?;
    let bytes = fs::copy(from, to)?;
    let mut times = FileTimes::new();
    if let Ok(modified) = metadata.modified() {
        times = times.set_modified(modified);
    }
    if let Ok(accessed) = metadata.accessed() {
        times = times.set_accessed(accessed);
    }
    File::options().write(true).open(to)?.set_times(times)?;
    progress.add(bytes);
    Ok(bytes)
}

/// Copies the folder `from` to `to` whole; links are copied as links where the system allows.
pub fn copy_tree(from: &Path, to: &Path, progress: &Progress) -> io::Result<Size> {
    let mut size = Size::default();
    fs::create_dir_all(to)?;
    for entry in fs::read_dir(from)? {
        let entry = entry?;
        let kind = entry.file_type()?;
        let target = to.join(entry.file_name());
        if kind.is_dir() {
            size.add(copy_tree(&entry.path(), &target, progress)?);
        } else if kind.is_file() {
            size.bytes += copy_file(&entry.path(), &target, progress)?;
            size.files += 1;
        } else if kind.is_symlink() {
            copy_link(&entry.path(), &target)?;
        }
    }
    Ok(size)
}

#[cfg(unix)]
fn copy_link(from: &Path, to: &Path) -> io::Result<()> {
    std::os::unix::fs::symlink(fs::read_link(from)?, to)
}

#[cfg(not(unix))]
fn copy_link(_: &Path, _: &Path) -> io::Result<()> {
    Ok(())
}

/// `path` with `suffix` after its file name: `catalog.sqlite-wal`.
pub fn with_suffix(path: &Path, suffix: &str) -> PathBuf {
    let mut name = path.as_os_str().to_owned();
    name.push(suffix);
    PathBuf::from(name)
}

/// Whether `folder` holds nothing (or is not there).
pub fn is_empty(folder: &Path) -> bool {
    fs::read_dir(folder).map_or(true, |mut listing| listing.next().is_none())
}

/// Removes a folder of the import's own making, such as its staging folder.
pub fn remove_own(folder: &Path) {
    if let Err(error) = fs::remove_dir_all(folder)
        && error.kind() != io::ErrorKind::NotFound
    {
        log::warn!("could not remove {}: {error}", folder.display());
    }
}

/// `toISOString`'s form, `2026-10-31T09:30:12.345Z`.
pub fn iso_timestamp(at: SystemTime) -> String {
    let (date, time, millis) = utc(at);
    format!("{date}T{time}.{millis:03}Z")
}

/// A form for a folder's name, `2026-10-31T09-30-12Z`.
pub fn folder_timestamp(at: SystemTime) -> String {
    let (date, time, _) = utc(at);
    format!("{date}T{}Z", time.replace(':', "-"))
}

/// The UTC date and time of `at`.
fn utc(at: SystemTime) -> (String, String, u64) {
    let since = at.duration_since(UNIX_EPOCH).unwrap_or_default();
    let seconds = since.as_secs();
    let days = (seconds / 86_400) as i64;
    let rest = seconds % 86_400;
    // Howard Hinnant's `civil_from_days`.
    let shifted = days + 719_468;
    let era = shifted.div_euclid(146_097);
    let day_of_era = shifted.rem_euclid(146_097);
    let year_of_era =
        (day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_index = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_index + 2) / 5 + 1;
    let month = if month_index < 10 {
        month_index + 3
    } else {
        month_index - 9
    };
    let year = year_of_era + era * 400 + i64::from(month <= 2);
    (
        format!("{year:04}-{month:02}-{day:02}"),
        format!(
            "{:02}:{:02}:{:02}",
            rest / 3600,
            rest % 3600 / 60,
            rest % 60
        ),
        u64::from(since.subsec_millis()),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn timestamps_read_as_javascript_writes_them() {
        let at = UNIX_EPOCH + Duration::from_millis(1_793_439_012_345);
        assert_eq!(iso_timestamp(at), "2026-10-31T09:30:12.345Z");
        assert_eq!(folder_timestamp(at), "2026-10-31T09-30-12Z");
        assert_eq!(iso_timestamp(UNIX_EPOCH), "1970-01-01T00:00:00.000Z");
        let leap = UNIX_EPOCH + Duration::from_secs(951_782_400);
        assert_eq!(folder_timestamp(leap), "2000-02-29T00-00-00Z");
    }
}
