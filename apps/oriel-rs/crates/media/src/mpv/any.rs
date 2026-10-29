//! The switch between the two video engines for View's capsule player. libmpv is the default
//! (plan 063, decision 7): it plays every container and seeks AV1 exactly. `ORIEL_RS_VIDEO=avplayer`
//! plays through AVPlayer instead, and so does a Mac where libmpv cannot be loaded.

use std::path::Path;
use std::time::Duration;

use gpui_kit::{AnyElement, IntoElement as _, ObjectFit, Styled as _, Window};

use super::{MpvPlayer, Pumped};
use crate::video::{SeekMode, VideoError, VideoPlayer};

/// Names the engine: `avplayer` for AVPlayer; anything else, or nothing, for libmpv.
const ENGINE_VARIABLE: &str = "ORIEL_RS_VIDEO";

/// Which engine plays video.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum VideoEngine {
    AvPlayer,
    Mpv,
}

impl VideoEngine {
    /// The engine `ORIEL_RS_VIDEO` names, libmpv unless it says `avplayer`.
    pub fn from_env() -> Self {
        match std::env::var(ENGINE_VARIABLE).as_deref() {
            Ok("avplayer") => Self::AvPlayer,
            _ => Self::Mpv,
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
    /// Opens `path` with the engine `ORIEL_RS_VIDEO` names, paused at its start.
    pub fn open(path: &Path) -> Result<Self, VideoError> {
        Self::open_with(path, VideoEngine::from_env())
    }

    /// Opens `path` as a gallery tile's preview: libmpv draws its frames no larger than
    /// `max_side` pixels on their longer side, as the tile needs no more. AVPlayer, the fallback,
    /// draws at the picture's size.
    pub fn open_preview(path: &Path, max_side: u32) -> Result<Self, VideoError> {
        let mut player = Self::open(path)?;
        if let Engine::Mpv(video) = &mut player.engine {
            video.set_max_picture_side(Some(max_side));
        }
        Ok(player)
    }

    pub fn open_with(path: &Path, engine: VideoEngine) -> Result<Self, VideoError> {
        let engine = match engine {
            VideoEngine::Mpv if !super::libmpv_available() => {
                // Without libmpv the app still plays what AVPlayer can, rather than nothing.
                log::warn!("libmpv could not be loaded; playing through AVPlayer");
                Engine::AvPlayer(VideoPlayer::open(path)?)
            }
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

    /// The speed playing runs at, 1 being normal.
    pub fn rate(&self) -> f32 {
        match &self.engine {
            Engine::AvPlayer(video) => video.rate(),
            Engine::Mpv(video) => video.rate(),
        }
    }

    pub fn set_rate(&mut self, rate: f32) {
        match &mut self.engine {
            Engine::AvPlayer(video) => video.set_rate(rate),
            Engine::Mpv(video) => video.set_rate(rate),
        }
    }

    /// Whether it plays again from the start at the end.
    pub fn is_looping(&self) -> bool {
        match &self.engine {
            Engine::AvPlayer(video) => video.is_looping(),
            Engine::Mpv(video) => video.is_looping(),
        }
    }

    pub fn set_looping(&mut self, looping: bool) {
        match &mut self.engine {
            Engine::AvPlayer(video) => video.set_looping(looping),
            Engine::Mpv(video) => video.set_looping(looping),
        }
    }

    /// The picture on screen, fitted inside its bounds and filling them.
    pub fn picture(&self) -> Option<AnyElement> {
        self.picture_fitted(ObjectFit::Contain)
    }

    /// The picture on screen, filling its bounds as `fit` says.
    pub fn picture_fitted(&self, fit: ObjectFit) -> Option<AnyElement> {
        match &self.engine {
            Engine::AvPlayer(video) => video
                .surface_fitted(fit)
                .map(|surface| surface.size_full().into_any_element()),
            Engine::Mpv(video) => video.picture_fitted(fit),
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
