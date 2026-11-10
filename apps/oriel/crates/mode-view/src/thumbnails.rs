//! The thumbnail service: a WebP per still and per video, made on the background executor, kept
//! on disk in `DataRoot::view_thumbnails` and drawn by GPUI's `img()`.
//!
//! - The request size is twice the thumbnail size setting.
//! - The cache key is the item's id (its path, length and modification time) and the request
//!   size, as SHA-1 hex, so a changed file gets a new thumbnail.
//! - Stills go through ImageIO (libvips off macOS) and libwebp at sharp's settings (lossless at effort 0 for PNG, BMP
//!   and GIF, quality 92 at effort 5 for the rest); videos as a frame a second in from the pinned
//!   ffmpeg, at quality 82 and effort 4.
//! - One video worker; the image workers are all the cores but two, up to 12 (below).
//! - The gallery's visible tiles come before its overscan, and a tile that scrolled away is
//!   dropped from the queue.
//! - The disk cache is pruned to its 5,000 newest files once it passes 5,100: a known weakness,
//!   since an archive larger than 5,000 tiles makes its thumbnails again on every pass.
//! - Decoded tiles live in the gallery's own bounded image cache, not here.

use std::collections::{HashMap, HashSet, VecDeque};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant, SystemTime};

use anyhow::{Context as _, Result};
use gpui_kit::{AppContext as _, Context, SharedString};
use oriel_core_domain::format::iso_timestamp;
use oriel_media::still::{self, WebpSettings};
use oriel_runtime::CancelToken;

use crate::listing::{MediaEntry, MediaKind};
use crate::media_tools::ViewMediaTools;

/// View's thumbnail size setting by default, in pixels.
pub const THUMBNAIL_SIZE: f32 = 220.;

/// The disk cache is pruned back to this many files…
pub const MAX_DISK_FILES: usize = 5000;
/// …once it holds more than this.
const PRUNE_ABOVE: usize = MAX_DISK_FILES + 100;

/// Bumped when the files or their keys change shape, so old ones are never read as new.
const CACHE_VERSION: &str = "thumb-v3";

/// Stills whose thumbnails stay lossless, as sharp is asked for them.
const LOSSLESS_EXTENSIONS: [&str; 3] = ["png", "bmp", "gif"];

/// Videos' frames are made one at a time: each is an ffmpeg process.
const VIDEO_WORKERS: usize = 1;

/// How many failures Diagnostics lists.
const RECENT_FAILURES: usize = 10;

/// How many of the service's own events Diagnostics lists.
const RECENT_EVENTS: usize = 10;

/// The size thumbnails are made at for a thumbnail size setting: twice it, for a 2× display,
/// within 64 to 1024.
pub fn request_size(thumbnail_size: f32) -> u32 {
    (thumbnail_size * 2.).round().clamp(64., 1024.) as u32
}

/// The cache key of the thumbnail of the item with `id` ([`crate::listing::media_id`]) at
/// `size`: `sha1("thumb-v3|id|size")` in hex.
pub fn cache_key(id: &str, size: u32) -> String {
    sha1_smol::Sha1::from(format!("{CACHE_VERSION}|{id}|{size}"))
        .digest()
        .to_string()
}

/// The image workers: every core but two, kept for the main thread and the rest of the app, at
/// least 2 and at most 12. Each holds one still's decode at a time, 20 to 100 MB for the largest
/// AVIF while ImageIO decodes it, so the cap bounds that on a machine with many cores.
fn default_concurrency() -> usize {
    let cores = std::thread::available_parallelism().map_or(4, |cores| cores.get());
    cores.saturating_sub(2).clamp(2, 12)
}

/// A gallery item's thumbnail, as the gallery draws it.
#[derive(Clone, Debug, PartialEq)]
pub enum Thumbnail {
    /// Not made yet, or not asked for: the tile shows its placeholder.
    Pending,
    /// The WebP on disk, for `img()`.
    Ready(Arc<Path>),
    /// It cannot be made (a file ImageIO cannot read, or a video ffmpeg cannot): the placeholder
    /// stays.
    Unavailable,
}

#[derive(Clone, Debug)]
enum Slot {
    Queued,
    Running,
    Ready(Arc<Path>),
    Unavailable,
}

/// How a job ended.
enum Made {
    FromDisk(Arc<Path>),
    Generated {
        path: Arc<Path>,
        took: Duration,
        created: bool,
    },
}

/// Why a thumbnail could not be made, for Diagnostics' counts.
enum Failure {
    Decode(anyhow::Error),
    Video(anyhow::Error),
    Cancelled,
}

/// What the service has done since it was made: Phase 0's measurements and Diagnostics.
#[derive(Clone, Copy, Debug, Default)]
pub struct ThumbnailStats {
    generated: usize,
    from_disk: usize,
    unavailable: usize,
    decode_failures: usize,
    video_failures: usize,
    cancelled: usize,
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

    /// Stills ImageIO could not read.
    pub fn decode_failures(&self) -> usize {
        self.decode_failures
    }

    /// Videos ffmpeg could not take a frame from.
    pub fn video_failures(&self) -> usize {
        self.video_failures
    }

    /// Video frames stopped because their tile went away.
    pub fn cancelled(&self) -> usize {
        self.cancelled
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

/// What View's two Diagnostics switches ask of the service: its events
/// written to the terminal as they happen, and its timings kept.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct DebugOptions {
    pub logging: bool,
    pub monitoring: bool,
}

/// One kind of timing, in milliseconds.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct TimingAggregate {
    pub count: u64,
    total_ms: f64,
    max_ms: f64,
}

impl TimingAggregate {
    fn record(&mut self, took: Duration) {
        let ms = took.as_secs_f64() * 1000.;
        self.count += 1;
        self.total_ms += ms;
        self.max_ms = self.max_ms.max(ms);
    }

    /// The mean, to two decimals.
    pub fn average_ms(&self) -> f64 {
        if self.count == 0 {
            return 0.;
        }
        (self.total_ms / self.count as f64 * 100.).round() / 100.
    }

    /// The longest, to two decimals.
    pub fn max_ms(&self) -> f64 {
        (self.max_ms * 100.).round() / 100.
    }
}

/// The service's timings while performance monitoring is on: a thumbnail found on disk, one made,
/// and each from the gallery asking to it being ready.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct ThumbnailTimings {
    pub disk_hit: TimingAggregate,
    pub generation: TimingAggregate,
    pub end_to_end: TimingAggregate,
}

/// What Diagnostics shows of the service right now.
#[derive(Clone, Debug, Default)]
pub struct ThumbnailDiagnostics {
    pub image_workers: usize,
    pub video_workers: usize,
    pub images_queued: usize,
    pub videos_queued: usize,
    pub in_flight: usize,
    pub disk_files: usize,
    pub recent_failures: Vec<String>,
    /// The service's own events, newest last.
    pub recent_events: Vec<String>,
    /// The timings, while performance monitoring is on.
    pub timings: Option<ThumbnailTimings>,
}

/// Makes and finds thumbnails. The gallery says which items it wants; the service works through
/// them, the visible ones first, a few at once, and notifies as each is ready. Thumbnails are
/// kept by item, so a re-sort, a shuffle or a scan's next batch keeps the ones already made.
pub struct ThumbnailService {
    folder: Arc<Path>,
    size: u32,
    concurrency: usize,
    tools: Arc<ViewMediaTools>,
    generation: u64,
    /// Cancels the video frames of this generation when it ends.
    cancel: CancelToken,
    slots: HashMap<SharedString, Slot>,
    images: VecDeque<MediaEntry>,
    videos: VecDeque<MediaEntry>,
    running_images: usize,
    running_videos: usize,
    stats: ThumbnailStats,
    recent_failures: VecDeque<String>,
    recent_events: VecDeque<String>,
    debug: DebugOptions,
    timings: ThumbnailTimings,
    /// When the gallery asked for each queued or running thumbnail, for the end-to-end timing.
    requested_at: HashMap<SharedString, Instant>,
    disk_files: usize,
    pruning: bool,
    /// The cache's WebP files by name, listed at start and kept up as files are written, pruned
    /// and cleared, so a thumbnail already on disk is ready as soon as it is wanted, without a
    /// job and its trip to a worker and back for each. `None` until the listing is in and while
    /// a prune runs; the jobs then look on disk themselves, as they always do before making one.
    on_disk: Option<HashSet<Box<str>>>,
    /// Which listing of the folder is current. A clear starts a new one, so a listing or prune
    /// begun before it, which would name the files it deleted, is dropped when it comes in.
    listing: u64,
}

impl ThumbnailService {
    /// A service writing to `folder` (View's thumbnail folder), at `size` pixels. The folder's
    /// files are counted, and pruned if there are too many, in the background.
    pub fn new(folder: impl Into<PathBuf>, size: u32, cx: &mut Context<Self>) -> Self {
        let folder: Arc<Path> = folder.into().into();
        let mut service = Self {
            folder: folder.clone(),
            size,
            concurrency: default_concurrency(),
            tools: ViewMediaTools::shared(),
            generation: 0,
            cancel: CancelToken::new(),
            slots: HashMap::new(),
            images: VecDeque::new(),
            videos: VecDeque::new(),
            running_images: 0,
            running_videos: 0,
            stats: ThumbnailStats::default(),
            recent_failures: VecDeque::new(),
            recent_events: VecDeque::new(),
            debug: DebugOptions::default(),
            timings: ThumbnailTimings::default(),
            requested_at: HashMap::new(),
            disk_files: 0,
            pruning: false,
            on_disk: None,
            listing: 0,
        };
        service.event(format!(
            "{} image workers and {VIDEO_WORKERS} video worker ready. ffmpeg={} ImageIO=true",
            service.concurrency,
            oriel_tools::MediaTools::shared().is_ok()
        ));
        cx.spawn(async move |this, cx| {
            let left = cx
                .background_spawn(async move {
                    if let Err(error) = fs::create_dir_all(&folder) {
                        log::warn!("cannot create {}: {error}", folder.display());
                    }
                    prune_listing(&folder)
                })
                .await;
            this.update(cx, |this, _| {
                if this.listing != 0 {
                    return;
                }
                let (count, names) = left;
                this.disk_files = count;
                // A file made meanwhile is missing from the listing; its job found or made it.
                this.on_disk = Some(names);
            })
            .ok();
        })
        .detach();
        service
    }

    pub fn concurrency(&self) -> usize {
        self.concurrency
    }

    pub fn stats(&self) -> ThumbnailStats {
        self.stats
    }

    pub fn diagnostics(&self) -> ThumbnailDiagnostics {
        ThumbnailDiagnostics {
            image_workers: self.concurrency,
            video_workers: VIDEO_WORKERS,
            images_queued: self.images.len(),
            videos_queued: self.videos.len(),
            in_flight: self.running_images + self.running_videos,
            disk_files: self.disk_files,
            recent_failures: self.recent_failures.iter().cloned().collect(),
            recent_events: self.recent_events.iter().cloned().collect(),
            timings: self.debug.monitoring.then_some(self.timings),
        }
    }

    /// Follows View's Diagnostics switches.
    pub fn set_debug(&mut self, debug: DebugOptions) {
        self.debug = debug;
    }

    /// Notes one of the service's own events for Diagnostics, and writes it to the terminal while
    /// debug logging is on.
    fn event(&mut self, message: String) {
        if self.debug.logging {
            eprintln!("[thumbnails] {message}");
        }
        self.recent_events
            .push_back(format!("{} {message}", iso_timestamp(SystemTime::now())));
        while self.recent_events.len() > RECENT_EVENTS {
            self.recent_events.pop_front();
        }
    }

    /// Makes thumbnails at `size` from now on, starting over if it changed.
    pub fn set_size(&mut self, size: u32, cx: &mut Context<Self>) {
        if self.size != size {
            self.size = size;
            self.reset(cx);
        }
    }

    /// Forgets every thumbnail and stops the work queued or running for them: for a new folder,
    /// where none of them will be asked for again. The files stay on disk.
    pub fn reset(&mut self, cx: &mut Context<Self>) {
        let (queued, running) = (
            self.images.len() + self.videos.len(),
            self.running_images + self.running_videos,
        );
        if queued + running > 0 {
            self.event(format!(
                "Started over: {queued} queued dropped, {running} running stopped"
            ));
        }
        self.requested_at.clear();
        self.generation += 1;
        self.cancel.cancel();
        self.cancel = CancelToken::new();
        self.slots.clear();
        self.images.clear();
        self.videos.clear();
        self.running_images = 0;
        self.running_videos = 0;
        cx.notify();
    }

    /// Deletes every thumbnail on disk (Settings › Storage).
    pub fn clear_cache(&mut self, cx: &mut Context<Self>) {
        self.reset(cx);
        self.listing += 1;
        self.on_disk = Some(HashSet::new());
        let folder = self.folder.clone();
        cx.spawn(async move |this, cx| {
            cx.background_spawn(async move { clear(&folder) }).await;
            this.update(cx, |this, cx| {
                this.disk_files = 0;
                this.event("Disk cache cleared".into());
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    pub fn thumbnail(&self, entry: &MediaEntry) -> Thumbnail {
        match self.slots.get(entry.key()) {
            Some(Slot::Ready(path)) => Thumbnail::Ready(path.clone()),
            Some(Slot::Unavailable) => Thumbnail::Unavailable,
            _ => Thumbnail::Pending,
        }
    }

    /// The items the gallery wants now: `visible` first, then `nearby` (its overscan). Anything
    /// queued before and wanted no longer is dropped from the queue. A thumbnail the cache's
    /// listing has is ready at once, and the gallery is told; the rest are drawn differently only
    /// once made.
    pub fn want(&mut self, visible: &[MediaEntry], nearby: &[MediaEntry], cx: &mut Context<Self>) {
        for entry in self.images.drain(..).chain(self.videos.drain(..)) {
            if matches!(self.slots.get(entry.key()), Some(Slot::Queued)) {
                self.slots.remove(entry.key());
                self.requested_at.remove(entry.key());
            }
        }
        let mut seen = HashSet::new();
        let now = Instant::now();
        let mut found = false;
        for entry in visible.iter().chain(nearby) {
            if !seen.insert(entry.key().clone()) || self.slots.contains_key(entry.key()) {
                continue;
            }
            if let Some(path) = self.on_disk_path(entry) {
                self.found_on_disk(entry, path, now);
                found = true;
                continue;
            }
            self.slots.insert(entry.key().clone(), Slot::Queued);
            self.requested_at.entry(entry.key().clone()).or_insert(now);
            if entry.is_video() {
                self.videos.push_back(entry.clone());
            } else {
                self.images.push_back(entry.clone());
            }
        }
        if found {
            cx.notify();
        }
        self.pump(cx);
    }

    /// The entry's file, if the cache's listing has it.
    fn on_disk_path(&self, entry: &MediaEntry) -> Option<Arc<Path>> {
        let on_disk = self.on_disk.as_ref()?;
        let name = file_name(&cache_key(entry.id(), self.size));
        on_disk
            .contains(name.as_str())
            .then(|| self.folder.join(name).into())
    }

    /// Records a thumbnail found in the cache's listing as a job finding it on disk would.
    fn found_on_disk(&mut self, entry: &MediaEntry, path: Arc<Path>, now: Instant) {
        self.stats.first_started.get_or_insert(now);
        self.stats.last_finished = Some(now);
        self.stats.from_disk += 1;
        if self.debug.monitoring {
            let took = now.elapsed();
            self.timings.disk_hit.record(took);
            self.timings.end_to_end.record(took);
        }
        self.slots.insert(entry.key().clone(), Slot::Ready(path));
    }

    pub fn is_idle(&self) -> bool {
        self.images.is_empty()
            && self.videos.is_empty()
            && self.running_images == 0
            && self.running_videos == 0
    }

    fn pump(&mut self, cx: &mut Context<Self>) {
        while self.running_images < self.concurrency {
            let Some(entry) = self.images.pop_front() else {
                break;
            };
            self.running_images += 1;
            self.start(entry, cx);
        }
        while self.running_videos < VIDEO_WORKERS {
            let Some(entry) = self.videos.pop_front() else {
                break;
            };
            self.running_videos += 1;
            self.start(entry, cx);
        }
    }

    fn start(&mut self, entry: MediaEntry, cx: &mut Context<Self>) {
        self.slots.insert(entry.key().clone(), Slot::Running);
        self.stats.first_started.get_or_insert_with(Instant::now);
        let generation = self.generation;
        let folder = self.folder.clone();
        let size = self.size;
        let tools = self.tools.clone();
        let cancel = self.cancel.clone();
        cx.spawn(async move |this, cx| {
            let job = entry.clone();
            let started = Instant::now();
            let made = cx
                .background_spawn(async move { make(&job, &folder, size, &tools, &cancel) })
                .await;
            let took = started.elapsed();
            this.update(cx, |this, cx| {
                this.time(generation, &entry, &made, took);
                this.finish(generation, &entry, made, cx);
            })
            .ok();
        })
        .detach();
    }

    /// Records a job's timings while performance monitoring is on.
    fn time(
        &mut self,
        generation: u64,
        entry: &MediaEntry,
        made: &Result<Made, Failure>,
        took: Duration,
    ) {
        if generation != self.generation {
            return;
        }
        let requested = self.requested_at.remove(entry.key());
        if !self.debug.monitoring {
            return;
        }
        match made {
            Ok(Made::FromDisk(_)) => self.timings.disk_hit.record(took),
            Ok(Made::Generated { took, .. }) => self.timings.generation.record(*took),
            Err(_) => {}
        }
        if made.is_ok()
            && let Some(requested) = requested
        {
            self.timings.end_to_end.record(requested.elapsed());
        }
    }

    fn finish(
        &mut self,
        generation: u64,
        entry: &MediaEntry,
        made: Result<Made, Failure>,
        cx: &mut Context<Self>,
    ) {
        if generation != self.generation {
            return;
        }
        if entry.is_video() {
            self.running_videos = self.running_videos.saturating_sub(1);
        } else {
            self.running_images = self.running_images.saturating_sub(1);
        }
        self.stats.last_finished = Some(Instant::now());
        let slot = match made {
            Ok(Made::FromDisk(path)) => {
                self.stats.from_disk += 1;
                Slot::Ready(path)
            }
            Ok(Made::Generated {
                path,
                took,
                created,
            }) => {
                self.stats.generated += 1;
                self.stats.generating += took;
                if created {
                    self.disk_files += 1;
                    if let (Some(on_disk), Some(name)) = (&mut self.on_disk, path.file_name()) {
                        on_disk.insert(name.to_string_lossy().into());
                    }
                    self.prune_if_full(cx);
                }
                Slot::Ready(path)
            }
            Err(Failure::Cancelled) => {
                self.stats.cancelled += 1;
                self.slots.remove(entry.key());
                self.pump(cx);
                return;
            }
            Err(Failure::Decode(error)) => {
                self.stats.decode_failures += 1;
                self.fail(entry, &error)
            }
            Err(Failure::Video(error)) => {
                self.stats.video_failures += 1;
                self.fail(entry, &error)
            }
        };
        self.slots.insert(entry.key().clone(), slot);
        cx.notify();
        self.pump(cx);
    }

    fn fail(&mut self, entry: &MediaEntry, error: &anyhow::Error) -> Slot {
        log::debug!("no thumbnail for {}: {error:#}", entry.path().display());
        self.stats.unavailable += 1;
        let line = format!(
            "{} {}: {error:#}",
            iso_timestamp(SystemTime::now()),
            entry.name()
        );
        self.recent_failures.push_back(line);
        while self.recent_failures.len() > RECENT_FAILURES {
            self.recent_failures.pop_front();
        }
        Slot::Unavailable
    }

    fn prune_if_full(&mut self, cx: &mut Context<Self>) {
        if self.pruning || self.disk_files <= PRUNE_ABOVE {
            return;
        }
        self.pruning = true;
        // The listing would name files the prune deletes, so it is set aside until the prune
        // says what is left.
        self.on_disk = None;
        let folder = self.folder.clone();
        let listing = self.listing;
        cx.spawn(async move |this, cx| {
            let left = cx
                .background_spawn(async move { prune_listing(&folder) })
                .await;
            this.update(cx, |this, _| {
                this.pruning = false;
                if this.listing != listing {
                    return;
                }
                let (count, names) = left;
                this.disk_files = count;
                this.event(format!("Disk cache pruned to {count} files"));
                this.on_disk = Some(names);
            })
            .ok();
        })
        .detach();
    }
}

/// Finds the thumbnail on disk or makes it. Blocks; runs on the background executor.
fn make(
    entry: &MediaEntry,
    folder: &Path,
    size: u32,
    tools: &ViewMediaTools,
    cancel: &CancelToken,
) -> Result<Made, Failure> {
    let key = cache_key(entry.id(), size);
    let path: Arc<Path> = folder.join(file_name(&key)).into();
    if path.is_file() {
        return Ok(Made::FromDisk(path));
    }

    let started = Instant::now();
    let bytes = if entry.kind() == MediaKind::Video {
        let frame = tools
            .poster_frame(entry.path(), cancel)
            .map_err(|_| Failure::Cancelled)?
            .ok_or_else(|| {
                Failure::Video(anyhow::anyhow!(
                    "Video frame extraction failed: {}",
                    entry.name()
                ))
            })?;
        still::decode_bytes(&frame, size)
            .and_then(|still| still.encode_webp(WebpSettings::lossy(82., 4)))
            .map_err(|error| Failure::Video(error.context("Video frame extraction failed")))?
    } else {
        still::decode(entry.path(), size)
            .and_then(|still| still.encode_webp(webp_settings(entry.path())))
            .map_err(Failure::Decode)?
    };
    if cancel.is_cancelled() && entry.is_video() {
        return Err(Failure::Cancelled);
    }
    let created = !path.is_file();
    write_atomically(folder, &key, &path, &bytes).map_err(Failure::Decode)?;
    Ok(Made::Generated {
        path,
        took: started.elapsed(),
        created,
    })
}

/// sharp's settings: lossless at effort 0 for PNG, BMP and GIF, and quality 92 at effort 5 for
/// the rest.
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

/// The cache's files, its WebP thumbnails; anything else in the folder is left alone.
fn cached_files(folder: &Path) -> Vec<PathBuf> {
    let Ok(entries) = fs::read_dir(folder) else {
        return Vec::new();
    };
    entries
        .flatten()
        .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_file()))
        .map(|entry| entry.path())
        .filter(|path| {
            path.extension()
                .is_some_and(|extension| extension == "webp")
        })
        .collect()
}

/// A thumbnail's file name in the cache.
fn file_name(key: &str) -> String {
    format!("{key}.webp")
}

/// Deletes the oldest files past [`MAX_DISK_FILES`], by modified time, and returns how many are
/// left, with the names of the WebP files left, which the service looks thumbnails up in.
fn prune_listing(folder: &Path) -> (usize, HashSet<Box<str>>) {
    let kept = prune_kept(folder);
    let names = kept
        .iter()
        .filter_map(|path| Some(path.file_name()?.to_string_lossy().into()))
        .collect();
    (kept.len(), names)
}

/// The cache's files once pruned.
fn prune_kept(folder: &Path) -> Vec<PathBuf> {
    let files = cached_files(folder);
    if files.len() <= MAX_DISK_FILES {
        return files;
    }
    let mut dated: Vec<(SystemTime, PathBuf)> = files
        .into_iter()
        .filter_map(|path| Some((fs::metadata(&path).ok()?.modified().ok()?, path)))
        .collect();
    dated.sort_by_key(|(modified, _)| *modified);
    let excess = dated.len().saturating_sub(MAX_DISK_FILES);
    for (_, path) in dated.iter().take(excess) {
        remove(path);
    }
    dated
        .into_iter()
        .skip(excess)
        .map(|(_, path)| path)
        .collect()
}

fn clear(folder: &Path) {
    for path in cached_files(folder) {
        remove(&path);
    }
}

fn remove(path: &Path) {
    if let Err(error) = fs::remove_file(path)
        && error.kind() != std::io::ErrorKind::NotFound
    {
        log::warn!("cannot delete {}: {error}", path.display());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_disk_cache_keeps_its_newest_five_thousand() {
        let folder =
            std::env::temp_dir().join(format!("oriel-mode-view-prune-{}", std::process::id()));
        let _ = fs::remove_dir_all(&folder);
        fs::create_dir_all(&folder).unwrap();
        let base = SystemTime::UNIX_EPOCH + Duration::from_secs(1_700_000_000);
        for ix in 0..MAX_DISK_FILES + 3 {
            let path = folder.join(format!("{ix:05}.webp"));
            fs::write(&path, b"x").unwrap();
            fs::File::options()
                .write(true)
                .open(&path)
                .unwrap()
                .set_modified(base + Duration::from_secs(ix as u64))
                .unwrap();
        }
        fs::write(folder.join("notes.txt"), b"not a thumbnail").unwrap();
        assert_eq!(prune_listing(&folder).0, MAX_DISK_FILES);
        for oldest in 0..3 {
            assert!(!folder.join(format!("{oldest:05}.webp")).exists());
        }
        assert!(folder.join("00003.webp").exists());
        assert!(folder.join("notes.txt").exists());
        clear(&folder);
        assert_eq!(cached_files(&folder).len(), 0);
        fs::remove_dir_all(&folder).unwrap();
    }
}
