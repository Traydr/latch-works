//! The switch between the two video engines, for View's capsule player while libmpv is
//! measured against AVPlayer: `ORIEL_GPUI_VIDEO=mpv` plays through libmpv, anything else (or
//! nothing) through AVPlayer, the default.

use std::path::Path;
use std::time::Duration;

use gpui_kit::{AnyElement, IntoElement as _, Styled as _, Window};

use super::{MpvPlayer, Pumped};
use crate::video::{SeekMode, VideoError, VideoPlayer};

/// Names the engine: `mpv` for libmpv.
const ENGINE_VARIABLE: &str = "ORIEL_GPUI_VIDEO";

/// Which engine plays video.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum VideoEngine {
    AvPlayer,
    Mpv,
}

impl VideoEngine {
    /// The engine `ORIEL_GPUI_VIDEO` names.
    pub fn from_env() -> Self {
        match std::env::var(ENGINE_VARIABLE).as_deref() {
            Ok("mpv") => Self::Mpv,
            _ => Self::AvPlayer,
        }
    }
}

/// A video played by either engine, with the controls both have.
pub struct AnyPlayer {
    engine: Engine,
    pump_scheduled: bool,
}

enum Engine {
    AvPlayer(VideoPlayer),
    Mpv(MpvPlayer),
}

impl AnyPlayer {
    /// Opens `path` with the engine `ORIEL_GPUI_VIDEO` names, paused at its start.
    pub fn open(path: &Path) -> Result<Self, VideoError> {
        Self::open_with(path, VideoEngine::from_env())
    }

    pub fn open_with(path: &Path, engine: VideoEngine) -> Result<Self, VideoError> {
        let engine = match engine {
            VideoEngine::AvPlayer => Engine::AvPlayer(VideoPlayer::open(path)?),
            VideoEngine::Mpv => Engine::Mpv(MpvPlayer::open(path)?),
        };
        Ok(Self {
            engine,
            pump_scheduled: false,
        })
    }

    pub fn engine(&self) -> VideoEngine {
        match self.engine {
            Engine::AvPlayer(_) => VideoEngine::AvPlayer,
            Engine::Mpv(_) => VideoEngine::Mpv,
        }
    }

    /// The AVPlayer player, when it is the one playing.
    pub fn av_player_mut(&mut self) -> Option<&mut VideoPlayer> {
        match &mut self.engine {
            Engine::AvPlayer(video) => Some(video),
            Engine::Mpv(_) => None,
        }
    }

    /// The libmpv player, when it is the one playing.
    pub fn mpv_mut(&mut self) -> Option<&mut MpvPlayer> {
        match &mut self.engine {
            Engine::AvPlayer(_) => None,
            Engine::Mpv(video) => Some(video),
        }
    }

    pub fn error(&self) -> Option<&VideoError> {
        match &self.engine {
            Engine::AvPlayer(video) => video.error(),
            Engine::Mpv(video) => video.error(),
        }
    }

    pub fn is_playing(&self) -> bool {
        match &self.engine {
            Engine::AvPlayer(video) => video.is_playing(),
            Engine::Mpv(video) => video.is_playing(),
        }
    }

    pub fn play(&mut self) {
        match &mut self.engine {
            Engine::AvPlayer(video) => video.play(),
            Engine::Mpv(video) => video.play(),
        }
    }

    pub fn pause(&mut self) {
        match &mut self.engine {
            Engine::AvPlayer(video) => video.pause(),
            Engine::Mpv(video) => video.pause(),
        }
    }

    pub fn toggle_playback(&mut self) {
        match &mut self.engine {
            Engine::AvPlayer(video) => video.toggle_playback(),
            Engine::Mpv(video) => video.toggle_playback(),
        }
    }

    pub fn seek(&mut self, target: Duration, mode: SeekMode) {
        match &mut self.engine {
            Engine::AvPlayer(video) => video.seek(target, mode),
            Engine::Mpv(video) => video.seek(target, mode),
        }
    }

    pub fn skip(&mut self, seconds: f64) {
        match &mut self.engine {
            Engine::AvPlayer(video) => video.skip(seconds),
            Engine::Mpv(video) => video.skip(seconds),
        }
    }

    pub fn position(&self) -> Duration {
        match &self.engine {
            Engine::AvPlayer(video) => video.position(),
            Engine::Mpv(video) => video.position(),
        }
    }

    pub fn duration(&self) -> Option<Duration> {
        match &self.engine {
            Engine::AvPlayer(video) => video.duration(),
            Engine::Mpv(video) => video.duration(),
        }
    }

    pub fn is_muted(&self) -> bool {
        match &self.engine {
            Engine::AvPlayer(video) => video.is_muted(),
            Engine::Mpv(video) => video.is_muted(),
        }
    }

    pub fn set_muted(&mut self, muted: bool) {
        match &mut self.engine {
            Engine::AvPlayer(video) => video.set_muted(muted),
            Engine::Mpv(video) => video.set_muted(muted),
        }
    }

    pub fn volume(&self) -> f32 {
        match &self.engine {
            Engine::AvPlayer(video) => video.volume(),
            Engine::Mpv(video) => video.volume(),
        }
    }

    pub fn set_volume(&mut self, volume: f32) {
        match &mut self.engine {
            Engine::AvPlayer(video) => video.set_volume(volume),
            Engine::Mpv(video) => video.set_volume(volume),
        }
    }

    /// The picture on screen, fitted inside its bounds and filling them.
    pub fn picture(&self) -> Option<AnyElement> {
        match &self.engine {
            Engine::AvPlayer(video) => video
                .surface()
                .map(|surface| surface.size_full().into_any_element()),
            Engine::Mpv(video) => video.picture(),
        }
    }
}

impl Pumped for AnyPlayer {
    fn pump_scheduled(&mut self) -> &mut bool {
        &mut self.pump_scheduled
    }

    fn wants_frames(&self) -> bool {
        match &self.engine {
            Engine::AvPlayer(video) => video.wants_frames(),
            Engine::Mpv(video) => video.wants_frames(),
        }
    }

    fn poll(&mut self, refresh: Duration, window: &mut Window) -> bool {
        match &mut self.engine {
            Engine::AvPlayer(video) => video.poll(refresh),
            Engine::Mpv(video) => video.poll(refresh, window),
        }
    }
}
