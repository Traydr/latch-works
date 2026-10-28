//! Video through libmpv, the engine plan 063 settled on for mpv's full capabilities: every
//! container and codec FFmpeg reads (MKV, WebM, AVI, FLV and ASF included, which AVPlayer
//! refuses) and exact seeks in any of them, AV1 from SVT-AV1 included.
//!
//! An [`MpvPlayer`] has the controls of [`crate::video::VideoPlayer`], so View's capsule player
//! can switch between the two ([`AnyPlayer`], chosen by `ORIEL_RS_VIDEO=mpv`). The AVPlayer
//! player stays the default until this one passes Phase 0's measurements.
//!
//! mpv owns decoding, sound, A/V sync and seeking. Its frames reach GPUI on one of two paths,
//! chosen by `ORIEL_RS_MPV_RENDER`:
//!
//! - `gl` (the default): mpv's OpenGL renderer draws into an IOSurface and VideoToolbox converts
//!   that on the GPU to the `420f` buffer `surface()` takes (`mpv/opengl.rs`).
//! - `sw`: mpv's software renderer draws into memory, shown as a `RenderImage` per frame
//!   (`mpv/software.rs`).
//!
//! Each player runs three threads of its own beside mpv's: one reads mpv's events, one renders
//! (mpv wants its render calls on a thread that never waits on the rest of its API), and one
//! tears the core down when the player is dropped. The UI thread only sends asynchronous
//! commands and reads the state the event thread keeps, so it never waits on mpv. [`pump_frames`]
//! takes each finished frame at the window's next refresh, as `video::pump_frames` does.
//!
//! libmpv is loaded at run time and never linked: on this Mac it is IINA's build, read in place
//! (`ORIEL_RS_LIBMPV` names another). IINA's build and its FFmpeg are GPL, which is fine for
//! measuring here and not for shipping in an MIT app; an LGPL build (`-Dgpl=false`, with an
//! FFmpeg built without `--enable-gpl`) loads the same way.

mod any;
mod client;
mod ffi;
#[cfg(target_os = "macos")]
mod opengl;
mod render;
mod samples;
mod software;

use std::path::Path;
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use gpui_kit::{
    AnyElement, Context, IntoElement as _, ObjectFit, RenderImage, Styled as _, StyledImage as _,
    Window, img,
};

use self::client::Core;
use self::render::{Picture, Rendered, Shared};
use crate::video::{SeekMode, VideoError, VideoStatus};

pub use any::{AnyPlayer, VideoEngine};
pub use samples::{MpvFrameSample, MpvSamples, MpvSeekSample};

/// How long a ready player may go without its first picture before it is called unplayable.
const FIRST_PICTURE_TIMEOUT: Duration = Duration::from_secs(5);
/// How long a seek may go without finishing before the player stops waiting for it.
const SEEK_TIMEOUT: Duration = Duration::from_secs(5);
/// How long a pause or play sent to mpv may go unconfirmed before mpv's word is taken.
const COMMAND_TIMEOUT: Duration = Duration::from_secs(1);
/// The refresh assumed when the window cannot say (it is between displays).
const DEFAULT_REFRESH: Duration = Duration::from_micros(16_667);
/// Overrides how far ahead of its due time a frame is handed out, in milliseconds.
const LEAD_VARIABLE: &str = "ORIEL_RS_MPV_LEAD_MS";
/// Chooses the render path: `gl` or `sw`.
const RENDER_VARIABLE: &str = "ORIEL_RS_MPV_RENDER";
/// More mpv options, `name=value` pairs split by commas, set after the player's own: for
/// trying one out without a build.
const OPTIONS_VARIABLE: &str = "ORIEL_RS_MPV_OPTIONS";

/// Software frames retired by players that were dropped, for the next poll to release from
/// GPUI's sprite atlas: a drop has no window to do it with.
static RETIRED: Mutex<Vec<Arc<RenderImage>>> = Mutex::new(Vec::new());

/// How mpv's frames reach GPUI.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MpvRender {
    /// mpv's OpenGL renderer into an IOSurface, converted on the GPU for `surface()`.
    OpenGl,
    /// mpv's software renderer into memory, shown with `img()`.
    Software,
}

impl MpvRender {
    /// The path `ORIEL_RS_MPV_RENDER` names: `sw` for software, anything else OpenGL.
    pub fn from_env() -> Self {
        match std::env::var(RENDER_VARIABLE).as_deref() {
            Ok("sw") => Self::Software,
            _ => Self::OpenGl,
        }
    }

    fn options(self) -> [(&'static str, &'static str); 1] {
        match self {
            // VideoToolbox decodes into IOSurfaces mpv maps into GL: no copy.
            Self::OpenGl => [("hwdec", "videotoolbox")],
            // The software renderer reads frames in memory, so decoded frames are copied back.
            Self::Software => [("hwdec", "videotoolbox-copy")],
        }
    }
}

/// One video file played by libmpv, with its newest frame ready for the window.
pub struct MpvPlayer {
    core: Arc<Core>,
    shared: Arc<Shared>,
    threads: Option<(JoinHandle<()>, JoinHandle<()>)>,
    render: MpvRender,
    status: VideoStatus,
    frame: Option<Rendered>,
    /// The time mpv gave when the picture on screen was taken.
    frame_position: Option<Duration>,
    /// Whether the player means to play, as [`crate::video::VideoPlayer::is_playing`].
    playing: bool,
    /// A pause state sent to mpv and not yet seen back, with when it was sent.
    pause_sent: Option<(bool, Instant)>,
    seek: Option<PendingSeek>,
    awaiting_picture_since: Option<Instant>,
    pump_scheduled: bool,
    opened_at: Instant,
    samples: Option<MpvSamples>,
}

struct PendingSeek {
    target: Duration,
    mode: SeekMode,
    requested_at: Instant,
    /// mpv's count of finished seeks when this one was asked for.
    restarts: u64,
    /// The frames the window took since the request, by number, with when from the request.
    taken: Vec<(u64, Duration)>,
}

impl MpvPlayer {
    /// Opens `path` paused at its start, on the render path `ORIEL_RS_MPV_RENDER` names. mpv
    /// reads the file in the background; [`Self::status`] turns `Ready` or `Failed` on a later
    /// [`Self::poll`].
    pub fn open(path: &Path) -> Result<Self, VideoError> {
        Self::open_with(path, MpvRender::from_env())
    }

    /// Opens `path` on the render path given.
    pub fn open_with(path: &Path, render: MpvRender) -> Result<Self, VideoError> {
        if !path.is_file() {
            return Err(VideoError::Failed {
                code: 0,
                message: "the file is missing".into(),
            });
        }
        #[cfg(not(target_os = "macos"))]
        if render == MpvRender::OpenGl {
            return Err(VideoError::Unavailable("through OpenGL off macOS"));
        }
        let file = path
            .to_str()
            .ok_or_else(|| VideoError::Failed {
                code: 0,
                message: "its path is not UTF-8".into(),
            })?
            .to_owned();
        let opened_at = Instant::now();
        let mut options = vec![
            // Frames go to this process's render context, never a window of mpv's.
            ("vo", "libmpv"),
            // Not the owner's mpv.conf, scripts or key bindings: this is an embedded player.
            ("config", "no"),
            ("load-scripts", "no"),
            ("ytdl", "no"),
            ("terminal", "no"),
            ("input-default-bindings", "no"),
            ("input-vo-keyboard", "no"),
            // No on-screen display is drawn into the picture; the capsule is GPUI's.
            ("osd-level", "0"),
            ("osd-bar", "no"),
            // At the end, hold the last frame paused, as AVPlayer does.
            ("keep-open", "yes"),
            ("idle", "yes"),
            ("pause", "yes"),
            // Cover art is not a picture here.
            ("audio-display", "no"),
            ("audio-client-name", "Oriel RS"),
        ];
        options.extend(render.options());
        let extra = std::env::var(OPTIONS_VARIABLE).unwrap_or_default();
        options.extend(
            extra
                .split(',')
                .filter_map(|option| option.split_once('='))
                .map(|(name, value)| (name.trim(), value.trim())),
        );
        let core = Core::start(&options)?;
        let lead_override = std::env::var(LEAD_VARIABLE)
            .ok()
            .and_then(|ms| ms.parse::<f64>().ok())
            .map(|ms| Duration::from_secs_f64(ms.max(0.) / 1000.));
        let shared = Shared::new(DEFAULT_REFRESH, lead_override);
        let events = core.spawn_events();
        let thread = match render {
            #[cfg(target_os = "macos")]
            MpvRender::OpenGl => {
                render::spawn(core.clone(), shared.clone(), opengl::OpenGl::new(), file)
            }
            #[cfg(not(target_os = "macos"))]
            MpvRender::OpenGl => unreachable!("refused above"),
            MpvRender::Software => {
                render::spawn(core.clone(), shared.clone(), software::Software, file)
            }
        };
        Ok(Self {
            core,
            shared,
            threads: Some((thread, events)),
            render,
            status: VideoStatus::Loading,
            frame: None,
            frame_position: None,
            playing: false,
            pause_sent: None,
            seek: None,
            awaiting_picture_since: None,
            pump_scheduled: false,
            opened_at,
            samples: None,
        })
    }

    /// Starts keeping timings, as [`crate::video::VideoPlayer::record_samples`].
    pub fn record_samples(&mut self) {
        self.samples = Some(MpvSamples::new(self.opened_at));
    }

    pub fn samples_mut(&mut self) -> Option<&mut MpvSamples> {
        self.samples.as_mut()
    }

    pub fn samples(&self) -> Option<&MpvSamples> {
        self.samples.as_ref()
    }

    pub fn render(&self) -> MpvRender {
        self.render
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

    /// Whether the player means to play: true from [`Self::play`] until a pause or the end.
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
            mode,
            requested_at: Instant::now(),
            restarts: self.core.observed().restarts,
            taken: Vec::new(),
        });
    }

    /// Moves by `seconds`, back when negative, landing on the exact frame.
    pub fn skip(&mut self, seconds: f64) {
        let target = (self.position().as_secs_f64() + seconds).max(0.);
        self.seek(Duration::from_secs_f64(target), SeekMode::Exact);
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
    pub fn has_ended(&self) -> bool {
        !self.playing
            && self.status == VideoStatus::Ready
            && self.seek.is_none()
            && self.core.observed().eof_reached
    }

    /// 0 to 1, as AVPlayer's volume: a gain on the sound's amplitude. mpv's own volume runs
    /// 0 to 100 on a cubic curve, so this is its cube.
    pub fn volume(&self) -> f32 {
        ((self.core.observed().volume / 100.).clamp(0., 1.).powi(3)) as f32
    }

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

    /// The speed playing runs at, 1 being normal.
    pub fn rate(&self) -> f32 {
        self.core.observed().speed as f32
    }

    pub fn set_rate(&mut self, rate: f32) {
        self.core.set_double(c"speed", f64::from(rate));
    }

    /// The picture's size in pixels as it is shown, once mpv knows it.
    pub fn picture_size(&self) -> Option<(f64, f64)> {
        self.core
            .observed()
            .picture_size()
            .map(|(width, height)| (f64::from(width), f64::from(height)))
    }

    /// mpv's time when the picture on screen was taken, if one is.
    pub fn picture_time(&self) -> Option<Duration> {
        self.frame.as_ref().and(self.frame_position)
    }

    /// The decoder in use: "videotoolbox" when the hardware decodes, "no" when the CPU does.
    pub fn hardware_decoder(&self) -> Option<String> {
        self.core.observed().hwdec.clone()
    }

    /// Which libmpv, mpv and FFmpeg play this: for the spike's report. Waits on mpv's core.
    pub fn describe_engine(&self) -> String {
        let api = self.core.api();
        format!(
            "{} (client API {}, {}), FFmpeg {}, from {}",
            self.core.get_string(c"mpv-version").unwrap_or_default(),
            api.client_api(),
            match self.render {
                MpvRender::OpenGl => "OpenGL render API",
                MpvRender::Software => "software render API",
            },
            self.core.get_string(c"ffmpeg-version").unwrap_or_default(),
            api.path.display(),
        )
    }

    /// Frames the render thread has drawn; those the window never took were replaced by a
    /// newer one before its next refresh.
    pub fn frames_drawn(&self) -> u64 {
        self.shared.drawn()
    }

    /// One of mpv's properties as a number, waiting on mpv's core: for measurements only.
    pub fn read_number(&self, name: &std::ffi::CStr) -> Option<f64> {
        self.core.get_double(name)
    }

    /// The picture on screen as 8-bit RGB, width, height and rows, as GPUI's renderer turns it
    /// into colours: for measuring which frame a seek landed on and how true its colours are.
    pub fn picture_rgb(&self) -> Option<(u32, u32, Vec<u8>)> {
        self.frame.as_ref()?.picture.rgb()
    }

    /// The picture on screen, fitted inside its bounds and filling them; `None` before the
    /// first one.
    pub fn picture(&self) -> Option<AnyElement> {
        match &self.frame.as_ref()?.picture {
            Picture::Image(image) => Some(
                img(image.clone())
                    .object_fit(ObjectFit::Contain)
                    .size_full()
                    .into_any_element(),
            ),
            #[cfg(target_os = "macos")]
            Picture::Buffer(buffer) => Some(
                gpui_kit::surface(buffer.0.clone())
                    .object_fit(ObjectFit::Contain)
                    .size_full()
                    .into_any_element(),
            ),
        }
    }

    /// Whether the player has pictures to take: it is loading, playing, or landing a seek.
    pub fn wants_frames(&self) -> bool {
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
    pub fn poll(&mut self, refresh: Duration, window: &mut Window) -> bool {
        for image in RETIRED.lock().unwrap_or_else(|p| p.into_inner()).drain(..) {
            window.drop_image(image).ok();
        }
        self.shared.set_refresh(refresh);

        let mut changed = self.poll_status();
        if matches!(self.status, VideoStatus::Failed(_)) {
            return changed;
        }

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
            if let Some(samples) = &mut self.samples {
                let late = rendered.due.map(|due| signed_seconds(shown, due));
                // mpv's avsync is the sound's time less the picture's at the due time; the
                // picture then reaches the screen `late` after that.
                let lead = late.zip(avsync).map(|(late, avsync)| -avsync - late);
                samples.frame(MpvFrameSample::new(
                    seconds(time_pos),
                    lead,
                    late,
                    rendered.draw_time,
                    taken.saturating_duration_since(rendered.rendered_at),
                ));
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
            self.frame_position = seconds(time_pos);
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
                let seek = self.seek.take().expect("a seek is pending");
                if let Some(samples) = &mut self.samples {
                    let finished = restarted_at
                        .map(|at| at.saturating_duration_since(seek.requested_at))
                        .unwrap_or_default();
                    samples.seek(MpvSeekSample::new(
                        seek.mode,
                        seek.target,
                        seconds(restart_pos),
                        landing.unwrap_or(finished),
                        finished,
                    ));
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
        if let Some(samples) = &mut self.samples {
            samples.ready();
        }
        true
    }
}

impl Drop for MpvPlayer {
    fn drop(&mut self) {
        // Silent at once; the core may take a moment longer to go.
        self.core.set_flag(c"pause", true);
        self.shared.stop();
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
        if let Some((render, events)) = self.threads.take() {
            client::shut_down(self.core.clone(), render, events);
        }
    }
}

/// A player [`pump_frames`] can keep polling.
pub trait Pumped {
    fn pump_scheduled(&mut self) -> &mut bool;
    fn wants_frames(&self) -> bool;
    fn poll(&mut self, refresh: Duration, window: &mut Window) -> bool;
}

impl Pumped for MpvPlayer {
    fn pump_scheduled(&mut self) -> &mut bool {
        &mut self.pump_scheduled
    }

    fn wants_frames(&self) -> bool {
        MpvPlayer::wants_frames(self)
    }

    fn poll(&mut self, refresh: Duration, window: &mut Window) -> bool {
        MpvPlayer::poll(self, refresh, window)
    }
}

/// Keeps `player` taking frames once per display refresh while it has any to show, and
/// re-renders the view only when a poll says something changed, as `video::pump_frames` does.
/// Call it from the view's `render` and after any command that may start motion.
pub fn pump_frames<V: 'static, P: Pumped + 'static>(
    view: &mut V,
    player: fn(&mut V) -> &mut P,
    window: &mut Window,
    cx: &mut Context<V>,
) {
    let video = player(view);
    if *video.pump_scheduled() || !video.wants_frames() {
        return;
    }
    *video.pump_scheduled() = true;
    let view = cx.weak_entity();
    window.on_next_frame(move |window, cx| {
        let refresh = window.refresh_interval(cx).unwrap_or(DEFAULT_REFRESH);
        view.update(cx, |view, cx| {
            let video = player(view);
            *video.pump_scheduled() = false;
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
fn signed_seconds(a: Instant, b: Instant) -> f64 {
    match a.checked_duration_since(b) {
        Some(after) => after.as_secs_f64(),
        None => -b.duration_since(a).as_secs_f64(),
    }
}
