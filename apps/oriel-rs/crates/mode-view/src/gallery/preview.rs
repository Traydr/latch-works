//! A video tile's hover preview, as Electron Oriel's `MediaTile` plays one: the video under the
//! pointer plays in its tile, cropped as the tile's thumbnail is, muted unless "Enable audio in
//! video preview" is on, and looping while "Loop videos" is.
//!
//! It is kept cheap. One plays at a time, through the same engine as the capsule player (libmpv
//! by default), with frames drawn at the tile's size rather than the video's. It starts once the
//! pointer has rested on the tile for [`HOVER_DELAY`], so tiles passing under a still pointer as
//! the grid scrolls open nothing, and it stops when the pointer leaves, the tile scrolls away, or
//! View stops showing the gallery. The thumbnail shows until its first frame does.

use std::path::Path;
use std::time::Duration;

use gpui_kit::{
    Context, IntoElement, ObjectFit, ParentElement as _, Render, Styled as _, Window, div,
    prelude::FluentBuilder as _,
};
use oriel_media::mpv::{AnyPlayer, pump_frames};

/// How long the pointer rests on a video tile before it plays.
pub const HOVER_DELAY: Duration = Duration::from_millis(200);

/// What a video tile does under the pointer, from View's settings.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct PreviewSettings {
    /// "Autoplay video on hover".
    pub autoplay: bool,
    /// "Enable audio in video preview".
    pub sound: bool,
    /// "Loop videos".
    pub looping: bool,
}

/// The video playing in a tile.
pub struct TilePreview {
    video: AnyPlayer,
}

impl TilePreview {
    /// Starts `path` playing, its frames drawn no larger than `max_side` pixels; `None` when it
    /// cannot be opened, and the tile keeps its thumbnail.
    pub fn start(path: &Path, settings: PreviewSettings, max_side: u32) -> Option<Self> {
        let mut video = AnyPlayer::open_preview(path, max_side)
            .inspect_err(|error| log::debug!("no hover preview: {error}"))
            .ok()?;
        video.set_muted(!settings.sound);
        video.set_looping(settings.looping);
        video.play();
        Some(Self { video })
    }

    pub fn is_playing(&self) -> bool {
        self.video.is_playing()
    }

    pub fn is_muted(&self) -> bool {
        self.video.is_muted()
    }

    pub fn is_looping(&self) -> bool {
        self.video.is_looping()
    }

    fn video(&mut self) -> &mut AnyPlayer {
        &mut self.video
    }
}

impl Render for TilePreview {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        pump_frames(self, Self::video, window, cx);
        div().absolute().inset_0().when_some(
            self.video.picture_fitted(ObjectFit::Cover),
            |this, picture| this.child(picture),
        )
    }
}
