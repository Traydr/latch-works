//! The capsule player: one video filling the view, fitted and letterboxed, with GPUI-drawn
//! controls over it in one low capsule, as Electron Oriel's `VideoPlayerChrome`: back and
//! forward 5 s, play or pause, the elapsed time, the scrubber, the length, and mute.
//!
//! Keys, while the player has focus: Space plays or pauses, ← and → skip 5 s, M mutes. A click
//! on the picture plays or pauses. AVPlayer does the playing (`oriel_media::video`), or libmpv
//! with `ORIEL_RS_VIDEO=mpv` (`oriel_media::mpv`); this view only draws its picture and sends
//! it commands.
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
    App, AppContext as _, Context, Entity, FocusHandle, Focusable, FontWeight, Global,
    InteractiveElement as _, IntoElement, KeyBinding, MouseButton, ParentElement as _, Render,
    SharedString, StatefulInteractiveElement as _, Styled as _, Subscription, Window, actions, div,
    prelude::FluentBuilder as _, px, relative, rgba,
};
use oriel_media::mpv::{AnyPlayer, MpvPlayer, pump_frames};
use oriel_media::video::{SeekMode, VideoError, VideoPlayer};

actions!(
    capsule_player,
    [
        /// Play or pause (Space).
        TogglePlayback,
        /// Back 5 s (←).
        SkipBack,
        /// Forward 5 s (→).
        SkipForward,
        /// Mute or unmute (M).
        ToggleMute
    ]
);

const KEY_CONTEXT: &str = "CapsulePlayer";
/// Electron Oriel's `VIDEO_SKIP_SECONDS`.
const SKIP_SECONDS: f64 = 5.;
/// The scrubber's resolution, as a share of the video: a tenth of a second in a 17-minute one.
const SCRUB_STEP: f32 = 0.0001;

/// The capsule is dark on any theme, as the picture behind it is: Electron's `zinc-900/65`,
/// its `white/10` ring, and its `violet-400` for the played part of the timeline.
const CAPSULE: u32 = 0x18181ba6;
const CAPSULE_RING: u32 = 0xffffff1a;
const PLAYED: u32 = 0xa78bfaff;

/// Marks that the player's keys are bound, so the first player binds them for the app.
struct KeysBound;

impl Global for KeysBound {}

/// The player's keys, bound once for the app. They live in the player's own key context, so
/// they win over the viewer's arrows only while the player has focus.
fn bind_keys(cx: &mut App) {
    if cx.has_global::<KeysBound>() {
        return;
    }
    cx.set_global(KeysBound);
    cx.bind_keys([
        KeyBinding::new("space", TogglePlayback, Some(KEY_CONTEXT)),
        KeyBinding::new("left", SkipBack, Some(KEY_CONTEXT)),
        KeyBinding::new("right", SkipForward, Some(KEY_CONTEXT)),
        KeyBinding::new("m", ToggleMute, Some(KEY_CONTEXT)),
    ]);
}

/// The interface the viewer relies on: built for a path, rendered as a view.
pub struct CapsulePlayer {
    path: PathBuf,
    video: Result<AnyPlayer, VideoError>,
    focus: FocusHandle,
    scrubber: Entity<SliderState>,
    /// Whether a scrub paused the video, to resume it when the scrub ends.
    resume_after_scrub: bool,
    _subscriptions: Vec<Subscription>,
}

impl CapsulePlayer {
    /// Opens `path` and starts playing it, with the player focused for its keys.
    pub fn new(path: PathBuf, window: &mut Window, cx: &mut Context<Self>) -> Self {
        bind_keys(cx);
        let mut video = AnyPlayer::open(&path);
        if let Ok(video) = &mut video {
            video.play();
        }
        let scrubber = cx.new(|_| SliderState::new().min(0.).max(1.).step(SCRUB_STEP));
        let subscriptions = vec![cx.subscribe_in(&scrubber, window, Self::on_scrub)];
        let focus = cx.focus_handle();
        focus.focus(window, cx);
        Self {
            path,
            video,
            focus,
            scrubber,
            resume_after_scrub: false,
            _subscriptions: subscriptions,
        }
    }

    pub fn path(&self) -> &Path {
        &self.path
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

    /// The libmpv player, when `ORIEL_RS_VIDEO=mpv` chose it.
    pub fn mpv_mut(&mut self) -> Option<&mut MpvPlayer> {
        self.video.as_mut().ok().and_then(AnyPlayer::mpv_mut)
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

    fn toggle_playback(&mut self, _: &TogglePlayback, window: &mut Window, cx: &mut Context<Self>) {
        self.command(window, cx, AnyPlayer::toggle_playback);
    }

    fn skip_back(&mut self, _: &SkipBack, window: &mut Window, cx: &mut Context<Self>) {
        self.command(window, cx, |video| video.skip(-SKIP_SECONDS));
    }

    fn skip_forward(&mut self, _: &SkipForward, window: &mut Window, cx: &mut Context<Self>) {
        self.command(window, cx, |video| video.skip(SKIP_SECONDS));
    }

    fn toggle_mute(&mut self, _: &ToggleMute, window: &mut Window, cx: &mut Context<Self>) {
        self.command(window, cx, |video| video.set_muted(!video.is_muted()));
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
            .relative()
            .size_full()
            .overflow_hidden()
            .bg(gpui_kit::black())
            .child(picture)
            .when(error.is_none(), |this| this.child(self.render_capsule(cx)))
    }
}

impl CapsulePlayer {
    fn render_capsule(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let video = self.video.as_ref().ok();
        let playing = video.is_some_and(AnyPlayer::is_playing);
        let muted = video.is_some_and(AnyPlayer::is_muted);
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
                capsule_button("skip-back", IconName::RotateCcw, "Back 5 seconds  ←", 32.)
                    .child(skip_count())
                    .on_click(cx.listener(|this, _, window, cx| {
                        this.skip_back(&SkipBack, window, cx);
                    })),
            )
            .child(
                capsule_button(
                    "play-pause",
                    if playing {
                        IconName::Pause
                    } else {
                        IconName::Play
                    },
                    if playing {
                        "Pause  Space"
                    } else {
                        "Play  Space"
                    },
                    40.,
                )
                .on_click(cx.listener(|this, _, window, cx| {
                    this.toggle_playback(&TogglePlayback, window, cx);
                })),
            )
            .child(
                capsule_button(
                    "skip-forward",
                    IconName::RotateCw,
                    "Forward 5 seconds  →",
                    32.,
                )
                .child(skip_count())
                .on_click(cx.listener(|this, _, window, cx| {
                    this.skip_forward(&SkipForward, window, cx);
                })),
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
            .child(self.render_scrubber(played))
            .child(
                div()
                    .w(px(36.))
                    .flex_shrink_0()
                    .text_right()
                    .child(duration.map(clock).unwrap_or_else(|| "–:––".into())),
            );

        let mute = capsule_button(
            "mute",
            if muted {
                IconName::VolumeX
            } else {
                IconName::Volume2
            },
            if muted { "Unmute  M" } else { "Mute  M" },
            32.,
        )
        .when(muted, |this| this.text_color(rgba(PLAYED)))
        .on_click(cx.listener(|this, _, window, cx| {
            this.toggle_mute(&ToggleMute, window, cx);
        }));

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
                    // A press on the controls is not a click on the picture.
                    .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                    .on_click(|_, _, cx| cx.stop_propagation())
                    .child(row)
                    .child(timeline)
                    .child(mute),
            )
    }

    /// The timeline: a 6 px track with the played part filled and a thumb at the playhead, in a
    /// 32 px band that takes the press. The thumb follows the video, not the slider's own value,
    /// so playing never writes to the slider while the window draws.
    fn render_scrubber(&self, played: f32) -> impl IntoElement {
        Slider::new(&self.scrubber)
            .accessibility_label("Video seek position")
            .flex()
            .flex_1()
            .min_w_0()
            .items_center()
            .child(
                SliderTrack::new(&self.scrubber)
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
                            ),
                    ),
            )
    }
}

/// A round icon button on the capsule, `size` px across, with its name and key as the tooltip.
fn capsule_button(
    id: &'static str,
    icon: IconName,
    tooltip: &'static str,
    size_px: f32,
) -> gpui_kit::Stateful<gpui_kit::Div> {
    let icon = Icon::new(icon).size(px(size_px / 2.));
    div()
        .id(id)
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
        .tooltip(move |window, cx| Tooltip::new(tooltip).build(window, cx))
        .child(icon)
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
}
