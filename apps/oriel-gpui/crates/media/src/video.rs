//! Video: AVPlayer decodes, and each display frame is drawn with GPUI's `surface()` (plan 063,
//! "Media in GPUI").
//!
//! AVPlayer owns decoding, sound, A/V sync, seeking, volume and rate. A [`VideoPlayer`] asks its
//! `AVPlayerItemVideoOutput` for the picture due at the next display refresh and hands that
//! `CVPixelBuffer` to `surface()` as it is: GPUI's Metal renderer makes textures straight from
//! the buffer's IOSurface, so no pixel is copied on the way. [`pump_frames`] runs that loop for a
//! view, once per display frame while the player has something to show, and re-renders the view
//! only when a new picture or a change of state arrives: a 30 fps video on a 120 Hz display
//! draws the window 30 times a second, and a paused one not at all.
//!
//! A player is main-thread only, as AVPlayer is. Containers AVPlayer cannot open (MKV, WebM,
//! AVI, FLV, ASF) fail at [`VideoPlayer::open`], before AVFoundation sees them, with the error
//! the viewer shows over the poster.

#[cfg(target_os = "macos")]
mod av_player;
mod samples;
#[cfg(not(target_os = "macos"))]
mod unsupported;

use std::fmt;
use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use gpui_kit::{Context, ObjectFit, Surface, Window};

#[cfg(target_os = "macos")]
use av_player::AvPlayer;
#[cfg(not(target_os = "macos"))]
use unsupported::AvPlayer;

pub use samples::{FrameSample, SeekSample, VideoSamples};

/// The containers Tidy's Convert turns into MP4, because AVPlayer cannot open them.
const UNPLAYABLE_CONTAINERS: [(&str, &str); 6] = [
    ("mkv", "MKV"),
    ("webm", "WebM"),
    ("avi", "AVI"),
    ("flv", "FLV"),
    ("asf", "ASF"),
    ("wmv", "WMV"),
];

/// How long a ready player may go without its first picture before it is called unplayable: the
/// file opened, but its video track does not decode here (AV1 on a Mac before the M3, say).
const FIRST_PICTURE_TIMEOUT: Duration = Duration::from_secs(5);
/// How long a seek, once AVPlayer calls it done, waits for its picture before the pump stops
/// asking. The seek itself may take longer: an exact one decodes from the keyframe before it.
const SEEK_PICTURE_TIMEOUT: Duration = Duration::from_secs(2);
/// How long a finished exact seek may go without its picture before it is taken for one the
/// decoder cannot show. A working one shows its picture when it finishes, or a frame later.
const EXACT_PICTURE_GRACE: Duration = Duration::from_millis(250);
/// How far a picture's time may be from AVPlayer's clock and still be the picture for it.
const NEAR: Duration = Duration::from_millis(150);
/// The refresh assumed when the window cannot say (it is between displays).
const DEFAULT_REFRESH: Duration = Duration::from_micros(16_667);

/// Why a video does not play.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum VideoError {
    /// A container AVPlayer cannot open, by its short name ("MKV").
    UnsupportedContainer(&'static str),
    /// AVFoundation could not open or decode the file, in its own words.
    Failed { code: i64, message: String },
    /// The file opened and has a video track, but no picture came.
    NoPicture,
    /// Video does not play here: off the main thread, or off macOS.
    Unavailable(&'static str),
}

impl fmt::Display for VideoError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::UnsupportedContainer(format) => {
                write!(f, "Can't play {format} here; Convert makes it MP4")
            }
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

/// One video file, played by AVPlayer, with the picture due now ready for `surface()`.
pub struct VideoPlayer {
    av: AvPlayer,
    status: VideoStatus,
    has_video: bool,
    frame: Option<Frame>,
    playing: bool,
    seeks: Seeks,
    awaiting_picture_since: Option<Instant>,
    pump_scheduled: bool,
    opened_at: Instant,
    samples: Option<VideoSamples>,
}

struct Frame {
    #[cfg(target_os = "macos")]
    buffer: gpui_kit::SurfaceSource,
    time: Duration,
}

impl VideoPlayer {
    /// Opens `path` for playing, paused at its start. AVFoundation reads the file in the
    /// background; [`Self::status`] turns `Ready` or `Failed` on a later [`Self::poll`].
    pub fn open(path: &Path) -> Result<Self, VideoError> {
        if let Some(format) = unplayable_container(path) {
            return Err(VideoError::UnsupportedContainer(format));
        }
        Self::open_any(path)
    }

    /// Opens `path` without refusing the containers AVPlayer is known not to play, to see what
    /// AVFoundation itself makes of them.
    pub fn open_any(path: &Path) -> Result<Self, VideoError> {
        if !path.is_file() {
            return Err(VideoError::Failed {
                code: 0,
                message: "the file is missing".into(),
            });
        }
        let opened_at = Instant::now();
        Ok(Self {
            av: AvPlayer::open(path)?,
            status: VideoStatus::Loading,
            has_video: false,
            frame: None,
            playing: false,
            seeks: Seeks::default(),
            awaiting_picture_since: None,
            pump_scheduled: false,
            opened_at,
            samples: None,
        })
    }

    /// Starts keeping timings, from the open, of the first picture, each seek and each picture
    /// shown, for the spike's measurements. Off by default: a long video would keep a sample per
    /// frame.
    pub fn record_samples(&mut self) {
        self.samples = Some(VideoSamples::new(self.opened_at));
    }

    pub fn samples_mut(&mut self) -> Option<&mut VideoSamples> {
        self.samples.as_mut()
    }

    pub fn samples(&self) -> Option<&VideoSamples> {
        self.samples.as_ref()
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

    /// Whether the player means to play: true from [`Self::play`] until a pause or the end, even
    /// while AVPlayer waits for data.
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
        self.av.play();
        self.playing = true;
    }

    pub fn pause(&mut self) {
        self.av.pause();
        self.playing = false;
    }

    pub fn toggle_playback(&mut self) {
        if self.playing {
            self.pause();
        } else {
            self.play();
        }
    }

    /// Moves to `target`, clamped to the video. While a seek is in flight the newest target
    /// waits for it rather than cancelling it, so dragging the scrubber keeps showing pictures
    /// instead of starting a decode it then abandons.
    pub fn seek(&mut self, target: Duration, mode: SeekMode) {
        if self.error().is_some() {
            return;
        }
        let target = match self.duration() {
            Some(duration) => target.min(duration),
            None => target,
        };
        let seek = self.seeks.request(target, mode);
        if self.seeks.in_flight.is_some() {
            self.seeks.queued = Some(seek);
        } else {
            self.start_seek(seek);
        }
    }

    /// Moves by `seconds`, back when negative, landing on the exact frame.
    pub fn skip(&mut self, seconds: f64) {
        let target = (self.position().as_secs_f64() + seconds).max(0.);
        self.seek(Duration::from_secs_f64(target), SeekMode::Exact);
    }

    /// Where playback is, or where the newest seek is going while it is under way.
    pub fn position(&self) -> Duration {
        if let Some(seek) = self.seeks.queued.as_ref().or(self.seeks.in_flight.as_ref()) {
            return seek.target;
        }
        let position = self.av.current_time();
        match self.duration() {
            Some(duration) => position.min(duration),
            None => position,
        }
    }

    /// The video's length, once AVFoundation has read it.
    pub fn duration(&self) -> Option<Duration> {
        self.av.duration()
    }

    /// Whether it has played to its end and stopped there.
    pub fn has_ended(&self) -> bool {
        !self.playing
            && self.status == VideoStatus::Ready
            && self.seeks.in_flight.is_none()
            && self.duration().is_some_and(|duration| {
                self.av.current_time() + Duration::from_millis(1) >= duration
            })
    }

    /// 0 to 1, as AVPlayer's volume.
    pub fn volume(&self) -> f32 {
        self.av.volume()
    }

    pub fn set_volume(&mut self, volume: f32) {
        self.av.set_volume(volume.clamp(0., 1.));
    }

    pub fn is_muted(&self) -> bool {
        self.av.is_muted()
    }

    pub fn set_muted(&mut self, muted: bool) {
        self.av.set_muted(muted);
    }

    /// The speed playing runs at, 1 being normal.
    pub fn rate(&self) -> f32 {
        self.av.default_rate()
    }

    pub fn set_rate(&mut self, rate: f32) {
        self.av.set_default_rate(rate);
        if self.playing {
            self.av.set_rate(rate);
        }
    }

    /// The picture's size in pixels, once known, as the video asks to be shown.
    pub fn picture_size(&self) -> Option<(f64, f64)> {
        let (width, height) = self.av.presentation_size();
        (width > 0. && height > 0.).then_some((width, height))
    }

    /// The time of the picture on screen, if one is.
    pub fn picture_time(&self) -> Option<Duration> {
        self.frame.as_ref().map(|frame| frame.time)
    }

    /// The picture on screen as a `surface()`, fitted inside its bounds; `None` before the first
    /// one. Size it as any element.
    pub fn surface(&self) -> Option<Surface> {
        #[cfg(target_os = "macos")]
        {
            self.frame
                .as_ref()
                .map(|frame| gpui_kit::surface(frame.buffer.clone()).object_fit(ObjectFit::Contain))
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = ObjectFit::Contain;
            None
        }
    }

    /// Whether the player has pictures to pull: it is loading, playing, or landing a seek.
    pub fn wants_frames(&self) -> bool {
        match self.status {
            VideoStatus::Failed(_) => false,
            VideoStatus::Loading => true,
            VideoStatus::Ready => {
                self.playing || self.seeks.is_busy() || self.awaiting_picture_since.is_some()
            }
        }
    }

    /// Takes the picture due one display refresh from now, and catches up with AVPlayer's
    /// state. Returns whether anything a view shows changed. [`pump_frames`] calls it.
    pub fn poll(&mut self, refresh: Duration) -> bool {
        let mut changed = self.poll_status();
        if matches!(self.status, VideoStatus::Failed(_)) {
            return changed;
        }

        if let Some(seek) = &self.seeks.in_flight
            && self.seeks.finished.load(Ordering::Acquire) >= seek.generation
        {
            let mut seek = self.seeks.in_flight.take().expect("a seek is in flight");
            seek.finished_after = Some(seek.requested_at.elapsed());
            // While playing, the target's picture often comes before AVPlayer calls the seek
            // done; that one is the landing.
            match seek.latest_picture {
                Some((after, time)) if near(time, self.av.current_time()) => {
                    self.record_seek(&seek, time, after);
                }
                _ => self.seeks.landing = Some(seek),
            }
            if let Some(next) = self.seeks.queued.take() {
                self.start_seek(next);
            }
            changed = true;
        }

        if let Some((buffer, time)) = self.av.take_frame(refresh) {
            #[cfg(not(target_os = "macos"))]
            let _ = buffer;
            self.frame = Some(Frame {
                #[cfg(target_os = "macos")]
                buffer: buffer.into(),
                time,
            });
            self.awaiting_picture_since = None;
            if let Some(seek) = &mut self.seeks.in_flight {
                seek.latest_picture = Some((seek.requested_at.elapsed(), time));
            }
            if let Some(samples) = &mut self.samples {
                samples.frame(time, self.av.item_time_at(refresh));
            }
            if self.seeks.in_flight.is_none()
                && let Some(seek) = self.seeks.landing.take()
            {
                self.record_seek(&seek, time, seek.requested_at.elapsed());
            }
            changed = true;
        }

        if let Some(since) = self.awaiting_picture_since
            && since.elapsed() > FIRST_PICTURE_TIMEOUT
        {
            self.status = VideoStatus::Failed(VideoError::NoPicture);
            return true;
        }
        if let Some(seek) = &self.seeks.landing {
            let waited = seek
                .requested_at
                .elapsed()
                .saturating_sub(seek.finished_after.unwrap_or_default());
            let stale = self
                .picture_time()
                .is_none_or(|time| !near(time, self.av.current_time()));
            if seek.tolerance == Tolerance::Exact && waited > EXACT_PICTURE_GRACE && stale {
                // AVFoundation called an exact seek done that its decoder cannot show: SVT-AV1's
                // default (random access, with hidden frames) does this. The picture would
                // stay put until the next keyframe while the sound runs on from the target,
                // so land on the keyframe before the target instead, here and from now on.
                let seek = self.seeks.landing.take().expect("a seek is landing");
                log::warn!(
                    "an exact seek to {:?} showed no picture; seeking to keyframes instead",
                    seek.target
                );
                self.seeks.exact_falls_short = true;
                if self.seeks.in_flight.is_none() && self.seeks.queued.is_none() {
                    let generation = self.seeks.next();
                    self.start_seek(PendingSeek {
                        tolerance: Tolerance::KeyframeBefore,
                        finished_after: None,
                        latest_picture: None,
                        generation,
                        ..seek
                    });
                }
                changed = true;
            } else if waited > SEEK_PICTURE_TIMEOUT {
                self.seeks.landing = None;
            }
        }

        let playing = self.av.rate() != 0.;
        if playing != self.playing {
            self.playing = playing;
            changed = true;
        }
        changed
    }

    fn poll_status(&mut self) -> bool {
        if self.status != VideoStatus::Loading {
            return false;
        }
        match self.av.status() {
            VideoStatus::Loading => false,
            VideoStatus::Ready => {
                self.status = VideoStatus::Ready;
                self.has_video = self.picture_size().is_some();
                if self.has_video && self.frame.is_none() {
                    self.awaiting_picture_since = Some(Instant::now());
                }
                if let Some(samples) = &mut self.samples {
                    samples.ready();
                }
                true
            }
            VideoStatus::Failed(error) => {
                self.status = VideoStatus::Failed(error);
                self.playing = false;
                true
            }
        }
    }

    fn start_seek(&mut self, seek: PendingSeek) {
        let (before, after) = match seek.tolerance {
            Tolerance::Exact => (false, false),
            Tolerance::KeyframeBefore => (true, false),
            Tolerance::Any => (true, true),
        };
        self.av.seek(
            seek.target,
            before,
            after,
            seek.generation,
            self.seeks.finished.clone(),
        );
        self.seeks.in_flight = Some(seek);
    }

    fn record_seek(&mut self, seek: &PendingSeek, landed: Duration, took: Duration) {
        if let Some(samples) = &mut self.samples {
            samples.seek(SeekSample::new(
                seek.mode,
                seek.target,
                landed,
                took,
                seek.finished_after.unwrap_or_default(),
                seek.tolerance != Tolerance::Exact && seek.mode == SeekMode::Exact,
            ));
        }
    }
}

impl Drop for VideoPlayer {
    fn drop(&mut self) {
        // AVPlayer keeps playing sound until it is deallocated, and something else (a pending
        // seek's block) may hold it a moment longer.
        self.av.pause();
    }
}

/// Keeps `player` pulling pictures once per display frame while it has any to show, and
/// re-renders the view only when [`VideoPlayer::poll`] says something changed. Call it from the
/// view's `render` and after any command that may start motion (play, seek); while a poll is
/// already pending it does nothing.
pub fn pump_frames<V: 'static>(
    view: &mut V,
    player: fn(&mut V) -> &mut VideoPlayer,
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
            if video.poll(refresh) {
                cx.notify();
            }
            pump_frames(view, player, window, cx);
        })
        .ok();
    });
}

fn unplayable_container(path: &Path) -> Option<&'static str> {
    let extension = path.extension()?.to_str()?.to_ascii_lowercase();
    UNPLAYABLE_CONTAINERS
        .iter()
        .find(|(known, _)| *known == extension)
        .map(|(_, name)| *name)
}

/// The seek in flight, the one waiting behind it, and the one that finished but whose picture
/// has not come yet.
#[derive(Default)]
struct Seeks {
    last_generation: u64,
    /// The newest generation AVPlayer finished (or abandoned), written from its completion block.
    finished: Arc<AtomicU64>,
    in_flight: Option<PendingSeek>,
    queued: Option<PendingSeek>,
    landing: Option<PendingSeek>,
    /// Whether an exact seek in this file has shown no picture, so exact seeks land on the
    /// keyframe before their target.
    exact_falls_short: bool,
}

impl Seeks {
    fn next(&mut self) -> u64 {
        self.last_generation += 1;
        self.last_generation
    }

    fn request(&mut self, target: Duration, mode: SeekMode) -> PendingSeek {
        let tolerance = match mode {
            SeekMode::Exact if self.exact_falls_short => Tolerance::KeyframeBefore,
            SeekMode::Exact => Tolerance::Exact,
            SeekMode::Fast => Tolerance::Any,
        };
        PendingSeek {
            target,
            mode,
            tolerance,
            generation: self.next(),
            requested_at: Instant::now(),
            finished_after: None,
            latest_picture: None,
        }
    }

    fn is_busy(&self) -> bool {
        self.in_flight.is_some() || self.queued.is_some() || self.landing.is_some()
    }
}

/// Where AVPlayer may land relative to a seek's target.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Tolerance {
    Exact,
    KeyframeBefore,
    Any,
}

struct PendingSeek {
    target: Duration,
    mode: SeekMode,
    tolerance: Tolerance,
    generation: u64,
    requested_at: Instant,
    /// When AVPlayer called the seek done.
    finished_after: Option<Duration>,
    /// The newest picture handed out while the seek was in flight: when, and its time.
    latest_picture: Option<(Duration, Duration)>,
}

/// Whether a picture's time is the clock's, give or take a few frames.
fn near(picture: Duration, clock: Duration) -> bool {
    picture.abs_diff(clock) <= NEAR
}

#[cfg(test)]
mod tests {
    use super::*;

    /// These fail before AVFoundation sees them, with the words the viewer shows over the poster.
    #[test]
    fn refuses_the_containers_convert_turns_into_mp4() {
        for (name, format) in [
            ("clip.mkv", "MKV"),
            ("clip.WEBM", "WebM"),
            ("clip.avi", "AVI"),
            ("clip.flv", "FLV"),
            ("clip.asf", "ASF"),
        ] {
            assert_eq!(
                VideoPlayer::open(Path::new(name)).err(),
                Some(VideoError::UnsupportedContainer(format)),
                "{name}"
            );
        }
        assert_eq!(
            VideoError::UnsupportedContainer("MKV").to_string(),
            "Can't play MKV here; Convert makes it MP4"
        );
    }
}
