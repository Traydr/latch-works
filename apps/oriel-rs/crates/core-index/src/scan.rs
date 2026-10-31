//! The archive scan, ported from `media-index`'s `scan.ts`: every media file under a source root
//! as an archive-relative item, the entries it skipped and why, each file's size and modified
//! time, and optionally its SHA-256.
//!
//! The rules are the TypeScript's:
//! - folders `media-domain` calls system folders (`.latch-works`, `__MACOSX`, `.Trashes`, …) are
//!   not entered, and its junk files (`.DS_Store`, `._*`, `Thumbs.db`, …) are skipped;
//! - a symlink is neither a file nor a folder, so it is skipped and never followed;
//! - folders are read, and files stated and hashed, through two bounded pools (plan 035): four
//!   at once by default, one to sixteen when asked. On macOS a folder's read gives each file's
//!   size and times as `stat` would (`getattrlistbulk`), so its files need no `stat` of their own;
//! - items and skipped entries come out sorted by path as `localeCompare` sorts them, whatever
//!   order the pools finished in, so a scan gives the same result at any concurrency.
//!
//! Collation is the root locale's at tertiary strength, which is `localeCompare` with no
//! arguments under an English system locale. Oriel RS never follows the system locale (the
//! owner, 2026-10-29), so a Lithuanian system would order a few names differently in the two
//! apps.

use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::Read as _;
use std::path::{Component, Path, PathBuf};
use std::sync::{LazyLock, Mutex, PoisonError};
use std::time::UNIX_EPOCH;

use anyhow::{Context as _, Result};
use icu_collator::options::CollatorOptions;
use icu_collator::{CollatorBorrowed, CollatorPreferences};
use oriel_core_domain::{
    MediaItem, detect_media_type, get_extension, get_parent_path, is_supported_media_file,
    is_system_junk_directory, is_system_junk_file, join_archive_path,
};
use oriel_runtime::CancelToken;
use serde::{Deserialize, Serialize};
use sha2::{Digest as _, Sha256};

use crate::folder::{EntryKind, FileStat, read_entries};
use crate::pool::{self, run_queue};

/// Node's `createReadStream` reads 64 KiB at a time, and progress is reported per read.
const READ_CHUNK: usize = 64 * 1024;

/// A file's identity for "has it changed": its size and its times in whole milliseconds, as
/// `normalizeFingerprint` truncates them. The change time is absent where the platform has none.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveFileFingerprint {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ctime_ms: Option<f64>,
    pub mtime_ms: f64,
    pub size: u64,
}

impl ArchiveFileFingerprint {
    /// The fingerprint `fs.stat` gives, with the times truncated.
    pub fn of(metadata: &fs::Metadata) -> Self {
        Self::from_stat(FileStat::of(metadata))
    }

    fn from_stat(stat: FileStat) -> Self {
        Self {
            ctime_ms: stat.changed_ms.map(f64::trunc),
            mtime_ms: stat.modified_ms.trunc(),
            size: stat.size,
        }
    }

    fn normalized(self) -> Self {
        Self {
            ctime_ms: self.ctime_ms.map(f64::trunc),
            mtime_ms: self.mtime_ms.trunc(),
            size: self.size,
        }
    }
}

/// Node's `mtimeMs`: whole seconds in milliseconds plus the nanoseconds as a fraction, summed in
/// that order so the same file gives the same float.
pub fn modified_ms(metadata: &fs::Metadata) -> f64 {
    metadata
        .modified()
        .ok()
        .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
        .map(|since| since.as_secs() as f64 * 1e3 + f64::from(since.subsec_nanos()) / 1e6)
        .unwrap_or(0.0)
}

/// `fingerprintsMatch`: the same size and the same whole-millisecond modified time, and the same
/// change time when both have one.
pub fn fingerprints_match(left: &ArchiveFileFingerprint, right: &ArchiveFileFingerprint) -> bool {
    left.size == right.size
        && left.mtime_ms.trunc() == right.mtime_ms.trunc()
        && match (left.ctime_ms, right.ctime_ms) {
            (Some(left), Some(right)) => left.trunc() == right.trunc(),
            _ => true,
        }
}

/// `escapesRoot`: whether a relative path leaves the folder it is relative to. Only a leading
/// `..` segment does; a name that merely starts with two dots (`..cover.jpg`) stays inside.
pub fn escapes_root(relative: &str) -> bool {
    let separator = std::path::MAIN_SEPARATOR;
    relative == ".."
        || relative.starts_with(&format!("..{separator}"))
        || Path::new(relative).is_absolute()
}

/// Why the scan left an entry out.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SkipReason {
    SystemFile,
    UnsupportedExtension,
    NotARegularFile,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SkippedArchiveEntry {
    pub path: String,
    pub reason: SkipReason,
}

/// What a running scan reports. Reports come from the pools' threads, in no fixed order.
#[derive(Clone, Debug, PartialEq)]
pub enum ScanArchiveProgress {
    Scanning {
        files_found: usize,
        path: Option<String>,
        skipped: usize,
    },
    Hashing {
        bytes_hashed: u64,
        file_size: u64,
        files_found: usize,
        path: String,
        skipped: usize,
    },
}

/// A finished scan.
#[derive(Clone, Debug, PartialEq)]
pub struct ScanArchiveResult {
    /// Each item's fingerprint, by its archive path.
    pub fingerprints: HashMap<String, ArchiveFileFingerprint>,
    /// The media, sorted by path.
    pub items: Vec<MediaItem>,
    pub skipped: usize,
    /// What was left out, sorted by path.
    pub skipped_entries: Vec<SkippedArchiveEntry>,
    /// The root, absolute.
    pub source_root: PathBuf,
}

type ProgressCallback<'a> = &'a (dyn Fn(ScanArchiveProgress) + Sync);

/// One scan of an archive: `scanArchive`'s options as a builder.
pub struct ScanArchive<'a> {
    source_root: PathBuf,
    directory_concurrency: Option<usize>,
    file_concurrency: Option<usize>,
    hash_files: bool,
    cancel: Option<&'a CancelToken>,
    on_progress: Option<ProgressCallback<'a>>,
}

impl<'a> ScanArchive<'a> {
    pub fn new(source_root: impl Into<PathBuf>) -> Self {
        Self {
            source_root: source_root.into(),
            directory_concurrency: None,
            file_concurrency: None,
            hash_files: false,
            cancel: None,
            on_progress: None,
        }
    }

    /// How many folders are read at once: 1 to 16, 4 by default.
    pub fn directory_concurrency(mut self, concurrency: usize) -> Self {
        self.directory_concurrency = Some(concurrency);
        self
    }

    /// How many files are stated, and hashed, at once: 1 to 16, 4 by default.
    pub fn file_concurrency(mut self, concurrency: usize) -> Self {
        self.file_concurrency = Some(concurrency);
        self
    }

    /// Hash every item, so its id becomes its SHA-256.
    pub fn hash_files(mut self, hash_files: bool) -> Self {
        self.hash_files = hash_files;
        self
    }

    pub fn cancel_on(mut self, token: &'a CancelToken) -> Self {
        self.cancel = Some(token);
        self
    }

    pub fn on_progress(mut self, callback: ProgressCallback<'a>) -> Self {
        self.on_progress = Some(callback);
        self
    }

    /// Runs the scan. Blocks on the file system; run it on a background thread. A folder that
    /// cannot be read fails the whole scan, as it does in the TypeScript.
    pub fn run(self) -> Result<ScanArchiveResult> {
        let directory_concurrency = pool::concurrency(self.directory_concurrency)?;
        let file_concurrency = pool::concurrency(self.file_concurrency)?;
        let root = absolute(&self.source_root)?;
        let progress = |report| {
            if let Some(callback) = self.on_progress {
                callback(report);
            }
        };

        let skipped_entries = Mutex::new(Vec::<SkippedArchiveEntry>::new());
        let candidates = Mutex::new(Vec::<Candidate>::new());
        let skip = |path: String, reason: SkipReason| {
            let mut skipped = skipped_entries
                .lock()
                .unwrap_or_else(PoisonError::into_inner);
            skipped.push(SkippedArchiveEntry { path, reason });
            skipped.len()
        };

        run_queue(
            directory_concurrency,
            vec![root.clone()],
            self.cancel,
            |current: PathBuf, queue| {
                check(self.cancel)?;
                // On macOS the read also gives each file's size and times, so the files need no
                // `stat` of their own below.
                let mut entries: Vec<(String, EntryKind, Option<FileStat>)> =
                    read_entries(&current)
                        .with_context(|| format!("cannot read {}", current.display()))?
                        .map(|entry| {
                            let entry = entry?;
                            Ok((
                                entry.name.to_string_lossy().into_owned(),
                                entry.kind,
                                entry.stat,
                            ))
                        })
                        .collect::<std::io::Result<_>>()
                        .with_context(|| format!("cannot read {}", current.display()))?;
                check(self.cancel)?;
                if !queue.is_running() {
                    return Ok(());
                }
                entries.sort_by(|left, right| locale_compare(&left.0, &right.0));

                let mut found = Vec::new();
                for (name, kind, stat) in entries {
                    check(self.cancel)?;
                    if !queue.is_running() {
                        return Ok(());
                    }
                    let absolute_path = current.join(&name);
                    // The entry's type does not follow a symlink, as `readdir`'s dirents do not,
                    // so a link is neither and is skipped.
                    if kind == EntryKind::Folder {
                        if !is_system_junk_directory(&name) {
                            queue.add(absolute_path);
                        }
                        continue;
                    }
                    let relative_path = archive_path(&root, &absolute_path);
                    if kind != EntryKind::File {
                        skip(relative_path, SkipReason::NotARegularFile);
                        continue;
                    }
                    if is_system_junk_file(&name) {
                        let skipped = skip(relative_path, SkipReason::SystemFile);
                        progress(ScanArchiveProgress::Scanning {
                            files_found: 0,
                            path: None,
                            skipped,
                        });
                        continue;
                    }
                    if !is_supported_media_file(&name) {
                        let skipped = skip(relative_path, SkipReason::UnsupportedExtension);
                        progress(ScanArchiveProgress::Scanning {
                            files_found: 0,
                            path: None,
                            skipped,
                        });
                        continue;
                    }
                    found.push(Candidate {
                        absolute_path,
                        name,
                        key: sort_key(&relative_path),
                        path: relative_path,
                        stat,
                    });
                }
                candidates
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner)
                    .append(&mut found);
                Ok(())
            },
        )?;

        let mut candidates = candidates
            .into_inner()
            .unwrap_or_else(PoisonError::into_inner);
        let mut skipped_entries = skipped_entries
            .into_inner()
            .unwrap_or_else(PoisonError::into_inner);
        sort_candidates(&mut candidates);
        skipped_entries.sort_by(|left, right| locale_compare(&left.path, &right.path));
        let skipped = skipped_entries.len();

        // Each candidate's item, in the candidates' order. Those the folder reads gave facts for
        // are made here; the rest are stated through the file pool.
        let mut found: Vec<Option<(MediaItem, ArchiveFileFingerprint)>> =
            Vec::with_capacity(candidates.len());
        let mut unstated = Vec::new();
        let mut files_found = 0;
        for (ix, candidate) in candidates.iter().enumerate() {
            let Some(stat) = candidate.stat else {
                found.push(None);
                unstated.push(ix);
                continue;
            };
            check(self.cancel)?;
            found.push(Some(
                candidate.indexed(ArchiveFileFingerprint::from_stat(stat)),
            ));
            files_found += 1;
            progress(ScanArchiveProgress::Scanning {
                files_found,
                path: Some(candidate.path.clone()),
                skipped,
            });
        }

        if !unstated.is_empty() {
            let stated = Mutex::new((files_found, Vec::with_capacity(unstated.len())));
            run_queue(
                file_concurrency,
                unstated,
                self.cancel,
                |ix: usize, queue| {
                    let candidate = &candidates[ix];
                    check(self.cancel)?;
                    let metadata = fs::metadata(&candidate.absolute_path).with_context(|| {
                        format!("cannot stat {}", candidate.absolute_path.display())
                    })?;
                    let fingerprint = ArchiveFileFingerprint::of(&metadata);
                    check(self.cancel)?;
                    if !queue.is_running() {
                        return Ok(());
                    }
                    let files_found = {
                        let mut stated = stated.lock().unwrap_or_else(PoisonError::into_inner);
                        stated.0 += 1;
                        stated.1.push((ix, candidate.indexed(fingerprint)));
                        stated.0
                    };
                    progress(ScanArchiveProgress::Scanning {
                        files_found,
                        path: Some(candidate.path.clone()),
                        skipped,
                    });
                    Ok(())
                },
            )?;
            let (_, stated) = stated.into_inner().unwrap_or_else(PoisonError::into_inner);
            for (ix, indexed) in stated {
                found[ix] = Some(indexed);
            }
        }

        let mut fingerprints = HashMap::with_capacity(candidates.len());
        let mut items = Vec::with_capacity(candidates.len());
        for (candidate, indexed) in candidates.iter().zip(found) {
            if let Some((item, fingerprint)) = indexed {
                fingerprints.insert(candidate.path.clone(), fingerprint);
                items.push(item);
            }
        }

        if self.hash_files {
            items = HashArchiveItems::new(&root, items)
                .fingerprints(&fingerprints)
                .file_concurrency(file_concurrency)
                .skipped(skipped)
                .cancel(self.cancel)
                .progress(self.on_progress)
                .run()?;
        }

        Ok(ScanArchiveResult {
            fingerprints,
            items,
            skipped,
            skipped_entries,
            source_root: root,
        })
    }
}

struct Candidate {
    absolute_path: PathBuf,
    name: String,
    path: String,
    /// The path's sort key, which orders it among the others.
    key: Box<[u8]>,
    /// The size and times the folder's read gave, if it did.
    stat: Option<FileStat>,
}

impl Candidate {
    /// The candidate's item, as `scanArchive` makes it from the file's fingerprint.
    fn indexed(&self, fingerprint: ArchiveFileFingerprint) -> (MediaItem, ArchiveFileFingerprint) {
        let item = MediaItem {
            id: self.path.clone(),
            path: self.path.clone(),
            parent_path: get_parent_path(&self.path),
            name: self.name.clone(),
            extension: get_extension(&self.name),
            media_type: detect_media_type(&self.name),
            size: fingerprint.size,
            mtime_ms: fingerprint.mtime_ms,
            sha256: None,
            width: None,
            height: None,
            duration_ms: None,
            page_count: None,
            thumbnail_url: None,
            original_url: None,
        };
        (item, fingerprint)
    }
}

/// `hashArchiveItems`: the items of a scan with their SHA-256 as their id. Items that already
/// have a hash, and those outside `paths` when it is given, are left as they are.
pub struct HashArchiveItems<'a> {
    source_root: &'a Path,
    items: Vec<MediaItem>,
    fingerprints: Option<&'a HashMap<String, ArchiveFileFingerprint>>,
    paths: Option<&'a HashSet<String>>,
    file_concurrency: Option<usize>,
    skipped: usize,
    cancel: Option<&'a CancelToken>,
    on_progress: Option<ProgressCallback<'a>>,
}

impl<'a> HashArchiveItems<'a> {
    pub fn new(source_root: &'a Path, items: Vec<MediaItem>) -> Self {
        Self {
            source_root,
            items,
            fingerprints: None,
            paths: None,
            file_concurrency: None,
            skipped: 0,
            cancel: None,
            on_progress: None,
        }
    }

    /// What each file looked like when it was scanned; a file that differs after its hash fails
    /// the run.
    pub fn fingerprints(
        mut self,
        fingerprints: &'a HashMap<String, ArchiveFileFingerprint>,
    ) -> Self {
        self.fingerprints = Some(fingerprints);
        self
    }

    /// Hash only these archive paths.
    pub fn paths(mut self, paths: &'a HashSet<String>) -> Self {
        self.paths = Some(paths);
        self
    }

    pub fn file_concurrency(mut self, concurrency: usize) -> Self {
        self.file_concurrency = Some(concurrency);
        self
    }

    fn skipped(mut self, skipped: usize) -> Self {
        self.skipped = skipped;
        self
    }

    fn cancel(mut self, token: Option<&'a CancelToken>) -> Self {
        self.cancel = token;
        self
    }

    fn progress(mut self, callback: Option<ProgressCallback<'a>>) -> Self {
        self.on_progress = callback;
        self
    }

    pub fn cancel_on(self, token: &'a CancelToken) -> Self {
        self.cancel(Some(token))
    }

    pub fn on_progress(self, callback: ProgressCallback<'a>) -> Self {
        self.progress(Some(callback))
    }

    pub fn run(self) -> Result<Vec<MediaItem>> {
        let concurrency = pool::concurrency(self.file_concurrency)?;
        let root = absolute(self.source_root)?;
        let tasks: Vec<&MediaItem> = self
            .items
            .iter()
            .filter(|item| {
                item.sha256.is_none() && self.paths.is_none_or(|paths| paths.contains(&item.path))
            })
            .collect();
        let hashes = Mutex::new(HashMap::<String, String>::new());
        let files_found = self.items.len();

        run_queue(
            concurrency,
            tasks,
            self.cancel,
            |item: &MediaItem, queue| {
                check(self.cancel)?;
                let file_path = item
                    .path
                    .split('/')
                    .fold(root.clone(), |path, segment| path.join(segment));
                let file_path = normalize(&file_path);
                let relative = relative_to(&root, &file_path);
                anyhow::ensure!(
                    !escapes_root(&relative),
                    "Archive path escapes source root: {}",
                    item.path
                );
                let expected = self
                    .fingerprints
                    .and_then(|fingerprints| fingerprints.get(&item.path).copied())
                    .unwrap_or(ArchiveFileFingerprint {
                        ctime_ms: None,
                        mtime_ms: item.mtime_ms,
                        size: item.size,
                    });
                let on_bytes = |bytes_hashed| {
                    if queue.is_running()
                        && let Some(callback) = self.on_progress
                    {
                        callback(ScanArchiveProgress::Hashing {
                            bytes_hashed,
                            file_size: item.size,
                            files_found,
                            path: item.path.clone(),
                            skipped: self.skipped,
                        });
                    }
                };
                let sha256 =
                    hash_file_contents(&file_path, Some(&expected), self.cancel, &on_bytes)?;
                if queue.is_running() {
                    hashes
                        .lock()
                        .unwrap_or_else(PoisonError::into_inner)
                        .insert(item.path.clone(), sha256);
                }
                Ok(())
            },
        )?;

        let hashes = hashes.into_inner().unwrap_or_else(PoisonError::into_inner);
        Ok(self
            .items
            .into_iter()
            .map(|mut item| {
                if let Some(sha256) = hashes.get(&item.path) {
                    item.id = sha256.clone();
                    item.sha256 = Some(sha256.clone());
                }
                item
            })
            .collect())
    }
}

/// `hashFileContents`: the file's SHA-256 in hex, read in 64 KiB chunks. With `expected`, the
/// file is stated again afterwards and a change since `expected` fails the hash, so a file
/// written during the read is never recorded under a hash it no longer has.
pub fn hash_file_contents(
    file_path: &Path,
    expected: Option<&ArchiveFileFingerprint>,
    cancel: Option<&CancelToken>,
    on_progress: &dyn Fn(u64),
) -> Result<String> {
    check(cancel)?;
    let mut file = fs::File::open(file_path)
        .with_context(|| format!("cannot open {}", file_path.display()))?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0; READ_CHUNK];
    let mut bytes_hashed = 0u64;
    loop {
        check(cancel)?;
        let read = file
            .read(&mut buffer)
            .with_context(|| format!("cannot read {}", file_path.display()))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
        bytes_hashed += read as u64;
        on_progress(bytes_hashed);
    }
    check(cancel)?;

    if let Some(expected) = expected {
        let after = fs::metadata(file_path)
            .with_context(|| format!("cannot stat {}", file_path.display()))?;
        check(cancel)?;
        if !fingerprints_match(&expected.normalized(), &ArchiveFileFingerprint::of(&after)) {
            anyhow::bail!("File changed while hashing: {}", file_path.display());
        }
    }

    let digest: [u8; 32] = hasher.finalize().into();
    Ok(digest.iter().map(|byte| format!("{byte:02x}")).collect())
}

fn check(cancel: Option<&CancelToken>) -> Result<()> {
    match cancel {
        Some(token) => Ok(token.check()?),
        None => Ok(()),
    }
}

/// The root collator at its default, tertiary strength: `String.prototype.localeCompare` with
/// no locale and no options.
static LOCALE_COLLATOR: LazyLock<CollatorBorrowed<'static>> = LazyLock::new(|| {
    CollatorBorrowed::try_new(CollatorPreferences::default(), CollatorOptions::default())
        .expect("the compiled collation data has the root locale")
});

/// The collator's sort key of `path`: comparing two keys as bytes orders their paths as
/// [`locale_compare`] does.
fn sort_key(path: &str) -> Box<[u8]> {
    let mut key = Vec::with_capacity(path.len() * 2);
    let Ok(()) = LOCALE_COLLATOR.write_sort_key_to(path, &mut key);
    key.into_boxed_slice()
}

/// Sorts the candidates by path as `localeCompare` orders them, keeping those it calls equal in
/// the order they came, as a stable sort through [`locale_compare`] does.
///
/// A scan sorts tens of thousands of paths, so each one's sort key is made as its folder is read,
/// on the folder pool's threads, and the keys are compared as bytes. The order is then checked
/// pair by pair against the collator itself, and should the two ever disagree the candidates are
/// sorted through the collator instead, so the result is always its order.
fn sort_candidates(candidates: &mut [Candidate]) {
    candidates.sort_by(|left, right| left.key.cmp(&right.key));
    let agrees = candidates.windows(2).all(|pair| {
        match locale_compare(&pair[0].path, &pair[1].path) {
            Ordering::Less => true,
            // Equal keys kept the order they came in; unequal ones may not have.
            Ordering::Equal => pair[0].key == pair[1].key,
            Ordering::Greater => false,
        }
    });
    if !agrees {
        log::warn!("the collator's sort keys disagree with it; sorting the scan through it");
        candidates.sort_by(|left, right| locale_compare(&left.path, &right.path));
    }
}

/// `a.localeCompare(b)`, in the root locale.
pub fn locale_compare(a: &str, b: &str) -> Ordering {
    LOCALE_COLLATOR.compare(a, b)
}

/// `path.resolve`: absolute, with `.` and `..` folded, and no symlink resolved.
fn absolute(path: &Path) -> Result<PathBuf> {
    let absolute =
        std::path::absolute(path).with_context(|| format!("cannot resolve {}", path.display()))?;
    Ok(normalize(&absolute))
}

/// Folds `.` and `..` out of an absolute path, as `path.resolve` does, without the file system.
fn normalize(path: &Path) -> PathBuf {
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                normalized.pop();
            }
            other => normalized.push(other),
        }
    }
    normalized
}

/// `path.relative(root, path)` for a `path` that may or may not be inside `root`.
fn relative_to(root: &Path, path: &Path) -> String {
    match path.strip_prefix(root) {
        Ok(inside) => inside.to_string_lossy().into_owned(),
        Err(_) => {
            let root: Vec<_> = root.components().collect();
            let path: Vec<_> = path.components().collect();
            let common = root
                .iter()
                .zip(&path)
                .take_while(|(left, right)| left == right)
                .count();
            let mut relative = PathBuf::new();
            for _ in common..root.len() {
                relative.push("..");
            }
            for component in &path[common..] {
                relative.push(component);
            }
            relative.to_string_lossy().into_owned()
        }
    }
}

/// The archive path of a file under `root`: `joinArchivePath(path.relative(root, file))`.
fn archive_path(root: &Path, file: &Path) -> String {
    join_archive_path(&[relative_to(root, file)])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn relative_paths_climb_out_of_the_root_with_dot_dot() {
        assert_eq!(
            relative_to(Path::new("/a/b"), Path::new("/a/b/c/d.jpg")),
            "c/d.jpg"
        );
        assert_eq!(
            relative_to(Path::new("/a/b"), Path::new("/a/x.jpg")),
            "../x.jpg"
        );
        assert_eq!(
            normalize(Path::new("/a/b/../c/./d")),
            PathBuf::from("/a/c/d")
        );
    }

    #[test]
    fn a_file_that_changes_while_it_is_hashed_fails() {
        let folder =
            std::env::temp_dir().join(format!("oriel-core-index-hash-{}", std::process::id()));
        fs::create_dir_all(&folder).unwrap();
        let file = folder.join("a.jpg");
        fs::write(&file, b"abc").unwrap();
        let metadata = fs::metadata(&file).unwrap();
        let fingerprint = ArchiveFileFingerprint::of(&metadata);
        assert_eq!(
            hash_file_contents(&file, Some(&fingerprint), None, &|_| {}).unwrap(),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        let stale = ArchiveFileFingerprint {
            size: 4,
            ..fingerprint
        };
        let error = hash_file_contents(&file, Some(&stale), None, &|_| {}).unwrap_err();
        assert!(
            error
                .to_string()
                .starts_with("File changed while hashing: ")
        );
        fs::remove_dir_all(&folder).unwrap();
    }
}
