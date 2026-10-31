//! The pages spike: Tidy's pages on a real catalog, timed in a real window, run by environment
//! variables as the Library's spike is ([`crate::spike`]), because this Mac allows no scripted
//! input.
//!
//! `ORIEL_RS_SPIKE_TIDY=<file>` waits until Tidy shows a root with its Overview read, then does
//! what the owner's clicks and keys would, one step at a time, and writes one JSON line per step
//! before it quits:
//!
//! - `page`: each page shown twice, first as the launch left it and then again, from the switch
//!   to the first frame that draws everything the page asked for, its pictures included;
//! - `sort`, `type`, `filter`, `inspector`, `mode`: the Library's headers, search, filter,
//!   Inspector and grid, each until the frame that shows the answer;
//! - `scroll`: the Library's list and grid, top to bottom, every frame's interval;
//! - `set`, `loupe`, `play`: Duplicates' next set, its loupe and a video in a tile;
//! - `grid`: the version grid of the first set, top to bottom, every frame's interval;
//! - `rescan`: Rescan, until Overview shows the result;
//! - `watch`: a page drawn again every frame for a while, every frame's interval;
//! - `memory`: this process's memory and the pictures Tidy holds, once the work before rested.
//!
//! A step is done at the first of two frames in a row that find nothing it asked for on its
//! way (a frame can still ask for more as it draws). Every step also says how long its longest
//! frame took, which is how long the main thread was busy with it, and the CPU time it took on
//! the main thread and in all; a scroll or a watch says the main thread's CPU time per frame,
//! which is what one frame costs even when the display's own interval hides it. The frames are drawn all the
//! time the spike runs, as the Library's spike does. `ORIEL_RS_SPIKE_TIDY_ONLY` picks groups of
//! steps, and `ORIEL_RS_SPIKE_TIDY_HOLD` keeps the app open at the end, to be looked at.

use std::collections::VecDeque;
use std::fs::{File, OpenOptions};
use std::io::Write as _;
use std::time::{Duration, Instant};

use gpui_kit::{App, Context, Window, point, px};
use oriel_core_tidy::contract::{FileFormat, FileKind};

use crate::TidyMode;
use crate::library::{Filters, LibraryMode};
use crate::loaded::reads_in_flight;
use crate::pages::TidyPage;
use crate::spike::{frame_stats, memory, process_cpu_ms, thread_cpu_ms};

/// The file the spike writes its lines to; the spike runs when it is set.
pub const LOG_VARIABLE: &str = "ORIEL_RS_SPIKE_TIDY";
/// The groups of steps to run, comma-separated: `pages`, `rescan`, `redraw`, `library`,
/// `grid`, `duplicates`.
pub const ONLY_VARIABLE: &str = "ORIEL_RS_SPIKE_TIDY_ONLY";
/// Set, the app stays open once the spike is done, to be looked at from outside.
pub const HOLD_VARIABLE: &str = "ORIEL_RS_SPIKE_TIDY_HOLD";
/// How long the spike lets Tidy rest once it shows a root, before the first step.
const SETTLE: Duration = Duration::from_millis(2_000);
/// How long a step may take before the spike writes it down as timed out.
const TIMEOUT: Duration = Duration::from_secs(30);
/// The rest between steps, still drawing, so one step's late work never lands in the next.
const GAP: Duration = Duration::from_millis(500);
/// How long the spike draws before it reads memory, so what the work before freed has gone.
const MEMORY_REST: Duration = Duration::from_secs(3);
/// The time between two letters typed into the search.
const KEY_INTERVAL: Duration = Duration::from_millis(120);
/// What the search is typed with: a word and a digit, as the fixture names its files.
const SEARCH: &str = "photo 5";
/// The versions a set of duplicates shows before its grid is scrolled.
const SHOWN_TILES: usize = 8;

#[derive(Clone, Debug)]
enum Action {
    Go(TidyPage),
    /// A click on the Library's header with this key.
    Sort(&'static str),
    /// The list or grid on screen, top to bottom at this many pixels a second.
    Scroll(f32),
    /// Duplicates' version grid, top to bottom at this many pixels a second.
    GridScroll(f32),
    /// Waits until every picture asked for is in.
    Settle,
    Type(&'static str),
    ClearSearch,
    Filter(Filters),
    Inspector(bool),
    Mode(LibraryMode),
    NextSet,
    PrevSet,
    Loupe(bool),
    Play,
    /// Scans the root again, as Rescan does, and waits for Overview to show the result.
    Rescan,
    /// Draws for this long and writes the frames' intervals, as while a video plays.
    Watch(Duration),
    /// Reads memory once the work before has rested.
    Memory,
}

impl Action {
    fn event(&self) -> &'static str {
        match self {
            Action::Go(_) => "page",
            Action::Sort(_) => "sort",
            Action::Scroll(_) => "scroll",
            Action::GridScroll(_) => "grid",
            Action::Settle => "settle",
            Action::Type(_) | Action::ClearSearch => "type",
            Action::Filter(_) => "filter",
            Action::Inspector(_) => "inspector",
            Action::Mode(_) => "mode",
            Action::NextSet | Action::PrevSet => "set",
            Action::Loupe(_) => "loupe",
            Action::Play => "play",
            Action::Rescan => "rescan",
            Action::Watch(_) => "watch",
            Action::Memory => "memory",
        }
    }
}

/// Something that has to hold on two frames in a row to count.
#[derive(Default)]
struct Steady {
    since: Option<Instant>,
    confirmed: Option<Instant>,
}

impl Steady {
    /// Sees whether it holds at this frame; once it has held on two in a row, the first of them.
    fn see(&mut self, holds: bool, now: Instant) -> Option<Instant> {
        if self.confirmed.is_none() {
            match (holds, self.since) {
                (true, Some(since)) => self.confirmed = Some(since),
                (true, None) => self.since = Some(now),
                (false, _) => self.since = None,
            }
        }
        self.confirmed
    }
}

struct Running {
    label: String,
    action: Action,
    /// When the step was taken; `None` until the deferred step has run.
    asked: Option<Instant>,
    frames: Vec<Instant>,
    /// The main thread's and the process's CPU time when the step was taken, and at each frame.
    cpu_asked: (f64, f64),
    cpu: Vec<(f64, f64)>,
    typed: usize,
    next_key: Instant,
    last_key: Option<Instant>,
    /// The first of two frames in a row with no page read on its way.
    read: Steady,
    /// The first of two frames in a row with everything the step asked for drawn.
    settled: Steady,
    /// The first frame that showed the first versions of a set of duplicates.
    shown_at: Option<Instant>,
    decoded_before: (u64, u64, Duration),
    /// When the step was written down; the spike rests until [`GAP`] after it.
    finished: Option<Instant>,
}

/// The pages spike's run: what is left to do, and the step on its way.
pub struct PageSpike {
    log: Option<File>,
    steps: VecDeque<(String, Action)>,
    running: Option<Running>,
    ready_since: Option<Instant>,
    started: bool,
    done: bool,
}

impl PageSpike {
    pub fn from_environment() -> Option<Self> {
        let path = std::env::var(LOG_VARIABLE)
            .ok()
            .filter(|path| !path.is_empty())?;
        let log = OpenOptions::new().create(true).append(true).open(path).ok();
        Some(Self {
            log,
            steps: schedule(std::env::var(ONLY_VARIABLE).ok().as_deref()),
            running: None,
            ready_since: None,
            started: false,
            done: false,
        })
    }

    /// Called from every frame Tidy draws; moves the run on.
    pub fn on_frame(
        &mut self,
        mode: &mut TidyMode,
        window: &mut Window,
        cx: &mut Context<TidyMode>,
    ) {
        let now = Instant::now();
        if self.done {
            return;
        }
        if !self.started {
            let state = mode.state.read(cx);
            let ready = state.is_ready()
                && state.root().is_some()
                && state.overview().is_some()
                && settled(mode, cx);
            match (ready, self.ready_since) {
                (true, None) => self.ready_since = Some(now),
                (true, Some(since)) if now.duration_since(since) >= SETTLE => {
                    self.started = true;
                    self.write_memory("start", mode, cx);
                }
                (false, _) => self.ready_since = None,
                _ => {}
            }
        } else if let Some(running) = self.running.as_mut() {
            if let Some(finished) = running.finished {
                if now.duration_since(finished) >= GAP {
                    self.running = None;
                }
            } else if let Some(asked) = running.asked {
                running.frames.push(now);
                running.cpu.push((thread_cpu_ms(), process_cpu_ms()));
                if let Some(line) = advance(running, asked, now, mode, window, cx) {
                    running.finished = Some(now);
                    self.write(&line);
                }
            }
        } else if let Some((label, action)) = self.steps.pop_front() {
            let decoded_before = mode.thumbs.read(cx).decoded();
            self.running = Some(Running {
                label,
                action: action.clone(),
                asked: None,
                frames: Vec::new(),
                cpu_asked: (0., 0.),
                cpu: Vec::new(),
                typed: 0,
                next_key: now,
                last_key: None,
                read: Steady::default(),
                settled: Steady::default(),
                shown_at: None,
                decoded_before,
                finished: None,
            });
            // The step runs as an event would, outside the frame, and its effects land
            // before the next one.
            cx.defer_in(window, move |mode, window, cx| {
                let asked = Instant::now();
                let cpu_asked = (thread_cpu_ms(), process_cpu_ms());
                perform(&action, mode, window, cx);
                if let Some(spike) = mode.page_spike.as_mut()
                    && let Some(running) = spike.running.as_mut()
                {
                    running.asked = Some(asked);
                    running.cpu_asked = cpu_asked;
                }
            });
        } else {
            self.write(r#""event":"done""#);
            self.done = true;
            if std::env::var_os(HOLD_VARIABLE).is_none() {
                cx.quit();
            }
            return;
        }
        cx.notify();
        window.request_animation_frame();
    }

    fn write_memory(&mut self, label: &str, mode: &TidyMode, cx: &App) {
        let line = memory_line(label, mode, cx);
        self.write(&line);
    }

    fn write(&mut self, fields: &str) {
        if let Some(log) = self.log.as_mut() {
            let _ = writeln!(log, "{{{fields}}}");
        }
    }
}

/// What the spike does, in order: the groups `ORIEL_RS_SPIKE_TIDY_ONLY` names (a comma-separated
/// list), or all of them.
fn schedule(only: Option<&str>) -> VecDeque<(String, Action)> {
    let wanted = |group: &str| only.is_none_or(|only| only.split(',').any(|name| name == group));
    let mut steps = VecDeque::new();
    let mut push = |label: &str, action: Action| steps.push_back((label.to_owned(), action));
    if wanted("pages") {
        let pages = [
            TidyPage::Duplicates,
            TidyPage::Convert,
            TidyPage::CleanUp,
            TidyPage::Shrink,
            TidyPage::Library,
            TidyPage::History,
            TidyPage::Holding,
            TidyPage::Overview,
        ];
        for round in ["first", "again"] {
            for page in pages {
                push(&format!("{}-{round}", page.key()), Action::Go(page));
            }
        }
    }
    if wanted("rescan") {
        push("overview", Action::Go(TidyPage::Overview));
        push("overview", Action::Rescan);
    }
    if wanted("redraw") {
        // Each page drawn again every frame for a while: how long one frame of it takes.
        for page in [
            TidyPage::Overview,
            TidyPage::Duplicates,
            TidyPage::Library,
            TidyPage::History,
            TidyPage::Holding,
        ] {
            push(page.key(), Action::Go(page));
            push(page.key(), Action::Watch(Duration::from_secs(2)));
        }
    }
    if wanted("library") {
        push("library", Action::Go(TidyPage::Library));
        push("list", Action::Mode(LibraryMode::List));
        for (label, key) in [
            ("name-asc", "name"),
            ("name-desc", "name"),
            ("size-desc", "size"),
            ("modified-desc", "modified"),
            ("format-asc", "format"),
            ("name-asc-again", "name"),
        ] {
            push(label, Action::Sort(key));
        }
        push("list", Action::Scroll(20_000.));
        push("search", Action::Type(SEARCH));
        push("clear", Action::ClearSearch);
        let videos = Filters {
            kinds: vec![FileKind::Video],
            ..Filters::default()
        };
        let jpegs = Filters {
            formats: vec![FileFormat::Jpeg],
            ..Filters::default()
        };
        push("videos", Action::Filter(videos));
        push("jpegs", Action::Filter(jpegs));
        push("none", Action::Filter(Filters::default()));
        push("open", Action::Inspector(true));
        push("close", Action::Inspector(false));
    }
    if wanted("grid") {
        push("library", Action::Go(TidyPage::Library));
        push("before-grid", Action::Memory);
        push("grid", Action::Mode(LibraryMode::Grid));
        push("grid", Action::Scroll(5_000.));
        push("after-grid-scroll", Action::Memory);
        push("list-again", Action::Mode(LibraryMode::List));
    }
    if wanted("duplicates") {
        push("duplicates", Action::Go(TidyPage::Duplicates));
        push("versions", Action::GridScroll(3_000.));
        push("versions", Action::Settle);
        for index in 1..=10 {
            push(&format!("next-{index}"), Action::NextSet);
        }
        push("open", Action::Loupe(true));
        push("close", Action::Loupe(false));
        for index in (1..=9).rev() {
            push(&format!("back-{index}"), Action::PrevSet);
        }
        push("after-duplicates", Action::Memory);
        push("video", Action::Play);
        push("video", Action::Watch(Duration::from_secs(3)));
    }
    push("end", Action::Memory);
    steps
}

fn perform(action: &Action, mode: &mut TidyMode, window: &mut Window, cx: &mut Context<TidyMode>) {
    let library = mode.library.clone();
    let duplicates = mode.duplicates.clone();
    match action {
        Action::Go(page) => mode.go(*page, cx),
        Action::Sort(key) => {
            library.update(cx, |library, cx| library.spike_sort(key, window, cx));
        }
        Action::Scroll(_) => {
            let handle = library.read(cx).spike_scroll_handle(cx);
            handle.set_offset(point(px(0.), px(0.)));
        }
        Action::GridScroll(_) => {
            if let Some(handle) = duplicates.read(cx).spike_grid_scroll_handle() {
                handle.set_offset(point(px(0.), px(0.)));
            }
        }
        Action::Type(_) | Action::Watch(_) | Action::Memory | Action::Settle => {}
        Action::ClearSearch => {
            library.update(cx, |library, cx| library.spike_clear_search(window, cx));
        }
        Action::Filter(filters) => {
            let filters = filters.clone();
            library.update(cx, |library, cx| library.spike_filters(filters, cx));
        }
        Action::Inspector(open) => {
            library.update(cx, |library, cx| library.spike_inspector(*open, cx));
        }
        Action::Mode(next) => library.update(cx, |library, cx| library.set_mode(*next, cx)),
        Action::NextSet => duplicates.update(cx, |page, cx| page.spike_move(1, cx)),
        Action::PrevSet => duplicates.update(cx, |page, cx| page.spike_move(-1, cx)),
        Action::Loupe(open) => duplicates.update(cx, |page, cx| page.spike_loupe(*open, cx)),
        Action::Play => {
            duplicates.update(cx, |page, cx| page.spike_play_video(window, cx));
        }
        Action::Rescan => mode.state.update(cx, |state, cx| {
            if let Some(root_id) = state.root_id() {
                state.start_scan(root_id, window, cx);
            }
        }),
    }
}

/// Whether nothing Tidy asked for is still on its way: no page read, no picture.
fn settled(mode: &TidyMode, cx: &App) -> bool {
    reads_in_flight() == 0 && mode.thumbs.read(cx).is_idle()
}

/// This process's memory and the pictures Tidy holds, as a JSON line's fields.
fn memory_line(label: &str, mode: &TidyMode, cx: &App) -> String {
    let (resident, footprint) = memory();
    let thumbs = mode.thumbs.read(cx);
    let (held, bytes) = thumbs.held();
    format!(
        r#""event":"memory","label":"{label}","resident_mb":{:.1},"footprint_mb":{:.1},"pictures":{held},"picture_mb":{:.1},"decoded":{}"#,
        resident as f64 / 1e6,
        footprint as f64 / 1e6,
        bytes as f64 / 1e6,
        thumbs.decoded().0,
    )
}

/// Moves a running step on by one frame; its line once it is done.
fn advance(
    running: &mut Running,
    asked: Instant,
    now: Instant,
    mode: &mut TidyMode,
    window: &mut Window,
    cx: &mut Context<TidyMode>,
) -> Option<String> {
    let elapsed = now.duration_since(asked);
    running.read.see(reads_in_flight() == 0, now);
    if running.shown_at.is_none()
        && matches!(
            running.action,
            Action::Go(TidyPage::Duplicates) | Action::NextSet | Action::PrevSet
        )
        && mode.duplicates.read(cx).spike_tiles_shown(SHOWN_TILES, cx)
    {
        running.shown_at = Some(now);
    }
    let timed_out = elapsed >= TIMEOUT;
    let done = match &running.action {
        Action::Scroll(speed) | Action::GridScroll(speed) => {
            let handle = match running.action {
                Action::Scroll(_) => Some(mode.library.read(cx).spike_scroll_handle(cx)),
                _ => mode.duplicates.read(cx).spike_grid_scroll_handle(),
            };
            let max = handle
                .as_ref()
                .map_or(0., |handle| f32::from(handle.max_offset().y));
            let target = speed * elapsed.as_secs_f32();
            if let Some(handle) = &handle {
                handle.set_offset(point(px(0.), px(-target.min(max))));
            }
            if handle.is_none() || (max > 0. && target >= max) || timed_out {
                let mut line = frame_stats(&running.frames, *speed);
                if let Action::GridScroll(_) = running.action {
                    line = line.replacen(r#""event":"scroll""#, r#""event":"grid""#, 1);
                }
                line.insert_str(0, &format!(r#""label":"{}","#, running.label));
                let decoded = decodes_since(running.decoded_before, mode, cx);
                let per_frame = main_cpu_per_frame(running);
                line.push_str(&format!(
                    r#",{decoded},"max_offset_px":{max:.0},"main_cpu_ms_per_frame":{per_frame:.2}"#
                ));
                return Some(line);
            }
            false
        }
        Action::Memory => {
            // Read once the work before has rested, as the owner would find it a moment later.
            if elapsed >= MEMORY_REST {
                return Some(memory_line(&running.label, mode, cx));
            }
            false
        }
        Action::Watch(length) => {
            if elapsed >= *length {
                let mut line = frame_stats(&running.frames, 0.);
                line.insert_str(0, &format!(r#""label":"{}","#, running.label));
                let per_frame = main_cpu_per_frame(running);
                line.push_str(&format!(r#","main_cpu_ms_per_frame":{per_frame:.2}"#));
                return Some(line.replacen(r#""event":"scroll""#, r#""event":"watch""#, 1));
            }
            false
        }
        Action::Type(text) => {
            if running.typed < text.len() {
                if now >= running.next_key {
                    let letter = &text[running.typed..running.typed + 1];
                    running.typed += 1;
                    running.next_key = now + KEY_INTERVAL;
                    running.last_key = Some(now);
                    let library = mode.library.clone();
                    let letter = letter.to_owned();
                    cx.defer_in(window, move |_, window, cx| {
                        library.update(cx, |library, cx| library.spike_type(&letter, window, cx));
                    });
                }
                false
            } else {
                mode.library.read(cx).search() == *text && settled(mode, cx)
            }
        }
        Action::ClearSearch => mode.library.read(cx).search().is_empty() && settled(mode, cx),
        Action::Inspector(true) => mode.library.read(cx).spike_targets_read() && settled(mode, cx),
        Action::Play => mode.duplicates.read(cx).spike_video_shows(cx),
        Action::Go(page) => mode.state.read(cx).page() == *page && settled(mode, cx),
        Action::Rescan => !mode.state.read(cx).is_busy() && settled(mode, cx),
        _ => settled(mode, cx),
    };
    // A frame that finds everything in may still ask for more as it draws (a page whose rows
    // just came in asks for their pictures), so the next frame has to find it so too.
    let settled_at = running
        .settled
        .see(done, now)
        .or(timed_out.then_some(now))?;
    let elapsed = settled_at.duration_since(asked);
    let mut intervals: Vec<f64> = std::iter::once(asked)
        .chain(running.frames.iter().copied())
        .collect::<Vec<_>>()
        .windows(2)
        .map(|pair| pair[1].duration_since(pair[0]).as_secs_f64() * 1e3)
        .collect();
    intervals.sort_by(f64::total_cmp);
    let first_frame = running
        .frames
        .first()
        .map_or(0., |first| first.duration_since(asked).as_secs_f64() * 1e3);
    let decoded = decodes_since(running.decoded_before, mode, cx);
    let after_last_key = running.last_key.map_or(String::new(), |last| {
        format!(
            r#","after_last_key_ms":{:.1}"#,
            settled_at.duration_since(last).as_secs_f64() * 1e3
        )
    });
    let read = running
        .read
        .confirmed
        .map_or(elapsed, |at| at.duration_since(asked));
    let versions = mode.duplicates.read(cx).rows().len();
    // The CPU time to the frame the step settled at.
    let (main_cpu, cpu) = running
        .frames
        .iter()
        .position(|frame| *frame == settled_at)
        .and_then(|at| running.cpu.get(at))
        .or(running.cpu.last())
        .map_or((0., 0.), |(main, all)| {
            (main - running.cpu_asked.0, all - running.cpu_asked.1)
        });
    let shown = running.shown_at.map_or(String::new(), |at| {
        format!(
            r#","shown_ms":{:.1}"#,
            at.duration_since(asked).as_secs_f64() * 1e3
        )
    });
    Some(format!(
        r#""event":"{}","label":"{}","settled_ms":{:.1},"read_ms":{:.1},"first_frame_ms":{first_frame:.1},"max_frame_ms":{:.1},"frames":{},"main_cpu_ms":{main_cpu:.1},"cpu_ms":{cpu:.1},{decoded},"versions":{versions},"timed_out":{timed_out}{after_last_key}{shown}"#,
        running.action.event(),
        running.label,
        elapsed.as_secs_f64() * 1e3,
        read.as_secs_f64() * 1e3,
        intervals.last().copied().unwrap_or_default(),
        running.frames.len(),
    ))
}

/// The main thread's CPU time per frame since the step was taken.
fn main_cpu_per_frame(running: &Running) -> f64 {
    match running.cpu.last() {
        Some((main, _)) if !running.frames.is_empty() => {
            (main - running.cpu_asked.0) / running.frames.len() as f64
        }
        _ => 0.,
    }
}

/// The decodes since `before`, as JSON fields: how many, the videos' frames among them, and the
/// time they took, summed over the decoding threads.
fn decodes_since(before: (u64, u64, Duration), mode: &TidyMode, cx: &App) -> String {
    let (decoded, videos, time) = mode.thumbs.read(cx).decoded();
    format!(
        r#""decoded":{},"video_frames":{},"decode_ms":{:.0}"#,
        decoded - before.0,
        videos - before.1,
        (time - before.2).as_secs_f64() * 1e3
    )
}
