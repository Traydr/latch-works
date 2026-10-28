//! The viewer: one item over the whole window, stepped through in the gallery's order with the
//! arrows (or `e` and `q`), and closed with Escape, as Electron Oriel's `ViewerModal` is.
//!
//! Stills decode through ImageIO at the size the window needs, and the neighbours either side
//! decode ahead so a step shows its still at once. GIFs go to GPUI's own decoder, which animates
//! them, and videos to the capsule player.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use gpui_kit::assets::IconName;
use gpui_kit::component::{
    Icon, Sizable as _,
    button::{Button, ButtonVariants as _},
};
use gpui_kit::{
    App, AppContext as _, Context, Entity, EventEmitter, FocusHandle, Focusable,
    InteractiveElement as _, IntoElement, KeyBinding, ObjectFit, ParentElement as _, Priority,
    Render, RenderImage, Role, SharedString, StatefulInteractiveElement as _, Styled as _,
    StyledImage as _, Subscription, Task, TestSupportExt as _, Window, actions, div, img,
    linear_color_stop, linear_gradient, prelude::FluentBuilder as _, px,
};

use crate::CapsulePlayer;
use crate::listing::{MediaEntry, MediaKind};

actions!(
    viewer,
    [
        /// The next item, wrapping at the end (→ or `e`).
        NextItem,
        /// The previous item, wrapping at the start (← or `q`).
        PreviousItem,
        /// Back to the gallery (Escape).
        CloseViewer
    ]
);

const KEY_CONTEXT: &str = "Viewer";

/// The viewer's keys, as `hotkeys.ts` binds them. They reach the viewer only while it has focus.
pub(crate) fn bind_keys(cx: &mut App) {
    cx.bind_keys([
        KeyBinding::new("right", NextItem, Some(KEY_CONTEXT)),
        KeyBinding::new("e", NextItem, Some(KEY_CONTEXT)),
        KeyBinding::new("left", PreviousItem, Some(KEY_CONTEXT)),
        KeyBinding::new("q", PreviousItem, Some(KEY_CONTEXT)),
        KeyBinding::new("escape", CloseViewer, Some(KEY_CONTEXT)),
    ]);
}

/// Neighbours decoded ahead: one behind and two ahead, so stepping on in either direction finds
/// its still ready, and at most four screen-sized stills are held.
const BEHIND: usize = 1;
const AHEAD: usize = 2;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ViewerEvent {
    /// The viewer closed on this item.
    Closed(usize),
}

enum Decoded {
    /// Decoding; dropping the task cancels it if it has not started.
    Loading {
        _task: Task<()>,
    },
    Ready(Arc<RenderImage>),
    Failed,
}

pub struct Viewer {
    entries: Arc<[MediaEntry]>,
    index: usize,
    focus_handle: FocusHandle,
    stills: HashMap<usize, Decoded>,
    /// The longer side stills decode at: the window's, in device pixels.
    decode_size: u32,
    player: Option<(usize, Entity<CapsulePlayer>)>,
    /// When the last step was asked for, until its still is drawn.
    step_started: Option<Instant>,
    step_times: Vec<Duration>,
    _release: Subscription,
}

impl EventEmitter<ViewerEvent> for Viewer {}

impl Focusable for Viewer {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus_handle.clone()
    }
}

impl Viewer {
    pub fn new(
        entries: Arc<[MediaEntry]>,
        index: usize,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let mut viewer = Self {
            entries,
            index,
            focus_handle: cx.focus_handle(),
            stills: HashMap::new(),
            decode_size: decode_size(window),
            player: None,
            step_started: None,
            step_times: Vec::new(),
            // The decoded stills are in GPUI's sprite atlas until released there; dropping the
            // last handle alone would leave their textures behind.
            _release: cx.on_release(|viewer, cx| {
                for (_, decoded) in viewer.stills.drain() {
                    if let Decoded::Ready(image) = decoded {
                        cx.drop_image(image, None);
                    }
                }
            }),
        };
        viewer.show(window, cx);
        viewer
    }

    pub fn index(&self) -> usize {
        self.index
    }

    pub fn entry(&self) -> &MediaEntry {
        &self.entries[self.index]
    }

    /// How long each step took from the key to its still being drawn: for Phase 0's
    /// measurements.
    pub fn step_times(&self) -> &[Duration] {
        &self.step_times
    }

    /// The longer side, in device pixels, stills decode at.
    pub fn decode_size(&self) -> u32 {
        self.decode_size
    }

    /// Whether the current still is decoded, so the next frame draws it (always true for a GIF
    /// or a video, which draw themselves).
    pub fn is_current_ready(&self) -> bool {
        match self.entry().kind() {
            MediaKind::Image => matches!(self.stills.get(&self.index), Some(Decoded::Ready(_))),
            MediaKind::Gif | MediaKind::Video => true,
        }
    }

    pub fn step(&mut self, delta: isize, window: &mut Window, cx: &mut Context<Self>) {
        let len = self.entries.len() as isize;
        if len == 0 {
            return;
        }
        self.index = (self.index as isize + delta).rem_euclid(len) as usize;
        self.step_started = Some(Instant::now());
        self.show(window, cx);
        cx.notify();
    }

    fn close(&mut self, cx: &mut Context<Self>) {
        cx.emit(ViewerEvent::Closed(self.index));
    }

    /// Makes the current item ready: its player for a video, and for stills the current one
    /// and its neighbours decoded, the current one first and at high priority. Stills that are
    /// no longer neighbours are released.
    fn show(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.decode_size = decode_size(window);
        let entry = self.entries[self.index].clone();
        match entry.kind() {
            MediaKind::Video => {
                if self.player.as_ref().map(|(ix, _)| *ix) != Some(self.index) {
                    let path = entry.path().to_path_buf();
                    let player = cx.new(|cx| CapsulePlayer::new(path, window, cx));
                    self.player = Some((self.index, player));
                }
            }
            MediaKind::Image | MediaKind::Gif => self.player = None,
        }

        let wanted = self.neighbours();
        let stale: Vec<usize> = self
            .stills
            .keys()
            .copied()
            .filter(|ix| !wanted.contains(ix))
            .collect();
        for ix in stale {
            if let Some(Decoded::Ready(image)) = self.stills.remove(&ix) {
                cx.drop_image(image, Some(window));
            }
        }
        for (order, ix) in wanted.into_iter().enumerate() {
            let priority = if order == 0 {
                Priority::High
            } else {
                Priority::Medium
            };
            self.decode(ix, priority, cx);
        }
    }

    /// The current item, then the ones ahead, then the one behind, wrapping as stepping does.
    /// A short listing names an item once.
    fn neighbours(&self) -> Vec<usize> {
        let len = self.entries.len();
        let ahead = (1..=AHEAD).map(|offset| (self.index + offset) % len);
        let behind = (1..=BEHIND).map(|offset| (self.index + len - offset % len) % len);
        let mut order = Vec::with_capacity(1 + AHEAD + BEHIND);
        for ix in std::iter::once(self.index).chain(ahead).chain(behind) {
            if !order.contains(&ix) {
                order.push(ix);
            }
        }
        order
    }

    fn decode(&mut self, ix: usize, priority: Priority, cx: &mut Context<Self>) {
        let entry = &self.entries[ix];
        if entry.kind() != MediaKind::Image || self.stills.contains_key(&ix) {
            return;
        }
        let path = entry.path().clone();
        let size = self.decode_size;
        let decoding = cx
            .background_executor()
            .spawn_with_priority(priority, async move {
                oriel_media::still::decode(&path, size).map(|still| still.into_render_image())
            });
        let task = cx.spawn(async move |this, cx| {
            let decoded = decoding.await;
            this.update(cx, |this, cx| {
                if !matches!(this.stills.get(&ix), Some(Decoded::Loading { .. })) {
                    return;
                }
                let decoded = match decoded {
                    Ok(image) => Decoded::Ready(image),
                    Err(error) => {
                        log::warn!("the viewer cannot show item {ix}: {error:#}");
                        Decoded::Failed
                    }
                };
                this.stills.insert(ix, decoded);
                if ix == this.index {
                    cx.notify();
                }
            })
            .ok();
        });
        self.stills.insert(ix, Decoded::Loading { _task: task });
    }

    fn render_media(&self) -> gpui_kit::AnyElement {
        let entry = self.entry();
        match entry.kind() {
            MediaKind::Video => match &self.player {
                Some((_, player)) => player.clone().into_any_element(),
                None => div().into_any_element(),
            },
            // GPUI's decoder plays a GIF on an `img` with an id.
            MediaKind::Gif => img(entry.path().clone())
                .id("viewer-gif")
                .size_full()
                .object_fit(ObjectFit::Contain)
                .into_any_element(),
            MediaKind::Image => match self.stills.get(&self.index) {
                Some(Decoded::Ready(image)) => img(image.clone())
                    .size_full()
                    .object_fit(ObjectFit::Contain)
                    .into_any_element(),
                Some(Decoded::Failed) => div()
                    .text_color(gpui_kit::white().opacity(0.7))
                    .child(format!("{} cannot be shown here.", entry.name()))
                    .into_any_element(),
                // Still decoding: the dark ground until it is ready.
                _ => div().into_any_element(),
            },
        }
    }
}

/// The longer side of the window in device pixels: no still is decoded larger than the screen
/// can show it.
fn decode_size(window: &Window) -> u32 {
    let size = window.viewport_size();
    let longer = f32::from(size.width).max(f32::from(size.height));
    (longer * window.scale_factor()).ceil().max(1.) as u32
}

/// "12.3 MB": decimal units, as Electron Oriel writes sizes.
fn format_bytes(bytes: u64) -> String {
    const UNITS: [&str; 5] = ["B", "KB", "MB", "GB", "TB"];
    if bytes < 1000 {
        return format!("{bytes} B");
    }
    let mut value = bytes as f64;
    let mut unit = 0;
    while value >= 1000. && unit < UNITS.len() - 1 {
        value /= 1000.;
        unit += 1;
    }
    if value >= 100. {
        format!("{value:.0} {}", UNITS[unit])
    } else {
        format!("{value:.1} {}", UNITS[unit])
    }
}

impl Render for Viewer {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        if self.is_current_ready()
            && let Some(started) = self.step_started.take()
        {
            self.step_times.push(started.elapsed());
        }

        let entry = self.entry().clone();
        let extension = entry
            .path()
            .extension()
            .map(|extension| extension.to_string_lossy().to_uppercase())
            .unwrap_or_default();
        let details = format!("{} · {extension}", format_bytes(entry.size()));
        let label = SharedString::from(format!("Viewer for {}", entry.name()));

        // The viewer is a dark room for the picture in either theme, as Electron Oriel's is, so
        // its ground and its text are black and white rather than the theme's surfaces.
        div()
            .id("viewer")
            .role(Role::Dialog)
            .test_support()
            .aria_label(label)
            .key_context(KEY_CONTEXT)
            .track_focus(&self.focus_handle)
            .on_action(cx.listener(|this, _: &NextItem, window, cx| this.step(1, window, cx)))
            .on_action(cx.listener(|this, _: &PreviousItem, window, cx| this.step(-1, window, cx)))
            .on_action(cx.listener(|this, _: &CloseViewer, _, cx| this.close(cx)))
            .relative()
            .size_full()
            .bg(gpui_kit::black())
            .text_color(gpui_kit::white())
            .child(
                div()
                    .absolute()
                    .inset_0()
                    .p_3()
                    .flex()
                    .items_center()
                    .justify_center()
                    .child(self.render_media()),
            )
            .child(
                // macOS draws the window buttons over the top left, so the title starts to
                // their right, as `ViewerChrome` pads it.
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
                    // `.viewer-scrim-top`: black at 70% fading out, so the title reads over a
                    // light picture.
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
                            .child(div().truncate().text_sm().child(entry.name().clone()))
                            .child(
                                div()
                                    .truncate()
                                    .text_xs()
                                    .text_color(gpui_kit::white().opacity(0.7))
                                    .child(details),
                            ),
                    )
                    .child(
                        Button::new("viewer-close")
                            .ghost()
                            .icon(Icon::new(IconName::Close))
                            .tooltip("Close")
                            .on_click(cx.listener(|this, _, _, cx| this.close(cx))),
                    ),
            )
            .child(step_button(
                "viewer-previous",
                IconName::ChevronLeft,
                "Previous item",
                cx.listener(|this, _, window, cx| this.step(-1, window, cx)),
            ))
            .child(step_button(
                "viewer-next",
                IconName::ChevronRight,
                "Next item",
                cx.listener(|this, _, window, cx| this.step(1, window, cx)),
            ))
    }
}

/// A step arrow at the viewer's left or right edge, centred down it.
fn step_button(
    id: &'static str,
    icon: IconName,
    label: &'static str,
    on_click: impl Fn(&gpui_kit::ClickEvent, &mut Window, &mut App) + 'static,
) -> impl IntoElement {
    let left = id == "viewer-previous";
    div()
        .absolute()
        .top_0()
        .bottom_0()
        .when(left, |this| this.left_3())
        .when(!left, |this| this.right_3())
        .flex()
        .items_center()
        .child(
            Button::new(id)
                .ghost()
                .large()
                .icon(Icon::new(icon))
                .tooltip(label)
                .on_click(on_click),
        )
}

#[cfg(test)]
mod tests {
    use super::format_bytes;

    #[test]
    fn writes_sizes_as_electron_oriel_does() {
        assert_eq!(format_bytes(999), "999 B");
        assert_eq!(format_bytes(12_345), "12.3 KB");
        assert_eq!(format_bytes(123_456_789), "123 MB");
    }
}
