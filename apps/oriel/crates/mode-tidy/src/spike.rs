//! The measurement of the Library table (plan 063: "GPUI Kit's data table with 100,000 rows: sort,
//! scroll and select"), set up by the launch's variables, as View's spike is.
//!
//! `ORIEL_SPIKE_LIBRARY=<rows>` opens Tidy on Library with that many synthetic rows. With
//! `ORIEL_SPIKE_LOG=<file>` the run then writes one JSON line per event and quits:
//!
//! 1. `rows`: the rows made, and memory.
//! 2. `sort`: each column ascending then descending, the sort alone and the sort until the frame
//!    that shows it.
//! 3. `scroll`: top to bottom at `ORIEL_SPIKE_SCROLL` px/s (5,000 by default), every frame's
//!    interval, then memory.
//! 4. `select`: `ORIEL_SPIKE_SELECT` (200 by default) rows selected one after another, each
//!    until the frame that shows it.

use std::time::{Duration, Instant};

use gpui_kit::component::table::ColumnSort;
use gpui_kit::{Context, Window, point, px};
use oriel_launch::{Variables, variables};
use oriel_ui::measure::{SpikeLog, frame_stats, memory_fields, percentile};

use crate::synthetic::{LibraryColumn, SyntheticLibrary as LibraryPage};

const SPIKE_SELECT: &str = "ORIEL_SPIKE_SELECT";

const SETTLE: Duration = Duration::from_millis(1_500);

/// The rows the spike asks for, if it runs.
pub fn requested_rows(spikes: &Variables) -> Option<usize> {
    spikes.parse(variables::SPIKE_LIBRARY)
}

enum Step {
    /// Waiting for the table to draw and settle before anything is timed.
    Settling(Instant),
    /// A sort was asked for at this instant; the next frame shows it.
    Sorted {
        column: usize,
        sort: ColumnSort,
        asked: Instant,
        rows_only: Duration,
    },
    Scrolling {
        started: Option<Instant>,
        frames: Vec<Instant>,
    },
    Selecting {
        next: usize,
        asked: Option<Instant>,
        times: Vec<Duration>,
    },
    Done,
}

pub struct LibrarySpike {
    log: Option<SpikeLog>,
    speed: f32,
    selections: usize,
    step: Step,
}

impl LibrarySpike {
    pub fn start(spikes: &Variables, rows_made_in: Duration) -> Option<Self> {
        let path = spikes.get(variables::SPIKE_LOG)?;
        let log = SpikeLog::open(path);
        let mut spike = Self {
            log,
            speed: spikes.parse(variables::SPIKE_SCROLL).unwrap_or(5_000.),
            selections: spikes.parse(SPIKE_SELECT).unwrap_or(200),
            step: Step::Settling(Instant::now()),
        };
        spike.write(&format!(
            r#""event":"rows","made_ms":{:.1},{}"#,
            rows_made_in.as_secs_f64() * 1e3,
            memory_fields(),
        ));
        Some(spike)
    }

    /// Called from every frame the Library draws; moves the run on.
    pub fn on_frame(
        &mut self,
        page: &mut LibraryPage,
        window: &mut Window,
        cx: &mut Context<LibraryPage>,
    ) {
        let now = Instant::now();
        match &mut self.step {
            Step::Settling(since) => {
                if now.duration_since(*since) >= SETTLE {
                    self.sort(0, ColumnSort::Ascending, page, cx);
                }
            }
            Step::Sorted {
                column,
                sort,
                asked,
                rows_only,
            } => {
                let (column, sort) = (*column, *sort);
                let line = format!(
                    r#""event":"sort","column":"{}","order":"{}","rows_ms":{:.1},"to_frame_ms":{:.1}"#,
                    LibraryColumn::ALL[column].key(),
                    if sort == ColumnSort::Descending {
                        "desc"
                    } else {
                        "asc"
                    },
                    rows_only.as_secs_f64() * 1e3,
                    now.duration_since(*asked).as_secs_f64() * 1e3,
                );
                self.write(&line);
                match (sort, column + 1 < LibraryColumn::ALL.len()) {
                    (ColumnSort::Ascending, _) => {
                        self.sort(column, ColumnSort::Descending, page, cx)
                    }
                    (_, true) => self.sort(column + 1, ColumnSort::Ascending, page, cx),
                    (_, false) => {
                        // Scroll the table as the catalog lists it, by name.
                        self.sort_quietly(0, page, cx);
                        self.step = Step::Scrolling {
                            started: None,
                            frames: Vec::new(),
                        };
                    }
                }
            }
            Step::Scrolling { started, frames } => {
                let started = *started.get_or_insert(now);
                frames.push(now);
                let handle = page
                    .table()
                    .read(cx)
                    .vertical_scroll_handle
                    .0
                    .borrow()
                    .base_handle
                    .clone();
                let max = f32::from(handle.max_offset().y);
                let target = self.speed * now.duration_since(started).as_secs_f32();
                handle.set_offset(point(px(0.), px(-target.min(max))));
                if max > 0. && target >= max {
                    let line = frame_stats(frames, self.speed);
                    self.write(&line);
                    self.write_memory("after-scroll");
                    page.table()
                        .update(cx, |table, cx| table.scroll_to_row(0, cx));
                    self.step = Step::Selecting {
                        next: 0,
                        asked: None,
                        times: Vec::new(),
                    };
                }
            }
            Step::Selecting { next, asked, times } => {
                if let Some(asked) = asked.take() {
                    times.push(now.duration_since(asked));
                }
                if *next < self.selections {
                    let row = *next;
                    *next += 1;
                    *asked = Some(Instant::now());
                    page.table()
                        .update(cx, |table, cx| table.set_selected_row(row, cx));
                } else {
                    let mut millis: Vec<f64> =
                        times.iter().map(|time| time.as_secs_f64() * 1e3).collect();
                    millis.sort_by(f64::total_cmp);
                    let line = format!(
                        r#""event":"select","count":{},"p50_ms":{:.2},"p95_ms":{:.2},"max_ms":{:.2}"#,
                        millis.len(),
                        percentile(&millis, 0.5),
                        percentile(&millis, 0.95),
                        millis.last().copied().unwrap_or_default(),
                    );
                    self.write(&line);
                    self.write(r#""event":"done""#);
                    self.step = Step::Done;
                    cx.quit();
                    return;
                }
            }
            Step::Done => return,
        }
        // The page keeps drawing frames until the run ends.
        cx.notify();
        window.request_animation_frame();
    }

    fn sort(
        &mut self,
        column: usize,
        sort: ColumnSort,
        page: &mut LibraryPage,
        cx: &mut Context<LibraryPage>,
    ) {
        let asked = Instant::now();
        let rows_only = page.table().update(cx, |table, cx| {
            table.delegate_mut().sort(LibraryColumn::ALL[column], sort);
            table.refresh(cx);
            table.delegate().last_sort().unwrap_or_default()
        });
        self.step = Step::Sorted {
            column,
            sort,
            asked,
            rows_only,
        };
    }

    fn sort_quietly(
        &mut self,
        column: usize,
        page: &mut LibraryPage,
        cx: &mut Context<LibraryPage>,
    ) {
        page.table().update(cx, |table, cx| {
            table
                .delegate_mut()
                .sort(LibraryColumn::ALL[column], ColumnSort::Ascending);
            table.refresh(cx);
        });
    }

    fn write_memory(&mut self, event: &str) {
        self.write(&format!(r#""event":"{event}",{}"#, memory_fields()));
    }

    fn write(&mut self, fields: &str) {
        if let Some(log) = self.log.as_mut() {
            log.write(fields);
        }
    }
}
