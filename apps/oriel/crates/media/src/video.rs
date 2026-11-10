//! Video through libmpv (plan 063, decision 7): every container and codec FFmpeg reads, MKV,
//! WebM, AVI, FLV and ASF included, and exact seeks in any of them, AV1 from SVT-AV1 included.
//!
//! mpv owns decoding, sound, A/V sync and seeking. Its frames reach GPUI on one of two paths
//! ([`Render`]):
//!
//! - OpenGL (the default on macOS): mpv's OpenGL renderer draws into an IOSurface and
//!   VideoToolbox converts that on the GPU to the `420f` buffer `surface()` takes
//!   (`video/opengl.rs`).
//! - Software (the only one elsewhere, as GPUI's `surface()` is macOS only): mpv's software
//!   renderer draws into memory, shown as a `RenderImage` per frame (`video/software.rs`).
//!
//! Each player's engine runs two threads of its own beside mpv's: one reads mpv's events and one
//! renders (mpv wants its render calls on a thread that never waits on the rest of its API).
//! The UI thread only sends asynchronous commands and reads the state the event thread keeps,
//! so it never waits on mpv. [`pump_frames`] takes each finished frame at the window's next
//! refresh, and re-renders the view only when something it shows changed: a 30 fps video on a
//! 120 Hz display draws the window 30 times a second, and a paused one not at all. A player that
//! goes gives its engine back, and the next player plays its file in it (`video/engine.rs`): a
//! new engine's first frame costs its renderer its shaders, and a kept one has them built.
//!
//! libmpv is loaded at run time and never linked, found by `oriel_core_paths::NativeSet::LIBMPV`.
//! It is Oriel's own LGPL build (mpv `-Dgpl=false`, FFmpeg without `--enable-gpl`), made by
//! `cargo run -p xtask -- libmpv`. Failing that, a development build falls back to IINA's
//! libmpv, read in place; that build and its FFmpeg are GPL, fine for measuring here and never
//! loaded by a packaged app. Where no libmpv loads, a player fails to open with the reason.

mod client;
mod engine;
mod ffi;
#[cfg(feature = "measure")]
mod measure;
#[cfg(target_os = "macos")]
mod opengl;
mod render;
mod scrubber;
mod software;

use std::fmt;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use gpui_kit::{
    AnyElement, Context, IntoElement as _, ObjectFit, RenderImage, Styled as _, StyledImage as _,
    Window, img,
};

use self::client::Core;
use self::engine::Engine;
use self::render::{Picture, Rendered, Shared};

#[cfg(not(feature = "measure"))]
use engine::EngineOptions;
#[cfg(feature = "measure")]
pub use engine::{EngineOptions, prewarm_with, prime_with};
pub use engine::{load_libmpv, prewarm, prime};
#[cfg(feature = "measure")]
pub use measure::{FrameTiming, Meter, SeekTiming, Timings};
pub use scrubber::{Scrub, Scrubber};

/// How long a ready player may go without its first picture before it is called unplayable: the
/// file opened, but its video track does not decode here.
const FIRST_PICTURE_TIMEOUT: Duration = Duration::from_secs(5);
/// How long a seek may go without finishing before the player stops waiting for it.
const SEEK_TIMEOUT: Duration = Duration::from_secs(5);
/// How long a pause or play sent to mpv may go unconfirmed before mpv's word is taken.
const COMMAND_TIMEOUT: Duration = Duration::from_secs(1);
/// The refresh assumed when the window cannot say (it is between displays).
const DEFAULT_REFRESH: Duration = Duration::from_micros(16_667);

/// Software frames retired by players that were dropped, for the next poll to release from
/// GPUI's sprite atlas: a drop has no window to do it with.
static RETIRED: Mutex<Vec<Arc<RenderImage>>> = Mutex::new(Vec::new());

/// Why a video does not play.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum VideoError {
    /// libmpv could not open or decode the file, or could not start, in its own words.
    Failed { code: i64, message: String },
    /// The file opened and has a video track, but no picture came.
    NoPicture,
    /// Video does not play this way here.
    Unavailable(&'static str),
}

impl fmt::Display for VideoError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Failed { message, .. } => write!(f, "Can't play this video: {message}"),
            Self::NoPicture => write!(f, "Can't show this video's picture here"),
            Self::Unavailable(why) => write!(f, "Can't play video {why}"),
        }
    }
}

impl std::error::Error for VideoError {}

/// Where a player is in opening its file.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum VideoStatus {
    Loading,
    Ready,
    Failed(VideoError),
}

/// How closely a seek lands on its target.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SeekMode {
    /// On the frame at the target, decoding from the keyframe before it.
    Exact,
    /// On a keyframe near the target, which shows sooner: for scrubbing.
    Fast,
}

/// How mpv's frames reach GPUI.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Render {
    /// mpv's OpenGL renderer into an IOSurface, converted on the GPU for `surface()`.
    OpenGl,
    /// mpv's software renderer into memory, shown with `img()`.
    Software,
}

impl Render {
    fn options(self) -> [(&'static str, &'static str); 1] {
        match self {
            // VideoToolbox decodes into IOSurfaces mpv maps into GL: no copy.
            Self::OpenGl => [("hwdec", "videotoolbox")],
            // The software renderer reads frames in memory, so decoded frames are copied back.
            #[cfg(target_os = "macos")]
            Self::Software => [("hwdec", "videotoolbox-copy")],
            // Direct3D 11's decoder, copied back the same way.
            #[cfg(not(target_os = "macos"))]
            Self::Software => [("hwdec", "d3d11va-copy")],
        }
    }
}

/// One video file played by libmpv, with its newest frame ready for the window. Main-thread
/// only, as the view that draws it is.
pub struct Player {
    core: Arc<Core>,
    shared: Arc<Shared>,
    /// What plays the file; given back when the player goes.
    engine: Option<Engine>,
    /// Whether the soundtrack plays (muted or not), rather than not at all.
    sound: bool,
    status: VideoStatus,
    frame: Option<Rendered>,
    /// Whether the player means to play: true from [`Self::play`] until a pause or the end, even
    /// while mpv waits for data.
    playing: bool,
    /// Whether it plays again from the start at the end, rather than holding the last frame.
    looping: bool,
    /// A pause state sent to mpv and not yet seen back, with when it was sent.
    pause_sent: Option<(bool, Instant)>,
    seek: Option<PendingSeek>,
    awaiting_picture_since: Option<Instant>,
    /// Whether [`pump_frames`] has a poll waiting for the next display frame.
    pump_scheduled: bool,
    #[cfg(feature = "measure")]
    opened_at: Instant,
    #[cfg(feature = "measure")]
    timings: Option<Box<dyn Timings>>,
}

struct PendingSeek {
    target: Duration,
    #[cfg(feature = "measure")]
    mode: SeekMode,
    requested_at: Instant,
    /// mpv's count of finished seeks when this one was asked for.
    restarts: u64,
    /// The frames the window took since the request, by number, with when from the request.
    taken: Vec<(u64, Duration)>,
}

impl Player {
    /// Opens `path` paused at its start, with its sound. mpv reads the file in the background;
    /// [`Self::status`] turns `Ready` or `Failed` on a later poll.
    pub fn open(path: &Path) -> Result<Self, VideoError> {
        Self::open_on(path, &EngineOptions::default(), true)
    }

    /// Opens `path` as a gallery tile's preview, with its sound: frames are drawn no larger than
    /// `max_side` pixels on their longer side, as the tile needs no more, and a 4K picture drawn
    /// at that size costs a sixtieth of the memory and the GPU time.
    pub fn open_preview(path: &Path, max_side: u32) -> Result<Self, VideoError> {
        let player = Self::open(path)?;
        player.shared.set_max_side(Some(max_side));
        Ok(player)
    }

    /// Opens `path` as a gallery tile's preview that plays without sound, for good: its
    /// soundtrack is neither decoded nor sent to an audio device, so the first picture does not
    /// wait for the device to start, and playing costs less. [`Self::is_muted`] reads true.
    pub fn open_silent_preview(path: &Path, max_side: u32) -> Result<Self, VideoError> {
        let player = Self::open_on(path, &EngineOptions::default(), false)?;
        player.shared.set_max_side(Some(max_side));
        Ok(player)
    }

    /// Opens `path` on an engine made as `options` say, with its sound or without it for good.
    #[cfg(feature = "measure")]
    pub fn open_with(
        path: &Path,
        options: &EngineOptions,
        sound: bool,
    ) -> Result<Self, VideoError> {
        Self::open_on(path, options, sound)
    }

    fn open_on(path: &Path, options: &EngineOptions, sound: bool) -> Result<Self, VideoError> {
        if !path.is_file() {
            return Err(VideoError::Failed {
                code: 0,
                message: "the file is missing".into(),
            });
        }
        #[cfg(not(target_os = "macos"))]
        if options.render == Render::OpenGl {
            return Err(VideoError::Unavailable("through OpenGL off macOS"));
        }
        let file = path
            .to_str()
            .ok_or_else(|| VideoError::Failed {
                code: 0,
                message: "its path is not UTF-8".into(),
            })?
            .to_owned();
        #[cfg(feature = "measure")]
        let opened_at = Instant::now();
        let engine = Engine::take(options)?;
        engine.load(file, sound);
        let mut player = Self {
            core: engine.core.clone(),
            shared: engine.shared.clone(),
            engine: Some(engine),
            sound,
            status: VideoStatus::Loading,
            frame: None,
            playing: false,
            looping: false,
            pause_sent: None,
            seek: None,
            awaiting_picture_since: None,
            pump_scheduled: false,
            #[cfg(feature = "measure")]
            opened_at,
            #[cfg(feature = "measure")]
            timings: None,
        };
        if !sound {
            player.set_muted(true);
        }
        Ok(player)
    }

    pub fn status(&self) -> &VideoStatus {
        &self.status
    }

    pub fn error(&self) -> Option<&VideoError> {
        match &self.status {
            VideoStatus::Failed(error) => Some(error),
            _ => None,
        }
    }

    pub fn is_playing(&self) -> bool {
        self.playing
    }

    /// Plays from where it is, or from the start once it has played to the end.
    pub fn play(&mut self) {
        if self.error().is_some() {
            return;
        }
        if self.has_ended() {
            self.seek(Duration::ZERO, SeekMode::Exact);
        }
        self.send_pause(false);
    }

    pub fn pause(&mut self) {
        self.send_pause(true);
    }

    pub fn toggle_playback(&mut self) {
        if self.playing {
            self.pause();
        } else {
            self.play();
        }
    }

    fn send_pause(&mut self, pause: bool) {
        self.core.set_flag(c"pause", pause);
        self.pause_sent = Some((pause, Instant::now()));
        self.playing = !pause;
    }

    /// Moves to `target`, clamped to the video. mpv itself drops a seek still queued when a
    /// newer one comes, so a scrub shows pictures as it goes.
    pub fn seek(&mut self, target: Duration, mode: SeekMode) {
        if self.error().is_some() {
            return;
        }
        let target = match self.duration() {
            Some(duration) => target.min(duration),
            None => target,
        };
        let flags = match mode {
            SeekMode::Exact => "absolute+exact",
            SeekMode::Fast => "absolute+keyframes",
        };
        self.core
            .command(0, &["seek", &format!("{:.6}", target.as_secs_f64()), flags]);
        self.seek = Some(PendingSeek {
            target,
            #[cfg(feature = "measure")]
            mode,
            requested_at: Instant::now(),
            restarts: self.core.observed().restarts,
            taken: Vec::new(),
        });
    }

    /// Where playback is, or where the newest seek is going while it is under way.
    pub fn position(&self) -> Duration {
        if let Some(seek) = &self.seek {
            return seek.target;
        }
        let position = seconds(self.core.observed().time_pos).unwrap_or_default();
        match self.duration() {
            Some(duration) => position.min(duration),
            None => position,
        }
    }

    /// The video's length, once mpv has read it.
    pub fn duration(&self) -> Option<Duration> {
        seconds(self.core.observed().duration)
    }

    /// Whether it has played to its end and stopped there.
    fn has_ended(&self) -> bool {
        !self.playing
            && self.status == VideoStatus::Ready
            && self.seek.is_none()
            && self.core.observed().eof_reached
    }

    /// Sets the volume, 0 to 1: a gain on the sound's amplitude. mpv's own volume runs 0 to 100
    /// on a cubic curve, so it is given this one's cube root.
    pub fn set_volume(&mut self, volume: f32) {
        let gain = f64::from(volume.clamp(0., 1.));
        self.core.set_double(c"volume", gain.cbrt() * 100.);
        self.core.observed().volume = gain.cbrt() * 100.;
    }

    pub fn is_muted(&self) -> bool {
        self.core.observed().muted
    }

    pub fn set_muted(&mut self, muted: bool) {
        self.core.set_flag(c"mute", muted);
        // Shown at once; mpv's own change confirms it a moment later.
        self.core.observed().muted = muted;
    }

    /// Sets the speed playing runs at, 1 being normal.
    pub fn set_rate(&mut self, rate: f32) {
        self.core.set_double(c"speed", f64::from(rate));
    }

    /// Whether it plays again from the start at the end (View's "Loop videos").
    pub fn is_looping(&self) -> bool {
        self.looping
    }

    pub fn set_looping(&mut self, looping: bool) {
        self.looping = looping;
        // `loop-file` wins over `keep-open`, which holds the last frame only when not looping.
        self.core
            .command(0, &["set", "loop-file", if looping { "inf" } else { "no" }]);
    }

    /// The picture on screen, fitted inside its bounds and filling them; `None` before the
    /// first one.
    pub fn picture(&self) -> Option<AnyElement> {
        self.picture_fitted(ObjectFit::Contain)
    }

    /// The picture on screen, filling its bounds as `fit` says: `Cover` crops it to a gallery
    /// tile, as the tile's thumbnail is.
    pub fn picture_fitted(&self, fit: ObjectFit) -> Option<AnyElement> {
        match &self.frame.as_ref()?.picture {
            Picture::Image(image) => Some(
                img(image.clone())
                    .object_fit(fit)
                    .size_full()
                    .into_any_element(),
            ),
            #[cfg(target_os = "macos")]
            Picture::Buffer(buffer) => Some(
                gpui_kit::surface(buffer.0.clone())
                    .object_fit(fit)
                    .size_full()
                    .into_any_element(),
            ),
        }
    }

    /// Whether the player has pictures to take: it is loading, playing, or landing a seek.
    fn wants_frames(&self) -> bool {
        match self.status {
            VideoStatus::Failed(_) => false,
            VideoStatus::Loading => true,
            VideoStatus::Ready => {
                self.playing
                    || self.seek.is_some()
                    || self.awaiting_picture_since.is_some()
                    || self.pause_sent.is_some()
            }
        }
    }

    /// Takes the newest finished frame and catches up with mpv's state. Returns whether
    /// anything a view shows changed. [`pump_frames`] calls it once per display refresh.
    fn poll(&mut self, refresh: Duration, window: &mut Window) -> bool {
        for image in RETIRED.lock().unwrap_or_else(|p| p.into_inner()).drain(..) {
            window.drop_image(image).ok();
        }
        self.shared.set_refresh(refresh);

        let mut changed = self.poll_status();
        if matches!(self.status, VideoStatus::Failed(_)) {
            return changed;
        }

        #[cfg_attr(
            not(feature = "measure"),
            expect(unused_variables, reason = "for timings")
        )]
        let (paused, restarts, restart_pos, restarted_at, avsync, time_pos, has_size) = {
            let observed = self.core.observed();
            (
                observed.paused,
                observed.restarts,
                observed.restart_pos,
                observed.restarted_at,
                observed.avsync,
                observed.time_pos,
                observed.picture_size().is_some(),
            )
        };

        let taken = Instant::now();
        let shown = taken + refresh;
        if let Some(rendered) = self.shared.take(shown) {
            #[cfg(feature = "measure")]
            if let Some(timings) = &mut self.timings {
                let late = rendered.due.map(|due| signed_seconds(shown, due));
                // mpv's avsync is the sound's time less the picture's at the due time; the
                // picture then reaches the screen `late` after that.
                let lead = late.zip(avsync).map(|(late, avsync)| -avsync - late);
                timings.frame(FrameTiming {
                    at: Instant::now(),
                    after_open: self.opened_at.elapsed(),
                    position: seconds(time_pos),
                    lead,
                    late,
                    draw: rendered.draw_time,
                    waited: taken.saturating_duration_since(rendered.rendered_at),
                });
            }
            if let Some(seek) = &mut self.seek
                && seek.taken.len() < 512
            {
                seek.taken
                    .push((rendered.number, seek.requested_at.elapsed()));
            }
            if let Some(Rendered {
                picture: Picture::Image(old),
                ..
            }) = self.frame.replace(rendered)
            {
                window.drop_image(old).ok();
            }
            self.awaiting_picture_since = None;
            changed = true;
        }

        if let Some(seek) = &self.seek {
            let restarted = restarts > seek.restarts;
            // The seek's picture is the frame mpv took last before the restart, or the first
            // after it the window took, if a newer one replaced it before the window's refresh.
            let landing = restarted_at
                .filter(|_| restarted)
                .and_then(|at| self.shared.begun_by(seek.requested_at, at))
                .and_then(|first| {
                    seek.taken
                        .iter()
                        .find(|(number, _)| *number >= first)
                        .map(|(_, after)| *after)
                });
            let pictured = landing.is_some() || !has_size;
            if restarted && pictured {
                #[cfg_attr(
                    not(feature = "measure"),
                    expect(unused_variables, reason = "for timings")
                )]
                let seek = self.seek.take().expect("a seek is pending");
                #[cfg(feature = "measure")]
                if let Some(timings) = &mut self.timings {
                    let finished = restarted_at
                        .map(|at| at.saturating_duration_since(seek.requested_at))
                        .unwrap_or_default();
                    timings.seek(SeekTiming {
                        mode: seek.mode,
                        target: seek.target,
                        landed: seconds(restart_pos),
                        took: landing.unwrap_or(finished),
                        finished,
                    });
                }
                changed = true;
            } else if seek.requested_at.elapsed() > SEEK_TIMEOUT {
                log::warn!("a seek to {:?} did not finish", seek.target);
                self.seek = None;
                changed = true;
            }
        }

        if let Some(since) = self.awaiting_picture_since
            && since.elapsed() > FIRST_PICTURE_TIMEOUT
        {
            self.awaiting_picture_since = None;
            if has_size {
                self.status = VideoStatus::Failed(VideoError::NoPicture);
            }
            return true;
        }

        // mpv's pause is the truth, but a pause or play just sent shows at once.
        match self.pause_sent {
            Some((sent, at)) if sent != paused && at.elapsed() < COMMAND_TIMEOUT => {}
            _ => {
                self.pause_sent = None;
                if self.playing == paused {
                    self.playing = !paused;
                    changed = true;
                }
            }
        }
        changed
    }

    fn poll_status(&mut self) -> bool {
        let failure = self.core.observed().failed.clone().or_else(|| {
            self.shared
                .failure()
                .map(|message| VideoError::Failed { code: 0, message })
        });
        if let Some(error) = failure {
            if self.status != VideoStatus::Failed(error.clone()) {
                self.status = VideoStatus::Failed(error);
                self.playing = false;
                return true;
            }
            return false;
        }
        if self.status != VideoStatus::Loading || !self.core.observed().file_loaded {
            return false;
        }
        self.status = VideoStatus::Ready;
        if self.frame.is_none() {
            self.awaiting_picture_since = Some(Instant::now());
        }
        #[cfg(feature = "measure")]
        if let Some(timings) = &mut self.timings {
            timings.ready(self.opened_at.elapsed());
        }
        true
    }
}

impl Drop for Player {
    fn drop(&mut self) {
        // Silent at once; the file may take a moment longer to stop.
        self.core.set_flag(c"pause", true);
        if let Some(Rendered {
            picture: Picture::Image(image),
            ..
        }) = self.frame.take()
        {
            RETIRED
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .push(image);
        }
        if let Some(engine) = self.engine.take() {
            engine.give_back(self.sound);
        }
    }
}

/// Keeps `player` taking frames once per display refresh while it has any to show, and
/// re-renders the view only when a poll says something changed. Call it from the view's
/// `render` and after any command that may start motion (play, seek); while a poll is already
/// waiting it does nothing.
pub fn pump_frames<V: 'static>(
    view: &mut V,
    player: fn(&mut V) -> &mut Player,
    window: &mut Window,
    cx: &mut Context<V>,
) {
    let video = player(view);
    if video.pump_scheduled || !video.wants_frames() {
        return;
    }
    video.pump_scheduled = true;
    let view = cx.weak_entity();
    window.on_next_frame(move |window, cx| {
        let refresh = window.refresh_interval(cx).unwrap_or(DEFAULT_REFRESH);
        view.update(cx, |view, cx| {
            let video = player(view);
            video.pump_scheduled = false;
            if video.poll(refresh, window) {
                cx.notify();
            }
            pump_frames(view, player, window, cx);
        })
        .ok();
    });
}

fn seconds(value: Option<f64>) -> Option<Duration> {
    value
        .filter(|seconds| seconds.is_finite() && *seconds >= 0.)
        .map(Duration::from_secs_f64)
}

/// `a - b` in seconds, either way round.
#[cfg(feature = "measure")]
fn signed_seconds(a: Instant, b: Instant) -> f64 {
    match a.checked_duration_since(b) {
        Some(after) => after.as_secs_f64(),
        None => -b.duration_since(a).as_secs_f64(),
    }
}
