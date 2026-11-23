//! The hash pass: hashes only what could be a
//! duplicate. Files sharing a size get a hash of their first and last 64 KiB; files that still
//! collide get a full SHA-256, the same content id Sync uploads under. A small file is read once
//! and gets both. Most of an archive is never read in full.

use std::fs::File;
use std::io::Read as _;
#[cfg(unix)]
use std::os::unix::fs::FileExt as _;
#[cfg(windows)]
use std::os::windows::fs::FileExt as _;
use std::path::Path;

use oriel_runtime::Cancelled;
use oriel_runtime::fs_meta::{MetadataExt as _, change_time};
use sha2::{Digest as _, Sha256};

use crate::catalog::files::{SqlParams, record_edge_hash, record_sha256};
use crate::catalog::rows::to_absolute_path;
use crate::contract::FileId;
use crate::passes::{PassContext, Progress, for_each_concurrent};
use crate::scan::whole_ms;

/// Bytes read from each end of a file for the cheap first comparison.
const EDGE_BYTES: u64 = 64 * 1024;

struct Candidate {
    id: FileId,
    root_path: String,
    rel_path: String,
    size: i64,
    mtime_ms: f64,
    ctime_ms: f64,
}

fn candidates(context: &PassContext<'_>, condition: &str) -> anyhow::Result<Vec<Candidate>> {
    let mut params = SqlParams::new();
    let sql = format!(
        "SELECT f.id, r.path AS root_path, f.rel_path, f.size, f.mtime_ms, f.ctime_ms
      FROM files f JOIN roots r ON r.id = f.root_id
      WHERE {condition}
        {}",
        context.root_clause(&mut params)
    );
    context.catalog.blocking(move |connection| {
        let mut statement = connection.prepare(&sql)?;
        let rows = statement.query_map(&*params.named(), |row| {
            Ok(Candidate {
                id: row.get(0)?,
                root_path: row.get(1)?,
                rel_path: row.get(2)?,
                size: row.get(3)?,
                mtime_ms: row.get(4)?,
                ctime_ms: row.get(5)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    })
}

pub fn run_hash_pass(context: &PassContext<'_>) -> anyhow::Result<()> {
    let edge_candidates = candidates(
        context,
        "f.head_hash IS NULL AND f.is_junk = 0 AND f.size > 0
        AND f.size IN (SELECT size FROM files WHERE is_junk = 0 AND size > 0
          GROUP BY size HAVING COUNT(*) > 1)",
    )?;
    for_each_concurrent(
        &edge_candidates,
        8,
        context.progress,
        "Comparing file edges",
        |file| {
            let path = to_absolute_path(&file.root_path, &file.rel_path);
            let size = file.size.max(0) as u64;
            let small = size <= EDGE_BYTES * 2;
            // A file that cannot be read stays unhashed; the next scan tries again.
            let Ok(edge) = hash_edges(&path, size) else {
                return Ok(());
            };
            let sha256 = if small {
                // The edges cover the whole file, so read it once more as one SHA-256.
                match hash_small_file(&path) {
                    Ok(sha256) => Some(sha256),
                    Err(_) => return Ok(()),
                }
            } else {
                None
            };
            let id = file.id;
            context.catalog.blocking(move |connection| {
                record_edge_hash(connection, id, &edge, sha256.as_deref())
            })
        },
    )?;

    let full_candidates = candidates(
        context,
        "f.sha256 IS NULL AND f.head_hash IS NOT NULL
        AND (f.size, f.head_hash) IN (SELECT size, head_hash FROM files
          WHERE head_hash IS NOT NULL GROUP BY size, head_hash HAVING COUNT(*) > 1)",
    )?;
    for_each_concurrent(
        &full_candidates,
        4,
        context.progress,
        "Hashing possible duplicates",
        |file| {
            let path = to_absolute_path(&file.root_path, &file.rel_path);
            let expected = (file.size, file.mtime_ms.trunc(), file.ctime_ms.trunc());
            // Changed while hashing or unreadable: left for the next scan.
            let sha256 = match hash_whole_file(&path, expected, context.progress) {
                Ok(sha256) => sha256,
                Err(HashError::Cancelled) => return Err(Cancelled.into()),
                Err(HashError::Unreadable) => return Ok(()),
            };
            let id = file.id;
            context
                .catalog
                .blocking(move |connection| record_sha256(connection, id, &sha256))
        },
    )
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// Reads up to `buffer.len()` bytes at `offset`, leaving the rest zero, as Node's
/// `handle.read` into a fresh buffer does.
fn read_at(file: &File, buffer: &mut [u8], offset: u64) -> std::io::Result<()> {
    let mut filled = 0;
    while filled < buffer.len() {
        #[cfg(unix)]
        let read = file.read_at(&mut buffer[filled..], offset + filled as u64)?;
        // Windows' positional read also moves the cursor, which nothing here reads.
        #[cfg(windows)]
        let read = file.seek_read(&mut buffer[filled..], offset + filled as u64)?;
        match read {
            0 => break,
            count => filled += count,
        }
    }
    Ok(())
}

/// SHA-256 of the size as decimal text, the first 64 KiB, and the last 64 KiB past those.
pub fn hash_edges(path: &Path, size: u64) -> std::io::Result<String> {
    let file = File::open(path)?;
    let mut hash = Sha256::new();
    hash.update(size.to_string().as_bytes());
    let mut head = vec![0; EDGE_BYTES.min(size) as usize];
    read_at(&file, &mut head, 0)?;
    hash.update(&head);
    if size > EDGE_BYTES {
        let tail_length = EDGE_BYTES.min(size - EDGE_BYTES);
        let mut tail = vec![0; tail_length as usize];
        read_at(&file, &mut tail, size - tail_length)?;
        hash.update(&tail);
    }
    Ok(hex(&hash.finalize()))
}

fn hash_small_file(path: &Path) -> std::io::Result<String> {
    let bytes = std::fs::read(path)?;
    Ok(hex(&Sha256::digest(&bytes)))
}

pub(crate) enum HashError {
    Cancelled,
    Unreadable,
}

/// A file's SHA-256, the duplicate content id. Fails when the file's size, mtime or ctime (in
/// whole milliseconds) are not `expected` once it has been read, so a hash never describes bytes
/// that changed underneath it.
pub(crate) fn hash_whole_file(
    path: &Path,
    expected: (i64, f64, f64),
    progress: &dyn Progress,
) -> Result<String, HashError> {
    hash_whole_file_reporting(path, expected, progress, None)
}

/// [`hash_whole_file`] for one long read at a time, such as a large video's in a change:
/// `on_read` hears how many bytes it has read after each piece, and paused as a tool is
/// (asked-for work, not background) it waits between pieces rather than reading on. Reads that run
/// several at once pass `None` and finish their file, to come to rest together at a checkpoint.
pub(crate) fn hash_whole_file_reporting(
    path: &Path,
    expected: (i64, f64, f64),
    progress: &dyn Progress,
    on_read: Option<&dyn Fn(u64)>,
) -> Result<String, HashError> {
    let mut file = File::open(path).map_err(|_| HashError::Unreadable)?;
    let mut hash = Sha256::new();
    let mut buffer = vec![0; 1024 * 1024];
    let mut read = 0_u64;
    loop {
        progress.check().map_err(|_| HashError::Cancelled)?;
        if on_read.is_some()
            && let (Some(pause), Some(cancel)) = (progress.pause_token(), progress.cancel_token())
            && pause.holds_tools()
        {
            pause
                .wait_blocking(cancel)
                .map_err(|_| HashError::Cancelled)?;
        }
        match file.read(&mut buffer) {
            Ok(0) => break,
            Ok(count) => {
                hash.update(&buffer[..count]);
                read += count as u64;
                if let Some(on_read) = on_read {
                    on_read(read);
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => {}
            Err(_) => return Err(HashError::Unreadable),
        }
    }
    let after = std::fs::metadata(path).map_err(|_| HashError::Unreadable)?;
    let (size, mtime_ms, ctime_ms) = expected;
    let unchanged = after.size() as i64 == size
        && whole_ms(after.mtime(), after.mtime_nsec()) as f64 == mtime_ms
        && {
            let (seconds, nanoseconds) = change_time(path, &after);
            whole_ms(seconds, nanoseconds) as f64 == ctime_ms
        };
    if !unchanged {
        return Err(HashError::Unreadable);
    }
    Ok(hex(&hash.finalize()))
}

#[cfg(test)]
mod tests {
    use std::sync::mpsc;
    use std::time::Duration;

    use super::*;
    use crate::passes::Quiet;

    /// Removes the file when dropped.
    struct Scratch(std::path::PathBuf);

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_file(&self.0);
        }
    }

    /// A file of `bytes` and what a hash expects of it.
    fn file(bytes: usize) -> (Scratch, std::path::PathBuf, (i64, f64, f64)) {
        let path =
            std::env::temp_dir().join(format!("oriel-hash-pause-{}.bin", std::process::id()));
        let folder = Scratch(path.clone());
        std::fs::write(&path, vec![7_u8; bytes]).unwrap();
        let metadata = std::fs::metadata(&path).unwrap();
        let (seconds, nanoseconds) = change_time(&path, &metadata);
        let expected = (
            metadata.size() as i64,
            whole_ms(metadata.mtime(), metadata.mtime_nsec()) as f64,
            whole_ms(seconds, nanoseconds) as f64,
        );
        (folder, path, expected)
    }

    /// A long read for a change waits while the change is paused and goes on when resumed;
    /// background work's read finishes its file, as its tools do.
    #[test]
    fn a_reported_read_waits_while_asked_for_work_is_paused() {
        let (_folder, path, expected) = file(3 * 1024 * 1024);
        let progress = Quiet::new();
        progress.pause().pause();
        let (done, finished) = mpsc::channel();
        let reading = progress.clone();
        let read_path = path.clone();
        let reader = std::thread::spawn(move || {
            let hashed = hash_whole_file_reporting(&read_path, expected, &reading, Some(&|_| {}));
            done.send(()).unwrap();
            hashed
        });
        assert!(
            finished.recv_timeout(Duration::from_millis(300)).is_err(),
            "it read on while paused"
        );
        progress.pause().resume();
        assert!(reader.join().unwrap().is_ok());

        let background = Quiet::new();
        background.pause().set_background(true);
        background.pause().pause();
        assert!(hash_whole_file_reporting(&path, expected, &background, Some(&|_| {})).is_ok());
        // Reads that run several at once finish their file and come to rest at a checkpoint.
        let paused = Quiet::new();
        paused.pause().pause();
        assert!(hash_whole_file(&path, expected, &paused).is_ok());
    }
}
