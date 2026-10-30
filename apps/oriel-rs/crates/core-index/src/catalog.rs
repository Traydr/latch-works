//! View's scan of a folder, ported from Electron Oriel's `catalog/CatalogRuntime.ts` and
//! `catalogDiscoveryAdapter.ts`: the media the gallery shows, found breadth first and streamed
//! to it in batches while the scan goes on, and recorded in the [`MediaIndex`].
//!
//! It differs from [`crate::scan`] on purpose, as the two do in Electron Oriel: items carry
//! absolute paths, a scan lists only the folder's own files unless it is recursive, the root's
//! excluded children are not entered, the settings' filters choose the extensions, and a folder
//! that cannot be read is reported and passed over rather than failing the scan. The skip rules
//! are the same: system folders are not entered, junk files are left out, and symlinks are never
//! followed.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex, PoisonError};
use std::time::{Duration, Instant};

use futures::executor::block_on;
use icu_collator::options::{CollatorOptions, Strength};
use icu_collator::{CollatorBorrowed, CollatorPreferences};
use oriel_core_domain::{FolderNode, get_extension, is_system_junk_directory, is_system_junk_file};
use oriel_runtime::CancelToken;
use serde::{Deserialize, Serialize};

use crate::media_index::{MediaIndex, ScanWrites, ScanWritesEnd};
use crate::pool::run_queue;
use crate::scan::modified_ms;

#[cfg(target_os = "macos")]
mod bulk;

/// Items sent to the gallery, and written to the index, at a time (`CATALOG_BATCH_SIZE`).
pub const BATCH_SIZE: usize = 300;
/// Files of a folder stated at once (`CATALOG_FILE_STAT_CONCURRENCY`).
pub const FILE_STAT_CONCURRENCY: usize = 10;
/// The least time between two progress events (`CATALOG_PROGRESS_EVENT_INTERVAL_MS`).
pub const PROGRESS_INTERVAL: Duration = Duration::from_millis(80);

/// View's two kinds: a GIF is an image here, as `classifyFrameCandidate` calls it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CatalogMediaType {
    Image,
    Video,
}

impl CatalogMediaType {
    /// The name the index stores.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Image => "image",
            Self::Video => "video",
        }
    }
}

/// One file View shows, as View's `MediaItemSchema` describes it: an absolute path, and an id
/// that changes when the file does.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogItem {
    /// `path:size:mtimeMs`, with the time written as JavaScript writes a number.
    pub id: String,
    pub path: String,
    pub name: String,
    pub extension: String,
    pub media_type: CatalogMediaType,
    pub size: u64,
    /// `fs.stat`'s `mtimeMs`: milliseconds since the epoch with a fraction.
    pub mtime_ms: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub width: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub height: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub codec: Option<String>,
}

impl CatalogItem {
    /// `toFrameMediaItem`.
    pub fn new(
        path: String,
        name: String,
        extension: String,
        media_type: CatalogMediaType,
        size: u64,
        mtime_ms: f64,
    ) -> Self {
        Self {
            id: format!("{path}:{size}:{mtime_ms}"),
            path,
            name,
            extension,
            media_type,
            size,
            mtime_ms,
            width: None,
            height: None,
            duration_ms: None,
            codec: None,
        }
    }
}

/// Which files a scan lists: the settings' `filters`, extensions lowercased without their dot.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CatalogFilters {
    pub image_extensions: HashSet<String>,
    pub video_extensions: HashSet<String>,
    pub show_images: bool,
    pub show_videos: bool,
}

impl CatalogFilters {
    /// `classifyFrameCandidate`: the file's canonical extension and kind, or `None` for junk and
    /// for files the filters leave out. A video wins over an image when a list has both.
    pub fn classify(&self, name: &str) -> Option<(String, CatalogMediaType)> {
        if is_system_junk_file(name) {
            return None;
        }
        let extension = get_extension(name);
        let image = self.show_images && self.image_extensions.contains(&extension);
        let video = self.show_videos && self.video_extensions.contains(&extension);
        match (image, video) {
            (_, true) => Some((extension, CatalogMediaType::Video)),
            (true, false) => Some((extension, CatalogMediaType::Image)),
            (false, false) => None,
        }
    }
}

/// What a scan tells the gallery, as View's `ScanEventSchema` describes it.
#[derive(Clone, Debug, PartialEq)]
pub enum CatalogEvent {
    /// The scan started: the gallery empties.
    Reset {
        run_id: u64,
        root_path: String,
        recursive: bool,
    },
    Progress {
        run_id: u64,
        scanned_directories: usize,
        discovered_items: usize,
        current_path: String,
    },
    /// Items found since the last batch, in the order found. The index's write of them shares
    /// them.
    Batch {
        run_id: u64,
        items: Arc<[CatalogItem]>,
    },
    Done {
        run_id: u64,
        total_items: usize,
        elapsed: Duration,
    },
    Cancelled {
        run_id: u64,
    },
    /// Something the scan could not do. It goes on, unless it is a cancel or done next.
    Error {
        run_id: Option<u64>,
        message: String,
        path: Option<String>,
    },
}

/// One scan of a folder: `ScanOptions`.
#[derive(Clone, Debug)]
pub struct CatalogScan {
    run_id: u64,
    root: PathBuf,
    recursive: bool,
    filters: CatalogFilters,
    excluded_root_children: HashSet<PathBuf>,
}

impl CatalogScan {
    /// A scan of `root`, which should be absolute and canonical (View resolves the folder it is
    /// given, symlinks included, before it scans).
    pub fn new(run_id: u64, root: PathBuf, recursive: bool, filters: CatalogFilters) -> Self {
        Self {
            run_id,
            root,
            recursive,
            filters,
            excluded_root_children: HashSet::new(),
        }
    }

    /// Children of the root a recursive scan does not enter. Paths that are not the root's
    /// direct children are ignored, as `buildScanContext` drops them.
    pub fn excluding(mut self, paths: impl IntoIterator<Item = PathBuf>) -> Self {
        self.excluded_root_children = paths
            .into_iter()
            .filter(|path| path.parent() == Some(self.root.as_path()))
            .collect();
        self
    }

    pub fn run_id(&self) -> u64 {
        self.run_id
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    /// Runs the scan to its end or its cancel, sending each event to `emit` and recording the
    /// items in `index` when there is one. Blocks, until the index has recorded the scan too;
    /// run it on a background thread. The gallery hears `Done` as soon as the folder is read,
    /// before the index has caught up.
    pub fn run(
        self,
        index: Option<&MediaIndex>,
        cancel: &CancelToken,
        emit: &mut dyn FnMut(CatalogEvent),
    ) {
        let run_id = self.run_id;
        let root_path = self.root.to_string_lossy().into_owned();
        let started = Instant::now();

        // The index's writes are queued and the scan does not wait on them; only the start of
        // the run is waited on, for its id.
        let writes = match index {
            Some(index) => match block_on(index.start_scan(root_path.clone(), self.recursive)) {
                Ok(scan_id) => Some(index.scan_writes(root_path.clone(), scan_id)),
                Err(error) => {
                    emit(CatalogEvent::Error {
                        run_id: Some(run_id),
                        message: format!("Media index unavailable: {error:#}"),
                        path: None,
                    });
                    None
                }
            },
            None => None,
        };
        // A failed batch is reported once, when the scan next looks.
        let report_failure = |writes: &Option<ScanWrites>, emit: &mut dyn FnMut(CatalogEvent)| {
            if let Some(message) = writes.as_ref().and_then(ScanWrites::take_failure) {
                emit(CatalogEvent::Error {
                    run_id: Some(run_id),
                    message: format!("Media index update failed: {message}"),
                    path: None,
                });
            }
        };
        // A cancel is recorded once what was queued before it has run, so a scan started next
        // finds the index as this one left it.
        let cancelled = |writes: Option<ScanWrites>, emit: &mut dyn FnMut(CatalogEvent)| {
            report_failure(&writes, emit);
            emit(CatalogEvent::Cancelled { run_id });
            if let Some(writes) = writes {
                let _ = block_on(writes.cancel());
            }
        };

        if cancel.is_cancelled() {
            cancelled(writes, emit);
            return;
        }
        emit(CatalogEvent::Reset {
            run_id,
            root_path: root_path.clone(),
            recursive: self.recursive,
        });

        let mut scanned_directories = 0;
        let mut discovered_items = 0;
        let mut pending: Vec<CatalogItem> = Vec::new();
        let mut last_progress: Option<Instant> = None;
        let mut pending_progress: Option<String> = None;

        let flush = |pending: &mut Vec<CatalogItem>,
                     writes: &Option<ScanWrites>,
                     emit: &mut dyn FnMut(CatalogEvent)| {
            if pending.is_empty() {
                return;
            }
            // The gallery and the index share the batch.
            let batch: Arc<[CatalogItem]> = std::mem::take(pending).into();
            emit(CatalogEvent::Batch {
                run_id,
                items: batch.clone(),
            });
            if let Some(writes) = writes {
                writes.upsert(batch);
            }
            report_failure(writes, emit);
        };

        // Breadth first, one folder at a time, in the order found; the folders are read ahead
        // on threads of their own.
        let scan = &self;
        let ahead = ReadAhead::new(scan.root.clone());
        let walked = std::thread::scope(|scope| {
            // The readers stop as the walk leaves, however it leaves, so the scope can end.
            let _stop = ahead.stop_on_drop();
            for _ in 0..READ_AHEAD_THREADS {
                scope.spawn(|| ahead.serve(scan, cancel));
            }
            while let Some((current, read)) = ahead.next() {
                if cancel.is_cancelled() {
                    return Walked::Cancelled;
                }
                let candidates = match read {
                    Ok(read) => {
                        ahead.push(read.subfolders);
                        read.candidates
                    }
                    Err(_) => {
                        emit(CatalogEvent::Error {
                            run_id: Some(run_id),
                            message: "Unable to access directory".into(),
                            path: Some(current.to_string_lossy().into_owned()),
                        });
                        continue;
                    }
                };
                scanned_directories += 1;
                pending_progress = Some(current.to_string_lossy().into_owned());
                emit_progress(
                    run_id,
                    scanned_directories,
                    discovered_items,
                    &mut pending_progress,
                    &mut last_progress,
                    false,
                    emit,
                );

                for result in stat_candidates(candidates, cancel) {
                    match result {
                        Stat::Item(item) => {
                            pending.push(item);
                            discovered_items += 1;
                            if pending.len() >= BATCH_SIZE {
                                flush(&mut pending, &writes, emit);
                            }
                        }
                        Stat::Failed(path) => emit(CatalogEvent::Error {
                            run_id: Some(run_id),
                            message: "Unable to stat file".into(),
                            path: Some(path),
                        }),
                        Stat::Cancelled => return Walked::Cancelled,
                    }
                }
            }
            Walked::Done
        });
        if walked == Walked::Cancelled {
            cancelled(writes, emit);
            return;
        }

        if cancel.is_cancelled() {
            cancelled(writes, emit);
            return;
        }
        flush(&mut pending, &writes, emit);
        emit_progress(
            run_id,
            scanned_directories,
            discovered_items,
            &mut pending_progress,
            &mut last_progress,
            true,
            emit,
        );
        if cancel.is_cancelled() {
            cancelled(writes, emit);
            return;
        }

        // The scan's end is queued behind its batches before the gallery hears it is done, so a
        // scan started after this one is queued behind it. The index is a cache: the gallery
        // does not wait for it, and a failure to finish it is reported, the scan still done.
        let finished = writes.as_ref().map(ScanWrites::finish);
        emit(CatalogEvent::Done {
            run_id,
            total_items: discovered_items,
            elapsed: started.elapsed(),
        });
        // What goes wrong after `Done` the gallery no longer shows, so it is logged too.
        if let Some(finished) = finished {
            let end = block_on(finished);
            if let Some(message) = writes.as_ref().and_then(ScanWrites::take_failure) {
                log::warn!("View's media index update failed: {message}");
                emit(CatalogEvent::Error {
                    run_id: Some(run_id),
                    message: format!("Media index update failed: {message}"),
                    path: None,
                });
            }
            let error = match end {
                Ok(ScanWritesEnd::Done | ScanWritesEnd::Cancelled) => None,
                Ok(ScanWritesEnd::FinishFailed(error)) | Err(error) => Some(error),
            };
            if let Some(error) = error {
                log::warn!("View's media index finalize failed: {error:#}");
                emit(CatalogEvent::Error {
                    run_id: Some(run_id),
                    message: format!("Media index finalize failed: {error:#}"),
                    path: None,
                });
            }
        }
    }

    /// Reads one folder: its media files as candidates, and its subfolders to enter when the
    /// scan is recursive. The order is the file system's, as `opendir` gives it.
    fn read_directory(&self, current: &Path) -> io::Result<FolderRead> {
        let mut candidates = Vec::new();
        let mut subfolders = Vec::new();
        for entry in read_entries(current)? {
            let DirEntry { name, kind, stat } = entry?;
            let name = name.to_string_lossy().into_owned();
            let full_path = current.join(&name);
            if kind == EntryKind::Folder {
                if is_system_junk_directory(&name) {
                    continue;
                }
                if self.recursive {
                    if current == self.root && self.excluded_root_children.contains(&full_path) {
                        continue;
                    }
                    subfolders.push(full_path);
                }
                continue;
            }
            // A symlink is neither a file nor a folder here, and is left out.
            if kind != EntryKind::File {
                continue;
            }
            if let Some((extension, media_type)) = self.filters.classify(&name) {
                candidates.push(Candidate {
                    full_path,
                    name,
                    extension,
                    media_type,
                    stat,
                });
            }
        }
        Ok(FolderRead {
            subfolders,
            candidates,
        })
    }
}

/// One folder as the scan reads it.
struct FolderRead {
    subfolders: Vec<PathBuf>,
    candidates: Vec<Candidate>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Walked {
    Done,
    Cancelled,
}

/// Threads reading folders ahead of the scan.
const READ_AHEAD_THREADS: usize = 4;
/// How far past the folder the scan is on they read.
const READ_AHEAD_FOLDERS: usize = 8;

/// The folders of one scan, read ahead of it by a few threads and handed to it in its own order:
/// the scan still takes one folder at a time, breadth first, but finds each one read when it gets
/// there. A folder's subfolders are queued once the scan takes it, so the order is the one a
/// scan reading each folder itself would follow.
struct ReadAhead {
    state: Mutex<AheadState>,
    /// The readers wait here for a folder to read.
    work: Condvar,
    /// The scan waits here for the folder it is on.
    ready: Condvar,
}

struct AheadState {
    /// Every folder queued so far, in the scan's order.
    folders: Vec<PathBuf>,
    /// How many of them a reader has taken.
    claimed: usize,
    /// How many of them the scan has taken.
    taken: usize,
    reads: HashMap<usize, io::Result<FolderRead>>,
    stopped: bool,
}

impl ReadAhead {
    fn new(root: PathBuf) -> Self {
        Self {
            state: Mutex::new(AheadState {
                folders: vec![root],
                claimed: 0,
                taken: 0,
                reads: HashMap::new(),
                stopped: false,
            }),
            work: Condvar::new(),
            ready: Condvar::new(),
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, AheadState> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// A reader: reads the next folder not yet read, within the window ahead of the scan, until
    /// stopped.
    fn serve(&self, scan: &CatalogScan, cancel: &CancelToken) {
        loop {
            let (ix, folder) = {
                let mut state = self.lock();
                loop {
                    if state.stopped {
                        return;
                    }
                    if state.claimed < state.folders.len()
                        && state.claimed < state.taken + READ_AHEAD_FOLDERS
                    {
                        break;
                    }
                    state = self
                        .work
                        .wait(state)
                        .unwrap_or_else(PoisonError::into_inner);
                }
                let ix = state.claimed;
                state.claimed += 1;
                (ix, state.folders[ix].clone())
            };
            let read = if cancel.is_cancelled() {
                Err(io::Error::from(io::ErrorKind::Interrupted))
            } else {
                scan.read_directory(&folder)
            };
            self.lock().reads.insert(ix, read);
            self.ready.notify_all();
        }
    }

    /// The next folder in the scan's order and how its read went, once read; `None` when every
    /// folder queued has been taken.
    fn next(&self) -> Option<(PathBuf, io::Result<FolderRead>)> {
        let mut state = self.lock();
        let ix = state.taken;
        if ix >= state.folders.len() {
            return None;
        }
        let read = loop {
            if let Some(read) = state.reads.remove(&ix) {
                break read;
            }
            state = self
                .ready
                .wait(state)
                .unwrap_or_else(PoisonError::into_inner);
        };
        state.taken += 1;
        let folder = state.folders[ix].clone();
        drop(state);
        self.work.notify_all();
        Some((folder, read))
    }

    /// Queues the subfolders of the folder the scan just took.
    fn push(&self, subfolders: Vec<PathBuf>) {
        if subfolders.is_empty() {
            return;
        }
        self.lock().folders.extend(subfolders);
        self.work.notify_all();
    }

    /// Stops the readers when the scan leaves, however it leaves.
    fn stop_on_drop(&self) -> impl Drop + '_ {
        struct Stop<'a>(&'a ReadAhead);
        impl Drop for Stop<'_> {
            fn drop(&mut self) {
                self.0.lock().stopped = true;
                self.0.work.notify_all();
            }
        }
        Stop(self)
    }
}

#[cfg(target_os = "macos")]
use bulk::Kind as EntryKind;

#[cfg(not(target_os = "macos"))]
#[derive(Clone, Copy, PartialEq, Eq)]
enum EntryKind {
    File,
    Folder,
    Other,
}

/// One entry of a folder: its name, what it is as `readdir` types it, and a file's size and
/// time when the read gave them.
struct DirEntry {
    name: std::ffi::OsString,
    kind: EntryKind,
    stat: Option<(u64, f64)>,
}

/// A folder's entries in its own order. On macOS one call reads many entries with each file's
/// size and time ([`bulk`]); elsewhere `readdir`, and the scan states each file.
#[cfg(target_os = "macos")]
fn read_entries(folder: &Path) -> io::Result<impl Iterator<Item = io::Result<DirEntry>>> {
    Ok(bulk::read(folder)?.into_iter().map(|entry| {
        Ok(DirEntry {
            name: entry.name.into(),
            kind: entry.kind,
            stat: entry.stat,
        })
    }))
}

#[cfg(not(target_os = "macos"))]
fn read_entries(folder: &Path) -> io::Result<impl Iterator<Item = io::Result<DirEntry>>> {
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

struct Candidate {
    full_path: PathBuf,
    name: String,
    extension: String,
    media_type: CatalogMediaType,
    /// The size and time the folder's read gave, if it did.
    stat: Option<(u64, f64)>,
}

enum Stat {
    Item(CatalogItem),
    Failed(String),
    Cancelled,
}

/// States a folder's candidates, ten at a time, keeping their order. Those the folder's read
/// already gave a size and time to need no `stat`.
fn stat_candidates(candidates: Vec<Candidate>, cancel: &CancelToken) -> Vec<Stat> {
    let stat = |candidate: &Candidate| -> Stat {
        if cancel.is_cancelled() {
            return Stat::Cancelled;
        }
        let path = candidate.full_path.to_string_lossy().into_owned();
        let stat = candidate.stat.map(Ok).unwrap_or_else(|| {
            fs::metadata(&candidate.full_path)
                .map(|metadata| (metadata.len(), modified_ms(&metadata)))
        });
        match stat {
            Ok((size, mtime_ms)) => Stat::Item(CatalogItem::new(
                path,
                candidate.name.clone(),
                candidate.extension.clone(),
                candidate.media_type,
                size,
                mtime_ms,
            )),
            Err(_) => Stat::Failed(path),
        }
    };
    if candidates.len() <= 1 || candidates.iter().all(|candidate| candidate.stat.is_some()) {
        let mut stats: Vec<Stat> = Vec::with_capacity(candidates.len());
        for candidate in &candidates {
            let stat = stat(candidate);
            let cancelled = matches!(stat, Stat::Cancelled);
            stats.push(stat);
            if cancelled {
                break;
            }
        }
        return stats;
    }
    let results: Vec<Mutex<Option<Stat>>> = candidates.iter().map(|_| Mutex::new(None)).collect();
    let concurrency = FILE_STAT_CONCURRENCY.min(candidates.len());
    let _ = run_queue(
        concurrency,
        (0..candidates.len()).collect(),
        None,
        |ix: usize, _| {
            *results[ix].lock().unwrap_or_else(PoisonError::into_inner) =
                Some(stat(&candidates[ix]));
            Ok(())
        },
    );
    let mut stats: Vec<Stat> = results
        .into_iter()
        .map(|slot| {
            slot.into_inner()
                .unwrap_or_else(PoisonError::into_inner)
                .unwrap_or(Stat::Cancelled)
        })
        .collect();
    // A cancel part way through ends the folder where it struck.
    if let Some(first) = stats
        .iter()
        .position(|stat| matches!(stat, Stat::Cancelled))
    {
        stats.truncate(first + 1);
    }
    stats
}

fn emit_progress(
    run_id: u64,
    scanned_directories: usize,
    discovered_items: usize,
    pending: &mut Option<String>,
    last: &mut Option<Instant>,
    force: bool,
    emit: &mut dyn FnMut(CatalogEvent),
) {
    if pending.is_none() {
        return;
    }
    if !force && last.is_some_and(|last| last.elapsed() < PROGRESS_INTERVAL) {
        return;
    }
    if let Some(current_path) = pending.take() {
        emit(CatalogEvent::Progress {
            run_id,
            scanned_directories,
            discovered_items,
            current_path,
        });
        *last = Some(Instant::now());
    }
}

/// The folder list's collator: `localeCompare(name, undefined, { sensitivity: "base" })`, the
/// root locale at primary strength without numeric order.
static FOLDER_COLLATOR: std::sync::LazyLock<CollatorBorrowed<'static>> =
    std::sync::LazyLock::new(|| {
        let mut options = CollatorOptions::default();
        options.strength = Some(Strength::Primary);
        CollatorBorrowed::try_new(CollatorPreferences::default(), options)
            .expect("the compiled collation data has the root locale")
    });

/// `listFolderChildren` (`folderService.ts`): the folders directly in `folder`, by name at base
/// strength. Every folder counts, system folders included, and a symlink to a folder does not.
pub fn list_folder_children(folder: &Path) -> io::Result<Vec<FolderNode>> {
    let parent_path = folder.to_string_lossy().into_owned();
    let mut nodes = Vec::new();
    for entry in fs::read_dir(folder)? {
        let entry = entry?;
        if !entry.file_type()?.is_dir() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        nodes.push(FolderNode {
            path: folder.join(&name).to_string_lossy().into_owned(),
            parent_path: parent_path.clone(),
            parent_id: None,
            name,
            has_children: true,
        });
    }
    nodes.sort_by(|left, right| FOLDER_COLLATOR.compare(&left.name, &right.name));
    Ok(nodes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_write_the_time_as_javascript_does() {
        let item = CatalogItem::new(
            "/a/b.jpg".into(),
            "b.jpg".into(),
            "jpg".into(),
            CatalogMediaType::Image,
            2048,
            1_793_199_880_249.688_5,
        );
        assert_eq!(item.id, "/a/b.jpg:2048:1793199880249.6885");
        let whole = CatalogItem::new(
            "/a/c.mp4".into(),
            "c.mp4".into(),
            "mp4".into(),
            CatalogMediaType::Video,
            1,
            1_730_000_000_000.0,
        );
        assert_eq!(whole.id, "/a/c.mp4:1:1730000000000");
    }

    #[test]
    fn filters_choose_the_kinds_and_videos_win() {
        let filters = CatalogFilters {
            image_extensions: ["jpg", "gif", "png"].map(String::from).into(),
            video_extensions: ["mp4", "gif"].map(String::from).into(),
            show_images: true,
            show_videos: true,
        };
        assert_eq!(
            filters.classify("a.JPEG"),
            Some(("jpg".into(), CatalogMediaType::Image))
        );
        assert_eq!(
            filters.classify("a.gif"),
            Some(("gif".into(), CatalogMediaType::Video))
        );
        assert_eq!(filters.classify("._a.jpg"), None);
        assert_eq!(filters.classify("Thumbs.db"), None);
        let images_only = CatalogFilters {
            show_videos: false,
            ..filters
        };
        assert_eq!(images_only.classify("a.mp4"), None);
        assert_eq!(
            images_only.classify("a.gif"),
            Some(("gif".into(), CatalogMediaType::Image))
        );
    }
}
