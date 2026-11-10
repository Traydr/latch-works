//! The viewer: one item over the whole window, stepped through in the gallery's order with the
//! arrows (or `e` and `q`), and closed with Escape. Its top
//! bar has the name and the details (size, format, and a video's length, size and codec from
//! ffprobe), then Copy path, Reveal in folder, Show in Tidy, Fullscreen and Close. Stepping wraps
//! at the ends while "Loop viewer navigation" is on, and stops there otherwise.
//!
//! The controls fade away after 2.5 s without the pointer moving or a key, and come back with
//! either; a paused video keeps them. The pointer hides with them.
//!
//! Stills decode through ImageIO at the size the window needs, and the neighbours either side
//! decode ahead so a step shows its still at once. GIFs go to GPUI's own decoder, which animates
//! them, and videos to the capsule player, which gets the volume, mute and speed the last video
//! had: the volume and mute from the shell's local storage, and the speed for as long as the
//! viewer is open.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use gpui_kit::assets::IconName;
use gpui_kit::component::{
    Disableable as _, Icon, Sizable as _, Size,
    button::{Button, ButtonVariants as _},
};
use gpui_kit::{
    App, AppContext as _, ClipboardItem, Context, DispatchPhase, Entity, EventEmitter, FocusHandle,
    Focusable, InteractiveElement as _, IntoElement, KeyDownEvent, KeyUpEvent, MouseMoveEvent,
    ObjectFit, ParentElement as _, Priority, Render, Role, SharedString,
    StatefulInteractiveElement as _, Styled as _, StyledImage as _, Subscription, Task,
    TestSupportExt as _, Window, canvas, div, img, linear_color_stop, linear_gradient,
    prelude::FluentBuilder as _, px,
};
use oriel_core_domain::format;
use oriel_ui::TextRole as _;
use oriel_ui::{ControlSize as _, LocalStorage};

use crate::CapsulePlayer;
use crate::chrome::{self, ChromeFade, Fading};
use crate::listing::{MediaEntry, MediaKind};
use crate::media_tools::ViewMediaTools;
use crate::player::{
    CapsulePlayerEvent, HoldSpeed, PlayerOptions, SkipBack, SkipForward, ToggleMute,
    TogglePlayback, VIDEO_KEYS,
};
use crate::shortcuts::{Close, Next, OVERLAY_KEYS, Previous};
use crate::stills::NeighbourStills;

pub use crate::chrome::CHROME_IDLE;

/// How the viewer behaves, from View's settings.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ViewerOptions {
    /// Step from the last item to the first and back.
    pub wrap: bool,
    /// Start a video playing when it shows.
    pub autoplay: bool,
    /// Play a video again from the start at its end.
    pub loop_videos: bool,
}

impl Default for ViewerOptions {
    fn default() -> Self {
        Self {
            wrap: true,
            autoplay: true,
            loop_videos: true,
        }
    }
}

const KEY_CONTEXT: &str = "Viewer";

/// The stored volume, `0` to `1`, under the key Frame View's `localStorage` used.
pub const VOLUME_KEY: &str = "frameview.viewer.volume";
/// Whether the viewer is stored muted: `1` or `0`.
pub const MUTED_KEY: &str = "frameview.viewer.muted";

/// The viewer's keys. They reach the viewer only while it has focus. The video keys are bound
/// here too, so they reach the video shown wherever in the viewer focus is.
pub(crate) fn bind_keys(cx: &mut App) {
    cx.bind_keys(OVERLAY_KEYS.bindings(KEY_CONTEXT, cx));
    cx.bind_keys(VIDEO_KEYS.bindings(KEY_CONTEXT, cx));
}

/// Neighbours decoded ahead: one behind and two ahead, so stepping on in either direction finds
/// its still ready, and at most four screen-sized stills are held.
const BEHIND: usize = 1;
const AHEAD: usize = 2;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ViewerEvent {
    /// The viewer closed on this item.
    Closed(usize),
    /// The viewer stepped to this item, which the gallery selects.
    Stepped(usize),
    /// Show in Tidy, for this file: the app hands it to Tidy.
    ShowInTidy(PathBuf),
}

pub struct Viewer {
    entries: Arc<[MediaEntry]>,
    index: usize,
    options: ViewerOptions,
    /// Reads ffprobe's facts about the video shown, for its details.
    _probe: Option<Task<()>>,
    focus_handle: FocusHandle,
    stills: NeighbourStills,
    /// The longer side stills decode at: the window's, in device pixels.
    decode_size: u32,
    player: Option<(usize, Entity<CapsulePlayer>)>,
    /// The player's events and its state, dropped with it.
    player_subscriptions: Vec<Subscription>,
    /// What the next video starts with: the volume and mute kept across launches, and the speed
    /// picked while the viewer is open.
    player_options: PlayerOptions,
    /// Whether the video shown plays, which keeps the controls from fading while it does not.
    video_playing: bool,
    chrome: ChromeFade,
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
        options: ViewerOptions,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let player_options = PlayerOptions {
            autoplay: options.autoplay,
            looping: options.loop_videos,
            volume: LocalStorage::get(cx, VOLUME_KEY)
                .and_then(|volume| volume.parse::<f32>().ok())
                .filter(|volume| volume.is_finite())
                .map_or(1., |volume| volume.clamp(0., 1.)),
            muted: LocalStorage::get(cx, MUTED_KEY) == Some("1"),
            speed: 1.,
        };
        let mut viewer = Self {
            entries,
            index,
            options,
            _probe: None,
            focus_handle: cx.focus_handle(),
            stills: NeighbourStills::default(),
            decode_size: decode_size(window),
            player: None,
            player_subscriptions: Vec::new(),
            player_options,
            video_playing: false,
            chrome: ChromeFade::new(cx),
            step_started: None,
            step_times: Vec::new(),
            _release: cx.on_release(|viewer, cx| viewer.stills.release_all(cx)),
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
            MediaKind::Image => self.stills.ready(self.index).is_some(),
            MediaKind::Gif | MediaKind::Video => true,
        }
    }

    /// The capsule player of the video shown, when a video shows.
    pub fn player(&self) -> Option<&Entity<CapsulePlayer>> {
        self.player
            .as_ref()
            .filter(|(ix, _)| *ix == self.index)
            .map(|(_, player)| player)
    }

    pub fn options(&self) -> ViewerOptions {
        self.options
    }

    /// What the next video starts with.
    pub fn player_options(&self) -> PlayerOptions {
        self.player_options
    }

    pub fn is_chrome_visible(&self) -> bool {
        self.chrome.is_visible()
    }

    /// The controls show, and fade again once left alone.
    pub fn reveal_chrome(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        chrome::reveal(self, window, cx);
    }

    /// View left the screen: the controls stop fading, so the pointer is never hidden over
    /// another mode. [`Self::reveal_chrome`] starts it again.
    pub fn stop_fading(&mut self) {
        self.chrome.stop();
    }

    /// Runs `command` on the video shown, if one shows: the video keys when focus is elsewhere
    /// in the viewer than on the player.
    fn with_player(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
        command: impl FnOnce(&mut CapsulePlayer, &mut Window, &mut Context<CapsulePlayer>),
    ) {
        if let Some(player) = self.player() {
            player
                .clone()
                .update(cx, |player, cx| command(player, window, cx));
        }
    }

    /// Opens the capsule player for the video at `ix`, with what the last video had, and keeps
    /// what the owner changes in it for the next.
    fn open_player(&mut self, ix: usize, window: &mut Window, cx: &mut Context<Self>) {
        let path = self.entries[ix].path().to_path_buf();
        let options = self.player_options;
        let player = cx.new(|cx| CapsulePlayer::open(path, options, window, cx));
        player.update(cx, |player, cx| {
            player.set_chrome_visible(self.chrome.is_visible(), cx)
        });
        self.player_subscriptions = vec![
            cx.subscribe(&player, |this, _, event, cx| match *event {
                CapsulePlayerEvent::VolumeChanged { volume, muted } => {
                    this.player_options.volume = volume;
                    this.player_options.muted = muted;
                    LocalStorage::set(cx, VOLUME_KEY, &volume.to_string());
                    LocalStorage::set(cx, MUTED_KEY, if muted { "1" } else { "0" });
                }
                CapsulePlayerEvent::SpeedChanged(speed) => this.player_options.speed = speed,
            }),
            cx.observe_in(&player, window, |this, player, window, cx| {
                let playing = player.read(cx).is_playing();
                if playing != this.video_playing {
                    this.video_playing = playing;
                    chrome::pin_changed(this, window, cx);
                }
            }),
        ];
        self.video_playing = player.read(cx).is_playing();
        self.player = Some((ix, player));
    }

    /// Steps `delta` items: around the ends when wrapping, else no further than them
    ///.
    pub fn step(&mut self, delta: isize, window: &mut Window, cx: &mut Context<Self>) {
        let len = self.entries.len() as isize;
        if len == 0 {
            return;
        }
        let raw = self.index as isize + delta;
        let next = if self.options.wrap {
            raw.rem_euclid(len)
        } else {
            raw.clamp(0, len - 1)
        } as usize;
        if !self.options.wrap && next == self.index {
            return;
        }
        self.index = next;
        self.step_started = Some(Instant::now());
        self.show(window, cx);
        cx.emit(ViewerEvent::Stepped(self.index));
        cx.notify();
    }

    /// Whether a step that way goes anywhere (the step arrows are disabled at an end when not
    /// wrapping).
    fn can_step(&self, delta: isize) -> bool {
        self.options.wrap
            || (delta < 0 && self.index > 0)
            || (delta > 0 && self.index + 1 < self.entries.len())
    }

    /// The details under the name: size, format, and for a video its
    /// length (ffprobe's, or the player's), its size and its codec.
    pub fn details(&self, cx: &App) -> String {
        let entry = self.entry();
        // `formatBytes`, media-domain's: steps of 1024.
        let mut details = vec![
            format::bytes(entry.size()),
            entry.extension().to_uppercase(),
        ];
        if entry.is_video() {
            let probe = ViewMediaTools::shared().cached_probe(entry);
            let duration = probe
                .as_ref()
                .and_then(|probe| probe.duration_ms)
                .filter(|duration| *duration > 0.)
                .map(|duration| Duration::from_secs_f64(duration / 1000.))
                .or_else(|| {
                    self.player()
                        .and_then(|player| player.read(cx).duration())
                        .filter(|duration| !duration.is_zero())
                });
            if let Some(duration) = duration {
                details.push(format::clock(duration));
            }
            if let Some(probe) = probe {
                if let (Some(width), Some(height)) = (probe.width, probe.height) {
                    details.push(format!("{width}x{height}"));
                }
                if let Some(codec) = probe.video_codec {
                    details.push(codec);
                }
            }
        }
        details.join(" · ")
    }

    /// Asks ffprobe about the video shown, once per version of the file.
    fn probe(&mut self, cx: &mut Context<Self>) {
        let entry = self.entry().clone();
        if ViewMediaTools::shared().cached_probe(&entry).is_some() {
            return;
        }
        self._probe = Some(cx.spawn(async move |this, cx| {
            let read = cx
                .background_spawn(async move { ViewMediaTools::shared().probe(&entry) })
                .await
                .is_some();
            if read {
                this.update(cx, |_, cx| cx.notify()).ok();
            }
        }));
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
                    self.open_player(self.index, window, cx);
                }
                self.probe(cx);
            }
            MediaKind::Image | MediaKind::Gif => {
                // The video's player has the keys, and they would go with it, leaving the next
                // step's key nothing to reach: the viewer takes them back first.
                if self.player.take().is_some() && self.focus_handle.contains_focused(window, cx) {
                    self.focus_handle.focus(window, cx);
                }
                self.player_subscriptions.clear();
                self.video_playing = false;
            }
        }
        chrome::pin_changed(self, window, cx);

        let wanted = self.neighbours();
        self.stills.set_size(self.decode_size);
        self.stills.keep(|ix| wanted.contains(&ix), window, cx);
        for (order, ix) in wanted.into_iter().enumerate() {
            let entry = &self.entries[ix];
            if entry.kind() != MediaKind::Image {
                continue;
            }
            let priority = if order == 0 {
                Priority::High
            } else {
                Priority::Medium
            };
            self.stills.decode(
                ix,
                entry.path().clone(),
                priority,
                cx,
                |viewer| &mut viewer.stills,
                |viewer, ix, cx| {
                    if ix == viewer.index {
                        cx.notify();
                    }
                },
            );
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

    fn render_media(&self) -> gpui_kit::AnyElement {
        let entry = self.entry();
        match entry.kind() {
            MediaKind::Video => match &self.player {
                Some((_, player)) => player.clone().into_any_element(),
                None => div().into_any_element(),
            },
            // GPUI's decoder plays a GIF on an `img` with an id.
            // Positioned in a place of its own, so its share of that place is definite: `img()`
            // otherwise takes the picture's own shape, and a tall one is cut off.
            MediaKind::Gif => div()
                .relative()
                .size_full()
                .child(
                    img(entry.path().clone())
                        .id("viewer-gif")
                        .absolute()
                        .size_full()
                        .object_fit(ObjectFit::Contain),
                )
                .into_any_element(),
            MediaKind::Image => match self.stills.ready(self.index) {
                // Painted rather than left to `img()`, which takes the picture's own shape as its
                // aspect ratio, and would cut a tall still off rather than fit it.
                Some(image) => {
                    let image = image.clone();
                    div()
                        .relative()
                        .size_full()
                        .child(
                            gpui_kit::canvas(
                                |_, _, _| {},
                                move |bounds, (), window, _| {
                                    let shown =
                                        ObjectFit::Contain.get_bounds(bounds, image.size(0));
                                    window
                                        .paint_image(
                                            bounds,
                                            shown,
                                            gpui_kit::Corners::default(),
                                            image.clone(),
                                            0,
                                            false,
                                        )
                                        .ok();
                                },
                            )
                            .absolute()
                            .size_full(),
                        )
                        .into_any_element()
                }
                None if self.stills.failed(self.index) => div()
                    .text_color(gpui_kit::white().opacity(0.7))
                    .child(format!("{} cannot be shown here.", entry.name()))
                    .into_any_element(),
                // Still decoding: the dark ground until it is ready.
                None => div().into_any_element(),
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

impl Render for Viewer {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        if self.is_current_ready()
            && let Some(started) = self.step_started.take()
        {
            self.step_times.push(started.elapsed());
        }

        let entry = self.entry().clone();
        let details = self.details(cx);
        let label = SharedString::from(format!("Viewer for {}", entry.name()));
        let fullscreen = window.is_fullscreen();
        let copied_path = entry.path().to_string_lossy().into_owned();
        let revealed = entry.path().clone();

        // The viewer is a dark room for the picture in either theme, so its ground and its text
        // are black and white rather than the theme's surfaces.
        let viewer = cx.entity().downgrade();
        let shown_file = entry.path().to_path_buf();
        let panel_open = self
            .player
            .as_ref()
            .is_some_and(|(_, player)| player.read(cx).panel().is_some());
        div()
            .id("viewer")
            .role(Role::Dialog)
            .test_support()
            .aria_label(label)
            .key_context(KEY_CONTEXT)
            .track_focus(&self.focus_handle)
            .on_action(cx.listener(|this, _: &Next, window, cx| this.step(1, window, cx)))
            .on_action(cx.listener(|this, _: &Previous, window, cx| this.step(-1, window, cx)))
            .on_action(cx.listener(|this, _: &Close, _, cx| this.close(cx)))
            .on_action(cx.listener(|this, action: &TogglePlayback, window, cx| {
                this.with_player(window, cx, |player, window, cx| {
                    player.toggle_playback(action, window, cx);
                });
            }))
            .on_action(cx.listener(|this, action: &SkipBack, window, cx| {
                this.with_player(window, cx, |player, window, cx| {
                    player.skip_back(action, window, cx);
                });
            }))
            .on_action(cx.listener(|this, action: &SkipForward, window, cx| {
                this.with_player(window, cx, |player, window, cx| {
                    player.skip_forward(action, window, cx);
                });
            }))
            .on_action(cx.listener(|this, action: &ToggleMute, window, cx| {
                this.with_player(window, cx, |player, window, cx| {
                    player.toggle_mute(action, window, cx);
                });
            }))
            .on_action(cx.listener(|this, action: &HoldSpeed, window, cx| {
                this.with_player(window, cx, |player, window, cx| {
                    player.hold_speed(action, window, cx);
                });
            }))
            .on_key_down(cx.listener(|this, event: &KeyDownEvent, window, cx| {
                this.with_player(window, cx, |player, window, cx| {
                    player.on_key_down(event, window, cx);
                });
            }))
            .on_key_up(cx.listener(|this, event: &KeyUpEvent, window, cx| {
                this.with_player(window, cx, |player, window, cx| {
                    player.on_key_up(event, window, cx);
                });
            }))
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
            // The pointer moving anywhere over the viewer brings the controls back, over the
            // capsule too, which keeps its presses from the picture behind it.
            .child(
                canvas(
                    |_, _, _| {},
                    move |_, _, window, _| {
                        let viewer = viewer.clone();
                        window.on_mouse_event(move |_: &MouseMoveEvent, phase, window, cx| {
                            if phase == DispatchPhase::Bubble {
                                viewer
                                    .update(cx, |viewer, cx| viewer.reveal_chrome(window, cx))
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
                    // macOS draws the window buttons over the top left, so the title starts to
                    // their right; full screen has none.
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
                        .pl(px(if fullscreen { 12. } else { 88. }))
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
                                .child(div().truncate().text_body().child(entry.name().clone()))
                                .child(
                                    div()
                                        .truncate()
                                        .text_caption()
                                        .text_color(gpui_kit::white().opacity(0.85))
                                        .child(details),
                                ),
                        )
                        .child(
                            oriel_ui::on_dark_stage(Button::new("viewer-copy-path"))
                                .bar_size()
                                .ghost()
                                .icon(Icon::new(IconName::Copy))
                                .tooltip("Copy path")
                                .accessibility_label("Copy path")
                                .on_click(move |_, _, cx| {
                                    cx.write_to_clipboard(ClipboardItem::new_string(
                                        copied_path.clone(),
                                    ));
                                }),
                        )
                        .child(
                            oriel_ui::on_dark_stage(Button::new("viewer-reveal"))
                                .bar_size()
                                .ghost()
                                .icon(Icon::new(IconName::FolderOpen))
                                .tooltip("Reveal in folder")
                                .accessibility_label("Reveal in folder")
                                .on_click(move |_, _, cx| cx.reveal_path(&revealed)),
                        )
                        .child(
                            oriel_ui::on_dark_stage(Button::new("viewer-show-in-tidy"))
                                .bar_size()
                                .ghost()
                                .icon(Icon::new(IconName::WandSparkles))
                                .tooltip("Show in Tidy")
                                .accessibility_label("Show in Tidy")
                                .on_click(cx.listener(move |_, _, _, cx| {
                                    cx.emit(ViewerEvent::ShowInTidy(shown_file.clone()));
                                })),
                        )
                        .child(
                            oriel_ui::on_dark_stage(Button::new("viewer-fullscreen"))
                                .bar_size()
                                .ghost()
                                .icon(Icon::new(if fullscreen {
                                    IconName::Minimize
                                } else {
                                    IconName::Maximize
                                }))
                                .tooltip(if fullscreen {
                                    "Exit fullscreen"
                                } else {
                                    "Fullscreen"
                                })
                                .accessibility_label(if fullscreen {
                                    "Exit fullscreen"
                                } else {
                                    "Fullscreen"
                                })
                                .on_click(|_, window, _| window.toggle_fullscreen()),
                        )
                        .child(
                            oriel_ui::on_dark_stage(Button::new("viewer-close"))
                                .bar_size()
                                .ghost()
                                .icon(Icon::new(IconName::Close))
                                .tooltip("Close")
                                .accessibility_label("Close")
                                .on_click(cx.listener(|this, _, _, cx| this.close(cx))),
                        ),
                )
                .child(step_button(
                    "viewer-previous",
                    IconName::ChevronLeft,
                    "Previous item",
                    self.can_step(-1),
                    cx.listener(|this, _, window, cx| this.step(-1, window, cx)),
                ))
                // The player's speed and volume panels rise along the right edge, over this arrow's
                // place, so it gives way while one is open.
                .when(!panel_open, |this| {
                    this.child(step_button(
                        "viewer-next",
                        IconName::ChevronRight,
                        "Next item",
                        self.can_step(1),
                        cx.listener(|this, _, window, cx| this.step(1, window, cx)),
                    ))
                })
            })
    }
}

/// A step arrow at the viewer's left or right edge, centred down it.
fn step_button(
    id: &'static str,
    icon: IconName,
    label: &'static str,
    enabled: bool,
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
            // A 28 px arrow on a dark round plate in a 52 px target: the step the viewer is used
            // for, and it must read over any picture, even a bright one. The plate is its own, as
            // a ghost button draws no ground at rest.
            div()
                .rounded_full()
                .bg(gpui_kit::black().opacity(0.45))
                .child(
                    oriel_ui::on_dark_stage(Button::new(id))
                        .ghost()
                        .with_size(Size::Size(px(37.)))
                        .size(px(52.))
                        .rounded_full()
                        .text_color(gpui_kit::white())
                        .icon(Icon::new(icon))
                        .tooltip(label)
                        .accessibility_label(label)
                        .disabled(!enabled)
                        .on_click(on_click),
                ),
        )
}

impl Fading for Viewer {
    fn fade(&mut self) -> &mut ChromeFade {
        &mut self.chrome
    }

    /// The controls stay while a paused video shows.
    fn pinned(&self) -> bool {
        self.entry().is_video() && !self.video_playing
    }

    fn shown(&mut self, visible: bool, cx: &mut Context<Self>) {
        if let Some((_, player)) = &self.player {
            player.update(cx, |player, cx| player.set_chrome_visible(visible, cx));
        }
        cx.notify();
    }
}
