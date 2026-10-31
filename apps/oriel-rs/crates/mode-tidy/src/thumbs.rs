//! The pictures Tidy's tiles and rows show, as Electron Oriel's `glazier-media://thumb/` serves
//! them: a still decoded by ImageIO at the size asked for, a video's frame from the pinned ffmpeg.
//!
//! They are kept in memory only: the most recently drawn, up to a few hundred and about 200 MB of
//! pixels (plan 063, decision 23), whichever comes first. An image that goes is released from
//! GPUI's sprite atlas too, since GPUI keeps every image it was handed otherwise (Phase 0's
//! findings), and a tile whose image went shows its ground until it is decoded again.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use gpui_kit::{App, Context, RenderImage};
use oriel_core_tidy::contract::{FileKind, FileRow};
use oriel_tools::{MediaTools, ToolRun};

/// The most decoded pictures kept; more than any page draws at once.
const CAPACITY: usize = 400;

/// The most bytes of decoded pixels kept (decision 23). Duplicates' tiles are 768 px, about 2 MB
/// each, so 400 of them came to some 660 MB; at this cap a revisited set decodes again, which
/// takes under a second.
const CAPACITY_BYTES: u64 = 200 << 20;

/// Electron Oriel's media tools' timeout.
const FRAME_TIMEOUT: Duration = Duration::from_secs(12);

/// Stills decode on the background executor, at most this many at once.
const CONCURRENT: usize = 4;

/// Videos' frames decode in slots of their own, at most this many at once. Each is an ffmpeg
/// process, and most of its time is the process starting and seeking, so more at once fill the
/// cores: with eight, a set of 77 versions shows its tiles in about 40 % less time than with
/// the stills' four, and the Library's typing and scrolling keep their frames.
const VIDEO_CONCURRENT: usize = 8;

enum Entry {
    Queued,
    Loading,
    Ready(Arc<RenderImage>),
    Failed,
}

struct Held {
    entry: Entry,
    /// When it was last asked for, on [`Thumbs::clock`].
    used: u64,
    /// The frame that last asked for it, on [`Thumbs::frame`].
    frame: u64,
    video: bool,
}

/// What a tile shows for a file.
#[derive(Clone)]
pub enum Thumb {
    /// Not decoded yet: the tile's ground.
    Pending,
    Ready(Arc<RenderImage>),
    /// It cannot be shown: the tile's icon.
    Unavailable,
}

pub struct Thumbs {
    held: HashMap<(PathBuf, u32), Held>,
    loading: usize,
    /// Of `loading`, the videos' frames.
    loading_videos: usize,
    /// Counts requests, so the order they came in is known.
    clock: u64,
    /// Counts frames, or rather the bursts of requests one frame's drawing makes: it moves on
    /// once the frame that asked is done.
    frame: u64,
    frame_open: bool,
    /// The bytes of pixels of the pictures held.
    bytes: u64,
    /// Decodes finished since Tidy started, the videos among them, and the time they took,
    /// for the pages spike.
    decoded: u64,
    video_frames: u64,
    decode_time: Duration,
}

impl Thumbs {
    pub fn new() -> Self {
        Self {
            held: HashMap::new(),
            loading: 0,
            loading_videos: 0,
            clock: 0,
            frame: 0,
            frame_open: false,
            bytes: 0,
            decoded: 0,
            video_frames: 0,
            decode_time: Duration::ZERO,
        }
    }

    /// Whether every picture asked for has been decoded, or has failed.
    pub fn is_idle(&self) -> bool {
        self.loading == 0
            && !self
                .held
                .values()
                .any(|held| matches!(held.entry, Entry::Queued))
    }

    /// How many decodes have finished since Tidy started, how many of them were videos' frames,
    /// and the time they took in all.
    pub fn decoded(&self) -> (u64, u64, Duration) {
        (self.decoded, self.video_frames, self.decode_time)
    }

    /// Whether the picture for `path` at `size` has been decoded, or has failed, for the pages
    /// spike.
    pub fn is_done(&self, path: &Path, size: u32) -> bool {
        self.held
            .get(&(path.to_path_buf(), size))
            .is_some_and(|held| matches!(held.entry, Entry::Ready(_) | Entry::Failed))
    }

    /// The pictures held and their pixels' bytes, for the pages spike's memory readings.
    pub fn held(&self) -> (usize, u64) {
        (self.held.len(), self.bytes)
    }

    /// The picture for `row` at `size` pixels on its longer side, asking for it if it is not
    /// decoded yet. Files that are neither images nor videos, or that would not open, have none.
    pub fn get(&mut self, row: &FileRow, size: u32, cx: &mut Context<Self>) -> Thumb {
        let showable = matches!(row.kind, FileKind::Image | FileKind::Video)
            && row.probe_error.is_none()
            && row.size > 0;
        if !showable {
            return Thumb::Unavailable;
        }
        self.path(
            Path::new(&row.abs_path),
            row.kind == FileKind::Video,
            size,
            cx,
        )
    }

    /// The picture for the file at `path`, a video when `video`.
    pub fn path(&mut self, path: &Path, video: bool, size: u32, cx: &mut Context<Self>) -> Thumb {
        self.clock += 1;
        self.open_frame(cx);
        let key = (path.to_path_buf(), size);
        if let Some(held) = self.held.get_mut(&key) {
            held.used = self.clock;
            held.frame = self.frame;
            return match &held.entry {
                Entry::Ready(image) => Thumb::Ready(image.clone()),
                Entry::Failed => Thumb::Unavailable,
                Entry::Queued | Entry::Loading => Thumb::Pending,
            };
        }
        self.make_room(1, cx);
        self.held.insert(
            key,
            Held {
                entry: Entry::Queued,
                used: self.clock,
                frame: self.frame,
                video,
            },
        );
        self.pump(cx);
        Thumb::Pending
    }

    /// Counts the requests from here until the frame drawing them is done as one frame's.
    /// Pictures are asked for while a frame is drawn, and a deferred call runs once it is.
    fn open_frame(&mut self, cx: &mut Context<Self>) {
        if self.frame_open {
            return;
        }
        self.frame_open = true;
        let this = cx.entity().downgrade();
        cx.defer(move |cx| {
            this.update(cx, |this, _| {
                this.frame += 1;
                this.frame_open = false;
            })
            .ok();
        });
    }

    /// Starts decodes while there is room: what the newest frame asked for first, since that is
    /// what is on screen, and in the order it asked, so a page fills from its top.
    fn pump(&mut self, cx: &mut Context<Self>) {
        loop {
            let stills = self.loading - self.loading_videos < CONCURRENT;
            let videos = self.loading_videos < VIDEO_CONCURRENT;
            if !stills && !videos {
                break;
            }
            let Some(key) = self
                .held
                .iter()
                .filter(|(_, held)| {
                    matches!(held.entry, Entry::Queued) && if held.video { videos } else { stills }
                })
                .max_by(|(_, a), (_, b)| a.frame.cmp(&b.frame).then(b.used.cmp(&a.used)))
                .map(|(key, _)| key.clone())
            else {
                break;
            };
            let Some(held) = self.held.get_mut(&key) else {
                break;
            };
            held.entry = Entry::Loading;
            let video = held.video;
            let (path, size) = key.clone();
            self.loading += 1;
            self.loading_videos += usize::from(video);
            let decode = cx.background_executor().spawn(async move {
                let started = std::time::Instant::now();
                let still = if video {
                    video_frame(&path)
                        .and_then(|png| oriel_media::still::decode_bytes(&png, size).ok())
                } else {
                    oriel_media::still::decode(&path, size).ok()
                };
                (
                    still.map(|still| still.into_render_image()),
                    started.elapsed(),
                )
            });
            // Detached, so a picture evicted while it decodes still frees its slot when done.
            cx.spawn(async move |this, cx| {
                let (image, took) = decode.await;
                this.update(cx, |this, cx| {
                    this.loading -= 1;
                    this.loading_videos -= usize::from(video);
                    this.decoded += 1;
                    this.video_frames += u64::from(video);
                    this.decode_time += took;
                    match this.held.get_mut(&key) {
                        // Asked for again after it went, it may have been decoded twice.
                        Some(held) if !matches!(held.entry, Entry::Ready(_)) => {
                            held.entry = match image {
                                Some(image) => {
                                    this.bytes += pixel_bytes(&image);
                                    Entry::Ready(image)
                                }
                                None => Entry::Failed,
                            };
                            // The bytes grew, so the least recently drawn may have to go.
                            this.make_room(0, cx);
                        }
                        _ => {
                            if let Some(image) = image {
                                cx.drop_image(image, None);
                            }
                        }
                    }
                    this.pump(cx);
                    cx.notify();
                })
                .ok();
            })
            .detach();
        }
    }

    /// Drops the least recently drawn until there is room for `more` pictures and the pixels
    /// held fit [`CAPACITY_BYTES`]. What the last frame drew stays, even past either cap, so a
    /// page that draws more than that never decodes its own pictures over and over.
    fn make_room(&mut self, more: usize, cx: &mut App) {
        let mut evicted = Vec::new();
        while self.held.len() + more > CAPACITY || self.bytes > CAPACITY_BYTES {
            let frame = self.frame;
            let Some(oldest) = self
                .held
                .iter()
                .filter(|(_, held)| held.frame + 1 < frame)
                .min_by_key(|(_, held)| held.used)
                .map(|(key, _)| key.clone())
            else {
                break;
            };
            if let Some(Held {
                entry: Entry::Ready(image),
                ..
            }) = self.held.remove(&oldest)
            {
                self.bytes -= pixel_bytes(&image);
                evicted.push(image);
            }
        }
        if !evicted.is_empty() {
            // Pictures are asked for while a frame is drawn, and GPUI lends the window out for
            // the draw, so `drop_image` would miss its atlas and the texture would stay there
            // for good. Once the frame is done the window is back and the atlas lets go.
            cx.defer(move |cx| {
                for image in evicted {
                    cx.drop_image(image, None);
                }
            });
        }
    }
}

/// The bytes of a decoded picture's pixels.
fn pixel_bytes(image: &RenderImage) -> u64 {
    let size = image.size(0);
    size.width.0.unsigned_abs() as u64 * size.height.0.unsigned_abs() as u64 * 4
}

/// One frame of a video, a second in or else its first, as PNG bytes from the pinned ffmpeg
/// (`extractVideoFrame`).
///
/// The PNG is compressed at zlib's quickest level, not ffmpeg's default: it only crosses a pipe
/// to be decoded at once, and decodes to the same pixels, while the default's compression of a
/// full-size frame took most of the run. Stored outright it would be a little quicker still, but
/// five times the size, and the allocator keeps what such frames leave behind.
fn video_frame(path: &Path) -> Option<Vec<u8>> {
    static TOOLS: OnceLock<Option<MediaTools>> = OnceLock::new();
    let tools = TOOLS.get_or_init(|| MediaTools::locate().ok()).as_ref()?;
    for start in ["00:00:01", "00:00:00"] {
        let output = ToolRun::new(tools.ffmpeg(), FRAME_TIMEOUT)
            .args(["-hide_banner", "-loglevel", "error", "-ss", start, "-i"])
            .arg(path)
            .args([
                "-frames:v",
                "1",
                "-f",
                "image2pipe",
                "-vcodec",
                "png",
                "-compression_level",
                "1",
                "pipe:1",
            ])
            .run()
            .ok()?;
        if output.success() && !output.stdout.is_empty() {
            return Some(output.stdout);
        }
    }
    None
}

/// A file's picture filling its box: the thumbnail fitted as `fit` says, or the file's icon on
/// the tile's ground while there is none.
pub fn picture(
    thumbs: &gpui_kit::Entity<Thumbs>,
    row: &FileRow,
    size: u32,
    fit: gpui_kit::ObjectFit,
    cx: &mut App,
) -> gpui_kit::AnyElement {
    use gpui_kit::component::{ActiveTheme as _, Icon};
    use gpui_kit::{IntoElement as _, ParentElement as _, Styled as _, StyledImage as _, div, img};

    let thumb = thumbs.update(cx, |thumbs, cx| thumbs.get(row, size, cx));
    let theme = cx.theme();
    match thumb {
        Thumb::Ready(image) => img(image).size_full().object_fit(fit).into_any_element(),
        Thumb::Pending => div().size_full().bg(theme.muted).into_any_element(),
        Thumb::Unavailable => div()
            .size_full()
            .flex()
            .items_center()
            .justify_center()
            .bg(theme.muted)
            .text_color(theme.muted_foreground)
            .child(Icon::new(kind_icon(row.kind)))
            .into_any_element(),
    }
}

/// The icon standing for a file of `kind` that shows no picture.
pub fn kind_icon(kind: FileKind) -> gpui_kit::assets::IconName {
    use gpui_kit::assets::IconName;
    match kind {
        FileKind::Image => IconName::Image,
        FileKind::Video => IconName::Film,
        FileKind::Junk => IconName::Delete,
        FileKind::Audio | FileKind::Pdf | FileKind::Other => IconName::File,
    }
}
