//! The comic reader (`ComicReader.tsx`): a comic's pages one under another, as wide as the
//! window allows up to 980 px, on the viewer's dark ground. → or E and ← or Q go a page on or
//! back, Escape or Close returns to the gallery; the top bar has the page count, Scroll to top and
//! Reveal in folder. The top bar fades after 2.5 s without the pointer moving, a key or a scroll,
//! with the pointer, and comes back with any of them, as the viewer's does (`useViewerChromeIdle`).
//!
//! Pages decode through ImageIO (GPUI's own decoder reads neither AVIF nor HEIC) at the width
//! they show at, the ones near the page in view first; pages further away are released, so a
//! long comic holds a few decoded pages at a time.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Instant;

use gpui_kit::assets::IconName;
use gpui_kit::component::{
    Icon,
    button::{Button, ButtonVariants as _},
};
use gpui_kit::{
    App, AppContext as _, Context, DispatchPhase, EventEmitter, FocusHandle, Focusable,
    InteractiveElement as _, IntoElement, KeyBinding, MouseMoveEvent, ObjectFit,
    ParentElement as _, Render, RenderImage, Role, ScrollHandle, SharedString,
    StatefulInteractiveElement as _, Styled as _, StyledImage as _, Subscription, Task,
    TestSupportExt as _, Window, actions, canvas, div, img, linear_color_stop, linear_gradient,
    prelude::FluentBuilder as _, px,
};

use crate::browser::Comic;
use crate::viewer::{CHROME_IDLE, on_any_key};

actions!(
    comic_reader,
    [
        /// The next page (→ or `e`).
        NextPage,
        /// The previous page (← or `q`).
        PreviousPage,
        /// Back to the gallery (Escape).
        CloseReader
    ]
);

const KEY_CONTEXT: &str = "ComicReader";

/// The widest a page shows (`w-[min(100%,980px)]`).
const MAX_PAGE_WIDTH: f32 = 980.;
/// A page not decoded yet holds this shape, a portrait page's.
const PLACEHOLDER_ASPECT: f32 = 1.4;
/// Pages decoded ahead of the one in view, and behind it.
const AHEAD: usize = 3;
const BEHIND: usize = 1;

pub(crate) fn bind_keys(cx: &mut App) {
    let context = Some(KEY_CONTEXT);
    cx.bind_keys([
        KeyBinding::new("right", NextPage, context),
        KeyBinding::new("e", NextPage, context),
        KeyBinding::new("left", PreviousPage, context),
        KeyBinding::new("q", PreviousPage, context),
        KeyBinding::new("escape", CloseReader, context),
    ]);
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ComicReaderEvent {
    Closed,
}

enum Page {
    Loading { _task: Task<()> },
    Ready(Arc<RenderImage>),
    Failed,
}

pub struct ComicReader {
    comic: Arc<Comic>,
    focus: FocusHandle,
    scroll: ScrollHandle,
    pages: HashMap<usize, Page>,
    current: usize,
    /// Whether the top bar shows.
    chrome_visible: bool,
    /// When the pointer last moved, a key was pressed or the pages scrolled.
    last_activity: Instant,
    /// Hides the top bar once it has been left alone for [`CHROME_IDLE`].
    _idle: Option<Task<()>>,
    /// Every key brings the top bar back, the page keys too.
    _keys: Subscription,
    _release: Subscription,
}

impl EventEmitter<ComicReaderEvent> for ComicReader {}

impl Focusable for ComicReader {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}

impl ComicReader {
    pub fn new(comic: Arc<Comic>, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let mut reader = Self {
            comic,
            focus: cx.focus_handle(),
            scroll: ScrollHandle::new(),
            pages: HashMap::new(),
            current: 0,
            chrome_visible: true,
            last_activity: cx.background_executor().now(),
            _idle: None,
            _keys: on_any_key(cx, Self::reveal_chrome),
            // Decoded pages live in GPUI's sprite atlas until released there.
            _release: cx.on_release(|reader, cx| {
                for (_, page) in reader.pages.drain() {
                    if let Page::Ready(image) = page {
                        cx.drop_image(image, None);
                    }
                }
            }),
        };
        reader.decode_near(window, cx);
        reader.reveal_chrome(window, cx);
        reader
    }

    /// Whether the top bar shows.
    pub fn is_chrome_visible(&self) -> bool {
        self.chrome_visible
    }

    /// `revealChrome`: the top bar shows, and fades again once left alone.
    pub fn reveal_chrome(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        // The executor's clock, which a test can move on.
        self.last_activity = cx.background_executor().now();
        if !self.chrome_visible {
            self.chrome_visible = true;
            cx.notify();
        }
        if self._idle.is_some() {
            return;
        }
        self._idle = Some(cx.spawn_in(window, async move |this, cx| {
            loop {
                let Ok(wait) = this.update(cx, |this, cx| {
                    let idle = cx
                        .background_executor()
                        .now()
                        .saturating_duration_since(this.last_activity);
                    CHROME_IDLE.saturating_sub(idle)
                }) else {
                    return;
                };
                if wait.is_zero() {
                    break;
                }
                cx.background_executor().timer(wait).await;
            }
            this.update(cx, |this, cx| {
                this._idle = None;
                this.chrome_visible = false;
                oriel_media::video::hide_pointer_until_it_moves();
                cx.notify();
            })
            .ok();
        }));
    }

    pub fn comic(&self) -> &Arc<Comic> {
        &self.comic
    }

    /// The page in view, from 0.
    pub fn current_page(&self) -> usize {
        self.current
    }

    /// Whether page `ix` is decoded.
    pub fn is_page_ready(&self, ix: usize) -> bool {
        matches!(self.pages.get(&ix), Some(Page::Ready(_)))
    }

    fn close(&mut self, cx: &mut Context<Self>) {
        cx.emit(ComicReaderEvent::Closed);
    }

    /// Goes to page `ix`, clamped to the comic, with its top at the top of the view.
    pub fn go_to(&mut self, ix: usize, window: &mut Window, cx: &mut Context<Self>) {
        let last = self.comic.pages().len().saturating_sub(1);
        self.current = ix.min(last);
        self.scroll.scroll_to_top_of_item(self.current);
        self.decode_near(window, cx);
        cx.notify();
    }

    fn page_width(window: &Window) -> f32 {
        (f32::from(window.viewport_size().width) - 24.).clamp(120., MAX_PAGE_WIDTH)
    }

    /// Decodes the pages near the current one and releases the rest.
    fn decode_near(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let count = self.comic.pages().len();
        if count == 0 {
            return;
        }
        let wanted = self.current.saturating_sub(BEHIND)..(self.current + AHEAD + 1).min(count);
        let stale: Vec<usize> = self
            .pages
            .keys()
            .copied()
            .filter(|ix| !wanted.contains(ix))
            .collect();
        for ix in stale {
            if let Some(Page::Ready(image)) = self.pages.remove(&ix) {
                cx.drop_image(image, Some(window));
            }
        }
        let size = (Self::page_width(window) * window.scale_factor() * 2.).ceil() as u32;
        for ix in wanted {
            if self.pages.contains_key(&ix) {
                continue;
            }
            let path = self.comic.pages()[ix].path().clone();
            let decoding = cx.background_spawn(async move {
                oriel_media::still::decode(&path, size).map(|still| still.into_render_image())
            });
            let task = cx.spawn(async move |this, cx| {
                let decoded = decoding.await;
                this.update(cx, |this, cx| {
                    if !matches!(this.pages.get(&ix), Some(Page::Loading { .. })) {
                        return;
                    }
                    let page = match decoded {
                        Ok(image) => Page::Ready(image),
                        Err(error) => {
                            log::warn!("the reader cannot show page {ix}: {error:#}");
                            Page::Failed
                        }
                    };
                    this.pages.insert(ix, page);
                    cx.notify();
                })
                .ok();
            });
            self.pages.insert(ix, Page::Loading { _task: task });
        }
    }

    /// Follows a scroll: the page nearest the top of the view is the current one.
    fn sync_current(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let top = self.scroll.top_item();
        if top != self.current && top < self.comic.pages().len() {
            self.current = top;
            self.decode_near(window, cx);
        }
    }

    fn render_page(&self, ix: usize, width: f32) -> impl IntoElement + use<> {
        let page = &self.comic.pages()[ix];
        let ground = div()
            .id(SharedString::from(format!("comic-page-{ix}")))
            .role(Role::Image)
            .test_support()
            .aria_label(page.name().clone())
            .flex_shrink_0()
            .w(px(width))
            .bg(gpui_kit::rgb(0x18181b))
            .border_1()
            .border_color(gpui_kit::white().opacity(0.1));
        match self.pages.get(&ix) {
            Some(Page::Ready(image)) => {
                let size = image.size(0);
                let aspect = size.height.0 as f32 / size.width.0.max(1) as f32;
                ground
                    .h(px(width * aspect))
                    .child(
                        img(image.clone())
                            .size_full()
                            .object_fit(ObjectFit::Contain),
                    )
                    .into_any_element()
            }
            Some(Page::Failed) => ground
                .h(px(width * 0.5))
                .flex()
                .items_center()
                .justify_center()
                .text_color(gpui_kit::white().opacity(0.7))
                .child(format!("{} cannot be shown here.", page.name()))
                .into_any_element(),
            _ => ground.h(px(width * PLACEHOLDER_ASPECT)).into_any_element(),
        }
    }
}

impl Render for ComicReader {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.sync_current(window, cx);
        let width = Self::page_width(window);
        let count = self.comic.pages().len();
        let pages: Vec<_> = (0..count)
            .map(|ix| self.render_page(ix, width).into_any_element())
            .collect();
        let cover = self.comic.cover().path().clone();
        let reader = cx.entity().downgrade();

        div()
            .id("comic-reader")
            .role(Role::Dialog)
            .test_support()
            .aria_label(format!("Comic reader for {}", self.comic.name()))
            .key_context(KEY_CONTEXT)
            .track_focus(&self.focus)
            .on_action(cx.listener(|this, _: &NextPage, window, cx| {
                let next = this.current + 1;
                this.go_to(next, window, cx);
            }))
            .on_action(cx.listener(|this, _: &PreviousPage, window, cx| {
                let previous = this.current.saturating_sub(1);
                this.go_to(previous, window, cx);
            }))
            .on_action(cx.listener(|this, _: &CloseReader, _, cx| this.close(cx)))
            .relative()
            .size_full()
            .bg(gpui_kit::rgb(0x09090b))
            .text_color(gpui_kit::white())
            .child(
                div()
                    .id("comic-pages")
                    .size_full()
                    .overflow_y_scroll()
                    .track_scroll(&self.scroll)
                    .on_scroll(cx.listener(|this, _, window, cx| {
                        this.reveal_chrome(window, cx);
                        cx.notify();
                    }))
                    .px_3()
                    .pt_3()
                    .pb_6()
                    .flex()
                    .flex_col()
                    .items_center()
                    .gap_3()
                    .children(pages),
            )
            // The pointer moving anywhere over the reader brings the top bar back.
            .child(
                canvas(
                    |_, _, _| {},
                    move |_, _, window, _| {
                        let reader = reader.clone();
                        window.on_mouse_event(move |_: &MouseMoveEvent, phase, window, cx| {
                            if phase == DispatchPhase::Bubble {
                                reader
                                    .update(cx, |reader, cx| reader.reveal_chrome(window, cx))
                                    .ok();
                            }
                        });
                    },
                )
                .absolute()
                .size_full(),
            )
            .when(self.chrome_visible, |this| {
                this.child(
                    // macOS draws the window buttons over the top left, so the title starts to their
                    // right, as the reader pads it.
                    div()
                        .absolute()
                        .top_0()
                        .left_0()
                        .right_0()
                        .flex()
                        .flex_row()
                        .items_start()
                        .gap_3()
                        .pt_4()
                        .pb_10()
                        .pr_3()
                        .pl(px(88.))
                        .bg(linear_gradient(
                            180.,
                            linear_color_stop(gpui_kit::black().opacity(0.7), 0.),
                            linear_color_stop(gpui_kit::black().opacity(0.), 1.),
                        ))
                        .child(
                            div()
                                .flex()
                                .flex_col()
                                .flex_1()
                                .min_w_0()
                                .child(div().truncate().text_sm().child(self.comic.name().clone()))
                                .child(
                                    div()
                                        .id("comic-page-count")
                                        .role(Role::Status)
                                        .test_support()
                                        .aria_label(format!("{}/{count} pages", self.current + 1))
                                        .text_xs()
                                        .text_color(gpui_kit::white().opacity(0.7))
                                        .child(format!("{}/{count} pages", self.current + 1)),
                                ),
                        )
                        .child(
                            Button::new("comic-scroll-top")
                                .ghost()
                                .icon(Icon::new(IconName::ArrowUp))
                                .tooltip("Scroll to top")
                                .accessibility_label("Scroll to top")
                                .on_click(
                                    cx.listener(|this, _, window, cx| this.go_to(0, window, cx)),
                                ),
                        )
                        .child(
                            Button::new("comic-reveal")
                                .ghost()
                                .icon(Icon::new(IconName::FolderOpen))
                                .tooltip("Reveal in folder")
                                .accessibility_label("Reveal in folder")
                                .on_click(move |_, _, cx| cx.reveal_path(&cover)),
                        )
                        .child(
                            Button::new("comic-close")
                                .ghost()
                                .icon(Icon::new(IconName::Close))
                                .tooltip("Close")
                                .accessibility_label("Close")
                                .on_click(cx.listener(|this, _, _, cx| this.close(cx))),
                        ),
                )
            })
    }
}
