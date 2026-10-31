//! Walking a root, from glazier-core's `scan/walk.ts`.

use std::fs;
use std::path::Path;

use oriel_core_domain::{is_system_junk_directory, is_system_junk_file};
use oriel_runtime::Cancelled;
use oriel_runtime::fs_meta::{MetadataExt as _, dev_ino};

/// A regular file the walk found, with what tells later scans it changed.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WalkedFile {
    /// Path inside the root with forward slashes.
    pub rel_path: String,
    pub dir: String,
    pub name: String,
    /// Lowercased, without the dot; "" when the name has none.
    pub ext: String,
    pub size: i64,
    pub mtime_ms: i64,
    pub ctime_ms: i64,
    /// Device and inode as decimal strings: hard links to one file share both.
    pub dev: String,
    pub ino: String,
    /// `._*` files a Mac leaves on other disks: recorded so they can be cleaned up.
    pub junk: bool,
}

/// What a walk found besides its files.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct WalkSummary {
    pub files: usize,
    /// Folders holding no files and no folders, relative to the root, in the order walked.
    pub empty_folders: Vec<String>,
    /// Symlinks and other non-regular entries, which Tidy never follows or touches.
    pub skipped_entries: usize,
}

/// Files go to the catalog in batches of about this many.
const BATCH_SIZE: usize = 500;

/// glazier-core stats this many entries at once; batches flush between such slices.
const STAT_SLICE: usize = 32;

/// Files Finder and Explorer write into the folders they show: view settings (`.DS_Store`,
/// `desktop.ini`) and thumbnail caches (`Thumbs.db`). The system writes them again, so cleaning
/// them up never sticks: the walk leaves them out, and one leaves only with its empty folder.
const FOLDER_SYSTEM_FILES: [&str; 5] = [
    ".ds_store",
    "desktop.ini",
    "thumbs.db",
    "ehthumbs.db",
    "ehthumbs_vista.db",
];

pub fn is_folder_system_file(name: &str) -> bool {
    FOLDER_SYSTEM_FILES.contains(&name.to_lowercase().as_str())
}

/// The lowercased extension after the last dot, or "" for none, a leading dot or a trailing one.
pub fn extension_of(name: &str) -> String {
    match name.rfind('.') {
        Some(dot) if dot > 0 && dot + 1 < name.len() => name[dot + 1..].to_lowercase(),
        _ => String::new(),
    }
}

/// Whole milliseconds of a timestamp in seconds and nanoseconds, computed exactly, as
/// glazier-core's `wholeMs` divides `stat`'s nanoseconds: a float can round across a millisecond,
/// and then two reads of one untouched file would disagree about whether it changed.
pub fn whole_ms(seconds: i64, nanoseconds: i64) -> i64 {
    let total = i128::from(seconds) * 1_000_000_000 + i128::from(nanoseconds);
    (total / 1_000_000) as i64
}

/// Walks a root breadth-first. It stays inside the root: symlinks are never followed and
/// non-regular files are skipped. System junk folders (which include old holding folders) are not
/// entered, and Finder's and Explorer's folder files are left out.
///
/// Each folder's entries are taken in byte order of their names, as Node's `readdir` returns
/// them (libuv sorts `scandir` with `strcmp`), so files get the same catalog ids as glazier-core
/// gives them and every query without an `ORDER BY` returns them in the same order.
pub fn walk_root(
    root: &Path,
    mut on_batch: impl FnMut(Vec<WalkedFile>) -> anyhow::Result<()>,
    mut on_progress: impl FnMut(usize, &str),
    check: impl Fn() -> Result<(), Cancelled>,
) -> anyhow::Result<WalkSummary> {
    let mut queue: Vec<String> = vec![String::new()];
    let mut summary = WalkSummary::default();
    let mut batch: Vec<WalkedFile> = Vec::new();
    let mut cursor = 0;

    while cursor < queue.len() {
        check()?;
        let rel_dir = queue[cursor].clone();
        cursor += 1;
        let abs_dir = rel_dir
            .split('/')
            .filter(|segment| !segment.is_empty())
            .fold(root.to_path_buf(), |path, segment| path.join(segment));

        // A folder that vanished or cannot be read is skipped; the rest of the root still scans.
        let Ok(listing) = fs::read_dir(&abs_dir) else {
            continue;
        };
        let mut entries: Vec<(String, fs::FileType)> = Vec::new();
        for entry in entries_of(listing) {
            match entry {
                Some(entry) => entries.push(entry),
                None => summary.skipped_entries += 1,
            }
        }
        entries.sort_by(|left, right| left.0.as_bytes().cmp(right.0.as_bytes()));

        let mut content = 0;
        let mut file_names = Vec::new();
        for (name, kind) in entries {
            if kind.is_dir() {
                if !is_system_junk_directory(&name) {
                    queue.push(join(&rel_dir, &name));
                    content += 1;
                }
            } else if kind.is_file() {
                if is_folder_system_file(&name) {
                    continue;
                }
                if !is_system_junk_file(&name) {
                    content += 1;
                }
                file_names.push(name);
            } else {
                summary.skipped_entries += 1;
            }
        }
        if content == 0 && !rel_dir.is_empty() {
            summary.empty_folders.push(rel_dir.clone());
        }

        for slice in file_names.chunks(STAT_SLICE) {
            for name in slice {
                let path = abs_dir.join(name);
                let stat = fs::symlink_metadata(&path)
                    .ok()
                    .filter(fs::Metadata::is_file);
                let Some(stat) = stat else {
                    summary.skipped_entries += 1;
                    continue;
                };
                let (dev, ino) = dev_ino(&path, &stat);
                batch.push(WalkedFile {
                    rel_path: join(&rel_dir, name),
                    dir: rel_dir.clone(),
                    ext: extension_of(name),
                    size: stat.size() as i64,
                    mtime_ms: whole_ms(stat.mtime(), stat.mtime_nsec()),
                    ctime_ms: whole_ms(stat.ctime(), stat.ctime_nsec()),
                    dev: dev.to_string(),
                    ino: ino.to_string(),
                    junk: is_system_junk_file(name),
                    name: name.clone(),
                });
                summary.files += 1;
            }
            if batch.len() >= BATCH_SIZE {
                on_batch(std::mem::take(&mut batch))?;
            }
        }
        on_progress(summary.files, &rel_dir);
    }
    if !batch.is_empty() {
        on_batch(batch)?;
    }
    Ok(summary)
}

/// A folder's entries as names and types; `None` for one whose name is not Unicode or whose type
/// cannot be read, which the walk counts as skipped.
fn entries_of(entries: fs::ReadDir) -> impl Iterator<Item = Option<(String, fs::FileType)>> {
    entries.filter_map(|entry| {
        let entry = entry.ok()?;
        Some(
            entry
                .file_name()
                .into_string()
                .ok()
                .zip(entry.file_type().ok()),
        )
    })
}

fn join(dir: &str, name: &str) -> String {
    if dir.is_empty() {
        name.to_owned()
    } else {
        format!("{dir}/{name}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_walk_takes_names_in_byte_order_and_never_follows_links() {
        let root = std::env::temp_dir().join(format!("oriel-tidy-walk-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        for folder in ["b", "a", "only-junk", "empty", ".Trashes", "Z"] {
            fs::create_dir_all(root.join(folder)).unwrap();
        }
        for file in [
            "b/2.jpg",
            "b/10.jpg",
            "a/x.png",
            "Z/z.png",
            "only-junk/._x.png",
            "c.txt",
        ] {
            fs::write(root.join(file), b"bytes").unwrap();
        }
        fs::write(root.join("a/.DS_Store"), b"view").unwrap();
        fs::write(root.join(".Trashes/gone.png"), b"bytes").unwrap();
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(root.join("a"), root.join("a-link")).unwrap();
            std::os::unix::fs::symlink(root.join("c.txt"), root.join("c-link.txt")).unwrap();
        }
        #[cfg(windows)]
        {
            std::os::windows::fs::symlink_dir(root.join("a"), root.join("a-link")).unwrap();
            std::os::windows::fs::symlink_file(root.join("c.txt"), root.join("c-link.txt"))
                .unwrap();
        }

        let mut files = Vec::new();
        let summary = walk_root(
            &root,
            |batch| {
                files.extend(batch.into_iter().map(|file| (file.rel_path, file.junk)));
                Ok(())
            },
            |_, _| {},
            || Ok(()),
        )
        .unwrap();
        let _ = fs::remove_dir_all(&root);

        // Breadth first, each folder in byte order: upper case before lower, "10" before "2".
        assert_eq!(
            files,
            [
                ("c.txt".to_owned(), false),
                ("Z/z.png".to_owned(), false),
                ("a/x.png".to_owned(), false),
                ("b/10.jpg".to_owned(), false),
                ("b/2.jpg".to_owned(), false),
                ("only-junk/._x.png".to_owned(), true),
            ]
        );
        // A folder of junk alone is empty; the two links are skipped, never followed.
        assert_eq!(summary.empty_folders, ["empty", "only-junk"]);
        assert_eq!(summary.skipped_entries, 2);
        assert_eq!(summary.files, 6);
    }

    #[test]
    fn extensions_and_times_read_as_glazier_core_reads_them() {
        assert_eq!(extension_of("photo.JPG"), "jpg");
        assert_eq!(extension_of(".hidden"), "");
        assert_eq!(extension_of("trailing."), "");
        assert_eq!(whole_ms(1, 999_999_999), 1999);
        assert_eq!(whole_ms(-1, 500_000_000), -500);
    }
}
