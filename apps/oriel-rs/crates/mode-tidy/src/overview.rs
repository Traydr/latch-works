//! Overview (`views/OverviewView.tsx`): what tidying the folder would do, with Tidy up (⌘↩)
//! running every step but duplicates as one change, then the similar versions and identical
//! copies that wait for the owner, Shrink, holding, and what else the scan found.

use std::collections::BTreeSet;

use gpui_kit::assets::IconName;
use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::progress::Progress;
use gpui_kit::component::spinner::Spinner;
use gpui_kit::component::{ActiveTheme as _, Disableable as _, Icon, Sizable as _};
use gpui_kit::{
    AnyElement, App, Context, Entity, FocusHandle, Focusable, FontWeight, InteractiveElement as _,
    IntoElement, KeyDownEvent, ObjectFit, ParentElement as _, Render, Role, SharedString,
    StatefulInteractiveElement as _, Styled as _, Subscription, TestSupportExt as _, Window, div,
    prelude::FluentBuilder as _, px,
};
use oriel_core_tidy::contract::{
    DuplicateScope, DuplicateSetPage, DuplicateSetRequest, FileFlag, FileFormat, FindingKind,
    RootId, SimilarityLevel, Tidy,
};
use oriel_ui::TopBar;

use crate::actions::{PerformOptions, TidyStep};
use crate::changes::{PlanKind, PlanRequest};
use crate::format;
use crate::loaded::Loaded;
use crate::pages::TidyPage;
use crate::state::{LibraryPreset, TidyState};
use crate::thumbs::{self, Thumbs};
use crate::widgets;

const TIDY_SOURCE: &str = "overview:tidy";

/// Up to this many keepers stand for the similar sets on the "needs your eye" card.
const STACK: usize = 5;

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum StepId {
    CleanUp,
    Silent,
    Convert,
}

impl StepId {
    fn key(self) -> &'static str {
        match self {
            StepId::CleanUp => "cleanup",
            StepId::Silent => "silent",
            StepId::Convert => "convert",
        }
    }

    fn source(self) -> &'static str {
        match self {
            StepId::CleanUp => "overview:cleanup",
            StepId::Silent => "overview:silent",
            StepId::Convert => "overview:convert",
        }
    }

    /// Which row a plan Tidy up runs belongs to.
    fn of_kind(kind: PlanKind) -> Option<Self> {
        match kind {
            PlanKind::Cleanup => Some(StepId::CleanUp),
            PlanKind::StripAudio => Some(StepId::Silent),
            PlanKind::Optimize => Some(StepId::Convert),
            _ => None,
        }
    }
}

/// Where a row of the hero card is.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StepState {
    Todo,
    Running,
    Done,
}

impl StepState {
    fn key(self) -> &'static str {
        match self {
            StepState::Todo => "todo",
            StepState::Running => "running",
            StepState::Done => "done",
        }
    }
}

struct Step {
    id: StepId,
    icon: IconName,
    title: &'static str,
    caption: String,
    todo: bool,
    open: TidyPage,
    action: &'static str,
}

pub struct OverviewPage {
    state: Entity<TidyState>,
    thumbs: Entity<Thumbs>,
    focus: FocusHandle,
    /// Rows started this visit stay listed, as done once their work is.
    started: (Option<RootId>, BTreeSet<StepId>),
    /// What the last Tidy up this visit took out of the folder, for the done card.
    saved: Option<(RootId, f64)>,
    keepers: Loaded<DuplicateSetPage>,
    seen: (Option<RootId>, u64),
    /// The hero card's rows as last drawn, which ↑ ↓ move between, and the one they rest on: its
    /// ring shows, and ↩ or → open its page.
    shown_steps: Vec<(StepId, TidyPage)>,
    focused_step: Option<StepId>,
    _subscriptions: Vec<Subscription>,
}

impl OverviewPage {
    pub fn new(state: &Entity<TidyState>, thumbs: &Entity<Thumbs>, cx: &mut Context<Self>) -> Self {
        let subscriptions = vec![
            cx.observe(state, |this, _, cx| this.sync(cx)),
            cx.observe(thumbs, |_, _, cx| cx.notify()),
        ];
        Self {
            state: state.clone(),
            thumbs: thumbs.clone(),
            focus: cx.focus_handle(),
            started: (None, BTreeSet::new()),
            saved: None,
            keepers: Loaded::default(),
            seen: (None, 0),
            shown_steps: Vec::new(),
            focused_step: None,
            _subscriptions: subscriptions,
        }
    }

    /// Reads the similar sets' keepers again when the catalog moves, while Overview shows.
    fn sync(&mut self, cx: &mut Context<Self>) {
        let state = self.state.read(cx);
        if state.page() != TidyPage::Overview {
            // A row's ring is for this visit only, as a focused button's is.
            self.focused_step = None;
            cx.notify();
            return;
        }
        let key = (state.root_id(), state.catalog_version());
        if key == self.seen {
            cx.notify();
            return;
        }
        self.seen = key;
        let (Some(engine), Some(root_id)) = (state.engine().cloned(), state.root_id()) else {
            return;
        };
        let level = state
            .settings()
            .map_or(SimilarityLevel::Balanced, |settings| settings.similarity);
        let request = DuplicateSetRequest {
            root_id: Some(root_id),
            offset: 0,
            limit: STACK,
            level,
            scope: DuplicateScope::Similar,
            dismissed: false,
        };
        self.keepers
            .load(engine.duplicate_sets(request), |this| &mut this.keepers, cx);
        cx.notify();
    }

    fn steps(&self, data: &Tidy, cx: &App) -> Vec<Step> {
        let state = self.state.read(cx);
        let groups: Vec<_> = state.convert_groups().iter().copied().collect();
        let (files, bytes) = groups.iter().fold((0, 0), |(files, bytes), group| {
            let (f, b) = group.totals(data);
            (files + f, bytes + b)
        });
        let estimate = state.estimate(&state.convert_categories());
        let cleanup = &data.cleanup;
        let parts = [
            (cleanup.junk > 0).then(|| format::plural(cleanup.junk, "junk file")),
            (cleanup.empty_folders > 0)
                .then(|| format::plural(cleanup.empty_folders, "empty folder")),
            (cleanup.extensions > 0).then(|| format::plural(cleanup.extensions, "wrong extension")),
        ];
        vec![
            Step {
                id: StepId::CleanUp,
                icon: IconName::Sparkles,
                title: "Junk and empty folders",
                caption: parts.into_iter().flatten().collect::<Vec<_>>().join(" · "),
                todo: cleanup.junk + cleanup.empty_folders + cleanup.extensions > 0,
                open: TidyPage::CleanUp,
                action: "Clean up",
            },
            Step {
                id: StepId::Silent,
                icon: IconName::VolumeX,
                title: "Silent soundtracks",
                caption: format::plural(data.silent_tracks.files, "video"),
                todo: data.silent_tracks.files > 0,
                open: TidyPage::CleanUp,
                action: "Remove sound",
            },
            Step {
                id: StepId::Convert,
                icon: IconName::Repeat2,
                title: "Convert to AVIF and MP4",
                caption: format!(
                    "{} · {}",
                    format::plural(files, "file"),
                    estimate.describe(bytes as f64)
                ),
                todo: files > 0,
                open: TidyPage::Convert,
                action: "Convert",
            },
        ]
    }

    /// The row whose plan Tidy up is running.
    fn tidy_step(&self, cx: &App) -> Option<StepId> {
        let change = self.state.read(cx).change_for(TIDY_SOURCE)?;
        StepId::of_kind(change.kind?)
    }

    fn state_of(&self, step: &Step, cx: &App) -> StepState {
        let state = self.state.read(cx);
        if state.change_for(step.id.source()).is_some() || self.tidy_step(cx) == Some(step.id) {
            StepState::Running
        } else if step.todo {
            StepState::Todo
        } else {
            StepState::Done
        }
    }

    fn kept(&self, cx: &App) -> BTreeSet<StepId> {
        let root_id = self.state.read(cx).root_id();
        if self.started.0 == root_id {
            self.started.1.clone()
        } else {
            BTreeSet::new()
        }
    }

    fn keep(&mut self, steps: impl IntoIterator<Item = StepId>, cx: &App) {
        let root_id = self.state.read(cx).root_id();
        if self.started.0 != root_id {
            self.started = (root_id, BTreeSet::new());
        }
        self.started.1.extend(steps);
    }

    /// Runs one row's work on its own.
    fn run_step(&mut self, id: StepId, window: &mut Window, cx: &mut Context<Self>) {
        let state = self.state.read(cx);
        let Some(root_id) = state.root_id() else {
            return;
        };
        let categories = state.convert_categories();
        self.keep([id], cx);
        let source = PerformOptions::from(id.source());
        self.state.update(cx, |state, cx| match id {
            StepId::CleanUp => {
                state.perform(PlanRequest::Cleanup { root_id }, source, window, cx);
            }
            StepId::Silent => state.perform_all(
                vec![TidyStep::SilentVideos(root_id)],
                "Removed silent soundtracks".into(),
                StepId::Silent.source(),
                window,
                cx,
            ),
            StepId::Convert => state.perform(
                PlanRequest::Optimize {
                    root_id,
                    categories,
                    file_ids: None,
                },
                source,
                window,
                cx,
            ),
        });
        cx.notify();
    }

    /// Tidy up: Clean up, then silent soundtracks, then Convert, as one change with one Undo
    /// (`tidyUpSteps`). Duplicates are not a step: the owner decides every set.
    pub fn tidy_up(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let state = self.state.read(cx);
        let (Some(root), Some(data)) = (state.root().cloned(), state.overview.data().cloned())
        else {
            return;
        };
        if state.is_changing() {
            return;
        }
        let categories = state.convert_categories();
        let todo: Vec<StepId> = self
            .steps(&data, cx)
            .into_iter()
            .filter(|step| step.todo)
            .map(|step| step.id)
            .collect();
        self.keep(todo, cx);
        let mut steps = Vec::new();
        let cleanup = &data.cleanup;
        if cleanup.junk + cleanup.empty_folders + cleanup.extensions > 0 {
            steps.push(TidyStep::Planned(PlanRequest::Cleanup { root_id: root.id }));
        }
        if data.silent_tracks.files > 0 {
            steps.push(TidyStep::SilentVideos(root.id));
        }
        if !categories.is_empty() {
            steps.push(TidyStep::Planned(PlanRequest::Optimize {
                root_id: root.id,
                categories,
                file_ids: None,
            }));
        }
        if steps.is_empty() {
            return;
        }
        let title = format!("Tidied up {}", root.name);
        self.state.update(cx, |state, cx| {
            state.perform_all(steps, title, TIDY_SOURCE, window, cx);
        });
        cx.notify();
    }

    fn on_key_down(&mut self, event: &KeyDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        let keys = &event.keystroke;
        if keys.modifiers.platform && keys.key == "enter" {
            self.tidy_up(window, cx);
            cx.stop_propagation();
        } else if !keys.modifiers.modified() && keys.key == "d" {
            self.state.update(cx, |state, cx| {
                state.open_duplicates(DuplicateScope::Similar, cx);
            });
            cx.stop_propagation();
        } else if !keys.modifiers.modified() && self.move_between_steps(&keys.key, cx) {
            cx.stop_propagation();
        }
    }

    /// ↑ ↓ move between the hero card's rows, from the first or the last; ↩ and → open the page of
    /// the row they rest on, as Electron's arrows move the focus between its row buttons.
    fn move_between_steps(&mut self, key: &str, cx: &mut Context<Self>) -> bool {
        let at = self
            .focused_step
            .and_then(|focused| self.shown_steps.iter().position(|(id, _)| *id == focused));
        match key {
            "down" | "up" if !self.shown_steps.is_empty() => {
                let last = self.shown_steps.len() - 1;
                let next = match (at, key) {
                    (None, "down") => 0,
                    (None, _) => last,
                    (Some(at), "down") => (at + 1).min(last),
                    (Some(at), _) => at.saturating_sub(1),
                };
                self.focused_step = Some(self.shown_steps[next].0);
                cx.notify();
                true
            }
            "enter" | "right" => {
                let Some((_, page)) = at.map(|at| self.shown_steps[at]) else {
                    return false;
                };
                self.state.update(cx, |state, cx| state.go(page, cx));
                true
            }
            _ => false,
        }
    }

    fn render_top_bar(&self, cx: &mut Context<Self>) -> TopBar {
        let state = self.state.read(cx);
        let theme = cx.theme();
        let scanning = state.root_id().is_some_and(|id| state.is_scanning(id));
        let meta = state.overview.data().map(|data| {
            let scanned = if scanning {
                "scanning".to_string()
            } else {
                format!(
                    "scanned {}",
                    format::relative(data.last_scan_at.map(|at| at as f64), format::now_ms())
                )
            };
            format!(
                "{} · {} · {scanned}",
                format::plural(data.files, "file"),
                format::bytes(data.bytes as f64)
            )
        });
        let rescan = Button::new("overview-rescan")
            .ghost()
            .small()
            .map(|button| {
                if scanning {
                    button.child(Spinner::new().small())
                } else {
                    button.icon(Icon::new(IconName::RefreshCw))
                }
            })
            .disabled(scanning)
            .accessibility_label("Rescan")
            .tooltip("Rescan  ⌘R")
            .on_click(cx.listener(|this, _, window, cx| {
                this.state.update(cx, |state, cx| {
                    if let Some(root_id) = state.root_id() {
                        state.start_scan(root_id, window, cx);
                    }
                });
            }));
        // The folder on screen goes to the other modes: View shows it, Sync pushes it.
        let links = state.root().map(|root| {
            let (shown, synced) = (root.path.clone(), root.path.clone());
            div()
                .flex()
                .flex_row()
                .items_center()
                .gap_1()
                .child(
                    Button::new("overview-open-in-view")
                        .ghost()
                        .small()
                        .icon(Icon::new(IconName::Images))
                        .label("Open in View")
                        .tooltip("Open this folder in View")
                        .on_click(cx.listener(move |this, _, _, cx| {
                            let folder = shown.clone();
                            this.state
                                .update(cx, |state, cx| state.open_in_view(folder, cx));
                        })),
                )
                .child(
                    Button::new("overview-sync-folder")
                        .ghost()
                        .small()
                        .icon(Icon::new(IconName::FolderUp))
                        .label("Sync this folder")
                        .tooltip("Push this folder to Pane View with Sync")
                        .on_click(cx.listener(move |this, _, _, cx| {
                            let folder = synced.clone();
                            this.state
                                .update(cx, |state, cx| state.sync_folder(folder, cx));
                        })),
                )
        });
        TopBar::new(&state.shell, "Overview")
            .when_some(meta, |bar, meta| {
                bar.trailing(
                    div()
                        .id("overview-meta")
                        .test_support()
                        .aria_label(SharedString::from(meta.clone()))
                        .text_xs()
                        .text_color(theme.muted_foreground)
                        .child(meta),
                )
            })
            .when_some(links, |bar, links| bar.trailing(links))
            .trailing(rescan)
    }

    fn render_first_scan(&self, cx: &mut Context<Self>) -> AnyElement {
        let state = self.state.read(cx);
        let name = state
            .root()
            .map(|root| root.name.clone())
            .unwrap_or_else(|| "the folder".into());
        let progress = state
            .scan()
            .map(|scan| scan.job.read(cx).progress().clone());
        let done = progress.as_ref().map_or(0, |progress| progress.done());
        let total = progress.as_ref().map_or(0, |progress| progress.total());
        div()
            .flex()
            .flex_col()
            .flex_1()
            .items_center()
            .justify_center()
            .gap_3()
            .p_10()
            .pb(px(100.))
            .child(
                div()
                    .text_size(px(15.))
                    .font_weight(FontWeight::SEMIBOLD)
                    .child(format!("Scanning {name}")),
            )
            .child(
                div().w(px(320.)).child(
                    Progress::new("overview-scan-progress")
                        .value(if total > 0 {
                            done as f32 / total as f32 * 100.
                        } else {
                            0.
                        })
                        .loading(total == 0),
                ),
            )
            .child(widgets::caption(
                format::plural(done as i64, "file") + " found",
                cx,
            ))
            .into_any_element()
    }

    fn render_hero(&mut self, data: &Tidy, cx: &mut Context<Self>) -> AnyElement {
        let muted = cx.theme().muted_foreground;
        let success = cx.theme().success;
        let state = self.state.read(cx);
        let tidying = state.change_for(TIDY_SOURCE).is_some();
        let steps = self.steps(data, cx);
        let kept = self.kept(cx);
        let work = steps.iter().any(|step| step.todo) || tidying;
        let root_name = state
            .root()
            .map(|root| root.name.clone())
            .unwrap_or_default();

        if !work {
            let saved = self
                .saved
                .filter(|(root_id, _)| Some(*root_id) == state.root_id())
                .map_or(0., |(_, bytes)| bytes);
            let line = if saved > 0. {
                format!(
                    "{} out of {root_name} · in holding until you empty it",
                    format::bytes(saved)
                )
            } else {
                "Nothing left to tidy".to_string()
            };
            return widgets::card(cx)
                .id("overview-step-tidy")
                .test_support()
                .aria_label(SharedString::from(line.clone()))
                .flex_row()
                .items_center()
                .gap_3()
                .h(px(64.))
                .px_5()
                .child(Icon::new(IconName::Check).size(px(20.)).text_color(success))
                .child(
                    div()
                        .flex()
                        .flex_col()
                        .min_w_0()
                        .child(
                            div()
                                .text_size(px(13.))
                                .font_weight(FontWeight::SEMIBOLD)
                                .child("Tidy"),
                        )
                        .child(widgets::caption(line, cx).truncate()),
                )
                .into_any_element();
        }

        let categories = state.convert_categories();
        let convert_files: i64 = state
            .convert_groups()
            .iter()
            .map(|group| group.totals(data).0)
            .sum();
        let estimate = state.estimate(&categories);
        let saving = match estimate {
            crate::state::Estimate::Known { before, after } if convert_files > 0 => {
                (before - after).max(0.)
            }
            _ => 0.,
        };
        let estimating = convert_files > 0 && estimate == crate::state::Estimate::Pending;
        let states: Vec<StepState> = steps.iter().map(|step| self.state_of(step, cx)).collect();
        let done = states
            .iter()
            .filter(|state| **state == StepState::Done)
            .count() as i64;
        let todo = steps.iter().filter(|step| step.todo).count() as i64;
        // Tidy up leaves duplicates to the owner, so what it saves leaves them out, and says so.
        let duplicates = data.duplicates.similar.sets + data.duplicates.exact.sets > 0;
        let heading = if tidying {
            "Tidying up"
        } else if saving > 0. && duplicates {
            "Tidying up saves, not counting duplicates"
        } else if saving > 0. {
            "Tidying up saves"
        } else {
            "Ready to tidy"
        };
        let display = if tidying {
            format!("{} of {} done", format::plural(done, "step"), steps.len())
        } else if saving > 0. {
            format!(
                "{} {}",
                if estimating { "At least" } else { "About" },
                format::bytes(saving)
            )
        } else {
            format!("{} to do", format::plural(todo, "thing"))
        };

        let action: AnyElement = match state.change_for(TIDY_SOURCE) {
            Some(change) => {
                let progress = change.progress(cx);
                let label = if progress.phase().is_empty() {
                    change.name(cx)
                } else {
                    progress.phase().clone()
                };
                let stopper = self.state.clone();
                widgets::run_progress(
                    "overview-tidy",
                    label,
                    progress.done(),
                    progress.total(),
                    // Tidy up runs its steps one after another, so it stops but never pauses.
                    None,
                    move |_, _, cx| stopper.update(cx, |state, cx| state.stop_change(cx)),
                    cx,
                )
                .into_any_element()
            }
            None => widgets::primary_action("overview-tidy-up", "Tidy up", "⌘↩")
                .large()
                .disabled(state.is_changing())
                .on_click(cx.listener(|this, _, window, cx| this.tidy_up(window, cx)))
                .into_any_element(),
        };

        let shown: Vec<(Step, StepState)> = steps
            .into_iter()
            .zip(states)
            .filter(|(step, row_state)| {
                step.todo || kept.contains(&step.id) || *row_state == StepState::Running
            })
            .collect();
        self.shown_steps = shown.iter().map(|(step, _)| (step.id, step.open)).collect();
        let rows: Vec<AnyElement> = shown
            .into_iter()
            .enumerate()
            .map(|(index, (step, row_state))| self.render_step(index, step, row_state, tidying, cx))
            .collect();

        widgets::card(cx)
            .p_5()
            .child(
                div()
                    .flex()
                    .flex_row()
                    .items_end()
                    .gap_4()
                    .child(
                        div()
                            .flex()
                            .flex_col()
                            .flex_1()
                            .min_w_0()
                            .child(
                                div()
                                    .text_xs()
                                    .font_weight(FontWeight::MEDIUM)
                                    .text_color(muted)
                                    .child(heading),
                            )
                            .child(
                                div()
                                    .id("overview-display")
                                    .test_support()
                                    .aria_label(SharedString::from(display.clone()))
                                    .mt_1()
                                    .flex()
                                    .flex_row()
                                    .items_center()
                                    .gap(px(10.))
                                    .text_size(px(24.))
                                    .font_weight(FontWeight::SEMIBOLD)
                                    .child(display)
                                    .when(!tidying && saving > 0. && estimating, |this| {
                                        this.child(Spinner::new().small())
                                    }),
                            )
                            .child(
                                widgets::caption(
                                    "Everything goes to holding first and can be undone.",
                                    cx,
                                )
                                .mt(px(6.)),
                            ),
                    )
                    .child(action),
            )
            .child(div().mt_5().flex().flex_col().children(rows))
            .into_any_element()
    }

    fn render_step(
        &self,
        index: usize,
        step: Step,
        row_state: StepState,
        busy: bool,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let theme = cx.theme();
        let done = row_state == StepState::Done;
        let caption = if done {
            "Done".to_string()
        } else {
            step.caption.clone()
        };
        let (id, open) = (step.id, step.open);
        let focused = self.focused_step == Some(id);
        div()
            .id(SharedString::from(format!(
                "overview-step-{}",
                step.id.key()
            )))
            .test_support()
            .aria_label(SharedString::from(format!("{} · {caption}", step.title)))
            .aria_description(SharedString::from(row_state.key()))
            .group("step")
            .relative()
            .flex()
            .flex_row()
            .items_center()
            .gap_3()
            .h(px(52.))
            .px_2()
            .rounded(theme.radius)
            .when(index > 0, |this| {
                this.border_t_1().border_color(theme.border)
            })
            .hover(|style| style.bg(theme.accent))
            .when(focused, |this| {
                this.bg(theme.accent).border_1().border_color(theme.ring)
            })
            .cursor_pointer()
            .on_click(cx.listener(move |this, _, _, cx| {
                this.state.update(cx, |state, cx| state.go(open, cx));
            }))
            .child(
                widgets::row_icon(if done { IconName::Check } else { step.icon }, cx)
                    .when(done, |this| this.text_color(theme.success)),
            )
            .child(
                div()
                    .flex()
                    .flex_col()
                    .flex_1()
                    .min_w_0()
                    .child(
                        div()
                            .text_size(px(13.))
                            .font_weight(FontWeight::MEDIUM)
                            .when(done, |this| this.text_color(theme.muted_foreground))
                            .child(step.title),
                    )
                    .child(widgets::caption(caption, cx).truncate()),
            )
            .when(row_state == StepState::Todo && !busy, |this| {
                this.child(
                    Button::new(SharedString::from(format!(
                        "overview-run-{}",
                        step.id.key()
                    )))
                    .ghost()
                    .small()
                    .label(step.action)
                    .on_click(cx.listener(move |this, _, window, cx| {
                        cx.stop_propagation();
                        this.run_step(id, window, cx);
                    })),
                )
            })
            .child(if row_state == StepState::Running {
                Spinner::new().small().into_any_element()
            } else {
                Icon::new(IconName::ChevronRight)
                    .size(px(16.))
                    .text_color(theme.muted_foreground)
                    .into_any_element()
            })
            .into_any_element()
    }

    /// Similar versions need a person; this card points at them, and starts checking if it
    /// waits.
    fn render_look_card(&mut self, data: &Tidy, cx: &mut Context<Self>) -> Option<AnyElement> {
        let state = self.state.read(cx);
        let similar = data.duplicates.similar;
        let analysis = data.analysis;
        let looking = analysis.fingerprinted < analysis.fingerprintable;
        let similar_job = state.analysis().is_some() || state.scan().is_some();
        let unchecked =
            !state.is_busy() && (looking || analysis.sound_measured < analysis.sound_measurable);
        if similar.sets == 0 && !looking && !unchecked {
            return None;
        }
        let sets_line = format!(
            "{} of similar versions",
            format::plural_as(similar.sets, "set", "sets")
        );
        let bytes_line = format!(
            "frees up to {}",
            format::bytes(similar.reclaimable_bytes as f64)
        );
        let (title, caption): (String, Option<String>) = if looking && similar_job {
            (
                format!(
                    "Still looking for similar versions · {} of {} checked",
                    format::count(analysis.fingerprinted),
                    format::count(analysis.fingerprintable)
                ),
                (similar.sets > 0).then(|| format!("{sets_line} so far · {bytes_line}")),
            )
        } else if similar.sets > 0 {
            (
                format!("{sets_line} · {bytes_line}"),
                unchecked.then(|| "Some files are not checked yet.".to_string()),
            )
        } else if looking {
            (
                "Not checked for similar versions yet".into(),
                Some(format!(
                    "{} of {} checked",
                    format::count(analysis.fingerprinted),
                    format::count(analysis.fingerprintable)
                )),
            )
        } else {
            (
                "Not checked for silent soundtracks yet".into(),
                Some(format!(
                    "{} of {} measured",
                    format::count(analysis.sound_measured),
                    format::count(analysis.sound_measurable)
                )),
            )
        };
        let keepers: Vec<_> = self
            .keepers
            .data()
            .map(|page| {
                page.sets
                    .iter()
                    .filter_map(|set| {
                        let files: Vec<_> =
                            set.versions.iter().flat_map(|v| v.files.iter()).collect();
                        files
                            .iter()
                            .find(|file| set.keep.contains(&file.id))
                            .or(files.first())
                            .map(|file| (*file).clone())
                    })
                    .collect()
            })
            .unwrap_or_default();
        let (radius, ground) = (cx.theme().radius, cx.theme().background);
        let stack: Vec<AnyElement> = keepers
            .iter()
            .enumerate()
            .map(|(index, file)| {
                div()
                    .size(px(48.))
                    .when(index > 0, |this| this.ml(px(-12.)))
                    .rounded(radius)
                    .overflow_hidden()
                    .border_2()
                    .border_color(ground)
                    .child(thumbs::picture(
                        &self.thumbs,
                        file,
                        96,
                        ObjectFit::Cover,
                        cx,
                    ))
                    .into_any_element()
            })
            .collect();
        let theme = cx.theme();
        Some(
            widgets::card(cx)
                .id("overview-similar")
                .test_support()
                .aria_label(SharedString::from(title.clone()))
                .flex_row()
                .items_center()
                .gap_4()
                .p_4()
                // The same leading tile as the identical copies' card, so both titles start on
                // one spine; the keepers' pictures sit before the actions.
                .child(widgets::row_icon(IconName::Images, cx))
                .child(
                    div()
                        .flex()
                        .flex_col()
                        .flex_1()
                        .min_w_0()
                        .child(
                            div()
                                .flex()
                                .flex_row()
                                .items_center()
                                .gap_2()
                                .text_size(px(13.))
                                .font_weight(FontWeight::MEDIUM)
                                .when(looking && similar_job, |this| {
                                    this.child(Spinner::new().small())
                                })
                                .child(title),
                        )
                        .when_some(caption, |this, caption| {
                            this.child(widgets::caption(caption, cx).mt_0p5())
                        }),
                )
                .when(!stack.is_empty(), |this| {
                    this.child(
                        div()
                            .flex()
                            .flex_row()
                            .flex_shrink_0()
                            .pl_3()
                            .children(stack),
                    )
                })
                .when(unchecked, |this| {
                    this.child(
                        Button::new("overview-check-now")
                            .outline()
                            .label("Check now")
                            .on_click(cx.listener(|this, _, window, cx| {
                                this.state.update(cx, |state, cx| {
                                    if let Some(root_id) = state.root_id() {
                                        state.start_analysis(root_id, window, cx);
                                    }
                                });
                            })),
                    )
                })
                .when(similar.sets > 0, |this| {
                    this.child(
                        Button::new("overview-review-similar")
                            .outline()
                            .label("Review")
                            .tooltip("Review  D")
                            .on_click(cx.listener(|this, _, _, cx| {
                                this.state.update(cx, |state, cx| {
                                    state.open_duplicates(DuplicateScope::Similar, cx);
                                });
                            })),
                    )
                })
                .text_color(theme.foreground)
                .into_any_element(),
        )
    }

    /// Identical copies wait for the owner like similar versions do: which copy to keep depends
    /// on where each one is, so Tidy up leaves them.
    fn render_identical_card(&self, data: &Tidy, cx: &mut Context<Self>) -> Option<AnyElement> {
        let exact = data.duplicates.exact;
        if exact.sets == 0 {
            return None;
        }
        let title = format!(
            "{} of identical copies · frees up to {}",
            format::plural(exact.sets, "set"),
            format::bytes(exact.reclaimable_bytes as f64)
        );
        Some(
            widgets::card(cx)
                .id("overview-identical")
                .test_support()
                .aria_label(SharedString::from(title.clone()))
                .flex_row()
                .items_center()
                .gap_4()
                .p_4()
                .child(widgets::row_icon(IconName::Copy, cx))
                .child(
                    div()
                        .flex()
                        .flex_col()
                        .flex_1()
                        .min_w_0()
                        .child(
                            div()
                                .text_size(px(13.))
                                .font_weight(FontWeight::MEDIUM)
                                .child(title),
                        )
                        .child(widgets::caption("Choose which folders keep each one", cx).mt_0p5()),
                )
                .child(
                    Button::new("overview-review-identical")
                        .outline()
                        .label("Review")
                        .on_click(cx.listener(|this, _, _, cx| {
                            this.state.update(cx, |state, cx| {
                                state.open_duplicates(DuplicateScope::Exact, cx);
                            });
                        })),
                )
                .into_any_element(),
        )
    }

    /// A row that opens a page: Shrink, or holding.
    fn link_row(
        &self,
        id: &'static str,
        icon: IconName,
        title: String,
        caption: String,
        page: TidyPage,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let theme = cx.theme();
        widgets::card(cx)
            .px_3()
            .py(px(6.))
            .child(
                div()
                    .id(id)
                    .test_support()
                    .role(Role::Button)
                    .aria_label(SharedString::from(title.clone()))
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap_3()
                    .h(px(52.))
                    .px_2()
                    .rounded(theme.radius)
                    .cursor_pointer()
                    .hover(|style| style.bg(theme.accent))
                    .on_click(cx.listener(move |this, _, _, cx| {
                        this.state.update(cx, |state, cx| state.go(page, cx));
                    }))
                    .child(widgets::row_icon(icon, cx))
                    .child(
                        div()
                            .flex()
                            .flex_col()
                            .flex_1()
                            .min_w_0()
                            .child(
                                div()
                                    .truncate()
                                    .text_size(px(13.))
                                    .font_weight(FontWeight::MEDIUM)
                                    .child(title),
                            )
                            .child(widgets::caption(caption, cx).truncate()),
                    )
                    .child(
                        Icon::new(IconName::ChevronRight)
                            .size(px(16.))
                            .text_color(theme.muted_foreground),
                    ),
            )
            .into_any_element()
    }

    fn render_attention(&self, data: &Tidy, cx: &mut Context<Self>) -> Option<AnyElement> {
        let findings: Vec<_> = data
            .attention
            .iter()
            .filter(|finding| finding.count > 0)
            .cloned()
            .collect();
        if findings.is_empty() {
            return None;
        }
        let theme = cx.theme();
        let mut line = div()
            .id("overview-attention")
            .flex()
            .flex_row()
            .flex_wrap()
            .items_center()
            .gap_1()
            .px_1()
            .text_xs()
            .text_color(theme.muted_foreground)
            .child("Also found:");
        for (index, finding) in findings.into_iter().enumerate() {
            let (label, preset) = attention(finding.kind, finding.count);
            if index > 0 {
                line = line.child("·");
            }
            line = line.child(
                Button::new(SharedString::from(format!(
                    "overview-finding-{}",
                    finding.kind
                )))
                .text()
                .xsmall()
                .label(label)
                .on_click(cx.listener(move |this, _, _, cx| {
                    let preset = preset.clone();
                    this.state
                        .update(cx, |state, cx| state.open_library(preset, cx));
                })),
            );
        }
        Some(line.into_any_element())
    }
}

/// What a scan finds that needs a look, and the Library filter that shows it (`ATTENTION`).
fn attention(kind: FindingKind, count: i64) -> (String, LibraryPreset) {
    let flags = |flag| LibraryPreset {
        flags: vec![flag],
        ..LibraryPreset::default()
    };
    let formats = |formats: &[FileFormat]| LibraryPreset {
        formats: formats.to_vec(),
        ..LibraryPreset::default()
    };
    match kind {
        FindingKind::Undecodable => (
            format!("{} won't open", format::plural(count, "file")),
            flags(FileFlag::Undecodable),
        ),
        FindingKind::ZeroByte => (
            format::plural(count, "empty file"),
            flags(FileFlag::ZeroByte),
        ),
        FindingKind::Unsupported => (
            format!("{} no Latch Works app shows", format::plural(count, "file")),
            flags(FileFlag::Unsupported),
        ),
        FindingKind::PresignedDelivery => (
            format!(
                "{} Pane serves without resizing (MKV, BMP)",
                format::count(count)
            ),
            formats(&[FileFormat::Matroska, FileFormat::Bmp]),
        ),
        FindingKind::UnconvertibleVideo => (
            format!("{} can't become MP4 (AVI, FLV, WMV)", format::count(count)),
            formats(&[FileFormat::Avi, FileFormat::Flv, FileFormat::Asf]),
        ),
    }
}

impl Focusable for OverviewPage {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}

impl Render for OverviewPage {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let top_bar = self.render_top_bar(cx);
        let state = self.state.read(cx);
        let root = state.root().cloned();
        let data = state.overview.data().cloned();
        let error = state.overview.error().cloned();
        let scanning = root.as_ref().is_some_and(|root| state.is_scanning(root.id));
        let never_scanned = root
            .as_ref()
            .is_some_and(|root| root.last_scan_at.is_none());
        let empty = data.as_ref().is_none_or(|data| data.files == 0);
        let first_scan = if scanning {
            never_scanned || empty
        } else {
            never_scanned && empty
        };

        let body: AnyElement = if first_scan {
            self.render_first_scan(cx)
        } else if let Some(data) = data {
            if data.files == 0 {
                widgets::empty_state(
                    "overview-empty",
                    Some(IconName::FolderOpen),
                    "This folder is empty",
                    None,
                    Vec::new(),
                    cx,
                )
                .into_any_element()
            } else {
                let hero = self.render_hero(&data, cx);
                let look = self.render_look_card(&data, cx);
                let identical = self.render_identical_card(&data, cx);
                let shrink = (data.shrink.files > 0).then(|| {
                    self.link_row(
                        "overview-shrink",
                        IconName::Shrink,
                        format!(
                            "Shrink videos with AV1 · about {} smaller",
                            format::bytes((data.shrink.bytes - data.shrink.estimated_bytes) as f64)
                        ),
                        format!(
                            "{} · {}, in runs you can stop at any time",
                            format::plural(data.shrink.files, "video"),
                            format::bytes(data.shrink.bytes as f64)
                        ),
                        TidyPage::Shrink,
                        cx,
                    )
                });
                let held = self
                    .state
                    .read(cx)
                    .holding
                    .data()
                    .filter(|held| held.total > 0)
                    .map(|held| (held.total, held.total_bytes));
                let holding = held.map(|(files, bytes)| {
                    self.link_row(
                        "overview-holding",
                        IconName::Archive,
                        format!(
                            "Holding · {} · {}",
                            format::plural(files, "file"),
                            format::bytes(bytes)
                        ),
                        "The space comes back when you empty it".into(),
                        TidyPage::Holding,
                        cx,
                    )
                });
                let attention = self.render_attention(&data, cx);
                div()
                    .id("overview-scroll")
                    .flex_1()
                    .min_h_0()
                    .overflow_y_scroll()
                    .child(
                        div()
                            .mx_auto()
                            .w_full()
                            .max_w(px(760.))
                            .flex()
                            .flex_col()
                            .gap_4()
                            .px_6()
                            .pt_6()
                            .pb(px(112.))
                            .child(hero)
                            .children(look)
                            .children(identical)
                            .children(shrink)
                            .children(holding)
                            .children(attention),
                    )
                    .into_any_element()
            }
        } else if let Some(error) = error {
            widgets::empty_state("overview-error", None, error, None, Vec::new(), cx)
                .into_any_element()
        } else {
            div().flex_1().into_any_element()
        };

        div()
            .id("overview")
            .track_focus(&self.focus)
            .key_context("TidyOverview")
            .on_key_down(cx.listener(Self::on_key_down))
            .flex()
            .flex_col()
            .size_full()
            .min_h_0()
            .child(top_bar)
            .child(body)
    }
}
