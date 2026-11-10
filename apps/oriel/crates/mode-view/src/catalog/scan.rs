//! View's scan of a folder: the media the gallery shows, found breadth first and streamed to it in
//! batches while the scan goes on.
//!
//! It differs from Sync's archive scan on purpose: items carry absolute paths, a scan lists only
//! the folder's own files unless it is recursive, the root's excluded children are not entered,
//! the settings' filters choose the extensions, and what cannot be read is reported and passed
//! over rather than failing the scan. The skip rules are the same: system folders are not
//! entered, junk files are left out, and symlinks are never followed.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex, PoisonError};
use std::time::{Duration, Instant};

use oriel_core_domain::collation::Collation;
use oriel_core_domain::{FolderNode, get_extension, is_system_junk_directory, is_system_junk_file};
use oriel_runtime::fs_meta::{DirEntry, EntryKind, FileStat, read_entries};
use oriel_runtime::{CancelToken, run_queue};

use super::{ScanRequest, SortOrder};
use crate::browser::sort_media;
use crate::listing::{MediaEntry, MediaKind};

/// Items sent to the gallery at a time.
const BATCH_SIZE: usize = 300;
/// Files of a folder stated at once.
const FILE_STAT_CONCURRENCY: usize = 10;
/// The least time between two progress events.
const PROGRESS_INTERVAL: Duration = Duration::from_millis(80);

/// Which files a scan lists: the settings' `filters`, extensions lowercased without their dot.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CatalogFilters {
    pub image_extensions: HashSet<String>,
    pub video_extensions: HashSet<String>,
    pub show_images: bool,
    pub show_videos: bool,
}

impl CatalogFilters {
    /// The file's canonical extension and kind, or `None` for junk and for files the filters leave
    /// out. A video wins over an image when a list has both, and a GIF image is [`MediaKind::Gif`].
    pub fn classify(&self, name: &str) -> Option<(String, MediaKind)> {
        if is_system_junk_file(name) {
            return None;
        }
        let extension = get_extension(name);
        let image = self.show_images && self.image_extensions.contains(&extension);
        let video = self.show_videos && self.video_extensions.contains(&extension);
        let kind = match (image, video) {
            (_, true) => MediaKind::Video,
            (true, false) if extension == "gif" => MediaKind::Gif,
            (true, false) => MediaKind::Image,
            (false, false) => return None,
        };
        Some((extension, kind))
    }
}

/// What a scan tells the gallery.
#[derive(Clone, Debug, PartialEq)]
pub enum CatalogEvent {
    /// The scan started: the gallery empties.
    Reset {
        root_path: String,
    },
    Progress {
        scanned_directories: usize,
        discovered_items: usize,
        current_path: String,
    },
    /// Items found since the last batch, in the order found.
    Batch(Vec<MediaEntry>),
    /// Every item found, in the order the scan was asked to sort them by.
    Done {
        sorted: Arc<[MediaEntry]>,
        elapsed: Duration,
    },
    Cancelled,
    /// Something the scan could not do. It goes on, unless it is a cancel or done next.
    Error {
        message: String,
        path: String,
    },
}

/// One scan of a folder.
#[derive(Clone, Debug)]
pub struct CatalogScan {
    root: PathBuf,
    recursive: bool,
    filters: CatalogFilters,
    excluded_root_children: HashSet<PathBuf>,
    order: SortOrder,
}

impl CatalogScan {
    /// The scan `request` asks for. Its root should be absolute and canonical (View resolves the
    /// folder it is given, symlinks included, before it scans); excluded paths that are not the
    /// root's direct children are ignored.
    pub fn new(request: &ScanRequest) -> Self {
        let root = request.root.clone();
        let excluded_root_children = request
            .excluded_root_children
            .iter()
            .filter(|path| path.parent() == Some(root.as_path()))
            .cloned()
            .collect();
        Self {
            root,
            recursive: request.recursive,
            filters: request.filters.clone(),
            excluded_root_children,
            order: request.order,
        }
    }

    /// Runs the scan to its end or its cancel, sending each event to `emit`. Blocks; run it on a
    /// background thread.
    pub fn run(self, cancel: &CancelToken, emit: &mut dyn FnMut(CatalogEvent)) {
        let root_path = self.root.to_string_lossy().into_owned();
        let started = Instant::now();

        if cancel.is_cancelled() {
            emit(CatalogEvent::Cancelled);
            return;
        }
        emit(CatalogEvent::Reset { root_path });

        let mut scanned_directories = 0;
        let mut found: Vec<MediaEntry> = Vec::new();
        let mut pending: Vec<MediaEntry> = Vec::new();
        let mut last_progress: Option<Instant> = None;
        let mut pending_progress: Option<String> = None;

        let flush = |pending: &mut Vec<MediaEntry>, emit: &mut dyn FnMut(CatalogEvent)| {
            if !pending.is_empty() {
                emit(CatalogEvent::Batch(std::mem::take(pending)));
            }
        };
        let error = |message: String, path: &Path| CatalogEvent::Error {
            message,
            path: path.to_string_lossy().into_owned(),
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
                let read = match read {
                    Ok(read) => read,
                    Err(failure) => {
                        emit(error(
                            format!("Unable to access directory: {failure}"),
                            &current,
                        ));
                        continue;
                    }
                };
                ahead.push(read.subfolders);
                for path in &read.not_unicode {
                    emit(error("The name is not Unicode".into(), path));
                }
                scanned_directories += 1;
                pending_progress = Some(current.to_string_lossy().into_owned());
                emit_progress(
                    scanned_directories,
                    found.len(),
                    &mut pending_progress,
                    &mut last_progress,
                    false,
                    emit,
                );

                for result in stat_candidates(read.candidates, cancel) {
                    match result {
                        Stat::Item(item) => {
                            found.push(item.clone());
                            pending.push(item);
                            if pending.len() >= BATCH_SIZE {
                                flush(&mut pending, emit);
                            }
                        }
                        Stat::Failed(path, failure) => {
                            emit(error(format!("Unable to stat file: {failure}"), &path));
                        }
                        Stat::Cancelled => return Walked::Cancelled,
                    }
                }
            }
            Walked::Done
        });
        if walked == Walked::Cancelled || cancel.is_cancelled() {
            emit(CatalogEvent::Cancelled);
            return;
        }
        flush(&mut pending, emit);
        emit_progress(
            scanned_directories,
            found.len(),
            &mut pending_progress,
            &mut last_progress,
            true,
            emit,
        );
        if cancel.is_cancelled() {
            emit(CatalogEvent::Cancelled);
            return;
        }
        let (mode, seed) = self.order;
        emit(CatalogEvent::Done {
            sorted: sort_media(&found, mode, seed).into(),
            elapsed: started.elapsed(),
        });
    }

    /// Reads one folder: its media files as candidates, and its subfolders to enter when the
    /// scan is recursive. The order is the file system's, as `opendir` gives it.
    fn read_directory(&self, current: &Path) -> io::Result<FolderRead> {
        let mut candidates = Vec::new();
        let mut subfolders = Vec::new();
        let mut not_unicode = Vec::new();
        for entry in read_entries(current)? {
            let DirEntry { name, kind, stat } = entry?;
            let full_path = current.join(&name);
            let name = match name.into_string() {
                Ok(name) => name,
                Err(name) => {
                    not_unicode.push(current.join(name));
                    continue;
                }
            };
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
            if let Some((extension, kind)) = self.filters.classify(&name) {
                candidates.push(Candidate {
                    full_path,
                    name,
                    extension,
                    kind,
                    stat,
                });
            }
        }
        Ok(FolderRead {
            subfolders,
            candidates,
            not_unicode,
        })
    }
}

/// One folder as the scan reads it.
struct FolderRead {
    subfolders: Vec<PathBuf>,
    candidates: Vec<Candidate>,
    /// Entries whose names are not Unicode, which an item cannot carry.
    not_unicode: Vec<PathBuf>,
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

struct Candidate {
    full_path: PathBuf,
    name: String,
    extension: String,
    kind: MediaKind,
    /// The size and times the folder's read gave, if it did.
    stat: Option<FileStat>,
}

enum Stat {
    Item(MediaEntry),
    Failed(PathBuf, io::Error),
    Cancelled,
}

/// States a folder's candidates, ten at a time, keeping their order. Those the folder's read
/// already gave a size and time to need no `stat`.
fn stat_candidates(candidates: Vec<Candidate>, cancel: &CancelToken) -> Vec<Stat> {
    let stat = |candidate: &Candidate| -> Stat {
        if cancel.is_cancelled() {
            return Stat::Cancelled;
        }
        let stat = candidate
            .stat
            .map(Ok)
            .unwrap_or_else(|| fs::metadata(&candidate.full_path).map(|m| FileStat::of(&m)));
        match stat {
            Ok(stat) => Stat::Item(MediaEntry::new(
                &candidate.full_path,
                &candidate.name,
                &candidate.extension,
                candidate.kind,
                stat.size,
                stat.modified_ms,
            )),
            Err(error) => Stat::Failed(candidate.full_path.clone(), error),
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
    let stated = run_queue(
        concurrency,
        (0..candidates.len()).collect(),
        None,
        |ix: usize, _| {
            *results[ix].lock().unwrap_or_else(PoisonError::into_inner) =
                Some(stat(&candidates[ix]));
            Ok(())
        },
    );
    if let Err(error) = stated {
        log::warn!("View's scan could not state a folder's files: {error:#}");
    }
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
            scanned_directories,
            discovered_items,
            current_path,
        });
        *last = Some(Instant::now());
    }
}

/// The folders directly in `folder`, by name in [`Collation::Base`] order. Every folder counts,
/// system folders included, and a symlink to a folder does not.
pub fn list_folder_children(folder: &Path) -> io::Result<Vec<FolderNode>> {
    let mut nodes = Vec::new();
    for entry in fs::read_dir(folder)? {
        let entry = entry?;
        if !entry.file_type()?.is_dir() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        nodes.push(FolderNode {
            path: folder.join(&name).to_string_lossy().into_owned(),
            name,
        });
    }
    nodes.sort_by(|left, right| Collation::Base.compare(&left.name, &right.name));
    Ok(nodes)
}

#[cfg(test)]
mod tests;
