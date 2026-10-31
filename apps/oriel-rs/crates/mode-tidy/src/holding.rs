//! Holding (`views/HoldingView.tsx`): what Tidy's changes moved aside, grouped by the change that
//! held them, until the owner restores them (⌘⌫) or empties holding to the Trash (⇧⌘⌫). Click
//! picks one, ⌘-click adds or removes one, ⇧-click picks a run; Escape clears. Space or a
//! double-click shows a held file in Quick Look.
//!
//! Holding is drawn a screen at a time ([`crate::windowed`]): each change's heading and each
//! line of its tiles are items of one column, broken into lines as the tiles would wrap.

use std::collections::{BTreeSet, HashMap};
use std::ops::Range;
use std::path::Path;
use std::rc::Rc;

use gpui_kit::assets::IconName;
use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::{ActiveTheme as _, Disableable as _, Icon, Sizable as _};
use gpui_kit::{
    AnyElement, App, Context, Entity, FocusHandle, Focusable, FontWeight, InteractiveElement as _,
    IntoElement, KeyDownEvent, ObjectFit, ParentElement as _, Render, SharedString,
    StatefulInteractiveElement as _, Styled as _, StyledImage as _, Subscription,
    TestSupportExt as _, Window, div, prelude::FluentBuilder as _, px,
};
use oriel_core_domain::{MediaType, detect_media_type};
use oriel_core_tidy::contract::RootId;
use oriel_ui::{Toast, TopBar};

use crate::changes::{
    HoldingId, HoldingItem, HoldingList, HoldingRequest, PlanId, PlanListRequest, PlanSummary,
};
use crate::format;
use crate::loaded::Loaded;
use crate::pages::TidyPage;
use crate::quick_look::quick_look;
use crate::state::TidyState;
use crate::thumbs::{Thumb, Thumbs};
use crate::widgets;
use crate::windowed::{Piece, Windowed};

/// Holding can hold tens of thousands of files; they come a page at a time.
const PAGE: usize = 300;

/// A tile's width.
const TILE: f32 = 176.;

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

fn file_name(path: &str) -> &str {
    path.rsplit(['/', '\\']).next().unwrap_or(path)
}

pub struct HoldingPage {
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
    busy: bool,
    seen: (Option<RootId>, u64),
    /// How much narrower than the window the column was when last laid out, and the window's
    /// width then, so a line holds as many tiles as fit before the column is laid out again.
    margin: Option<f32>,
    window_width: f32,
    _subscriptions: Vec<Subscription>,
}

impl HoldingPage {
    pub fn new(state: &Entity<TidyState>, thumbs: &Entity<Thumbs>, cx: &mut Context<Self>) -> Self {
        let subscriptions = vec![
            cx.observe(state, |this, _, cx| this.sync(cx)),
            cx.observe(thumbs, |_, _, cx| cx.notify()),
        ];
        Self {
            state: state.clone(),
            thumbs: thumbs.clone(),
            focus: cx.focus_handle(),
            holding: Loaded::default(),
            held: None,
            plans: Loaded::default(),
            wanted: PAGE,
            selected: BTreeSet::new(),
            anchor: None,
            busy: false,
            seen: (None, 0),
            margin: None,
            window_width: 0.,
            _subscriptions: subscriptions,
        }
    }

    fn sync(&mut self, cx: &mut Context<Self>) {
        let state = self.state.read(cx);
        let key = (state.root_id(), state.catalog_version());
        if state.page() != TidyPage::Holding || key == self.seen {
            cx.notify();
            return;
        }
        if key.0 != self.seen.0 {
            self.selected.clear();
            self.wanted = PAGE;
        }
        self.seen = key;
        self.reload(cx);
    }

    fn reload(&mut self, cx: &mut Context<Self>) {
        let state = self.state.read(cx);
        let Some(root_id) = state.root_id() else {
            return;
        };
        let changes = state.changes.clone();
        let Some(engine) = state.engine().cloned() else {
            return;
        };
        self.holding.load_then(
            changes.list_holding(
                &engine,
                HoldingRequest {
                    root_id,
                    offset: 0,
                    limit: self.wanted as i64,
                },
            ),
            |this| &mut this.holding,
            Self::loaded,
            cx,
        );
        self.plans.load(
            changes.list_plans(
                &engine,
                PlanListRequest {
                    root_id: Some(root_id),
                    offset: 0,
                    limit: 500,
                },
            ),
            |this| &mut this.plans,
            cx,
        );
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

    /// ⌘A: every held file listed.
    pub fn select_all(&mut self, cx: &mut Context<Self>) {
        self.selected = self.ordered().iter().map(|item| item.id).collect();
        cx.notify();
    }

    fn select(&mut self, id: HoldingId, command: bool, shift: bool, cx: &mut Context<Self>) {
        let held = self.held.clone();
        let ordered = held
            .as_ref()
            .map_or(&[][..], |held| held.ordered.as_slice());
        let position = |id: HoldingId| ordered.iter().position(|item| item.id == id);
        if shift && let (Some(from), Some(to)) = (self.anchor.and_then(position), position(id)) {
            let run = &ordered[from.min(to)..=from.max(to)];
            if !command {
                self.selected.clear();
            }
            self.selected.extend(run.iter().map(|item| item.id));
        } else if command {
            if !self.selected.remove(&id) {
                self.selected.insert(id);
            }
            self.anchor = Some(id);
        } else {
            self.selected = BTreeSet::from([id]);
            self.anchor = Some(id);
        }
        cx.notify();
    }

    fn restore(&mut self, ids: Vec<HoldingId>, window: &mut Window, cx: &mut Context<Self>) {
        if ids.is_empty() || self.busy {
            return;
        }
        self.busy = true;
        let state = self.state.read(cx);
        let Some(engine) = state.engine().cloned() else {
            return;
        };
        let restored = state.changes.restore_holding(&engine, ids);
        cx.spawn_in(window, async move |this, cx| {
            let restored = restored.await;
            this.update_in(cx, |this, window, cx| {
                this.busy = false;
                this.selected.clear();
                let toast = match restored {
                    Ok(result) if result.failed.is_empty() => Toast::done(format!(
                        "Restored {}",
                        format::plural(result.restored, "file")
                    )),
                    Ok(result) => Toast::error(format!(
                        "Restored {}; {} could not go back",
                        format::plural(result.restored, "file"),
                        format::count(result.failed.len() as i64)
                    ))
                    .detail(result.failed[0].clone()),
                    Err(error) => Toast::error("That didn't work").detail(format!("{error:#}")),
                };
                crate::widgets::show_toast(window, toast, cx);
                this.state.update(cx, |state, cx| state.changed(cx));
            })
            .ok();
        })
        .detach();
    }

    /// Empties holding into the system Trash, without asking: the Trash is the safety net, as
    /// Finder's Move to Trash is (`useEmptyHolding`).
    fn empty(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let state = self.state.read(cx);
        let (Some(root_id), Some(list)) = (state.root_id(), self.holding.data()) else {
            return;
        };
        if self.busy || list.total == 0 {
            return;
        }
        let bytes = list.total_bytes;
        self.busy = true;
        let Some(engine) = state.engine().cloned() else {
            return;
        };
        let emptied = state.changes.empty_holding(&engine, root_id);
        cx.spawn_in(window, async move |this, cx| {
            let emptied = emptied.await;
            this.update_in(cx, |this, window, cx| {
                this.busy = false;
                this.selected.clear();
                let toast = match emptied {
                    Ok(result) if result.failed.is_empty() => Toast::done(format!(
                        "Moved {} to the Trash",
                        format::plural(result.emptied, "file")
                    ))
                    .detail(format!(
                        "{} freed once the Trash is emptied",
                        format::bytes(bytes)
                    )),
                    Ok(result) => Toast::error(format!(
                        "{} stayed in holding",
                        format::plural_as(result.failed.len() as i64, "batch", "batches")
                    ))
                    .detail(result.failed[0].clone()),
                    Err(error) => Toast::error("That didn't work").detail(format!("{error:#}")),
                };
                crate::widgets::show_toast(window, toast, cx);
                this.state.update(cx, |state, cx| state.changed(cx));
            })
            .ok();
        })
        .detach();
    }

    fn on_key_down(&mut self, event: &KeyDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        let keys = &event.keystroke;
        if keys.modifiers.platform && keys.key == "backspace" {
            if keys.modifiers.shift {
                self.empty(window, cx);
            } else {
                let ids = self.selected.iter().copied().collect();
                self.restore(ids, window, cx);
            }
        } else if keys.key == "escape" && !self.selected.is_empty() {
            self.selected.clear();
            cx.notify();
        } else if keys.key == "space" && !keys.modifiers.modified() {
            // The file last clicked, else the first chosen, as Finder's Space previews it.
            let held = self.held.clone();
            let ordered = held
                .as_ref()
                .map_or(&[][..], |held| held.ordered.as_slice());
            let target = self
                .anchor
                .and_then(|anchor| ordered.iter().find(|item| item.id == anchor))
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
            thumbs.path(Path::new(&item.hold_path), video, 320, cx)
        });
        let theme = cx.theme();
        let selected = self.selected.contains(&item.id);
        let picture: AnyElement = match thumb {
            Thumb::Ready(image) => gpui_kit::img(image)
                .size_full()
                .object_fit(ObjectFit::Contain)
                .into_any_element(),
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
        let relative = item
            .original_path
            .strip_prefix(root)
            .map(|rest| rest.trim_start_matches(['/', '\\']).to_string())
            .unwrap_or_else(|| item.original_path.clone());
        let id = item.id;
        div()
            .id(("held", id as u64))
            .test_support()
            .aria_label(SharedString::from(name.clone()))
            .aria_selected(selected)
            .w(px(176.))
            .flex()
            .flex_col()
            .p_1()
            .rounded(theme.radius_lg)
            .border_2()
            .border_color(if selected {
                theme.primary
            } else {
                theme.transparent
            })
            .cursor_pointer()
            .tooltip({
                let tooltip = SharedString::from(relative);
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
                    this.select(id, modifiers.platform, modifiers.shift, cx);
                })
            })
            .child(
                div()
                    .h(px(132.))
                    .rounded(theme.radius)
                    .overflow_hidden()
                    .bg(theme.muted)
                    .child(picture),
            )
            .child(
                div()
                    .px_0p5()
                    .pt(px(6.))
                    .child(div().truncate().text_size(px(13.)).child(name))
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
            if self.state.read(cx).shell.read(cx).rail() {
                oriel_ui::layout::RAIL_WIDTH
            } else {
                oriel_ui::layout::SIDEBAR_WIDTH
            }
        });
        // The column's sides (`px_5`) and the space between tiles (`gap_x_3`), in rems.
        let rem = f32::from(window.rem_size());
        let (inner, gap) = (window_width - margin - 2.5 * rem, 0.75 * rem);
        let columns = (((inner + gap) / (TILE + gap)).floor() as usize).max(1);
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
        let (pieces, near) = column.update(cx, |column, _| {
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
                                .h(px(36.))
                                .text_size(px(13.))
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
                            .outline()
                            .small()
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
                            .text_xs()
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
                    thumbs.path(Path::new(&item.hold_path), video, 320, cx);
                }
            });
        }
        div()
            .id("holding-scroll")
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
        let shell = state.shell.clone();
        let root = state
            .root()
            .map(|root| root.path.clone())
            .unwrap_or_default();
        let list = self.holding.data().map(|list| HoldingCounts {
            total: list.total,
            total_bytes: list.total_bytes,
            listed: list.items.len(),
        });
        let theme = cx.theme();
        let (radius_lg, popover, border) = (theme.radius_lg, theme.popover, theme.border);
        let total = list.as_ref().map_or(0, |list| list.total);
        let meta = list.as_ref().filter(|list| list.total > 0).map(|list| {
            format!(
                "{} · {}",
                format::plural(list.total, "file"),
                format::bytes(list.total_bytes)
            )
        });
        let top_bar = TopBar::new(&shell, "Holding")
            .when_some(meta, |bar, meta| bar.trailing(widgets::caption(meta, cx)))
            .when(total > 0, |bar| {
                bar.trailing(
                    Button::new("holding-empty")
                        .danger()
                        .small()
                        .label("Empty to Trash")
                        .tooltip("Empty to Trash  ⇧⌘⌫")
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
            div()
                .absolute()
                .bottom(px(20.))
                .left_0()
                .right_0()
                .flex()
                .justify_center()
                .child(
                    div()
                        .id("holding-selection")
                        .flex()
                        .flex_row()
                        .items_center()
                        .gap(px(6.))
                        .p(px(6.))
                        .rounded(radius_lg)
                        .bg(popover)
                        .border_1()
                        .border_color(border)
                        .shadow_lg()
                        .child(
                            widgets::caption(
                                format!("{} selected", format::count(chosen.len() as i64)),
                                cx,
                            )
                            .px_2(),
                        )
                        .child(
                            Button::new("holding-restore")
                                .primary()
                                .small()
                                .label("Restore")
                                .tooltip("⌘⌫")
                                .disabled(self.busy)
                                .on_click(cx.listener(move |this, _, window, cx| {
                                    this.restore(ids.clone(), window, cx);
                                })),
                        )
                        .child(
                            Button::new("holding-reveal")
                                .outline()
                                .small()
                                .label("Show in Finder")
                                .on_click(move |_, _, cx| {
                                    if let Some(path) = &reveal {
                                        cx.reveal_path(Path::new(path));
                                    }
                                }),
                        )
                        .child(
                            Button::new("holding-clear")
                                .ghost()
                                .small()
                                .icon(Icon::new(IconName::Close))
                                .accessibility_label("Clear selection")
                                .tooltip("Esc")
                                .on_click(cx.listener(|this, _, _, cx| {
                                    this.selected.clear();
                                    cx.notify();
                                })),
                        ),
                )
        });

        div()
            .id("holding")
            .track_focus(&self.focus)
            .key_context("TidyHolding")
            .on_key_down(cx.listener(Self::on_key_down))
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
