//! History (`views/HistoryView.tsx`): every change Tidy made to the folder, newest first, by
//! day, with what it did and its Undo. Duplicate decisions made one after another read as one
//! entry. An entry opens to list its steps; U undoes the entry in focus.
//!
//! The log is drawn a screen at a time ([`crate::windowed`]): a day's heading, each entry, and
//! the button for earlier changes are items of one column, each entry drawing its part of its
//! day's card.

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
use crate::windowed::{Piece, Windowed};

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

/// One item of the log's column.
enum Item {
    /// A day's heading, over the day's card; `at` is when its newest entry was made.
    Day { first: bool, at: i64 },
    /// An entry, the `index`th of its day's card.
    Entry {
        entry: Rc<Entry>,
        index: usize,
        last: bool,
    },
    /// The button that shows earlier changes, while the last answer filled the page asked for.
    More,
}

/// What an item's height follows: an entry's grows as it opens and its steps come in.
#[derive(Clone, PartialEq, Eq, Hash)]
enum ItemKey {
    Day(bool),
    Entry {
        key: String,
        first: bool,
        last: bool,
        open: bool,
        steps: usize,
    },
    More,
}

/// The log as read: its entries, and the column's items, made once per answer.
struct Log {
    entries: Vec<Rc<Entry>>,
    items: Vec<Item>,
    newest_undoable: Option<String>,
}

impl Log {
    fn of(plans: &[PlanSummary]) -> Self {
        let entries: Vec<Rc<Entry>> = group_plans(plans).into_iter().map(Rc::new).collect();
        let newest_undoable = entries
            .iter()
            .find(|entry| entry.plans.iter().any(can_undo))
            .map(|entry| entry.key.clone());
        // A day's entries in a card under its heading. Days are told apart by their date, as
        // their headings are ("Today", "Yesterday", the date).
        let mut items = Vec::new();
        let mut day: Option<String> = None;
        let mut card: Vec<Rc<Entry>> = Vec::new();
        let flush = |items: &mut Vec<Item>, card: &mut Vec<Rc<Entry>>| {
            let count = card.len();
            for (index, entry) in card.drain(..).enumerate() {
                items.push(Item::Entry {
                    entry,
                    index,
                    last: index + 1 == count,
                });
            }
        };
        for entry in &entries {
            let at = entry.plans.first().map_or(0, |plan| plan.created_at);
            let date = format::date(at);
            if day.as_ref() != Some(&date) {
                flush(&mut items, &mut card);
                items.push(Item::Day {
                    first: day.is_none(),
                    at,
                });
                day = Some(date);
            }
            card.push(entry.clone());
        }
        flush(&mut items, &mut card);
        Self {
            entries,
            items,
            newest_undoable,
        }
    }
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
    /// The answer as the log shows it.
    log: Option<Rc<Log>>,
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
            log: None,
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
        self.plans
            .load_then(plans, |this| &mut this.plans, Self::loaded, cx);
        self.steps.clear();
        cx.notify();
    }

    fn loaded(&mut self, _: &mut Context<Self>) {
        self.log = self.plans.data().map(|plans| Rc::new(Log::of(plans)));
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
            .log
            .as_ref()
            .map(|log| log.entries.clone())
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

impl HistoryPage {
    /// The log: only the items on screen are drawn, in a column that scrolls as if all were.
    fn render_log(
        &mut self,
        has_more: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let Some(log) = self.log.clone() else {
            return div().flex_1().into_any_element();
        };
        let more = has_more.then_some(&Item::More);
        let items: Vec<&Item> = log.items.iter().chain(more).collect();
        let keys: Vec<ItemKey> = items
            .iter()
            .map(|item| match item {
                Item::Day { first, .. } => ItemKey::Day(*first),
                Item::Entry { entry, index, last } => {
                    let open = self.expanded.contains(&entry.key);
                    ItemKey::Entry {
                        key: entry.key.clone(),
                        first: *index == 0,
                        last: *last,
                        open,
                        steps: if open { self.step_count(entry) } else { 0 },
                    }
                }
                Item::More => ItemKey::More,
            })
            .collect();
        // The column's own scroll lives as long as it is drawn frame after frame, as the
        // scrolling element's would: History shown again starts at the top.
        let column = window.use_keyed_state("history-column", cx, |_, _| Windowed::default());
        // The space above the first day, a rem (`pt_4`).
        let before = f32::from(window.rem_size());
        let (pieces, _) = column.update(cx, |column, _| {
            column.plan(&keys, |index| guess(&keys[index]), before, 0., window)
        });
        let scroll = column.read(cx).scroll().clone();
        let now = format::now_ms();
        let children: Vec<AnyElement> = pieces
            .into_iter()
            .map(|piece| match piece {
                Piece::Room(height) => Piece::room(height),
                Piece::Item(index) => match &items[index] {
                    Item::Day { first, at } => div()
                        .mx_auto()
                        .w_full()
                        .max_w(px(760.))
                        .px_6()
                        .when(!*first, |this| this.pt_2())
                        .child(
                            div()
                                .h(px(36.))
                                .flex()
                                .items_center()
                                .text_xs()
                                .font_weight(FontWeight::MEDIUM)
                                .text_color(cx.theme().muted_foreground)
                                .child(format::day(*at, now)),
                        )
                        .into_any_element(),
                    Item::Entry { entry, index, last } => {
                        self.render_entry(entry, *index, *last, &log, cx)
                    }
                    Item::More => div()
                        .mx_auto()
                        .w_full()
                        .max_w(px(760.))
                        .px_6()
                        .pt_2()
                        .child(
                            Button::new("history-more")
                                .outline()
                                .small()
                                .label("Show earlier changes")
                                .on_click(cx.listener(|this, _, _, cx| {
                                    this.wanted += PAGE;
                                    this.reload(cx);
                                })),
                        )
                        .into_any_element(),
                },
            })
            .collect();
        div()
            .id("history-scroll")
            .flex_1()
            .min_h_0()
            .overflow_y_scroll()
            .track_scroll(&scroll)
            .pt_4()
            .pb(px(112.))
            .children(children)
            .into_any_element()
    }

    /// The steps listed under an open entry, once read.
    fn step_count(&self, entry: &Entry) -> usize {
        entry
            .plans
            .iter()
            .filter_map(|plan| self.steps.get(&plan.id))
            .map(|page| page.steps.len())
            .sum()
    }

    /// An entry, as its part of its day's card: the card's top edge over its first entry, its
    /// bottom edge under its last, and a rule between entries.
    fn render_entry(
        &self,
        entry: &Rc<Entry>,
        index: usize,
        last: bool,
        log: &Log,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let theme = cx.theme();
        let (border, muted, accent, card, radius) = (
            theme.border,
            theme.muted_foreground,
            theme.accent,
            theme.group_box,
            theme.radius_lg,
        );
        let open = self.expanded.contains(&entry.key);
        let focused = self.focused.as_ref() == Some(&entry.key);
        let first = entry.plans.first().cloned();
        let undoable = entry.plans.iter().any(can_undo);
        let status = first.as_ref().and_then(|plan| status_label(plan.status));
        let title = entry_title(entry);
        let detail = entry_detail(entry);
        let time = first
            .as_ref()
            .map(|plan| format::time(plan.created_at))
            .unwrap_or_default();
        let steps = open.then(|| self.render_steps(entry, cx));
        let key = entry.key.clone();
        let newest = log.newest_undoable.as_ref() == Some(&key);
        let (toggle_entry, undo_entry) = (entry.clone(), entry.clone());
        let row = div()
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
                        this.child(
                            Button::new(SharedString::from(format!("history-undo-{key}")))
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
                                .on_click(cx.listener(move |this, _, window, cx| {
                                    cx.stop_propagation();
                                    this.undo(&undo_entry, window, cx);
                                })),
                        )
                    }),
            )
            .children(steps);
        div()
            .mx_auto()
            .w_full()
            .max_w(px(760.))
            .px_6()
            .child(
                div()
                    .flex()
                    .flex_col()
                    .bg(card)
                    .border_color(border)
                    .border_l_1()
                    .border_r_1()
                    .when(index == 0, |this| this.border_t_1().rounded_t(radius))
                    .when(last, |this| this.border_b_1().rounded_b(radius))
                    .overflow_hidden()
                    .child(row),
            )
            .into_any_element()
    }
}

/// An item's height until it has been drawn: a heading, an entry closed, or the button.
fn guess(key: &ItemKey) -> f32 {
    match key {
        ItemKey::Day(true) => 36.,
        ItemKey::Day(false) => 44.,
        ItemKey::Entry { last, steps, .. } => {
            53. + f32::from(u8::from(*last)) + 28. * *steps as f32
        }
        ItemKey::More => 40.,
    }
}

impl Focusable for HistoryPage {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}

impl Render for HistoryPage {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let shell = self.state.read(cx).shell.clone();
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
                let has_more = plans.len() == self.wanted;
                self.render_log(has_more, window, cx)
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
