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

use std::collections::HashSet;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, PoisonError};
use std::time::{Duration, Instant};

use futures::executor::block_on;
use icu_collator::options::{CollatorOptions, Strength};
use icu_collator::{CollatorBorrowed, CollatorPreferences};
use oriel_core_domain::{FolderNode, get_extension, is_system_junk_directory, is_system_junk_file};
use oriel_runtime::CancelToken;
use serde::{Deserialize, Serialize};

use crate::media_index::MediaIndex;
use crate::pool::run_queue;
use crate::scan::modified_ms;

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
    /// Items found since the last batch, in the order found.
    Batch {
        run_id: u64,
        items: Vec<CatalogItem>,
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
    /// items in `index` when there is one. Blocks; run it on a background thread.
    pub fn run(
        self,
        index: Option<&MediaIndex>,
        cancel: &CancelToken,
        emit: &mut dyn FnMut(CatalogEvent),
    ) {
        let run_id = self.run_id;
        let root_path = self.root.to_string_lossy().into_owned();
        let started = Instant::now();

        let mut index_scan = match index {
            Some(index) => match block_on(index.start_scan(root_path.clone(), self.recursive)) {
                Ok(scan_id) => Some((index, scan_id)),
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
        let mut index_failed = false;

        let cancelled = |index_scan: &mut Option<(&MediaIndex, i64)>,
                         emit: &mut dyn FnMut(CatalogEvent)| {
            if let Some((index, scan_id)) = index_scan.take() {
                let _ = block_on(index.cancel_scan(scan_id));
            }
            emit(CatalogEvent::Cancelled { run_id });
        };

        if cancel.is_cancelled() {
            cancelled(&mut index_scan, emit);
            return;
        }
        emit(CatalogEvent::Reset {
            run_id,
            root_path: root_path.clone(),
            recursive: self.recursive,
        });

        let mut queue = vec![self.root.clone()];
        let mut cursor = 0;
        let mut scanned_directories = 0;
        let mut discovered_items = 0;
        let mut pending: Vec<CatalogItem> = Vec::new();
        let mut last_progress: Option<Instant> = None;
        let mut pending_progress: Option<String> = None;

        let flush = |pending: &mut Vec<CatalogItem>,
                     index_scan: &Option<(&MediaIndex, i64)>,
                     index_failed: &mut bool,
                     emit: &mut dyn FnMut(CatalogEvent)| {
            if pending.is_empty() {
                return;
            }
            let batch = std::mem::take(pending);
            emit(CatalogEvent::Batch {
                run_id,
                items: batch.clone(),
            });
            if let Some((index, scan_id)) = index_scan
                && !*index_failed
                && let Err(error) = block_on(index.upsert_batch(root_path.clone(), *scan_id, batch))
            {
                *index_failed = true;
                emit(CatalogEvent::Error {
                    run_id: Some(run_id),
                    message: format!("Media index update failed: {error:#}"),
                    path: None,
                });
            }
        };

        while cursor < queue.len() {
            if cancel.is_cancelled() {
                cancelled(&mut index_scan, emit);
                return;
            }
            let current = queue[cursor].clone();
            cursor += 1;

            let candidates = match self.read_directory(&current, &mut queue) {
                Ok(candidates) => candidates,
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
                            flush(&mut pending, &index_scan, &mut index_failed, emit);
                        }
                    }
                    Stat::Failed(path) => emit(CatalogEvent::Error {
                        run_id: Some(run_id),
                        message: "Unable to stat file".into(),
                        path: Some(path),
                    }),
                    Stat::Cancelled => {
                        cancelled(&mut index_scan, emit);
                        return;
                    }
                }
            }
        }

        if cancel.is_cancelled() {
            cancelled(&mut index_scan, emit);
            return;
        }
        flush(&mut pending, &index_scan, &mut index_failed, emit);
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
            cancelled(&mut index_scan, emit);
            return;
        }

        // The index is a cache: a failure to finish it is reported, and the scan is still done.
        if let Some((index, scan_id)) = index_scan {
            if index_failed {
                let _ = block_on(index.cancel_scan(scan_id));
            } else if let Err(error) = block_on(index.finish_scan(root_path.clone(), scan_id)) {
                emit(CatalogEvent::Error {
                    run_id: Some(run_id),
                    message: format!("Media index finalize failed: {error:#}"),
                    path: None,
                });
                let _ = block_on(index.cancel_scan(scan_id));
            }
        }

        emit(CatalogEvent::Done {
            run_id,
            total_items: discovered_items,
            elapsed: started.elapsed(),
        });
    }

    /// Reads one folder: its media files as candidates, and its subfolders onto `queue` when the
    /// scan is recursive. The order is the file system's, as `opendir` gives it.
    fn read_directory(
        &self,
        current: &Path,
        queue: &mut Vec<PathBuf>,
    ) -> io::Result<Vec<Candidate>> {
        let mut candidates = Vec::new();
        for entry in fs::read_dir(current)? {
            let entry = entry?;
            let file_type = entry.file_type()?;
            let name = entry.file_name().to_string_lossy().into_owned();
            let full_path = current.join(&name);
            if file_type.is_dir() {
                if is_system_junk_directory(&name) {
                    continue;
                }
                if self.recursive {
                    if current == self.root && self.excluded_root_children.contains(&full_path) {
                        continue;
                    }
                    queue.push(full_path);
                }
                continue;
            }
            // A symlink is neither a file nor a folder here, and is left out.
            if !file_type.is_file() {
                continue;
            }
            if let Some((extension, media_type)) = self.filters.classify(&name) {
                candidates.push(Candidate {
                    full_path,
                    name,
                    extension,
                    media_type,
                });
            }
        }
        Ok(candidates)
    }
}

struct Candidate {
    full_path: PathBuf,
    name: String,
    extension: String,
    media_type: CatalogMediaType,
}

enum Stat {
    Item(CatalogItem),
    Failed(String),
    Cancelled,
}

/// States a folder's candidates, ten at a time, keeping their order.
fn stat_candidates(candidates: Vec<Candidate>, cancel: &CancelToken) -> Vec<Stat> {
    let stat = |candidate: &Candidate| -> Stat {
        if cancel.is_cancelled() {
            return Stat::Cancelled;
        }
        let path = candidate.full_path.to_string_lossy().into_owned();
        match fs::metadata(&candidate.full_path) {
            Ok(metadata) => Stat::Item(CatalogItem::new(
                path,
                candidate.name.clone(),
                candidate.extension.clone(),
                candidate.media_type,
                metadata.len(),
                modified_ms(&metadata),
            )),
            Err(_) => Stat::Failed(path),
        }
    };
    if candidates.len() <= 1 {
        return candidates.iter().map(stat).collect();
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
