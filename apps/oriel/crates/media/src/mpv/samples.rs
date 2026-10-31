//! Timings an mpv player keeps when asked, for the same rows plan 063's Phase 0 measured on
//! AVPlayer: open to the first picture, each seek to its picture, and each picture shown
//! against mpv's clock, which the sound follows.

use std::time::{Duration, Instant};

use crate::video::SeekMode;

/// The timings of one player since [`super::MpvPlayer::record_samples`].
pub struct MpvSamples {
    started: Instant,
    ready_after: Option<Duration>,
    first_frame_after: Option<Duration>,
    seeks: Vec<MpvSeekSample>,
    frames: Vec<MpvFrameSample>,
}

/// One seek: where it was asked to go, where mpv says it landed, and how long its picture took.
#[derive(Clone, Copy, Debug)]
pub struct MpvSeekSample {
    mode: SeekMode,
    target: Duration,
    landed: Option<Duration>,
    took: Duration,
    finished: Duration,
}

/// One picture handed to the window.
#[derive(Clone, Copy, Debug)]
pub struct MpvFrameSample {
    at: Instant,
    position: Option<Duration>,
    lead: Option<f64>,
    late: Option<f64>,
    draw: Duration,
    waited: Duration,
}

impl MpvSamples {
    pub(super) fn new(started: Instant) -> Self {
        Self {
            started,
            ready_after: None,
            first_frame_after: None,
            seeks: Vec::new(),
            frames: Vec::new(),
        }
    }

    pub(super) fn ready(&mut self) {
        self.ready_after.get_or_insert(self.started.elapsed());
    }

    pub(super) fn frame(&mut self, frame: MpvFrameSample) {
        self.first_frame_after.get_or_insert(self.started.elapsed());
        self.frames.push(frame);
    }

    pub(super) fn seek(&mut self, seek: MpvSeekSample) {
        self.seeks.push(seek);
    }

    /// From the open to mpv reading the file (`MPV_EVENT_FILE_LOADED`).
    pub fn ready_after(&self) -> Option<Duration> {
        self.ready_after
    }

    /// From the open to the first picture handed to the window.
    pub fn first_frame_after(&self) -> Option<Duration> {
        self.first_frame_after
    }

    pub fn seeks(&self) -> &[MpvSeekSample] {
        &self.seeks
    }

    pub fn frames(&self) -> &[MpvFrameSample] {
        &self.frames
    }

    /// Forgets the pictures so far, to measure a steady stretch on its own.
    pub fn clear_frames(&mut self) {
        self.frames.clear();
    }
}

impl MpvSeekSample {
    pub(super) fn new(
        mode: SeekMode,
        target: Duration,
        landed: Option<Duration>,
        took: Duration,
        finished: Duration,
    ) -> Self {
        Self {
            mode,
            target,
            landed,
            took,
            finished,
        }
    }

    pub fn mode(&self) -> SeekMode {
        self.mode
    }

    pub fn target(&self) -> Duration {
        self.target
    }

    /// mpv's `time-pos` when it finished the seek: the time of its first frame.
    pub fn landed(&self) -> Option<Duration> {
        self.landed
    }

    /// From the request to the seek's first picture handed to the window.
    pub fn took(&self) -> Duration {
        self.took
    }

    /// From the request to mpv's `MPV_EVENT_PLAYBACK_RESTART`.
    pub fn finished(&self) -> Duration {
        self.finished
    }
}

impl MpvFrameSample {
    pub(super) fn new(
        position: Option<Duration>,
        lead: Option<f64>,
        late: Option<f64>,
        draw: Duration,
        waited: Duration,
    ) -> Self {
        Self {
            at: Instant::now(),
            position,
            lead,
            late,
            draw,
            waited,
        }
    }

    pub fn at(&self) -> Instant {
        self.at
    }

    /// mpv's `time-pos` when the picture was taken: its time, give or take the frame mpv has
    /// queued behind it.
    pub fn position(&self) -> Option<Duration> {
        self.position
    }

    /// The picture's time less the sound's when it is on screen, in seconds: above zero the
    /// picture is early. It is mpv's own A/V difference (`avsync`) plus how far the picture
    /// reached the screen after the time mpv meant; `None` without sound or for a redraw.
    pub fn lead(&self) -> Option<f64> {
        self.lead
    }

    /// How long after mpv's due time the picture reaches the screen, in seconds.
    pub fn late(&self) -> Option<f64> {
        self.late
    }

    /// How long the backend took to draw it, conversion included.
    pub fn draw(&self) -> Duration {
        self.draw
    }

    /// How long it waited in the slot for the window's next frame.
    pub fn waited(&self) -> Duration {
        self.waited
    }
}
