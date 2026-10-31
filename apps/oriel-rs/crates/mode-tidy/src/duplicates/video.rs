//! A video playing in a version tile, the copy list or the loupe, through `oriel-media`'s player
//! (libmpv, or AVPlayer where libmpv cannot load), with its sound: playing one is how the owner
//! checks a soundtrack. One plays at a time; the page drops it when another starts or the set
//! changes.
//!
//! Over its picture sit Electron Oriel's `VideoControls`: play or pause, the time and the length,
//! a scrubber and the sound, so versions can be watched and heard side by side to check their
//! length and soundtrack. Clicks stay in the controls: the tile under them keeps a version on
//! click, which these must not do.

use std::path::PathBuf;
use std::time::Duration;

use gpui_kit::assets::IconName;
use gpui_kit::base::slider::{SliderEvent, SliderState};
use gpui_kit::base::{Slider, SliderIndicator, SliderTrack};
use gpui_kit::component::Icon;
use gpui_kit::{
    AppContext as _, Context, Entity, InteractiveElement as _, IntoElement, MouseButton,
    ParentElement as _, Render, SharedString, StatefulInteractiveElement as _, Styled as _,
    Subscription, Window, div, prelude::FluentBuilder as _, px, relative,
};
use oriel_media::mpv::{AnyPlayer, pump_frames};
use oriel_media::video::{SeekMode, VideoError};

/// The scrubber's resolution, as a share of the video.
const SCRUB_STEP: f32 = 0.0005;

pub struct TileVideo {
    video: Result<AnyPlayer, VideoError>,
    scrubber: Entity<SliderState>,
    /// The video was playing when a drag along the scrubber paused it.
    resume_after_scrub: bool,
    _subscriptions: Vec<Subscription>,
}

impl TileVideo {
    /// Opens `path` and plays it at once, muted when the page's sound is off.
    pub fn new(path: PathBuf, muted: bool, cx: &mut Context<Self>) -> Self {
        let mut video = AnyPlayer::open(&path);
        if let Ok(video) = &mut video {
            video.set_muted(muted);
            video.play();
        }
        let scrubber = cx.new(|_| SliderState::new().min(0.).max(1.).step(SCRUB_STEP));
        let subscriptions = vec![cx.subscribe(&scrubber, Self::on_scrub)];
        Self {
            video,
            scrubber,
            resume_after_scrub: false,
            _subscriptions: subscriptions,
        }
    }

    pub fn is_playing(&self) -> bool {
        self.video.as_ref().is_ok_and(AnyPlayer::is_playing)
    }

    /// Whether a picture shows yet, or the error that stands for one.
    pub fn shows_picture(&self) -> bool {
        self.video
            .as_ref()
            .map_or(true, |video| video.picture().is_some())
    }

    pub fn toggle(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if let Ok(video) = &mut self.video {
            video.toggle_playback();
            pump_frames(self, Self::video_of, window, cx);
            cx.notify();
        }
    }

    pub fn set_muted(&mut self, muted: bool, cx: &mut Context<Self>) {
        if let Ok(video) = &mut self.video {
            video.set_muted(muted);
            cx.notify();
        }
    }

    fn toggle_sound(&mut self, cx: &mut Context<Self>) {
        if let Ok(video) = &mut self.video {
            let muted = !video.is_muted();
            video.set_muted(muted);
            cx.notify();
        }
    }

    /// A drag along the scrubber shows keyframes as it goes, with the video held still, and
    /// lands on the exact frame where it is let go.
    fn on_scrub(&mut self, _: Entity<SliderState>, event: &SliderEvent, cx: &mut Context<Self>) {
        let (fraction, mode) = match event {
            SliderEvent::Change(value) => (value.end(), SeekMode::Fast),
            SliderEvent::Release(value) => (value.end(), SeekMode::Exact),
        };
        let Ok(video) = &mut self.video else {
            return;
        };
        let Some(duration) = video.duration() else {
            return;
        };
        let releasing = mode == SeekMode::Exact;
        if !releasing && video.is_playing() {
            video.pause();
            self.resume_after_scrub = true;
        }
        video.seek(duration.mul_f32(fraction.clamp(0., 1.)), mode);
        if releasing && std::mem::take(&mut self.resume_after_scrub) {
            video.play();
        }
        cx.notify();
    }

    fn video_of(&mut self) -> &mut AnyPlayer {
        self.video
            .as_mut()
            .expect("frames are pumped only for a video that opened")
    }

    fn render_controls(&self, video: &AnyPlayer, cx: &mut Context<Self>) -> impl IntoElement {
        let playing = video.is_playing();
        let muted = video.is_muted();
        let position = video.position();
        let duration = video.duration().unwrap_or_default();
        let played = if duration.is_zero() {
            0.
        } else {
            (position.as_secs_f32() / duration.as_secs_f32()).clamp(0., 1.)
        };
        let slider = Slider::new(&self.scrubber)
            .accessibility_label("Position")
            .flex()
            .flex_1()
            .min_w_0()
            .items_center()
            .child(
                SliderTrack::new(&self.scrubber)
                    .relative()
                    .flex()
                    .items_center()
                    .w_full()
                    .h(px(20.))
                    .child(
                        SliderIndicator::new(&self.scrubber)
                            .relative()
                            .w_full()
                            .h(px(4.))
                            .rounded_full()
                            .bg(gpui_kit::white().opacity(0.3))
                            .child(
                                div()
                                    .absolute()
                                    .top_0()
                                    .bottom_0()
                                    .left_0()
                                    .w(relative(played))
                                    .rounded_full()
                                    .bg(gpui_kit::rgb(0xa7_8b_fa)),
                            ),
                    ),
            );
        div()
            .id("video-controls")
            .absolute()
            .left_2()
            .right_2()
            .bottom_2()
            .flex()
            .flex_row()
            .items_center()
            .gap(px(6.))
            .px(px(6.))
            .py_1()
            .rounded_lg()
            .bg(gpui_kit::black().opacity(0.65))
            .text_color(gpui_kit::white())
            // The tile under the controls keeps a version on click; these clicks stay here.
            .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
            .on_click(|_, _, cx| cx.stop_propagation())
            .child(control_button(
                "video-play",
                if playing {
                    IconName::Pause
                } else {
                    IconName::Play
                },
                if playing { "Pause" } else { "Play" },
                cx.listener(|this, _, window, cx| {
                    cx.stop_propagation();
                    this.toggle(window, cx);
                }),
            ))
            .child(
                div()
                    .flex_shrink_0()
                    .text_xs()
                    .child(SharedString::from(format!(
                        "{} / {}",
                        clock(position),
                        clock(duration)
                    ))),
            )
            .child(slider)
            .child(control_button(
                "video-sound",
                if muted {
                    IconName::VolumeX
                } else {
                    IconName::Volume2
                },
                if muted { "Sound on" } else { "Sound off" },
                cx.listener(|this, _, _, cx| {
                    cx.stop_propagation();
                    this.toggle_sound(cx);
                }),
            ))
    }
}

/// One of the controls' 28 px buttons, with its name as its tooltip.
fn control_button(
    id: &'static str,
    icon: IconName,
    label: &'static str,
    on_click: impl Fn(&gpui_kit::ClickEvent, &mut Window, &mut gpui_kit::App) + 'static,
) -> impl IntoElement {
    div()
        .id(id)
        .flex_shrink_0()
        .size(px(28.))
        .flex()
        .items_center()
        .justify_center()
        .rounded_md()
        .cursor_pointer()
        .hover(|style| style.bg(gpui_kit::white().opacity(0.15)))
        .tooltip(move |window, cx| {
            gpui_kit::component::tooltip::Tooltip::new(label).build(window, cx)
        })
        .on_click(on_click)
        .child(Icon::new(icon).size(px(16.)))
}

/// A time as the controls show it: "1:05", "1:02:05" (`formatDuration`).
fn clock(time: Duration) -> String {
    let total = time.as_secs();
    let (hours, minutes, seconds) = (total / 3600, total % 3600 / 60, total % 60);
    if hours > 0 {
        format!("{hours}:{minutes:02}:{seconds:02}")
    } else {
        format!("{minutes}:{seconds:02}")
    }
}

impl Render for TileVideo {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        if self.video.is_ok() {
            pump_frames(self, Self::video_of, window, cx);
        }
        let (picture, controls) = match &self.video {
            Ok(video) => (video.picture(), Some(self.render_controls(video, cx))),
            Err(error) => (
                Some(
                    div()
                        .px_4()
                        .text_size(px(12.))
                        .text_color(gpui_kit::white().opacity(0.7))
                        .child(error.to_string())
                        .into_any_element(),
                ),
                None,
            ),
        };
        div()
            .relative()
            .size_full()
            .flex()
            .items_center()
            .justify_center()
            .bg(gpui_kit::black())
            .children(picture)
            .when_some(controls, |this, controls| this.child(controls))
    }
}
