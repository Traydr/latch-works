//! A video's scrubber: a slider along the video whose drag shows keyframes as it goes, with the
//! video held still, and lands on the exact frame where it is let go, playing on if the drag
//! paused it. The owner draws the slider and applies each [`Scrub`] to its player
//! ([`Player::scrub`]).

use gpui_kit::base::slider::{SliderEvent, SliderState};
use gpui_kit::{App, AppContext as _, Entity};

use super::{Player, SeekMode};

pub struct Scrubber {
    slider: Entity<SliderState>,
    /// Whether a drag paused the video, to play it again when the drag ends.
    resume: bool,
}

/// What one of the slider's events asks of the video.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Scrub {
    /// Where to seek, as a share of the video's length.
    pub fraction: f32,
    /// Whether to land on the exact frame (the drag ended) rather than on a keyframe near it.
    pub exact: bool,
    /// Pause before seeking: a drag began while the video played.
    pub pause: bool,
    /// Play after seeking: the drag that paused the video ended.
    pub resume: bool,
}

impl Scrubber {
    /// A scrubber from 0 to 1 in steps of `step`.
    pub fn new(step: f32, cx: &mut App) -> Self {
        Self {
            slider: cx.new(|_| SliderState::new().min(0.).max(1.).step(step)),
            resume: false,
        }
    }

    pub fn slider(&self) -> &Entity<SliderState> {
        &self.slider
    }

    /// What `event` from [`Self::slider`] asks of a video that is `playing` now.
    pub fn scrub(&mut self, event: &SliderEvent, playing: bool) -> Scrub {
        let (value, exact) = match event {
            SliderEvent::Change(value) => (value.end(), false),
            SliderEvent::Release(value) => (value.end(), true),
        };
        let pause = !exact && playing;
        self.resume |= pause;
        Scrub {
            fraction: value.clamp(0., 1.),
            exact,
            pause,
            resume: exact && std::mem::take(&mut self.resume),
        }
    }
}

impl Player {
    /// Applies what the scrubber asked: pause, seek to the share of the video, and play on.
    pub fn scrub(&mut self, scrub: Scrub) {
        let Some(duration) = self.duration() else {
            return;
        };
        if scrub.pause {
            self.pause();
        }
        let mode = if scrub.exact {
            SeekMode::Exact
        } else {
            SeekMode::Fast
        };
        self.seek(duration.mul_f32(scrub.fraction), mode);
        if scrub.resume {
            self.play();
        }
    }
}
