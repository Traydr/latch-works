//! Holding: what Tidy's changes moved aside, grouped by the change that
//! held them, until the owner restores them (⌘⌫) or empties holding to the Trash (⇧⌘⌫). Click
//! picks one, ⌘-click adds or removes one, ⇧-click picks a run; the arrows move a cursor from
//! tile to tile, across the changes' headings, picking the tile or with ⇧ the run from the
//! anchor; Escape clears. Space or a double-click shows a held file in Quick Look, and each tile
//! has its own Restore.
//!
//! Holding is drawn a screen at a time ([`crate::windowed`]): each change's heading and each
//! line of its tiles are items of one column, broken into lines as the tiles would wrap.

use std::cell::RefCell;
use std::collections::{BTreeSet, HashMap};
use std::ops::Range;
use std::path::Path;
use std::rc::Rc;

use gpui_kit::assets::IconName;
use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::{ActiveTheme as _, Disableable as _, Icon};
use gpui_kit::{
    AnyElement, App, Bounds, Context, Entity, FocusHandle, Focusable, FontWeight,
    InteractiveElement as _, IntoElement, KeyDownEvent, MouseDownEvent, ObjectFit,
    ParentElement as _, Pixels, Point, Render, SharedString, StatefulInteractiveElement as _,
    Styled as _, Subscription, TestSupportExt as _, Window, canvas, div,
    prelude::FluentBuilder as _, px,
};
use oriel_core_domain::format;
use oriel_core_domain::{MediaType, detect_media_type};
use oriel_ui::TextRole as _;
use oriel_ui::ToastExt as _;
use oriel_ui::focus::FocusReveal;
use oriel_ui::{ControlSize as _, Toast, TopBar};

use crate::actions::Ended;
use crate::labels::{file_name, relative_to};
use crate::loaded::{Loaded, PageReads};
use crate::pages::TidyPage;
use crate::quick_look::quick_look;
use crate::state::TidyState;
use crate::thumbs::{Thumb, Thumbs};
use crate::widgets;
use crate::windowed::{Piece, Windowed};
use oriel_core_tidy::contract::{
    HoldingId, HoldingItem, HoldingList, HoldingRequest, PlanId, PlanListRequest, PlanSummary,
};

/// Holding can hold tens of thousands of files; they come a page at a time.
const PAGE: usize = 300;

/// A tile's width.
const TILE: f32 = 216.;

/// A picture taller than this against its width shows whole on its tile.
const TALL_PICTURE: f32 = 1.6;

/// The change that put a run of files in holding, or none for files held on their own.
struct Group {
    plan_id: Option<PlanId>,
    items: Vec<HoldingItem>,
}

/// The held files as Holding shows them, grouped once per answer.
struct Held {
    /// Every file, in the order shown: each change's files together, in the order the first of
    /// each came.
    ordered: Vec<HoldingItem>,
    /// Each change's run of `ordered`.
    groups: Vec<(Option<PlanId>, Range<usize>)>,
}

impl Held {
    fn of(items: &[HoldingItem]) -> Self {
        let mut ordered = Vec::with_capacity(items.len());
        let mut groups = Vec::new();
        for group in group_items(items) {
            let start = ordered.len();
            ordered.extend(group.items);
            groups.push((group.plan_id, start..ordered.len()));
        }
        Self { ordered, groups }
    }
}

/// One item of Holding's column.
enum Item {
    /// The heading of a change's files.
    Title(usize),
    /// A line of a change's tiles, as they wrap.
    Line {
        files: Range<usize>,
        first: bool,
        last: bool,
    },
    /// The button that shows more, or the note under the last file.
    More,
    Note,
}

/// What an item's height follows: every heading is as tall as the next, and so is every line
/// but for the space above the first and below the last.
#[derive(Clone, PartialEq, Eq, Hash)]
enum ItemKey {
    Title,
    Line { first: bool, last: bool },
    More,
    Note,
}

fn group_items(items: &[HoldingItem]) -> Vec<Group> {
    let mut groups: Vec<Group> = Vec::new();
    let mut index: HashMap<Option<PlanId>, usize> = HashMap::new();
    for item in items {
        match index.get(&item.plan_id) {
            Some(&at) => groups[at].items.push(item.clone()),
            None => {
                index.insert(item.plan_id, groups.len());
                groups.push(Group {
                    plan_id: item.plan_id,
                    items: vec![item.clone()],
                });
            }
        }
    }
    groups
}

pub struct HoldingPage {
    reveal: FocusReveal,
    state: Entity<TidyState>,
    thumbs: Entity<Thumbs>,
    focus: FocusHandle,
    holding: Loaded<HoldingList>,
    /// The answer as Holding shows it.
    held: Option<Rc<Held>>,
    plans: Loaded<Vec<PlanSummary>>,
    wanted: usize,
    selected: BTreeSet<HoldingId>,
    anchor: Option<HoldingId>,
    /// The keyboard cursor: the tile the arrows move from, Space looks at, and the ring marks.
    cursor: Option<HoldingId>,
    /// The cursor moved by key, so the next frame scrolls its tile into view.
    reveal_cursor: bool,
    /// Tiles to a line as last laid out, which ↑ ↓ move across.
    columns: usize,
    /// A tile's width: the columns share the page's whole width between them.
    tile_width: f32,
    busy: bool,
    /// Where a press does nothing for a moment: where a restored tile or the selection bar was.
    bar: widgets::SelectionBar,
    /// The selection bar and each tile where last drawn.
    tile_bounds: Rc<RefCell<HashMap<HoldingId, Bounds<Pixels>>>>,
    reads: PageReads,
    /// How much narrower than the window the column was when last laid out, and the window's
    /// width then, so a line holds as many tiles as fit before the column is laid out again.
    margin: Option<f32>,
    window_width: f32,
    _subscriptions: Vec<Subscription>,
}

impl HoldingPage {
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
            holding: Loaded::default(),
            held: None,
            plans: Loaded::default(),
            wanted: PAGE,
            selected: BTreeSet::new(),
            anchor: None,
            cursor: None,
            reveal_cursor: false,
            columns: 1,
            tile_width: TILE,
            busy: false,
            bar: widgets::SelectionBar::default(),
            tile_bounds: Rc::default(),
            reads: PageReads::default(),
            margin: None,
            window_width: 0.,
            _subscriptions: subscriptions,
        }
    }

    fn sync(&mut self, cx: &mut Context<Self>) {
        cx.notify();
        let Some(read) = self.reads.due(TidyPage::Holding, self.state.read(cx)) else {
            return;
        };
        if read.root_changed {
            self.selected.clear();
            self.wanted = PAGE;
        }
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
        let request = HoldingRequest {
            root_id,
            offset: 0,
            limit: self.wanted as i64,
        };
        let holding = engine.ask(|engine| engine.list_holding(request), cx);
        self.holding
            .load_then(holding, |this| &mut this.holding, Self::loaded, cx);
        let request = PlanListRequest {
            root_id: Some(root_id),
            offset: 0,
            limit: 500,
        };
        let plans = engine.ask(|engine| engine.list_plans(request), cx);
        self.plans.load(plans, |this| &mut this.plans, cx);
        cx.notify();
    }

    fn loaded(&mut self, _: &mut Context<Self>) {
        self.held = self
            .holding
            .data()
            .map(|list| Rc::new(Held::of(&list.items)));
    }

    /// Every held file listed, in the order shown.
    fn ordered(&self) -> &[HoldingItem] {
        self.held
            .as_ref()
            .map_or(&[], |held| held.ordered.as_slice())
    }

    /// Whether a press at `position` would do nothing yet.
    pub fn holds_press_at(&self, position: Point<Pixels>, cx: &App) -> bool {
        self.bar.holds(position, cx)
    }

    /// How much of the window's foot the page keeps for the selection bar, while it shows.
    pub fn foot_height(&self) -> f32 {
        self.bar.foot_height(!self.selected.is_empty())
    }

    /// ⌘A: every held file listed.
    pub fn select_all(&mut self, cx: &mut Context<Self>) {
        self.selected = self.ordered().iter().map(|item| item.id).collect();
        cx.notify();
    }

    fn select(&mut self, id: HoldingId, command: bool, shift: bool, cx: &mut Context<Self>) {
        self.cursor = Some(id);
        let held = self.held.clone();
        let ordered = held
            .as_ref()
            .map_or(&[][..], |held| held.ordered.as_slice());
        let position = |id: HoldingId| ordered.iter().position(|item| item.id == id);
        let Some(at) = position(id) else {
            return;
        };
        let (selected, anchor) = crate::selection::click(
            &self.selected,
            self.anchor.and_then(position),
            at,
            command,
            shift,
            |at| ordered.get(at).map(|item| item.id),
        );
        self.selected = selected;
        self.anchor = anchor.and_then(|at| ordered.get(at)).map(|item| item.id);
        cx.notify();
    }

    /// Where an arrow moves the cursor: the next or previous tile for ← →; for ↑ ↓ the tile in
    /// the line above or below, the nearest to the cursor's column, across a change's heading.
    /// The first tile when there is no cursor yet.
    fn neighbour(&self, key: &str) -> Option<HoldingId> {
        let held = self.held.as_ref()?;
        let ordered = &held.ordered;
        let Some(at) = self
            .cursor
            .and_then(|cursor| ordered.iter().position(|item| item.id == cursor))
        else {
            return ordered.first().map(|item| item.id);
        };
        let columns = self.columns.max(1);
        let target = match key {
            "right" => (at + 1).min(ordered.len() - 1),
            "left" => at.saturating_sub(1),
            "down" | "up" => {
                // Each change's tiles wrap on their own, so lines are counted within a group.
                let lines: Vec<std::ops::Range<usize>> = held
                    .groups
                    .iter()
                    .flat_map(|(_, files)| {
                        files
                            .clone()
                            .step_by(columns)
                            .map(move |start| start..(start + columns).min(files.end))
                    })
                    .collect();
                let line = lines.iter().position(|line| line.contains(&at))?;
                let column = at - lines[line].start;
                let next = if key == "down" {
                    lines.get(line + 1)
                } else {
                    line.checked_sub(1).and_then(|line| lines.get(line))
                };
                match next {
                    Some(next) => (next.start + column).min(next.end - 1),
                    None => at,
                }
            }
            _ => return None,
        };
        ordered.get(target).map(|item| item.id)
    }

    /// Moves the cursor to a tile, picking it alone or, with ⇧, the run from the anchor.
    fn move_cursor(&mut self, target: HoldingId, extend: bool, cx: &mut Context<Self>) {
        let start = self.anchor.or(self.cursor).unwrap_or(target);
        self.cursor = Some(target);
        self.reveal_cursor = true;
        if extend {
            let ordered = self.ordered();
            let position = |id: HoldingId| ordered.iter().position(|item| item.id == id);
            if let (Some(from), Some(to)) = (position(start), position(target)) {
                self.selected = ordered[from.min(to)..=from.max(to)]
                    .iter()
                    .map(|item| item.id)
                    .collect();
            }
            self.anchor = Some(start);
        } else {
            self.selected = BTreeSet::from([target]);
            self.anchor = Some(target);
        }
        cx.notify();
    }

    /// Restores `ids`, in its turn behind the changes asked for before, and scans where they went
    /// back. A press brought it from `place`, where what comes under the pointer next is not what
    /// that press meant, so a press there waits a moment.
    fn restore(
        &mut self,
        ids: Vec<HoldingId>,
        place: Option<Bounds<Pixels>>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if ids.is_empty() || self.busy {
            return;
        }
        let Some(work) = self
            .state
            .read(cx)
            .engine()
            .map(|engine| engine.queue(|engine| engine.restore_holding(ids)))
        else {
            return;
        };
        self.busy = true;
        let page = cx.entity().downgrade();
        self.state.update(cx, |state, cx| {
            state.run_holding_work(
                "Restore",
                work,
                move |state, ended, window, cx| {
                    page.update(cx, |this, cx| {
                        this.busy = false;
                        if let Some(place) = place {
                            this.bar.arm(place, cx);
                        }
                        this.selected.clear();
                        cx.notify();
                    })
                    .ok();
                    let toast = match ended {
                        Ended::Withdrawn | Ended::Stopped => return,
                        Ended::Done(result) => {
                            state.follow_up(result.follow_up, window, cx);
                            if result.failed.is_empty() {
                                Toast::done(format!(
                                    "Restored {}",
                                    format::plural(result.restored, "file")
                                ))
                            } else {
                                Toast::error(format!(
                                    "Restored {}; {} could not go back",
                                    format::plural(result.restored, "file"),
                                    format::count(result.failed.len() as i64)
                                ))
                                .detail(result.failed[0].clone())
                            }
                        }
                        Ended::Failed(error) => Toast::error("Couldn't restore the files")
                            .detail(crate::actions::job_message(&error)),
                    };
                    window.show_toast(toast, cx);
                },
                window,
                cx,
            );
        });
    }

    /// Empties holding into the system Trash, without asking: the Trash is the safety net, as
    /// Finder's Move to Trash is. It waits its turn behind the changes asked for before it, so an
    /// Undo queued first still finds what it needs.
    fn empty(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let state = self.state.read(cx);
        let (Some(root_id), Some(list), Some(engine)) =
            (state.root_id(), self.holding.data(), state.engine())
        else {
            return;
        };
        if self.busy || list.total == 0 {
            return;
        }
        let bytes = list.total_bytes;
        let work = engine.queue(|engine| engine.empty_holding(root_id));
        self.busy = true;
        let page = cx.entity().downgrade();
        self.state.update(cx, |state, cx| {
            state.run_holding_work(
                "Empty holding",
                work,
                move |_, ended, window, cx| {
                    page.update(cx, |this, cx| {
                        this.busy = false;
                        this.selected.clear();
                        cx.notify();
                    })
                    .ok();
                    let toast = match ended {
                        Ended::Withdrawn | Ended::Stopped => return,
                        Ended::Done(result) if result.failed.is_empty() => Toast::done(format!(
                            "Moved {} to the Trash",
                            format::plural(result.emptied, "file")
                        ))
                        .detail(format!(
                            "{} freed once the Trash is emptied",
                            format::bytes(bytes)
                        )),
                        Ended::Done(result) => Toast::error(format!(
                            "{} stayed in holding",
                            format::plural_as(result.failed.len() as i64, "batch", "batches")
                        ))
                        .detail(result.failed[0].clone()),
                        Ended::Failed(error) => Toast::error("Couldn't empty holding")
                            .detail(crate::actions::job_message(&error)),
                    };
                    window.show_toast(toast, cx);
                },
                window,
                cx,
            );
        });
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
        if oriel_ui::keys::command_held(&keys.modifiers) && keys.key == "backspace" {
            if keys.modifiers.shift {
                self.empty(window, cx);
            } else {
                let ids = self.selected.iter().copied().collect();
                self.restore(ids, None, window, cx);
            }
        } else if keys.key == "escape" && !self.selected.is_empty() {
            self.selected.clear();
            cx.notify();
        } else if matches!(keys.key.as_str(), "left" | "right" | "up" | "down")
            && !(keys.modifiers.platform || keys.modifiers.control || keys.modifiers.alt)
        {
            let Some(target) = self.neighbour(&keys.key) else {
                return;
            };
            self.move_cursor(target, keys.modifiers.shift, cx);
        } else if keys.key == "space" && !keys.modifiers.modified() {
            // The cursor's file, else the first chosen, as Finder's Space previews it.
            let held = self.held.clone();
            let ordered = held
                .as_ref()
                .map_or(&[][..], |held| held.ordered.as_slice());
            let target = self
                .cursor
                .and_then(|cursor| ordered.iter().find(|item| item.id == cursor))
                .or_else(|| ordered.iter().find(|item| self.selected.contains(&item.id)));
            let Some(target) = target else {
                return;
            };
            quick_look(Path::new(&target.hold_path), window, cx);
        } else {
            return;
        }
        cx.stop_propagation();
    }

    fn render_tile(&self, item: &HoldingItem, root: &str, cx: &mut Context<Self>) -> AnyElement {
        let name = file_name(&item.original_path).to_string();
        let video = detect_media_type(&name) == MediaType::Video;
        let thumb = self.thumbs.update(cx, |thumbs, cx| {
            thumbs.path(Path::new(&item.hold_path), video, 512, cx)
        });
        let theme = cx.theme();
        let selected = self.selected.contains(&item.id);
        // The keyboard cursor's tile carries the screen's one ring in the accent colour.
        let current = self.cursor == Some(item.id);
        let picture: AnyElement = match thumb {
            Thumb::Ready(image) => {
                // A restore is decided on what shows: a tall picture is seen whole on the tile's
                // ground, not by its middle.
                let shape = image.size(0);
                let tall = shape.height.0 as f32 > shape.width.0 as f32 * TALL_PICTURE;
                let fit = if tall {
                    ObjectFit::Contain
                } else {
                    ObjectFit::Cover
                };
                crate::thumbs::painted(image, fit, theme.radius)
            }
            _ => div()
                .size_full()
                .flex()
                .items_center()
                .justify_center()
                .text_color(theme.muted_foreground)
                .child(Icon::new(if video {
                    IconName::Film
                } else {
                    IconName::Image
                }))
                .into_any_element(),
        };
        let relative = relative_to(root, &item.original_path);
        let id = item.id;
        div()
            .id(("held", id as u64))
            .test_support()
            .aria_label(SharedString::from(name.clone()))
            .aria_selected(selected)
            .w(px(self.tile_width))
            .flex()
            .flex_col()
            .p_1()
            .rounded(theme.radius_lg)
            .relative()
            .child({
                let tiles = self.tile_bounds.clone();
                canvas(
                    move |bounds, _, _| {
                        tiles.borrow_mut().insert(id, bounds);
                    },
                    |_, _, _, _| {},
                )
                .absolute()
                .size_full()
            })
            .group("held-tile")
            .border_2()
            .border_color(if current {
                theme.ring
            } else if selected {
                theme.primary
            } else {
                theme.transparent
            })
            .cursor_pointer()
            .tooltip({
                let tooltip = SharedString::from(format!("{relative}\n{}", item.reason));
                move |window, cx| {
                    gpui_kit::component::tooltip::Tooltip::new(tooltip.clone()).build(window, cx)
                }
            })
            .on_click({
                let held = item.hold_path.clone();
                cx.listener(move |this, event: &gpui_kit::ClickEvent, window, cx| {
                    if event.click_count() >= 2 {
                        quick_look(Path::new(&held), window, cx);
                        return;
                    }
                    let modifiers = event.modifiers();
                    this.select(
                        id,
                        oriel_ui::keys::command_held(&modifiers),
                        modifiers.shift,
                        cx,
                    );
                })
            })
            .child(
                div()
                    .relative()
                    .h(px(168.))
                    .rounded(theme.radius)
                    .overflow_hidden()
                    .bg(theme.muted)
                    .child(picture),
            )
            .child(
                div()
                    .absolute()
                    .top(px(10.))
                    .right(px(10.))
                    .invisible()
                    .group_hover("held-tile", |style| style.visible())
                    .child(
                        Button::new(("restore-held", id as u64))
                            .row_size()
                            .outline()
                            .quiet_edge(cx)
                            .label("Restore")
                            .disabled(self.busy)
                            .on_click(cx.listener(
                                move |this, event: &gpui_kit::ClickEvent, window, cx| {
                                    cx.stop_propagation();
                                    if event.click_count() == 1 {
                                        let place = this.tile_bounds.borrow().get(&id).copied();
                                        this.restore(vec![id], place, window, cx);
                                    }
                                },
                            )),
                    ),
            )
            .child(
                div()
                    .px_0p5()
                    .pt(px(6.))
                    .child(div().truncate().text_body().child(name))
                    .child(
                        widgets::caption(
                            format!(
                                "{} · {}",
                                format::bytes(item.size),
                                format::time(item.held_at)
                            ),
                            cx,
                        )
                        .truncate(),
                    ),
            )
            .into_any_element()
    }
}

/// What the top bar and the end of the column count.
struct HoldingCounts {
    total: i64,
    total_bytes: i64,
    listed: usize,
}

impl HoldingPage {
    /// The held files by the change that held them: only the headings and lines on screen are
    /// drawn, in a column that scrolls as if all were; the pictures of the lines just past the
    /// screen are asked for ahead.
    fn render_held(
        &mut self,
        root: &str,
        has_more: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let Some(held) = self.held.clone() else {
            return div().flex_1().into_any_element();
        };
        // The column's own scroll lives as long as it is drawn frame after frame, as the
        // scrolling element's would: Holding shown again starts at the top.
        let column = window.use_keyed_state("holding-column", cx, |_, _| Windowed::default());
        let scroll = column.read(cx).scroll().clone();
        // As many tiles to a line as wrap there: the column is as much narrower than the window
        // as it was when last laid out, or than the window less the sidebar before then.
        let window_width = f32::from(window.viewport_size().width);
        let laid_out = f32::from(scroll.bounds().size.width);
        if laid_out > 0. && self.window_width > 0. {
            self.margin = Some(self.window_width - laid_out);
        }
        self.window_width = window_width;
        let margin = self.margin.unwrap_or_else(|| {
            if self.state.read(cx).shell().read(cx).rail() {
                oriel_ui::layout::RAIL_WIDTH
            } else {
                oriel_ui::layout::SIDEBAR_WIDTH
            }
        });
        // The column's sides (`px_5`) and the space between tiles (`gap_x_3`), in rems.
        let rem = f32::from(window.rem_size());
        let (inner, gap) = (window_width - margin - 2.5 * rem, 0.75 * rem);
        let columns = (((inner + gap) / (TILE + gap)).floor() as usize).max(1);
        self.columns = columns;
        self.tile_width = (inner - gap * (columns - 1) as f32) / columns as f32;
        let mut items = Vec::new();
        for (group, (_, files)) in held.groups.iter().enumerate() {
            items.push(Item::Title(group));
            let mut start = files.start;
            while start < files.end {
                let end = (start + columns).min(files.end);
                items.push(Item::Line {
                    files: start..end,
                    first: start == files.start,
                    last: end == files.end,
                });
                start = end;
            }
        }
        items.push(if has_more { Item::More } else { Item::Note });
        let keys: Vec<ItemKey> = items
            .iter()
            .map(|item| match item {
                Item::Title(_) => ItemKey::Title,
                Item::Line { first, last, .. } => ItemKey::Line {
                    first: *first,
                    last: *last,
                },
                Item::More => ItemKey::More,
                Item::Note => ItemKey::Note,
            })
            .collect();
        // The line the cursor moved onto by key comes into view, as little as it takes.
        let cursor_line = std::mem::take(&mut self.reveal_cursor)
            .then(|| {
                let at = self
                    .cursor
                    .and_then(|cursor| held.ordered.iter().position(|item| item.id == cursor))?;
                items.iter().position(
                    |item| matches!(item, Item::Line { files, .. } if files.contains(&at)),
                )
            })
            .flatten();
        let (pieces, near) = column.update(cx, |column, _| {
            if let Some(line) = cursor_line {
                column.reveal(line);
            }
            column.plan(&keys, |index| guess(&keys[index]), 0., NEAR, window)
        });
        // The lines just past the screen: their pictures are asked for after those on it.
        let ahead: Vec<&HoldingItem> = near
            .into_iter()
            .filter_map(|index| match &items[index] {
                Item::Line { files, .. } => Some(&held.ordered[files.clone()]),
                _ => None,
            })
            .flatten()
            .collect();
        let plans: HashMap<PlanId, &PlanSummary> = self
            .plans
            .data()
            .map(|plans| plans.iter().map(|plan| (plan.id, plan)).collect())
            .unwrap_or_default();
        let now = format::now_ms();
        let muted = cx.theme().muted_foreground;
        let mut children = Vec::new();
        for piece in pieces {
            match piece {
                Piece::Room(height) => children.push(Piece::room(height)),
                Piece::Item(index) => match &items[index] {
                    Item::Title(group) => {
                        let (plan_id, files) = &held.groups[*group];
                        let title = match plan_id {
                            None => "Moved to holding".to_string(),
                            Some(id) => {
                                let plan = plans.get(id);
                                let when = plan.map_or_else(
                                    || held.ordered.get(files.start).map_or(0, |item| item.held_at),
                                    |plan| plan.created_at,
                                );
                                format!(
                                    "{} · {} {}",
                                    plan.map_or("Earlier change", |plan| plan.title.as_str()),
                                    format::day(when, now),
                                    format::time(when)
                                )
                            }
                        };
                        children.push(
                            div()
                                .flex()
                                .items_center()
                                .h(px(44.))
                                .text_body()
                                .font_weight(FontWeight::MEDIUM)
                                .child(title)
                                .into_any_element(),
                        );
                    }
                    Item::Line { files, first, last } => {
                        let tiles: Vec<AnyElement> = held.ordered[files.clone()]
                            .iter()
                            .map(|item| self.render_tile(item, root, cx))
                            .collect();
                        // The tiles' wrapping grid's spacing (`tile_grid`), line by line.
                        children.push(
                            div()
                                .flex()
                                .flex_row()
                                .gap_x_3()
                                .when(*first, |this| this.pt_1())
                                .map(|this| if *last { this.pb_6() } else { this.pb_4() })
                                .children(tiles)
                                .into_any_element(),
                        );
                    }
                    Item::More => children.push(
                        Button::new("holding-more")
                            .bar_size()
                            .outline()
                            .quiet_edge(cx)
                            .label("Show more")
                            .on_click(cx.listener(|this, _, _, cx| {
                                this.wanted += PAGE;
                                this.reload(cx);
                            }))
                            .into_any_element(),
                    ),
                    Item::Note => children.push(
                        div()
                            .mx_auto()
                            .max_w(px(560.))
                            .pt_4()
                            .text_center()
                            .text_caption()
                            .text_color(muted)
                            .child(
                                "Files here stay recoverable until you empty them. To bring \
                                 Pane View in line afterwards, run lockstep plan, then push \
                                 and prune.",
                            )
                            .into_any_element(),
                    ),
                },
            }
        }
        if !ahead.is_empty() {
            self.thumbs.update(cx, |thumbs, cx| {
                for item in ahead {
                    let video =
                        detect_media_type(file_name(&item.original_path)) == MediaType::Video;
                    thumbs.path(Path::new(&item.hold_path), video, 512, cx);
                }
            });
        }
        // What Tab lands on stays in sight, as the arrows' tile does.
        self.reveal = self.reveal.over(&scroll);
        let reveal = self.reveal.clone();
        let children: Vec<AnyElement> = children
            .into_iter()
            .enumerate()
            .map(|(index, child)| reveal.keep(format!("holding-{index}"), child, window, cx))
            .collect();
        div()
            .id("holding-scroll")
            .test_support()
            .flex_1()
            .min_h_0()
            .overflow_y_scroll()
            .track_scroll(&scroll)
            .px_5()
            .pb(px(112.))
            .children(children)
            .into_any_element()
    }
}

/// How far past the screen, above and below, the pictures of lines are asked for ahead.
const NEAR: f32 = 200.;

/// An item's height until it has been drawn, on the short side, so the first frame draws at
/// least a screen: a heading, a line of tiles, the button or the note.
fn guess(key: &ItemKey) -> f32 {
    match key {
        ItemKey::Title => 36.,
        ItemKey::Line { .. } => 150.,
        ItemKey::More => 28.,
        ItemKey::Note => 32.,
    }
}

impl Focusable for HoldingPage {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}

impl Render for HoldingPage {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let state = self.state.read(cx);
        let shell = state.shell().clone();
        let root = state
            .root()
            .map(|root| root.path.clone())
            .unwrap_or_default();
        let list = self.holding.data().map(|list| HoldingCounts {
            total: list.total,
            total_bytes: list.total_bytes,
            listed: list.items.len(),
        });
        let total = list.as_ref().map_or(0, |list| list.total);
        let meta = list.as_ref().filter(|list| list.total > 0).map(|list| {
            format!(
                "{} · {}",
                format::plural(list.total, "file"),
                format::bytes(list.total_bytes)
            )
        });
        let top_bar = TopBar::new(&shell, TidyPage::Holding.label())
            .when_some(meta, |bar, meta| {
                bar.quiet(widgets::caption(meta, cx).min_w_0().truncate())
            })
            .when(total > 0, |bar| {
                bar.trailing(
                    Button::new("holding-empty")
                        .bar_size()
                        .outline()
                        .danger()
                        .label("Empty to Trash")
                        .tooltip(oriel_ui::keys::labelled(
                            "Empty to Trash",
                            "cmd-shift-backspace",
                        ))
                        .disabled(self.busy)
                        .on_click(cx.listener(|this, _, window, cx| this.empty(window, cx))),
                )
            });

        let body: AnyElement = match (&list, self.holding.error()) {
            (None, Some(error)) => widgets::empty_state(
                "holding-error",
                Some(IconName::Archive),
                error.clone(),
                None,
                Vec::new(),
                cx,
            )
            .into_any_element(),
            (None, None) => div().flex_1().into_any_element(),
            (Some(list), _) if list.total == 0 => widgets::empty_state(
                "holding-empty-state",
                Some(IconName::Archive),
                "Holding is empty",
                Some(
                    "Removed files and replaced originals wait here until you empty them to the \
                     Trash."
                        .into_any_element(),
                ),
                Vec::new(),
                cx,
            )
            .into_any_element(),
            (Some(list), _) => {
                let has_more = list.listed < list.total as usize;
                self.render_held(&root, has_more, window, cx)
            }
        };

        let chosen: Vec<&HoldingItem> = self
            .ordered()
            .iter()
            .filter(|item| self.selected.contains(&item.id))
            .collect();
        let bar = (!chosen.is_empty()).then(|| {
            let ids: Vec<HoldingId> = chosen.iter().map(|item| item.id).collect();
            let reveal = chosen.first().map(|item| item.hold_path.clone());
            let restore = Button::new("holding-restore")
                .bar_size()
                .primary()
                .label(format!("Restore {}", format::count(chosen.len() as i64)))
                .loading(self.busy)
                .tooltip(oriel_ui::keys::labelled("Restore", "cmd-backspace"))
                .disabled(self.busy)
                .on_click(cx.listener(move |this, _, window, cx| {
                    let place = Some(this.bar.place());
                    this.restore(ids.clone(), place, window, cx);
                }));
            let show = Button::new("holding-reveal")
                .bar_size()
                .outline()
                .quiet_edge(cx)
                .label(oriel_ui::keys::REVEAL_LABEL)
                .on_click(move |_, _, cx| {
                    if let Some(path) = &reveal {
                        cx.reveal_path(Path::new(path));
                    }
                });
            let clear = Button::new("holding-clear")
                .bar_size()
                .ghost()
                .icon(Icon::new(IconName::Close))
                .accessibility_label("Clear selection")
                .tooltip("Clear selection  Esc")
                .on_click(cx.listener(|this, _, _, cx| {
                    this.selected.clear();
                    cx.notify();
                }));
            self.bar.render(
                "holding-selection",
                None,
                vec![
                    restore.into_any_element(),
                    show.into_any_element(),
                    clear.into_any_element(),
                ],
                cx,
            )
        });

        div()
            .id("holding")
            .track_focus(&self.focus)
            .key_context("TidyHolding")
            .on_key_down(cx.listener(Self::on_key_down))
            .capture_any_mouse_down(cx.listener(|this, event: &MouseDownEvent, _, cx| {
                if this.bar.holds(event.position, cx) {
                    cx.stop_propagation();
                }
            }))
            .relative()
            .flex()
            .flex_col()
            .size_full()
            .min_h_0()
            .child(top_bar)
            .child(body)
            .children(bar)
    }
}
