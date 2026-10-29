//! History (`views/HistoryView.tsx`): every change Tidy made to the folder, newest first, by
//! day, with what it did and its Undo. Duplicate decisions made one after another read as one
//! entry. An entry opens to list its steps; U undoes the entry in focus.

use std::collections::{HashMap, HashSet};
use std::rc::Rc;

use gpui_kit::assets::IconName;
use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::spinner::Spinner;
use gpui_kit::component::{ActiveTheme as _, Icon, Sizable as _};
use gpui_kit::{
    AnyElement, App, Context, Entity, FocusHandle, Focusable, FontWeight, InteractiveElement as _,
    IntoElement, KeyDownEvent, ParentElement as _, Render, SharedString,
    StatefulInteractiveElement as _, Styled as _, Subscription, TestSupportExt as _, Window, div,
    prelude::FluentBuilder as _, px,
};
use oriel_core_tidy::contract::RootId;
use oriel_ui::{Toast, TopBar};

use crate::actions::{PerformOptions, describe_plan};
use crate::changes::{
    PlanId, PlanKind, PlanListRequest, PlanStatus, PlanStep, PlanStepPage, PlanStepsRequest,
    PlanSummary, StepStatus, can_undo,
};
use crate::format;
use crate::loaded::Loaded;
use crate::pages::TidyPage;
use crate::state::TidyState;
use crate::widgets;

const PAGE: usize = 200;

/// Duplicate decisions made within this long of each other read as one session.
const SESSION_GAP_MS: f64 = 10. * 60_000.;

/// Steps listed when an entry opens.
const STEP_LIMIT: usize = 100;

/// One row of the log: a plan, or a run of duplicate decisions made in one sitting.
struct Entry {
    key: String,
    /// Newest first.
    plans: Vec<PlanSummary>,
}

fn group_plans(plans: &[PlanSummary]) -> Vec<Entry> {
    let mut entries: Vec<Entry> = Vec::new();
    for plan in plans {
        if let Some(previous) = entries.last_mut()
            && let Some(last) = previous.plans.last()
            && plan.kind == PlanKind::ResolveDuplicates
            && last.kind == PlanKind::ResolveDuplicates
            && ((last.created_at - plan.created_at) as f64) < SESSION_GAP_MS
            && can_undo(last) == can_undo(plan)
        {
            previous.plans.push(plan.clone());
            continue;
        }
        entries.push(Entry {
            key: plan.id.to_string(),
            plans: vec![plan.clone()],
        });
    }
    entries
}

fn entry_title(entry: &Entry) -> String {
    match entry.plans.as_slice() {
        [] => String::new(),
        [only] => only.title.clone(),
        plans => format!(
            "Resolved {}",
            format::plural(plans.iter().map(|plan| plan.count).sum(), "duplicate set")
        ),
    }
}

fn entry_detail(entry: &Entry) -> String {
    if let [only] = entry.plans.as_slice() {
        return describe_plan(only);
    }
    if entry
        .plans
        .iter()
        .all(|plan| plan.status == PlanStatus::Undone)
    {
        return "undone".into();
    }
    let (files, bytes) = entry.plans.iter().fold((0, 0), |(files, bytes), plan| {
        (files + plan.held.files, bytes + plan.held.bytes)
    });
    if files > 0 {
        format!(
            "{} to holding · {}",
            format::plural(files, "file"),
            format::bytes(bytes as f64)
        )
    } else {
        String::new()
    }
}

fn status_label(status: PlanStatus) -> Option<&'static str> {
    match status {
        PlanStatus::Draft => Some("Draft"),
        PlanStatus::Applying => Some("Running"),
        PlanStatus::Partial => Some("Partly done"),
        PlanStatus::Failed => Some("Failed"),
        PlanStatus::Cancelled => Some("Stopped"),
        PlanStatus::Applied | PlanStatus::Undone => None,
    }
}

pub struct HistoryPage {
    state: Entity<TidyState>,
    focus: FocusHandle,
    plans: Loaded<Vec<PlanSummary>>,
    wanted: usize,
    expanded: HashSet<String>,
    steps: HashMap<PlanId, PlanStepPage>,
    focused: Option<String>,
    seen: (Option<RootId>, u64),
    _subscriptions: Vec<Subscription>,
}

impl HistoryPage {
    pub fn new(state: &Entity<TidyState>, cx: &mut Context<Self>) -> Self {
        let subscriptions = vec![cx.observe(state, |this, _, cx| this.sync(cx))];
        Self {
            state: state.clone(),
            focus: cx.focus_handle(),
            plans: Loaded::default(),
            wanted: PAGE,
            expanded: HashSet::new(),
            steps: HashMap::new(),
            focused: None,
            seen: (None, 0),
            _subscriptions: subscriptions,
        }
    }

    fn sync(&mut self, cx: &mut Context<Self>) {
        let state = self.state.read(cx);
        let key = (state.root_id(), state.catalog_version());
        if state.page() != TidyPage::History || key == self.seen {
            cx.notify();
            return;
        }
        self.seen = key;
        self.reload(cx);
    }

    fn reload(&mut self, cx: &mut Context<Self>) {
        let state = self.state.read(cx);
        let Some(root_id) = state.root_id() else {
            return;
        };
        let Some(engine) = state.engine().cloned() else {
            return;
        };
        let request = PlanListRequest {
            root_id: Some(root_id),
            offset: 0,
            limit: self.wanted as i64,
        };
        let plans = state.changes.list_plans(&engine, request);
        self.plans.load(plans, |this| &mut this.plans, cx);
        self.steps.clear();
        cx.notify();
    }

    fn toggle(&mut self, entry: &Entry, cx: &mut Context<Self>) {
        if !self.expanded.remove(&entry.key) {
            self.expanded.insert(entry.key.clone());
            let changes = self.state.read(cx).changes.clone();
            let Some(engine) = self.state.read(cx).engine().cloned() else {
                return;
            };
            for plan in &entry.plans {
                let id = plan.id;
                let request = PlanStepsRequest {
                    plan_id: id,
                    offset: 0,
                    limit: STEP_LIMIT as i64,
                };
                let steps = changes.plan_steps(&engine, request);
                cx.spawn(async move |this, cx| {
                    let steps = steps.await;
                    this.update(cx, |this, cx| {
                        if let Ok(steps) = steps {
                            this.steps.insert(id, steps);
                        }
                        cx.notify();
                    })
                    .ok();
                })
                .detach();
            }
        }
        self.focused = Some(entry.key.clone());
        cx.notify();
    }

    fn undo(&mut self, entry: &Entry, window: &mut Window, cx: &mut Context<Self>) {
        let undoable: Vec<PlanSummary> = entry
            .plans
            .iter()
            .filter(|plan| can_undo(plan))
            .cloned()
            .collect();
        match undoable.as_slice() {
            [] => {}
            [only] => {
                let only = only.clone();
                self.state.update(cx, |state, cx| {
                    state.undo_plan(only, PerformOptions::default(), window, cx);
                });
            }
            _ => {
                // Newest first, one after another, as ⌘Z would take them back.
                let title = entry_title(entry);
                crate::widgets::show_toast(
                    window,
                    Toast::info(format!("Undoing “{title}”"))
                        .detail(format!("{} changes, newest first", undoable.len())),
                    cx,
                );
                if let Some(first) = undoable.first().cloned() {
                    self.state.update(cx, |state, cx| {
                        state.undo_plan(first, PerformOptions::default(), window, cx);
                    });
                }
            }
        }
    }

    fn on_key_down(&mut self, event: &KeyDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        let keys = &event.keystroke;
        if keys.modifiers.modified() {
            return;
        }
        let entries = self
            .plans
            .data()
            .map(|plans| group_plans(plans))
            .unwrap_or_default();
        let at = self
            .focused
            .as_ref()
            .and_then(|key| entries.iter().position(|entry| &entry.key == key));
        match keys.key.as_str() {
            "down" | "up" if !entries.is_empty() => {
                let next = match (at, keys.key.as_str()) {
                    (None, "down") => 0,
                    (None, _) => entries.len() - 1,
                    (Some(at), "down") => (at + 1).min(entries.len() - 1),
                    (Some(at), _) => at.saturating_sub(1),
                };
                self.focused = Some(entries[next].key.clone());
                cx.notify();
            }
            "right" | "left" => {
                if let Some(entry) = at.and_then(|at| entries.get(at)) {
                    let open = self.expanded.contains(&entry.key);
                    if open == (keys.key == "left") {
                        self.toggle(entry, cx);
                    }
                }
            }
            "u" => {
                if let Some(entry) = at.and_then(|at| entries.get(at)) {
                    self.undo(entry, window, cx);
                }
            }
            _ => return,
        }
        cx.stop_propagation();
    }

    fn render_steps(&self, entry: &Entry, cx: &App) -> AnyElement {
        let theme = cx.theme();
        let steps: Vec<PlanStep> = entry
            .plans
            .iter()
            .filter_map(|plan| self.steps.get(&plan.id))
            .flat_map(|page| page.steps.iter().cloned())
            .collect();
        if steps.is_empty() {
            return div()
                .px_4()
                .py_2()
                .child(Spinner::new().small())
                .into_any_element();
        }
        div()
            .flex()
            .flex_col()
            .px_4()
            .pb_3()
            .children(steps.into_iter().map(|step| {
                let to = step.to_path.clone().unwrap_or_default();
                div()
                    .flex()
                    .flex_row()
                    .gap_2()
                    .h(px(28.))
                    .items_center()
                    .text_xs()
                    .child(
                        div()
                            .w(px(64.))
                            .flex_shrink_0()
                            .text_color(match step.status {
                                StepStatus::Failed => theme.danger,
                                StepStatus::Skipped | StepStatus::Undone => theme.muted_foreground,
                                _ => theme.foreground,
                            })
                            .child(format!("{:?}", step.status)),
                    )
                    .child(div().flex_1().min_w_0().truncate().child(if to.is_empty() {
                        step.from_path.clone()
                    } else {
                        format!("{} → {to}", step.from_path)
                    }))
            }))
            .into_any_element()
    }
}

impl Focusable for HistoryPage {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}

impl Render for HistoryPage {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let shell = self.state.read(cx).shell.clone();
        let now = format::now_ms();
        let body: AnyElement = match (self.plans.data(), self.plans.error()) {
            (None, Some(error)) => widgets::empty_state(
                "history-error",
                Some(IconName::RotateCcw),
                error.clone(),
                None,
                Vec::new(),
                cx,
            )
            .into_any_element(),
            (None, None) => div().flex_1().into_any_element(),
            (Some(plans), _) if plans.is_empty() => widgets::empty_state(
                "history-empty",
                Some(IconName::RotateCcw),
                "No changes yet",
                Some("What Tidy changes shows here, with its Undo.".into_any_element()),
                Vec::new(),
                cx,
            )
            .into_any_element(),
            (Some(plans), _) => {
                let entries = group_plans(plans);
                let has_more = plans.len() == self.wanted;
                let newest_undoable = entries
                    .iter()
                    .find(|entry| entry.plans.iter().any(can_undo))
                    .map(|entry| entry.key.clone());
                let mut days: Vec<(String, Vec<Entry>)> = Vec::new();
                for entry in entries {
                    let label =
                        format::day(entry.plans.first().map_or(0, |plan| plan.created_at), now);
                    match days.last_mut() {
                        Some((last, list)) if *last == label => list.push(entry),
                        _ => days.push((label, vec![entry])),
                    }
                }
                let theme = cx.theme();
                let (border, muted, accent) = (theme.border, theme.muted_foreground, theme.accent);
                let mut sections = Vec::new();
                for (label, entries) in days {
                    let mut rows = Vec::new();
                    for (index, entry) in entries.into_iter().enumerate() {
                        let open = self.expanded.contains(&entry.key);
                        let focused = self.focused.as_ref() == Some(&entry.key);
                        let first = entry.plans.first().cloned();
                        let undoable = entry.plans.iter().any(can_undo);
                        let status = first.as_ref().and_then(|plan| status_label(plan.status));
                        let title = entry_title(&entry);
                        let detail = entry_detail(&entry);
                        let time = first
                            .as_ref()
                            .map(|plan| format::time(plan.created_at))
                            .unwrap_or_default();
                        let steps = open.then(|| self.render_steps(&entry, cx));
                        let key = entry.key.clone();
                        let entry = Rc::new(entry);
                        let (toggle_entry, undo_entry) = (entry.clone(), entry.clone());
                        rows.push(
                            div()
                                .flex()
                                .flex_col()
                                .when(index > 0, |this| this.border_t_1().border_color(border))
                                .child(
                                    div()
                                        .id(SharedString::from(format!("history-{key}")))
                                        .test_support()
                                        .aria_label(SharedString::from(title.clone()))
                                        .flex()
                                        .flex_row()
                                        .items_center()
                                        .gap_3()
                                        .min_h(px(52.))
                                        .px_4()
                                        .cursor_pointer()
                                        .when(focused, |this| this.bg(accent))
                                        .hover(|style| style.bg(accent))
                                        .on_click(cx.listener(move |this, _, _, cx| {
                                            this.toggle(&toggle_entry, cx);
                                        }))
                                        .child(
                                            Icon::new(if open {
                                                IconName::ChevronDown
                                            } else {
                                                IconName::ChevronRight
                                            })
                                            .size(px(14.))
                                            .text_color(muted),
                                        )
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
                                                .child(widgets::caption(
                                                    [
                                                        Some(time),
                                                        status.map(String::from),
                                                        (!detail.is_empty()).then_some(detail),
                                                    ]
                                                    .into_iter()
                                                    .flatten()
                                                    .collect::<Vec<_>>()
                                                    .join(" · "),
                                                    cx,
                                                )),
                                        )
                                        .when(undoable, |this| {
                                            let newest = newest_undoable.as_ref() == Some(&key);
                                            this.child(
                                                Button::new(SharedString::from(format!(
                                                    "history-undo-{key}"
                                                )))
                                                .map(|button| {
                                                    if newest {
                                                        button.outline()
                                                    } else {
                                                        button.ghost()
                                                    }
                                                })
                                                .small()
                                                .label("Undo")
                                                .tooltip("Undo  U")
                                                .on_click(cx.listener(
                                                    move |this, _, window, cx| {
                                                        cx.stop_propagation();
                                                        this.undo(&undo_entry, window, cx);
                                                    },
                                                )),
                                            )
                                        }),
                                )
                                .children(steps)
                                .into_any_element(),
                        );
                    }
                    sections.push(
                        div()
                            .flex()
                            .flex_col()
                            .child(
                                div()
                                    .h(px(36.))
                                    .flex()
                                    .items_center()
                                    .text_xs()
                                    .font_weight(FontWeight::MEDIUM)
                                    .text_color(muted)
                                    .child(label),
                            )
                            .child(widgets::card(cx).overflow_hidden().children(rows))
                            .into_any_element(),
                    );
                }
                div()
                    .id("history-scroll")
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
                            .gap_2()
                            .px_6()
                            .pt_4()
                            .pb(px(112.))
                            .children(sections)
                            .when(has_more, |this| {
                                this.child(
                                    Button::new("history-more")
                                        .outline()
                                        .small()
                                        .label("Show earlier changes")
                                        .on_click(cx.listener(|this, _, _, cx| {
                                            this.wanted += PAGE;
                                            this.reload(cx);
                                        })),
                                )
                            }),
                    )
                    .into_any_element()
            }
        };
        div()
            .id("history")
            .track_focus(&self.focus)
            .key_context("TidyHistory")
            .on_key_down(cx.listener(Self::on_key_down))
            .flex()
            .flex_col()
            .size_full()
            .min_h_0()
            .child(TopBar::new(&shell, "History"))
            .child(body)
    }
}
