//! The analysis passes, from glazier-core's `passes/`: each selects the files it has not done
//! yet, works on several at once on worker threads, and writes its result back only to a row
//! that still describes the bytes it read.

pub mod detail;
pub mod fingerprint;
pub mod hash;
pub mod loudness;
pub mod probe;
pub mod sniff;

use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};

use oriel_runtime::{CancelToken, Cancelled, JobReporter, PauseToken};
use rusqlite::{Connection, OptionalExtension as _};

use crate::catalog::Catalog;
use crate::catalog::files::SqlParams;
use crate::contract::{FileId, RootId};
use crate::similarity::Vips;

/// Where a pass reports how far it has got, and learns that it should wait or stop.
pub trait Progress: Send + Sync {
    /// Starts a phase: names it and sets its total (0 when unknown), with nothing done yet.
    fn phase(&self, label: &str, total: u64);
    fn done(&self, done: u64);
    /// The token tool runs are killed by, when there is one.
    fn cancel_token(&self) -> Option<&CancelToken>;

    /// The token the owner pauses the work with, when there is one.
    fn pause_token(&self) -> Option<&PauseToken> {
        None
    }

    /// Says the work waits for its turn (queued behind other work, or stepped aside for work the
    /// owner asked for), or works again.
    fn waiting(&self, _waiting: bool) {}

    /// Says the work runs in the background, behind work the owner asked for, or not.
    fn background(&self, _background: bool) {}

    /// `Err(Cancelled)` once the work should stop. It never waits, so it is safe anywhere, even
    /// in the middle of an item.
    fn check(&self) -> Result<(), Cancelled> {
        self.cancel_token().map_or(Ok(()), CancelToken::check)
    }

    /// Whether the work should come to a [`Progress::checkpoint`] before its next item: it was
    /// stopped, paused, or asked to step aside. Work on several items at once stops taking new
    /// ones when this says so, lets those in flight finish, and then calls the checkpoint.
    fn wants_checkpoint(&self) -> bool {
        self.check().is_err() || self.pause_token().is_some_and(PauseToken::is_paused)
    }

    /// Between items, with nothing in flight: waits while the work is paused (and, in the
    /// background, while work the owner asked for runs), and fails once it is cancelled, paused
    /// or not. glazier-core's `checkpoint`.
    fn checkpoint(&self) -> Result<(), Cancelled> {
        match (self.pause_token(), self.cancel_token()) {
            (Some(pause), Some(cancel)) => pause.wait_blocking(cancel),
            (Some(pause), None) => pause.wait_blocking(&CancelToken::new()),
            _ => self.check(),
        }
    }
}

impl Progress for JobReporter {
    fn phase(&self, label: &str, total: u64) {
        self.begin_phase(label.to_owned(), total);
    }

    fn done(&self, done: u64) {
        self.set_done(done);
    }

    fn cancel_token(&self) -> Option<&CancelToken> {
        Some(JobReporter::cancel_token(self))
    }

    fn pause_token(&self) -> Option<&PauseToken> {
        Some(JobReporter::pause_token(self))
    }

    fn waiting(&self, waiting: bool) {
        self.set_waiting(waiting);
    }

    fn background(&self, background: bool) {
        self.set_background(background);
    }
}

/// Progress nobody watches, for tests and one-off runs; it stops when its token is cancelled
/// and waits while its pause token is paused.
#[derive(Clone, Debug, Default)]
pub struct Quiet {
    token: CancelToken,
    pause: PauseToken,
}

impl Quiet {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn token(&self) -> &CancelToken {
        &self.token
    }

    pub fn pause(&self) -> &PauseToken {
        &self.pause
    }
}

impl Progress for Quiet {
    fn phase(&self, _label: &str, _total: u64) {}

    fn done(&self, _done: u64) {}

    fn cancel_token(&self) -> Option<&CancelToken> {
        Some(&self.token)
    }

    fn pause_token(&self) -> Option<&PauseToken> {
        Some(&self.pause)
    }
}

/// The native tools the passes run: libvips in process, ffmpeg and ffprobe as child processes.
/// Each is optional, as in glazier-core's toolkit: a pass that needs one that is missing leaves
/// its files for later rather than recording them as broken.
#[derive(Clone, Default)]
pub struct Media {
    pub vips: Option<Arc<Vips>>,
    pub ffmpeg: Option<PathBuf>,
    pub ffprobe: Option<PathBuf>,
}

impl std::fmt::Debug for Media {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Media")
            .field("vips", &self.vips.as_ref().map(|vips| vips.version()))
            .field("ffmpeg", &self.ffmpeg)
            .field("ffprobe", &self.ffprobe)
            .finish()
    }
}

/// What every pass runs with.
pub struct PassContext<'a> {
    pub catalog: &'a Catalog,
    pub media: &'a Media,
    /// The root to analyse, or `None` for every root.
    pub root_id: Option<RootId>,
    pub progress: &'a dyn Progress,
}

impl PassContext<'_> {
    /// `AND f.root_id = $root` when the pass has a root, setting `$root`.
    pub fn root_clause(&self, params: &mut SqlParams) -> &'static str {
        match self.root_id {
            Some(root_id) => {
                params.set("root", root_id);
                "AND f.root_id = $root"
            }
            None => "",
        }
    }
}

/// Runs `work` over `items`, at most `concurrency` at a time on worker threads, reporting each
/// item done in `phase`; see [`run_concurrently`].
pub fn for_each_concurrent<T: Sync>(
    items: &[T],
    concurrency: usize,
    progress: &dyn Progress,
    phase: &str,
    work: impl Fn(&T) -> anyhow::Result<()> + Sync,
) -> anyhow::Result<()> {
    progress.phase(phase, items.len() as u64);
    let done = AtomicU64::new(0);
    run_concurrently(items, concurrency, progress, |item| {
        work(item)?;
        progress.done(done.fetch_add(1, Ordering::AcqRel) + 1);
        Ok(())
    })
}

/// Runs `work` over `items`, at most `concurrency` at a time on worker threads, as glazier-core's
/// `forEachConcurrent`. The first error stops every lane and is returned; a stop is checked
/// between items. When the work is paused or asked to step aside, the lanes stop taking items,
/// those in flight finish, and the checkpoint runs with none in flight, so whatever runs in it
/// never overlaps them; then the lanes go on from where they were.
pub fn run_concurrently<T: Sync>(
    items: &[T],
    concurrency: usize,
    progress: &dyn Progress,
    work: impl Fn(&T) -> anyhow::Result<()> + Sync,
) -> anyhow::Result<()> {
    let next = AtomicUsize::new(0);
    let failed = AtomicBool::new(false);
    let lanes = concurrency.max(1).min(items.len().max(1));
    loop {
        run_lanes(items, lanes, progress, &next, &failed, &work)?;
        if next.load(Ordering::Acquire) >= items.len() {
            return Ok(());
        }
        progress.checkpoint()?;
    }
}

/// One round of lanes, until the items run out or the work wants a checkpoint.
fn run_lanes<T: Sync>(
    items: &[T],
    lanes: usize,
    progress: &dyn Progress,
    next: &AtomicUsize,
    failed: &AtomicBool,
    work: &(impl Fn(&T) -> anyhow::Result<()> + Sync),
) -> anyhow::Result<()> {
    std::thread::scope(|scope| {
        let handles: Vec<_> = (0..lanes)
            .map(|_| {
                scope.spawn(|| -> anyhow::Result<()> {
                    loop {
                        if failed.load(Ordering::Acquire) {
                            return Ok(());
                        }
                        progress.check()?;
                        if progress.wants_checkpoint() {
                            return Ok(());
                        }
                        let index = next.fetch_add(1, Ordering::AcqRel);
                        let Some(item) = items.get(index) else {
                            return Ok(());
                        };
                        if let Err(error) = work(item) {
                            failed.store(true, Ordering::Release);
                            return Err(error);
                        }
                    }
                })
            })
            .collect();
        let mut first_error = None;
        for handle in handles {
            let outcome = handle
                .join()
                .unwrap_or_else(|_| Err(anyhow::anyhow!("a worker thread panicked")));
            if let Err(error) = outcome
                && first_error.is_none()
            {
                first_error = Some(error);
            }
        }
        first_error.map_or(Ok(()), Err)
    })
}

/// A row as a pass selected it; the pass works on it only while the catalog still agrees.
#[derive(Clone, Debug, PartialEq)]
pub struct SelectedFile {
    pub id: FileId,
    pub root_id: RootId,
    pub rel_path: String,
    pub size: i64,
    pub mtime_ms: f64,
}

/// True when the file's row still has the path, size and mtime the pass selected it with. A
/// background pass can resume after a change moved, held or converted the file.
pub fn still_selected(connection: &Connection, file: &SelectedFile) -> anyhow::Result<bool> {
    let current: Option<(RootId, String, i64, f64)> = connection
        .query_row(
            "SELECT root_id, rel_path, size, mtime_ms FROM files WHERE id = ?1",
            [file.id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .optional()?;
    Ok(current.is_some_and(|(root_id, rel_path, size, mtime_ms)| {
        root_id == file.root_id
            && rel_path == file.rel_path
            && size == file.size
            && mtime_ms == file.mtime_ms
    }))
}

/// The WHERE condition that writes a pass's result only to the row it selected, unchanged.
pub const SAME_ROW_SQL: &str = "id = $id AND root_id = $root_id AND rel_path = $rel_path
  AND size = $size AND mtime_ms = $mtime_ms";

pub fn same_row_params(file: &SelectedFile) -> SqlParams {
    SqlParams::new()
        .with("id", file.id)
        .with("root_id", file.root_id)
        .with("rel_path", file.rel_path.clone())
        .with("size", file.size)
        .with("mtime_ms", file.mtime_ms)
}

/// glazier-core's `message.slice(0, 500)`: at most 500 UTF-16 code units of an error, cut at a
/// character.
pub fn error_text(message: &str) -> String {
    let mut units = 0;
    let mut end = message.len();
    for (index, character) in message.char_indices() {
        units += character.len_utf16();
        if units > 500 {
            end = index;
            break;
        }
    }
    message[..end].to_owned()
}
