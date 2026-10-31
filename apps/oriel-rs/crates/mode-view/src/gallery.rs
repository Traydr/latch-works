//! The gallery: a folder's tiles (its subfolders, comics or media) as a virtual grid,
//! `uniform_list` rows of tiles sized as Electron Oriel sizes them, each tile its thumbnail once
//! made and a placeholder until then.
//!
//! The gallery owns the grid's scroll position, the selection and the keys that move it
//! (`useGalleryKeyboardNavigation`). It says which rows it drew, and the thumbnail service makes
//! those first. What a tile opens is the owner's: a double-click, Enter or F emits
//! [`GalleryEvent::Activated`], and the folder keys emit [`GalleryEvent::FolderStep`].
//!
//! A tile under the pointer shows its name and size over the picture (`MediaTile`'s hover
//! caption), with a video's picture size once ffprobe has read it; the videos drawn are probed
//! two at a time, as `useVideoMetadataQueue` does. A video tile plays under the pointer while
//! "Autoplay video on hover" is on ([`preview`]).

mod images;
pub mod metrics;
pub mod preview;

use std::collections::{HashMap, HashSet, VecDeque};
use std::ops::Range;
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::sync::Arc;
use std::time::{Duration, Instant};

use gpui_kit::assets::IconName;
use gpui_kit::component::{ActiveTheme as _, Icon};
use gpui_kit::{
    App, AppContext as _, Bounds, ClickEvent, Context, DispatchPhase, ElementId, Entity,
    EventEmitter, FocusHandle, Focusable, Hitbox, HitboxBehavior, InteractiveElement as _,
    IntoElement, KeyBinding, MouseMoveEvent, ParentElement as _, Render, Role, ScrollStrategy,
    SharedString, StatefulInteractiveElement as _, Styled as _, Subscription, Task,
    TestSupportExt as _, UniformListScrollHandle, WeakEntity, Window, actions, canvas, div,
    linear_color_stop, linear_gradient, point, prelude::FluentBuilder as _, px, size, uniform_list,
};
use oriel_core_domain::format_bytes;
use oriel_ui::layout::{RAIL_WIDTH, SIDEBAR_WIDTH};
use oriel_ui::{ModeId, OfferedFolders, ShellState};

use crate::browser::{Comic, Tile};
use crate::listing::MediaEntry;
use crate::media_tools::{VideoProbe, ViewMediaTools};
use crate::thumbnails::{THUMBNAIL_SIZE, Thumbnail, ThumbnailService};
use images::{TileImages, TilePicture, tile_picture};
use metrics::{GridMetrics, OVERSCAN_ROWS, TileAspect};
pub use preview::{HOVER_DELAY, PreviewSettings, TilePreview};

/// How many videos ffprobe reads at once for their captions (`MAX_PROBE_CONCURRENCY`).
const PROBES_AT_ONCE: usize = 2;

/// How long the gallery stays still, drawing nothing and making no thumbnails, before the memory
/// its scroll and thumbnails freed goes back to the system.
const SETTLE: Duration = Duration::from_secs(2);

/// The id of the grid's scroll region.
pub const GALLERY_ID: &str = "gallery";

/// The id of the hover caption, which one tile at most shows.
pub const CAPTION_ID: &str = "tile-caption";

const KEY_CONTEXT: &str = "Gallery";

actions!(
    gallery,
    [
        /// The tile to the left (← or A).
        SelectLeft,
        /// The tile to the right (→ or D).
        SelectRight,
        /// The tile a row up (↑ or W).
        SelectUp,
        /// The tile a row down (↓ or S).
        SelectDown,
        /// Opens the selected tile (Return or F).
        ActivateSelected,
        /// Opens the selected folder (⇧S).
        OpenSelectedFolder,
        /// The parent folder (⇧W).
        OpenParentFolder,
        /// The previous sibling folder (⇧A).
        OpenPreviousFolder,
        /// The next sibling folder (⇧D).
        OpenNextFolder
    ]
);

/// The gallery's keys, as `hotkeys.ts` binds them. They reach the gallery only while it has
/// focus, so never while the viewer, the reader or another mode shows.
pub(crate) fn bind_keys(cx: &mut App) {
    let context = Some(KEY_CONTEXT);
    cx.bind_keys([
        KeyBinding::new("left", SelectLeft, context),
        KeyBinding::new("a", SelectLeft, context),
        KeyBinding::new("right", SelectRight, context),
        KeyBinding::new("d", SelectRight, context),
        KeyBinding::new("up", SelectUp, context),
        KeyBinding::new("w", SelectUp, context),
        KeyBinding::new("down", SelectDown, context),
        KeyBinding::new("s", SelectDown, context),
        KeyBinding::new("enter", ActivateSelected, context),
        KeyBinding::new("f", ActivateSelected, context),
        KeyBinding::new("shift-s", OpenSelectedFolder, context),
        KeyBinding::new("shift-w", OpenParentFolder, context),
        KeyBinding::new("shift-a", OpenPreviousFolder, context),
        KeyBinding::new("shift-d", OpenNextFolder, context),
    ]);
}

/// What the gallery shows.
#[derive(Clone, Debug, PartialEq)]
pub enum Listing {
    /// No folder yet.
    Empty,
    /// The folder is being read; tiles found so far show.
    Loading,
    /// The folder's tiles, possibly none.
    Listed,
    /// The folder could not be read.
    Failed(SharedString),
}

/// What opening a tile asks for.
#[derive(Clone, Debug, PartialEq)]
pub enum Activation {
    Folder(PathBuf),
    Comic(Arc<Comic>),
    /// The item at this index of the listing's media.
    Media(usize),
}

/// The folder keys (⇧W, ⇧A, ⇧D), for the owner to act on.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FolderStep {
    Parent,
    Previous,
    Next,
}

#[derive(Clone, Debug, PartialEq)]
pub enum GalleryEvent {
    Activated(Activation),
    FolderStep(FolderStep),
    /// The selection moved, for the header's position.
    Selected,
    /// A folder another mode works on, chosen from the offer before View has a folder.
    OpenOffered(PathBuf),
}

pub struct Gallery {
    shell: Entity<ShellState>,
    listing: Listing,
    /// Shown when there are no tiles.
    empty_message: SharedString,
    tiles: Arc<[Tile]>,
    /// The listing's media, in order: what the viewer steps through.
    media: Arc<[MediaEntry]>,
    aspect: TileAspect,
    thumbnail_size: f32,
    thumbnails: Entity<ThumbnailService>,
    images: Entity<TileImages>,
    scroll: UniformListScrollHandle,
    focus: FocusHandle,
    selected: Option<SharedString>,
    /// The rows the list last drew, and whether a thumbnail request for them is due.
    drawn_rows: Range<usize>,
    wanted: Option<(Range<usize>, usize)>,
    request_due: bool,
    columns: usize,
    /// Whether every tile drawn last had its thumbnail on screen.
    drawn_complete: bool,
    autoscroll: Option<Autoscroll>,
    /// What video tiles do under the pointer.
    preview_settings: PreviewSettings,
    /// The video tile under the pointer, and its preview once that plays.
    hover: Option<Hover>,
    probes: VideoProbes,
    /// Frames drawn and thumbnails finished, counted so a quiet spell can be told.
    activity: u64,
    /// Whether a wait for [`SETTLE`] is under way, after which freed memory goes back.
    settling: bool,
    /// The media tile under the pointer, by position, whose hover caption shows.
    captioned: Option<usize>,
    _subscriptions: Vec<Subscription>,
}

/// The video tile under the pointer.
struct Hover {
    path: Arc<Path>,
    /// The tile's place in the grid, to tell when it scrolls away.
    position: usize,
    /// The preview, once the pointer has rested for [`HOVER_DELAY`] and it opened.
    preview: Option<Entity<TilePreview>>,
    /// Waits out [`HOVER_DELAY`]; dropping it cancels the start.
    _start: Option<Task<()>>,
}

/// ffprobe's facts about the videos the grid draws, for their captions.
#[derive(Default)]
struct VideoProbes {
    facts: HashMap<SharedString, VideoProbe>,
    /// Asked for, queued or under way, by item key.
    asked: HashSet<SharedString>,
    queue: VecDeque<MediaEntry>,
    in_flight: usize,
    /// Bumped when the folder changes, so a probe of the last folder's video is dropped.
    generation: u64,
}

impl EventEmitter<GalleryEvent> for Gallery {}

impl Focusable for Gallery {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}

impl Gallery {
    pub fn new(
        shell: &Entity<ShellState>,
        thumbnails_folder: PathBuf,
        cx: &mut Context<Self>,
    ) -> Self {
        let size = crate::thumbnails::request_size(THUMBNAIL_SIZE);
        let thumbnails = cx.new(|cx| ThumbnailService::new(thumbnails_folder, size, cx));
        let images = TileImages::new(0, cx);
        let subscriptions = vec![
            cx.observe(shell, |_, _, cx| cx.notify()),
            cx.observe(&thumbnails, |this, _, cx| {
                this.note_activity(cx);
                cx.notify();
            }),
            cx.observe(&images, |_, _, cx| cx.notify()),
        ];
        Self {
            shell: shell.clone(),
            listing: Listing::Empty,
            empty_message: "Drop a folder or click Open below".into(),
            tiles: Arc::from([]),
            media: Arc::from([]),
            aspect: TileAspect::Wide,
            thumbnail_size: THUMBNAIL_SIZE,
            thumbnails,
            images,
            scroll: UniformListScrollHandle::new(),
            focus: cx.focus_handle(),
            selected: None,
            drawn_rows: 0..0,
            wanted: None,
            request_due: false,
            columns: 1,
            drawn_complete: false,
            autoscroll: None,
            preview_settings: PreviewSettings::default(),
            hover: None,
            probes: VideoProbes::default(),
            activity: 0,
            settling: false,
            captioned: None,
            _subscriptions: subscriptions,
        }
    }

    /// Notes a frame drawn or a thumbnail finished. Once the gallery has been still for
    /// [`SETTLE`], the memory the scroll's decodes and the thumbnail workers freed goes back to
    /// the system: macOS's allocator keeps freed regions dirty for reuse, and they would stay in
    /// View's footprint at rest.
    fn note_activity(&mut self, cx: &mut Context<Self>) {
        self.activity += 1;
        if self.settling {
            return;
        }
        self.settling = true;
        cx.spawn(async move |this, cx| {
            let mut seen = None;
            loop {
                let Ok(now) = this.update(cx, |this, _| this.activity) else {
                    return;
                };
                if seen == Some(now) {
                    break;
                }
                seen = Some(now);
                cx.background_executor().timer(SETTLE).await;
            }
            this.update(cx, |this, _| this.settling = false).ok();
            cx.background_spawn(async { oriel_runtime::release_free_memory() })
                .await;
        })
        .detach();
    }

    /// The pointer came onto (`hovered`) or left the media tile at `position`, as its caption
    /// sees it ([`CaptionProbe`]).
    fn caption_hovered(&mut self, position: usize, hovered: bool, cx: &mut Context<Self>) {
        let captioned = if hovered {
            Some(position)
        } else if self.captioned == Some(position) {
            None
        } else {
            return;
        };
        if self.captioned != captioned {
            self.captioned = captioned;
            cx.notify();
        }
    }

    /// What video tiles do under the pointer, from View's settings. A preview playing stops when
    /// they change, and the next hover plays as they now say.
    pub fn set_preview_settings(&mut self, settings: PreviewSettings, cx: &mut Context<Self>) {
        if self.preview_settings != settings {
            self.preview_settings = settings;
            self.stop_preview(cx);
            cx.notify();
        }
    }

    pub fn preview_settings(&self) -> PreviewSettings {
        self.preview_settings
    }

    /// The hover preview playing, and the path of its video.
    pub fn preview(&self) -> Option<(&Arc<Path>, &Entity<TilePreview>)> {
        let hover = self.hover.as_ref()?;
        Some((&hover.path, hover.preview.as_ref()?))
    }

    /// The video tile under the pointer, whether or not its preview plays yet.
    pub fn hovered_video(&self) -> Option<&Arc<Path>> {
        self.hover.as_ref().map(|hover| &hover.path)
    }

    /// Stops the hover preview: the viewer or the reader opened over the gallery, or View is
    /// not on screen.
    pub fn stop_preview(&mut self, cx: &mut Context<Self>) {
        if self
            .hover
            .take()
            .is_some_and(|hover| hover.preview.is_some())
        {
            cx.notify();
        }
    }

    /// ffprobe's facts about a video tile drawn, once read.
    pub fn video_probe(&self, entry: &MediaEntry) -> Option<&VideoProbe> {
        self.probes.facts.get(entry.key())
    }

    /// A new folder: back to the top, and its thumbnails, probes and preview start over.
    pub fn reset_folder(&mut self, cx: &mut Context<Self>) {
        self.scroll_to_top(cx);
        self.thumbnails
            .update(cx, |thumbnails, cx| thumbnails.reset(cx));
        let generation = self.probes.generation + 1;
        self.probes = VideoProbes {
            generation,
            ..VideoProbes::default()
        };
        self.stop_preview(cx);
    }

    /// The pointer came onto (`hovered`) or left the video tile at `position`. Its preview starts
    /// once the pointer has rested there for [`HOVER_DELAY`].
    fn hover_video(
        &mut self,
        path: Arc<Path>,
        position: usize,
        hovered: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let current = self.hover.as_ref().is_some_and(|hover| hover.path == path);
        if !hovered {
            if current {
                self.stop_preview(cx);
            }
            return;
        }
        // A video under the pointer may play next, in the tile or the viewer: libmpv's engine
        // starts now, off this thread, rather than when it does.
        oriel_media::mpv::prewarm();
        if current || !self.preview_settings.autoplay {
            return;
        }
        let metrics = self.metrics(window, cx);
        let max_side =
            (metrics.card_width().max(metrics.card_height()) * window.scale_factor()).ceil() as u32;
        let settings = self.preview_settings;
        let start = {
            let path = path.clone();
            cx.spawn(async move |this, cx| {
                cx.background_executor().timer(HOVER_DELAY).await;
                this.update(cx, |this, cx| {
                    let Some(hover) = this.hover.as_mut().filter(|hover| hover.path == path) else {
                        return;
                    };
                    hover._start = None;
                    if let Some(preview) = TilePreview::start(&path, settings, max_side) {
                        hover.preview = Some(cx.new(|_| preview));
                        cx.notify();
                    }
                })
                .ok();
            })
        };
        let had_preview = self
            .hover
            .as_ref()
            .is_some_and(|hover| hover.preview.is_some());
        self.hover = Some(Hover {
            path,
            position,
            preview: None,
            _start: Some(start),
        });
        if had_preview {
            cx.notify();
        }
    }

    /// Asks ffprobe about the videos among `entries` not yet asked about, and forgets the queued
    /// ones no longer drawn, so a fast scroll does not leave a long queue behind it.
    fn want_probes(&mut self, entries: &[MediaEntry], cx: &mut Context<Self>) {
        let wanted: HashSet<&SharedString> = entries
            .iter()
            .filter(|entry| entry.is_video())
            .map(MediaEntry::key)
            .collect();
        let probes = &mut self.probes;
        probes.queue.retain(|entry| {
            let keep = wanted.contains(entry.key());
            if !keep {
                probes.asked.remove(entry.key());
            }
            keep
        });
        for entry in entries.iter().filter(|entry| entry.is_video()) {
            if !probes.facts.contains_key(entry.key()) && probes.asked.insert(entry.key().clone()) {
                probes.queue.push_back(entry.clone());
            }
        }
        self.pump_probes(cx);
    }

    fn pump_probes(&mut self, cx: &mut Context<Self>) {
        while self.probes.in_flight < PROBES_AT_ONCE {
            let Some(entry) = self.probes.queue.pop_front() else {
                return;
            };
            self.probes.in_flight += 1;
            let generation = self.probes.generation;
            cx.spawn(async move |this, cx| {
                let key = entry.key().clone();
                let probe = cx
                    .background_spawn(async move {
                        ViewMediaTools::shared().probe_video(
                            entry.path(),
                            entry.modified_ms(),
                            entry.size(),
                        )
                    })
                    .await;
                this.update(cx, |this, cx| {
                    if this.probes.generation != generation {
                        return;
                    }
                    this.probes.in_flight -= 1;
                    if let Some(probe) = probe {
                        this.probes.facts.insert(key, probe);
                        cx.notify();
                    }
                    this.pump_probes(cx);
                })
                .ok();
            })
            .detach();
        }
    }

    pub fn listing(&self) -> &Listing {
        &self.listing
    }

    pub fn tiles(&self) -> &Arc<[Tile]> {
        &self.tiles
    }

    /// The listing's media in order, which the viewer steps through.
    pub fn media(&self) -> &Arc<[MediaEntry]> {
        &self.media
    }

    /// The selected tile's key.
    pub fn selected_key(&self) -> Option<&SharedString> {
        self.selected.as_ref()
    }

    /// The selected tile's position, for the header's `3/40`.
    pub fn selected_index(&self) -> Option<usize> {
        let key = self.selected.as_ref()?;
        self.tiles.iter().position(|tile| tile.key() == key)
    }

    /// The selected media item's index in [`Self::media`], when a media tile is selected.
    pub fn selected(&self) -> Option<usize> {
        match self.tiles.get(self.selected_index()?)? {
            Tile::Media { media_index, .. } => Some(*media_index),
            _ => None,
        }
    }

    pub fn thumbnails(&self) -> &Entity<ThumbnailService> {
        &self.thumbnails
    }

    pub fn scroll_handle(&self) -> &UniformListScrollHandle {
        &self.scroll
    }

    pub fn thumbnail_size(&self) -> f32 {
        self.thumbnail_size
    }

    /// The rows the list drew last frame.
    pub fn drawn_rows(&self) -> Range<usize> {
        self.drawn_rows.clone()
    }

    /// Whether the last frame drew every visible tile with its thumbnail (or with nothing to
    /// draw for a tile that has none).
    pub fn is_drawn_complete(&self) -> bool {
        self.drawn_complete
    }

    /// Shows `tiles`. The selection stays on the same tile when it is still listed, moves to
    /// `prefer` when that is listed (a folder stepped up out of), and otherwise to the first
    /// tile, as `useBrowserSelection` keeps it.
    pub fn set_tiles(
        &mut self,
        tiles: Arc<[Tile]>,
        media: Arc<[MediaEntry]>,
        aspect: TileAspect,
        prefer: Option<SharedString>,
        cx: &mut Context<Self>,
    ) {
        let has = |key: &SharedString| tiles.iter().any(|tile| tile.key() == key);
        let selected = prefer
            .filter(|key| has(key))
            .or_else(|| self.selected.clone().filter(|key| has(key)))
            .or_else(|| tiles.first().map(|tile| tile.key().clone()));
        if selected != self.selected {
            self.selected = selected;
            cx.emit(GalleryEvent::Selected);
        }
        self.tiles = tiles;
        self.media = media;
        self.aspect = aspect;
        self.wanted = None;
        // The next paint finds the tile under the pointer in the new listing.
        self.captioned = None;
        // A preview follows its tile to wherever the new listing has it, or stops.
        let moved = self.hover.as_ref().map(|hover| {
            self.tiles.iter().position(
                |tile| matches!(tile, Tile::Media { media, .. } if *media.path() == hover.path),
            )
        });
        match moved {
            Some(Some(position)) => {
                if let Some(hover) = &mut self.hover {
                    hover.position = position;
                }
            }
            Some(None) => self.stop_preview(cx),
            None => {}
        }
        cx.notify();
    }

    /// What shows without tiles, and whether a folder is being read.
    pub fn set_listing(
        &mut self,
        listing: Listing,
        empty_message: SharedString,
        cx: &mut Context<Self>,
    ) {
        if self.listing != listing || self.empty_message != empty_message {
            self.listing = listing;
            self.empty_message = empty_message;
            cx.notify();
        }
    }

    /// Tiles of about `size` pixels, with thumbnails made at twice that.
    pub fn set_thumbnail_size(&mut self, size: f32, cx: &mut Context<Self>) {
        if self.thumbnail_size != size {
            self.thumbnail_size = size;
            let request = crate::thumbnails::request_size(size);
            self.thumbnails
                .update(cx, |thumbnails, cx| thumbnails.set_size(request, cx));
            self.wanted = None;
            cx.notify();
        }
    }

    /// Back to the top, as a new folder opens.
    pub fn scroll_to_top(&mut self, cx: &mut Context<Self>) {
        self.scroll.scroll_to_item(0, ScrollStrategy::Top);
        cx.notify();
    }

    /// Scrolls from where the grid is to its end at `speed` pixels a second, measured in wall
    /// time, drawing every frame: Phase 0's scroll measurement, since this Mac takes no
    /// scripted input.
    pub fn start_autoscroll(&mut self, speed: f32, cx: &mut Context<Self>) {
        self.autoscroll = Some(Autoscroll {
            speed,
            started: None,
            frames: Vec::new(),
            finished: false,
        });
        cx.notify();
    }

    /// The frames an autoscroll drew, once it has reached the end.
    pub fn autoscroll_frames(&self) -> Option<&[Instant]> {
        self.autoscroll
            .as_ref()
            .filter(|run| run.finished)
            .map(|run| run.frames.as_slice())
    }

    fn advance_autoscroll(&mut self, window: &mut Window) {
        let Some(run) = self.autoscroll.as_mut().filter(|run| !run.finished) else {
            return;
        };
        let now = Instant::now();
        let started = *run.started.get_or_insert(now);
        run.frames.push(now);
        let handle = self.scroll.0.borrow().base_handle.clone();
        // The furthest the list scrolls, from its last layout; nothing until it has one.
        let max = f32::from(handle.max_offset().y);
        let target = run.speed * now.duration_since(started).as_secs_f32();
        handle.set_offset(point(px(0.), px(-target.min(max))));
        run.finished = max > 0. && target >= max;
        // One more frame after the last step too, so whoever waits on the run sees it end.
        window.request_animation_frame();
    }

    /// Selects media item `ix` and scrolls its row into view if it is not, as after the viewer
    /// closes on it; a row already in view does not move.
    pub fn reveal(&mut self, ix: usize, cx: &mut Context<Self>) {
        let Some(position) = self
            .tiles
            .iter()
            .position(|tile| matches!(tile, Tile::Media { media_index, .. } if *media_index == ix))
        else {
            return;
        };
        self.select_position(position, cx);
    }

    /// Selects the tile with `key`, if it is listed.
    pub fn select_key(&mut self, key: &str, cx: &mut Context<Self>) {
        if let Some(position) = self
            .tiles
            .iter()
            .position(|tile| tile.key().as_ref() == key)
        {
            self.select_position(position, cx);
        }
    }

    fn select_position(&mut self, position: usize, cx: &mut Context<Self>) {
        let Some(tile) = self.tiles.get(position) else {
            return;
        };
        if self.selected.as_ref() != Some(tile.key()) {
            self.selected = Some(tile.key().clone());
            cx.emit(GalleryEvent::Selected);
        }
        self.scroll
            .scroll_to_item(position / self.columns.max(1), ScrollStrategy::Nearest);
        cx.notify();
    }

    /// Moves the selection by `delta` tiles, clamped to the ends.
    fn move_selection(&mut self, delta: isize, cx: &mut Context<Self>) {
        if self.tiles.is_empty() {
            return;
        }
        let current = self.selected_index().unwrap_or(0) as isize;
        let next = (current + delta).clamp(0, self.tiles.len() as isize - 1) as usize;
        self.select_position(next, cx);
    }

    fn activate(&mut self, position: usize, cx: &mut Context<Self>) {
        let Some(tile) = self.tiles.get(position) else {
            return;
        };
        let activation = match tile {
            Tile::Folder { path, .. } => Activation::Folder(path.to_path_buf()),
            Tile::Comic { comic, .. } => Activation::Comic(comic.clone()),
            Tile::Media { media_index, .. } => Activation::Media(*media_index),
        };
        cx.emit(GalleryEvent::Activated(activation));
    }

    fn click_tile(
        &mut self,
        position: usize,
        event: &ClickEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.focus.focus(window, cx);
        if let Some(tile) = self.tiles.get(position)
            && self.selected.as_ref() != Some(tile.key())
        {
            self.selected = Some(tile.key().clone());
            cx.emit(GalleryEvent::Selected);
            cx.notify();
        }
        if event.click_count() >= 2 {
            self.activate(position, cx);
        }
    }

    /// The grid for the window as it is now. The gallery fills the mode's content, which is the
    /// window less the sidebar, full or the rail, so its width is known before layout.
    fn metrics(&self, window: &Window, cx: &Context<Self>) -> GridMetrics {
        let sidebar = if self.shell.read(cx).rail() {
            RAIL_WIDTH
        } else {
            SIDEBAR_WIDTH
        };
        let width = f32::from(window.viewport_size().width) - sidebar;
        GridMetrics::new(width, self.thumbnail_size, self.aspect)
    }

    /// The list drew `rows`: ask for their thumbnails once the frame is done. The list also
    /// draws its first row to measure it, before the visible ones, so the request reads
    /// whichever rows were drawn last.
    fn note_drawn(&mut self, rows: Range<usize>, window: &Window, cx: &mut Context<Self>) {
        self.drawn_rows = rows;
        if !self.request_due {
            self.request_due = true;
            cx.defer_in(window, |this, _, cx| this.request_thumbnails(cx));
        }
    }

    fn request_thumbnails(&mut self, cx: &mut Context<Self>) {
        self.request_due = false;
        let rows = self.drawn_rows.clone();
        let columns = self.columns.max(1);
        // A tile scrolled out of the drawn rows has no hover to lose, so its preview stops here.
        if let Some(hover) = &self.hover
            && !(rows.start * columns..rows.end * columns).contains(&hover.position)
        {
            self.stop_preview(cx);
        }
        let wanted = (rows.clone(), self.tiles.len());
        if self.wanted.as_ref() == Some(&wanted) {
            return;
        }
        self.wanted = Some(wanted);
        let len = self.tiles.len();
        let row_count = len.div_ceil(columns);
        let nearby =
            rows.start.saturating_sub(OVERSCAN_ROWS)..(rows.end + OVERSCAN_ROWS).min(row_count);
        let visible = (rows.start * columns).min(len)..(rows.end * columns).min(len);
        let nearby = (nearby.start * columns).min(len)..(nearby.end * columns).min(len);
        let sources = |range: Range<usize>| -> Vec<MediaEntry> {
            self.tiles[range]
                .iter()
                .filter_map(|tile| tile.thumbnail_source().cloned())
                .collect()
        };
        let (visible_sources, nearby_sources) = (sources(visible.clone()), sources(nearby.clone()));
        // A video in sight may play soon, in its tile or the viewer: an engine primed now has
        // paid the first open's costs by then. Nothing is primed while no video is in sight.
        if self.tiles[visible.clone()]
            .iter()
            .any(|tile| matches!(tile, Tile::Media { media, .. } if media.is_video()))
        {
            oriel_media::mpv::prime();
        }
        // Room for the drawn tiles, the overscan, and a screen's worth more for scrolling back.
        let capacity = nearby.len() + visible.len() * 2;
        self.images
            .update(cx, |images, _| images.set_capacity(capacity));
        self.thumbnails.update(cx, |thumbnails, cx| {
            thumbnails.want(&visible_sources, &nearby_sources, cx)
        });
        let nearby_media: Vec<MediaEntry> = self.tiles[nearby]
            .iter()
            .filter_map(|tile| match tile {
                Tile::Media { media, .. } => Some(media.clone()),
                _ => None,
            })
            .collect();
        self.want_probes(&nearby_media, cx);
    }

    fn render_rows(
        &mut self,
        rows: Range<usize>,
        metrics: GridMetrics,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Vec<gpui_kit::AnyElement> {
        self.note_drawn(rows.clone(), window, cx);
        self.note_activity(cx);
        let mut complete = true;
        let mut elements = Vec::with_capacity(rows.len());
        for row in rows {
            let items = metrics.items_in(row..row + 1, self.tiles.len());
            let mut tiles = Vec::with_capacity(items.len());
            let probe = CaptionProbe {
                gallery: cx.entity().downgrade(),
                first: items.start,
                media: self.tiles[items.clone()]
                    .iter()
                    .map(|tile| matches!(tile, Tile::Media { .. }))
                    .collect(),
                captioned: self.captioned,
                metrics,
            };
            for position in items {
                let (tile, drawn) = self.render_tile(position, metrics, window, cx);
                complete &= drawn;
                tiles.push(tile);
            }
            elements.push(
                div()
                    .relative()
                    .flex()
                    .flex_row()
                    .gap(px(metrics::GRID_GAP))
                    .w(px(metrics.grid_width()))
                    .h(px(metrics.row_stride()))
                    .mx_auto()
                    .children(tiles)
                    .child(probe.element())
                    .into_any_element(),
            );
        }
        self.drawn_complete = complete;
        elements
    }

    /// One tile, and whether its thumbnail is drawn this frame (or it has none to draw).
    fn render_tile(
        &self,
        position: usize,
        metrics: GridMetrics,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> (gpui_kit::AnyElement, bool) {
        let tile = &self.tiles[position];
        let thumbnail = tile
            .thumbnail_source()
            .map(|source| self.thumbnails.read(cx).thumbnail(source));
        let (picture, drawn) = match thumbnail {
            Some(Thumbnail::Ready(path)) => {
                let picture = self
                    .images
                    .update(cx, |images, cx| images.picture(&path, window, cx))
                    .map(|picture| (path, picture));
                let drawn = picture.is_some();
                (picture, drawn)
            }
            Some(Thumbnail::Unavailable) | None => (None, true),
            Some(Thumbnail::Pending) => (None, false),
        };
        let selected = self.selected.as_ref() == Some(tile.key());
        let theme = cx.theme();
        let id = match tile {
            Tile::Media { media, .. } => ElementId::Path(media.path().clone()),
            _ => ElementId::Name(tile.key().clone()),
        };

        let card = div()
            .id(id)
            .role(Role::Button)
            .test_support()
            .aria_label(tile.name().clone())
            .relative()
            .flex_shrink_0()
            .w(px(metrics.card_width()))
            .h(px(metrics.card_height()))
            .rounded(theme.radius_lg)
            .overflow_hidden()
            .on_click(cx.listener(move |this, event: &ClickEvent, window, cx| {
                this.click_tile(position, event, window, cx);
            }));

        let card = match tile {
            Tile::Folder { name, .. } => card
                .flex()
                .flex_col()
                .justify_between()
                .p_4()
                .bg(theme.background)
                .border_1()
                .border_color(theme.border)
                .child(
                    div()
                        .flex()
                        .flex_row()
                        .items_start()
                        .justify_between()
                        .child(
                            Icon::new(IconName::Folder)
                                .size(px(36.))
                                .text_color(gpui_kit::rgb(0xf59e0b)),
                        )
                        .child(
                            div()
                                .px_2()
                                .rounded_full()
                                .bg(theme.muted)
                                .text_xs()
                                .text_color(theme.muted_foreground)
                                .child("Folder"),
                        ),
                )
                .child(
                    div()
                        .text_size(px(13.))
                        .font_weight(gpui_kit::FontWeight::SEMIBOLD)
                        .line_clamp(2)
                        .child(name.clone()),
                ),
            Tile::Comic { comic, .. } => card
                .bg(theme.muted)
                .when_some(picture, |card, (path, picture)| {
                    card.child(self.picture(path, picture))
                })
                .child(caption(
                    comic.name().clone(),
                    format!("{} pages", comic.pages().len()).into(),
                )),
            Tile::Media { media, .. } => {
                let preview = self
                    .hover
                    .as_ref()
                    .filter(|hover| hover.path == *media.path())
                    .and_then(|hover| hover.preview.clone());
                let hover_plays = media.is_video() && self.preview_settings.autoplay;
                let path = media.path().clone();
                let captioned = self.captioned == Some(position);
                card.bg(theme.muted)
                    .when_some(picture, |card, (path, picture)| {
                        card.child(self.picture(path, picture))
                    })
                    .when_some(preview, |card, preview| card.child(preview))
                    .when(captioned, |card| {
                        card.child(hover_caption(media, self.probes.facts.get(media.key())))
                    })
                    .when(media.is_video(), |card| card.child(video_badge()))
                    .when(hover_plays, |card| {
                        card.on_hover(cx.listener(move |this, hovered: &bool, window, cx| {
                            this.hover_video(path.clone(), position, *hovered, window, cx);
                        }))
                    })
            }
        };
        let card = card.when(selected, |card| card.border_2().border_color(theme.ring));
        (card.into_any_element(), drawn)
    }

    /// A tile's thumbnail, from the gallery's own bounded cache ([`images`]) rather than
    /// `img()`'s: an `img()` without a cache of its own keeps its image in the App's asset cache
    /// for good, which held 11 GB once 20,000 tiles had scrolled by.
    fn picture(&self, path: Arc<Path>, picture: TilePicture) -> impl IntoElement {
        tile_picture(&self.images, path, picture)
    }
}

/// A run of [`Gallery::start_autoscroll`].
struct Autoscroll {
    speed: f32,
    started: Option<Instant>,
    frames: Vec<Instant>,
    finished: bool,
}

/// The badge on a video's tile. It sits on the picture rather than on a themed surface, so it is
/// white on translucent black in either theme, as Electron Oriel's is.
fn video_badge() -> impl IntoElement {
    div()
        .absolute()
        .top_2()
        .right_2()
        .px_2()
        .rounded_full()
        .bg(gpui_kit::black().opacity(0.5))
        .text_color(gpui_kit::white())
        .text_xs()
        .font_weight(gpui_kit::FontWeight::MEDIUM)
        .child("VIDEO")
}

/// Finds the media tile under the pointer in one row, for its hover caption: what `group_hover`
/// on each tile told before, with the same hit test on each tile's bounds, at each paint and each
/// mouse move. Only the tile it finds is given a caption to lay out, rather than every tile drawn
/// having one hidden: laying out and shaping those was a fifth of a scroll's frame. The caption
/// shows one frame after the pointer reaches the tile, as the change is drawn in the next frame.
struct CaptionProbe {
    gallery: WeakEntity<Gallery>,
    /// The position of the row's first tile.
    first: usize,
    /// Which of the row's tiles are media, the ones with a caption.
    media: Vec<bool>,
    /// The tile whose caption the row was drawn with.
    captioned: Option<usize>,
    metrics: GridMetrics,
}

impl CaptionProbe {
    /// The row's tiles' hitboxes, over the row: each tile's border box, where the flex row puts
    /// it.
    fn element(self) -> impl IntoElement {
        let metrics = self.metrics;
        let count = self.media.len();
        canvas(
            move |bounds, window, _| {
                let stride = metrics.card_width() + metrics::GRID_GAP;
                let tile = size(px(metrics.card_width()), px(metrics.card_height()));
                (0..count)
                    .map(|ix| {
                        let origin =
                            point(bounds.origin.x + px(ix as f32 * stride), bounds.origin.y);
                        window.insert_hitbox(Bounds::new(origin, tile), HitboxBehavior::Normal)
                    })
                    .collect::<Vec<Hitbox>>()
            },
            move |_, hitboxes, window, cx| {
                let probe = Rc::new((self, hitboxes));
                probe.0.check(&probe.1, window, cx);
                window.on_mouse_event(move |_: &MouseMoveEvent, phase, window, cx| {
                    if phase == DispatchPhase::Bubble {
                        probe.0.check(&probe.1, window, cx);
                    }
                });
            },
        )
        .absolute()
        .inset_0()
    }

    /// Tells the gallery of each media tile whose hover differs from how the row was drawn.
    fn check(&self, hitboxes: &[Hitbox], window: &Window, cx: &mut App) {
        for (ix, hitbox) in hitboxes.iter().enumerate() {
            let position = self.first + ix;
            let hovered = hitbox.is_hovered(window);
            if !self.media[ix] || hovered == (self.captioned == Some(position)) {
                continue;
            }
            let gallery = self.gallery.clone();
            cx.defer(move |cx| {
                gallery
                    .update(cx, |gallery, cx| {
                        gallery.caption_hovered(position, hovered, cx)
                    })
                    .ok();
            });
        }
    }
}

/// A media tile's name and size, and a video's picture size once known, over the bottom of the
/// picture while the pointer is on the tile (`MediaTile`'s caption).
fn hover_caption(media: &MediaEntry, probe: Option<&VideoProbe>) -> impl IntoElement {
    let mut detail = format_bytes(media.size() as f64);
    if let Some((width, height)) = probe.and_then(|probe| probe.width.zip(probe.height)) {
        detail.push_str(&format!(" · {width}×{height}"));
    }
    div()
        .id(CAPTION_ID)
        .test_support()
        .absolute()
        .inset_0()
        .flex()
        .flex_col()
        .justify_end()
        .px_3()
        .pb_3()
        .bg(linear_gradient(
            0.,
            linear_color_stop(gpui_kit::black().opacity(0.7), 0.),
            linear_color_stop(gpui_kit::black().opacity(0.), 0.5),
        ))
        .child(
            div()
                .truncate()
                .text_sm()
                .font_weight(gpui_kit::FontWeight::SEMIBOLD)
                .text_color(gpui_kit::white())
                .child(media.name().clone()),
        )
        .child(
            div()
                .text_size(px(11.))
                .text_color(gpui_kit::white().opacity(0.7))
                .child(detail),
        )
}

/// A comic's name and page count over the bottom of its cover, on a scrim.
fn caption(title: SharedString, detail: SharedString) -> impl IntoElement {
    div()
        .absolute()
        .inset_0()
        .flex()
        .flex_col()
        .justify_end()
        .px_3()
        .pb_3()
        .bg(linear_gradient(
            0.,
            linear_color_stop(gpui_kit::black().opacity(0.75), 0.),
            linear_color_stop(gpui_kit::black().opacity(0.), 0.6),
        ))
        .child(
            div()
                .text_sm()
                .font_weight(gpui_kit::FontWeight::SEMIBOLD)
                .text_color(gpui_kit::white())
                .line_clamp(2)
                .child(title),
        )
        .child(
            div()
                .text_size(px(11.))
                .text_color(gpui_kit::white().opacity(0.75))
                .child(detail),
        )
}

impl Render for Gallery {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = cx.theme();
        let message = match &self.listing {
            Listing::Failed(message) => Some(message.clone()),
            _ if self.tiles.is_empty() => Some(self.empty_message.clone()),
            _ => None,
        };
        let base = div()
            .id(GALLERY_ID)
            .test_support()
            .key_context(KEY_CONTEXT)
            .track_focus(&self.focus)
            .on_action(cx.listener(|this, _: &SelectLeft, _, cx| this.move_selection(-1, cx)))
            .on_action(cx.listener(|this, _: &SelectRight, _, cx| this.move_selection(1, cx)))
            .on_action(cx.listener(|this, _: &SelectUp, _, cx| {
                let columns = this.columns.max(1) as isize;
                this.move_selection(-columns, cx);
            }))
            .on_action(cx.listener(|this, _: &SelectDown, _, cx| {
                let columns = this.columns.max(1) as isize;
                this.move_selection(columns, cx);
            }))
            .on_action(cx.listener(|this, _: &ActivateSelected, _, cx| {
                if let Some(position) = this.selected_index() {
                    this.activate(position, cx);
                }
            }))
            .on_action(cx.listener(|this, _: &OpenSelectedFolder, _, cx| {
                if let Some(position) = this.selected_index()
                    && matches!(this.tiles.get(position), Some(Tile::Folder { .. }))
                {
                    this.activate(position, cx);
                }
            }))
            .on_action(cx.listener(|_, _: &OpenParentFolder, _, cx| {
                cx.emit(GalleryEvent::FolderStep(FolderStep::Parent));
            }))
            .on_action(cx.listener(|_, _: &OpenPreviousFolder, _, cx| {
                cx.emit(GalleryEvent::FolderStep(FolderStep::Previous));
            }))
            .on_action(cx.listener(|_, _: &OpenNextFolder, _, cx| {
                cx.emit(GalleryEvent::FolderStep(FolderStep::Next));
            }))
            .flex_1()
            .min_h_0()
            .size_full();

        if let Some(message) = message {
            self.drawn_complete = true;
            // Before View has a folder, the folders Tidy and Sync work on are offered.
            let offered = (self.listing == Listing::Empty)
                .then(|| self.shell.read(cx).offered_to(ModeId::View))
                .filter(|folders| !folders.is_empty())
                .map(|folders| {
                    let gallery = cx.entity().downgrade();
                    OfferedFolders::new("view-offered-folders", folders)
                        .title("Or open one you already use")
                        .on_choose(move |folder, _, cx| {
                            let folder = folder.path().to_path_buf();
                            gallery
                                .update(cx, |_, cx| cx.emit(GalleryEvent::OpenOffered(folder)))
                                .ok();
                        })
                });
            return base
                .flex()
                .flex_col()
                .items_center()
                .justify_center()
                .text_color(theme.muted_foreground)
                .child(
                    div()
                        .id("gallery-message")
                        .role(Role::Status)
                        .test_support()
                        .aria_label(message.clone())
                        .px_6()
                        .py_4()
                        .rounded(theme.radius_lg)
                        .bg(theme.background)
                        .border_1()
                        .border_color(theme.border)
                        .text_size(px(13.))
                        .child(message),
                )
                .children(offered)
                .into_any_element();
        }

        self.advance_autoscroll(window);
        let metrics = self.metrics(window, cx);
        self.columns = metrics.columns();
        let rows = metrics.row_count(self.tiles.len());
        base.child(
            uniform_list(
                "gallery-rows",
                rows,
                cx.processor(move |this, rows: Range<usize>, window, cx| {
                    this.render_rows(rows, metrics, window, cx)
                }),
            )
            .track_scroll(&self.scroll)
            .size_full()
            .pt(px(metrics::TOP_INSET))
            // Room under the last row for the floating toolbar (`pb-28`).
            .pb(px(112.))
            .px(px(metrics::HORIZONTAL_INSET)),
        )
        .into_any_element()
    }
}

/// A folder's last component, as the gallery names it.
pub fn display_name(folder: &Path) -> String {
    folder
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| folder.display().to_string())
}
