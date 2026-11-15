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
//! it waits: 100 to 250 MB up to 1080p, and 800 to 950 MB at 4K. Seeks come in runs, so the
//! player opens it at a seek, and a thread of its own closes it [`KEEP`] after the last,
//! whether or not the window draws meanwhile. Its engine is its own, started for it and shut
//! down with it, and never one of the idle ones: those wait for the next video with the shaders
//! hardware frames need, and this one's are for software frames.

use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use super::client::Decode;
use super::engine::{Engine, EngineOptions};
use super::render::Rendered;
use super::{VideoError, retire};

/// How long the second core stays open after the player last had a use for it.
const KEEP: Duration = Duration::from_secs(15);

pub(super) struct SeekPicture {
    kept: Arc<Kept>,
    /// Its newest frame.
    frame: Option<Rendered>,
    /// The seek it was sent last: its number, and when.
    sought: Option<(u64, Instant)>,
    /// Where to seek once it is ready: the newest seek came before that.
    waiting: Option<f64>,
}

/// What the seek picture shares with the thread that closes it.
struct Kept {
    /// What decodes the file, until it is closed.
    engine: Mutex<Option<Engine>>,
    /// When it closes, unless the player has a use for it again first.
    until: Mutex<Instant>,
    /// Signalled when `until` is brought forward: the seek picture is going.
    hurry: Condvar,
}

impl Kept {
    fn engine(&self) -> MutexGuard<'_, Option<Engine>> {
        self.engine.lock().unwrap_or_else(|p| p.into_inner())
    }

    fn until(&self) -> MutexGuard<'_, Instant> {
        self.until.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// Waits until the time to close has come, and shuts the engine down.
    fn close_when_unwanted(&self) {
        let mut until = self.until();
        while let Some(left) = until.checked_duration_since(Instant::now())
            && !left.is_zero()
        {
            until = self
                .hurry
                .wait_timeout(until, left)
                .unwrap_or_else(|p| p.into_inner())
                .0;
        }
        drop(until);
        if let Some(engine) = self.engine().take() {
            engine.shut_down();
        }
    }
}

impl SeekPicture {
    /// Opens `path` on a new engine made as `options` say: paused at its start, without its
    /// sound, decoded in software.
    pub(super) fn open(path: String, options: &EngineOptions) -> Result<Self, VideoError> {
        let engine = Engine::start(options)?;
        engine.load(path, false, Decode::Software);
        let kept = Arc::new(Kept {
            engine: Mutex::new(Some(engine)),
            until: Mutex::new(Instant::now() + KEEP),
            hurry: Condvar::new(),
        });
        let keeper = kept.clone();
        std::thread::Builder::new()
            .name("mpv-seek-picture".into())
            .spawn(move || keeper.close_when_unwanted())
            .expect("spawn the seek picture's keeper");
        Ok(Self {
            kept,
            frame: None,
            sought: None,
            waiting: None,
        })
    }

    /// Whether it has been closed, its time up: it shows no more seeks, and the player opens
    /// another at the next.
    pub(super) fn is_closed(&self) -> bool {
        self.kept.engine().is_none()
    }

    /// Whether a seek goes to it at once: its file is open and its first frame drawn. A seek
    /// sent before the file is open is lost, and one sent before the first frame is drawn may
    /// have its own frame taken for that one.
    pub(super) fn is_ready(&self) -> bool {
        self.kept.engine().as_ref().is_some_and(|engine| {
            let observed = engine.core.observed();
            observed.file_loaded
                && observed.failed.is_none()
                && engine.shared.failure().is_none()
                && engine.shared.drawn() > 0
        })
    }

    /// Notes that the player has a use for it now, and keeps it open [`KEEP`] from now.
    pub(super) fn keep(&mut self) {
        *self.kept.until() = Instant::now() + KEEP;
    }

    /// Seeks to the frame at `seconds` into the file: now if it is ready, else as soon as a
    /// later [`Self::take`] finds it so. A first seek's picture so still comes from here, the
    /// file's open later.
    pub(super) fn seek(&mut self, seconds: f64) {
        let ready = self.is_ready();
        let engine = self.kept.engine();
        match engine.as_ref().filter(|_| ready) {
            Some(engine) => {
                self.sought = Some((engine.core.seek(seconds, true), Instant::now()));
                self.waiting = None;
            }
            None => {
                self.sought = None;
                self.waiting = Some(seconds);
            }
        }
    }

    /// Takes its newest frame, for a window that refreshes next at `shown`, and hands the frame
    /// that one replaces to `retire`. Returns whether there was a newer one. Sends the seek
    /// that waited for it to be ready, if it is now.
    pub(super) fn take(&mut self, shown: Instant, retire: impl FnOnce(Rendered)) -> bool {
        if let Some(seconds) = self.waiting.filter(|_| self.is_ready()) {
            self.seek(seconds);
        }
        let taken = self
            .kept
            .engine()
            .as_ref()
            .and_then(|engine| engine.shared.take(shown));
        let Some(rendered) = taken else {
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
        let engine = self.kept.engine();
        let Some(engine) = engine.as_ref() else {
            return false;
        };
        let (landed, restarted_at) = {
            let observed = engine.core.observed();
            (observed.landed, observed.restarted_at)
        };
        landed >= number
            && restarted_at
                .and_then(|at| engine.shared.begun_by(sent, at))
                .zip(self.frame.as_ref())
                .is_some_and(|(first, frame)| frame.number >= first)
    }

    pub(super) fn frame(&self) -> Option<&Rendered> {
        self.frame.as_ref()
    }

    /// Where its newest seek landed, in seconds.
    #[cfg(test)]
    pub(super) fn landed_at(&self) -> Option<f64> {
        let engine = self.kept.engine();
        engine.as_ref()?.core.observed().restart_pos
    }

    /// What decodes its file, in mpv's word: "no" is software.
    #[cfg(test)]
    pub(super) fn decoder(&self) -> Option<String> {
        let engine = self.kept.engine();
        engine.as_ref()?.core.get_string(c"hwdec-current")
    }
}

impl Drop for SeekPicture {
    fn drop(&mut self) {
        if let Some(frame) = self.frame.take() {
            retire(frame);
        }
        // The keeper shuts the engine down, off this thread.
        *self.kept.until() = Instant::now();
        self.kept.hurry.notify_all();
    }
}
