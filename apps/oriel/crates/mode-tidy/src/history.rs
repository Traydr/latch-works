//! History: every change Tidy made to the folder, newest first, by
//! day, with what it did and its Undo. Duplicate decisions made one after another read as one
//! entry, which opens to list its sets, each with a picture of what stayed and its own Undo;
//! any other entry opens to list its first steps, and all of them on asking.
//! U undoes the entry in focus, all of its changes at once.
//!
//! Sets marked as not duplicates ("Keep both", "Keep all") are duplicate decisions too, though
//! no plan records them: the catalog's dismissals are read beside the journal and listed among
//! the plans by when they were made, and their Undo brings the set back to review (the owner's
//! choice over a separate "Not duplicates" list in Duplicates).
//!
//! The log is drawn a screen at a time ([`crate::windowed`]): a day's heading, each entry, and
//! the button for earlier changes are items of one column, each entry drawing its part of its
//! day's card.

use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::rc::Rc;
use std::sync::atomic::{AtomicI64, Ordering};

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
use oriel_core_domain::format;
use oriel_core_tidy::contract::DuplicateDismissal;
use oriel_ui::TextRole as _;
use oriel_ui::ToastExt as _;
use oriel_ui::focus::FocusReveal;
use oriel_ui::{ControlSize as _, Toast, TopBar};

use crate::actions::{PerformOptions, describe_plan};
use crate::labels::{file_name, relative_to};
use crate::loaded::{Loaded, PageReads};
use crate::pages::TidyPage;
use crate::state::TidyState;
use crate::thumbs::{Thumb, Thumbs};
use crate::widgets;
use crate::windowed::{Piece, Windowed};
use oriel_core_tidy::TidyEngine;
use oriel_core_tidy::contract::{
    HoldingItem, HoldingRequest, MAX_HISTORY_ROWS, PlanId, PlanKind, PlanListRequest, PlanStatus,
    PlanStep, PlanStepAction, PlanStepPage, PlanStepsRequest, PlanSummary, RootId, StepStatus,
};

const PAGE: usize = 200;

/// Duplicate decisions made within this long of each other read as one session.
const SESSION_GAP_MS: f64 = 10. * 60_000.;

/// Steps an entry lists when it opens, before "Show all".
const PREVIEW_STEPS: usize = 8;

/// Steps each "Show all" adds.
const STEP_PAGE: usize = MAX_HISTORY_ROWS as usize;

/// What the log lists: a plan from the journal, or a set marked as not duplicates.
#[derive(Clone)]
enum Decision {
    Plan(PlanSummary),
    Dismissal(DuplicateDismissal),
}

impl Decision {
    fn at(&self) -> i64 {
        match self {
            Self::Plan(plan) => plan.created_at,
            Self::Dismissal(dismissal) => dismissal.created_at,
        }
    }

    /// A dismissal can always be taken back; a plan, while its changes stand.
    fn undoable(&self) -> bool {
        match self {
            Self::Plan(plan) => plan.can_undo(),
            Self::Dismissal(_) => true,
        }
    }

    /// A duplicate decision that moved nothing, so it stays a row of its own and is not counted
    /// among the sets resolved. Undone is another matter: those it did resolve, and took back.
    fn resolved_nothing(&self) -> bool {
        matches!(
            self,
            Self::Plan(plan) if plan.kind == PlanKind::ResolveDuplicates
                && plan.steps > 0
                && plan.done == 0
                && plan.undone == 0
                && plan.status != PlanStatus::Undone
        )
    }

    fn about_duplicates(&self) -> bool {
        match self {
            Self::Plan(plan) => plan.kind == PlanKind::ResolveDuplicates,
            Self::Dismissal(_) => true,
        }
    }
}

/// One row of the log: a plan, a set marked as not duplicates, or a run of duplicate decisions
/// made in one sitting.
struct Entry {
    key: String,
    /// Newest first.
    decisions: Vec<Decision>,
}

impl Entry {
    fn plans(&self) -> impl Iterator<Item = &PlanSummary> {
        self.decisions.iter().filter_map(|decision| match decision {
            Decision::Plan(plan) => Some(plan),
            Decision::Dismissal(_) => None,
        })
    }

    fn dismissals(&self) -> impl Iterator<Item = &DuplicateDismissal> {
        self.decisions.iter().filter_map(|decision| match decision {
            Decision::Dismissal(dismissal) => Some(dismissal),
            Decision::Plan(_) => None,
        })
    }

    /// A run of duplicate decisions, which opens to its sets.
    fn is_run(&self) -> bool {
        self.decisions.len() > 1
    }

    fn at(&self) -> i64 {
        self.decisions.first().map_or(0, Decision::at)
    }

    /// The entry's only plan, for one that is a single change.
    fn only_plan(&self) -> Option<&PlanSummary> {
        match self.decisions.as_slice() {
            [Decision::Plan(plan)] => Some(plan),
            _ => None,
        }
    }

    fn only_dismissal(&self) -> Option<&DuplicateDismissal> {
        match self.decisions.as_slice() {
            [Decision::Dismissal(dismissal)] => Some(dismissal),
            _ => None,
        }
    }
}

/// The key a dismissal's entry, row and Undo go by; a plan's is its id.
fn dismissal_key(dismissal: &DuplicateDismissal) -> String {
    format!("dismissal-{}", dismissal.id)
}

/// What a dismissal says it did, as Duplicates' toast said it.
fn dismissal_title(dismissal: &DuplicateDismissal) -> &'static str {
    if dismissal.exact {
        "Kept every copy"
    } else {
        "Marked as not duplicates"
    }
}

fn dismissal_detail(dismissal: &DuplicateDismissal) -> String {
    let count = dismissal.files.len() as i64;
    if dismissal.exact {
        format!("{} kept", format::plural_as(count, "copy", "copies"))
    } else {
        format!("{} kept", format::plural(count, "version"))
    }
}

/// What a run's row for one set shows: its ids, its Undo's state, its picture and its words.
struct SetLine {
    id: (&'static str, u64),
    name_id: (&'static str, u64),
    undo_id: String,
    busy: bool,
    undone: bool,
    picture: Option<String>,
    name: String,
    full: Option<String>,
    detail: String,
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
    fn of(plans: &[PlanSummary], dismissals: &[DuplicateDismissal], wanted: usize) -> Self {
        let entries: Vec<Rc<Entry>> = group_decisions(plans, dismissals, wanted)
            .into_iter()
            .map(Rc::new)
            .collect();
        // ⌘Z takes back the newest change of the session, else the journal's newest plan, so
        // only an entry with a plan can promise it: after a restart a dismissal is not in reach.
        let newest_undoable = entries
            .iter()
            .find(|entry| entry.decisions.iter().any(Decision::undoable))
            .filter(|entry| entry.plans().any(PlanSummary::can_undo))
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
            let at = entry.at();
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

/// Reads `wanted` rows from `offset` on, in pages of at most [`MAX_HISTORY_ROWS`] (the most the
/// engine answers at once), stopping early at the end of the list.
async fn read_pages<T, Page>(
    offset: usize,
    wanted: usize,
    mut page: impl FnMut(i64, i64) -> Page,
) -> anyhow::Result<Vec<T>>
where
    Page: Future<Output = anyhow::Result<Vec<T>>>,
{
    let mut rows = Vec::new();
    while rows.len() < wanted {
        let limit = (wanted - rows.len()).min(MAX_HISTORY_ROWS as usize);
        let read = page((offset + rows.len()) as i64, limit as i64).await?;
        let end = read.len() < limit;
        rows.extend(read);
        if end {
            break;
        }
    }
    Ok(rows)
}

/// A plan's steps from `offset` on, `wanted` of them, with the plan's total.
async fn read_steps(
    engine: TidyEngine,
    plan_id: PlanId,
    offset: usize,
    wanted: usize,
) -> anyhow::Result<PlanStepPage> {
    let total = AtomicI64::new(0);
    let steps: Vec<PlanStep> = read_pages(offset, wanted, |offset, limit| {
        let page = engine.plan_steps(PlanStepsRequest {
            plan_id,
            offset,
            limit,
        });
        let total = &total;
        async move {
            let page = page.await?;
            total.store(page.total, Ordering::Relaxed);
            Ok(page.steps)
        }
    })
    .await?;
    Ok(PlanStepPage {
        total: total.into_inner(),
        steps,
    })
}

/// The first held file of each of `plans`, which names the copy its duplicate decision kept:
/// the root's holding is read a page at a time until each is found or the list ends.
async fn read_held(
    engine: TidyEngine,
    root_id: RootId,
    plans: HashSet<PlanId>,
) -> anyhow::Result<HashMap<PlanId, HoldingItem>> {
    let mut held = HashMap::new();
    let mut offset = 0;
    while held.len() < plans.len() {
        let page = engine
            .list_holding(HoldingRequest {
                root_id,
                offset,
                limit: MAX_HISTORY_ROWS,
            })
            .await?;
        let read = page.items.len() as i64;
        for item in page.items {
            if let Some(plan_id) = item.plan_id.filter(|id| plans.contains(id)) {
                held.entry(plan_id).or_insert(item);
            }
        }
        offset += read;
        if read < MAX_HISTORY_ROWS || offset >= page.total {
            break;
        }
    }
    Ok(held)
}

/// The journal's plans and the dismissals, newest first, as the log's entries: duplicate
/// decisions made within [`SESSION_GAP_MS`] of each other join one run. Each list is read at
/// most `wanted` long; while one has earlier entries to read, what the other holds from before
/// its oldest waits for them, so the log never skips a stretch of time.
fn group_decisions(
    plans: &[PlanSummary],
    dismissals: &[DuplicateDismissal],
    wanted: usize,
) -> Vec<Entry> {
    let oldest_plan = plans
        .last()
        .filter(|_| plans.len() >= wanted)
        .map(|plan| plan.created_at);
    let oldest_dismissal = dismissals
        .last()
        .filter(|_| dismissals.len() >= wanted)
        .map(|dismissal| dismissal.created_at);
    let since = oldest_plan.max(oldest_dismissal).unwrap_or(i64::MIN);
    let mut decisions: Vec<Decision> = plans
        .iter()
        .cloned()
        .map(Decision::Plan)
        .chain(dismissals.iter().cloned().map(Decision::Dismissal))
        .filter(|decision| decision.at() >= since)
        .collect();
    // Stable, so a plan and a dismissal of the same moment keep the journal's first.
    decisions.sort_by_key(|decision| std::cmp::Reverse(decision.at()));
    let mut entries: Vec<Entry> = Vec::new();
    for decision in decisions {
        if let Some(previous) = entries.last_mut()
            && let Some(last) = previous.decisions.last()
            && decision.about_duplicates()
            && last.about_duplicates()
            && ((last.at() - decision.at()) as f64) < SESSION_GAP_MS
            && last.undoable() == decision.undoable()
            && !last.resolved_nothing()
            && !decision.resolved_nothing()
        {
            previous.decisions.push(decision);
            continue;
        }
        let key = match &decision {
            Decision::Plan(plan) => plan.id.to_string(),
            Decision::Dismissal(dismissal) => dismissal_key(dismissal),
        };
        entries.push(Entry {
            key,
            decisions: vec![decision],
        });
    }
    entries
}

fn entry_title(entry: &Entry) -> String {
    if let Some(only) = entry.only_plan() {
        return only.title.clone();
    }
    if let Some(only) = entry.only_dismissal() {
        return dismissal_title(only).to_string();
    }
    let sets =
        entry.plans().map(|plan| plan.count).sum::<i64>() + entry.dismissals().count() as i64;
    format!("Resolved {}", format::plural(sets, "duplicate set"))
}

fn entry_detail(entry: &Entry) -> String {
    if let Some(only) = entry.only_plan() {
        return describe_plan(only);
    }
    if let Some(only) = entry.only_dismissal() {
        return dismissal_detail(only);
    }
    // An undone dismissal leaves the catalog, so only plans can be undone and still listed.
    if entry.decisions.iter().all(
        |decision| matches!(decision, Decision::Plan(plan) if plan.status == PlanStatus::Undone),
    ) {
        return "undone".into();
    }
    let (files, bytes) = entry.plans().fold((0, 0), |(files, bytes), plan| {
        (files + plan.held.files, bytes + plan.held.bytes)
    });
    let dismissed = entry.dismissals().count() as i64;
    [
        (files > 0).then(|| {
            format!(
                "{} to holding · {}",
                format::plural(files, "file"),
                format::bytes(bytes as f64)
            )
        }),
        (dismissed > 0).then(|| {
            format!(
                "{} marked as not duplicates",
                format::plural(dismissed, "set")
            )
        }),
    ]
    .into_iter()
    .flatten()
    .collect::<Vec<_>>()
    .join(" · ")
}

/// What a step did, in its row's first column.
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

/// How a step ended, where it is not simply done.
fn step_status(status: StepStatus) -> Option<&'static str> {
    match status {
        StepStatus::Pending => Some("Not run"),
        StepStatus::Done => None,
        StepStatus::Skipped => Some("Skipped"),
        StepStatus::Failed => Some("Failed"),
        StepStatus::Undone => Some("Undone"),
    }
}

fn folder_of(rel_path: &str) -> &str {
    rel_path
        .rfind(['/', '\\'])
        .map_or("", |cut| &rel_path[..cut])
}

/// The path a duplicate's hold reason names as the copy that stayed: "Duplicate of a/b.jpg".
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
    reveal: FocusReveal,
    state: Entity<TidyState>,
    thumbs: Entity<Thumbs>,
    focus: FocusHandle,
    /// The journal's plans and the dismissals, newest first, both read at most [`Self::wanted`].
    plans: Loaded<(Vec<PlanSummary>, Vec<DuplicateDismissal>)>,
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
    reads: PageReads,
    _subscriptions: Vec<Subscription>,
}

impl HistoryPage {
    pub(crate) fn new(
        state: &Entity<TidyState>,
        thumbs: &Entity<Thumbs>,
        cx: &mut Context<Self>,
    ) -> Self {
        let subscriptions = vec![
            cx.observe(state, |this, _, cx| this.sync(cx)),
            cx.observe(thumbs, |_, _, cx| cx.notify()),
        ];
        Self {
            reveal: FocusReveal::new(&gpui_kit::ScrollHandle::new(), px(0.)),
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
            reads: PageReads::default(),
            _subscriptions: subscriptions,
        }
    }

    fn sync(&mut self, cx: &mut Context<Self>) {
        cx.notify();
        if self
            .reads
            .due(TidyPage::History, self.state.read(cx))
            .is_some()
        {
            self.reload(cx);
        }
    }

    fn reload(&mut self, cx: &mut Context<Self>) {
        let state = self.state.read(cx);
        let Some(root_id) = state.root_id() else {
            return;
        };
        let Some(engine) = state.engine().cloned() else {
            return;
        };
        let wanted = self.wanted;
        let answer = engine.ask(
            move |engine| async move {
                let dismissals = engine.list_dismissals(root_id, wanted);
                let plans = read_pages(0, wanted, |offset, limit| {
                    engine.list_plans(PlanListRequest {
                        root_id: Some(root_id),
                        offset,
                        limit,
                    })
                })
                .await?;
                Ok((plans, dismissals.await?))
            },
            cx,
        );
        self.plans
            .load_then(answer, |this| &mut this.plans, Self::loaded, cx);
        self.steps.clear();
        self.held.clear();
        // What was being undone has been: the catalog changed, which is why this reads again.
        self.undoing.clear();
        cx.notify();
    }

    fn loaded(&mut self, cx: &mut Context<Self>) {
        let wanted = self.wanted;
        self.log = self
            .plans
            .data()
            .map(|(plans, dismissals)| Rc::new(Log::of(plans, dismissals, wanted)));
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
        let (Some(engine), Some(root_id)) = (state.engine().cloned(), state.root_id()) else {
            return;
        };
        let sets = entry.is_run();
        if sets {
            let plans = entry.plans().map(|plan| plan.id).collect();
            let held = engine.ask(move |engine| read_held(engine, root_id, plans), cx);
            cx.spawn(async move |this, cx| {
                let held = held.await;
                this.update(cx, |this, cx| {
                    if let Ok(held) = held {
                        this.held.extend(held);
                    }
                    cx.notify();
                })
                .ok();
            })
            .detach();
        }
        for plan in entry.plans() {
            let id = plan.id;
            let wanted = if sets {
                1
            } else {
                self.showing.get(&id).copied().unwrap_or(PREVIEW_STEPS)
            };
            let steps = engine.ask(move |engine| read_steps(engine, id, 0, wanted), cx);
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

    /// "Show all": the plan's next page of steps, after those listed.
    fn show_more_steps(&mut self, entry: &Entry, cx: &mut Context<Self>) {
        let Some(plan) = entry.only_plan() else {
            return;
        };
        let Some(engine) = self.state.read(cx).engine().cloned() else {
            return;
        };
        let id = plan.id;
        let listed = self.steps.get(&id).map_or(0, |page| page.steps.len());
        self.showing.insert(id, listed + STEP_PAGE);
        let more = engine.ask(move |engine| read_steps(engine, id, listed, STEP_PAGE), cx);
        cx.spawn(async move |this, cx| {
            let more = more.await;
            this.update(cx, |this, cx| {
                if let Ok(more) = more
                    && let Some(page) = this.steps.get_mut(&id)
                    && page.steps.len() == listed
                {
                    page.total = more.total;
                    page.steps.extend(more.steps);
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
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
    /// with one toast for them all.
    fn undo(&mut self, entry: &Entry, window: &mut Window, cx: &mut Context<Self>) {
        let undoable: Vec<PlanSummary> = entry
            .plans()
            .filter(|plan| plan.can_undo())
            .cloned()
            .collect();
        let dismissals: Vec<i64> = entry.dismissals().map(|dismissal| dismissal.id).collect();
        if (undoable.is_empty() && dismissals.is_empty()) || !self.undoing.insert(entry.key.clone())
        {
            return;
        }
        self.restore(dismissals, undoable.is_empty(), window, cx);
        match undoable.as_slice() {
            [] => {}
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

    /// Undoes one set of a run of duplicate decisions.
    fn undo_set(&mut self, plan: PlanSummary, window: &mut Window, cx: &mut Context<Self>) {
        if !self.undoing.insert(plan.id.to_string()) {
            return;
        }
        self.state.update(cx, |state, cx| {
            state.undo_plan(plan, PerformOptions::default(), window, cx);
        });
        cx.notify();
    }

    /// Undoes one set marked as not duplicates, which brings it back to review.
    fn undo_dismissal(
        &mut self,
        dismissal: &DuplicateDismissal,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if !self.undoing.insert(dismissal_key(dismissal)) {
            return;
        }
        self.restore(vec![dismissal.id], true, window, cx);
        cx.notify();
    }

    /// Takes back dismissals, as Duplicates' own Undo does: their sets
    /// are open again, and Duplicates lists them once it reads the catalog, which `changed`
    /// asks for. Nothing on screen says where the set went, so a toast does, when `announce`.
    fn restore(
        &mut self,
        ids: Vec<i64>,
        announce: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(engine) = self.state.read(cx).engine().cloned() else {
            return;
        };
        if ids.is_empty() {
            return;
        }
        let count = ids.len() as i64;
        let restored: Vec<_> = ids
            .into_iter()
            .map(|id| engine.ask(move |engine| engine.restore_duplicate_set(id), cx))
            .collect();
        cx.spawn_in(window, async move |this, cx| {
            let mut failed = None;
            for restored in restored {
                if let Err(error) = restored.await {
                    failed = Some(error);
                }
            }
            this.update_in(cx, |this, window, cx| {
                this.state.update(cx, |state, cx| state.changed(cx));
                let toast = match failed {
                    Some(error) => Some(
                        Toast::error("Couldn't bring the set back to review")
                            .detail(format!("{error:#}")),
                    ),
                    None => announce.then(|| {
                        Toast::done(if count > 1 {
                            format!("{} back in Duplicates", format::plural(count, "set"))
                        } else {
                            "Back in Duplicates".to_string()
                        })
                    }),
                };
                if let Some(toast) = toast {
                    window.show_toast(toast, cx);
                }
            })
            .ok();
        })
        .detach();
    }

    fn on_key_down(&mut self, event: &KeyDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        // It is the open menu's, or nothing's; the page must not act on it behind the menu.
        if oriel_ui::popups::popup_open(window, cx) {
            return;
        }
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

    /// What an open entry lists under it: its sets, for a run of duplicate decisions; the files
    /// kept, for a set marked as not duplicates; or its steps.
    fn render_steps(&self, entry: &Rc<Entry>, cx: &mut Context<Self>) -> AnyElement {
        if entry.is_run() {
            return self.render_sets(entry, cx);
        }
        if let Some(dismissal) = entry.only_dismissal() {
            return self.render_kept_files(dismissal, cx);
        }
        let Some(plan) = entry.only_plan() else {
            return div().into_any_element();
        };
        let Some(page) = self.steps.get(&plan.id) else {
            return div()
                .h(px(44.))
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
                .h(px(44.))
                .pl(px(60.))
                .pr_4()
                .border_t_1()
                .border_color(border)
                .text_body()
                .child(
                    div()
                        .w(px(96.))
                        .flex_shrink_0()
                        .text_caption()
                        .text_color(muted)
                        .child(if plan.kind == PlanKind::ShrinkVideos {
                            "To AV1"
                        } else {
                            action_label(step.action)
                        }),
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
                        .text_caption()
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
                        .text_caption()
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
                .h(px(44.))
                .pl(px(52.))
                .flex()
                .items_center()
                .border_t_1()
                .border_color(border)
                .child(
                    Button::new(SharedString::from(format!("history-show-all-{}", plan.id)))
                        .ghost()
                        .row_size()
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

    /// The files a set marked as not duplicates kept, a step's row each.
    fn render_kept_files(
        &self,
        dismissal: &DuplicateDismissal,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let theme = cx.theme();
        let (border, muted) = (theme.border, theme.muted_foreground);
        let rows = dismissal.files.iter().map(|file| {
            div()
                .flex()
                .flex_row()
                .items_center()
                .gap_3()
                .h(px(44.))
                .pl(px(60.))
                .pr_4()
                .border_t_1()
                .border_color(border)
                .text_body()
                .child(
                    div()
                        .w(px(96.))
                        .flex_shrink_0()
                        .text_caption()
                        .text_color(muted)
                        .child("Kept"),
                )
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .overflow_hidden()
                        .whitespace_nowrap()
                        .text_ellipsis_start()
                        .child(file.rel_path.clone()),
                )
        });
        div()
            .flex()
            .flex_col()
            .border_t_1()
            .border_color(border)
            .bg(theme.muted.opacity(0.3))
            .children(rows)
            .into_any_element()
    }

    /// The sets of a run of duplicate decisions, one row each with its own Undo. Each set is its
    /// own plan; what stayed comes from the hold reason of the copies it put in holding.
    fn render_sets(&self, entry: &Entry, cx: &mut Context<Self>) -> AnyElement {
        let root = self.root_path(cx);
        let root_name = self
            .state
            .read(cx)
            .root()
            .map_or_else(|| "the top folder".to_string(), |root| root.name.clone());
        let rows: Vec<AnyElement> = entry
            .decisions
            .iter()
            .map(|decision| {
                let plan = match decision {
                    Decision::Plan(plan) => plan,
                    Decision::Dismissal(dismissal) => {
                        return self.render_dismissal_set(dismissal, cx);
                    }
                };
                let held = self.held.get(&plan.id);
                let keeper = held.and_then(HoldingItem::kept_rel_path);
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
                let undo = plan.can_undo().then(|| {
                    let plan = plan.clone();
                    move |this: &mut Self, window: &mut Window, cx: &mut Context<Self>| {
                        this.undo_set(plan.clone(), window, cx);
                    }
                });
                self.render_set(
                    SetLine {
                        id: ("history-set", plan.id as u64),
                        name_id: ("history-set-name", plan.id as u64),
                        undo_id: format!("history-undo-set-{}", plan.id),
                        busy: self.undoing.contains(&plan.id.to_string()),
                        undone: plan.status == PlanStatus::Undone,
                        picture,
                        name,
                        full,
                        detail: detail.join(" · "),
                    },
                    undo,
                    cx,
                )
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

    /// A set marked as not duplicates as its entry shows it: its first file's picture, in the
    /// 32 px tile a change's icon takes.
    fn render_dismissal_picture(
        &self,
        dismissal: &DuplicateDismissal,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let thumb = dismissal.files.first().map_or(Thumb::Unavailable, |file| {
            self.thumbs
                .update(cx, |thumbs, cx| thumbs.get(file, 96, cx))
        });
        let theme = cx.theme();
        div()
            .flex_shrink_0()
            .size_8()
            .rounded(theme.radius_lg)
            .overflow_hidden()
            .bg(theme.muted)
            .child(set_picture(thumb, cx))
            .into_any_element()
    }

    /// A set marked as not duplicates, in a run: its picture, what it did, its files, its Undo.
    fn render_dismissal_set(
        &self,
        dismissal: &DuplicateDismissal,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let first = dismissal.files.first();
        let undo = {
            let dismissal = dismissal.clone();
            move |this: &mut Self, window: &mut Window, cx: &mut Context<Self>| {
                this.undo_dismissal(&dismissal, window, cx);
            }
        };
        let detail = [
            first.map(|file| file.name.clone()),
            Some(dismissal_detail(dismissal)),
        ]
        .into_iter()
        .flatten()
        .collect::<Vec<_>>()
        .join(" · ");
        self.render_set(
            SetLine {
                id: ("history-dismissal", dismissal.id as u64),
                name_id: ("history-dismissal-name", dismissal.id as u64),
                undo_id: format!("history-undo-{}", dismissal_key(dismissal)),
                busy: self.undoing.contains(&dismissal_key(dismissal)),
                undone: false,
                picture: first.map(|file| file.abs_path.clone()),
                name: dismissal_title(dismissal).to_string(),
                full: Some(
                    dismissal
                        .files
                        .iter()
                        .map(|file| file.rel_path.as_str())
                        .collect::<Vec<_>>()
                        .join("\n"),
                ),
                detail,
            },
            Some(undo),
            cx,
        )
    }

    fn render_set(
        &self,
        line: SetLine,
        undo: Option<impl Fn(&mut Self, &mut Window, &mut Context<Self>) + 'static>,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let SetLine {
            id,
            name_id,
            undo_id,
            busy,
            undone,
            picture,
            name,
            full,
            detail,
        } = line;
        let video = picture.as_deref().is_some_and(|path| {
            oriel_core_domain::detect_media_type(file_name(path))
                == oriel_core_domain::MediaType::Video
        });
        let thumb = picture.as_deref().map_or(Thumb::Unavailable, |path| {
            self.thumbs.update(cx, |thumbs, cx| {
                thumbs.path(std::path::Path::new(path), video, 96, cx)
            })
        });
        let picture = set_picture(thumb, cx);
        let theme = cx.theme();
        let undo = undo.map(|undo| {
            Button::new(SharedString::from(undo_id))
                .outline()
                .quiet_edge(cx)
                .row_size()
                .label("Undo")
                .loading(busy)
                .disabled(busy)
                .on_click(cx.listener(move |this, _, window, cx| {
                    cx.stop_propagation();
                    undo(this, window, cx);
                }))
        });
        div()
            .id(id)
            .test_support()
            .aria_label(SharedString::from(name.clone()))
            .group("history-set")
            .flex()
            .flex_row()
            .items_center()
            .gap_3()
            .h(px(56.))
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
                            .id(name_id)
                            .truncate()
                            .text_body()
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
                        .max_w(widgets::PAGE_COLUMN)
                        .px_6()
                        .when(!*first, |this| this.pt_2())
                        .child(
                            div()
                                .h(px(44.))
                                .flex()
                                .items_center()
                                .text_caption()
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
                        .max_w(widgets::PAGE_COLUMN)
                        .px_6()
                        .pt_2()
                        .child(
                            Button::new("history-more")
                                .outline()
                                .quiet_edge(cx)
                                .row_size()
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
        // What Tab lands on stays in sight, as the arrows' row does.
        self.reveal = self.reveal.over(&scroll);
        let reveal = self.reveal.clone();
        let children: Vec<AnyElement> = children
            .into_iter()
            .enumerate()
            .map(|(index, child)| reveal.keep(format!("history-{index}"), child, window, cx))
            .collect();
        div()
            .id("history-scroll")
            .test_support()
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
        if entry.is_run() {
            return entry.decisions.len();
        }
        if let Some(dismissal) = entry.only_dismissal() {
            return dismissal.files.len();
        }
        entry
            .only_plan()
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
        let ring = cx.theme().ring;
        let open = self.expanded.contains(&entry.key);
        let focused = self.focused.as_ref() == Some(&entry.key);
        let first = entry.decisions.first().cloned();
        let undoable_count = entry
            .decisions
            .iter()
            .filter(|decision| decision.undoable())
            .count();
        let undoable = undoable_count > 0;
        let undoing = self.undoing.contains(&entry.key);
        let status = match &first {
            Some(Decision::Plan(plan)) => status_label(plan.status),
            _ => None,
        };
        let title = entry_title(entry);
        let detail = entry_detail(entry);
        // When, as "5 min ago" with the full date and time in a tooltip.
        let when = first.as_ref().map(|decision| {
            let at = decision.at();
            div()
                .id(SharedString::from(format!(
                    "history-time-{key}",
                    key = entry.key
                )))
                .flex_shrink_0()
                .text_caption()
                .text_color(muted)
                .child(format::relative(Some(at as f64), format::now_ms()))
                .tooltip(move |window, cx| {
                    gpui_kit::component::tooltip::Tooltip::new(format::date_time(at))
                        .build(window, cx)
                })
        });
        // A set marked as not duplicates shows its picture; anything else, what kind it is.
        let icon = match (&first, entry.only_dismissal()) {
            (_, Some(dismissal)) => Some(self.render_dismissal_picture(dismissal, cx)),
            (Some(Decision::Plan(plan)), None) => Some(plan_icon(plan.kind, cx).into_any_element()),
            (Some(Decision::Dismissal(_)), None) => {
                Some(plan_icon(PlanKind::ResolveDuplicates, cx).into_any_element())
            }
            (None, None) => None,
        };
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
                    .min_h(px(60.))
                    .px_4()
                    .cursor_pointer()
                    // The arrow keys' place in the log, as Overview's rows show theirs.
                    .when(focused, |this| {
                        this.bg(accent).border_1().border_color(ring)
                    })
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
                        .size(px(16.))
                        .text_color(muted),
                    )
                    .children(icon)
                    .child(
                        div()
                            .flex()
                            .flex_col()
                            .flex_1()
                            .min_w_0()
                            .child(
                                div()
                                    .truncate()
                                    .text_body()
                                    .font_weight(FontWeight::MEDIUM)
                                    .child(title),
                            )
                            .map(|this| {
                                // A title alone sits level with its icon.
                                let caption = [
                                    status.map(String::from),
                                    (!detail.is_empty()).then_some(detail),
                                ]
                                .into_iter()
                                .flatten()
                                .collect::<Vec<_>>()
                                .join(" · ");
                                if caption.is_empty() {
                                    this
                                } else {
                                    this.child(widgets::caption(caption, cx))
                                }
                            }),
                    )
                    .children(when)
                    .when(undoable, |this| {
                        this.child(
                            Button::new(SharedString::from(format!("history-undo-{key}")))
                                .outline()
                                .quiet_edge(cx)
                                .row_size()
                                .label(if undoable_count > 1 {
                                    format!("Undo all {undoable_count}")
                                } else {
                                    "Undo".to_string()
                                })
                                .loading(undoing)
                                .disabled(undoing)
                                // ⌘Z undoes the newest change from anywhere; U undoes
                                // the row the arrows are on.
                                .tooltip(oriel_ui::keys::labelled(
                                    "Undo",
                                    if newest { "cmd-z" } else { "u" },
                                ))
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
            .max_w(widgets::PAGE_COLUMN)
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

/// A set's picture, cropped to fill its tile, or a file's icon where there is none.
fn set_picture(thumb: Thumb, cx: &App) -> AnyElement {
    match thumb {
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
            .text_color(cx.theme().muted_foreground)
            .child(Icon::new(IconName::File).size(px(16.)))
            .into_any_element(),
    }
}

/// The 32 px tile that says what kind of change a row is.
fn plan_icon(kind: PlanKind, cx: &App) -> impl IntoElement + use<> {
    let icon = match kind {
        PlanKind::Hold => IconName::Archive,
        PlanKind::Move => IconName::FolderInput,
        PlanKind::Rename | PlanKind::FixExtension => IconName::PencilLine,
        PlanKind::Optimize | PlanKind::Reencode => IconName::ArrowRightLeft,
        PlanKind::StripAudio => IconName::VolumeX,
        PlanKind::ResolveDuplicates => IconName::Copy,
        PlanKind::CleanJunk | PlanKind::RemoveEmptyFolders | PlanKind::Cleanup => {
            IconName::Sparkles
        }
        PlanKind::ShrinkVideos => IconName::Shrink,
    };
    let theme = cx.theme();
    div()
        .flex_shrink_0()
        .size_8()
        .flex()
        .items_center()
        .justify_center()
        .rounded(theme.radius_lg)
        .bg(theme.muted)
        .text_color(theme.muted_foreground)
        .child(Icon::new(icon).size(px(20.)))
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
        let shell = self.state.read(cx).shell().clone();
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
            (Some((plans, dismissals)), _) if plans.is_empty() && dismissals.is_empty() => {
                widgets::empty_state(
                    "history-empty",
                    Some(IconName::RotateCcw),
                    "No changes yet",
                    Some("Every change you make shows up here with an Undo.".into_any_element()),
                    Vec::new(),
                    cx,
                )
                .into_any_element()
            }
            (Some((plans, dismissals)), _) => {
                let has_more = plans.len() == self.wanted || dismissals.len() == self.wanted;
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
            .child(TopBar::new(&shell, TidyPage::History.label()))
            .child(body)
    }
}

#[cfg(test)]
mod tests {
    use oriel_core_tidy::contract::HeldCount;

    use super::*;

    fn resolved(id: i64, status: PlanStatus, done: i64, undone: i64) -> PlanSummary {
        PlanSummary {
            id,
            kind: PlanKind::ResolveDuplicates,
            created_at: 1_000 - id,
            status,
            title: "Resolved 1 duplicate set".into(),
            count: 1,
            steps: 3,
            done,
            skipped: 3 - done - undone,
            skipped_for_kept_file: 0,
            failed: 0,
            undone,
            bytes_before: 0,
            bytes_after: 0,
            held: HeldCount::default(),
        }
    }

    #[test]
    fn a_plan_that_resolved_nothing_stays_its_own_row_and_is_not_counted() {
        // One moved nothing, beside one undone, in one sitting.
        let plans = vec![
            resolved(1, PlanStatus::Applied, 0, 0),
            resolved(2, PlanStatus::Undone, 0, 3),
            resolved(3, PlanStatus::Undone, 0, 3),
        ];
        let entries = group_decisions(&plans, &[], 20);
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].decisions.len(), 1);
        assert_eq!(entries[0].key, "1");
        assert_eq!(entry_title(&entries[1]), "Resolved 2 duplicate sets");

        // Two that moved nothing are two rows, not "Resolved 2 duplicate sets".
        let plans = vec![
            resolved(1, PlanStatus::Applied, 0, 0),
            resolved(2, PlanStatus::Applied, 0, 0),
        ];
        assert_eq!(group_decisions(&plans, &[], 20).len(), 2);
    }
}
