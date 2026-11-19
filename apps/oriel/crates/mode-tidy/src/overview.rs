//! The Tidy page: what Tidy up would do to the folder on screen, as one plan grouped by where the
//! files end up. Smaller: videos to MP4, pictures to AVIF, animations to MP4. Cleaner: silent
//! soundtracks removed, then junk, empty folders and wrong extensions. Each row has its switch and
//! opens to say more, and Tidy up (⌘↩) runs every row switched on as one change with one Undo.
//! Videos keep their codec or go to AV1, which encodes each video once, straight from MOV or MKV
//! (`plan`). Below the plan: the similar versions and identical copies that wait for the owner,
//! holding, and what else the scan found.

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
use oriel_core_domain::format;
use oriel_core_tidy::contract::{
    AudioState, DuplicateScope, DuplicateSetPage, DuplicateSetRequest, FileFlag, FileFormat,
    FileKind, FindingKind, PlanKind, RootId, SimilarityLevel, Tidy,
};
use oriel_ui::TextRole as _;
use oriel_ui::focus::FocusReveal;
use oriel_ui::segmented::{Segmented, SegmentedItem};
use oriel_ui::{ControlSize as _, TopBar};

use crate::loaded::{Loaded, PageReads, Read};
use crate::pages::TidyPage;
use crate::plan::{self, PlanRow, RowWork, Saving};
use crate::state::{LibraryPreset, TidyState};
use crate::thumbs::{self, Thumbs};
use crate::widgets;

pub(crate) const TIDY_SOURCE: &str = "overview:tidy";

/// Up to this many keepers stand for the similar sets on the "needs your eye" card.
const STACK: usize = 5;

/// Where a row of the plan is.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RowState {
    Todo,
    /// Work there, switched off.
    Off,
    Running,
    Done,
}

impl RowState {
    fn key(self) -> &'static str {
        match self {
            RowState::Todo => "todo",
            RowState::Off => "off",
            RowState::Running => "running",
            RowState::Done => "done",
        }
    }
}

pub struct OverviewPage {
    state: Entity<TidyState>,
    thumbs: Entity<Thumbs>,
    focus: FocusHandle,
    /// Rows Tidy up took on this visit stay listed, as done once their work is.
    started: (Option<RootId>, BTreeSet<PlanRow>),
    /// Rows opened to say more.
    open: BTreeSet<PlanRow>,
    /// Whether the files left as they are are listed.
    left_open: bool,
    /// What the last Tidy up this visit took out of the folder, for the done card.
    keepers: Loaded<DuplicateSetPage>,
    reads: PageReads,
    /// The plan's rows as last drawn, which ↑ ↓ move between, and the one they rest on: its ring
    /// shows, Space switches it and → ← open and close it.
    shown_rows: Vec<PlanRow>,
    focused_row: Option<PlanRow>,
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
            open: BTreeSet::new(),
            left_open: false,
            keepers: Loaded::default(),
            reads: PageReads::default(),
            shown_rows: Vec::new(),
            focused_row: None,
            _subscriptions: subscriptions,
        }
    }

    /// Reads the similar sets' keepers again when the catalog moves, while the page shows.
    fn sync(&mut self, cx: &mut Context<Self>) {
        cx.notify();
        let state = self.state.read(cx);
        if state.page() != TidyPage::Overview {
            // A row's ring is for this visit only, as a focused button's is.
            self.focused_row = None;
            return;
        }
        let Some(Read {
            engine, root_id, ..
        }) = self.reads.due(TidyPage::Overview, state)
        else {
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
        let keepers = engine.ask(|engine| engine.duplicate_sets(request), cx);
        self.keepers.load(keepers, |this| &mut this.keepers, cx);
        // The videos' row says when this machine has no H.264 encoder.
        if self.state.read(cx).capabilities().is_none() {
            self.state
                .update(cx, |state, cx| state.ask_capabilities(cx));
        }
        cx.notify();
    }

    /// The rows the plan step Tidy up is on belongs to.
    fn running_rows(&self, rows: &[RowWork], cx: &App) -> BTreeSet<PlanRow> {
        let Some(change) = self.state.read(cx).change_for(TIDY_SOURCE) else {
            return BTreeSet::new();
        };
        let taken = |row: PlanRow| rows.iter().any(|work| work.row == row && work.on);
        match change.kind {
            Some(PlanKind::Cleanup) => [PlanRow::CleanUp].into(),
            Some(PlanKind::StripAudio) => [PlanRow::SilentTracks].into(),
            Some(PlanKind::ShrinkVideos) => [PlanRow::Videos].into(),
            Some(PlanKind::Optimize) => {
                PlanRow::SMALLER.into_iter().filter(|r| taken(*r)).collect()
            }
            _ => BTreeSet::new(),
        }
    }

    fn kept(&self, cx: &App) -> BTreeSet<PlanRow> {
        let root_id = self.state.read(cx).root_id();
        if self.started.0 == root_id {
            self.started.1.clone()
        } else {
            BTreeSet::new()
        }
    }

    fn keep(&mut self, rows: impl IntoIterator<Item = PlanRow>, cx: &App) {
        let root_id = self.state.read(cx).root_id();
        if self.started.0 != root_id {
            self.started = (root_id, BTreeSet::new());
        }
        self.started.1.extend(rows);
    }

    /// Tidy up: every row switched on, as one change with one Undo. Duplicates are not a row:
    /// the owner decides every set.
    pub fn tidy_up(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let state = self.state.read(cx);
        let (Some(root), Some(data)) = (state.root().cloned(), state.overview().cloned()) else {
            return;
        };
        if state.change_status(TIDY_SOURCE, cx).is_some() {
            return;
        }
        let rows = plan::rows(state, &data);
        if !plan::todo_any(&rows) {
            return;
        }
        let choices = state.tidy_up_choices();
        self.keep(
            rows.iter()
                .filter(|work| work.on && work.todo())
                .map(|work| work.row),
            cx,
        );
        let title = format!("Tidied up {}", root.name);
        self.state.update(cx, |state, cx| {
            state.tidy_up(choices, title, TIDY_SOURCE, window, cx);
        });
        cx.notify();
    }

    fn toggle_open(&mut self, row: PlanRow, cx: &mut Context<Self>) {
        if !self.open.remove(&row) {
            self.open.insert(row);
        }
        cx.notify();
    }

    fn on_key_down(&mut self, event: &KeyDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        // It is the open menu's, or nothing's; the page must not act on it behind the menu.
        if oriel_ui::popups::popup_open(window, cx) {
            return;
        }
        if oriel_ui::keys::control_has_key(event, None, window, cx) {
            return;
        }
        let keys = &event.keystroke;
        if !keys.modifiers.modified() && keys.key == "d" {
            self.state.update(cx, |state, cx| {
                state.open_duplicates(DuplicateScope::Similar, cx);
            });
            cx.stop_propagation();
        } else if !keys.modifiers.modified() && self.move_between_rows(&keys.key, cx) {
            cx.stop_propagation();
        }
    }

    /// ↑ ↓ move between the plan's rows, from the first or the last; Space switches the row they
    /// rest on, and → or ↩ open it and ← closes it.
    fn move_between_rows(&mut self, key: &str, cx: &mut Context<Self>) -> bool {
        let at = self
            .focused_row
            .and_then(|focused| self.shown_rows.iter().position(|row| *row == focused));
        match key {
            "down" | "up" if !self.shown_rows.is_empty() => {
                let last = self.shown_rows.len() - 1;
                let next = match (at, key) {
                    (None, "down") => 0,
                    (None, _) => last,
                    (Some(at), "down") => (at + 1).min(last),
                    (Some(at), _) => at.saturating_sub(1),
                };
                self.focused_row = Some(self.shown_rows[next]);
                cx.notify();
                true
            }
            "space" => {
                let Some(row) = at.map(|at| self.shown_rows[at]) else {
                    return false;
                };
                if self.state.read(cx).change_for(TIDY_SOURCE).is_none() {
                    self.state.update(cx, |state, cx| {
                        let on = row.is_on(state);
                        row.set_on(state, !on, cx);
                    });
                }
                true
            }
            "enter" | "right" | "left" => {
                let Some(row) = at.map(|at| self.shown_rows[at]) else {
                    return false;
                };
                let open = key != "left";
                if open != self.open.contains(&row) {
                    self.toggle_open(row, cx);
                }
                true
            }
            _ => false,
        }
    }

    fn render_top_bar(&self, cx: &mut Context<Self>) -> TopBar {
        let state = self.state.read(cx);
        let theme = cx.theme();
        let scanning = state.root_id().is_some_and(|id| state.is_scanning(id));
        let meta = state.overview().map(|data| {
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
            .bar_size()
            .ghost()
            .map(|button| {
                if scanning {
                    button.child(Spinner::new().small())
                } else {
                    button.icon(Icon::new(IconName::RefreshCw))
                }
            })
            .disabled(scanning)
            .accessibility_label("Rescan")
            .tooltip(oriel_ui::keys::labelled("Rescan", crate::RESCAN_KEYS))
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
                        .bar_size()
                        .ghost()
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
                        .bar_size()
                        .ghost()
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
        TopBar::new(state.shell(), TidyPage::Overview.label())
            .when_some(meta, |bar, meta| {
                bar.quiet(
                    div()
                        .id("overview-meta")
                        .test_support()
                        .aria_label(SharedString::from(meta.clone()))
                        .min_w_0()
                        .truncate()
                        .text_caption()
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
        let progress = state.scan().map(|scan| scan.job.progress(cx));
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
                    .text_heading()
                    .font_weight(FontWeight::SEMIBOLD)
                    .child(format!("Scanning {name}")),
            )
            .child(
                div().w(px(400.)).child(
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

    fn render_done(&self, data: &Tidy, cx: &mut Context<Self>) -> AnyElement {
        let success = cx.theme().success;
        let state = self.state.read(cx);
        let root_name = state
            .root()
            .map(|root| root.name.clone())
            .unwrap_or_default();
        let saved = state
            .tidied()
            .filter(|tidied| Some(tidied.root_id) == state.root_id())
            .map_or(0, |tidied| tidied.saved);
        // What the page lists below still waits for the owner, so "nothing left" would not be
        // true of it.
        let waiting = data.duplicates.similar.sets + data.duplicates.exact.sets > 0;
        let heading = if saved > 0 || waiting {
            "Tidy up is done"
        } else {
            "All tidy"
        };
        let line = if saved > 0 {
            format!(
                "{} out of {root_name} · originals wait in holding until you empty it",
                format::bytes(saved as f64)
            )
        } else if waiting {
            "What's below needs your eye".to_string()
        } else {
            "Nothing left to tidy".to_string()
        };
        widgets::card(cx)
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
                            .text_body()
                            .font_weight(FontWeight::SEMIBOLD)
                            .child(heading),
                    )
                    .child(widgets::caption(line, cx).truncate()),
            )
            .into_any_element()
    }

    fn render_hero(
        &mut self,
        data: &Tidy,
        reveal: &FocusReveal,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let muted = cx.theme().muted_foreground;
        let state = self.state.read(cx);
        let tidying = state.change_for(TIDY_SOURCE).is_some();
        let rows = plan::rows(state, data);
        let running = self.running_rows(&rows, cx);
        let kept = self.kept(cx);
        let shrinkable = data.shrink.files > 0;
        let shown: Vec<RowWork> = rows
            .iter()
            .copied()
            .filter(|work| {
                work.todo()
                    || kept.contains(&work.row)
                    || running.contains(&work.row)
                    // AV1 is on offer while there is a video it would shrink.
                    || (work.row == PlanRow::Videos && shrinkable)
            })
            .collect();
        if shown.is_empty() && !tidying {
            self.shown_rows.clear();
            let done = self.render_done(data, cx);
            return reveal.keep("overview-done", done, window, cx);
        }

        let (files, saved, pending) = plan::totals(&rows);
        let heading = if tidying {
            "Tidying up"
        } else if files == 0 {
            "Nothing switched on"
        } else if saved > 0. {
            "Tidying up saves about"
        } else if pending {
            "Estimating the saving…"
        } else {
            "Ready to tidy"
        };
        let display = if saved > 0. {
            format::bytes(saved)
        } else {
            format!("{} to tidy", format::plural(files, "file"))
        };
        let note = format!(
            "{} · everything goes to holding first and can be undone",
            format::plural(files, "file")
        );
        let av1 = rows
            .iter()
            .any(|work| work.row == PlanRow::Videos && work.on && state.av1() && work.todo())
            .then(|| {
                format!(
                    "AV1 takes about {} · it runs in the background, and you can pause it",
                    format::span(data.shrink.encode_ms as f64)
                )
            });

        // Another page's change running, Tidy up queues behind it.
        let label = if files > 0 {
            format!("Tidy up {}", format::count(files))
        } else {
            "Tidy up".to_owned()
        };
        let action: AnyElement = widgets::while_changing(
            widgets::primary_action("overview-tidy-up", label, widgets::MAIN_ACTION_KEYS)
                .page_size()
                .disabled(files == 0)
                .on_click(cx.listener(|this, _, window, cx| this.tidy_up(window, cx))),
            state.change_status(TIDY_SOURCE, cx),
        )
        .into_any_element();

        self.shown_rows = shown.iter().map(|work| work.row).collect();
        let row_state = |work: &RowWork| {
            if running.contains(&work.row) {
                RowState::Running
            } else if !work.todo() && kept.contains(&work.row) {
                RowState::Done
            } else if !work.on {
                RowState::Off
            } else {
                RowState::Todo
            }
        };
        let mut sections = Vec::new();
        for (title, group) in [
            ("Smaller", &PlanRow::SMALLER[..]),
            ("Cleaner", &PlanRow::CLEANER[..]),
        ] {
            let in_group: Vec<RowWork> = shown
                .iter()
                .copied()
                .filter(|work| group.contains(&work.row))
                .collect();
            if in_group.is_empty() {
                continue;
            }
            let mut rows_out = Vec::new();
            for (index, work) in in_group.into_iter().enumerate() {
                let state_now = row_state(&work);
                let row = self.render_row(index, work, state_now, tidying, data, cx);
                rows_out.push(reveal.keep(
                    format!("overview-row-{}", work.row.key()),
                    row,
                    window,
                    cx,
                ));
            }
            sections.push(
                div()
                    .mt_5()
                    .flex()
                    .flex_col()
                    .child(
                        div()
                            .text_caption()
                            .font_weight(FontWeight::MEDIUM)
                            .text_color(muted)
                            .mb_1()
                            .child(title),
                    )
                    // The rows' icons level with the heading above, their hover ground reaching
                    // past it.
                    .child(div().mx(px(-8.)).flex().flex_col().children(rows_out))
                    .into_any_element(),
            );
        }

        let head = div()
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
                            .text_caption()
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
                            .text_size(px(32.))
                            .font_weight(FontWeight::SEMIBOLD)
                            .child(display)
                            .when(!tidying && pending, |this| {
                                this.child(Spinner::new().small())
                            }),
                    )
                    .child(widgets::caption(note, cx).mt(px(6.))),
            )
            .child(
                div()
                    .flex()
                    .flex_col()
                    .items_end()
                    .gap_1p5()
                    .flex_shrink_0()
                    .child(action)
                    .when_some(av1, |this, av1| {
                        this.child(
                            div()
                                .id("overview-av1-time")
                                .test_support()
                                .aria_label(SharedString::from(av1.clone()))
                                .child(widgets::caption(av1, cx)),
                        )
                    }),
            );
        let head = reveal.keep("overview-head", head, window, cx);
        let left = self
            .render_left(data, cx)
            .map(|left| reveal.keep("overview-left", left, window, cx));
        widgets::card(cx)
            .p_5()
            .child(head)
            .children(sections)
            .children(left)
            .into_any_element()
    }

    /// One row's name and what it would do.
    fn row_text(&self, work: &RowWork, data: &Tidy, cx: &App) -> (&'static str, String) {
        let state = self.state.read(cx);
        match work.row {
            PlanRow::Videos => {
                let caption = if state.av1() && work.files > 0 {
                    format!(
                        "{} · AV1, one encode each, even from MOV",
                        format::plural(work.files, "video")
                    )
                } else if work.files > 0 {
                    format!(
                        "{} · tracks MP4 can hold are copied as they are",
                        format::plural(work.files, "video")
                    )
                } else {
                    format!(
                        "Already MP4 · AV1 would make {} about {} smaller",
                        format::plural(data.shrink.files, "video"),
                        format::bytes((data.shrink.bytes - data.shrink.estimated_bytes) as f64)
                    )
                };
                ("Videos become MP4", caption)
            }
            PlanRow::Pictures => (
                "Pictures become AVIF",
                format!("{} · quality 70", format::plural(work.files, "picture")),
            ),
            PlanRow::Animations => (
                "Animations become MP4",
                format!(
                    "{} · they loop as video",
                    format::plural(work.files, "animation")
                ),
            ),
            PlanRow::SilentTracks => (
                "Silent soundtracks removed",
                format!(
                    "{} · the picture is not re-encoded",
                    format::plural(work.files, "video")
                ),
            ),
            PlanRow::CleanUp => {
                let cleanup = &data.cleanup;
                let parts = [
                    (cleanup.junk > 0).then(|| format::plural(cleanup.junk, "junk file")),
                    (cleanup.empty_folders > 0)
                        .then(|| format::plural(cleanup.empty_folders, "empty folder")),
                    (cleanup.extensions > 0)
                        .then(|| format::plural(cleanup.extensions, "wrong extension")),
                ];
                (
                    "Junk, empty folders and extensions",
                    parts.into_iter().flatten().collect::<Vec<_>>().join(" · "),
                )
            }
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn render_row(
        &self,
        index: usize,
        work: RowWork,
        row_state: RowState,
        busy: bool,
        data: &Tidy,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let theme = cx.theme().clone();
        let row = work.row;
        let key = row.key();
        let done = row_state == RowState::Done;
        let (title, caption) = self.row_text(&work, data, cx);
        let caption = if done { "Done".to_string() } else { caption };
        let focused = self.focused_row == Some(row);
        let open = self.open.contains(&row);
        let dim = row_state == RowState::Off;

        let switch_state = self.state.clone();
        let switch = oriel_ui::switch(SharedString::from(format!("overview-switch-{key}")))
            .checked(work.on)
            .disabled(busy)
            .accessibility_label(title)
            .on_click(move |on, _, cx| {
                let on = *on;
                switch_state.update(cx, |state, cx| row.set_on(state, on, cx));
            });

        let codec = (row == PlanRow::Videos).then(|| {
            let av1 = self.state.read(cx).av1();
            let choose = |id: &'static str, label: &'static str, to_av1: bool, tooltip: &str| {
                let state = self.state.clone();
                SegmentedItem::new(id, label)
                    .selected(av1 == to_av1)
                    .tooltip(tooltip.to_owned())
                    .on_click(move |_, _, cx| {
                        state.update(cx, |state, cx| state.set_av1(to_av1, cx));
                    })
            };
            Segmented::new("overview-codec", "Video codec").items([
                choose(
                    "overview-codec-keep",
                    "Keep codec",
                    false,
                    "Copy the tracks MP4 can hold as they are",
                ),
                choose(
                    "overview-codec-av1",
                    "AV1",
                    true,
                    "Re-encode to AV1: much smaller, and slow",
                ),
            ])
        });

        let saving: Option<AnyElement> = match (done, work.saving) {
            (true, _) | (_, Saving::None) => None,
            (_, Saving::Pending) => Some(Spinner::new().small().into_any_element()),
            (_, Saving::Unknown) => Some(widgets::caption("Saving unknown", cx).into_any_element()),
            (_, Saving::Known { before, after }) if before > after => Some(
                div()
                    .flex()
                    .flex_col()
                    .items_end()
                    .child(
                        div()
                            .text_body()
                            .font_weight(FontWeight::SEMIBOLD)
                            .text_color(theme.success)
                            .child(format!("−{}", format::bytes(before - after))),
                    )
                    .child(widgets::caption(
                        format!("{} → {}", format::bytes(before), format::bytes(after)),
                        cx,
                    ))
                    .into_any_element(),
            ),
            _ => Some(widgets::caption("No smaller", cx).into_any_element()),
        };

        let trailing: AnyElement = if row_state == RowState::Running {
            div()
                .size(px(32.))
                .flex()
                .items_center()
                .justify_center()
                .child(Spinner::new().small())
                .into_any_element()
        } else {
            Button::new(SharedString::from(format!("overview-more-{key}")))
                .bar_size()
                .ghost()
                .icon(Icon::new(if open {
                    IconName::ChevronDown
                } else {
                    IconName::ChevronRight
                }))
                .accessibility_label(if open { "Less" } else { "More" })
                .on_click(cx.listener(move |this, _, _, cx| this.toggle_open(row, cx)))
                .into_any_element()
        };

        let line = div()
            .id(SharedString::from(format!("overview-row-{key}")))
            .test_support()
            .aria_label(SharedString::from(format!("{title} · {caption}")))
            .aria_description(SharedString::from(row_state.key()))
            .relative()
            .flex()
            .flex_row()
            .items_center()
            .gap_3()
            .h(px(60.))
            .px_2()
            .rounded(theme.radius)
            .when(focused, |this| {
                this.bg(theme.accent).border_1().border_color(theme.ring)
            })
            .child(switch)
            .child(
                div()
                    .id(SharedString::from(format!("overview-open-{key}")))
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap_3()
                    .flex_1()
                    .min_w_0()
                    .h_full()
                    .cursor_pointer()
                    .when(dim, |this| this.opacity(0.5))
                    .on_click(cx.listener(move |this, _, _, cx| this.toggle_open(row, cx)))
                    .child(
                        widgets::row_icon(if done { IconName::Check } else { row.icon() }, cx)
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
                                    .text_body()
                                    .font_weight(FontWeight::MEDIUM)
                                    .when(done, |this| this.text_color(theme.muted_foreground))
                                    .child(title),
                            )
                            .child(widgets::caption(caption, cx).truncate()),
                    ),
            )
            .children(codec)
            .when_some(saving, |this, saving| {
                this.child(
                    div()
                        .flex_shrink_0()
                        .when(dim, |this| this.opacity(0.5))
                        .child(saving),
                )
            })
            .child(trailing);

        div()
            .flex()
            .flex_col()
            .when(index > 0, |this| {
                this.border_t_1().border_color(theme.border)
            })
            .child(line)
            .when(open, |this| this.child(self.render_detail(work, data, cx)))
            .into_any_element()
    }

    /// What a row opens to: what happens to its files, and a way to see them.
    fn render_detail(&self, work: RowWork, data: &Tidy, cx: &mut Context<Self>) -> AnyElement {
        let theme = cx.theme().clone();
        let state = self.state.read(cx);
        let mut lines: Vec<String> = Vec::new();
        let mut warning: Option<&'static str> = None;
        let preset = match work.row {
            PlanRow::Videos => {
                let split = plan::video_split(state, data);
                if split.to_av1 > 0 {
                    lines.push(match split.to_av1_from_convert {
                        0 => format!(
                            "{} encoded once to AV1 MP4",
                            format::plural(split.to_av1, "video")
                        ),
                        from => format!(
                            "{} encoded once to AV1 MP4, {} of them straight from MOV, MKV or \
                             another container",
                            format::plural(split.to_av1, "video"),
                            format::count(from)
                        ),
                    });
                    lines.push(format!(
                        "About {} of encoding · finished videos stay done if you stop",
                        format::span(data.shrink.encode_ms as f64)
                    ));
                }
                if split.remux > 0 {
                    lines.push(format!(
                        "{} copied into MP4, their tracks kept as they are",
                        format::plural(split.remux, "video")
                    ));
                }
                if split.reencode > 0 {
                    lines.push(format!(
                        "{} re-encoded into MP4, as MP4 can't hold their tracks",
                        format::plural(split.reencode, "video")
                    ));
                }
                if !state.av1() && data.shrink.files > 0 {
                    lines.push(format!(
                        "AV1 would make {} about {} smaller, but takes about {}",
                        format::plural(data.shrink.files, "video"),
                        format::bytes((data.shrink.bytes - data.shrink.estimated_bytes) as f64),
                        format::span(data.shrink.encode_ms as f64)
                    ));
                }
                // Oriel encodes video only through ffmpeg.
                if state
                    .capabilities()
                    .is_some_and(|found| !found.video.avc && !found.ffmpeg)
                {
                    warning = Some("No H.264 encoder on this machine");
                }
                LibraryPreset {
                    kinds: vec![FileKind::Video],
                    flags: vec![FileFlag::Convertible],
                    ..LibraryPreset::default()
                }
            }
            PlanRow::Pictures => {
                lines.push("AVIF at quality 70 · HEIC and TIFF stay as they are".into());
                LibraryPreset {
                    kinds: vec![FileKind::Image],
                    flags: vec![FileFlag::Convertible],
                    ..LibraryPreset::default()
                }
            }
            PlanRow::Animations => {
                lines.push("GIFs and animated WebP become MP4 that loop".into());
                LibraryPreset {
                    kinds: vec![FileKind::Image],
                    flags: vec![FileFlag::Convertible],
                    ..LibraryPreset::default()
                }
            }
            PlanRow::SilentTracks => {
                lines.push("Soundtracks measured as pure silence are taken out".into());
                let analysis = data.analysis;
                if analysis.sound_measured < analysis.sound_measurable {
                    lines.push(format!(
                        "Still measuring soundtracks · {} of {}",
                        format::count(analysis.sound_measured),
                        format::count(analysis.sound_measurable)
                    ));
                }
                LibraryPreset {
                    kinds: vec![FileKind::Video],
                    audio_states: vec![AudioState::Silent],
                    ..LibraryPreset::default()
                }
            }
            PlanRow::CleanUp => {
                let cleanup = &data.cleanup;
                if cleanup.junk > 0 {
                    lines.push(format!(
                        "{} to holding: .DS_Store, Thumbs.db, ._ files",
                        format::plural(cleanup.junk, "junk file")
                    ));
                }
                if cleanup.empty_folders > 0 {
                    lines.push(format!(
                        "{} removed, with folders that held only junk",
                        format::plural(cleanup.empty_folders, "empty folder")
                    ));
                }
                if cleanup.extensions > 0 {
                    lines.push(format!(
                        "{} renamed to match what the file is",
                        format::plural(cleanup.extensions, "wrong extension")
                    ));
                }
                LibraryPreset {
                    flags: vec![if cleanup.junk > 0 {
                        FileFlag::Junk
                    } else {
                        FileFlag::ExtensionMismatch
                    }],
                    ..LibraryPreset::default()
                }
            }
        };
        let key = work.row.key();
        div()
            .id(SharedString::from(format!("overview-detail-{key}")))
            .test_support()
            .flex()
            .flex_col()
            .gap_1()
            // Under the row's name: past the switch and the icon.
            .pl(px(8. + 44. + 12. + 32. + 12.))
            .pr_2()
            .pb_3()
            .children(lines.into_iter().map(|line| widgets::caption(line, cx)))
            .when_some(warning, |this, warning| {
                this.child(
                    div()
                        .text_caption()
                        .text_color(theme.warning)
                        .child(warning),
                )
            })
            .child(
                div().child(
                    Button::new(SharedString::from(format!("overview-library-{key}")))
                        .text()
                        .row_size()
                        .label("Show in Library")
                        .on_click(cx.listener(move |this, _, _, cx| {
                            let preset = preset.clone();
                            this.state
                                .update(cx, |state, cx| state.open_library(preset, cx));
                        })),
                ),
            )
            .into_any_element()
    }

    /// The files Convert leaves as they are, and why, under a link that lists them.
    fn render_left(&self, data: &Tidy, cx: &mut Context<Self>) -> Option<AnyElement> {
        let reasons: Vec<String> = data
            .convert
            .skipped
            .iter()
            .filter(|entry| entry.files > 0)
            .map(|entry| crate::labels::skip_reason(&entry.reason, entry.files, None))
            .collect();
        let left: i64 = data.convert.skipped.iter().map(|entry| entry.files).sum();
        if left == 0 {
            return None;
        }
        let open = self.left_open;
        Some(
            div()
                .id("overview-left")
                .test_support()
                .mt_4()
                .flex()
                .flex_col()
                .child(
                    div().child(
                        Button::new("overview-left-link")
                            .text()
                            .row_size()
                            .label(format!("{} left as they are", format::plural(left, "file")))
                            .on_click(cx.listener(|this, _, _, cx| {
                                this.left_open = !this.left_open;
                                cx.notify();
                            })),
                    ),
                )
                .when(open, |this| this.child(widgets::left_list(&reasons, cx)))
                .into_any_element(),
        )
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
        } else if similar.sets > 0 && similar_job {
            // The number moves until the comparing ends, so it says so.
            (
                format!("{sets_line} so far"),
                Some(format!("{bytes_line} · still checking")),
            )
        } else if similar.sets > 0 {
            (
                sets_line,
                Some(match unchecked {
                    true => format!("{bytes_line} · some files are not checked yet"),
                    false => bytes_line,
                }),
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
                    .relative()
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
                        radius,
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
                .gap_3()
                .px_5()
                .py_4()
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
                                .text_body()
                                .font_weight(FontWeight::MEDIUM)
                                .when(looking && similar_job, |this| {
                                    this.child(Spinner::new().small())
                                })
                                .child(div().min_w_0().line_clamp(2).child(title)),
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
                            .bar_size()
                            .outline()
                            .quiet_edge(cx)
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
                            .bar_size()
                            .outline()
                            .quiet_edge(cx)
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
                .gap_3()
                .px_5()
                .py_4()
                .child(widgets::row_icon(IconName::Copy, cx))
                .child(
                    div()
                        .flex()
                        .flex_col()
                        .flex_1()
                        .min_w_0()
                        .child(
                            div()
                                .text_body()
                                .font_weight(FontWeight::MEDIUM)
                                .child(title),
                        )
                        .child(widgets::caption("Choose which folders keep each one", cx).mt_0p5()),
                )
                .child(
                    Button::new("overview-review-identical")
                        .bar_size()
                        .outline()
                        .quiet_edge(cx)
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

    /// A row that opens a page: holding.
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
                    .h(px(60.))
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
                                    .text_body()
                                    .font_weight(FontWeight::MEDIUM)
                                    .child(title),
                            )
                            .child(widgets::caption(caption, cx).truncate()),
                    )
                    .child(
                        Icon::new(IconName::ChevronRight)
                            .size(px(20.))
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
            .text_body()
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
                .row_size()
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

/// What a scan finds that needs a look, and the Library filter that shows it.
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
            format!("{} Pane View can't resize", format::plural(count, "file")),
            formats(&[FileFormat::Matroska, FileFormat::Bmp]),
        ),
        FindingKind::UnconvertibleVideo => (
            format!("{} can't become MP4", format::plural(count, "file")),
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
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let top_bar = self.render_top_bar(cx);
        let state = self.state.read(cx);
        let root = state.root().cloned();
        let data = state.overview().cloned();
        let error = state.overview_error().cloned();
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
                // What Tab lands on stays in sight, however far down the page it is.
                let reveal = FocusReveal::of("overview-reveal", px(0.), window, cx);
                let hero = self.render_hero(&data, &reveal, window, cx);
                let look = self.render_look_card(&data, cx);
                let identical = self.render_identical_card(&data, cx);
                let held = self
                    .state
                    .read(cx)
                    .holding_preview()
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
                // What Tab lands on stays in sight, however far down the page it is.
                // The plan keeps its own rows in sight, as it can be taller than the window.
                let cards: Vec<AnyElement> = std::iter::once(hero)
                    .chain(
                        [look, identical, holding, attention]
                            .into_iter()
                            .flatten()
                            .enumerate()
                            .map(|(index, card)| {
                                reveal.keep(format!("overview-{index}"), card, window, cx)
                            }),
                    )
                    .collect();
                div()
                    .id("overview-scroll")
                    .test_support()
                    .flex_1()
                    .min_h_0()
                    .overflow_y_scroll()
                    .track_scroll(reveal.scroll())
                    .child(
                        div()
                            .mx_auto()
                            .w_full()
                            .max_w(widgets::PAGE_COLUMN)
                            .flex()
                            .flex_col()
                            .gap_4()
                            .px_6()
                            .pt_6()
                            .pb(px(112.))
                            .children(cards),
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
