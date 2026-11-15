//! A video's scrubber: a slider along the video whose drag shows keyframes as it goes, with the
//! video held still, and lands on the exact frame where it is let go, playing on if the drag
//! paused it. A press alone is a click: where exact seeks are quick it lands on its frame at
//! once, without waiting to be let go. The owner draws the slider and applies each [`Scrub`]
//! to its player ([`Player::scrub`]).

use gpui_kit::base::slider::{SliderEvent, SliderState};
use gpui_kit::{App, AppContext as _, Entity};

use super::{Player, SeekMode};

pub struct Scrubber {
    slider: Entity<SliderState>,
    /// Whether the slider is held: pressed, and not yet let go.
    held: bool,
    /// Whether a drag paused the video, to play it again when the drag ends.
    resume: bool,
}

/// Where in a press of the slider one of its events comes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Moment {
    /// The press itself, which may be all of a click.
    Press,
    /// A move while it is held.
    Drag,
    /// Its letting go.
    Release,
}

/// What one of the slider's events asks of the video.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Scrub {
    /// Where to seek, as a share of the video's length.
    pub fraction: f32,
    pub moment: Moment,
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
            held: false,
            resume: false,
        }
    }

    pub fn slider(&self) -> &Entity<SliderState> {
        &self.slider
    }

    /// What `event` from [`Self::slider`] asks of a video that is `playing` now.
    pub fn scrub(&mut self, event: &SliderEvent, playing: bool) -> Scrub {
        let (value, moment) = match event {
            SliderEvent::Change(value) if self.held => (value.end(), Moment::Drag),
            SliderEvent::Change(value) => (value.end(), Moment::Press),
            SliderEvent::Release(value) => (value.end(), Moment::Release),
        };
        let released = moment == Moment::Release;
        self.held = !released;
        let pause = !released && playing;
        self.resume |= pause;
        Scrub {
            fraction: value.clamp(0., 1.),
            moment,
            pause,
            resume: released && std::mem::take(&mut self.resume),
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
        let target = duration.mul_f32(scrub.fraction);
        match scrub.moment {
            Moment::Press if self.seeks_exactly_at_once() => self.seek(target, SeekMode::Exact),
            Moment::Press | Moment::Drag => self.seek(target, SeekMode::Fast),
            // A click's press may have gone there already.
            Moment::Release if self.sought_exactly == Some(target) => {}
            Moment::Release => self.seek(target, SeekMode::Exact),
        }
        if scrub.resume {
            self.play();
        }
    }
}
