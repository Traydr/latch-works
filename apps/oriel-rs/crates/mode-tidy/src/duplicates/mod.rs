//! Duplicates (`views/DuplicatesView.tsx`): the queue of sets on the left (Similar, Variants,
//! Identical, and the ones marked Not duplicates), the set on the stage (similar versions as the
//! version grid with playing video tiles, identical copies as the copy list), the loupe, and the
//! decision bar.
//!
//! Return keeps the suggestion and moves on; 1–9 keep only that version; ⇧1–9 keep it as well;
//! N marks the set as not duplicates; S skips; ↑ ↓ (J K) move through the queue and ← → (H L)
//! through the versions; Space or C looks closer, Z shows actual size, M turns sound on or off,
//! P prefers the version's folder, ⇧⌘R shows it in Finder. Each decision says what it did in a
//! toast with its own Undo.

pub mod model;
mod video;

use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::rc::Rc;
use std::time::{Duration, Instant};

use gpui_kit::assets::IconName;
use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::checkbox::Checkbox;
use gpui_kit::component::spinner::Spinner;
use gpui_kit::component::switch::Switch;
use gpui_kit::component::{ActiveTheme as _, Disableable as _, Icon, Sizable as _};
use gpui_kit::{
    AnyElement, App, AppContext as _, Context, Entity, FocusHandle, Focusable, FontWeight, Hsla,
    InteractiveElement as _, IntoElement, KeyDownEvent, ObjectFit, ParentElement as _, Render,
    SharedString, StatefulInteractiveElement as _, Styled as _, Subscription, TestSupportExt as _,
    UniformListScrollHandle, Window, div, prelude::FluentBuilder as _, px, uniform_list,
};
use oriel_core_tidy::contract::{
    DuplicateKind, DuplicateScope, DuplicateSet, DuplicateSetPage, DuplicateSetRequest, FileId,
    FileKind, FileRow, RootId, SimilarityLevel, is_close_call,
};
use oriel_ui::segmented::{Segmented, SegmentedItem};
use oriel_ui::{Toast, TopBar};

use crate::actions::PerformOptions;
use crate::changes::{PlanRequest, ResolveGroup};
use crate::format;
use crate::loaded::Loaded;
use crate::pages::TidyPage;
use crate::settings::SIMILARITY_LEVELS;
use crate::state::TidyState;
use crate::thumbs::{self, Thumbs};
use crate::widgets;

pub use model::SetRow;
use model::{
    copy_of_number, decision_label, facts_of, files_of, freed_bytes, holding_summary,
    keep_every_label, keeper_of, kept_ids, reason_of, removal_of, rows_of,
};
use video::TileVideo;

/// Sets read at once, and how many more as the queue nears its end.
const PAGE: usize = 100;

/// How long a click on a new set waits, so a double-click never decides two sets.
const ARM_DELAY: Duration = Duration::from_millis(400);

/// The queue's rows.
const QUEUE_ROW: f32 = 60.;

/// A set's sets and the catalog version they were read at.
type Queue = (DuplicateSetPage, u64);

pub struct DuplicatesPage {
    state: Entity<TidyState>,
    thumbs: Entity<Thumbs>,
    focus: FocusHandle,
    /// The tab the owner chose; `None` until the first answer picks one.
    chosen_scope: Option<DuplicateScope>,
    dismissed_mode: bool,
    queue: Loaded<Queue>,
    wanted: usize,
    active_index: usize,
    focused_row: usize,
    /// The focus is drawn only once the arrows move it, so a new set never looks half-picked.
    keyboard_focus: bool,
    hover_row: Option<usize>,
    looking: bool,
    zoomed: bool,
    sound_on: bool,
    overrides: HashMap<String, Vec<FileId>>,
    skipped: HashSet<String>,
    /// Sets resolved or dismissed here stay hidden until a read newer than that change.
    hidden: HashMap<String, u64>,
    /// A set undone from here comes back into focus once the queue brings it.
    return_to: Option<String>,
    freed_here: i64,
    armed_at: Instant,
    active_key: Option<String>,
    video: Option<(FileId, Entity<TileVideo>)>,
    seen: (
        Option<RootId>,
        u64,
        Option<DuplicateScope>,
        bool,
        Option<SimilarityLevel>,
    ),
    queue_scroll: UniformListScrollHandle,
    _subscriptions: Vec<Subscription>,
}

impl DuplicatesPage {
    pub fn new(state: &Entity<TidyState>, thumbs: &Entity<Thumbs>, cx: &mut Context<Self>) -> Self {
        let subscriptions = vec![
            cx.observe(state, |this, _, cx| this.sync(cx)),
            cx.observe(thumbs, |_, _, cx| cx.notify()),
        ];
        Self {
            state: state.clone(),
            thumbs: thumbs.clone(),
            focus: cx.focus_handle(),
            chosen_scope: None,
            dismissed_mode: false,
            queue: Loaded::default(),
            wanted: PAGE,
            active_index: 0,
            focused_row: 1,
            keyboard_focus: false,
            hover_row: None,
            looking: false,
            zoomed: false,
            sound_on: true,
            overrides: HashMap::new(),
            skipped: HashSet::new(),
            hidden: HashMap::new(),
            return_to: None,
            freed_here: 0,
            armed_at: Instant::now(),
            active_key: None,
            video: None,
            seen: (None, 0, None, false, None),
            queue_scroll: UniformListScrollHandle::new(),
            _subscriptions: subscriptions,
        }
    }

    // What the page shows.

    fn spot_variants(&self, cx: &App) -> bool {
        self.state
            .read(cx)
            .settings()
            .is_some_and(|settings| settings.spot_variants)
    }

    /// The tab on screen: the Variants tab exists only while Spot variants sorts them out.
    pub fn scope(&self, cx: &App) -> DuplicateScope {
        match self.chosen_scope {
            Some(DuplicateScope::Variants) if !self.spot_variants(cx) => DuplicateScope::Similar,
            Some(scope) => scope,
            None => DuplicateScope::Similar,
        }
    }

    pub fn is_dismissed_mode(&self) -> bool {
        self.dismissed_mode
    }

    /// The counts the queue's tabs show, once read.
    pub fn page(&self) -> Option<&DuplicateSetPage> {
        self.queue.data().map(|(page, _)| page)
    }

    /// The sets the queue lists: the page read, less those decided here.
    pub fn sets(&self) -> Vec<&DuplicateSet> {
        let Some((page, version)) = self.queue.data() else {
            return Vec::new();
        };
        page.sets
            .iter()
            .filter(|set| {
                self.hidden
                    .get(&set.key)
                    .is_none_or(|until| version > until)
            })
            .collect()
    }

    fn index(&self) -> usize {
        self.active_index.min(self.sets().len().saturating_sub(1))
    }

    pub fn active(&self) -> Option<&DuplicateSet> {
        self.sets().get(self.index()).copied()
    }

    pub fn rows(&self) -> Vec<SetRow> {
        self.active().map(rows_of).unwrap_or_default()
    }

    /// What resolving the set on screen keeps.
    pub fn kept(&self) -> Vec<FileId> {
        self.active()
            .map(|set| kept_ids(set, self.overrides.get(&set.key).map(Vec::as_slice)))
            .unwrap_or_default()
    }

    /// The names of the files the set on screen keeps, for checks.
    pub fn kept_names(&self) -> Vec<String> {
        let kept = self.kept();
        self.active()
            .map(|set| {
                files_of(set)
                    .into_iter()
                    .filter(|file| kept.contains(&file.id))
                    .map(|file| file.name.clone())
                    .collect()
            })
            .unwrap_or_default()
    }

    /// The decision button's label.
    pub fn decision(&self) -> Option<String> {
        let set = self.active()?;
        Some(if self.dismissed_mode {
            "Restore".into()
        } else if self.looking {
            format!("Keep {}", self.focus_row() + 1)
        } else {
            decision_label(set, &rows_of(set), &self.kept())
        })
    }

    fn focus_row(&self) -> usize {
        self.focused_row.min(self.rows().len().saturating_sub(1))
    }

    /// The version a key acts on: the keyboard's focus once the arrows moved it, else the one
    /// under the pointer, else the suggestion.
    fn target(&self) -> usize {
        if self.looking || self.keyboard_focus {
            return self.focus_row();
        }
        let kept = self.kept();
        self.hover_row.unwrap_or_else(|| {
            self.rows()
                .iter()
                .position(|row| kept.contains(&row.file.id))
                .unwrap_or(0)
        })
    }

    // Reading.

    /// Follows the state: reads the queue again when the catalog, the root, the tab or the level
    /// moves, while Duplicates shows.
    fn sync(&mut self, cx: &mut Context<Self>) {
        let state = self.state.read(cx);
        let visible = state.page() == TidyPage::Duplicates;
        if visible
            && let Some(scope) = self
                .state
                .update(cx, |state, _| state.take_duplicates_request())
        {
            self.change_scope(scope, cx);
        }
        let state = self.state.read(cx);
        let level = state.settings().map(|settings| settings.similarity);
        let key = (
            state.root_id(),
            state.catalog_version(),
            Some(self.scope(cx)),
            self.dismissed_mode,
            level,
        );
        if visible && key != self.seen {
            if key.0 != self.seen.0 {
                self.overrides.clear();
                self.skipped.clear();
                self.hidden.clear();
                self.freed_here = 0;
                self.active_index = 0;
            }
            self.seen = key;
            self.load(cx);
        }
        self.follow_active(cx);
        cx.notify();
    }

    fn load(&mut self, cx: &mut Context<Self>) {
        let state = self.state.read(cx);
        let (Some(engine), Some(root_id)) = (state.engine().cloned(), state.root_id()) else {
            return;
        };
        let version = state.catalog_version();
        let request = DuplicateSetRequest {
            root_id: Some(root_id),
            offset: 0,
            limit: self.wanted,
            level: state
                .settings()
                .map_or(SimilarityLevel::Balanced, |settings| settings.similarity),
            scope: self.scope(cx),
            dismissed: self.dismissed_mode,
        };
        let answer = engine.duplicate_sets(request);
        self.queue.load_then(
            async move { Ok((answer.await?, version)) },
            |this| &mut this.queue,
            Self::loaded,
            cx,
        );
    }

    /// The first answer picks the tab: similar sets first, unless there are none and identical
    /// copies wait.
    fn loaded(&mut self, cx: &mut Context<Self>) {
        if self.chosen_scope.is_none()
            && let Some(page) = self.page()
        {
            let scope = if page.counts.similar == 0 && page.counts.exact > 0 {
                DuplicateScope::Exact
            } else {
                DuplicateScope::Similar
            };
            self.chosen_scope = Some(scope);
            if scope != DuplicateScope::Similar {
                self.seen.2 = Some(scope);
                self.load(cx);
            }
        }
        if let Some(key) = self.return_to.clone()
            && let Some(position) = self.sets().iter().position(|set| set.key == key)
        {
            self.active_index = position;
            self.return_to = None;
        }
        self.follow_active(cx);
    }

    /// A new set starts with focus on its first version that would go, fitted and paused.
    fn follow_active(&mut self, cx: &mut Context<Self>) {
        let key = self.active().map(|set| set.key.clone());
        if key != self.active_key {
            self.active_key = key;
            self.focused_row = 1;
            self.keyboard_focus = false;
            self.zoomed = false;
            self.video = None;
            self.armed_at = Instant::now() + ARM_DELAY;
            if self.active_key.is_none() {
                self.looking = false;
            }
            self.queue_scroll
                .scroll_to_item(self.index(), gpui_kit::ScrollStrategy::Center);
            cx.notify();
        }
    }

    fn load_more(&mut self, cx: &mut Context<Self>) {
        let Some(page) = self.page() else {
            return;
        };
        if page.sets.len() < page.total as usize && self.wanted <= page.sets.len() {
            self.wanted = page.sets.len() + PAGE;
            self.load(cx);
        }
    }

    pub fn change_scope(&mut self, scope: DuplicateScope, cx: &mut Context<Self>) {
        self.chosen_scope = Some(scope);
        self.active_index = 0;
        self.looking = false;
        self.wanted = PAGE;
        self.sync(cx);
    }

    pub fn show_dismissed(&mut self, dismissed: bool, cx: &mut Context<Self>) {
        self.dismissed_mode = dismissed;
        self.active_index = 0;
        self.looking = false;
        self.wanted = PAGE;
        self.sync(cx);
    }

    // Deciding.

    fn hide(&mut self, key: &str, until: u64) {
        self.hidden.insert(key.to_string(), until);
    }

    fn unhide(&mut self, key: &str, cx: &mut Context<Self>) {
        self.hidden.remove(key);
        self.follow_active(cx);
        cx.notify();
    }

    fn bring_back(&mut self, key: &str, cx: &mut Context<Self>) {
        self.unhide(key, cx);
        self.return_to = Some(key.to_string());
    }

    /// Resolves a set keeping `keep`, and says so in a toast with Undo.
    fn resolve_with(
        &mut self,
        set: DuplicateSet,
        keep: Vec<FileId>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let going: Vec<FileId> = removal_of(&set, &keep).iter().map(|file| file.id).collect();
        if going.is_empty() {
            return;
        }
        let bytes = freed_bytes(&set, &removal_of(&set, &keep));
        let keeper = files_of(&set)
            .into_iter()
            .find(|file| keep.first() == Some(&file.id))
            .cloned();
        self.hide(&set.key, u64::MAX);
        self.follow_active(cx);
        let page = cx.entity().downgrade();
        let key = set.key.clone();
        let several = keep.len() > 1;
        let kept_count = keep.len() as i64;
        let kind = set.kind;
        let options = PerformOptions {
            source: Some("duplicates".into()),
            quiet: true,
            on_undone: Some({
                let (page, key) = (page.clone(), key.clone());
                Rc::new(move |_, cx| {
                    page.update(cx, |page, cx| page.bring_back(&key, cx)).ok();
                })
            }),
            on_failed: Some({
                let (page, key) = (page.clone(), key.clone());
                Rc::new(move |_, cx| {
                    page.update(cx, |page, cx| page.unhide(&key, cx)).ok();
                })
            }),
            on_done: Some({
                let (page, key) = (page.clone(), key.clone());
                let state = self.state.clone();
                Rc::new(move |plan, window, cx| {
                    let version = state.read(cx).catalog_version();
                    page.update(cx, |page, cx| {
                        page.hide(&key, version);
                        if plan.done > 0 {
                            page.freed_here += bytes;
                        }
                        cx.notify();
                    })
                    .ok();
                    // A file that changed since the scan stays where it is.
                    let stayed = (plan.skipped > 0).then(|| {
                        format!(
                            "{} changed since the scan and stayed; Tidy is scanning again",
                            format::plural(plan.skipped, "file")
                        )
                    });
                    if plan.done == 0 {
                        if plan.failed == 0 {
                            let toast = Toast::info("Nothing moved");
                            let toast = match stayed {
                                Some(stayed) => toast.detail(stayed),
                                None => toast,
                            };
                            crate::widgets::show_toast(window, toast, cx);
                        }
                        return;
                    }
                    let message = if several {
                        format!(
                            "Kept {}",
                            if kind == DuplicateKind::Exact {
                                format::plural_as(kept_count, "copy", "copies")
                            } else {
                                format::plural(kept_count, "version")
                            }
                        )
                    } else {
                        format!(
                            "Kept {}",
                            keeper.as_ref().map_or("1 file", |file| file.name.as_str())
                        )
                    };
                    let detail = stayed.or_else(|| {
                        (!several).then(|| {
                            let dir = keeper.as_ref().map_or("", |file| file.dir.as_str());
                            format!(
                                "In {}",
                                if dir.is_empty() {
                                    "the top folder"
                                } else {
                                    dir
                                }
                            )
                        })
                    });
                    let (undo_state, undo_page, undo_key, undone) =
                        (state.clone(), page.clone(), key.clone(), plan.clone());
                    let mut toast = Toast::done(message).action("Undo", move |window, cx| {
                        let (page, key) = (undo_page.clone(), undo_key.clone());
                        let options = PerformOptions {
                            quiet: true,
                            on_undone: Some(Rc::new(move |_, cx| {
                                page.update(cx, |page, cx| page.bring_back(&key, cx)).ok();
                            })),
                            ..PerformOptions::default()
                        };
                        undo_state.update(cx, |state, cx| {
                            state.undo_plan(undone.clone(), options, window, cx);
                        });
                    });
                    if let Some(detail) = detail {
                        toast = toast.detail(detail);
                    }
                    crate::widgets::show_toast(window, toast, cx);
                })
            }),
        };
        self.state.update(cx, |state, cx| {
            state.perform(
                PlanRequest::ResolveDuplicates {
                    groups: vec![ResolveGroup {
                        keep,
                        remove: going,
                    }],
                },
                options,
                window,
                cx,
            );
        });
        cx.notify();
    }

    /// N: marks the set as not duplicates (identical copies: keeps every copy), with Undo.
    fn dismiss(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(set) = self.active().cloned() else {
            return;
        };
        let Some(engine) = self.state.read(cx).engine().cloned() else {
            return;
        };
        self.hide(&set.key, u64::MAX);
        self.follow_active(cx);
        let ids: Vec<FileId> = files_of(&set).iter().map(|file| file.id).collect();
        let dismissed = engine.dismiss_duplicate_set(ids);
        let state = self.state.clone();
        cx.spawn_in(window, async move |this, cx| {
            let dismissed = dismissed.await;
            this.update_in(cx, |this, window, cx| match dismissed {
                Ok(dismissal_id) => {
                    let page = cx.entity().downgrade();
                    let (restore_engine, key) = (engine.clone(), set.key.clone());
                    let restore = Rc::new(move |cx: &mut App| {
                        let restored = restore_engine.restore_duplicate_set(dismissal_id);
                        let (page, key) = (page.clone(), key.clone());
                        cx.spawn(async move |cx| {
                            if restored.await.is_ok() {
                                page.update(cx, |page, cx| {
                                    page.bring_back(&key, cx);
                                    page.state.update(cx, |state, cx| state.changed(cx));
                                })
                                .ok();
                            }
                        })
                        .detach();
                    });
                    let undo = {
                        let restore = restore.clone();
                        state.update(cx, |state, _| state.push_undo(move |_, _, cx| restore(cx)))
                    };
                    let undo_state = state.clone();
                    crate::widgets::show_toast(
                        window,
                        Toast::done(if set.kind == DuplicateKind::Exact {
                            "Kept every copy"
                        } else {
                            "Marked as not duplicates"
                        })
                        .action("Undo", move |_, cx| {
                            undo_state.update(cx, |state, _| state.drop_undo(undo));
                            restore(cx);
                        }),
                        cx,
                    );
                    let version = this.state.read(cx).catalog_version();
                    this.hide(&set.key, version);
                    this.state.update(cx, |state, cx| state.changed(cx));
                }
                Err(error) => {
                    this.unhide(&set.key, cx);
                    crate::widgets::show_toast(
                        window,
                        Toast::error("Something went wrong").detail(format!("{error:#}")),
                        cx,
                    );
                }
            })
            .ok();
        })
        .detach();
    }

    /// Return in Not duplicates: the set goes back to review.
    fn restore_dismissed(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(set) = self.active().cloned() else {
            return;
        };
        let (Some(engine), Some(dismissal_id)) =
            (self.state.read(cx).engine().cloned(), set.dismissal_id)
        else {
            return;
        };
        self.hide(&set.key, u64::MAX);
        self.follow_active(cx);
        let restored = engine.restore_duplicate_set(dismissal_id);
        cx.spawn_in(window, async move |this, cx| {
            let restored = restored.await;
            this.update_in(cx, |this, window, cx| match restored {
                Ok(()) => {
                    let version = this.state.read(cx).catalog_version();
                    this.hide(&set.key, version);
                    this.state.update(cx, |state, cx| state.changed(cx));
                }
                Err(error) => {
                    this.unhide(&set.key, cx);
                    crate::widgets::show_toast(
                        window,
                        Toast::error("Something went wrong").detail(format!("{error:#}")),
                        cx,
                    );
                }
            })
            .ok();
        })
        .detach();
    }

    /// Return: the keepers, or "keep every version" when all are kept.
    pub fn decide(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(set) = self.active().cloned() else {
            return;
        };
        if self.dismissed_mode {
            self.restore_dismissed(window, cx);
            return;
        }
        let kept = self.kept();
        if removal_of(&set, &kept).is_empty() {
            self.dismiss(window, cx);
        } else {
            self.resolve_with(set, kept, window, cx);
        }
    }

    /// A number key or a click on a version: keeps only that one, resolves and moves on.
    fn keep_only(&mut self, index: usize, window: &mut Window, cx: &mut Context<Self>) {
        let (Some(set), Some(row)) = (self.active().cloned(), self.rows().get(index).cloned())
        else {
            return;
        };
        if !self.dismissed_mode {
            self.resolve_with(set, vec![row.file.id], window, cx);
        }
    }

    fn click_keep(&mut self, index: usize, window: &mut Window, cx: &mut Context<Self>) {
        if Instant::now() >= self.armed_at {
            self.keep_only(index, window, cx);
        }
    }

    /// ⇧ and a number, or a version's checkbox: keeps it as well, or not, without deciding.
    pub fn toggle_keep(&mut self, index: usize, cx: &mut Context<Self>) {
        let (Some(set), Some(row)) = (self.active().cloned(), self.rows().get(index).cloned())
        else {
            return;
        };
        if self.dismissed_mode {
            return;
        }
        let kept = self.kept();
        let next: Vec<FileId> = if kept.contains(&row.file.id) {
            kept.into_iter().filter(|id| *id != row.file.id).collect()
        } else {
            kept.into_iter().chain([row.file.id]).collect()
        };
        if !next.is_empty() {
            self.overrides.insert(set.key, next);
            cx.notify();
        }
    }

    fn move_by(&mut self, delta: isize, cx: &mut Context<Self>) {
        let count = self.sets().len() as isize;
        if count == 0 {
            return;
        }
        self.active_index = (self.index() as isize + delta).clamp(0, count - 1) as usize;
        self.follow_active(cx);
        if delta > 0 && self.active_index + 10 >= count as usize {
            self.load_more(cx);
        }
        cx.notify();
    }

    fn skip(&mut self, cx: &mut Context<Self>) {
        if let Some(set) = self.active() {
            self.skipped.insert(set.key.clone());
            self.move_by(1, cx);
        }
    }

    fn focus_by(&mut self, delta: isize, cx: &mut Context<Self>) {
        let count = self.rows().len() as isize;
        if count == 0 {
            return;
        }
        self.focused_row = (self.focus_row() as isize + delta).clamp(0, count - 1) as usize;
        self.keyboard_focus = true;
        cx.notify();
    }

    fn open_loupe(&mut self, index: usize, cx: &mut Context<Self>) {
        self.focused_row = index;
        self.zoomed = false;
        self.looking = true;
        cx.notify();
    }

    fn close_loupe(&mut self, cx: &mut Context<Self>) {
        self.looking = false;
        self.zoomed = false;
        cx.notify();
    }

    /// Plays a version's video in its tile, pausing any other.
    fn play(&mut self, file: &FileRow, window: &mut Window, cx: &mut Context<Self>) {
        if let Some((id, video)) = &self.video
            && *id == file.id
        {
            video.update(cx, |video, cx| video.toggle(window, cx));
            return;
        }
        let muted = !self.sound_on;
        let path = Path::new(&file.abs_path).to_path_buf();
        self.video = Some((file.id, cx.new(|_| TileVideo::new(path, muted))));
        cx.notify();
    }

    fn toggle_sound(&mut self, cx: &mut Context<Self>) {
        self.sound_on = !self.sound_on;
        if let Some((_, video)) = &self.video {
            let muted = !self.sound_on;
            video.update(cx, |video, cx| video.set_muted(muted, cx));
        }
        cx.notify();
    }

    fn on_key_down(&mut self, event: &KeyDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        let keys = &event.keystroke;
        let modifiers = keys.modifiers;
        let key = keys.key.as_str();
        let digit = key
            .parse::<usize>()
            .ok()
            .filter(|digit| (1..=9).contains(digit));
        // A held key repeats; a decision never should.
        let deciding = digit.is_some() || matches!(key, "enter" | "n" | "s");
        if event.is_held && deciding {
            cx.stop_propagation();
            return;
        }
        let rows = self.rows();
        if modifiers.platform && modifiers.shift && key == "r" {
            if let Some(row) = rows.get(self.target()) {
                cx.reveal_path(Path::new(&row.file.abs_path));
            }
            cx.stop_propagation();
            return;
        }
        if modifiers.platform || modifiers.control || modifiers.alt {
            return;
        }
        if let Some(digit) = digit {
            if !self.dismissed_mode && digit <= rows.len() {
                if modifiers.shift {
                    self.toggle_keep(digit - 1, cx);
                    self.focused_row = digit - 1;
                } else {
                    self.keep_only(digit - 1, window, cx);
                }
            }
            cx.stop_propagation();
            return;
        }
        if modifiers.shift {
            return;
        }
        let similar = self
            .active()
            .is_some_and(|set| set.kind == DuplicateKind::Similar);
        match key {
            "down" | "j" => self.move_by(1, cx),
            "up" | "k" => self.move_by(-1, cx),
            "right" | "l" => self.focus_by(1, cx),
            "left" | "h" => self.focus_by(-1, cx),
            "enter" => {
                if self.looking {
                    let focus = self.focus_row();
                    self.keep_only(focus, window, cx);
                } else {
                    self.decide(window, cx);
                }
            }
            "s" => self.skip(cx),
            "n" => {
                if !self.dismissed_mode {
                    self.dismiss(window, cx);
                }
            }
            "p" => {
                if let Some(row) = rows.get(self.target())
                    && !self.dismissed_mode
                {
                    crate::settings::prefer_folder(&self.state, row.file.dir.clone(), window, cx);
                }
            }
            "c" => {
                if similar {
                    if self.looking {
                        self.close_loupe(cx);
                    } else {
                        let target = self.target();
                        self.open_loupe(target, cx);
                    }
                }
            }
            "z" => {
                if similar {
                    if !self.looking {
                        self.focused_row = self.target();
                    }
                    self.zoomed = !self.looking || !self.zoomed;
                    self.looking = true;
                    cx.notify();
                }
            }
            "m" => self.toggle_sound(cx),
            "space" => {
                let target = self.target();
                match rows.get(target) {
                    Some(row) if self.looking && row.file.kind == FileKind::Video => {
                        let file = row.file.clone();
                        self.play(&file, window, cx);
                    }
                    Some(_) if similar && !self.looking => self.open_loupe(target, cx),
                    Some(row) if !similar => {
                        cx.open_with_system(Path::new(&row.file.abs_path));
                    }
                    _ => {}
                }
            }
            "escape" if self.looking => self.close_loupe(cx),
            _ => return,
        }
        cx.stop_propagation();
    }

    // Drawing.

    fn render_top_bar(&self, cx: &mut Context<Self>) -> TopBar {
        let state = self.state.read(cx);
        let theme = cx.theme();
        let settings = state.settings().cloned();
        let level = settings
            .as_ref()
            .map_or(SimilarityLevel::Balanced, |settings| settings.similarity);
        let spot = settings
            .as_ref()
            .is_some_and(|settings| settings.spot_variants);
        let analysing = state.analysis().is_some() || state.scan().is_some();
        let note = self.page().and_then(|page| {
            if page.fingerprinted < page.fingerprintable {
                Some(format!(
                    "Checking {} of {}",
                    format::count(page.fingerprinted),
                    format::count(page.fingerprintable)
                ))
            } else if page.compared < page.comparable {
                Some(format!(
                    "Comparing {} of {}",
                    format::count(page.compared),
                    format::count(page.comparable)
                ))
            } else {
                None
            }
        });
        let shell = state.shell.clone();
        let dismissed = self.page().map(|page| page.counts.dismissed);
        let levels = Segmented::new("duplicates-level", "Similar versions").items(
            SIMILARITY_LEVELS.map(|(value, label)| {
                let state = self.state.clone();
                SegmentedItem::new(SharedString::from(format!("level-{value}")), label)
                    .selected(value == level)
                    .on_click(move |_, window, cx| {
                        let Some(mut settings) = state.read(cx).settings().cloned() else {
                            return;
                        };
                        settings.similarity = value;
                        state.update(cx, |state, cx| state.update_settings(settings, window, cx));
                    })
            }),
        );
        let spot_state = self.state.clone();
        TopBar::new(
            &shell,
            if self.dismissed_mode {
                "Not duplicates"
            } else {
                "Duplicates"
            },
        )
        .when_some(note, |bar, note| {
            bar.trailing(
                div()
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap_2()
                    .text_xs()
                    .text_color(theme.muted_foreground)
                    .when(analysing, |this| this.child(Spinner::new().small()))
                    .child(note),
            )
        })
        .trailing(levels)
        .trailing(
            div()
                .flex()
                .flex_row()
                .items_center()
                .gap_2()
                .text_size(px(13.))
                .child("Spot variants")
                .child(
                    Switch::new("duplicates-spot-variants")
                        .checked(spot)
                        .accessibility_label("Spot variants")
                        .tooltip(
                            "Keeps every picture that differs in one area (a face, an outfit, a \
                             caption's language), and keeps each picture's copy with sound, the \
                             most pixels, or in the folder holding the rest of its set",
                        )
                        .on_click(move |checked, window, cx| {
                            let Some(mut settings) = spot_state.read(cx).settings().cloned() else {
                                return;
                            };
                            settings.spot_variants = *checked;
                            spot_state.update(cx, |state, cx| {
                                state.update_settings(settings, window, cx);
                            });
                        }),
                ),
        )
        .trailing(
            Button::new("duplicates-not-duplicates")
                .outline()
                .small()
                .toggled(self.dismissed_mode)
                .label(match dismissed {
                    Some(count) => format!("Not duplicates {}", format::count(count)),
                    None => "Not duplicates".into(),
                })
                .tooltip(if self.dismissed_mode {
                    "Back to the sets to review"
                } else {
                    "Sets you marked as not duplicates"
                })
                .on_click(cx.listener(|this, _, _, cx| {
                    let next = !this.dismissed_mode;
                    this.show_dismissed(next, cx);
                })),
        )
    }

    fn render_scope_switch(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let page = self.page()?;
        if self.dismissed_mode {
            return None;
        }
        let scope = self.scope(cx);
        let spot = self.spot_variants(cx);
        let mut options = vec![(DuplicateScope::Similar, "Similar", page.counts.similar)];
        if spot {
            options.push((DuplicateScope::Variants, "Variants", page.counts.variants));
        }
        options.push((DuplicateScope::Exact, "Identical", page.counts.exact));
        let this = cx.entity().downgrade();
        Some(
            Segmented::new("duplicates-scope", "Show")
                .fill()
                .items(options.into_iter().map(|(value, label, count)| {
                    let this = this.clone();
                    SegmentedItem::new(
                        SharedString::from(format!("scope-{value}")),
                        format!("{label} {}", format::count(count)),
                    )
                    .selected(value == scope)
                    .on_click(move |_, _, cx| {
                        this.update(cx, |this, cx| this.change_scope(value, cx))
                            .ok();
                    })
                }))
                .into_any_element(),
        )
    }

    fn render_queue(&self, cx: &mut Context<Self>) -> AnyElement {
        let theme = cx.theme();
        let (border, muted) = (theme.border, theme.muted_foreground);
        let header = self.render_scope_switch(cx);
        let count = self.sets().len();
        let this = cx.entity().downgrade();
        div()
            .flex()
            .flex_col()
            .w(px(248.))
            .flex_shrink_0()
            .h_full()
            .border_r_1()
            .border_color(border)
            .child(div().flex_shrink_0().px_3().pt_3().pb_2().children(header))
            .child(
                uniform_list("duplicates-queue", count, move |range, _, cx| {
                    let Some(page) = this.upgrade() else {
                        return Vec::new();
                    };
                    let page = page.clone();
                    range
                        .map(|index| render_queue_row(&page, index, muted, cx))
                        .collect()
                })
                .track_scroll(&self.queue_scroll)
                .flex_1()
                .px_2()
                .pb_3(),
            )
            .into_any_element()
    }

    fn render_stage(&mut self, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let Some(set) = self.active().cloned() else {
            return div().into_any_element();
        };
        let rows = rows_of(&set);
        let kept = self.kept();
        let overridden = self.overrides.contains_key(&set.key);
        let reason = reason_of(&set, &rows, &kept, overridden);
        let body = if set.kind == DuplicateKind::Exact {
            self.render_copies(&set, &rows, &kept, &reason.text, cx)
        } else {
            self.render_grid(&set, &rows, &kept, &reason, window, cx)
        };
        let bar = self.render_decision_bar(&set, &rows, &kept, cx);
        let loupe = (self.looking && set.kind == DuplicateKind::Similar)
            .then(|| self.render_loupe(&set, &rows, &kept, &reason, window, cx));
        div()
            .id(SharedString::from(format!("set-{}", set.key)))
            .test_support()
            .aria_label(SharedString::from(set.key.clone()))
            .relative()
            .flex()
            .flex_col()
            .flex_1()
            .min_w_0()
            .min_h_0()
            .child(body)
            .children(loupe)
            .child(bar)
            .into_any_element()
    }

    fn render_grid(
        &mut self,
        set: &DuplicateSet,
        rows: &[SetRow],
        kept: &[FileId],
        reason: &model::Reason,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let count = rows.len();
        let scrolls = count > 6;
        let columns = match count {
            0..=1 => 1,
            2 => 2,
            3 => 3,
            4 => 2,
            5 | 6 => 3,
            _ => 4,
        };
        let shared: HashSet<String> = {
            let mut seen = HashSet::new();
            rows.iter()
                .filter(|row| !seen.insert(row.file.dir.clone()))
                .map(|row| row.file.dir.clone())
                .collect()
        };
        let several = kept.len() > 1;
        let tiles: Vec<AnyElement> = rows
            .iter()
            .enumerate()
            .map(|(index, row)| {
                let keeper = keeper_of(set, rows, index, kept)
                    .cloned()
                    .unwrap_or_else(|| row.file.clone());
                self.render_tile(
                    set,
                    row,
                    index,
                    &keeper,
                    kept,
                    reason,
                    shared.contains(&row.file.dir),
                    several,
                    window,
                    cx,
                )
            })
            .collect();
        let mut lines = Vec::new();
        let mut tiles = tiles.into_iter().peekable();
        while tiles.peek().is_some() {
            let line: Vec<AnyElement> = tiles.by_ref().take(columns).collect();
            let missing = columns - line.len();
            lines.push(
                div()
                    .flex()
                    .flex_row()
                    .gap_4()
                    .when(!scrolls, |this| this.flex_1().min_h_0())
                    .when(scrolls, |this| this.h(px(300.)).flex_shrink_0())
                    .children(line)
                    .children((0..missing).map(|_| div().flex_1()))
                    .into_any_element(),
            );
        }
        div()
            .id("version-grid")
            .flex()
            .flex_col()
            .flex_1()
            .min_h_0()
            .gap_4()
            .px_5()
            .pt_4()
            .pb(px(76.))
            .when(scrolls, |this| this.overflow_y_scroll())
            .on_hover(cx.listener(|this, hovered: &bool, _, cx| {
                if !*hovered {
                    this.hover_row = None;
                    cx.notify();
                }
            }))
            .children(lines)
            .into_any_element()
    }

    #[allow(clippy::too_many_arguments)]
    fn render_tile(
        &mut self,
        set: &DuplicateSet,
        row: &SetRow,
        index: usize,
        keeper: &FileRow,
        kept: &[FileId],
        reason: &model::Reason,
        show_name: bool,
        several: bool,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let theme = cx.theme();
        let (primary, border, muted, warning, ground, radius, card) = (
            theme.primary,
            theme.border,
            theme.muted_foreground,
            theme.warning,
            theme.muted,
            theme.radius_lg,
            theme.group_box,
        );
        let file = row.file.clone();
        let number = index + 1;
        let is_kept = kept.contains(&file.id);
        let suggested = reason.close_call && is_kept && !self.overrides.contains_key(&set.key);
        let focused = self.keyboard_focus && self.focus_row() == index;
        let read_only = self.dismissed_mode;
        let facts = facts_of(&file, keeper);
        let copy_of = copy_of_number(set, index);
        let hard_linked = set.hard_linked_ids.contains(&file.id);
        let playing = self
            .video
            .as_ref()
            .filter(|(id, _)| *id == file.id)
            .map(|(_, video)| video.clone());
        let video = file.kind == FileKind::Video && file.probe_error.is_none();
        let is_playing = playing
            .as_ref()
            .is_some_and(|video| video.read(cx).is_playing());
        let picture: AnyElement = match &playing {
            Some(video) => video.clone().into_any_element(),
            None => thumbs::picture(&self.thumbs, &file, 768, ObjectFit::Contain, cx),
        };
        let ring: Hsla = if is_kept {
            if suggested {
                primary.opacity(0.45)
            } else {
                primary
            }
        } else if focused {
            muted
        } else {
            border
        };
        let tooltip = if read_only {
            file.rel_path.clone()
        } else {
            format!(
                "{}\nClick to keep only this one and go on  {number}",
                file.rel_path
            )
        };
        let (look_file, reveal_path, play_file) = (index, file.abs_path.clone(), file.clone());
        let facts_line: Vec<AnyElement> = facts
            .iter()
            .enumerate()
            .flat_map(|(position, fact)| {
                let separator = (position > 0).then(|| div().child(" · ").into_any_element());
                let text = div()
                    .when(fact.worse, |this| {
                        this.text_color(warning).font_weight(FontWeight::MEDIUM)
                    })
                    .child(fact.text.clone())
                    .into_any_element();
                separator.into_iter().chain([text])
            })
            .collect();
        let also: Option<String> = match row.copies.as_slice() {
            [] => None,
            [copy] => Some(format!(
                "Also in {}",
                if copy.dir.is_empty() {
                    "the top folder"
                } else {
                    &copy.dir
                }
            )),
            copies => Some(format!("Also in {} other folders", copies.len())),
        };
        div()
            .id(("version", file.id as u64))
            .test_support()
            .aria_label(SharedString::from(file.name.clone()))
            .aria_selected(is_kept)
            .aria_description(SharedString::from(
                copy_of.map_or_else(String::new, |of| format!("A copy of {of}")),
            ))
            .tooltip({
                let tooltip = SharedString::from(tooltip);
                move |window, cx| {
                    gpui_kit::component::tooltip::Tooltip::new(tooltip.clone()).build(window, cx)
                }
            })
            .relative()
            .flex()
            .flex_col()
            .flex_1()
            .min_w_0()
            .min_h_0()
            .p_1()
            .rounded(radius)
            .border_2()
            .border_color(ring)
            .bg(card)
            .when(!read_only, |this| this.cursor_pointer())
            .on_hover(cx.listener(move |this, hovered: &bool, _, cx| {
                if *hovered {
                    this.hover_row = Some(index);
                    this.keyboard_focus = false;
                    cx.notify();
                }
            }))
            .on_click(
                cx.listener(move |this, event: &gpui_kit::ClickEvent, window, cx| {
                    // A double-click's second click must not decide the next set, now under it.
                    if this.dismissed_mode || event.click_count() > 1 {
                        return;
                    }
                    if event.modifiers().shift {
                        this.toggle_keep(index, cx);
                    } else {
                        this.click_keep(index, window, cx);
                    }
                }),
            )
            .child(
                div()
                    .relative()
                    .flex_1()
                    .min_h_0()
                    .rounded(radius - px(4.))
                    .overflow_hidden()
                    .bg(ground)
                    .child(picture)
                    .child(
                        div()
                            .absolute()
                            .top_2()
                            .left_2()
                            .flex()
                            .flex_row()
                            .items_center()
                            .gap(px(6.))
                            .when(!read_only, |this| {
                                this.child(
                                    Checkbox::new(("keep-version", file.id as u64))
                                        .checked(is_kept)
                                        .accessibility_label(SharedString::from(format!(
                                            "Keep version {number}"
                                        )))
                                        .tooltip(if !is_kept {
                                            format!("Keep this one as well  ⇧{number}")
                                        } else if several {
                                            format!("Don't keep this one  ⇧{number}")
                                        } else {
                                            "Kept. Check another to keep more than one".into()
                                        })
                                        .on_click(cx.listener(move |this, _, _, cx| {
                                            cx.stop_propagation();
                                            this.toggle_keep(index, cx);
                                        })),
                                )
                            })
                            .child(badge(number.to_string().into(), false, cx)),
                    )
                    .child(
                        div()
                            .absolute()
                            .top_2()
                            .right_2()
                            .flex()
                            .flex_row()
                            .items_center()
                            .gap(px(6.))
                            .child(
                                Button::new(("reveal-version", file.id as u64))
                                    .xsmall()
                                    .icon(Icon::new(IconName::FolderOpen))
                                    .accessibility_label("Show in Finder")
                                    .tooltip("Show in Finder  ⇧⌘R")
                                    .on_click(move |_, _, cx| {
                                        cx.stop_propagation();
                                        cx.reveal_path(Path::new(&reveal_path));
                                    }),
                            )
                            .child(
                                Button::new(("look-version", file.id as u64))
                                    .xsmall()
                                    .icon(Icon::new(IconName::Maximize))
                                    .accessibility_label("Look closer")
                                    .tooltip("Look closer  Space")
                                    .on_click(cx.listener(move |this, _, _, cx| {
                                        cx.stop_propagation();
                                        this.open_loupe(look_file, cx);
                                    })),
                            )
                            .when(is_kept, |this| {
                                this.child(badge(
                                    if suggested { "Suggested" } else { "Keep" }.into(),
                                    !suggested,
                                    cx,
                                ))
                            }),
                    )
                    .when(video, |this| {
                        this.child(
                            div().absolute().bottom_2().left_2().child(
                                Button::new(("play-version", file.id as u64))
                                    .xsmall()
                                    .icon(Icon::new(if is_playing {
                                        IconName::Pause
                                    } else {
                                        IconName::Play
                                    }))
                                    .accessibility_label(if is_playing { "Pause" } else { "Play" })
                                    .on_click(cx.listener(move |this, _, window, cx| {
                                        cx.stop_propagation();
                                        this.play(&play_file, window, cx);
                                    })),
                            ),
                        )
                    }),
            )
            .child(
                div()
                    .flex()
                    .flex_col()
                    .px_2()
                    .pt_2()
                    .pb(px(6.))
                    .child(
                        div()
                            .text_size(px(13.))
                            .line_clamp(2)
                            .child(if file.dir.is_empty() {
                                "The top folder".to_string()
                            } else {
                                file.dir.clone()
                            }),
                    )
                    .when(show_name, |this| {
                        this.child(widgets::caption(file.name.clone(), cx).truncate())
                    })
                    .child(
                        div()
                            .flex()
                            .flex_row()
                            .flex_wrap()
                            .text_xs()
                            .text_color(muted)
                            .children(facts_line),
                    )
                    .when_some(copy_of, |this, of| {
                        this.child(widgets::caption(format!("A copy of {of}"), cx))
                    })
                    .when_some(also, |this, also| {
                        this.child(widgets::caption(also, cx).truncate())
                    })
                    .when(hard_linked, |this| {
                        this.child(widgets::caption("A hard link, so it frees nothing", cx))
                    }),
            )
            .into_any_element()
    }

    fn render_copies(
        &mut self,
        set: &DuplicateSet,
        rows: &[SetRow],
        kept: &[FileId],
        reason: &str,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let theme = cx.theme();
        let (border, primary, muted, accent) = (
            theme.border,
            theme.primary,
            theme.muted_foreground,
            theme.accent,
        );
        let read_only = self.dismissed_mode;
        let focus = self.keyboard_focus.then(|| self.focus_row());
        let first = rows.first().map(|row| row.file.clone());
        let (radius_lg, ground) = (theme.radius_lg, theme.muted);
        let preview = first.map(|file| {
            div()
                .h(px(220.))
                .rounded(radius_lg)
                .overflow_hidden()
                .bg(ground)
                .child(thumbs::picture(
                    &self.thumbs,
                    &file,
                    768,
                    ObjectFit::Contain,
                    cx,
                ))
        });
        let linked = &set.hard_linked_ids;
        let lines: Vec<AnyElement> = rows
            .iter()
            .enumerate()
            .map(|(index, row)| {
                let file = &row.file;
                let is_kept = kept.contains(&file.id);
                let reveal = file.abs_path.clone();
                div()
                    .id(("version", file.id as u64))
                    .test_support()
                    .aria_label(SharedString::from(file.name.clone()))
                    .aria_selected(is_kept)
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap_3()
                    .min_h(px(52.))
                    .px_3()
                    .when(index > 0, |this| this.border_t_1().border_color(border))
                    .when(focus == Some(index), |this| this.bg(accent))
                    .when(!read_only, |this| {
                        this.cursor_pointer().hover(|style| style.bg(accent))
                    })
                    .on_hover(cx.listener(move |this, hovered: &bool, _, cx| {
                        if *hovered {
                            this.hover_row = Some(index);
                            cx.notify();
                        }
                    }))
                    .on_click(
                        cx.listener(move |this, event: &gpui_kit::ClickEvent, window, cx| {
                            if this.dismissed_mode || event.click_count() > 1 {
                                return;
                            }
                            if event.modifiers().shift {
                                this.toggle_keep(index, cx);
                            } else {
                                this.click_keep(index, window, cx);
                            }
                        }),
                    )
                    .when(!read_only, |this| {
                        this.child(
                            Checkbox::new(("keep-version", file.id as u64))
                                .checked(is_kept)
                                .accessibility_label(SharedString::from(format!(
                                    "Keep copy {}",
                                    index + 1
                                )))
                                .on_click(cx.listener(move |this, _, _, cx| {
                                    cx.stop_propagation();
                                    this.toggle_keep(index, cx);
                                })),
                        )
                    })
                    .child(badge((index + 1).to_string().into(), false, cx))
                    .child(
                        div()
                            .flex()
                            .flex_col()
                            .flex_1()
                            .min_w_0()
                            .child(div().truncate().text_size(px(13.)).child(
                                if file.dir.is_empty() {
                                    "The top folder".to_string()
                                } else {
                                    file.dir.clone()
                                },
                            ))
                            .child(div().truncate().text_xs().text_color(muted).child(format!(
                                "{} · {}{}",
                                file.name,
                                format::date_time(file.mtime_ms),
                                if linked.contains(&file.id) {
                                    " · a hard link, so it frees nothing"
                                } else {
                                    ""
                                }
                            ))),
                    )
                    .when(is_kept, |this| {
                        this.child(
                            div()
                                .px_2()
                                .py_0p5()
                                .rounded(px(6.))
                                .bg(primary)
                                .text_color(gpui_kit::white())
                                .text_xs()
                                .font_weight(FontWeight::MEDIUM)
                                .child("Keep"),
                        )
                    })
                    .child(
                        Button::new(("reveal-version", file.id as u64))
                            .ghost()
                            .xsmall()
                            .icon(Icon::new(IconName::FolderOpen))
                            .accessibility_label("Show in Finder")
                            .tooltip("Show in Finder  ⇧⌘R")
                            .on_click(move |_, _, cx| {
                                cx.stop_propagation();
                                cx.reveal_path(Path::new(&reveal));
                            }),
                    )
                    .into_any_element()
            })
            .collect();
        div()
            .id("copy-list")
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
                    .pt_5()
                    .pb(px(96.))
                    .children(preview)
                    .child(widgets::caption(reason.to_string(), cx))
                    .child(widgets::card(cx).overflow_hidden().children(lines)),
            )
            .into_any_element()
    }

    fn render_loupe(
        &mut self,
        set: &DuplicateSet,
        rows: &[SetRow],
        kept: &[FileId],
        reason: &model::Reason,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let focus = self.focus_row();
        let Some(row) = rows.get(focus) else {
            return div().into_any_element();
        };
        let file = row.file.clone();
        let is_kept = kept.contains(&file.id);
        let suggested = rows
            .iter()
            .position(|row| kept.contains(&row.file.id))
            .map_or(1, |index| index + 1);
        let playing = self
            .video
            .as_ref()
            .filter(|(id, _)| *id == file.id)
            .map(|(_, video)| video.clone());
        let fit = if self.zoomed {
            ObjectFit::None
        } else {
            ObjectFit::Contain
        };
        let picture: AnyElement = match playing {
            Some(video) => video.into_any_element(),
            None => thumbs::picture(&self.thumbs, &file, 2048, fit, cx),
        };
        let keeper = keeper_of(set, rows, focus, kept)
            .cloned()
            .unwrap_or_else(|| file.clone());
        let facts: Vec<String> = facts_of(&file, &keeper)
            .into_iter()
            .map(|fact| fact.text)
            .collect();
        let close_call = reason.close_call;
        div()
            .id("loupe")
            .test_support()
            .aria_label(SharedString::from(format!(
                "{} of {}",
                focus + 1,
                rows.len()
            )))
            .absolute()
            .inset_0()
            .flex()
            .flex_col()
            .bg(gpui_kit::black())
            .text_color(gpui_kit::white())
            .child(
                div()
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap_3()
                    .h(px(44.))
                    .px_4()
                    .child(
                        div()
                            .text_size(px(13.))
                            .font_weight(FontWeight::MEDIUM)
                            .child(format!("{} of {}", focus + 1, rows.len())),
                    )
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .truncate()
                            .text_xs()
                            .opacity(0.7)
                            .child(format!("{} · {}", file.rel_path, facts.join(" · "))),
                    )
                    .when(is_kept, |this| {
                        this.child(div().text_xs().child(if close_call {
                            "Suggested".to_string()
                        } else {
                            "Keep".to_string()
                        }))
                    })
                    .when(!is_kept, |this| {
                        this.child(
                            div()
                                .text_xs()
                                .opacity(0.7)
                                .child(format!("Suggested: {suggested}")),
                        )
                    })
                    .child(
                        Button::new("loupe-close")
                            .ghost()
                            .xsmall()
                            .icon(Icon::new(IconName::Close))
                            .accessibility_label("Close")
                            .tooltip("Esc")
                            .on_click(cx.listener(|this, _, _, cx| this.close_loupe(cx))),
                    ),
            )
            .child(
                div()
                    .id("loupe-picture")
                    .flex_1()
                    .min_h_0()
                    .overflow_hidden()
                    .pb(px(76.))
                    .on_click(cx.listener(|this, _, _, cx| {
                        this.zoomed = !this.zoomed;
                        cx.notify();
                    }))
                    .child(picture),
            )
            .into_any_element()
    }

    fn render_decision_bar(
        &self,
        set: &DuplicateSet,
        rows: &[SetRow],
        kept: &[FileId],
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let theme = cx.theme();
        let removed = removal_of(set, kept).len();
        let focus = self.focus_row();
        let mut bar = div()
            .flex()
            .flex_row()
            .items_center()
            .gap_2()
            .p(px(6.))
            .rounded(theme.radius_lg)
            .bg(theme.popover)
            .border_1()
            .border_color(theme.border)
            .shadow_lg();
        if self.dismissed_mode {
            bar = bar
                .child(widgets::caption("You marked these as not duplicates", cx).px_3())
                .child(
                    widgets::primary_action("duplicates-decide", "Restore", "↩")
                        .on_click(cx.listener(|this, _, window, cx| this.decide(window, cx))),
                );
        } else {
            if self.looking {
                bar = bar
                    .child(
                        Button::new("loupe-previous")
                            .ghost()
                            .icon(Icon::new(IconName::ChevronLeft))
                            .accessibility_label("Previous version")
                            .tooltip("Previous version  ←")
                            .disabled(focus == 0)
                            .on_click(cx.listener(|this, _, _, cx| this.focus_by(-1, cx))),
                    )
                    .child(
                        Button::new("loupe-next")
                            .ghost()
                            .icon(Icon::new(IconName::ChevronRight))
                            .accessibility_label("Next version")
                            .tooltip("Next version  →")
                            .disabled(focus + 1 >= rows.len())
                            .on_click(cx.listener(|this, _, _, cx| this.focus_by(1, cx))),
                    );
            }
            bar = bar.child(
                Button::new("duplicates-skip")
                    .outline()
                    .label("Skip")
                    .tooltip("Skip for now  S")
                    .on_click(cx.listener(|this, _, _, cx| this.skip(cx))),
            );
            if removed > 0 {
                bar = bar.child(
                    Button::new("duplicates-keep-every")
                        .outline()
                        .label(keep_every_label(set, rows))
                        .tooltip(format!(
                            "Keep every {} and stop showing this set  N",
                            if set.kind == DuplicateKind::Exact {
                                "copy"
                            } else {
                                "version"
                            }
                        ))
                        .on_click(cx.listener(|this, _, window, cx| this.dismiss(window, cx))),
                );
            }
            let label = self.decision().unwrap_or_default();
            let tooltip = if self.looking {
                format!("Keep only {} and go on", focus + 1)
            } else {
                holding_summary(set, rows, kept)
            };
            bar = bar.child(
                widgets::primary_action("duplicates-decide", label, "↩")
                    .tooltip(tooltip)
                    .on_click(cx.listener(|this, _, window, cx| {
                        if this.looking {
                            let focus = this.focus_row();
                            this.keep_only(focus, window, cx);
                        } else {
                            this.decide(window, cx);
                        }
                    })),
            );
        }
        div()
            .absolute()
            .bottom(px(20.))
            .left_0()
            .right_0()
            .flex()
            .justify_center()
            .child(bar)
            .into_any_element()
    }

    fn render_empty(&self, cx: &mut Context<Self>) -> AnyElement {
        let page = self.page();
        let scope = self.scope(cx);
        let fingerprinting = page.is_some_and(|page| page.fingerprinted < page.fingerprintable);
        let comparing = page.is_some_and(|page| page.compared < page.comparable);
        let title = if self.dismissed_mode {
            "Nothing marked as not duplicates"
        } else {
            match scope {
                DuplicateScope::Variants if comparing => "No variants found yet",
                DuplicateScope::Variants => "No sets of variants",
                DuplicateScope::Similar | DuplicateScope::All if self.freed_here > 0 => {
                    "All similar sets done"
                }
                DuplicateScope::Similar | DuplicateScope::All if fingerprinting => {
                    "No similar versions found yet"
                }
                DuplicateScope::Similar | DuplicateScope::All => "No similar versions",
                DuplicateScope::Exact => "No identical copies",
            }
        };
        let body = if self.freed_here > 0 {
            Some(format!(
                "{} moved to holding.",
                format::bytes(self.freed_here as f64)
            ))
        } else if fingerprinting && scope == DuplicateScope::Similar && !self.dismissed_mode {
            page.map(|page| {
                format!(
                    "Still checking for similar versions: {} of {}.",
                    format::count(page.fingerprinted),
                    format::count(page.fingerprintable)
                )
            })
        } else if scope == DuplicateScope::Variants && !self.dismissed_mode {
            Some(
                "Similar sets whose pictures each differ in one area come here, since none of \
                 them is a copy."
                    .into(),
            )
        } else {
            None
        };
        let other = if scope == DuplicateScope::Exact {
            DuplicateScope::Similar
        } else {
            DuplicateScope::Exact
        };
        let other_count = page.map_or(0, |page| match other {
            DuplicateScope::Exact => page.counts.exact,
            _ => page.counts.similar,
        });
        let mut actions = Vec::new();
        if !self.dismissed_mode {
            actions.push(
                Button::new("duplicates-back")
                    .outline()
                    .label("Back to Overview")
                    .on_click(cx.listener(|this, _, _, cx| {
                        this.state
                            .update(cx, |state, cx| state.go(TidyPage::Overview, cx));
                    }))
                    .into_any_element(),
            );
            if other_count > 0 {
                actions.push(
                    Button::new("duplicates-other")
                        .outline()
                        .label(if other == DuplicateScope::Exact {
                            "Show identical copies"
                        } else {
                            "Show similar versions"
                        })
                        .on_click(cx.listener(move |this, _, _, cx| this.change_scope(other, cx)))
                        .into_any_element(),
                );
            }
        }
        let header = self.render_scope_switch(cx);
        let theme = cx.theme();
        div()
            .flex()
            .flex_row()
            .flex_1()
            .min_h_0()
            .when_some(header, |this, header| {
                this.child(
                    div()
                        .w(px(248.))
                        .flex_shrink_0()
                        .px_3()
                        .pt_3()
                        .border_r_1()
                        .border_color(theme.border)
                        .child(header),
                )
            })
            .child(widgets::empty_state(
                "duplicates-empty",
                Some(IconName::CircleCheck),
                title,
                body.map(IntoElement::into_any_element),
                actions,
                cx,
            ))
            .into_any_element()
    }
}

/// A number or a Keep on a picture (`lw-badge`).
fn badge(text: SharedString, keep: bool, cx: &App) -> AnyElement {
    let theme = cx.theme();
    div()
        .min_w(px(24.))
        .h(px(22.))
        .px(px(6.))
        .flex()
        .items_center()
        .justify_center()
        .rounded(px(6.))
        .text_xs()
        .font_weight(FontWeight::MEDIUM)
        .map(|this| {
            if keep {
                this.bg(theme.primary).text_color(gpui_kit::white())
            } else {
                this.bg(gpui_kit::black().opacity(0.6))
                    .text_color(gpui_kit::white())
            }
        })
        .child(text)
        .into_any_element()
}

/// One row of the queue: the keeper's thumbnail, its name and the set's size; a close call
/// carries an amber dot, and a skipped set is dimmed.
fn render_queue_row(
    page: &Entity<DuplicatesPage>,
    index: usize,
    muted: Hsla,
    cx: &mut App,
) -> AnyElement {
    let this = page.read(cx);
    let sets = this.sets();
    let Some(set) = sets.get(index).copied().cloned() else {
        return div().into_any_element();
    };
    let active = index == this.index();
    let overridden = this.overrides.get(&set.key).cloned();
    let skipped = this.skipped.contains(&set.key);
    let thumbs = this.thumbs.clone();
    let kept = kept_ids(&set, overridden.as_deref());
    let files = files_of(&set);
    let keeper = files
        .iter()
        .find(|file| kept.contains(&file.id))
        .or(files.first())
        .map(|file| (*file).clone());
    let close_call = overridden.is_none() && is_close_call(&set);
    let caption = if skipped {
        "Skipped".to_string()
    } else {
        format!(
            "{} · {}",
            if set.kind == DuplicateKind::Exact {
                format::plural_as(files.len() as i64, "copy", "copies")
            } else {
                format::plural(set.versions.len() as i64, "version")
            },
            format::bytes(set.reclaimable_bytes as f64)
        )
    };
    let theme = cx.theme();
    let (selected, hover, radius, warning) = (
        theme.list_active,
        theme.list_hover,
        theme.radius,
        theme.warning,
    );
    let picture = keeper
        .as_ref()
        .map(|file| thumbs::picture(&thumbs, file, 80, ObjectFit::Cover, cx));
    let target = page.downgrade();
    div()
        .id(("set-row", index))
        .test_support()
        .aria_label(SharedString::from(
            keeper
                .as_ref()
                .map(|file| file.name.clone())
                .unwrap_or_default(),
        ))
        .aria_description(SharedString::from(set.key.clone()))
        .aria_selected(active)
        .flex()
        .flex_row()
        .items_center()
        .gap_3()
        .w_full()
        .h(px(QUEUE_ROW - 4.))
        .my(px(2.))
        .px_2()
        .rounded(radius)
        .cursor_pointer()
        .when(active, |this| this.bg(selected))
        .when(!active, |this| this.hover(|style| style.bg(hover)))
        .when(skipped, |this| this.opacity(0.55))
        .on_click(move |_, _, cx| {
            target
                .update(cx, |page, cx| {
                    page.active_index = index;
                    page.looking = false;
                    page.follow_active(cx);
                    cx.notify();
                })
                .ok();
        })
        .child(
            div()
                .size(px(40.))
                .flex_shrink_0()
                .rounded(radius)
                .overflow_hidden()
                .children(picture),
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
                        .child(keeper.map(|file| file.name).unwrap_or_default()),
                )
                .child(
                    div()
                        .flex()
                        .flex_row()
                        .items_center()
                        .gap(px(6.))
                        .text_xs()
                        .text_color(muted)
                        .when(close_call, |this| {
                            this.child(div().size(px(6.)).rounded_full().bg(warning))
                        })
                        .child(div().truncate().child(caption)),
                ),
        )
        .into_any_element()
}

impl Focusable for DuplicatesPage {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}

impl Render for DuplicatesPage {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let top_bar = self.render_top_bar(cx);
        let body: AnyElement = if self.page().is_none() {
            widgets::empty_state(
                "duplicates-loading",
                None,
                "Finding duplicates…",
                None,
                Vec::new(),
                cx,
            )
            .into_any_element()
        } else if self.sets().is_empty() {
            self.render_empty(cx)
        } else {
            let queue = self.render_queue(cx);
            let stage = self.render_stage(window, cx);
            div()
                .flex()
                .flex_row()
                .flex_1()
                .min_h_0()
                .items_stretch()
                .child(queue)
                .child(stage)
                .into_any_element()
        };
        div()
            .id("duplicates")
            .track_focus(&self.focus)
            .key_context("TidyDuplicates")
            .on_key_down(cx.listener(Self::on_key_down))
            .flex()
            .flex_col()
            .size_full()
            .min_h_0()
            .child(top_bar)
            .child(body)
    }
}
