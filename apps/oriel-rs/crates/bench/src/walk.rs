//! The archive walk, with `glazier-core`'s rules (`src/scan/walk.ts`): breadth-first, symlinks
//! never followed, non-regular entries skipped, system junk folders not entered, Finder's and
//! Explorer's folder files left out, and `._*` files kept but marked as junk.

use std::fs::{self, DirEntry};
use std::io;
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::thread;

/// A regular file the walk found, with the fields the catalog keeps for it.
#[derive(Debug, Clone)]
pub struct WalkedFile {
    /// Path inside the root with forward slashes.
    pub rel_path: String,
    pub abs_path: PathBuf,
    /// Lowercased, without the dot; empty when the name has none.
    pub ext: String,
    pub size: u64,
    pub mtime_ms: i64,
    pub ctime_ms: i64,
    pub dev: u64,
    pub ino: u64,
    /// `._*` files a Mac leaves on other disks.
    pub junk: bool,
}

#[derive(Debug, Default)]
pub struct WalkSummary {
    pub files: Vec<WalkedFile>,
    /// Folders holding no files and no folders, relative to the root.
    pub empty_folders: Vec<String>,
    /// Symlinks and other non-regular entries.
    pub skipped_entries: usize,
}

/// `media-domain`'s `SYSTEM_JUNK_DIRECTORY_NAMES`, lowercased.
const SYSTEM_JUNK_DIRECTORIES: [&str; 10] = [
    ".latch-works",
    ".glazier-holding",
    "$recycle.bin",
    ".documentrevisions-v100",
    ".fseventsd",
    ".spotlight-v100",
    ".temporaryitems",
    ".trashes",
    "__macosx",
    "system volume information",
];

/// `walk.ts`'s `FOLDER_SYSTEM_FILES`: view settings and thumbnail caches, left out of the walk.
const FOLDER_SYSTEM_FILES: [&str; 5] = [
    ".ds_store",
    "desktop.ini",
    "thumbs.db",
    "ehthumbs.db",
    "ehthumbs_vista.db",
];

fn is_system_junk_directory(name: &str) -> bool {
    SYSTEM_JUNK_DIRECTORIES.contains(&name.to_lowercase().as_str())
}

fn is_folder_system_file(name: &str) -> bool {
    FOLDER_SYSTEM_FILES.contains(&name.to_lowercase().as_str())
}

/// `media-domain`'s `isSystemJunkFile`: AppleDouble files and the folder system files.
fn is_system_junk_file(name: &str) -> bool {
    name.starts_with("._") || is_folder_system_file(name)
}

/// `walk.ts`'s `extensionOf`: after the last dot, unless the dot is first or last.
pub fn extension_of(name: &str) -> String {
    match name.rfind('.') {
        Some(index) if index > 0 && index < name.len() - 1 => name[index + 1..].to_lowercase(),
        _ => String::new(),
    }
}

/// Whole milliseconds of a timestamp, as `wholeMs` takes them from nanoseconds.
fn whole_ms(seconds: i64, nanoseconds: i64) -> i64 {
    seconds * 1000 + nanoseconds / 1_000_000
}

/// One file's lstat, or None when it vanished or is no longer a regular file.
fn stat_file(root_rel_dir: &str, abs_dir: &Path, name: String) -> Option<WalkedFile> {
    let abs_path = abs_dir.join(&name);
    let metadata = fs::symlink_metadata(&abs_path).ok()?;

    if !metadata.file_type().is_file() {
        return None;
    }

    Some(WalkedFile {
        rel_path: if root_rel_dir.is_empty() {
            name.clone()
        } else {
            format!("{root_rel_dir}/{name}")
        },
        abs_path,
        ext: extension_of(&name),
        size: metadata.len(),
        mtime_ms: whole_ms(metadata.mtime(), metadata.mtime_nsec()),
        ctime_ms: whole_ms(metadata.ctime(), metadata.ctime_nsec()),
        dev: metadata.dev(),
        ino: metadata.ino(),
        junk: is_system_junk_file(&name),
    })
}

/// Stats a folder's files, `threads` at a time, keeping their order.
fn stat_files(
    rel_dir: &str,
    abs_dir: &Path,
    names: Vec<String>,
    threads: usize,
) -> Vec<Option<WalkedFile>> {
    if threads <= 1 || names.len() < 2 {
        return names
            .into_iter()
            .map(|name| stat_file(rel_dir, abs_dir, name))
            .collect();
    }

    let chunk = names.len().div_ceil(threads);
    let chunks: Vec<Vec<String>> = names.chunks(chunk).map(<[String]>::to_vec).collect();

    thread::scope(|scope| {
        let handles: Vec<_> = chunks
            .into_iter()
            .map(|names| {
                scope.spawn(move || {
                    names
                        .into_iter()
                        .map(|name| stat_file(rel_dir, abs_dir, name))
                        .collect::<Vec<_>>()
                })
            })
            .collect();

        handles
            .into_iter()
            .flat_map(|handle| handle.join().unwrap_or_default())
            .collect()
    })
}

/// Walks `root` breadth-first. `stat_threads` is how many lstats run at once within a folder;
/// `walk.ts` issues 32 at a time onto Node's thread pool of 4.
pub fn walk_root(root: &Path, stat_threads: usize) -> io::Result<WalkSummary> {
    let mut queue: Vec<String> = vec![String::new()];
    let mut summary = WalkSummary::default();
    let mut cursor = 0;

    while cursor < queue.len() {
        let rel_dir = queue[cursor].clone();
        cursor += 1;
        let abs_dir = if rel_dir.is_empty() {
            root.to_path_buf()
        } else {
            root.join(&rel_dir)
        };

        // A folder that vanished or cannot be read is skipped; the rest of the root still walks.
        let Ok(entries) = fs::read_dir(&abs_dir) else {
            continue;
        };

        let mut content_count = 0;
        let mut file_names = Vec::new();

        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();

            match entry_kind(&entry) {
                EntryKind::Directory => {
                    if !is_system_junk_directory(&name) {
                        queue.push(if rel_dir.is_empty() {
                            name
                        } else {
                            format!("{rel_dir}/{name}")
                        });
                        content_count += 1;
                    }
                }
                EntryKind::File => {
                    if is_folder_system_file(&name) {
                        continue;
                    }

                    if !is_system_junk_file(&name) {
                        content_count += 1;
                    }

                    file_names.push(name);
                }
                EntryKind::Other => summary.skipped_entries += 1,
            }
        }

        if content_count == 0 && !rel_dir.is_empty() {
            summary.empty_folders.push(rel_dir.clone());
        }

        for file in stat_files(&rel_dir, &abs_dir, file_names, stat_threads) {
            match file {
                Some(file) => summary.files.push(file),
                None => summary.skipped_entries += 1,
            }
        }
    }

    Ok(summary)
}

enum EntryKind {
    Directory,
    File,
    Other,
}

/// The entry's own type from the directory listing, as `readdir`'s `withFileTypes` gives it: a
/// symlink is neither a file nor a folder.
fn entry_kind(entry: &DirEntry) -> EntryKind {
    match entry.file_type() {
        Ok(kind) if kind.is_dir() => EntryKind::Directory,
        Ok(kind) if kind.is_file() => EntryKind::File,
        _ => EntryKind::Other,
    }
}
