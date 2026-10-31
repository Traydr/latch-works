//! History (`views/HistoryView.tsx`): every change Tidy made to the folder, newest first, by
//! day, with what it did and its Undo. Duplicate decisions made one after another read as one
//! entry, which opens to list its sets, each with a picture of what stayed and its own Undo
//! (`ResolveSets`); any other entry opens to list its first steps, and all of them on asking
//! (`PlanSteps`). U undoes the entry in focus, all of its changes at once.
//!
//! The log is drawn a screen at a time ([`crate::windowed`]): a day's heading, each entry, and
//! the button for earlier changes are items of one column, each entry drawing its part of its
//! day's card.

use std::collections::{HashMap, HashSet};
use std::rc::Rc;

use gpui_kit::assets::IconName;
use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::spinner::Spinner;
use gpui_kit::component::{ActiveTheme as _, Disableable as _, Icon, Sizable as _};
use gpui_kit::{
    AnyElement, App, Context, Entity, FocusHandle, Focusable, FontWeight, InteractiveElement as _,
    IntoElement, KeyDownEvent, ParentElement as _, Render, SharedString,
    StatefulInteractiveElement as _, Styled as _, StyledImage as _, Subscription,
    TestSupportExt as _, Window, div, prelude::FluentBuilder as _, px,
};
use oriel_core_tidy::contract::RootId;
use oriel_ui::TopBar;

use crate::actions::{PerformOptions, describe_plan};
use crate::changes::{
    HoldingItem, HoldingRequest, PlanId, PlanKind, PlanListRequest, PlanStatus, PlanStepAction,
    PlanStepPage, PlanStepsRequest, PlanSummary, StepStatus, can_undo,
};
use crate::format;
use crate::loaded::Loaded;
use crate::pages::TidyPage;
use crate::state::TidyState;
use crate::thumbs::{Thumb, Thumbs};
use crate::widgets;
use crate::windowed::{Piece, Windowed};

const PAGE: usize = 200;

/// Duplicate decisions made within this long of each other read as one session.
const SESSION_GAP_MS: f64 = 10. * 60_000.;

/// Steps an entry lists when it opens, before "Show all".
const PREVIEW_STEPS: usize = 8;

/// Steps read at a time once all are asked for.
const STEP_PAGE: usize = 500;

/// Held files read to find what each set of a run of duplicate decisions kept.
const HELD_LIMIT: i64 = 500;

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

/// What a step did, in its row's first column (`ACTION_LABELS`).
fn action_label(action: PlanStepAction) -> &'static str {
    match action {
        PlanStepAction::Hold => "To holding",
        PlanStepAction::Move => "Moved",
        PlanStepAction::Rename => "Renamed",
        PlanStepAction::ConvertAvif => "To AVIF",
        PlanStepAction::ConvertAnimation | PlanStepAction::ConvertVideo => "To MP4",
        PlanStepAction::RemoveFolder => "Folder removed",
    }
}

/// How a step ended, where it is not simply done (`STEP_STATUS`).
fn step_status(status: StepStatus) -> Option<&'static str> {
    match status {
        StepStatus::Pending => Some("Not run"),
        StepStatus::Done => None,
        StepStatus::Skipped => Some("Skipped"),
        StepStatus::Failed => Some("Failed"),
        StepStatus::Undone => Some("Undone"),
    }
}

/// `path` inside the root, or as it is when it lies elsewhere (`relativeTo`).
fn relative_to(root: &str, path: &str) -> String {
    path.strip_prefix(root)
        .filter(|rest| rest.starts_with(['/', '\\']))
        .map(|rest| rest.trim_start_matches(['/', '\\']).to_string())
        .unwrap_or_else(|| path.to_string())
}

fn file_name(path: &str) -> &str {
    path.rsplit(['/', '\\']).next().unwrap_or(path)
}

fn folder_of(rel_path: &str) -> &str {
    rel_path
        .rfind(['/', '\\'])
        .map_or("", |cut| &rel_path[..cut])
}

/// The path a duplicate's hold reason names as the copy that stayed: "Duplicate of a/b.jpg".
fn keeper_of(reason: &str) -> Option<&str> {
    reason.strip_prefix("Duplicate of ")
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
    thumbs: Entity<Thumbs>,
    focus: FocusHandle,
    plans: Loaded<Vec<PlanSummary>>,
    /// The answer as the log shows it.
    log: Option<Rc<Log>>,
    wanted: usize,
    expanded: HashSet<String>,
    steps: HashMap<PlanId, PlanStepPage>,
    /// How many steps each plan whose steps were all asked for lists, a page at a time.
    showing: HashMap<PlanId, usize>,
    /// The first held file of each plan, which names the copy a duplicate decision kept.
    held: HashMap<PlanId, HoldingItem>,
    /// Entries and sets being undone, whose Undo waits.
    undoing: HashSet<String>,
    focused: Option<String>,
    seen: (Option<RootId>, u64),
    _subscriptions: Vec<Subscription>,
}

impl HistoryPage {
    pub fn new(state: &Entity<TidyState>, thumbs: &Entity<Thumbs>, cx: &mut Context<Self>) -> Self {
        let subscriptions = vec![
            cx.observe(state, |this, _, cx| this.sync(cx)),
            cx.observe(thumbs, |_, _, cx| cx.notify()),
        ];
        Self {
            state: state.clone(),
            thumbs: thumbs.clone(),
            focus: cx.focus_handle(),
            plans: Loaded::default(),
            log: None,
            wanted: PAGE,
            expanded: HashSet::new(),
            steps: HashMap::new(),
            showing: HashMap::new(),
            held: HashMap::new(),
            undoing: HashSet::new(),
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
        self.held.clear();
        // What was being undone has been: the catalog changed, which is why this reads again.
        self.undoing.clear();
        cx.notify();
    }

    fn loaded(&mut self, cx: &mut Context<Self>) {
        self.log = self.plans.data().map(|plans| Rc::new(Log::of(plans)));
        // The entries open before the answer came read their steps again, as they now are.
        let open: Vec<Rc<Entry>> = self
            .log
            .as_ref()
            .map(|log| {
                log.entries
                    .iter()
                    .filter(|entry| self.expanded.contains(&entry.key))
                    .cloned()
                    .collect()
            })
            .unwrap_or_default();
        for entry in open {
            self.read_steps(&entry, cx);
        }
    }

    /// Reads what an open entry lists: a set's first step each, and what each set held, for a
    /// run of duplicate decisions; the first steps, or as many as were asked for, for a change.
    fn read_steps(&mut self, entry: &Entry, cx: &mut Context<Self>) {
        let state = self.state.read(cx);
        let changes = state.changes.clone();
        let (Some(engine), Some(root_id)) = (state.engine().cloned(), state.root_id()) else {
            return;
        };
        let sets = entry.plans.len() > 1;
        if sets {
            let held = changes.list_holding(
                &engine,
                HoldingRequest {
                    root_id,
                    offset: 0,
                    limit: HELD_LIMIT,
                },
            );
            cx.spawn(async move |this, cx| {
                let held = held.await;
                this.update(cx, |this, cx| {
                    if let Ok(held) = held {
                        for item in held.items {
                            if let Some(plan_id) = item.plan_id {
                                this.held.entry(plan_id).or_insert(item);
                            }
                        }
                    }
                    cx.notify();
                })
                .ok();
            })
            .detach();
        }
        for plan in &entry.plans {
            let id = plan.id;
            let limit = if sets {
                1
            } else {
                self.showing.get(&id).copied().unwrap_or(PREVIEW_STEPS)
            };
            let request = PlanStepsRequest {
                plan_id: id,
                offset: 0,
                limit: limit as i64,
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

    /// "Show all": every step of the plan, a page at a time.
    fn show_more_steps(&mut self, entry: &Entry, cx: &mut Context<Self>) {
        if let Some(plan) = entry.plans.first() {
            let showing = self.showing.get(&plan.id).copied().unwrap_or(0);
            self.showing
                .insert(plan.id, showing.max(PREVIEW_STEPS) + STEP_PAGE);
            self.read_steps(entry, cx);
        }
    }

    fn toggle(&mut self, entry: &Entry, cx: &mut Context<Self>) {
        if !self.expanded.remove(&entry.key) {
            self.expanded.insert(entry.key.clone());
            self.read_steps(entry, cx);
        }
        self.focused = Some(entry.key.clone());
        cx.notify();
    }

    /// Undoes every change of the entry that can be, newest first as ⌘Z would take them back,
    /// with one toast for them all (`undoEntry`).
    fn undo(&mut self, entry: &Entry, window: &mut Window, cx: &mut Context<Self>) {
        let undoable: Vec<PlanSummary> = entry
            .plans
            .iter()
            .filter(|plan| can_undo(plan))
            .cloned()
            .collect();
        if undoable.is_empty() || !self.undoing.insert(entry.key.clone()) {
            return;
        }
        match undoable.as_slice() {
            [only] => {
                let only = only.clone();
                self.state.update(cx, |state, cx| {
                    state.undo_plan(only, PerformOptions::default(), window, cx);
                });
            }
            _ => {
                let title = entry_title(entry);
                // Oldest first, as `undo_all` takes them back from the end.
                let plans: Vec<PlanSummary> = undoable.into_iter().rev().collect();
                self.state.update(cx, |state, cx| {
                    state.undo_all(plans, title, window, cx);
                });
            }
        }
        cx.notify();
    }

    /// Undoes one set of a run of duplicate decisions (`undoOne`).
    fn undo_set(&mut self, plan: PlanSummary, window: &mut Window, cx: &mut Context<Self>) {
        if !self.undoing.insert(plan.id.to_string()) {
            return;
        }
        self.state.update(cx, |state, cx| {
            state.undo_plan(plan, PerformOptions::default(), window, cx);
        });
        cx.notify();
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

    /// What an open entry lists under it: its sets, for a run of duplicate decisions, or its
    /// steps.
    fn render_steps(&self, entry: &Rc<Entry>, cx: &mut Context<Self>) -> AnyElement {
        if entry.plans.len() > 1 {
            return self.render_sets(entry, cx);
        }
        let Some(plan) = entry.plans.first() else {
            return div().into_any_element();
        };
        let Some(page) = self.steps.get(&plan.id) else {
            return div()
                .h(px(36.))
                .pl(px(60.))
                .flex()
                .items_center()
                .child(Spinner::new().small())
                .into_any_element();
        };
        let root = self.root_path(cx);
        let theme = cx.theme();
        let (border, muted, warning) = (theme.border, theme.muted_foreground, theme.warning);
        let rows = page.steps.iter().map(|step| {
            let status = step_status(step.status);
            let target = step
                .to_path
                .as_deref()
                .filter(|_| step.action != PlanStepAction::Hold)
                .map(|to| (file_name(to).to_string(), to.to_string()));
            div()
                .id(("history-step", step.id as u64))
                .flex()
                .flex_row()
                .items_center()
                .gap_3()
                .h(px(36.))
                .pl(px(60.))
                .pr_4()
                .border_t_1()
                .border_color(border)
                .text_size(px(13.))
                .child(
                    div()
                        .w(px(96.))
                        .flex_shrink_0()
                        .text_xs()
                        .text_color(muted)
                        .child(action_label(step.action)),
                )
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .overflow_hidden()
                        .whitespace_nowrap()
                        .text_ellipsis_start()
                        .child(relative_to(&root, &step.from_path)),
                )
                .children(target.map(|(name, full)| {
                    div()
                        .id(("history-step-target", step.id as u64))
                        .max_w(gpui_kit::relative(0.35))
                        .flex_shrink_0()
                        .truncate()
                        .text_xs()
                        .text_color(muted)
                        .tooltip(move |window, cx| {
                            gpui_kit::component::tooltip::Tooltip::new(full.clone())
                                .build(window, cx)
                        })
                        .child(format!("→ {name}"))
                }))
                .children(status.map(|status| {
                    let message = step.message.clone();
                    div()
                        .id(("history-step-status", step.id as u64))
                        .flex_shrink_0()
                        .text_xs()
                        .text_color(match step.status {
                            StepStatus::Failed | StepStatus::Skipped => warning,
                            _ => muted,
                        })
                        .when_some(message, |this, message| {
                            this.tooltip(move |window, cx| {
                                gpui_kit::component::tooltip::Tooltip::new(message.clone())
                                    .build(window, cx)
                            })
                        })
                        .child(status)
                }))
                .into_any_element()
        });
        let listed = page.steps.len() as i64;
        let more = (page.total > listed).then(|| {
            let entry = entry.clone();
            let label = if self.showing.contains_key(&plan.id) {
                "Show more".to_string()
            } else {
                format!("Show all {}", format::count(page.total))
            };
            div()
                .h(px(36.))
                .pl(px(52.))
                .flex()
                .items_center()
                .border_t_1()
                .border_color(border)
                .child(
                    Button::new(SharedString::from(format!("history-show-all-{}", plan.id)))
                        .ghost()
                        .small()
                        .label(label)
                        .on_click(cx.listener(move |this, _, _, cx| {
                            cx.stop_propagation();
                            this.show_more_steps(&entry, cx);
                        })),
                )
        });
        div()
            .flex()
            .flex_col()
            .border_t_1()
            .border_color(border)
            .bg(theme.muted.opacity(0.3))
            .children(rows)
            .children(more)
            .into_any_element()
    }

    /// The sets of a run of duplicate decisions, one row each with its own Undo. Each set is its
    /// own plan; what stayed comes from the hold reason of the copies it put in holding
    /// (`ResolveSets`).
    fn render_sets(&self, entry: &Entry, cx: &mut Context<Self>) -> AnyElement {
        let root = self.root_path(cx);
        let root_name = self
            .state
            .read(cx)
            .root()
            .map_or_else(|| "the top folder".to_string(), |root| root.name.clone());
        let rows: Vec<AnyElement> = entry
            .plans
            .iter()
            .map(|plan| {
                let held = self.held.get(&plan.id);
                let keeper = held.and_then(|held| keeper_of(&held.reason));
                let removed = self
                    .steps
                    .get(&plan.id)
                    .and_then(|page| page.steps.first())
                    .map(|step| step.from_path.clone());
                // The copy that stayed is on disk; the held one, or a removed one, stands in.
                let picture = match keeper {
                    Some(keeper) if !root.is_empty() => {
                        Some(format!("{}/{keeper}", root.trim_end_matches(['/', '\\'])))
                    }
                    _ => held.map(|held| held.hold_path.clone()).or(removed.clone()),
                };
                let name = keeper
                    .map(|keeper| file_name(keeper).to_string())
                    .or_else(|| removed.as_deref().map(|path| file_name(path).to_string()))
                    .unwrap_or_else(|| plan.title.clone());
                let full = keeper.map(String::from).or(removed.clone());
                let detail: Vec<String> = [
                    (plan.count > 1).then(|| format::plural(plan.count, "set")),
                    keeper.map(|keeper| {
                        let folder = folder_of(keeper);
                        format!(
                            "kept {}",
                            if folder.is_empty() {
                                root_name.as_str()
                            } else {
                                folder
                            }
                        )
                    }),
                    (plan.held.files > 0)
                        .then(|| format!("removed {}", format::count(plan.held.files))),
                    (plan.status == PlanStatus::Undone).then(|| "undone".to_string()),
                ]
                .into_iter()
                .flatten()
                .collect();
                self.render_set(plan, picture, name, full, detail.join(" · "), cx)
            })
            .collect();
        let theme = cx.theme();
        div()
            .flex()
            .flex_col()
            .border_t_1()
            .border_color(theme.border)
            .bg(theme.muted.opacity(0.3))
            .children(rows)
            .into_any_element()
    }

    fn render_set(
        &self,
        plan: &PlanSummary,
        picture: Option<String>,
        name: String,
        full: Option<String>,
        detail: String,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let video = picture.as_deref().is_some_and(|path| {
            oriel_core_domain::detect_media_type(file_name(path))
                == oriel_core_domain::MediaType::Video
        });
        let thumb = picture.as_deref().map_or(Thumb::Unavailable, |path| {
            self.thumbs.update(cx, |thumbs, cx| {
                thumbs.path(std::path::Path::new(path), video, 96, cx)
            })
        });
        let theme = cx.theme();
        let undone = plan.status == PlanStatus::Undone;
        let picture: AnyElement = match thumb {
            Thumb::Ready(image) => gpui_kit::img(image)
                .size_full()
                .object_fit(gpui_kit::ObjectFit::Cover)
                .into_any_element(),
            Thumb::Pending => div().size_full().into_any_element(),
            Thumb::Unavailable => div()
                .size_full()
                .flex()
                .items_center()
                .justify_center()
                .text_color(theme.muted_foreground)
                .child(Icon::new(IconName::File).size(px(14.)))
                .into_any_element(),
        };
        let busy = self.undoing.contains(&plan.id.to_string());
        let undo = can_undo(plan).then(|| {
            let plan = plan.clone();
            Button::new(SharedString::from(format!("history-undo-set-{}", plan.id)))
                .outline()
                .small()
                .label("Undo")
                .loading(busy)
                .disabled(busy)
                .on_click(cx.listener(move |this, _, window, cx| {
                    cx.stop_propagation();
                    this.undo_set(plan.clone(), window, cx);
                }))
        });
        div()
            .id(("history-set", plan.id as u64))
            .test_support()
            .aria_label(SharedString::from(name.clone()))
            .group("history-set")
            .flex()
            .flex_row()
            .items_center()
            .gap_3()
            .h(px(48.))
            .pl(px(60.))
            .pr_4()
            .border_t_1()
            .border_color(theme.border)
            .child(
                div()
                    .size_8()
                    .flex_shrink_0()
                    .rounded(px(6.))
                    .overflow_hidden()
                    .bg(theme.muted)
                    .child(picture),
            )
            .child(
                div()
                    .flex()
                    .flex_col()
                    .flex_1()
                    .min_w_0()
                    .child(
                        div()
                            .id(("history-set-name", plan.id as u64))
                            .truncate()
                            .text_size(px(13.))
                            .when(undone, |this| this.text_color(theme.muted_foreground))
                            .when_some(full, |this, full| {
                                this.tooltip(move |window, cx| {
                                    gpui_kit::component::tooltip::Tooltip::new(full.clone())
                                        .build(window, cx)
                                })
                            })
                            .child(name),
                    )
                    .child(widgets::caption(detail, cx).truncate()),
            )
            .children(undo.map(|undo| {
                div()
                    .invisible()
                    .group_hover("history-set", |style| style.visible())
                    .when(busy, |this| this.visible())
                    .child(undo)
            }))
            .into_any_element()
    }

    /// The folder's own path, which steps are shown inside.
    fn root_path(&self, cx: &App) -> String {
        self.state
            .read(cx)
            .root()
            .map(|root| root.path.clone())
            .unwrap_or_default()
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
    /// The rows listed under an open entry once read: its sets, or its steps and "Show all".
    fn step_count(&self, entry: &Entry) -> usize {
        if entry.plans.len() > 1 {
            return entry.plans.len();
        }
        entry
            .plans
            .first()
            .and_then(|plan| self.steps.get(&plan.id))
            .map_or(0, |page| {
                page.steps.len() + usize::from(page.total > page.steps.len() as i64)
            })
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
        let undoable_count = entry.plans.iter().filter(|plan| can_undo(plan)).count();
        let undoable = undoable_count > 0;
        let undoing = self.undoing.contains(&entry.key);
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
                                .label(if undoable_count > 1 {
                                    format!("Undo all {undoable_count}")
                                } else {
                                    "Undo".to_string()
                                })
                                .loading(undoing)
                                .disabled(undoing)
                                // ⌘Z undoes the newest change from anywhere; U undoes
                                // the row the arrows are on.
                                .tooltip(if newest { "Undo  ⌘Z" } else { "Undo  U" })
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
            53. + f32::from(u8::from(*last)) + 36. * *steps as f32
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
                Some("Every change you make shows up here with an Undo.".into_any_element()),
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
