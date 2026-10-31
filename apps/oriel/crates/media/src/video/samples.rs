//! Timings a player keeps when asked, for plan 063's Phase 0 measurements: open to the first
//! picture, each seek to its picture, and each picture shown against AVPlayer's clock.

use std::time::{Duration, Instant};

use super::SeekMode;

/// The timings of one player since [`super::VideoPlayer::record_samples`].
pub struct VideoSamples {
    started: Instant,
    ready_after: Option<Duration>,
    first_frame_after: Option<Duration>,
    seeks: Vec<SeekSample>,
    frames: Vec<FrameSample>,
}

/// One seek: where it was asked to go, which picture it landed on, and how long that took.
#[derive(Clone, Copy, Debug)]
pub struct SeekSample {
    mode: SeekMode,
    target: Duration,
    landed: Duration,
    took: Duration,
    finished: Duration,
    keyframe: bool,
}

/// One picture handed to the window: when, its time in the video, and the time AVPlayer's
/// clock, which the sound follows, will read when the window shows it.
#[derive(Clone, Copy, Debug)]
pub struct FrameSample {
    at: Instant,
    time: Duration,
    clock: Duration,
}

impl VideoSamples {
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

    pub(super) fn frame(&mut self, time: Duration, clock: Duration) {
        self.first_frame_after.get_or_insert(self.started.elapsed());
        self.frames.push(FrameSample {
            at: Instant::now(),
            time,
            clock,
        });
    }

    pub(super) fn seek(&mut self, seek: SeekSample) {
        self.seeks.push(seek);
    }

    /// From the open to AVFoundation reading the file as playable.
    pub fn ready_after(&self) -> Option<Duration> {
        self.ready_after
    }

    /// From the open to the first picture handed to the window.
    pub fn first_frame_after(&self) -> Option<Duration> {
        self.first_frame_after
    }

    pub fn seeks(&self) -> &[SeekSample] {
        &self.seeks
    }

    pub fn frames(&self) -> &[FrameSample] {
        &self.frames
    }

    /// Forgets the pictures so far, to measure a steady stretch on its own.
    pub fn clear_frames(&mut self) {
        self.frames.clear();
    }
}

impl SeekSample {
    pub(super) fn new(
        mode: SeekMode,
        target: Duration,
        landed: Duration,
        took: Duration,
        finished: Duration,
        keyframe: bool,
    ) -> Self {
        Self {
            mode,
            target,
            landed,
            took,
            finished,
            keyframe,
        }
    }

    pub fn mode(&self) -> SeekMode {
        self.mode
    }

    pub fn target(&self) -> Duration {
        self.target
    }

    /// The time of the first picture after the seek.
    pub fn landed(&self) -> Duration {
        self.landed
    }

    /// From the seek's request to its first picture handed to the window.
    pub fn took(&self) -> Duration {
        self.took
    }

    /// From the seek's request to AVPlayer calling it done.
    pub fn finished(&self) -> Duration {
        self.finished
    }

    /// Whether an exact seek landed on the keyframe before its target, because the file's
    /// exact seeks show no picture.
    pub fn keyframe(&self) -> bool {
        self.keyframe
    }
}

impl FrameSample {
    pub fn at(&self) -> Instant {
        self.at
    }

    pub fn time(&self) -> Duration {
        self.time
    }

    /// The picture's time less AVPlayer's clock when it is shown, in seconds: above zero the
    /// picture is early, below it late.
    pub fn lead(&self) -> f64 {
        self.time.as_secs_f64() - self.clock.as_secs_f64()
    }
}
