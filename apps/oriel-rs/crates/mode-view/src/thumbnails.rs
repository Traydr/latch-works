//! The thumbnail service: a WebP per still, made by ImageIO and libwebp on the background
//! executor and kept on disk under `DataRoot::view()/thumbnails`, which GPUI's `img()` then
//! draws.
//!
//! It follows Electron Oriel's broker (`thumbnailService.ts`, `ThumbnailWorkerRuntime.ts`): the
//! same request size (twice the thumbnail size setting), the same cache key (the path, the size,
//! the file's `mtimeMs` and length, under `thumb-v2`, as SHA-1 hex), the same WebP settings, the
//! same number of image workers, and the gallery's visible rows before its overscan.
//!
//! Not yet: video frames (they need ffmpeg, which `crates/tools` brings in Phase 1) and the
//! 5,000-file cap Electron Oriel prunes its disk cache to.

use std::collections::VecDeque;
use std::fs;
use std::ops::Range;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use anyhow::{Context as _, Result, bail};
use gpui_kit::{AppContext as _, Context};
use oriel_media::still::{self, WebpSettings};

use crate::listing::{MediaEntry, MediaKind};

/// View's thumbnail size setting by default (`DEFAULT_SETTINGS.thumbnailSize`), in pixels.
pub const THUMBNAIL_SIZE: f32 = 220.;

/// Bumped when the files change shape, so old ones are never read as new.
const CACHE_VERSION: &str = "thumb-v2";

/// Stills whose thumbnails stay lossless, as sharp is asked for them.
const LOSSLESS_EXTENSIONS: [&str; 3] = ["png", "bmp", "gif"];

/// The size thumbnails are made at for a thumbnail size setting: twice it, for a 2× display
/// (`getThumbnailRequestSize`), within the 64–1024 the media protocol accepts.
pub fn request_size(thumbnail_size: f32) -> u32 {
    (thumbnail_size * 2.).round().clamp(64., 1024.) as u32
}

/// Electron Oriel's cache key for a thumbnail: `sha1("thumb-v2|path|size|mtimeMs|bytes")` in hex,
/// with `mtimeMs` written as JavaScript writes a number.
pub fn cache_key(path: &Path, size: u32, modified_ms: f64, file_size: u64) -> String {
    let source = format!(
        "{CACHE_VERSION}|{}|{size}|{}|{file_size}",
        path.display(),
        js_number(modified_ms)
    );
    sha1_smol::Sha1::from(source).digest().to_string()
}

/// A number as JavaScript's `String(number)` writes one in the range file times fall in: the
/// shortest digits that read back as the same float, with no `.0` on a whole number. Rust's
/// `Display` for `f64` does the same below 1e21.
fn js_number(value: f64) -> String {
    format!("{value}")
}

/// Electron Oriel's image workers: half the cores, at least 2 and at most 6. Its memory cap (one
/// worker per 2 GiB) only binds below 12 GiB, so it is left out.
fn default_concurrency() -> usize {
    let cores = std::thread::available_parallelism().map_or(4, |cores| cores.get());
    (cores / 2).clamp(2, 6)
}

/// A gallery item's thumbnail, as the gallery draws it.
#[derive(Clone, Debug, PartialEq)]
pub enum Thumbnail {
    /// Not made yet, or not asked for: the tile shows its placeholder.
    Pending,
    /// The WebP on disk, for `img()`.
    Ready(Arc<Path>),
    /// It cannot be made (a video, or a file ImageIO cannot read): the placeholder stays.
    Unavailable,
}

#[derive(Clone, Debug)]
enum Slot {
    Idle,
    Queued,
    Running,
    Ready(Arc<Path>),
    Unavailable,
}

/// How a job ended, for the counters.
enum Made {
    FromDisk(Arc<Path>),
    Generated(Arc<Path>, Duration),
}

/// What the service has done since it was made: for Phase 0's measurements.
#[derive(Clone, Copy, Debug, Default)]
pub struct ThumbnailStats {
    generated: usize,
    from_disk: usize,
    unavailable: usize,
    generating: Duration,
    first_started: Option<Instant>,
    last_finished: Option<Instant>,
}

impl ThumbnailStats {
    /// Thumbnails decoded and encoded.
    pub fn generated(&self) -> usize {
        self.generated
    }

    /// Thumbnails found already on disk.
    pub fn from_disk(&self) -> usize {
        self.from_disk
    }

    pub fn unavailable(&self) -> usize {
        self.unavailable
    }

    /// The time the generated ones took, summed over the workers.
    pub fn generating(&self) -> Duration {
        self.generating
    }

    /// From the first job's start to the last one's end.
    pub fn span(&self) -> Option<Duration> {
        Some(self.last_finished?.duration_since(self.first_started?))
    }
}

/// Makes and finds the thumbnails of one listing at a time. The gallery says which items it
/// wants; the service works through them, the visible ones first, a few at once, and notifies
/// as each is ready.
pub struct ThumbnailService {
    folder: Arc<Path>,
    size: u32,
    concurrency: usize,
    generation: u64,
    entries: Arc<[MediaEntry]>,
    slots: Vec<Slot>,
    queue: VecDeque<usize>,
    running: usize,
    stats: ThumbnailStats,
}

impl ThumbnailService {
    /// A service writing to `folder` (View's `thumbnails` folder), at `size` pixels.
    pub fn new(folder: impl Into<PathBuf>, size: u32) -> Self {
        Self {
            folder: folder.into().into(),
            size,
            concurrency: default_concurrency(),
            generation: 0,
            entries: Arc::from([]),
            slots: Vec::new(),
            queue: VecDeque::new(),
            running: 0,
            stats: ThumbnailStats::default(),
        }
    }

    pub fn folder(&self) -> &Path {
        &self.folder
    }

    pub fn size(&self) -> u32 {
        self.size
    }

    pub fn concurrency(&self) -> usize {
        self.concurrency
    }

    pub fn stats(&self) -> ThumbnailStats {
        self.stats
    }

    /// Starts over on a new listing. Work still running for the old one finishes and is
    /// dropped.
    pub fn set_entries(&mut self, entries: Arc<[MediaEntry]>, cx: &mut Context<Self>) {
        self.generation += 1;
        self.slots = vec![Slot::Idle; entries.len()];
        self.entries = entries;
        self.queue.clear();
        self.running = 0;
        cx.notify();
    }

    pub fn thumbnail(&self, ix: usize) -> Thumbnail {
        match self.slots.get(ix) {
            Some(Slot::Ready(path)) => Thumbnail::Ready(path.clone()),
            Some(Slot::Unavailable) => Thumbnail::Unavailable,
            _ => Thumbnail::Pending,
        }
    }

    /// The items the gallery wants now: `visible` first, then the rest of `nearby` (its
    /// overscan). Anything queued before and wanted no longer is dropped from the queue, as
    /// Electron Oriel aborts the request of a tile that scrolled away. Nothing is drawn
    /// differently until a thumbnail is ready, so this does not notify.
    pub fn want(&mut self, visible: Range<usize>, nearby: Range<usize>, cx: &mut Context<Self>) {
        let len = self.slots.len();
        let visible = visible.start.min(len)..visible.end.min(len);
        let nearby = nearby.start.min(len)..nearby.end.min(len);

        for ix in self.queue.drain(..) {
            if matches!(self.slots[ix], Slot::Queued) {
                self.slots[ix] = Slot::Idle;
            }
        }
        let order = visible
            .clone()
            .chain(nearby.filter(|ix| !visible.contains(ix)));
        for ix in order {
            if matches!(self.slots[ix], Slot::Idle) {
                self.slots[ix] = Slot::Queued;
                self.queue.push_back(ix);
            }
        }
        self.pump(cx);
    }

    /// Every item, in order: to fill the cache ahead of a measurement.
    pub fn want_all(&mut self, cx: &mut Context<Self>) {
        let len = self.slots.len();
        self.want(0..len, 0..len, cx);
    }

    /// Whether nothing is queued or running.
    pub fn is_idle(&self) -> bool {
        self.queue.is_empty() && self.running == 0
    }

    fn pump(&mut self, cx: &mut Context<Self>) {
        while self.running < self.concurrency {
            let Some(ix) = self.queue.pop_front() else {
                break;
            };
            if !matches!(self.slots[ix], Slot::Queued) {
                continue;
            }
            self.slots[ix] = Slot::Running;
            self.running += 1;
            self.stats.first_started.get_or_insert_with(Instant::now);

            let generation = self.generation;
            let entry = self.entries[ix].clone();
            let folder = self.folder.clone();
            let size = self.size;
            cx.spawn(async move |this, cx| {
                let made = cx
                    .background_spawn(async move { make(&entry, &folder, size) })
                    .await;
                this.update(cx, |this, cx| this.finish(generation, ix, made, cx))
                    .ok();
            })
            .detach();
        }
    }

    fn finish(&mut self, generation: u64, ix: usize, made: Result<Made>, cx: &mut Context<Self>) {
        if generation != self.generation {
            return;
        }
        self.running -= 1;
        self.stats.last_finished = Some(Instant::now());
        self.slots[ix] = match made {
            Ok(Made::FromDisk(path)) => {
                self.stats.from_disk += 1;
                Slot::Ready(path)
            }
            Ok(Made::Generated(path, took)) => {
                self.stats.generated += 1;
                self.stats.generating += took;
                Slot::Ready(path)
            }
            Err(error) => {
                log::debug!("no thumbnail: {error:#}");
                self.stats.unavailable += 1;
                Slot::Unavailable
            }
        };
        cx.notify();
        self.pump(cx);
    }
}

/// Finds the thumbnail on disk or makes it. Blocks; runs on the background executor.
fn make(entry: &MediaEntry, folder: &Path, size: u32) -> Result<Made> {
    let key = cache_key(entry.path(), size, entry.modified_ms(), entry.size());
    let path: Arc<Path> = folder.join(format!("{key}.webp")).into();
    if path.is_file() {
        return Ok(Made::FromDisk(path));
    }
    if entry.kind() == MediaKind::Video {
        bail!("video frames need ffmpeg, which Oriel RS does not run yet");
    }

    let started = Instant::now();
    let still = still::decode(entry.path(), size)?;
    let bytes = still.encode_webp(webp_settings(entry.path()))?;
    write_atomically(folder, &key, &path, &bytes)?;
    Ok(Made::Generated(path, started.elapsed()))
}

/// sharp's settings in Electron Oriel's worker: lossless at effort 0 for PNG, BMP and GIF, and
/// quality 92 at effort 5 for the rest.
fn webp_settings(path: &Path) -> WebpSettings {
    let extension = path
        .extension()
        .map(|extension| extension.to_string_lossy().to_ascii_lowercase());
    if extension.is_some_and(|extension| LOSSLESS_EXTENSIONS.contains(&extension.as_str())) {
        WebpSettings::lossless(0)
    } else {
        WebpSettings::lossy(92., 5)
    }
}

/// Writes beside the final name and renames over it, so `img()` never reads half a file.
fn write_atomically(folder: &Path, key: &str, path: &Path, bytes: &[u8]) -> Result<()> {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    fs::create_dir_all(folder).with_context(|| format!("cannot create {}", folder.display()))?;
    let unique = NEXT.fetch_add(1, Ordering::Relaxed);
    let temporary = folder.join(format!(".{key}.{}-{unique}.tmp", std::process::id()));
    fs::write(&temporary, bytes)
        .with_context(|| format!("cannot write {}", temporary.display()))?;
    fs::rename(&temporary, path).with_context(|| format!("cannot write {}", path.display()))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn request_size_is_twice_the_setting_within_the_protocols_range() {
        assert_eq!(request_size(THUMBNAIL_SIZE), 440);
        assert_eq!(request_size(20.), 64);
        assert_eq!(request_size(900.), 1024);
    }

    /// The key `buildThumbCacheKey` gives, from Node:
    /// `createHash("sha1").update("thumb-v2|/a/b.avif|440|1730000000123.4568|2048")`.
    #[test]
    fn keys_thumbnails_as_electron_oriel_does() {
        assert_eq!(
            cache_key(Path::new("/a/b.avif"), 440, 1_730_000_000_123.456_8, 2048),
            "e1f99ab89875c66745dfb6b561a7662609bc7b9c"
        );
        assert_eq!(js_number(1_730_000_000_000.0), "1730000000000");
        // A file Node stats at 1793199880 s and 249688421 ns has `mtimeMs` 1793199880249.6885.
        let modified_ms = 1_793_199_880_f64 * 1e3 + 249_688_421_f64 / 1e6;
        assert_eq!(js_number(modified_ms), "1793199880249.6885");
    }
}
