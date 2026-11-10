//! The comic reader: a comic's pages one under another, as wide as the window allows up to 980 px,
//! on the viewer's dark ground. → or E and ← or Q go a page on or back, Escape or Close returns to
//! the gallery; the top bar has the page count, Scroll to top and Reveal in folder. The top bar
//! fades as the viewer's controls do ([`crate::chrome`]).
//!
//! Pages decode at the width they show at, the ones near the page in view first; pages further
//! away are let go of, so a long comic holds a few decoded pages at a time ([`NeighbourStills`]).

use std::sync::Arc;

use gpui_kit::assets::IconName;
use gpui_kit::component::{
    Icon,
    button::{Button, ButtonVariants as _},
};
use gpui_kit::{
    App, Context, DispatchPhase, EventEmitter, FocusHandle, Focusable, InteractiveElement as _,
    IntoElement, MouseMoveEvent, ObjectFit, ParentElement as _, Priority, Render, Role,
    ScrollHandle, SharedString, StatefulInteractiveElement as _, Styled as _, StyledImage as _,
    Subscription, TestSupportExt as _, Window, canvas, div, img, linear_color_stop,
    linear_gradient, prelude::FluentBuilder as _, px,
};
use oriel_ui::ControlSize as _;
use oriel_ui::TextRole as _;

use crate::browser::Comic;
use crate::chrome::{self, ChromeFade, Fading};
use crate::shortcuts::{Close, Next, OVERLAY_KEYS, Previous};
use crate::stills::NeighbourStills;

const KEY_CONTEXT: &str = "ComicReader";

/// The widest a page shows.
const MAX_PAGE_WIDTH: f32 = 980.;
/// A page not decoded yet holds this shape, a portrait page's.
const PLACEHOLDER_ASPECT: f32 = 1.4;
/// Pages decoded ahead of the one in view, and behind it.
const AHEAD: usize = 3;
const BEHIND: usize = 1;

pub(crate) fn bind_keys(cx: &mut App) {
    cx.bind_keys(OVERLAY_KEYS.bindings(KEY_CONTEXT, cx));
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ComicReaderEvent {
    Closed,
}

pub struct ComicReader {
    comic: Arc<Comic>,
    focus: FocusHandle,
    scroll: ScrollHandle,
    pages: NeighbourStills,
    current: usize,
    chrome: ChromeFade,
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
            pages: NeighbourStills::default(),
            current: 0,
            chrome: ChromeFade::new(cx),
            _release: cx.on_release(|reader, cx| reader.pages.release_all(cx)),
        };
        reader.decode_near(window, cx);
        reader.reveal_chrome(window, cx);
        reader
    }

    pub fn is_chrome_visible(&self) -> bool {
        self.chrome.is_visible()
    }

    /// The top bar shows, and fades again once left alone.
    pub fn reveal_chrome(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        chrome::reveal(self, window, cx);
    }

    /// View left the screen: the top bar stops fading, so the pointer is never hidden over
    /// another mode. [`Self::reveal_chrome`] starts it again.
    pub fn stop_fading(&mut self) {
        self.chrome.stop();
    }

    pub fn comic(&self) -> &Arc<Comic> {
        &self.comic
    }

    /// Whether page `ix` is decoded.
    pub fn is_page_ready(&self, ix: usize) -> bool {
        self.pages.ready(ix).is_some()
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
        self.pages.keep(|ix| wanted.contains(&ix), window, cx);
        let size = (Self::page_width(window) * window.scale_factor() * 2.).ceil() as u32;
        self.pages.set_size(size);
        for ix in wanted {
            self.pages.decode(
                ix,
                self.comic.pages()[ix].path().clone(),
                Priority::Medium,
                cx,
                |reader| &mut reader.pages,
                |_, _, cx| cx.notify(),
            );
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
        match self.pages.ready(ix) {
            Some(image) => {
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
            None if self.pages.failed(ix) => ground
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
            .on_action(cx.listener(|this, _: &Next, window, cx| {
                let next = this.current + 1;
                this.go_to(next, window, cx);
            }))
            .on_action(cx.listener(|this, _: &Previous, window, cx| {
                let previous = this.current.saturating_sub(1);
                this.go_to(previous, window, cx);
            }))
            .on_action(cx.listener(|this, _: &Close, _, cx| this.close(cx)))
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
            .when(self.chrome.is_visible(), |this| {
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
                        // Black held behind both lines of text, so they read over a white page,
                        // and only then fading out.
                        .bg(linear_gradient(
                            180.,
                            linear_color_stop(gpui_kit::black().opacity(0.65), 0.66),
                            linear_color_stop(gpui_kit::black().opacity(0.), 1.),
                        ))
                        .child(
                            div()
                                .flex()
                                .flex_col()
                                .flex_1()
                                .min_w_0()
                                .child(
                                    div()
                                        .truncate()
                                        .text_body()
                                        .child(self.comic.name().clone()),
                                )
                                .child(
                                    div()
                                        .id("comic-page-count")
                                        .role(Role::Status)
                                        .test_support()
                                        .aria_label(format!("{}/{count} pages", self.current + 1))
                                        .text_caption()
                                        .text_color(gpui_kit::white().opacity(0.85))
                                        .child(format!("{}/{count} pages", self.current + 1)),
                                ),
                        )
                        .child(
                            oriel_ui::on_dark_stage(Button::new("comic-scroll-top"))
                                .bar_size()
                                .ghost()
                                .icon(Icon::new(IconName::ArrowUp))
                                .tooltip("Scroll to top")
                                .accessibility_label("Scroll to top")
                                .on_click(
                                    cx.listener(|this, _, window, cx| this.go_to(0, window, cx)),
                                ),
                        )
                        .child(
                            oriel_ui::on_dark_stage(Button::new("comic-reveal"))
                                .bar_size()
                                .ghost()
                                .icon(Icon::new(IconName::FolderOpen))
                                .tooltip("Reveal in folder")
                                .accessibility_label("Reveal in folder")
                                .on_click(move |_, _, cx| cx.reveal_path(&cover)),
                        )
                        .child(
                            oriel_ui::on_dark_stage(Button::new("comic-close"))
                                .bar_size()
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

impl Fading for ComicReader {
    fn fade(&mut self) -> &mut ChromeFade {
        &mut self.chrome
    }

    fn shown(&mut self, _: bool, cx: &mut Context<Self>) {
        cx.notify();
    }
}
