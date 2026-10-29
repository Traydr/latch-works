//! The viewer: one item over the whole window, stepped through in the gallery's order with the
//! arrows (or `e` and `q`), and closed with Escape, as Electron Oriel's `ViewerModal` is. Its top
//! bar has the name and the details (size, format, and a video's length, size and codec from
//! ffprobe), then Copy path, Reveal in folder, Show in Tidy, Fullscreen and Close. Stepping wraps
//! at the ends while "Loop viewer navigation" is on, and stops there otherwise.
//!
//! The controls fade away after 2.5 s without the pointer moving or a key, and come back with
//! either (`useViewerChromeIdle`); a paused video keeps them. The pointer hides with them.
//!
//! Stills decode through ImageIO at the size the window needs, and the neighbours either side
//! decode ahead so a step shows its still at once. GIFs go to GPUI's own decoder, which animates
//! them, and videos to the capsule player, which gets the volume, mute and speed the last video
//! had: the volume and mute from the shell's local storage, under Electron Oriel's keys, and the
//! speed for as long as the viewer is open.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use gpui_kit::assets::IconName;
use gpui_kit::component::{
    Disableable as _, Icon, Sizable as _,
    button::{Button, ButtonVariants as _},
};
use gpui_kit::{
    App, AppContext as _, ClipboardItem, Context, DispatchPhase, Entity, EventEmitter, FocusHandle,
    Focusable, InteractiveElement as _, IntoElement, KeyBinding, KeyUpEvent, MouseMoveEvent,
    ObjectFit, ParentElement as _, Priority, Render, RenderImage, Role, SharedString,
    StatefulInteractiveElement as _, Styled as _, StyledImage as _, Subscription, Task,
    TestSupportExt as _, Window, actions, canvas, div, img, linear_color_stop, linear_gradient,
    prelude::FluentBuilder as _, px,
};
use oriel_core_domain::format_bytes;
use oriel_ui::LocalStorage;

use crate::CapsulePlayer;
use crate::listing::{MediaEntry, MediaKind};
use crate::media_tools::{VideoProbe, ViewMediaTools};
use crate::player::{
    self, CapsulePlayerEvent, HoldSpeed, PlayerOptions, SkipBack, SkipForward, ToggleMute,
    TogglePlayback,
};

/// Where the viewer's volume and mute are kept: `localStorage`'s keys in Electron Oriel.
pub const VOLUME_KEY: &str = "frameview.viewer.volume";
pub const MUTED_KEY: &str = "frameview.viewer.muted";

/// How long the controls stay without the pointer moving or a key (`CHROME_IDLE_MS`).
pub const CHROME_IDLE: Duration = Duration::from_millis(2500);

/// How the viewer behaves, from View's settings.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ViewerOptions {
    /// Step from the last item to the first and back (`loopViewerNavigation`).
    pub wrap: bool,
    /// Start a video playing when it shows (`autoplayVideos`).
    pub autoplay: bool,
    /// Play a video again from the start at its end (`loopVideos`).
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

actions!(
    viewer,
    [
        /// The next item (→ or `e`).
        NextItem,
        /// The previous item (← or `q`).
        PreviousItem,
        /// Back to the gallery (Escape).
        CloseViewer
    ]
);

const KEY_CONTEXT: &str = "Viewer";

/// The viewer's keys, as `hotkeys.ts` binds them. They reach the viewer only while it has focus.
/// The video keys are bound here too, so they reach the video shown wherever in the viewer focus
/// is, as Electron Oriel's window-wide keys do.
pub(crate) fn bind_keys(cx: &mut App) {
    cx.bind_keys([
        KeyBinding::new("right", NextItem, Some(KEY_CONTEXT)),
        KeyBinding::new("e", NextItem, Some(KEY_CONTEXT)),
        KeyBinding::new("left", PreviousItem, Some(KEY_CONTEXT)),
        KeyBinding::new("q", PreviousItem, Some(KEY_CONTEXT)),
        KeyBinding::new("escape", CloseViewer, Some(KEY_CONTEXT)),
    ]);
    cx.bind_keys(player::key_bindings(KEY_CONTEXT));
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
    /// Show in Tidy, for this file: the app hands it to Tidy, as Electron Oriel's `handOff`.
    ShowInTidy(PathBuf),
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
    options: ViewerOptions,
    /// ffprobe's facts about the videos shown, by index.
    probes: HashMap<usize, VideoProbe>,
    _probe: Option<Task<()>>,
    focus_handle: FocusHandle,
    stills: HashMap<usize, Decoded>,
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
    /// Whether the controls show.
    chrome_visible: bool,
    /// When the pointer last moved or a key was pressed.
    last_activity: Instant,
    /// Hides the controls once they have been left alone for [`CHROME_IDLE`].
    _idle: Option<Task<()>>,
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
            probes: HashMap::new(),
            _probe: None,
            focus_handle: cx.focus_handle(),
            stills: HashMap::new(),
            decode_size: decode_size(window),
            player: None,
            player_subscriptions: Vec::new(),
            player_options,
            video_playing: false,
            chrome_visible: true,
            last_activity: cx.background_executor().now(),
            _idle: None,
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

    /// The capsule player of the video shown, when a video shows.
    pub fn player(&self) -> Option<&Entity<CapsulePlayer>> {
        self.player
            .as_ref()
            .filter(|(ix, _)| *ix == self.index)
            .map(|(_, player)| player)
    }

    /// The options it was opened with.
    pub fn options(&self) -> ViewerOptions {
        self.options
    }

    /// What the next video starts with.
    pub fn player_options(&self) -> PlayerOptions {
        self.player_options
    }

    /// Whether the controls show.
    pub fn is_chrome_visible(&self) -> bool {
        self.chrome_visible
    }

    /// The controls stay while a paused video shows, as Electron Oriel pins them.
    fn chrome_pinned(&self) -> bool {
        self.entry().is_video() && !self.video_playing
    }

    /// `revealChrome`: the controls show, and fade again once left alone.
    pub fn reveal_chrome(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        // The executor's clock, which a test can move on.
        self.last_activity = cx.background_executor().now();
        if !self.chrome_visible {
            self.set_chrome_visible(true, cx);
        }
        if self._idle.is_none() && !self.chrome_pinned() {
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
                    if !this.chrome_pinned() {
                        this.set_chrome_visible(false, cx);
                        oriel_media::video::hide_pointer_until_it_moves();
                    }
                })
                .ok();
            }));
        }
    }

    fn set_chrome_visible(&mut self, visible: bool, cx: &mut Context<Self>) {
        self.chrome_visible = visible;
        if let Some((_, player)) = &self.player {
            player.update(cx, |player, cx| player.set_chrome_visible(visible, cx));
        }
        cx.notify();
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
            player.set_chrome_visible(self.chrome_visible, cx)
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
                    this.chrome_pin_changed(window, cx);
                }
            }),
        ];
        self.video_playing = player.read(cx).is_playing();
        self.player = Some((ix, player));
    }

    /// The video shown started or stopped, or the item changed: a paused video keeps the
    /// controls, and anything else lets them fade.
    fn chrome_pin_changed(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.chrome_pinned() {
            self._idle = None;
            if !self.chrome_visible {
                self.set_chrome_visible(true, cx);
            }
        } else {
            self.reveal_chrome(window, cx);
        }
    }

    /// Steps `delta` items: around the ends when wrapping, else no further than them
    /// (`createShiftViewer`).
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

    /// The details under the name (`buildViewerDetails`): size, format, and for a video its
    /// length (ffprobe's, or the player's), its size and its codec.
    pub fn details(&self, cx: &App) -> String {
        let entry = self.entry();
        // `formatBytes`, media-domain's: steps of 1024.
        let mut details = vec![
            format_bytes(entry.size() as f64),
            entry.extension().to_uppercase(),
        ];
        if entry.is_video() {
            let probe = self.probes.get(&self.index);
            let duration_ms = probe
                .and_then(|probe| probe.duration_ms)
                .filter(|duration| *duration > 0)
                .or_else(|| {
                    self.player
                        .as_ref()
                        .filter(|(ix, _)| *ix == self.index)
                        .and_then(|(_, player)| player.read(cx).duration())
                        .map(|duration| duration.as_millis() as u64)
                        .filter(|duration| *duration > 0)
                });
            if let Some(duration_ms) = duration_ms {
                details.push(format_duration(duration_ms));
            }
            if let Some(probe) = probe {
                if let (Some(width), Some(height)) = (probe.width, probe.height) {
                    details.push(format!("{width}x{height}"));
                }
                if let Some(codec) = &probe.codec {
                    details.push(codec.clone());
                }
            }
        }
        details.join(" · ")
    }

    /// Asks ffprobe about the video shown, once.
    fn probe(&mut self, cx: &mut Context<Self>) {
        let ix = self.index;
        if self.probes.contains_key(&ix) {
            return;
        }
        let entry = self.entry().clone();
        self._probe = Some(cx.spawn(async move |this, cx| {
            let probe = cx
                .background_spawn(async move {
                    ViewMediaTools::shared().probe_video(
                        entry.path(),
                        entry.modified_ms(),
                        entry.size(),
                    )
                })
                .await;
            if let Some(probe) = probe {
                this.update(cx, |this, cx| {
                    this.probes.insert(ix, probe);
                    cx.notify();
                })
                .ok();
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
                self.player = None;
                self.player_subscriptions.clear();
                self.video_playing = false;
            }
        }
        self.chrome_pin_changed(window, cx);

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

/// `mm:ss`, as `formatDuration` writes a video's length in the viewer's details.
fn format_duration(ms: u64) -> String {
    let seconds = ms / 1000;
    format!("{:02}:{:02}", seconds / 60, seconds % 60)
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

        // The viewer is a dark room for the picture in either theme, as Electron Oriel's is, so
        // its ground and its text are black and white rather than the theme's surfaces.
        let viewer = cx.entity().downgrade();
        let shown_file = entry.path().to_path_buf();
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
            .on_key_up(cx.listener(|this, event: &KeyUpEvent, window, cx| {
                this.with_player(window, cx, |player, window, cx| {
                    player.on_key_up(event, window, cx);
                });
            }))
            // Any key brings the controls back, as `useViewerKeyboardControls` does first.
            .capture_key_down(cx.listener(|this, _, window, cx| this.reveal_chrome(window, cx)))
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
            .when(self.chrome_visible, |this| {
                this.child(
                    // macOS draws the window buttons over the top left, so the title starts to
                    // their right, as `ViewerChrome` pads it; full screen has none.
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
                        // `.viewer-scrim-top`: black at 70% fading out, so the title reads over
                        // a light picture.
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
                            Button::new("viewer-copy-path")
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
                            Button::new("viewer-reveal")
                                .ghost()
                                .icon(Icon::new(IconName::FolderOpen))
                                .tooltip("Reveal in folder")
                                .accessibility_label("Reveal in folder")
                                .on_click(move |_, _, cx| cx.reveal_path(&revealed)),
                        )
                        .child(
                            Button::new("viewer-show-in-tidy")
                                .ghost()
                                .icon(Icon::new(IconName::WandSparkles))
                                .tooltip("Show in Tidy")
                                .accessibility_label("Show in Tidy")
                                .on_click(cx.listener(move |_, _, _, cx| {
                                    cx.emit(ViewerEvent::ShowInTidy(shown_file.clone()));
                                })),
                        )
                        .child(
                            Button::new("viewer-fullscreen")
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
                                .on_click(|_, window, _| window.toggle_fullscreen()),
                        )
                        .child(
                            Button::new("viewer-close")
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
                .child(step_button(
                    "viewer-next",
                    IconName::ChevronRight,
                    "Next item",
                    self.can_step(1),
                    cx.listener(|this, _, window, cx| this.step(1, window, cx)),
                ))
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
            Button::new(id)
                .ghost()
                .large()
                .icon(Icon::new(icon))
                .tooltip(label)
                .accessibility_label(label)
                .disabled(!enabled)
                .on_click(on_click),
        )
}

#[cfg(test)]
mod tests {
    use super::format_duration;

    /// A video's length reads as `formatDuration` writes it in the details: minutes past an hour.
    #[test]
    fn writes_lengths_as_electron_oriel_does() {
        assert_eq!(format_duration(4_000), "00:04");
        assert_eq!(format_duration(3_725_000), "62:05");
    }
}
