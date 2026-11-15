//! The picture of an exact seek, shown before the player's own core has landed there.
//!
//! Where hardware plays a file for less CPU but software decodes to a seek's target sooner
//! (`client::QuickSeeks::BySeekPicture`), the player keeps a second core on the same file:
//! paused, silent, and decoding in software. An exact seek goes to both. The second core lands
//! first, and its frame stands in for the player's until the player's own core has landed and
//! plays on from there. Both cores draw through the same renderer, so the two frames are the
//! same picture.
//!
//! The second core holds the file's decoders a second time, which is memory and no CPU while
//! it waits, so the player opens it at a seek and closes it a while after the last
//! (`SEEK_PICTURE_KEEP`). Its engine is its own, started for it and shut down with it, and never
//! one of the idle ones: those wait for the next video with the shaders hardware frames need,
//! and this one's are for software frames.

use std::sync::Arc;
use std::time::{Duration, Instant};

use super::client::{Core, Decode};
use super::engine::{Engine, EngineOptions};
use super::render::{Rendered, Shared};
use super::{VideoError, retire};

pub(super) struct SeekPicture {
    core: Arc<Core>,
    shared: Arc<Shared>,
    /// What decodes the file; shut down when this goes.
    engine: Option<Engine>,
    /// Its newest frame.
    frame: Option<Rendered>,
    /// The seek it was sent last: its number, and when.
    sought: Option<(u64, Instant)>,
    /// Where to seek once its file is open: the newest seek came before that.
    waiting: Option<f64>,
    /// When the player last had a use for it.
    wanted_at: Instant,
}

impl SeekPicture {
    /// Opens `path` on a new engine made as `options` say: paused at its start, without its
    /// sound, decoded in software.
    pub(super) fn open(path: String, options: &EngineOptions) -> Result<Self, VideoError> {
        let engine = Engine::start(options)?;
        engine.load(path, false, Decode::Software);
        Ok(Self {
            core: engine.core.clone(),
            shared: engine.shared.clone(),
            engine: Some(engine),
            frame: None,
            sought: None,
            waiting: None,
            wanted_at: Instant::now(),
        })
    }

    /// Whether its file is open, so that a seek goes to it at once.
    pub(super) fn is_ready(&self) -> bool {
        let observed = self.core.observed();
        observed.file_loaded && observed.failed.is_none() && self.shared.failure().is_none()
    }

    /// Notes that the player has a use for it now.
    pub(super) fn keep(&mut self) {
        self.wanted_at = Instant::now();
    }

    /// How long since the player last had a use for it.
    pub(super) fn unwanted_for(&self) -> Duration {
        self.wanted_at.elapsed()
    }

    /// Seeks to the frame at `seconds` into the file: now if the file is open, else as soon as
    /// a later [`Self::take`] finds it open, since mpv would lose a seek sent sooner. A first
    /// seek's picture so still comes from here, the file's open later.
    pub(super) fn seek(&mut self, seconds: f64) {
        if self.is_ready() {
            self.sought = Some((self.core.seek(seconds, true), Instant::now()));
            self.waiting = None;
        } else {
            self.sought = None;
            self.waiting = Some(seconds);
        }
    }

    /// Takes its newest frame, for a window that refreshes next at `shown`, and hands the frame
    /// that one replaces to `retire`. Returns whether there was a newer one. Sends the seek
    /// that waited for the file, if the file is open now.
    pub(super) fn take(&mut self, shown: Instant, retire: impl FnOnce(Rendered)) -> bool {
        if let Some(seconds) = self.waiting.filter(|_| self.is_ready()) {
            self.seek(seconds);
        }
        let Some(rendered) = self.shared.take(shown) else {
            return false;
        };
        if let Some(old) = self.frame.replace(rendered) {
            retire(old);
        }
        true
    }

    /// Whether its frame is the picture of the seek it was sent last: mpv has landed that seek,
    /// and the frame mpv drew for it, or one since, is the one taken.
    pub(super) fn has_landed(&self) -> bool {
        let Some((number, sent)) = self.sought else {
            return false;
        };
        let (landed, restarted_at) = {
            let observed = self.core.observed();
            (observed.landed, observed.restarted_at)
        };
        landed >= number
            && restarted_at
                .and_then(|at| self.shared.begun_by(sent, at))
                .zip(self.frame.as_ref())
                .is_some_and(|(first, frame)| frame.number >= first)
    }

    /// Where its newest seek landed, in seconds.
    #[cfg(test)]
    pub(super) fn landed_at(&self) -> Option<f64> {
        self.core.observed().restart_pos
    }

    /// What decodes its file, in mpv's word: "no" is software.
    #[cfg(test)]
    pub(super) fn decoder(&self) -> Option<String> {
        self.core.get_string(c"hwdec-current")
    }

    pub(super) fn frame(&self) -> Option<&Rendered> {
        self.frame.as_ref()
    }
}

impl Drop for SeekPicture {
    fn drop(&mut self) {
        if let Some(frame) = self.frame.take() {
            retire(frame);
        }
        if let Some(engine) = self.engine.take() {
            engine.shut_down();
        }
    }
}
