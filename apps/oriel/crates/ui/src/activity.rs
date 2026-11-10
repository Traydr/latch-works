//! Everything the app is doing, in one place at the window's bottom right, in every mode (the
//! owner's ask after their first install). Each mode publishes its jobs here, running and queued,
//! and the shell draws them once: a compact indicator with the work that runs and how many jobs
//! wait, which opens into a panel listing every job with its progress and, where the job has
//! them, Pause, Resume and Stop. Nothing shows while nothing runs.
//!
//! Modes report their jobs with the switcher's ring or dot through their
//! [`crate::ModeReporter`]. The jobs live in an entity of their own, so a job's counts moving
//! redraw the indicator without waking every mode that observes the shell's state. A control
//! pressed in the panel reaches the mode whose job it is as a [`JobCommand`]; the mode finds the
//! job by its key.

use std::time::{Duration, Instant};

use gpui_kit::assets::IconName;
use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::progress::Progress;
use gpui_kit::component::scroll::{Scrollbar, ScrollbarMode};
use gpui_kit::component::spinner::Spinner;
use gpui_kit::component::{ActiveTheme as _, Icon, WindowExt as _};
use gpui_kit::{
    AnyElement, App, Bounds, Context, ElementId, Entity, EventEmitter, FontWeight,
    InteractiveElement as _, IntoElement, ParentElement as _, Pixels, RenderOnce, Role,
    ScrollHandle, SharedString, StatefulInteractiveElement as _, Styled as _, Task,
    TestSupportExt as _, Window, canvas, div, linear_color_stop, linear_gradient,
    prelude::FluentBuilder as _, px,
};
use oriel_core_domain::format;

use crate::controls::ControlSize as _;
use crate::controls::TextRole as _;
use crate::mode::ModeMap;
use crate::shell::ModeId;

pub const PANEL_WIDTH: f32 = 400.;
/// The most the collapsed indicator takes of the window's width.
const INDICATOR_MAX_WIDTH: f32 = 440.;
const INDICATOR_HEIGHT: f32 = 44.;
/// The indicator's frame: its inset, border and the surface's border.
const INDICATOR_FRAME: f32 = 28.;
/// Its spinner, and its chevron.
const INDICATOR_MARK: f32 = 16.;
const INDICATOR_GAP: f32 = 8.;
/// A caption's character at its widest on average, so what is reckoned to fit does.
const INDICATOR_CAPTION_CHAR: f32 = 7.5;
const INDICATOR_CHIP_INSET: f32 = 12.;
/// The job's name is left out rather than cut shorter than this.
const INDICATOR_NAME_LEAST: f32 = 90.;
/// The space between the indicator and what is beside it in that room.
const ROOM_MARGIN: f32 = 8.;
const PANEL_HEADER: f32 = 48.;
/// The most the panel's list takes, in a window with room for it.
const PANEL_LIST: f32 = 400.;
/// What a window always keeps clear of the panel above its list: the top bar, a toast and
/// the space around them.
const PANEL_CLEAR: f32 = 220.;
/// The space between the surface and the window's right edge and what it stands on.
const SURFACE_MARGIN: f32 = 16.;
/// How long work runs before the indicator shows: what finishes sooner has its toast to say so, and
/// the indicator would only blink over the page.
const SHOWS_AFTER: Duration = Duration::from_millis(300);
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
                format::count(self.done.min(self.total)),
                format::count(self.total)
            )
        } else {
            self.label.to_string()
        }
    }

    /// The line under its progress: its own detail, else how it stands.
    pub fn caption(&self) -> SharedString {
        match (&self.detail, self.state) {
            (Some(detail), JobState::Running | JobState::Background) => detail.clone(),
            (Some(detail), JobState::Paused) => format!("Paused · {detail}").into(),
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
    jobs: ModeMap<Vec<ActivityJob>>,
    open: bool,
    drawn_at: Option<Instant>,
    /// Work has begun after nothing was running, and has not yet run for [`SHOWS_AFTER`].
    just_began: bool,
    show_after: Option<Task<()>>,
    /// How tall the indicator or the panel was drawn last, for what stands on it.
    surface_height: Pixels,
    /// The panel's list, which scrolls where a short window cannot show every job.
    list_scroll: ScrollHandle,
}

impl EventEmitter<JobCommand> for Activity {}

impl Activity {
    /// A mode's jobs as they are now, replacing what it reported before; none when it is idle.
    pub(crate) fn set_jobs(
        &mut self,
        mode: ModeId,
        mut jobs: Vec<ActivityJob>,
        cx: &mut Context<Self>,
    ) {
        let slot = &mut self.jobs[mode];
        // A job paused holds what it last showed. It may finish its step or move on to its next
        // phase as it stops, and a bar that falls to nothing reads as lost work.
        for job in &mut jobs {
            if job.state == JobState::Paused
                && let Some(before) = slot.iter().find(|before| before.key == job.key)
            {
                job.label = before.label.clone();
                job.done = before.done;
                job.total = before.total;
                job.ratio = before.ratio;
            }
        }
        if *slot == jobs {
            return;
        }
        let counts_only = slot.len() == jobs.len()
            && slot
                .iter()
                .zip(&jobs)
                .all(|(before, now)| now.moves_on_from(before));
        *slot = jobs;
        let now = Instant::now();
        if self.is_idle() {
            if self.open {
                crate::toast::note_panel_closed(cx);
            }
            self.open = false;
            self.just_began = false;
            self.show_after = None;
        } else if self.show_after.is_none() {
            self.just_began = true;
            self.show_after = Some(cx.spawn(async move |this, cx| {
                cx.background_executor().timer(SHOWS_AFTER).await;
                this.update(cx, |this, cx| {
                    this.just_began = false;
                    cx.notify();
                })
                .ok();
            }));
        }
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
        &self.jobs[mode]
    }

    /// Every job, the running ones first and the queued last, each mode's in its own order.
    pub fn jobs(&self) -> Vec<(ModeId, &ActivityJob)> {
        let mut jobs: Vec<(ModeId, &ActivityJob)> = self
            .jobs
            .iter()
            .flat_map(|(mode, jobs)| jobs.iter().map(move |job| (mode, job)))
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
        self.jobs.values().all(Vec::is_empty)
    }

    /// Whether the indicator or the panel is drawn: there is work, and it has run long enough to
    /// be worth saying, or the panel is open on it.
    fn shows(&self) -> bool {
        !self.is_idle() && (self.open || !self.just_began)
    }

    /// Stops every paused job: nothing will resume one once the window has gone, so a quit asked
    /// for while one is paused does not wait for it.
    pub fn stop_paused(&mut self, cx: &mut Context<Self>) {
        let paused: Vec<(ModeId, SharedString)> = self
            .jobs()
            .into_iter()
            .filter(|(_, job)| job.state == JobState::Paused)
            .map(|(mode, job)| (mode, job.key.clone()))
            .collect();
        for (mode, key) in paused {
            cx.emit(JobCommand {
                mode,
                key,
                control: JobControl::Stop,
            });
        }
    }

    /// How much of the window's foot the indicator or the panel takes above the page's own foot:
    /// nothing while neither shows. A toast stands on it.
    pub fn footprint(&self) -> Pixels {
        if !self.shows() {
            px(0.)
        } else {
            self.surface_height + px(SURFACE_MARGIN)
        }
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
    foot: Pixels,
    room: Option<Bounds<Pixels>>,
}

impl ActivityIndicator {
    /// Standing on `foot`, the height of what the page keeps at the window's foot.
    pub fn new(activity: &Entity<Activity>, foot: Pixels) -> Self {
        Self {
            activity: activity.clone(),
            foot,
            room: None,
        }
    }

    /// Room the page keeps free among its commands, where the compact indicator covers nothing,
    /// as it would stood on the foot over what the page shows. It waits there while no toast does.
    pub fn room(mut self, room: Option<Bounds<Pixels>>) -> Self {
        self.room = room;
        self
    }
}

impl RenderOnce for ActivityIndicator {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let toast_showing = !window.notifications(cx).is_empty();
        let activity = self.activity.read(cx);
        if !activity.shows() {
            return div().into_any_element();
        }
        let theme = cx.theme();
        // The panel keeps the top bar and a toast in the clear, however short the window.
        let room = window.viewport_size().height
            - self.foot
            - px(PANEL_CLEAR + PANEL_HEADER + SURFACE_MARGIN);
        let list_height = room.min(px(PANEL_LIST)).max(px(PANEL_HEADER));
        let measured = self.activity.clone();
        // In the page's room only if what matters fits it, whatever the counts have grown to.
        let parts = indicator_parts(activity);
        let in_room = self
            .room
            .filter(|_| !activity.is_open() && !toast_showing)
            .and_then(|room| {
                let fit = parts
                    .as_ref()?
                    .fit(f32::from(room.size.width) - ROOM_MARGIN * 2.)?;
                Some((room, fit))
            });
        let room = in_room.map(|(room, _)| room);
        let viewport = window.viewport_size();
        let (right, bottom) = match room {
            Some(room) => (
                viewport.width - room.right() + px(ROOM_MARGIN),
                viewport.height - room.bottom() + (room.size.height - px(INDICATOR_HEIGHT)) / 2.,
            ),
            None => (px(SURFACE_MARGIN), self.foot + px(SURFACE_MARGIN)),
        };
        let surface = div()
            .absolute()
            .right(right)
            .bottom(bottom)
            .when_some(room, |this, room| {
                this.max_w(room.size.width - px(ROOM_MARGIN * 2.))
            })
            // A press here is its own, and chooses no file under it; the wheel still scrolls what
            // is under it.
            .block_mouse_except_scroll()
            .flex()
            .flex_col()
            .overflow_hidden()
            .rounded(theme.radius_lg)
            .bg(theme.popover)
            .text_color(theme.popover_foreground)
            .border_1()
            .border_color(theme.border)
            .shadow_lg()
            .child(
                canvas(
                    move |bounds, window, cx| {
                        let changed = measured.update(cx, |activity, _| {
                            let changed = activity.surface_height != bounds.size.height;
                            activity.surface_height = bounds.size.height;
                            changed
                        });
                        if changed {
                            crate::redraw::notify_next_frame(measured.downgrade(), window);
                        }
                    },
                    |_, _, _, _| {},
                )
                .absolute()
                .size_full(),
            );
        if activity.is_open() {
            surface
                .child(render_panel(&self.activity, list_height, cx))
                .into_any_element()
        } else {
            surface
                .child(render_indicator(
                    &self.activity,
                    in_room.map_or(EVERYTHING_FITS, |(_, fit)| fit),
                    cx,
                ))
                .into_any_element()
        }
    }
}

/// The spinner of running work, or the mark of work that waits.
fn state_mark(state: JobState, cx: &App) -> AnyElement {
    let muted = cx.theme().muted_foreground;
    match state {
        JobState::Running | JobState::Background => Spinner::new().into_any_element(),
        JobState::Paused => Icon::new(IconName::Pause)
            .text_color(muted)
            .into_any_element(),
        JobState::Queued => Icon::new(IconName::Clock)
            .text_color(muted)
            .into_any_element(),
    }
}

/// Where nothing limits the indicator but its own widest.
const EVERYTHING_FITS: IndicatorFit = IndicatorFit {
    name: true,
    count: CountShown::Percent,
    chips: true,
};

/// What the compact indicator has to show beside its spinner and chevron, which always show.
struct IndicatorParts {
    mode: &'static str,
    done: String,
    total: String,
    percent: Option<String>,
    paused: bool,
    more: Option<String>,
    queued: Option<String>,
}

/// How much of a job's count the indicator shows.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum CountShown {
    /// "10 of 100 · 50%"
    Percent,
    /// "10 of 100"
    Plain,
    /// "100"
    Total,
    None,
}

/// What of the indicator's parts it shows.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct IndicatorFit {
    name: bool,
    count: CountShown,
    chips: bool,
}

impl IndicatorParts {
    fn count_text(&self, shown: CountShown) -> Option<String> {
        if self.total == "0" {
            return None;
        }
        match shown {
            CountShown::Percent => Some(match &self.percent {
                Some(percent) => format!("{} of {} · {percent}", self.done, self.total),
                None => format!("{} of {}", self.done, self.total),
            }),
            CountShown::Plain => Some(format!("{} of {}", self.done, self.total)),
            CountShown::Total => Some(self.total.clone()),
            CountShown::None => None,
        }
    }

    /// How wide the indicator is with `fit`, at a generous reckoning of its captions.
    fn width(&self, fit: IndicatorFit) -> f32 {
        let caption = |text: &str| text.chars().count() as f32 * INDICATOR_CAPTION_CHAR;
        let chip = |text: &Option<String>| match text {
            Some(text) if fit.chips => Some(caption(text) + INDICATOR_CHIP_INSET),
            _ => None,
        };
        let parts = [
            Some(INDICATOR_MARK),
            Some(caption(self.mode)),
            fit.name.then_some(INDICATOR_NAME_LEAST),
            self.count_text(fit.count).map(|count| caption(&count)),
            self.paused.then(|| caption("Paused")),
            chip(&self.more),
            chip(&self.queued),
            Some(INDICATOR_MARK),
        ];
        let shown: Vec<f32> = parts.into_iter().flatten().collect();
        INDICATOR_FRAME + shown.iter().sum::<f32>() + (shown.len() - 1) as f32 * INDICATOR_GAP
    }

    /// The most that fits `room`, leaving out the name, then the chips and the share, then the
    /// "10 of", then the count. `None` if not even the spinner, mode and chevron fit, when the
    /// indicator stands somewhere else. A paused job says so before it gives its count.
    fn fit(&self, room: f32) -> Option<IndicatorFit> {
        let fit = |name, count, chips| IndicatorFit { name, count, chips };
        let steps = if self.paused {
            vec![
                fit(true, CountShown::Percent, true),
                fit(false, CountShown::Percent, true),
                fit(false, CountShown::None, true),
                fit(false, CountShown::None, false),
            ]
        } else {
            vec![
                fit(true, CountShown::Percent, true),
                fit(false, CountShown::Percent, true),
                fit(false, CountShown::Plain, true),
                fit(false, CountShown::Plain, false),
                fit(false, CountShown::Total, false),
                fit(false, CountShown::None, false),
            ]
        };
        steps.into_iter().find(|step| self.width(*step) <= room)
    }
}

fn indicator_parts(activity: &Activity) -> Option<IndicatorParts> {
    let (mode, lead) = activity.lead()?;
    let queued = activity.queued();
    let others = activity.jobs().len() - queued - usize::from(lead.state != JobState::Queued);
    Some(IndicatorParts {
        mode: mode.label(),
        done: format::count(lead.done),
        total: format::count(lead.total),
        // Steps can take minutes each, so the share within them shows it is moving.
        percent: lead
            .ratio
            .map(|ratio| format!("{}%", (ratio * 100.).floor())),
        paused: lead.state == JobState::Paused,
        more: (others > 0).then(|| format!("+{others}")),
        queued: (queued > 0).then(|| format!("{queued} queued")),
    })
}

fn render_indicator(activity: &Entity<Activity>, fit: IndicatorFit, cx: &App) -> AnyElement {
    let board = activity.read(cx);
    let theme = cx.theme();
    let (Some((mode, lead)), Some(parts)) = (board.lead(), indicator_parts(board)) else {
        return div().into_any_element();
    };
    let description = board.describe().unwrap_or_default();
    let chip = |id: &'static str, text: String| {
        div()
            .id(id)
            .test_support()
            .aria_label(SharedString::from(text.clone()))
            .flex_shrink_0()
            .px_1p5()
            .rounded_full()
            .bg(theme.muted)
            .text_caption()
            .text_color(theme.muted_foreground)
            .child(text)
    };
    let opener = activity.clone();
    Button::new("activity-indicator")
        .ghost()
        .accessibility_label(SharedString::from(description.clone()))
        // What it leaves out, its tooltip says.
        .tooltip(if fit.name {
            "Show what's running".into()
        } else {
            SharedString::from(description)
        })
        .h(px(INDICATOR_HEIGHT))
        .max_w(px(INDICATOR_MAX_WIDTH))
        .px_3()
        .gap_2()
        .rounded(theme.radius_lg)
        .child(state_mark(lead.state, cx))
        .child(
            div()
                .flex_shrink_0()
                .text_caption()
                .text_color(theme.muted_foreground)
                .child(mode.label()),
        )
        .when(fit.name, |this| {
            this.child(
                div()
                    .id("activity-indicator-label")
                    .test_support()
                    .aria_label(lead.label.clone())
                    .min_w_0()
                    .truncate()
                    .text_body()
                    .font_weight(FontWeight::MEDIUM)
                    .child(lead.label.clone()),
            )
        })
        .when_some(parts.count_text(fit.count), |this, counts| {
            this.child(
                div()
                    .flex_shrink_0()
                    .text_caption()
                    .text_color(theme.muted_foreground)
                    .child(counts),
            )
        })
        .when(lead.state == JobState::Paused, |this| {
            this.child(
                div()
                    .flex_shrink_0()
                    .text_caption()
                    .text_color(theme.muted_foreground)
                    .child("Paused"),
            )
        })
        .when_some(parts.more.filter(|_| fit.chips), |this, more| {
            this.child(chip("activity-indicator-more", more))
        })
        .when_some(parts.queued.filter(|_| fit.chips), |this, queued| {
            this.child(chip("activity-indicator-queued", queued))
        })
        .child(
            div()
                .id("activity-indicator-open")
                .test_support()
                .flex_shrink_0()
                .child(Icon::new(IconName::ChevronUp).text_color(theme.muted_foreground)),
        )
        .on_click(move |_, _, cx| {
            opener.update(cx, |activity, cx| activity.set_open(true, cx));
        })
        .into_any_element()
}

fn render_panel(activity: &Entity<Activity>, list_height: Pixels, cx: &App) -> AnyElement {
    let board = activity.read(cx);
    let theme = cx.theme();
    let jobs = board.jobs();
    let queued = board.queued();
    let paused = jobs
        .iter()
        .filter(|(_, job)| job.state == JobState::Paused)
        .count();
    let running = jobs.len() - queued - paused;
    let mut counts = Vec::new();
    if running > 0 {
        counts.push(format!("{running} running"));
    }
    if paused > 0 {
        counts.push(format!("{paused} paused"));
    }
    if queued > 0 {
        counts.push(format!("{queued} queued"));
    }
    let closer = activity.clone();
    let list_scroll = board.list_scroll.clone();
    let most = f32::from(list_scroll.max_offset().y);
    let scrolls = most > 0.5;
    let more_below = scrolls && -f32::from(list_scroll.offset().y) < most - 0.5;
    let ground = theme.popover;
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
                .h(px(PANEL_HEADER))
                .border_b_1()
                .border_color(theme.border)
                .child(
                    div()
                        .font_weight(FontWeight::SEMIBOLD)
                        .text_body()
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
                        .text_caption()
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
                .relative()
                .max_h(list_height)
                .flex()
                .flex_col()
                .min_h_0()
                .child(
                    div()
                        .id("activity-panel-jobs")
                        .flex()
                        .flex_col()
                        .max_h(list_height)
                        .overflow_y_scroll()
                        .track_scroll(&list_scroll)
                        .children(rows),
                )
                // A job past the edge is said three ways: cut in part, the edge fading into it,
                // and a scrollbar that stays.
                .when(more_below, |this| {
                    this.child(div().absolute().left_0().right_0().bottom_0().h_10().bg(
                        linear_gradient(
                            180.,
                            linear_color_stop(ground.opacity(0.), 0.),
                            linear_color_stop(ground.opacity(0.9), 1.),
                        ),
                    ))
                })
                .when(scrolls, |this| {
                    this.child(
                        div()
                            .absolute()
                            .inset_0()
                            .child(Scrollbar::vertical(&list_scroll).mode(ScrollbarMode::Always)),
                    )
                }),
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
    let counts = (job.total > 0).then(|| {
        format!(
            "{} of {}",
            format::count(job.done),
            format::count(job.total)
        )
    });
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
                        .text_caption()
                        .text_color(theme.muted_foreground)
                        .child(mode.label()),
                )
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .truncate()
                        .text_body()
                        .font_weight(FontWeight::MEDIUM)
                        .child(job.label.clone()),
                )
                .when_some(counts, |this, counts| {
                    this.child(
                        div()
                            .flex_shrink_0()
                            .text_caption()
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
                .min_h(crate::controls::ROW_HEIGHT)
                .child(
                    div()
                        .id(ElementId::Name(id("state")))
                        .test_support()
                        .aria_label(caption.clone())
                        .flex_1()
                        .min_w_0()
                        .truncate()
                        .text_caption()
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

    fn parts(done: &str, total: &str, more: bool) -> IndicatorParts {
        IndicatorParts {
            mode: "Sync",
            done: done.into(),
            total: total.into(),
            percent: None,
            paused: false,
            more: more.then(|| "+1".to_string()),
            queued: None,
        }
    }

    #[test]
    fn the_indicator_gives_up_parts_in_order_and_never_outgrows_its_room() {
        let job = parts("10", "100", true);
        let at = |room: f32| job.fit(room).unwrap();
        let count = |room: f32| job.count_text(at(room).count);
        assert!(at(400.).name);
        assert_eq!(count(220.).as_deref(), Some("10 of 100"));
        assert!(!at(220.).name && at(220.).chips);
        assert_eq!(count(185.).as_deref(), Some("10 of 100"));
        assert!(!at(185.).chips);
        assert_eq!(count(140.).as_deref(), Some("100"));
        assert_eq!(count(110.), None);
        assert_eq!(job.fit(100.), None, "it stands elsewhere");
        for job in [parts("10", "100", true), parts("1,000", "2,000", true)] {
            for room in (100..460).step_by(5) {
                let room = room as f32;
                if let Some(fit) = job.fit(room) {
                    assert!(job.width(fit) <= room, "{room}");
                }
            }
        }
    }

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
    }
}
