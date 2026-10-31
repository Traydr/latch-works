//! Phase 0's measurements of View (plan 063, "Scorecard"), run by environment variables so a run
//! repeats exactly without scripted input, which this Mac does not allow.
//!
//! With [`LOG_VARIABLE`] set and a folder opened through `ORIEL_OPEN`, View lists the folder
//! recursively, as Phase 0's listing did, and writes one JSON line per event to that file:
//!
//! 1. `listed`: the folder's media are listed.
//! 2. `first-thumbnails`: the first frame drawing every visible tile with its thumbnail, timed
//!    from the process's start.
//! 3. `fill` (with `ORIEL_SPIKE_FILL=1`): every thumbnail made or found, and how fast.
//! 4. `rest`: resident memory after `ORIEL_SPIKE_REST_MS` (5 s by default) at rest.
//! 5. `scroll` (with `ORIEL_SPIKE_SCROLL=<px/s>`): the grid scrolled top to bottom at that
//!    speed, every frame's interval; then `after-scroll`, memory after the same rest.
//! 6. `steps` (with `ORIEL_SPIKE_STEPS=<n>`): the viewer opened on the first AVIF and then
//!    the first JPEG, among stills of that format only, and stepped `n` times: half a second
//!    apart (`steady`, the neighbours decoded ahead) and then a tenth apart (`rapid`).
//! 7. `workflow` (with `ORIEL_SPIKE_WORKFLOWS=1`, in place of the steps): each order, Shuffle,
//!    Refresh, and comic mode on and off, 0.7 s apart, with the time each took on the main thread.
//! 8. `done`; the app quits if `ORIEL_SPIKE_QUIT=1`.
//!
//! `ORIEL_SPIKE_WINDOW=1280x900` sizes the window first, as Electron Oriel's
//! performance script sized its window.

use std::fs::{File, OpenOptions};
use std::io::Write as _;
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use gpui_kit::{AsyncWindowContext, Context, Entity, WeakEntity, Window, px, size};
use oriel_core_domain::GallerySortMode;

use crate::listing::{MediaEntry, MediaKind};
use crate::{Gallery, Listing, ViewMode, Viewer};

pub const LOG_VARIABLE: &str = "ORIEL_SPIKE_LOG";
const FILL_VARIABLE: &str = "ORIEL_SPIKE_FILL";
const REST_VARIABLE: &str = "ORIEL_SPIKE_REST_MS";
const SCROLL_VARIABLE: &str = "ORIEL_SPIKE_SCROLL";
const STEPS_VARIABLE: &str = "ORIEL_SPIKE_STEPS";
const WORKFLOWS_VARIABLE: &str = "ORIEL_SPIKE_WORKFLOWS";
const QUIT_VARIABLE: &str = "ORIEL_SPIKE_QUIT";
const WINDOW_VARIABLE: &str = "ORIEL_SPIKE_WINDOW";

fn variable(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|value| !value.is_empty())
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum Phase {
    Listing,
    FirstFrame,
    Filling,
    /// Waiting on a timer that moves the run on.
    Waiting,
    Scrolling,
    Done,
}

pub(crate) struct Spike {
    log: File,
    fill: bool,
    rest: Duration,
    scroll: Option<f32>,
    steps: usize,
    workflows: bool,
    quit: bool,
    phase: Phase,
    created: Instant,
}

impl Spike {
    pub(crate) fn from_environment(window: &mut Window, _: &mut Context<ViewMode>) -> Option<Self> {
        let path = variable(LOG_VARIABLE)?;
        let log = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .map_err(|error| log::error!("cannot open the spike log {path}: {error}"))
            .ok()?;
        if let Some((width, height)) = variable(WINDOW_VARIABLE).and_then(|value| {
            let (width, height) = value.split_once('x')?;
            Some((width.parse::<f32>().ok()?, height.parse::<f32>().ok()?))
        }) {
            window.resize(size(px(width), px(height)));
        }
        let mut spike = Self {
            log,
            fill: variable(FILL_VARIABLE).is_some_and(|value| value == "1"),
            rest: Duration::from_millis(
                variable(REST_VARIABLE)
                    .and_then(|value| value.parse().ok())
                    .unwrap_or(5_000),
            ),
            scroll: variable(SCROLL_VARIABLE).and_then(|value| value.parse().ok()),
            steps: variable(STEPS_VARIABLE)
                .and_then(|value| value.parse().ok())
                .unwrap_or(0),
            workflows: variable(WORKFLOWS_VARIABLE).is_some_and(|value| value == "1"),
            quit: variable(QUIT_VARIABLE).is_some_and(|value| value == "1"),
            phase: Phase::Listing,
            created: Instant::now(),
        };
        spike.write(&format!(
            r#""event":"start","gpui_fast":{},"release":{},"since_launch_ms":{:.1}"#,
            gpui_kit::GPUI_FAST,
            !cfg!(debug_assertions),
            since_launch_ms(),
        ));
        Some(spike)
    }

    fn write(&mut self, fields: &str) {
        let at = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |since| since.as_millis());
        let line = format!(
            "{{\"at_ms\":{at},\"since_view_ms\":{:.1},{fields}}}\n",
            self.created.elapsed().as_secs_f64() * 1e3
        );
        if let Err(error) = self.log.write_all(line.as_bytes()) {
            log::error!("cannot write the spike log: {error}");
        }
    }

    /// Called at the start of every View frame: moves the run on when its condition holds.
    pub(crate) fn on_frame(
        &mut self,
        gallery: &Entity<Gallery>,
        _viewer: Option<&Entity<Viewer>>,
        window: &mut Window,
        cx: &mut Context<ViewMode>,
    ) {
        match self.phase {
            Phase::Listing => {
                let gallery = gallery.read(cx);
                if *gallery.listing() == Listing::Listed {
                    let count = gallery.media().len();
                    self.write(&format!(r#""event":"listed","items":{count}"#));
                    self.phase = Phase::FirstFrame;
                }
            }
            Phase::FirstFrame => {
                let state = gallery.read(cx);
                let ready = !state.media().is_empty() && state.is_drawn_complete();
                let rows = state.drawn_rows();
                let thumbnails = state.thumbnails().clone();
                let media = state.media().clone();
                if ready {
                    let stats = thumbnails.read(cx).stats();
                    self.write(&format!(
                        r#""event":"first-thumbnails","since_launch_ms":{:.1},"rows":"{}..{}","generated":{},"from_disk":{}"#,
                        since_launch_ms(),
                        rows.start,
                        rows.end,
                        stats.generated(),
                        stats.from_disk(),
                    ));
                    if self.fill {
                        thumbnails.update(cx, |thumbnails, cx| thumbnails.want(&media, &[], cx));
                        self.phase = Phase::Filling;
                    } else {
                        self.rest_then(window, cx, Self::after_rest);
                    }
                }
            }
            Phase::Filling => {
                let thumbnails = gallery.read(cx).thumbnails().read(cx);
                let line = thumbnails.is_idle().then(|| {
                    let stats = thumbnails.stats();
                    let span = stats.span().unwrap_or_default().as_secs_f64();
                    let made = stats.generated() + stats.from_disk();
                    format!(
                        r#""event":"fill","generated":{},"from_disk":{},"unavailable":{},"span_s":{span:.2},"per_second":{:.1},"mean_generate_ms":{:.1},"workers":{}"#,
                        stats.generated(),
                        stats.from_disk(),
                        stats.unavailable(),
                        made as f64 / span.max(1e-9),
                        stats.generating().as_secs_f64() * 1e3 / stats.generated().max(1) as f64,
                        thumbnails.concurrency(),
                    )
                });
                if let Some(line) = line {
                    self.write(&line);
                    self.rest_then(window, cx, Self::after_rest);
                }
            }
            Phase::Scrolling => {
                let speed = self.scroll.unwrap_or_default();
                let line = gallery
                    .read(cx)
                    .autoscroll_frames()
                    .map(|frames| frame_stats(frames, speed));
                if let Some(line) = line {
                    let active = window.is_window_active();
                    self.write(&format!(r#"{line},"window_active_at_end":{active}"#));
                    self.rest_then(window, cx, |spike, view, window, cx| {
                        spike.write_memory("after-scroll");
                        spike.start_steps(view, window, cx);
                    });
                }
            }
            Phase::Waiting | Phase::Done => {}
        }
        // View draws before the gallery in a frame, so it reads what the gallery drew in the
        // frame before: one more frame is asked for, and `first-thumbnails` is at most one
        // frame late. Filling needs none: each finished thumbnail draws a frame.
        if matches!(self.phase, Phase::Listing | Phase::FirstFrame) {
            window.request_animation_frame();
        }
    }

    fn after_rest(&mut self, view: &mut ViewMode, window: &mut Window, cx: &mut Context<ViewMode>) {
        self.write_memory("rest");
        match self.scroll {
            Some(speed) => {
                // GPUI stops drawing a window that is covered, so the measured window comes to
                // the front first: other apps' windows had covered it during the rest.
                window.activate_window();
                view.gallery()
                    .update(cx, |gallery, cx| gallery.start_autoscroll(speed, cx));
                self.write(&format!(r#""event":"scroll-start","px_per_s":{speed}"#));
                self.phase = Phase::Scrolling;
            }
            None => self.start_steps(view, window, cx),
        }
    }

    fn write_memory(&mut self, event: &str) {
        let (resident, footprint) = memory();
        self.write(&format!(
            r#""event":"{event}","resident_mb":{:.1},"footprint_mb":{:.1}"#,
            resident as f64 / 1e6,
            footprint as f64 / 1e6,
        ));
    }

    /// Waits `self.rest` without holding frames, then calls `next`.
    fn rest_then(
        &mut self,
        window: &mut Window,
        cx: &mut Context<ViewMode>,
        next: fn(&mut Spike, &mut ViewMode, &mut Window, &mut Context<ViewMode>),
    ) {
        self.phase = Phase::Waiting;
        let rest = self.rest;
        cx.spawn_in(window, async move |this, cx| {
            cx.background_executor().timer(rest).await;
            with_spike(&this, cx, next);
        })
        .detach();
    }

    fn start_steps(
        &mut self,
        view: &mut ViewMode,
        window: &mut Window,
        cx: &mut Context<ViewMode>,
    ) {
        if self.workflows {
            self.start_workflows(window, cx);
            return;
        }
        if self.steps == 0 {
            self.finish(cx);
            return;
        }
        self.phase = Phase::Waiting;
        let entries = view.gallery().read(cx).media().clone();
        let steps = self.steps;
        cx.spawn_in(window, async move |this, cx| {
            for (format, extensions) in [("avif", &["avif"][..]), ("jpeg", &["jpg", "jpeg"][..])] {
                let stills: Arc<[MediaEntry]> = entries
                    .iter()
                    .filter(|entry| {
                        entry.kind() == MediaKind::Image
                            && entry.path().extension().is_some_and(|extension| {
                                let extension = extension.to_string_lossy().to_ascii_lowercase();
                                extensions.contains(&extension.as_str())
                            })
                    })
                    .cloned()
                    .collect();
                if stills.len() < 2 {
                    continue;
                }
                for (pace, gap) in [("steady", 500), ("rapid", 100)] {
                    let stills = stills.clone();
                    let opened = this.update_in(cx, |view, window, cx| {
                        window.activate_window();
                        view.open_viewer_with(stills, 0, window, cx);
                    });
                    if opened.is_err() {
                        return;
                    }
                    cx.background_executor()
                        .timer(Duration::from_millis(800))
                        .await;
                    for _ in 0..steps {
                        let stepped = this.update_in(cx, |view, window, cx| {
                            if let Some(viewer) = view.viewer().cloned() {
                                viewer.update(cx, |viewer, cx| viewer.step(1, window, cx));
                            }
                        });
                        if stepped.is_err() {
                            return;
                        }
                        cx.background_executor()
                            .timer(Duration::from_millis(gap))
                            .await;
                    }
                    cx.background_executor()
                        .timer(Duration::from_millis(500))
                        .await;
                    let written = this.update_in(cx, |view, window, cx| {
                        let times: Vec<Duration> = view
                            .viewer()
                            .map(|viewer| viewer.read(cx).step_times().to_vec())
                            .unwrap_or_default();
                        let size = view.viewer().map(|viewer| viewer.read(cx).decode_size());
                        let line = step_stats(format, pace, &times, steps, size.unwrap_or(0));
                        if let Some(spike) = view.spike.as_mut() {
                            spike.write(&line);
                        }
                        view.close_viewer_now(window, cx);
                    });
                    if written.is_err() {
                        return;
                    }
                }
            }
            this.update(cx, |view, cx| {
                if let Some(mut spike) = view.spike.take() {
                    spike.finish(cx);
                    view.spike = Some(spike);
                }
            })
            .ok();
        })
        .detach();
    }

    /// View's other workflows on the listing, one at a time, each written with the time its
    /// action took on the main thread: the orders, Shuffle, Refresh (whose scan then runs in the
    /// background), and comic mode on and off.
    fn start_workflows(&mut self, window: &mut Window, cx: &mut Context<ViewMode>) {
        type Action = fn(&mut ViewMode, &mut Context<ViewMode>);
        const ACTIONS: [(&str, Action); 9] = [
            ("sort-name-desc", |view, cx| {
                view.set_sort_mode(GallerySortMode::NameDesc, cx)
            }),
            ("sort-date-newest", |view, cx| {
                view.set_sort_mode(GallerySortMode::DateNewest, cx)
            }),
            ("sort-date-oldest", |view, cx| {
                view.set_sort_mode(GallerySortMode::DateOldest, cx)
            }),
            ("sort-random", |view, cx| {
                view.set_sort_mode(GallerySortMode::Random, cx)
            }),
            ("shuffle", |view, cx| view.shuffle(cx)),
            ("sort-name-asc", |view, cx| {
                view.set_sort_mode(GallerySortMode::NameAsc, cx)
            }),
            ("refresh", |view, cx| view.refresh(cx)),
            ("comic-on", |view, cx| view.set_comic_mode(true, cx)),
            ("comic-off", |view, cx| view.set_comic_mode(false, cx)),
        ];
        self.phase = Phase::Waiting;
        cx.spawn_in(window, async move |this, cx| {
            for (name, action) in ACTIONS {
                let done = this.update(cx, |view, cx| {
                    let started = Instant::now();
                    action(view, cx);
                    let took = started.elapsed().as_secs_f64() * 1e3;
                    if let Some(spike) = view.spike.as_mut() {
                        spike.write(&format!(
                            r#""event":"workflow","name":"{name}","main_ms":{took:.2}"#
                        ));
                    }
                });
                if done.is_err() {
                    return;
                }
                // Long enough for a scan the action started to list, and for a frame to draw.
                cx.background_executor()
                    .timer(Duration::from_millis(700))
                    .await;
            }
            this.update(cx, |view, cx| {
                if let Some(mut spike) = view.spike.take() {
                    spike.finish(cx);
                    view.spike = Some(spike);
                }
            })
            .ok();
        })
        .detach();
    }

    fn finish(&mut self, cx: &mut Context<ViewMode>) {
        self.phase = Phase::Done;
        self.write_memory("done");
        if self.quit {
            cx.quit();
        }
    }
}

/// Runs `next` on the view's spike, taken out of the view for the call.
fn with_spike(
    this: &WeakEntity<ViewMode>,
    cx: &mut AsyncWindowContext,
    next: fn(&mut Spike, &mut ViewMode, &mut Window, &mut Context<ViewMode>),
) {
    this.update_in(cx, |view, window, cx| {
        if let Some(mut spike) = view.spike.take() {
            next(&mut spike, view, window, cx);
            view.spike = Some(spike);
            cx.notify();
        }
    })
    .ok();
}

fn percentile(sorted: &[f64], fraction: f64) -> f64 {
    if sorted.is_empty() {
        return 0.;
    }
    let rank = ((sorted.len() - 1) as f64 * fraction).round() as usize;
    sorted[rank]
}

/// The intervals between consecutive frames of a scroll, in milliseconds.
fn frame_stats(frames: &[Instant], speed: f32) -> String {
    let mut intervals: Vec<f64> = frames
        .windows(2)
        .map(|pair| pair[1].duration_since(pair[0]).as_secs_f64() * 1e3)
        .collect();
    let duration = match (frames.first(), frames.last()) {
        (Some(first), Some(last)) => last.duration_since(*first).as_secs_f64(),
        _ => 0.,
    };
    intervals.sort_by(f64::total_cmp);
    let p50 = percentile(&intervals, 0.5);
    // A frame that took more than one and a half times the typical interval missed its vsync.
    let long = intervals
        .iter()
        .filter(|interval| **interval > p50 * 1.5)
        .count();
    format!(
        r#""event":"scroll","px_per_s":{speed},"frames":{},"duration_s":{duration:.2},"p50_ms":{p50:.2},"p95_ms":{:.2},"p99_ms":{:.2},"max_ms":{:.2},"long_frames":{long}"#,
        frames.len(),
        percentile(&intervals, 0.95),
        percentile(&intervals, 0.99),
        intervals.last().copied().unwrap_or_default(),
    )
}

fn step_stats(format: &str, pace: &str, times: &[Duration], steps: usize, size: u32) -> String {
    let mut millis: Vec<f64> = times.iter().map(|time| time.as_secs_f64() * 1e3).collect();
    millis.sort_by(f64::total_cmp);
    format!(
        r#""event":"steps","format":"{format}","pace":"{pace}","asked":{steps},"drawn":{},"decode_px":{size},"p50_ms":{:.2},"p95_ms":{:.2},"max_ms":{:.2}"#,
        millis.len(),
        percentile(&millis, 0.5),
        percentile(&millis, 0.95),
        millis.last().copied().unwrap_or_default(),
    )
}

/// This process's resident size and its physical footprint (what Activity Monitor shows), in
/// bytes.
#[cfg(target_os = "macos")]
fn memory() -> (u64, u64) {
    match rusage() {
        Some(usage) => (usage.ri_resident_size, usage.ri_phys_footprint),
        None => (0, 0),
    }
}

#[cfg(not(target_os = "macos"))]
fn memory() -> (u64, u64) {
    (0, 0)
}

#[cfg(target_os = "macos")]
fn rusage() -> Option<libc::rusage_info_v2> {
    let mut usage = std::mem::MaybeUninit::<libc::rusage_info_v2>::zeroed();
    // SAFETY: `usage` is a `rusage_info_v2`, the flavour asked for.
    let status = unsafe {
        libc::proc_pid_rusage(
            libc::getpid(),
            libc::RUSAGE_INFO_V2,
            usage.as_mut_ptr().cast(),
        )
    };
    // SAFETY: zeroed is a valid `rusage_info_v2`, and the call filled it on success.
    (status == 0).then(|| unsafe { usage.assume_init() })
}

/// Milliseconds since the kernel started this process. The start is in Mach ticks, and `libc`
/// marks its Mach clock bindings deprecated in favour of the `mach2` crate, which is not worth a
/// dependency for one reading.
#[cfg(target_os = "macos")]
#[expect(deprecated, reason = "libc's Mach clock is enough for one reading")]
fn since_launch_ms() -> f64 {
    let Some(usage) = rusage() else {
        return 0.;
    };
    let mut timebase = libc::mach_timebase_info { numer: 0, denom: 0 };
    // SAFETY: plain out-parameter and clock reads.
    let now = unsafe {
        libc::mach_timebase_info(&mut timebase);
        libc::mach_absolute_time()
    };
    if timebase.denom == 0 {
        return 0.;
    }
    let ticks = now.saturating_sub(usage.ri_proc_start_abstime) as f64;
    ticks * f64::from(timebase.numer) / f64::from(timebase.denom) / 1e6
}

#[cfg(not(target_os = "macos"))]
fn since_launch_ms() -> f64 {
    0.
}
