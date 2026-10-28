//! The gallery: a folder's media as a virtual grid, `uniform_list` rows of tiles sized as
//! Electron Oriel sizes them, each tile its thumbnail once made and a placeholder until then.
//!
//! The gallery owns the listing, the grid's scroll position and the selection. It says which
//! rows it drew, and the thumbnail service makes those first. Opening an item is the owner's:
//! a double-click emits [`GalleryEvent::Activated`].

mod images;
pub mod metrics;

use std::ops::Range;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Instant;

use gpui_kit::component::ActiveTheme as _;
use gpui_kit::{
    AppContext as _, ClickEvent, Context, ElementId, Entity, EventEmitter, InteractiveElement as _,
    IntoElement, ObjectFit, ParentElement as _, Render, Resource, Role, ScrollStrategy,
    SharedString, StatefulInteractiveElement as _, Styled as _, StyledImage as _, Subscription,
    Task, TestSupportExt as _, UniformListScrollHandle, Window, div, img, point,
    prelude::FluentBuilder as _, px, uniform_list,
};
use oriel_ui::ShellState;
use oriel_ui::layout::{RAIL_WIDTH, SIDEBAR_WIDTH};

use crate::listing::{self, MediaEntry};
use crate::thumbnails::{THUMBNAIL_SIZE, Thumbnail, ThumbnailService};
use images::TileImages;
use metrics::{GridMetrics, OVERSCAN_ROWS, TileAspect};

/// The id of the grid's scroll region.
pub const GALLERY_ID: &str = "gallery";

/// What the gallery shows.
#[derive(Clone, Debug, PartialEq)]
pub enum Listing {
    /// No folder yet.
    Empty,
    /// The folder is being read.
    Loading,
    /// The folder's media, possibly none.
    Listed,
    /// The folder could not be read.
    Failed(SharedString),
}

#[derive(Clone, Debug, PartialEq)]
pub enum GalleryEvent {
    /// A listing finished.
    Listed,
    /// An item was double-clicked.
    Activated(usize),
}

pub struct Gallery {
    shell: Entity<ShellState>,
    folder: Option<Arc<Path>>,
    listing: Listing,
    entries: Arc<[MediaEntry]>,
    thumbnails: Entity<ThumbnailService>,
    images: Entity<TileImages>,
    scroll: UniformListScrollHandle,
    selected: Option<usize>,
    /// The rows the list last drew, and whether a thumbnail request for them is due.
    drawn_rows: Range<usize>,
    wanted_rows: Option<Range<usize>>,
    request_due: bool,
    columns: usize,
    /// Whether every tile drawn last had its thumbnail on screen.
    drawn_complete: bool,
    autoscroll: Option<Autoscroll>,
    _listing: Option<Task<()>>,
    _subscriptions: Vec<Subscription>,
}

impl EventEmitter<GalleryEvent> for Gallery {}

impl Gallery {
    pub fn new(
        shell: &Entity<ShellState>,
        thumbnails_folder: PathBuf,
        cx: &mut Context<Self>,
    ) -> Self {
        let size = crate::thumbnails::request_size(THUMBNAIL_SIZE);
        let thumbnails = cx.new(|_| ThumbnailService::new(thumbnails_folder, size));
        let images = TileImages::new(0, cx);
        let subscriptions = vec![
            cx.observe(shell, |_, _, cx| cx.notify()),
            cx.observe(&thumbnails, |_, _, cx| cx.notify()),
        ];
        Self {
            shell: shell.clone(),
            folder: None,
            listing: Listing::Empty,
            entries: Arc::from([]),
            thumbnails,
            images,
            scroll: UniformListScrollHandle::new(),
            selected: None,
            drawn_rows: 0..0,
            wanted_rows: None,
            request_due: false,
            columns: 1,
            drawn_complete: false,
            autoscroll: None,
            _listing: None,
            _subscriptions: subscriptions,
        }
    }

    pub fn folder(&self) -> Option<&Path> {
        self.folder.as_deref()
    }

    pub fn listing(&self) -> &Listing {
        &self.listing
    }

    pub fn entries(&self) -> &Arc<[MediaEntry]> {
        &self.entries
    }

    pub fn selected(&self) -> Option<usize> {
        self.selected
    }

    pub fn thumbnails(&self) -> &Entity<ThumbnailService> {
        &self.thumbnails
    }

    pub fn scroll_handle(&self) -> &UniformListScrollHandle {
        &self.scroll
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

    /// Lists `folder` recursively on the background executor, then shows it from the top.
    pub fn open(&mut self, folder: PathBuf, cx: &mut Context<Self>) {
        let folder: Arc<Path> = folder.into();
        self.folder = Some(folder.clone());
        self.listing = Listing::Loading;
        self.selected = None;
        cx.notify();

        let task = cx.spawn(async move |this, cx| {
            let read = folder.clone();
            let listed = cx
                .background_spawn(async move { listing::list_media(&read) })
                .await;
            this.update(cx, |this, cx| {
                if this.folder.as_ref() != Some(&folder) {
                    return;
                }
                match listed {
                    Ok(entries) => {
                        this.entries = entries.into();
                        this.listing = Listing::Listed;
                    }
                    Err(error) => {
                        this.entries = Arc::from([]);
                        this.listing = Listing::Failed(
                            format!("{} could not be read: {error}", folder.display()).into(),
                        );
                    }
                }
                let entries = this.entries.clone();
                this.thumbnails
                    .update(cx, |thumbnails, cx| thumbnails.set_entries(entries, cx));
                this.wanted_rows = None;
                this.scroll.scroll_to_item(0, ScrollStrategy::Top);
                cx.emit(GalleryEvent::Listed);
                cx.notify();
            })
            .ok();
        });
        self._listing = Some(task);
    }

    /// Selects `ix` and scrolls its row into view if it is not, as after the viewer closes on
    /// it; a row already in view does not move.
    pub fn reveal(&mut self, ix: usize, cx: &mut Context<Self>) {
        if ix >= self.entries.len() {
            return;
        }
        self.selected = Some(ix);
        self.scroll
            .scroll_to_item(ix / self.columns.max(1), ScrollStrategy::Nearest);
        cx.notify();
    }

    fn click_tile(&mut self, ix: usize, event: &ClickEvent, cx: &mut Context<Self>) {
        if self.selected != Some(ix) {
            self.selected = Some(ix);
            cx.notify();
        }
        if event.click_count() >= 2 {
            cx.emit(GalleryEvent::Activated(ix));
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
        GridMetrics::new(width, THUMBNAIL_SIZE, TileAspect::Wide)
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
        if self.wanted_rows.as_ref() == Some(&rows) {
            return;
        }
        self.wanted_rows = Some(rows.clone());
        let columns = self.columns.max(1);
        let len = self.entries.len();
        let row_count = len.div_ceil(columns);
        let nearby =
            rows.start.saturating_sub(OVERSCAN_ROWS)..(rows.end + OVERSCAN_ROWS).min(row_count);
        let visible = (rows.start * columns).min(len)..(rows.end * columns).min(len);
        let nearby = (nearby.start * columns).min(len)..(nearby.end * columns).min(len);
        // Room for the drawn tiles, the overscan, and a screen's worth more for scrolling back.
        let capacity = nearby.len() + visible.len() * 2;
        self.images
            .update(cx, |images, _| images.set_capacity(capacity));
        self.thumbnails
            .update(cx, |thumbnails, cx| thumbnails.want(visible, nearby, cx));
    }

    fn render_rows(
        &mut self,
        rows: Range<usize>,
        metrics: GridMetrics,
        window: &Window,
        cx: &mut Context<Self>,
    ) -> Vec<gpui_kit::AnyElement> {
        self.note_drawn(rows.clone(), window, cx);
        let mut complete = true;
        let mut elements = Vec::with_capacity(rows.len());
        for row in rows {
            let items = metrics.items_in(row..row + 1, self.entries.len());
            let mut tiles = Vec::with_capacity(items.len());
            for ix in items {
                let (tile, drawn) = self.render_tile(ix, metrics, cx);
                complete &= drawn;
                tiles.push(tile);
            }
            elements.push(
                div()
                    .flex()
                    .flex_row()
                    .gap(px(metrics::GRID_GAP))
                    .w(px(metrics.grid_width()))
                    .h(px(metrics.row_stride()))
                    .mx_auto()
                    .children(tiles)
                    .into_any_element(),
            );
        }
        self.drawn_complete = complete;
        elements
    }

    /// One tile, and whether its thumbnail is drawn this frame (or it has none to draw).
    fn render_tile(
        &self,
        ix: usize,
        metrics: GridMetrics,
        cx: &mut Context<Self>,
    ) -> (gpui_kit::AnyElement, bool) {
        let entry = &self.entries[ix];
        let thumbnail = self.thumbnails.read(cx).thumbnail(ix);
        let drawn = match &thumbnail {
            Thumbnail::Ready(path) => self
                .images
                .read(cx)
                .is_loaded(&Resource::Path(path.clone())),
            Thumbnail::Unavailable => true,
            Thumbnail::Pending => false,
        };
        let selected = self.selected == Some(ix);
        let theme = cx.theme();

        let tile = div()
            .id(ElementId::Path(entry.path().clone()))
            .role(Role::Button)
            .test_support()
            .aria_label(entry.name().clone())
            .relative()
            .flex_shrink_0()
            .w(px(metrics.card_width()))
            .h(px(metrics.card_height()))
            .rounded(theme.radius_lg)
            .overflow_hidden()
            .bg(theme.muted)
            .when_some(
                match thumbnail {
                    Thumbnail::Ready(path) => Some(path),
                    _ => None,
                },
                |tile, path| {
                    // The cache goes on each image, not on an `image_cache()` element around the
                    // list: `uniform_list` lays its rows out in prepaint, where that element's
                    // cache is not in force, and an `img()` without one keeps its image in the
                    // App's asset cache for good. Scrolling 20,000 tiles held 11 GB that way.
                    tile.child(
                        img(path)
                            .image_cache(&self.images)
                            .size_full()
                            .object_fit(ObjectFit::Cover),
                    )
                },
            )
            .when(entry.is_video(), |tile| tile.child(video_badge()))
            .when(selected, |tile| tile.border_2().border_color(theme.ring))
            .on_click(cx.listener(move |this, event: &ClickEvent, _, cx| {
                this.click_tile(ix, event, cx);
            }))
            .into_any_element();
        (tile, drawn)
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

impl Render for Gallery {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = cx.theme();
        let message = match &self.listing {
            Listing::Empty => Some(SharedString::from("Open a folder to see its gallery.")),
            Listing::Loading => Some(SharedString::from("Reading the folder…")),
            Listing::Failed(message) => Some(message.clone()),
            Listing::Listed if self.entries.is_empty() => self
                .folder
                .as_ref()
                .map(|folder| format!("No media found in {}.", display_name(folder)).into()),
            Listing::Listed => None,
        };
        if let Some(message) = message {
            self.drawn_complete = true;
            return div()
                .id(GALLERY_ID)
                .flex()
                .flex_1()
                .min_h_0()
                .items_center()
                .justify_center()
                .text_color(theme.muted_foreground)
                .child(
                    div()
                        .id("gallery-message")
                        .role(Role::Status)
                        .test_support()
                        .aria_label(message.clone())
                        .child(message),
                )
                .into_any_element();
        }

        self.advance_autoscroll(window);
        let metrics = self.metrics(window, cx);
        self.columns = metrics.columns();
        let rows = metrics.row_count(self.entries.len());
        div()
            .id(GALLERY_ID)
            .test_support()
            .flex_1()
            .min_h_0()
            .size_full()
            .child(
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
