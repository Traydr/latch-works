//! How many uploads a push runs at once when the caller leaves it to Sync (owner's decision 22):
//! up to 6, backing off when more at once stops adding speed.
//!
//! Electron Oriel's lockstep-core always runs 3. On the local stack 6 at once pushed 2,000 stills
//! in about half the time, but more uploads at once only help while the link has room: on a link
//! that is already full they split the same bandwidth. So the width climbs, one step at a time,
//! while each step brings a measured gain, and comes back down when it does not.
//!
//! - It starts at 3, as Electron Oriel runs.
//! - It measures the total throughput at the current width over a window of completed uploads:
//!   the bytes every upload sent in the window, over the window's time. A window closes once it
//!   holds at least two completions per upload slot and a second has passed, so neither one
//!   large file nor a burst of small ones decides alone. The first completion only starts the
//!   clock, which leaves the run's start-up out of the first window; after a change of width the
//!   clock starts once as many uploads have completed as there are slots, so they settle first.
//! - With that baseline it adds a slot and measures again. A gain of at least 10% keeps the new
//!   width and probes the next one, up to 6. A window without that gain gets one more, since a
//!   busy machine or server makes single windows noisy. Two without it mean the link, not the
//!   width, is the limit: the width goes back one step and holds there before it measures and
//!   probes again.
//! - A sign of overload (a 429 or 5xx answer, a timeout, a dropped connection) takes a slot away
//!   at once, down to 1, and holds as well.
//! - A hold lasts 5 s, and each one after it without a kept gain in between twice as long, up to
//!   a minute. A step back that noise caused costs a few seconds; on a link that is really full
//!   the probes grow rare and the width settles.
//!
//! The controller only does arithmetic on the samples it is given, with times the caller
//! measures, so the same samples always give the same widths and tests can drive it with
//! made-up throughputs.

use std::time::Duration;

use crate::rules::DEFAULT_UPLOAD_CONCURRENCY;

/// The most uploads a push runs at once on its own.
pub const MAX_ADAPTIVE_UPLOADS: usize = 6;

/// The fewest it backs off to.
const MIN_UPLOADS: usize = 1;

/// The gain one more upload at once must bring to be kept.
const MEANINGFUL_GAIN: f64 = 0.10;

/// A window holds at least this many completions per upload slot...
const SAMPLES_PER_SLOT: usize = 2;

/// ...and lasts at least this long.
const MIN_WINDOW: Duration = Duration::from_secs(1);

/// The first hold after a step back, and the longest any grows to.
const FIRST_HOLD: Duration = Duration::from_secs(5);
const LONGEST_HOLD: Duration = Duration::from_secs(60);

/// What happened to one upload, at a time measured from the push's start.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum UploadSample {
    /// An upload completed; `bytes` is what all the uploads sent since the last sample.
    Completed { bytes: u64, at: Duration },
    /// It failed in a way that says the server or the link is overloaded.
    Overloaded { at: Duration },
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum Phase {
    /// Measuring the current width. With a baseline the width is a probe, one above the
    /// baseline's, and `missed` says whether a window at it has already shown no gain.
    Measuring { baseline: Option<f64>, missed: bool },
    /// Holding the current width until then.
    Holding { until: Duration },
}

impl Phase {
    const FRESH: Self = Self::Measuring {
        baseline: None,
        missed: false,
    };
}

/// The completions counted toward one throughput measurement.
#[derive(Clone, Copy, Debug, PartialEq)]
struct Window {
    /// When the window opened: the completion before its first, or `None` until one comes.
    started: Option<Duration>,
    /// Completions still to pass before the window opens.
    settling: usize,
    bytes: u64,
    samples: usize,
}

impl Window {
    /// A window that opens at once, at `at`.
    fn open(at: Duration) -> Self {
        Self {
            started: Some(at),
            settling: 0,
            bytes: 0,
            samples: 0,
        }
    }

    /// A window that opens once `completions` more uploads have completed. After a change of
    /// width the uploads in flight, and the buffers between them and the server, settle first:
    /// a new connection fills its socket's buffer at once, which would read as speed the link
    /// does not have.
    fn after(completions: usize) -> Self {
        Self {
            started: None,
            settling: completions.max(1),
            bytes: 0,
            samples: 0,
        }
    }
}

/// The adaptive upload width.
#[derive(Clone, Debug)]
pub struct UploadWidth {
    width: usize,
    phase: Phase,
    window: Window,
    /// How long the next step back holds.
    next_hold: Duration,
    /// Each width the push ran at, with when it started.
    history: Vec<(Duration, usize)>,
}

impl Default for UploadWidth {
    fn default() -> Self {
        Self::new()
    }
}

impl UploadWidth {
    /// A controller at Electron Oriel's width, 3, about to measure it.
    pub fn new() -> Self {
        Self {
            width: DEFAULT_UPLOAD_CONCURRENCY,
            phase: Phase::FRESH,
            window: Window::after(1),
            next_hold: FIRST_HOLD,
            history: vec![(Duration::ZERO, DEFAULT_UPLOAD_CONCURRENCY)],
        }
    }

    /// How many uploads may run at once now.
    pub fn width(&self) -> usize {
        self.width
    }

    /// Each width the push ran at, with the time it took over, in order.
    pub fn history(&self) -> &[(Duration, usize)] {
        &self.history
    }

    /// Folds in one upload's outcome.
    pub fn record(&mut self, sample: UploadSample) {
        let (bytes, at) = match sample {
            UploadSample::Overloaded { at } => {
                self.set_width(self.width.saturating_sub(1).max(MIN_UPLOADS), at);
                self.back_off(at);
                return;
            }
            UploadSample::Completed { bytes, at } => (bytes, at),
        };
        let (baseline, missed) = match self.phase {
            Phase::Holding { until } if at < until => return,
            Phase::Holding { .. } => {
                self.phase = Phase::FRESH;
                self.window = Window::after(self.width);
                return;
            }
            Phase::Measuring { baseline, missed } => (baseline, missed),
        };
        let Some(rate) = self.measure(bytes, at) else {
            return;
        };
        match baseline {
            Some(baseline) if rate < baseline * (1.0 + MEANINGFUL_GAIN) => {
                if missed {
                    self.set_width(self.width - 1, at);
                    self.back_off(at);
                } else {
                    self.phase = Phase::Measuring {
                        baseline: Some(baseline),
                        missed: true,
                    };
                }
            }
            _ if self.width < MAX_ADAPTIVE_UPLOADS => {
                if baseline.is_some() {
                    // The probe paid: the next step back starts the holds over.
                    self.next_hold = FIRST_HOLD;
                }
                self.phase = Phase::Measuring {
                    baseline: Some(rate),
                    missed: false,
                };
                self.set_width(self.width + 1, at);
                self.window = Window::after(self.width);
            }
            // At the top there is nothing more to probe; it holds, then measures again.
            _ => self.hold(at, FIRST_HOLD),
        }
    }

    /// Adds a completion to the window; the window's throughput in bytes a second once it is
    /// full, when the next window opens.
    fn measure(&mut self, bytes: u64, at: Duration) -> Option<f64> {
        let Some(started) = self.window.started else {
            self.window.settling -= 1;
            if self.window.settling == 0 {
                self.window.started = Some(at);
            }
            return None;
        };
        self.window.bytes += bytes;
        self.window.samples += 1;
        let span = at.saturating_sub(started);
        if self.window.samples < SAMPLES_PER_SLOT * self.width || span < MIN_WINDOW {
            return None;
        }
        let rate = self.window.bytes as f64 / span.as_secs_f64();
        self.window = Window::open(at);
        Some(rate)
    }

    /// Holds after a step back, each time longer until a probe pays.
    fn back_off(&mut self, at: Duration) {
        self.hold(at, self.next_hold);
        self.next_hold = (self.next_hold * 2).min(LONGEST_HOLD);
    }

    fn hold(&mut self, at: Duration, hold: Duration) {
        self.phase = Phase::Holding { until: at + hold };
    }

    fn set_width(&mut self, width: usize, at: Duration) {
        if width != self.width {
            self.width = width;
            self.history.push((at, width));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Feeds completions of `bytes` each, `every` apart, from `from`, until `until`; returns the
    /// time after the last.
    fn feed(
        width: &mut UploadWidth,
        from: Duration,
        until: Duration,
        rate_at: impl Fn(usize) -> f64,
    ) -> Duration {
        const BYTES: u64 = 1_000_000;
        let mut at = from;
        while at < until {
            // The time one upload's bytes take at the throughput this width reaches.
            at += Duration::from_secs_f64(BYTES as f64 / rate_at(width.width()));
            width.record(UploadSample::Completed { bytes: BYTES, at });
        }
        at
    }

    fn widths(width: &UploadWidth) -> Vec<usize> {
        width.history().iter().map(|&(_, width)| width).collect()
    }

    #[test]
    fn it_climbs_to_six_while_each_step_adds_speed() {
        let mut width = UploadWidth::new();
        // Latency-bound: each upload at once adds 5 MB/s.
        feed(&mut width, Duration::ZERO, Duration::from_secs(60), |w| {
            w as f64 * 5e6
        });
        assert_eq!(widths(&width), [3, 4, 5, 6]);
        assert_eq!(width.width(), 6);
    }

    /// How long the push ran at `width` before `end`.
    fn time_at(width: &UploadWidth, at_width: usize, end: Duration) -> Duration {
        let history = width.history();
        history
            .iter()
            .enumerate()
            .filter(|&(_, &(_, w))| w == at_width)
            .map(|(index, &(from, _))| {
                history.get(index + 1).map_or(end, |&(to, _)| to).min(end) - from
            })
            .sum()
    }

    #[test]
    fn on_a_full_link_it_steps_back_and_probes_ever_more_rarely() {
        let mut width = UploadWidth::new();
        // The link carries 2 MB/s however many uploads share it.
        let end = Duration::from_secs(300);
        feed(&mut width, Duration::ZERO, end, |_| 2e6);
        // Each probe of a fourth upload takes two windows and is given back; the holds between
        // them grow from 5 s to a minute.
        let probes: Vec<u64> = width
            .history()
            .iter()
            .filter(|&&(_, w)| w == 4)
            .map(|&(at, _)| at.as_secs())
            .collect();
        assert_eq!(probes, [3, 23, 47, 82, 136, 211, 285]);
        assert_eq!(width.width(), 3);
        assert!(time_at(&width, 3, end) > end * 3 / 4);
    }

    #[test]
    fn it_keeps_the_widest_step_that_still_paid() {
        let mut width = UploadWidth::new();
        // Gains up to 5 at once, then the link is full.
        feed(&mut width, Duration::ZERO, Duration::from_secs(15), |w| {
            w.min(5) as f64 * 1e6
        });
        assert_eq!(widths(&width), [3, 4, 5, 6, 5]);
    }

    #[test]
    fn a_gain_under_ten_percent_is_not_worth_a_slot() {
        let mut width = UploadWidth::new();
        feed(&mut width, Duration::ZERO, Duration::from_secs(10), |w| {
            if w > 3 { 3.2e6 } else { 3e6 }
        });
        assert_eq!(widths(&width), [3, 4, 3]);
    }

    #[test]
    fn overload_takes_a_slot_away_at_once_down_to_one() {
        let mut width = UploadWidth::new();
        for second in 1..=5 {
            width.record(UploadSample::Overloaded {
                at: Duration::from_secs(second),
            });
        }
        assert_eq!(widths(&width), [3, 2, 1]);
        // It holds after an overload: completions inside the hold change nothing.
        feed(
            &mut width,
            Duration::from_secs(5),
            Duration::from_secs(20),
            |w| w as f64 * 5e6,
        );
        assert_eq!(width.width(), 1);
        // Afterwards it climbs again while that pays.
        feed(
            &mut width,
            Duration::from_secs(25),
            Duration::from_secs(80),
            |w| w as f64 * 5e6,
        );
        assert_eq!(widths(&width), [3, 2, 1, 2, 3, 4, 5, 6]);
    }

    #[test]
    fn a_window_needs_two_completions_a_slot_and_a_second() {
        let mut width = UploadWidth::new();
        // The first completion only starts the clock; six more inside a second decide nothing.
        for tenth in 0..7 {
            width.record(UploadSample::Completed {
                bytes: 1,
                at: Duration::from_millis(100 * tenth),
            });
        }
        assert_eq!(width.width(), 3);
        width.record(UploadSample::Completed {
            bytes: 1,
            at: Duration::from_millis(1_000),
        });
        assert_eq!(width.width(), 4);
    }
}
