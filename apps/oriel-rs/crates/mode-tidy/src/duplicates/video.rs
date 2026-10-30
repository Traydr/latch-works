//! A video playing in a version tile or the loupe, through `oriel-media`'s player (libmpv, or
//! AVPlayer where libmpv cannot load), with its sound: playing one is how the owner checks a
//! soundtrack. One plays at a time; the page drops it when another starts or the set changes.

use std::path::PathBuf;

use gpui_kit::{Context, IntoElement, ParentElement as _, Render, Styled as _, Window, div, px};
use oriel_media::mpv::{AnyPlayer, pump_frames};
use oriel_media::video::VideoError;

pub struct TileVideo {
    video: Result<AnyPlayer, VideoError>,
}

impl TileVideo {
    /// Opens `path` and plays it at once, muted when the page's sound is off.
    pub fn new(path: PathBuf, muted: bool) -> Self {
        let mut video = AnyPlayer::open(&path);
        if let Ok(video) = &mut video {
            video.set_muted(muted);
            video.play();
        }
        Self { video }
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

    fn video_of(&mut self) -> &mut AnyPlayer {
        self.video
            .as_mut()
            .expect("frames are pumped only for a video that opened")
    }
}

impl Render for TileVideo {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        if self.video.is_ok() {
            pump_frames(self, Self::video_of, window, cx);
        }
        let picture = match &self.video {
            Ok(video) => video.picture(),
            Err(error) => Some(
                div()
                    .px_4()
                    .text_size(px(12.))
                    .text_color(gpui_kit::white().opacity(0.7))
                    .child(error.to_string())
                    .into_any_element(),
            ),
        };
        div()
            .size_full()
            .flex()
            .items_center()
            .justify_center()
            .bg(gpui_kit::black())
            .children(picture)
    }
}
