//! The capsule player: one video filling the view, fitted and letterboxed, with GPUI-drawn
//! controls over it in one low capsule, as Electron Oriel's `VideoPlayerChrome`: back and
//! forward 5 s, play or pause, the elapsed time, the scrubber, the length, then the volume and
//! the playback speed, each opening a small panel straight up from the capsule.
//!
//! The player holds what `useViewerVideoModel` holds: the volume and mute, the speed, whether it
//! loops, and the held 2×. It applies them to the engine and says when the owner changed the
//! volume or picked a speed ([`CapsulePlayerEvent`]), so the viewer can keep them for the next
//! video: the volume and mute across launches, the speed for the viewer's session.
//!
//! Keys, while the player has focus: Space or 2 plays or pauses, 1 and 3 skip 5 s, M mutes, and
//! 4 plays at 2× while it is held. ← and → are the viewer's, which steps to the previous or next
//! item, as Electron Oriel's viewer does. A click on the picture plays or pauses. libmpv does the
//! playing (`oriel_media::mpv`), or AVPlayer (`oriel_media::video`) with `ORIEL_RS_VIDEO=avplayer`
//! or where libmpv cannot be loaded; this view only draws its picture and sends it commands.
//!
//! The file names only `gpui_kit` and `oriel_media`, so the media crate's spike examples can
//! build it as it is.

use std::path::{Path, PathBuf};
use std::time::Duration;

use gpui_kit::assets::IconName;
use gpui_kit::base::slider::{SliderEvent, SliderState};
use gpui_kit::base::{Slider, SliderIndicator, SliderTrack};
use gpui_kit::component::Icon;
use gpui_kit::component::tooltip::Tooltip;
use gpui_kit::{
    App, AppContext as _, Context, Entity, EventEmitter, FocusHandle, Focusable, FontWeight,
    Global, InteractiveElement as _, IntoElement, KeyBinding, KeyUpEvent, MouseButton,
    MouseMoveEvent, ParentElement as _, Render, Role, SharedString,
    StatefulInteractiveElement as _, Styled as _, Subscription, TestSupportExt as _, Window,
    actions, div, prelude::FluentBuilder as _, px, relative, rgba,
};
use oriel_media::mpv::{AnyPlayer, MpvPlayer, pump_frames};
use oriel_media::video::{SeekMode, VideoError, VideoPlayer};

actions!(
    capsule_player,
    [
        /// Play or pause (Space or 2).
        TogglePlayback,
        /// Back 5 s (1).
        SkipBack,
        /// Forward 5 s (3).
        SkipForward,
        /// Mute or unmute (M).
        ToggleMute,
        /// Play at 2× until the key is let go (4).
        HoldSpeed
    ]
);

pub(crate) const KEY_CONTEXT: &str = "CapsulePlayer";
/// The key that plays at 2× while it is held (`HOTKEYS.videoTemporarySpeed`).
pub(crate) const HOLD_KEY: &str = "4";
/// Electron Oriel's `VIDEO_SKIP_SECONDS`.
const SKIP_SECONDS: f64 = 5.;
/// How far short of the end a skip stops, in seconds (`commitSeek`'s `total - 0.05`).
const END_MARGIN: f64 = 0.05;
/// The scrubber's resolution, as a share of the video: a tenth of a second in a 17-minute one.
const SCRUB_STEP: f32 = 0.0001;
/// The speeds the speed panel offers (`SPEEDS`).
pub const SPEEDS: [f32; 6] = [0.5, 0.75, 1., 1.25, 1.5, 2.];
/// The speed a held 4 plays at.
pub const HELD_SPEED: f32 = 2.;

/// The capsule is dark on any theme, as the picture behind it is: Electron's `zinc-900/65`,
/// its `white/10` ring, `violet-400` for the played part of the timeline and `violet-300` for a
/// control that is on.
const CAPSULE: u32 = 0x18181ba6;
const CAPSULE_RING: u32 = 0xffffff1a;
const PLAYED: u32 = 0xa78bfaff;
const ACTIVE: u32 = 0xc4b5fdff;
/// A panel over the picture: `zinc-900/90`.
const PANEL: u32 = 0x18181be6;
const PANEL_GAP: f32 = 12.;
/// A panel's corner radius.
const PANEL_RADIUS: f32 = 16.;
/// How far a panel's rows sit inside its border, so their fills keep clear of its corners.
const PANEL_INSET: f32 = 4.;
/// A row's corner radius in a panel: the panel's, less the inset and the 1 px border, so the
/// two curves run concentric (the Design Guides' nested radii).
const PANEL_ROW_RADIUS: f32 = PANEL_RADIUS - PANEL_INSET - 1.;
/// The volume thumb's diameter. Its travel reaches half of it past each end of the track.
const VOLUME_THUMB: f32 = 14.;
/// The volume track's length.
const VOLUME_TRACK: f32 = 112.;
const VOLUME_PANEL_WIDTH: f32 = 48.;
const SPEED_PANEL_WIDTH: f32 = 72.;
const SPEED_BUTTON_WIDTH: f32 = 36.;

/// Marks that the player's keys are bound, so the first player binds them for the app.
struct KeysBound;

impl Global for KeysBound {}

/// The player's keys, bound once for the app. They live in the player's own key context, so
/// they reach the video shown while the player has focus.
fn bind_keys(cx: &mut App) {
    if cx.has_global::<KeysBound>() {
        return;
    }
    cx.set_global(KeysBound);
    cx.bind_keys(key_bindings(KEY_CONTEXT));
}

/// The player's keys in `context`: the player's own, and the viewer's, which hands them to the
/// player when something else in the viewer has focus.
pub(crate) fn key_bindings(context: &'static str) -> [KeyBinding; 6] {
    let context = Some(context);
    [
        KeyBinding::new("space", TogglePlayback, context),
        KeyBinding::new("2", TogglePlayback, context),
        KeyBinding::new("1", SkipBack, context),
        KeyBinding::new("3", SkipForward, context),
        KeyBinding::new("m", ToggleMute, context),
        KeyBinding::new(HOLD_KEY, HoldSpeed, context),
    ]
}

/// How a player starts: View's settings and what the viewer kept from the last video.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PlayerOptions {
    /// Play at once ("Autoplay videos in viewer").
    pub autoplay: bool,
    /// Play again from the start at the end ("Loop videos").
    pub looping: bool,
    /// 0 to 1.
    pub volume: f32,
    pub muted: bool,
    /// 1 is normal.
    pub speed: f32,
}

impl Default for PlayerOptions {
    fn default() -> Self {
        Self {
            autoplay: true,
            looping: false,
            volume: 1.,
            muted: false,
            speed: 1.,
        }
    }
}

/// What the owner changed, for the viewer to keep.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum CapsulePlayerEvent {
    /// The volume or mute changed: Electron Oriel keeps both across launches.
    VolumeChanged { volume: f32, muted: bool },
    /// The owner picked a speed (never the held 2×): kept while the viewer is open.
    SpeedChanged(f32),
}

/// The panel the capsule has open.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CapsulePanel {
    Volume,
    Speed,
}

/// The interface the viewer relies on: built for a path, rendered as a view.
pub struct CapsulePlayer {
    path: PathBuf,
    video: Result<AnyPlayer, VideoError>,
    focus: FocusHandle,
    scrubber: Entity<SliderState>,
    volume_slider: Entity<SliderState>,
    /// Whether a scrub paused the video, to resume it when the scrub ends.
    resume_after_scrub: bool,
    volume: f32,
    muted: bool,
    /// The speed playing runs at, the held 2× included.
    speed: f32,
    /// The speed chosen before 4 was held, while it is.
    held_from: Option<f32>,
    panel: Option<CapsulePanel>,
    /// Where the pointer is along the scrubber, as a share of it, while it hovers there.
    scrub_hover: Option<f32>,
    /// Whether the controls show: the viewer hides them while a video plays untouched.
    chrome_visible: bool,
    _subscriptions: Vec<Subscription>,
}

impl EventEmitter<CapsulePlayerEvent> for CapsulePlayer {}

impl CapsulePlayer {
    /// Opens `path` and starts playing it, with the player focused for its keys.
    pub fn new(path: PathBuf, window: &mut Window, cx: &mut Context<Self>) -> Self {
        Self::open(path, PlayerOptions::default(), window, cx)
    }

    /// Opens `path` as `options` say, with the player focused for its keys.
    pub fn open(
        path: PathBuf,
        options: PlayerOptions,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        bind_keys(cx);
        let volume = options.volume.clamp(0., 1.);
        let mut video = AnyPlayer::open(&path);
        if let Ok(video) = &mut video {
            video.set_volume(volume);
            video.set_muted(options.muted);
            video.set_looping(options.looping);
            if options.speed != 1. {
                video.set_rate(options.speed);
            }
            if options.autoplay {
                video.play();
            }
        }
        let scrubber = cx.new(|_| SliderState::new().min(0.).max(1.).step(SCRUB_STEP));
        let volume_slider = cx.new(|_| SliderState::new().min(0.).max(1.).step(0.01));
        let subscriptions = vec![
            cx.subscribe_in(&scrubber, window, Self::on_scrub),
            cx.subscribe_in(&volume_slider, window, Self::on_volume_drag),
            // A held 4 whose key-up goes to another app would otherwise play at 2× for good.
            cx.observe_window_activation(window, |this, window, cx| {
                if !window.is_window_active() {
                    this.end_hold(window, cx);
                }
            }),
        ];
        let focus = cx.focus_handle();
        focus.focus(window, cx);
        Self {
            path,
            video,
            focus,
            scrubber,
            volume_slider,
            resume_after_scrub: false,
            volume,
            muted: options.muted,
            speed: options.speed,
            held_from: None,
            panel: None,
            scrub_hover: None,
            chrome_visible: true,
            _subscriptions: subscriptions,
        }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// The video's length, once it is known.
    pub fn duration(&self) -> Option<Duration> {
        self.video.as_ref().ok().and_then(AnyPlayer::duration)
    }

    /// Where playback is, or where the newest seek is going.
    pub fn position(&self) -> Duration {
        self.video
            .as_ref()
            .map(AnyPlayer::position)
            .unwrap_or_default()
    }

    /// Whether the video is playing.
    pub fn is_playing(&self) -> bool {
        self.video.as_ref().is_ok_and(AnyPlayer::is_playing)
    }

    /// The volume set, 0 to 1, whether or not it is muted.
    pub fn volume(&self) -> f32 {
        self.volume
    }

    pub fn is_muted(&self) -> bool {
        self.muted
    }

    /// The speed it plays at, the held 2× included.
    pub fn speed(&self) -> f32 {
        self.speed
    }

    /// Whether 4 is held, playing it at 2×.
    pub fn is_holding_speed(&self) -> bool {
        self.held_from.is_some()
    }

    pub fn is_looping(&self) -> bool {
        self.video.as_ref().is_ok_and(AnyPlayer::is_looping)
    }

    /// The panel the capsule has open.
    pub fn panel(&self) -> Option<CapsulePanel> {
        self.panel
    }

    /// Why the video does not play, when it does not: the viewer shows this over the poster.
    pub fn error(&self) -> Option<&VideoError> {
        match &self.video {
            Ok(video) => video.error(),
            Err(error) => Some(error),
        }
    }

    /// The player itself, for a caller that measures or drives it.
    pub fn video_mut(&mut self) -> Option<&mut VideoPlayer> {
        self.video.as_mut().ok().and_then(AnyPlayer::av_player_mut)
    }

    /// The libmpv player, when it is the one playing.
    pub fn mpv_mut(&mut self) -> Option<&mut MpvPlayer> {
        self.video.as_mut().ok().and_then(AnyPlayer::mpv_mut)
    }

    /// Shows or hides the controls. The viewer hides them while a video plays untouched; a
    /// hidden capsule takes no presses, so a click anywhere reaches the picture.
    pub fn set_chrome_visible(&mut self, visible: bool, cx: &mut Context<Self>) {
        if self.chrome_visible != visible {
            self.chrome_visible = visible;
            cx.notify();
        }
    }

    /// Runs `command` on the video, if it opened, then keeps its pictures coming.
    fn command(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
        command: impl FnOnce(&mut AnyPlayer),
    ) {
        let Ok(video) = &mut self.video else {
            return;
        };
        command(video);
        pump_frames(self, Self::video_of, window, cx);
        cx.notify();
    }

    fn video_of(&mut self) -> &mut AnyPlayer {
        self.video
            .as_mut()
            .expect("frames are pumped only for a video that opened")
    }

    pub fn toggle_playback(
        &mut self,
        _: &TogglePlayback,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.command(window, cx, AnyPlayer::toggle_playback);
    }

    /// Pauses the video, as Electron Oriel pauses a hidden mode's media; it stays paused when
    /// the mode shows again.
    pub fn pause(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.end_hold(window, cx);
        if self.is_playing() {
            self.command(window, cx, AnyPlayer::pause);
        }
    }

    pub fn skip_back(&mut self, _: &SkipBack, window: &mut Window, cx: &mut Context<Self>) {
        self.skip(-SKIP_SECONDS, window, cx);
    }

    pub fn skip_forward(&mut self, _: &SkipForward, window: &mut Window, cx: &mut Context<Self>) {
        self.skip(SKIP_SECONDS, window, cx);
    }

    /// `skip`, through `commitSeek`: `seconds` from where it is, on the exact frame, and never
    /// past the last 50 ms, so a skip near the end neither ends nor loops the video.
    fn skip(&mut self, seconds: f64, window: &mut Window, cx: &mut Context<Self>) {
        self.command(window, cx, |video| {
            let target = (video.position().as_secs_f64() + seconds).max(0.);
            let target = match video.duration() {
                Some(duration) => target.min((duration.as_secs_f64() - END_MARGIN).max(0.)),
                None => target,
            };
            video.seek(Duration::from_secs_f64(target), SeekMode::Exact);
        });
    }

    pub fn toggle_mute(&mut self, _: &ToggleMute, window: &mut Window, cx: &mut Context<Self>) {
        self.set_muted(!self.muted, window, cx);
    }

    fn set_muted(&mut self, muted: bool, window: &mut Window, cx: &mut Context<Self>) {
        self.muted = muted;
        self.command(window, cx, |video| video.set_muted(muted));
        self.volume_changed(cx);
    }

    /// `changeVolume`: the level, clamped, and unmuted when it is above nothing.
    pub fn set_volume(&mut self, volume: f32, window: &mut Window, cx: &mut Context<Self>) {
        self.apply_volume(volume, window, cx);
        self.volume_changed(cx);
    }

    /// Sets the level without saying so: a drag says it once, when it lets go, rather than at
    /// every step, so the level is kept once per change.
    fn apply_volume(&mut self, volume: f32, window: &mut Window, cx: &mut Context<Self>) {
        let volume = volume.clamp(0., 1.);
        let unmute = volume > 0. && self.muted;
        self.volume = volume;
        if unmute {
            self.muted = false;
        }
        self.command(window, cx, |video| {
            video.set_volume(volume);
            if unmute {
                video.set_muted(false);
            }
        });
    }

    fn volume_changed(&mut self, cx: &mut Context<Self>) {
        cx.emit(CapsulePlayerEvent::VolumeChanged {
            volume: self.volume,
            muted: self.muted,
        });
    }

    /// `applySpeed` from the speed panel: the speed the video plays at from now on. A held 4
    /// lets go to the speed picked.
    pub fn set_speed(&mut self, speed: f32, window: &mut Window, cx: &mut Context<Self>) {
        self.held_from = None;
        self.apply_speed(speed, window, cx);
        cx.emit(CapsulePlayerEvent::SpeedChanged(speed));
    }

    fn apply_speed(&mut self, speed: f32, window: &mut Window, cx: &mut Context<Self>) {
        self.speed = speed;
        self.command(window, cx, |video| video.set_rate(speed));
    }

    /// `beginHoldBoost`: 2× until the key is let go, then the speed chosen before. A key held
    /// down repeats; only the first press counts.
    pub fn hold_speed(&mut self, _: &HoldSpeed, window: &mut Window, cx: &mut Context<Self>) {
        if self.held_from.is_some() {
            return;
        }
        self.held_from = Some(self.speed);
        self.apply_speed(HELD_SPEED, window, cx);
    }

    /// `endHoldBoost`.
    pub fn end_hold(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(speed) = self.held_from.take() {
            self.apply_speed(speed, window, cx);
        }
    }

    /// Lets go of a held 4 when its key comes up.
    pub fn on_key_up(&mut self, event: &KeyUpEvent, window: &mut Window, cx: &mut Context<Self>) {
        if event.keystroke.key == HOLD_KEY {
            self.end_hold(window, cx);
        }
    }

    /// Opens `panel`, or closes it when it is the one open.
    pub fn toggle_panel(&mut self, panel: CapsulePanel, cx: &mut Context<Self>) {
        self.panel = (self.panel != Some(panel)).then_some(panel);
        cx.notify();
    }

    fn close_panel(&mut self, cx: &mut Context<Self>) {
        if self.panel.take().is_some() {
            cx.notify();
        }
    }

    /// A drag along the scrubber shows keyframes as it goes, with the video held still, and
    /// lands on the exact frame where it is let go.
    fn on_scrub(
        &mut self,
        _: &Entity<SliderState>,
        event: &SliderEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let (fraction, mode) = match event {
            SliderEvent::Change(value) => (value.end(), SeekMode::Fast),
            SliderEvent::Release(value) => (value.end(), SeekMode::Exact),
        };
        let releasing = mode == SeekMode::Exact;
        let mut resume = self.resume_after_scrub;
        self.command(window, cx, |video| {
            let Some(duration) = video.duration() else {
                return;
            };
            if !releasing && video.is_playing() {
                video.pause();
                resume = true;
            }
            video.seek(duration.mul_f32(fraction.clamp(0., 1.)), mode);
            if releasing && resume {
                video.play();
                resume = false;
            }
        });
        self.resume_after_scrub = resume;
    }

    /// The volume panel's slider: a press or a drag sets the level as it goes, and the level is
    /// kept when it lets go.
    fn on_volume_drag(
        &mut self,
        _: &Entity<SliderState>,
        event: &SliderEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        match event {
            SliderEvent::Change(value) => self.apply_volume(value.end(), window, cx),
            SliderEvent::Release(value) => self.set_volume(value.end(), window, cx),
        }
    }

    /// The level the volume control shows: nothing while muted (`model.muted ? 0 : volume`).
    fn level(&self) -> f32 {
        if self.muted { 0. } else { self.volume }
    }
}

impl Focusable for CapsulePlayer {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}

impl Render for CapsulePlayer {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        if self.video.is_ok() {
            pump_frames(self, Self::video_of, window, cx);
        }
        let error = self
            .error()
            .map(|error| SharedString::from(error.to_string()));
        let controls = error.is_none() && self.chrome_visible;

        let picture = div()
            .id("capsule-picture")
            .absolute()
            .inset_0()
            .flex()
            .items_center()
            .justify_center()
            .when_some(
                self.video.as_ref().ok().and_then(AnyPlayer::picture),
                |this, picture| this.child(picture),
            )
            .when_some(error.clone(), |this, error| {
                this.child(
                    div()
                        .px_4()
                        .text_size(px(14.))
                        .text_color(gpui_kit::white().opacity(0.7))
                        .child(error),
                )
            })
            .on_click(cx.listener(|this, _, window, cx| {
                this.toggle_playback(&TogglePlayback, window, cx);
            }));

        div()
            .id("capsule-player")
            .track_focus(&self.focus)
            .key_context(KEY_CONTEXT)
            .on_action(cx.listener(Self::toggle_playback))
            .on_action(cx.listener(Self::skip_back))
            .on_action(cx.listener(Self::skip_forward))
            .on_action(cx.listener(Self::toggle_mute))
            .on_action(cx.listener(Self::hold_speed))
            .on_key_up(cx.listener(Self::on_key_up))
            .relative()
            .size_full()
            .overflow_hidden()
            .bg(gpui_kit::black())
            .child(picture)
            // While a panel is open, a press anywhere but the capsule and its panels closes it,
            // as `useOutsideClose` does; the press still reaches what is under it.
            .when(controls && self.panel.is_some(), |this| {
                this.child(
                    div()
                        .id("capsule-panel-backdrop")
                        .absolute()
                        .inset_0()
                        .on_mouse_down(
                            MouseButton::Left,
                            cx.listener(|this, _, _, cx| this.close_panel(cx)),
                        ),
                )
            })
            .when(self.held_from.is_some(), |this| this.child(held_badge()))
            .when(controls, |this| this.child(self.render_capsule(cx)))
    }
}

impl CapsulePlayer {
    fn render_capsule(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let video = self.video.as_ref().ok();
        let playing = video.is_some_and(AnyPlayer::is_playing);
        let position = video.map(AnyPlayer::position).unwrap_or_default();
        let duration = video.and_then(AnyPlayer::duration);
        let played = match duration {
            Some(duration) if !duration.is_zero() => {
                (position.as_secs_f64() / duration.as_secs_f64()).clamp(0., 1.) as f32
            }
            _ => 0.,
        };

        let row = div()
            .flex()
            .flex_row()
            .items_center()
            .gap(px(2.))
            .child(
                capsule_button("skip-back", IconName::RotateCcw, "Back 5 seconds", "1", 32.)
                    .child(skip_count())
                    .on_click(cx.listener(|this, _, window, cx| {
                        this.skip_back(&SkipBack, window, cx);
                    }))
                    .test_support(),
            )
            .child(
                capsule_button(
                    "play-pause",
                    if playing {
                        IconName::Pause
                    } else {
                        IconName::Play
                    },
                    if playing { "Pause" } else { "Play" },
                    "Space",
                    40.,
                )
                .on_click(cx.listener(|this, _, window, cx| {
                    this.toggle_playback(&TogglePlayback, window, cx);
                }))
                .test_support(),
            )
            .child(
                capsule_button(
                    "skip-forward",
                    IconName::RotateCw,
                    "Forward 5 seconds",
                    "3",
                    32.,
                )
                .child(skip_count())
                .on_click(cx.listener(|this, _, window, cx| {
                    this.skip_forward(&SkipForward, window, cx);
                }))
                .test_support(),
            );

        let timeline = div()
            .flex()
            .flex_row()
            .flex_1()
            .min_w_0()
            .items_center()
            .gap_2()
            .px_1()
            .text_size(px(12.))
            .text_color(gpui_kit::white().opacity(0.8))
            .child(div().w(px(36.)).flex_shrink_0().child(clock(position)))
            .child(self.render_scrubber(played, duration, cx))
            .child(
                div()
                    .w(px(36.))
                    .flex_shrink_0()
                    .text_right()
                    .child(duration.map(clock).unwrap_or_else(|| "–:––".into())),
            );

        let settings = div()
            .flex()
            .flex_row()
            .items_center()
            .gap(px(2.))
            .child(self.render_volume(cx))
            .child(self.render_speed(cx));

        div()
            .absolute()
            .left_0()
            .right_0()
            .bottom(px(16.))
            .flex()
            .justify_center()
            .px_3()
            .child(
                div()
                    .id("capsule")
                    // A press on the controls is not a click on the picture.
                    .occlude()
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap_1()
                    .w_full()
                    .max_w(px(896.))
                    .h(px(48.))
                    .px_3()
                    .rounded_full()
                    .bg(rgba(CAPSULE))
                    .border_1()
                    .border_color(rgba(CAPSULE_RING))
                    .shadow_2xl()
                    .child(row)
                    .child(timeline)
                    .child(settings),
            )
    }

    /// The timeline: a 6 px track with the played part filled and a thumb at the playhead, in a
    /// 32 px band that takes the press, and the time under the pointer above it while it hovers.
    /// The thumb follows the video, not the slider's own value, so playing never writes to the
    /// slider while the window draws.
    fn render_scrubber(
        &self,
        played: f32,
        duration: Option<Duration>,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let hover = self.scrub_hover.zip(duration);
        let slider = Slider::new(&self.scrubber)
            .accessibility_label("Video seek position")
            .flex()
            .w_full()
            .items_center()
            .child(
                SliderTrack::new(&self.scrubber)
                    .relative()
                    .flex()
                    .items_center()
                    .w_full()
                    .h(px(32.))
                    .child(
                        SliderIndicator::new(&self.scrubber)
                            .relative()
                            .w_full()
                            .h(px(6.))
                            .rounded_full()
                            .bg(gpui_kit::white().opacity(0.25))
                            .child(
                                div()
                                    .absolute()
                                    .top_0()
                                    .bottom_0()
                                    .left_0()
                                    .w(relative(played))
                                    .rounded_full()
                                    .bg(rgba(PLAYED)),
                            )
                            .child(
                                div()
                                    .absolute()
                                    .top(px(-4.))
                                    .left(relative(played))
                                    .ml(px(-7.))
                                    .size(px(14.))
                                    .rounded_full()
                                    .bg(gpui_kit::white())
                                    .shadow_md(),
                            )
                            .when_some(hover, |this, (along, duration)| {
                                this.child(
                                    div()
                                        .absolute()
                                        .bottom(px(16.))
                                        .left(relative(along))
                                        .ml(px(-20.))
                                        .w(px(40.))
                                        .flex()
                                        .justify_center()
                                        .child(
                                            div()
                                                .px(px(6.))
                                                .py(px(2.))
                                                .rounded_md()
                                                .bg(rgba(PANEL))
                                                .border_1()
                                                .border_color(rgba(CAPSULE_RING))
                                                .text_size(px(11.))
                                                .font_weight(FontWeight::MEDIUM)
                                                .text_color(gpui_kit::white())
                                                .child(clock(duration.mul_f32(along))),
                                        ),
                                )
                            }),
                    ),
            );
        // The pointer's place along the track, for the time above it.
        div()
            .id("scrubber")
            .flex()
            .flex_1()
            .min_w_0()
            .items_center()
            .on_mouse_move(cx.listener(|this, event: &MouseMoveEvent, _, cx| {
                let bounds = this.scrubber.read(cx).bounds();
                let width = f32::from(bounds.size.width);
                if width > 0. {
                    let along = f32::from(event.position.x - bounds.left()) / width;
                    this.scrub_hover = Some(along.clamp(0., 1.));
                    cx.notify();
                }
            }))
            .on_hover(cx.listener(|this, hovered: &bool, _, cx| {
                if !hovered && this.scrub_hover.take().is_some() {
                    cx.notify();
                }
            }))
            .child(slider)
    }

    /// The volume button, and its panel when open: a vertical level, the percentage, and mute.
    fn render_volume(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let open = self.panel == Some(CapsulePanel::Volume);
        let level = self.level();
        let trigger = capsule_button("volume", volume_icon(level), "Volume", "", 32.)
            .aria_expanded(open)
            .when(open, |this| this.text_color(rgba(ACTIVE)))
            .on_click(cx.listener(|this, _, _, cx| this.toggle_panel(CapsulePanel::Volume, cx)))
            .test_support();
        let percent = (level * 100.).round();

        div()
            .relative()
            .flex_shrink_0()
            .child(trigger)
            .when(open, |this| {
                this.child(
                    popup(32., VOLUME_PANEL_WIDTH, 32.)
                        .id("volume-panel")
                        .role(Role::Group)
                        .test_support()
                        .aria_label("Volume")
                        .flex()
                        .flex_col()
                        .items_center()
                        .gap_2()
                        .px_2()
                        .pt_3()
                        .pb_2()
                        .child(
                            // The thumb's half at either end is room the track keeps clear,
                            // so at 100% it sits inside the panel's top rather than at its
                            // edge, and at 0% clear of the percentage.
                            div().py(px(VOLUME_THUMB / 2.)).child(
                                Slider::new(&self.volume_slider)
                                    .vertical()
                                    .accessibility_label("Volume")
                                    .child(
                                        SliderTrack::new(&self.volume_slider)
                                            .axis(gpui_kit::Axis::Vertical)
                                            .flex()
                                            .justify_center()
                                            .w(px(32.))
                                            .h(px(VOLUME_TRACK))
                                            .child(
                                                SliderIndicator::new(&self.volume_slider)
                                                    .relative()
                                                    .w(px(6.))
                                                    .h_full()
                                                    .rounded_full()
                                                    .bg(gpui_kit::white().opacity(0.25))
                                                    .child(
                                                        div()
                                                            .absolute()
                                                            .left_0()
                                                            .right_0()
                                                            .bottom_0()
                                                            .h(relative(level))
                                                            .rounded_full()
                                                            .bg(gpui_kit::white()),
                                                    )
                                                    .child(
                                                        div()
                                                            .absolute()
                                                            .bottom(relative(level))
                                                            .left(px(-4.))
                                                            .mb(px(-VOLUME_THUMB / 2.))
                                                            .size(px(VOLUME_THUMB))
                                                            .rounded_full()
                                                            .bg(gpui_kit::white())
                                                            .shadow_md(),
                                                    ),
                                            ),
                                    ),
                            ),
                        )
                        .child(
                            div()
                                .id("volume-level")
                                .role(Role::Status)
                                .test_support()
                                .aria_label(SharedString::from(format!("{percent}%")))
                                .text_size(px(11.))
                                .text_color(gpui_kit::white().opacity(0.6))
                                .child(format!("{percent}%")),
                        )
                        .child(
                            capsule_button(
                                "mute",
                                volume_icon(if self.muted { 0. } else { 1. }),
                                if self.muted { "Unmute" } else { "Mute" },
                                "M",
                                32.,
                            )
                            .when(self.muted, |this| this.text_color(rgba(ACTIVE)))
                            .on_click(cx.listener(|this, _, window, cx| {
                                this.toggle_mute(&ToggleMute, window, cx);
                            }))
                            .test_support(),
                        ),
                )
            })
    }

    /// The speed button, reading the speed, and its panel when open: the speeds, fastest first.
    fn render_speed(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let open = self.panel == Some(CapsulePanel::Speed);
        let speed = self.speed;
        let label = format_speed(speed);
        let trigger = div()
            .id("speed")
            .role(Role::Button)
            .test_support()
            .aria_label("Playback speed")
            .aria_expanded(open)
            .flex()
            .flex_shrink_0()
            .items_center()
            .justify_center()
            .h(px(32.))
            .min_w(px(SPEED_BUTTON_WIDTH))
            .px(px(6.))
            .rounded_full()
            .text_size(px(11.))
            .font_weight(FontWeight::SEMIBOLD)
            .text_color(if speed == 1. && !open {
                gpui_kit::white().opacity(0.9)
            } else {
                rgba(ACTIVE).into()
            })
            .hover(|style| style.bg(gpui_kit::white().opacity(0.1)))
            .tooltip(|window, cx| Tooltip::new("Playback speed").build(window, cx))
            .on_click(cx.listener(|this, _, _, cx| this.toggle_panel(CapsulePanel::Speed, cx)))
            .child(label);

        div()
            .relative()
            .flex_shrink_0()
            .child(trigger)
            .when(open, |this| {
                this.child(
                    popup(SPEED_BUTTON_WIDTH, SPEED_PANEL_WIDTH, 32.)
                        .id("speed-panel")
                        .role(Role::Menu)
                        .test_support()
                        .aria_label("Playback speed")
                        .flex()
                        .flex_col()
                        .gap(px(2.))
                        .p(px(PANEL_INSET))
                        .children(SPEEDS.iter().rev().map(|&choice| {
                            let chosen = choice == speed;
                            div()
                                .id(SharedString::from(format!("speed-{choice}")))
                                .role(Role::MenuItemRadio)
                                .test_support()
                                .aria_label(format_speed(choice))
                                .aria_selected(chosen)
                                .px_3()
                                .py(px(5.))
                                .rounded(px(PANEL_ROW_RADIUS))
                                .text_center()
                                .text_size(px(14.))
                                .when(chosen, |this| {
                                    this.font_weight(FontWeight::SEMIBOLD)
                                        .text_color(rgba(ACTIVE))
                                        .bg(gpui_kit::white().opacity(0.08))
                                })
                                .when(!chosen, |this| {
                                    this.text_color(gpui_kit::white().opacity(0.9))
                                })
                                .hover(|style| style.bg(gpui_kit::white().opacity(0.1)))
                                .on_click(cx.listener(move |this, _, window, cx| {
                                    this.set_speed(choice, window, cx);
                                    this.close_panel(cx);
                                }))
                                .child(format_speed(choice))
                        })),
                )
            })
    }
}

/// A panel straight up from a trigger `trigger_width` wide and `trigger_height` high, centred on
/// it and `width` wide.
fn popup(trigger_width: f32, width: f32, trigger_height: f32) -> gpui_kit::Div {
    div()
        .absolute()
        .bottom(px(trigger_height + PANEL_GAP))
        .left(px((trigger_width - width) / 2.))
        .w(px(width))
        .occlude()
        .rounded(px(PANEL_RADIUS))
        .bg(rgba(PANEL))
        .border_1()
        .border_color(rgba(CAPSULE_RING))
        .shadow_2xl()
}

/// "2×" over the picture, after the fast-forward mark, while 4 is held.
fn held_badge() -> impl IntoElement {
    div()
        .absolute()
        .top(px(80.))
        .left_0()
        .right_0()
        .flex()
        .justify_center()
        .child(
            div()
                .id("held-speed")
                .role(Role::Status)
                .test_support()
                .aria_label(SharedString::from(format!(
                    "Playing at {}",
                    format_speed(HELD_SPEED)
                )))
                .flex()
                .flex_row()
                .items_center()
                .gap(px(6.))
                .px_3()
                .py(px(6.))
                .rounded_full()
                .bg(gpui_kit::black().opacity(0.6))
                .border_1()
                .border_color(gpui_kit::white().opacity(0.15))
                .text_size(px(14.))
                .font_weight(FontWeight::SEMIBOLD)
                .text_color(gpui_kit::white())
                .child(Icon::new(IconName::FastForward).size(px(16.)))
                .child(format_speed(HELD_SPEED)),
        )
}

/// A round icon button on the capsule, `size` px across, named for VoiceOver by `label`, with
/// the label and its key as the tooltip. Callers end it with `test_support()`, which tests find
/// it by, once its handlers are on.
fn capsule_button(
    id: &'static str,
    icon: IconName,
    label: &'static str,
    key: &'static str,
    size_px: f32,
) -> gpui_kit::Stateful<gpui_kit::Div> {
    let icon = Icon::new(icon).size(px(size_px / 2.));
    let tooltip: SharedString = if key.is_empty() {
        label.into()
    } else {
        format!("{label}  {key}").into()
    };
    div()
        .id(id)
        .role(Role::Button)
        .aria_label(label)
        .relative()
        .flex()
        .flex_shrink_0()
        .items_center()
        .justify_center()
        .size(px(size_px))
        .rounded_full()
        .text_color(gpui_kit::white().opacity(0.9))
        .hover(|style| {
            style
                .bg(gpui_kit::white().opacity(0.1))
                .text_color(gpui_kit::white())
        })
        .tooltip(move |window, cx| Tooltip::new(tooltip.clone()).build(window, cx))
        .child(icon)
}

/// `volumeIconFor`: crossed out at nothing, one wave below half, two waves from half up.
fn volume_icon(level: f32) -> IconName {
    if level == 0. {
        IconName::VolumeX
    } else if level < 0.5 {
        IconName::Volume1
    } else {
        IconName::Volume2
    }
}

/// The seconds a skip moves, inside its arrow, as Electron's `SkipButton` draws it.
fn skip_count() -> impl IntoElement {
    div()
        .absolute()
        .inset_0()
        .flex()
        .items_center()
        .justify_center()
        .pt(px(1.))
        .text_size(px(7.))
        .font_weight(FontWeight::BOLD)
        .child(SharedString::new_static("5"))
}

/// `formatSpeed`: "1×", "0.75×".
pub fn format_speed(speed: f32) -> SharedString {
    format!("{speed}×").into()
}

/// `m:ss`, or `h:mm:ss` past an hour, as Electron's `formatClock`.
fn clock(time: Duration) -> SharedString {
    let total = time.as_secs();
    let (hours, minutes, seconds) = (total / 3600, total % 3600 / 60, total % 60);
    if hours > 0 {
        format!("{hours}:{minutes:02}:{seconds:02}").into()
    } else {
        format!("{minutes}:{seconds:02}").into()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The capsule's times read as Electron Oriel's `formatClock` writes them.
    #[test]
    fn clocks_read_as_electron_oriels() {
        for (seconds, expected) in [
            (0, "0:00"),
            (65, "1:05"),
            (3599, "59:59"),
            (3725, "1:02:05"),
        ] {
            assert_eq!(clock(Duration::from_secs(seconds)), expected);
        }
        assert_eq!(clock(Duration::from_millis(59_999)), "0:59");
    }

    /// Speeds read as JavaScript writes the numbers: no trailing zeros.
    #[test]
    fn speeds_read_as_electron_oriels() {
        let labels: Vec<SharedString> = SPEEDS.iter().map(|&speed| format_speed(speed)).collect();
        assert_eq!(labels, ["0.5×", "0.75×", "1×", "1.25×", "1.5×", "2×"]);
    }
}
