//! Everything the app is doing, in one place at the window's bottom right, in every mode (the
//! owner's ask after their first install). Each mode publishes its jobs here, running and queued,
//! and the shell draws them once: a compact indicator with the work that runs and how many jobs
//! wait, which opens into a panel listing every job with its progress and, where the job has
//! them, Pause, Resume and Stop. Nothing shows while nothing runs.
//!
//! It is modelled on the panel Sync showed at the bottom right while it planned, and it takes the
//! place of Tidy's job card, the pages' own progress and Sync's running panel. The switcher's ring
//! and dot and the Dock's progress stay, fed by [`crate::ShellState::set_activity`].
//!
//! The jobs live in an entity of their own, so a job's counts moving redraw the indicator without
//! waking every mode that observes the shell's state. A control pressed in the panel reaches the
//! mode as a [`JobCommand`] this entity emits; the mode finds the job by its key.

use std::time::{Duration, Instant};

use gpui_kit::assets::IconName;
use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::progress::Progress;
use gpui_kit::component::spinner::Spinner;
use gpui_kit::component::{ActiveTheme as _, Icon, Sizable as _};
use gpui_kit::{
    AnyElement, App, Context, ElementId, Entity, EventEmitter, FontWeight, InteractiveElement as _,
    IntoElement, ParentElement as _, RenderOnce, Role, SharedString,
    StatefulInteractiveElement as _, Styled as _, TestSupportExt as _, Window, div,
    prelude::FluentBuilder as _, px,
};

use crate::controls::ControlSize as _;
use crate::shell::ModeId;

/// The panel's width, as Sync's run panel had it.
pub const PANEL_WIDTH: f32 = 320.;
/// The most the collapsed indicator takes of the window's width.
const INDICATOR_MAX_WIDTH: f32 = 380.;
/// How often a job's counts alone redraw the indicator: a conversion moves on many times a
/// second, and the window need not follow every step.
const COUNTS_EVERY: Duration = Duration::from_millis(100);

/// Where a job is.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum JobState {
    /// Running now.
    Running,
    /// Running while nothing the owner asked for waits, such as Tidy's background analysis.
    Background,
    /// Paused: it keeps its turn, so what waits behind it waits on.
    Paused,
    /// Waiting for its turn behind another job.
    Queued,
}

impl JobState {
    /// How the panel says it, where the job has nothing more particular to say.
    pub fn caption(self) -> &'static str {
        match self {
            JobState::Running => "Working…",
            JobState::Background => "In the background",
            JobState::Paused => "Paused",
            JobState::Queued => "Queued",
        }
    }

    fn rank(self) -> u8 {
        match self {
            JobState::Running => 0,
            JobState::Paused => 1,
            JobState::Background => 2,
            JobState::Queued => 3,
        }
    }
}

/// What the panel's buttons ask of a job.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum JobControl {
    Pause,
    Resume,
    Stop,
}

/// One piece of work a mode reports: what it does, how far it has got, and which of the panel's
/// controls it takes.
#[derive(Clone, Debug, PartialEq)]
pub struct ActivityJob {
    key: SharedString,
    label: SharedString,
    state: JobState,
    done: u64,
    total: u64,
    ratio: Option<f32>,
    detail: Option<SharedString>,
    pausable: bool,
    stoppable: bool,
}

impl ActivityJob {
    /// A running job, `key` naming it within its mode ("change", "scan", "queued-3") and `label`
    /// saying what it does ("Converting stills to AVIF").
    pub fn new(key: impl Into<SharedString>, label: impl Into<SharedString>) -> Self {
        Self {
            key: key.into(),
            label: label.into(),
            state: JobState::Running,
            done: 0,
            total: 0,
            ratio: None,
            detail: None,
            pausable: false,
            stoppable: false,
        }
    }

    pub fn state(mut self, state: JobState) -> Self {
        self.state = state;
        self
    }

    /// How many of its steps are done, out of `total`; a total of 0 is not known yet.
    pub fn counts(mut self, done: u64, total: u64) -> Self {
        self.done = done;
        self.total = total;
        self
    }

    /// How far it has got, `0.0..=1.0`, where its counts do not say (a push goes by bytes).
    pub fn progress(mut self, ratio: f32) -> Self {
        self.ratio = Some(ratio.clamp(0., 1.));
        self
    }

    /// A line under its progress, such as "1.2 GB of 3.4 GB · 2:31 left".
    pub fn detail(mut self, detail: impl Into<SharedString>) -> Self {
        self.detail = Some(detail.into());
        self
    }

    /// Whether Pause and Resume apply to it now.
    pub fn pausable(mut self, pausable: bool) -> Self {
        self.pausable = pausable;
        self
    }

    /// Whether Stop applies to it now: a queued job leaves the queue.
    pub fn stoppable(mut self, stoppable: bool) -> Self {
        self.stoppable = stoppable;
        self
    }

    pub fn key(&self) -> &SharedString {
        &self.key
    }

    pub fn label(&self) -> &SharedString {
        &self.label
    }

    pub fn job_state(&self) -> JobState {
        self.state
    }

    pub fn is_pausable(&self) -> bool {
        self.pausable
    }

    pub fn is_stoppable(&self) -> bool {
        self.stoppable
    }

    /// How far it has got, if that is known.
    pub fn ratio(&self) -> Option<f32> {
        self.ratio.or_else(|| {
            (self.total > 0).then(|| self.done.min(self.total) as f32 / self.total as f32)
        })
    }

    /// Its label with its counts: "Converting stills to AVIF 40 of 120".
    pub fn summary(&self) -> String {
        if self.total > 0 {
            format!(
                "{} {} of {}",
                self.label,
                count(self.done.min(self.total)),
                count(self.total)
            )
        } else {
            self.label.to_string()
        }
    }

    /// The line under its progress: its own detail, else how it stands.
    pub fn caption(&self) -> SharedString {
        match (&self.detail, self.state) {
            (Some(detail), JobState::Running | JobState::Background) => detail.clone(),
            _ => self.state.caption().into(),
        }
    }

    /// Whether only its counts or its detail differ from `other`'s, which redraws at most every
    /// [`COUNTS_EVERY`].
    fn moves_on_from(&self, other: &Self) -> bool {
        self.key == other.key
            && self.label == other.label
            && self.state == other.state
            && self.pausable == other.pausable
            && self.stoppable == other.stoppable
            && (self.total > 0) == (other.total > 0)
    }
}

/// A control pressed in the panel, for the mode whose job it is.
#[derive(Clone, Debug, PartialEq)]
pub struct JobCommand {
    mode: ModeId,
    key: SharedString,
    control: JobControl,
}

impl JobCommand {
    pub fn mode(&self) -> ModeId {
        self.mode
    }

    pub fn key(&self) -> &str {
        &self.key
    }

    pub fn control(&self) -> JobControl {
        self.control
    }
}

/// Every mode's jobs, and whether the panel is open. One per window, on the shell's state.
#[derive(Default)]
pub struct Activity {
    jobs: [Vec<ActivityJob>; 3],
    open: bool,
    drawn_at: Option<Instant>,
}

impl EventEmitter<JobCommand> for Activity {}

impl Activity {
    /// A mode's jobs as they are now, replacing what it reported before; none when it is idle.
    pub fn set_jobs(&mut self, mode: ModeId, jobs: Vec<ActivityJob>, cx: &mut Context<Self>) {
        let slot = &mut self.jobs[mode.index()];
        if *slot == jobs {
            return;
        }
        let counts_only = slot.len() == jobs.len()
            && slot
                .iter()
                .zip(&jobs)
                .all(|(before, now)| now.moves_on_from(before));
        *slot = jobs;
        if self.is_idle() {
            self.open = false;
        }
        let now = Instant::now();
        if counts_only
            && self
                .drawn_at
                .is_some_and(|drawn| now.duration_since(drawn) < COUNTS_EVERY)
        {
            return;
        }
        self.drawn_at = Some(now);
        cx.notify();
    }

    /// One mode's jobs, as it reported them.
    pub fn jobs_of(&self, mode: ModeId) -> &[ActivityJob] {
        &self.jobs[mode.index()]
    }

    /// Every job, the running ones first and the queued last, each mode's in its own order.
    pub fn jobs(&self) -> Vec<(ModeId, &ActivityJob)> {
        let mut jobs: Vec<(ModeId, &ActivityJob)> = ModeId::ALL
            .into_iter()
            .flat_map(|mode| self.jobs_of(mode).iter().map(move |job| (mode, job)))
            .collect();
        jobs.sort_by_key(|(_, job)| u8::from(job.state == JobState::Queued));
        jobs
    }

    /// The job the collapsed indicator shows: the first that runs, else the first paused, else
    /// the first in the background, else the first queued.
    pub fn lead(&self) -> Option<(ModeId, &ActivityJob)> {
        self.jobs()
            .into_iter()
            .min_by_key(|(_, job)| job.state.rank())
    }

    /// How many jobs wait for their turn.
    pub fn queued(&self) -> usize {
        self.jobs()
            .iter()
            .filter(|(_, job)| job.state == JobState::Queued)
            .count()
    }

    pub fn is_idle(&self) -> bool {
        self.jobs.iter().all(Vec::is_empty)
    }

    /// Whether the panel is open, rather than the compact indicator.
    pub fn is_open(&self) -> bool {
        self.open && !self.is_idle()
    }

    pub fn set_open(&mut self, open: bool, cx: &mut Context<Self>) {
        if self.open != open {
            self.open = open;
            cx.notify();
        }
    }

    pub fn toggle_open(&mut self, cx: &mut Context<Self>) {
        self.set_open(!self.open, cx);
    }

    /// Asks `mode` to pause, resume or stop its job `key`.
    pub fn control(
        &mut self,
        mode: ModeId,
        key: impl Into<SharedString>,
        control: JobControl,
        cx: &mut Context<Self>,
    ) {
        cx.emit(JobCommand {
            mode,
            key: key.into(),
            control,
        });
    }

    /// How the indicator reads: the lead job, then how many more run and how many wait.
    pub fn describe(&self) -> Option<String> {
        let (mode, lead) = self.lead()?;
        let mut text = format!("{} · {}", mode.label(), lead.summary());
        if lead.state == JobState::Paused {
            text.push_str(" · Paused");
        }
        let more = self.jobs().len() - self.queued() - usize::from(lead.state != JobState::Queued);
        if more > 0 {
            text.push_str(&format!(" · {more} more running"));
        }
        let queued = self.queued();
        if queued > 0 {
            text.push_str(&format!(" · {queued} queued"));
        }
        Some(text)
    }
}

/// A count as the pages write one: 1,234.
fn count(value: u64) -> String {
    let digits = value.to_string();
    let mut out = String::with_capacity(digits.len() + digits.len() / 3);
    for (index, digit) in digits.chars().enumerate() {
        if index > 0 && (digits.len() - index).is_multiple_of(3) {
            out.push(',');
        }
        out.push(digit);
    }
    out
}

/// The element id of a job's row, or of one of its parts: `activity-tidy-change-stop`.
pub fn job_element_id(mode: ModeId, key: &str, part: &str) -> SharedString {
    if part.is_empty() {
        format!("activity-{}-{key}", mode.key()).into()
    } else {
        format!("activity-{}-{key}-{part}", mode.key()).into()
    }
}

/// The indicator, or the panel once it is open, at the bottom right of whatever it is drawn in;
/// nothing at all while no mode has a job. The shell draws it once, over every mode.
#[derive(IntoElement)]
pub struct ActivityIndicator {
    activity: Entity<Activity>,
}

impl ActivityIndicator {
    pub fn new(activity: &Entity<Activity>) -> Self {
        Self {
            activity: activity.clone(),
        }
    }
}

impl RenderOnce for ActivityIndicator {
    fn render(self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        let activity = self.activity.read(cx);
        if activity.is_idle() {
            return div().into_any_element();
        }
        let theme = cx.theme();
        let surface = div()
            .absolute()
            .right_4()
            .bottom_4()
            .flex()
            .flex_col()
            .overflow_hidden()
            .rounded(theme.radius_lg)
            .bg(theme.popover)
            .text_color(theme.popover_foreground)
            .border_1()
            .border_color(theme.border)
            .shadow_lg();
        if activity.is_open() {
            surface
                .child(render_panel(&self.activity, cx))
                .into_any_element()
        } else {
            surface
                .child(render_indicator(&self.activity, cx))
                .into_any_element()
        }
    }
}

/// The spinner of running work, or the mark of work that waits.
fn state_mark(state: JobState, cx: &App) -> AnyElement {
    let muted = cx.theme().muted_foreground;
    match state {
        JobState::Running | JobState::Background => Spinner::new().small().into_any_element(),
        JobState::Paused => Icon::new(IconName::Pause)
            .small()
            .text_color(muted)
            .into_any_element(),
        JobState::Queued => Icon::new(IconName::Clock)
            .small()
            .text_color(muted)
            .into_any_element(),
    }
}

fn render_indicator(activity: &Entity<Activity>, cx: &App) -> AnyElement {
    let board = activity.read(cx);
    let theme = cx.theme();
    let Some((mode, lead)) = board.lead() else {
        return div().into_any_element();
    };
    let queued = board.queued();
    let others = board.jobs().len() - queued - usize::from(lead.state != JobState::Queued);
    let description = board.describe().unwrap_or_default();
    let counts = (lead.total > 0).then(|| format!("{} of {}", count(lead.done), count(lead.total)));
    let chip = |id: &'static str, text: String| {
        div()
            .id(id)
            .test_support()
            .aria_label(SharedString::from(text.clone()))
            .flex_shrink_0()
            .px_1p5()
            .rounded_full()
            .bg(theme.muted)
            .text_xs()
            .text_color(theme.muted_foreground)
            .child(text)
    };
    let opener = activity.clone();
    Button::new("activity-indicator")
        .ghost()
        .accessibility_label(SharedString::from(description))
        .tooltip("Show what's running")
        .h(px(36.))
        .max_w(px(INDICATOR_MAX_WIDTH))
        .px_3()
        .gap_2()
        .rounded(theme.radius_lg)
        .child(state_mark(lead.state, cx))
        .child(
            div()
                .flex_shrink_0()
                .text_xs()
                .text_color(theme.muted_foreground)
                .child(mode.label()),
        )
        .child(
            div()
                .id("activity-indicator-label")
                .test_support()
                .aria_label(lead.label.clone())
                .min_w_0()
                .truncate()
                .text_size(px(13.))
                .font_weight(FontWeight::MEDIUM)
                .child(lead.label.clone()),
        )
        .when_some(counts, |this, counts| {
            this.child(
                div()
                    .flex_shrink_0()
                    .text_xs()
                    .text_color(theme.muted_foreground)
                    .child(counts),
            )
        })
        .when(lead.state == JobState::Paused, |this| {
            this.child(
                div()
                    .flex_shrink_0()
                    .text_xs()
                    .text_color(theme.muted_foreground)
                    .child("Paused"),
            )
        })
        .when(others > 0, |this| {
            this.child(chip("activity-indicator-more", format!("+{others}")))
        })
        .when(queued > 0, |this| {
            this.child(chip(
                "activity-indicator-queued",
                format!("{queued} queued"),
            ))
        })
        .child(
            Icon::new(IconName::ChevronUp)
                .small()
                .text_color(theme.muted_foreground),
        )
        .on_click(move |_, _, cx| {
            opener.update(cx, |activity, cx| activity.set_open(true, cx));
        })
        .into_any_element()
}

fn render_panel(activity: &Entity<Activity>, cx: &App) -> AnyElement {
    let board = activity.read(cx);
    let theme = cx.theme();
    let jobs = board.jobs();
    let queued = board.queued();
    let running = jobs.len() - queued;
    let mut counts = Vec::new();
    if running > 0 {
        counts.push(format!("{running} running"));
    }
    if queued > 0 {
        counts.push(format!("{queued} queued"));
    }
    let closer = activity.clone();
    let rows: Vec<AnyElement> = jobs
        .iter()
        .enumerate()
        .map(|(index, (mode, job))| render_job(activity, *mode, job, index > 0, cx))
        .collect();
    div()
        .id("activity-panel")
        .role(Role::Group)
        .test_support()
        .aria_label("Activity")
        .w(px(PANEL_WIDTH))
        .flex()
        .flex_col()
        .child(
            div()
                .flex()
                .flex_row()
                .items_center()
                .gap_2()
                .pl_4()
                .pr_2()
                .h(px(40.))
                .border_b_1()
                .border_color(theme.border)
                .child(
                    div()
                        .font_weight(FontWeight::SEMIBOLD)
                        .text_size(px(13.))
                        .child("Activity"),
                )
                .child(
                    div()
                        .id("activity-panel-counts")
                        .test_support()
                        .aria_label(SharedString::from(counts.join(" · ")))
                        .flex_1()
                        .min_w_0()
                        .truncate()
                        .text_xs()
                        .text_color(theme.muted_foreground)
                        .child(counts.join(" · ")),
                )
                .child(
                    Button::new("activity-panel-close")
                        .ghost()
                        .row_size()
                        .icon(Icon::new(IconName::ChevronDown))
                        .accessibility_label("Hide activity")
                        .tooltip("Hide")
                        .on_click(move |_, _, cx| {
                            closer.update(cx, |activity, cx| activity.set_open(false, cx));
                        }),
                ),
        )
        .child(
            div()
                .id("activity-panel-jobs")
                .flex()
                .flex_col()
                .max_h(px(360.))
                .overflow_y_scroll()
                .children(rows),
        )
        .into_any_element()
}

/// One job's row; rows after the first are ruled off from the one above.
fn render_job(
    activity: &Entity<Activity>,
    mode: ModeId,
    job: &ActivityJob,
    ruled: bool,
    cx: &App,
) -> AnyElement {
    let theme = cx.theme();
    let key = job.key.to_string();
    let id = |part: &str| job_element_id(mode, &key, part);
    let counts = (job.total > 0).then(|| format!("{} of {}", count(job.done), count(job.total)));
    let caption = job.caption();
    let paused = job.state == JobState::Paused;
    let pause = job.pausable.then(|| {
        let (activity, key) = (activity.clone(), job.key.clone());
        Button::new(ElementId::Name(id("pause")))
            .ghost()
            .row_size()
            .icon(Icon::new(if paused {
                IconName::Play
            } else {
                IconName::Pause
            }))
            .accessibility_label(if paused { "Resume" } else { "Pause" })
            .tooltip(if paused { "Resume" } else { "Pause" })
            .on_click(move |_, _, cx| {
                let control = if paused {
                    JobControl::Resume
                } else {
                    JobControl::Pause
                };
                activity.update(cx, |activity, cx| {
                    activity.control(mode, key.clone(), control, cx);
                });
            })
    });
    let stop = job.stoppable.then(|| {
        let (activity, key) = (activity.clone(), job.key.clone());
        let queued = job.state == JobState::Queued;
        Button::new(ElementId::Name(id("stop")))
            .ghost()
            .row_size()
            .icon(Icon::new(if queued {
                IconName::Close
            } else {
                IconName::Square
            }))
            .accessibility_label(if queued { "Remove from queue" } else { "Stop" })
            .tooltip(if queued {
                "Remove from queue"
            } else {
                "Stop (what is done stays done)"
            })
            .on_click(move |_, _, cx| {
                activity.update(cx, |activity, cx| {
                    activity.control(mode, key.clone(), JobControl::Stop, cx);
                });
            })
    });
    let progress = (job.state != JobState::Queued).then(|| {
        Progress::new(ElementId::Name(id("progress")))
            .value(job.ratio().unwrap_or(0.) * 100.)
            .loading(job.ratio().is_none() && job.state != JobState::Paused)
            .when(job.state == JobState::Background, |this| {
                this.color(theme.muted_foreground)
            })
    });
    div()
        .id(ElementId::Name(id("")))
        .role(Role::Status)
        .test_support()
        .aria_label(SharedString::from(format!(
            "{} · {}",
            mode.label(),
            job.summary()
        )))
        .flex()
        .flex_col()
        .gap_1p5()
        .px_4()
        .py_3()
        .when(ruled, |this| this.border_t_1().border_color(theme.border))
        .child(
            div()
                .flex()
                .flex_row()
                .items_baseline()
                .gap_2()
                .child(
                    div()
                        .flex_shrink_0()
                        .text_xs()
                        .text_color(theme.muted_foreground)
                        .child(mode.label()),
                )
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .truncate()
                        .text_size(px(13.))
                        .font_weight(FontWeight::MEDIUM)
                        .child(job.label.clone()),
                )
                .when_some(counts, |this, counts| {
                    this.child(
                        div()
                            .flex_shrink_0()
                            .text_xs()
                            .text_color(theme.muted_foreground)
                            .child(counts),
                    )
                }),
        )
        .children(progress)
        .child(
            div()
                .flex()
                .flex_row()
                .items_center()
                .gap_1()
                .min_h(px(22.))
                .child(
                    div()
                        .id(ElementId::Name(id("state")))
                        .test_support()
                        .aria_label(caption.clone())
                        .flex_1()
                        .min_w_0()
                        .truncate()
                        .text_xs()
                        .text_color(theme.muted_foreground)
                        .child(caption),
                )
                .children(pause)
                .children(stop),
        )
        .into_any_element()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_job_says_how_far_it_has_got() {
        let job = ActivityJob::new("change", "Converting stills to AVIF").counts(40, 120);
        assert_eq!(job.summary(), "Converting stills to AVIF 40 of 120");
        assert_eq!(job.ratio(), Some(40. / 120.));
        assert_eq!(job.caption(), "Working…");
        let queued = ActivityJob::new("queued-1", "Clean up").state(JobState::Queued);
        assert_eq!(queued.summary(), "Clean up");
        assert_eq!(queued.ratio(), None);
        assert_eq!(queued.caption(), "Queued");
        let push = ActivityJob::new("run", "Pushing")
            .progress(0.25)
            .detail("1 GB of 4 GB");
        assert_eq!(push.ratio(), Some(0.25));
        assert_eq!(push.caption(), "1 GB of 4 GB");
        assert_eq!(count(1_234_567), "1,234,567");
    }
}
