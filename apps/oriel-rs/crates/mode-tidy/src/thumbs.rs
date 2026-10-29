//! The pictures Tidy's tiles and rows show, as Electron Oriel's `glazier-media://thumb/` serves
//! them: a still decoded by ImageIO at the size asked for, a video's frame from the pinned ffmpeg.
//!
//! They are kept in memory only, the most recently drawn few hundred, and an image that goes is
//! released from GPUI's sprite atlas too, since GPUI keeps every image it was handed otherwise
//! (plan 063, Phase 0's findings).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use gpui_kit::{App, Context, RenderImage};
use oriel_core_tidy::contract::{FileKind, FileRow};
use oriel_tools::{MediaTools, ToolRun};

/// The most decoded pictures kept; more than any page draws at once.
const CAPACITY: usize = 400;

/// Electron Oriel's media tools' timeout.
const FRAME_TIMEOUT: Duration = Duration::from_secs(12);

/// Decodes run on the background executor, at most this many at once.
const CONCURRENT: usize = 4;

enum Entry {
    Queued,
    Loading,
    Ready(Arc<RenderImage>),
    Failed,
}

struct Held {
    entry: Entry,
    used: u64,
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
    queue: Vec<(PathBuf, u32, bool)>,
    loading: usize,
    clock: u64,
}

impl Thumbs {
    pub fn new() -> Self {
        Self {
            held: HashMap::new(),
            queue: Vec::new(),
            loading: 0,
            clock: 0,
        }
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
        let key = (path.to_path_buf(), size);
        if let Some(held) = self.held.get_mut(&key) {
            held.used = self.clock;
            return match &held.entry {
                Entry::Ready(image) => Thumb::Ready(image.clone()),
                Entry::Failed => Thumb::Unavailable,
                Entry::Queued | Entry::Loading => Thumb::Pending,
            };
        }
        self.make_room(cx);
        self.held.insert(
            key,
            Held {
                entry: Entry::Queued,
                used: self.clock,
            },
        );
        self.queue.push((path.to_path_buf(), size, video));
        self.pump(cx);
        Thumb::Pending
    }

    /// Starts decodes while there is room, newest asked first, since that is what is on screen.
    fn pump(&mut self, cx: &mut Context<Self>) {
        while self.loading < CONCURRENT {
            let Some((path, size, video)) = self.queue.pop() else {
                break;
            };
            let key = (path.clone(), size);
            if !matches!(
                self.held.get(&key),
                Some(Held {
                    entry: Entry::Queued,
                    ..
                })
            ) {
                continue;
            }
            let task_key = path.clone();
            self.loading += 1;
            let decode = cx.background_executor().spawn(async move {
                let still = if video {
                    video_frame(&path)
                        .and_then(|png| oriel_media::still::decode_bytes(&png, size).ok())
                } else {
                    oriel_media::still::decode(&path, size).ok()
                };
                still.map(|still| still.into_render_image())
            });
            // Detached, so a picture evicted while it decodes still frees its slot when done.
            cx.spawn(async move |this, cx| {
                let image = decode.await;
                this.update(cx, |this, cx| {
                    this.loading -= 1;
                    if let Some(held) = this.held.get_mut(&key) {
                        held.entry = match image {
                            Some(image) => Entry::Ready(image),
                            None => Entry::Failed,
                        };
                    } else if let Some(image) = image {
                        cx.drop_image(image, None);
                    }
                    this.pump(cx);
                    cx.notify();
                })
                .ok();
            })
            .detach();
            if let Some(held) = self.held.get_mut(&(task_key, size)) {
                held.entry = Entry::Loading;
            }
        }
    }

    /// Drops the least recently drawn until there is room for one more.
    fn make_room(&mut self, cx: &mut App) {
        while self.held.len() >= CAPACITY {
            let Some(oldest) = self
                .held
                .iter()
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
                cx.drop_image(image, None);
            }
        }
    }
}

/// One frame of a video, a second in or else its first, as PNG bytes from the pinned ffmpeg
/// (`extractVideoFrame`).
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
