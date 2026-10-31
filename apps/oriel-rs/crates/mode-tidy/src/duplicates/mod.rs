//! Duplicates (`views/DuplicatesView.tsx`): the queue of sets on the left (Similar, Variants and
//! Identical), the set on the stage (similar versions as the version grid with playing video
//! tiles, identical copies as the copy list), the loupe, and the decision bar.
//!
//! A similar set's videos play in their tiles as soon as the set is on the stage, silent and
//! looping, so versions are compared moving without a press on a small button; a click on a
//! video's picture pauses or plays it, and a click on the rest of its tile keeps it, as a click
//! anywhere on a still's tile does. Only tiles on screen play, and none under the loupe, on
//! another page or with Tidy hidden. The loupe and the copy list play one video with its sound.
//!
//! Return keeps the suggestion and moves on; 1–9 keep only that version; ⇧1–9 keep it as well;
//! N keeps every version and marks the set as not duplicates, which its Undo (the toast's, ⌘Z,
//! or History's, which lists such sets in place of Electron Oriel's list of them) brings back;
//! S skips; ↑ ↓
//! (J K) move through the queue and ← → (H L) through the versions; Space or C looks closer, Z
//! shows actual size, M turns sound on or off, P prefers the version's folder, ⌘Y shows it in
//! Quick Look and ⇧⌘R in Finder. Each decision says what it did in a toast with its own Undo.

pub mod model;
mod video;

use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::rc::Rc;
use std::time::{Duration, Instant};

use gpui_kit::assets::IconName;
use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::checkbox::Checkbox;
use gpui_kit::component::kbd::Kbd;
use gpui_kit::component::menu::{ContextMenuExt as _, DropdownMenu as _, PopupMenu, PopupMenuItem};
use gpui_kit::component::popover::Popover;
use gpui_kit::component::{ActiveTheme as _, Disableable as _, Icon, Sizable as _};
use gpui_kit::{
    Anchor, AnyElement, App, AppContext as _, Context, Entity, FocusHandle, Focusable, FontWeight,
    Hsla, InteractiveElement as _, IntoElement, KeyDownEvent, Keystroke, MouseButton, ObjectFit,
    ParentElement as _, Pixels, Render, Role, ScrollHandle, SharedString,
    StatefulInteractiveElement as _, Styled as _, StyledImage as _, Subscription,
    TestSupportExt as _, UniformListScrollHandle, WeakEntity, Window, div, img,
    prelude::FluentBuilder as _, px, rems, uniform_list,
};
use oriel_core_tidy::contract::{
    DuplicateKind, DuplicateScope, DuplicateSet, DuplicateSetPage, DuplicateSetRequest, FileId,
    FileKind, FileRow, RootId, SimilarityLevel, is_close_call,
};
use oriel_ui::layout::NavItem;
use oriel_ui::{ControlSize as _, Toast, TopBar, checkbox_target};

use crate::actions::PerformOptions;
use crate::changes::{PlanRequest, ResolveGroup};
use crate::format;
use crate::loaded::Loaded;
use crate::pages::TidyPage;
use crate::quick_look::{QUICK_LOOK_LABEL, quick_look};
use crate::state::TidyState;
use crate::thumbs::{self, Thumb, Thumbs};
use crate::widgets;

pub use model::SetRow;
use model::{
    Lane, Standing, copy_of_number, decision_label, facts_of, files_of, freed_bytes, has_video,
    keep_every_label, keeper_of, kept_ids, reason_of, removal_of, rows_of,
};
use video::TileVideo;

/// Sets read at once, and how many more as the queue nears its end.
const PAGE: usize = 100;

/// How long a click on a new set waits, so a double-click never decides two sets.
const ARM_DELAY: Duration = Duration::from_millis(400);

/// A set of more versions than this scrolls, a line of four at a time.
const FITS: usize = 6;

/// The height of a line of versions once the grid scrolls, which the grid's own arithmetic
/// (`lines_to_draw`) needs in pixels. The space between lines, above the first and below the
/// last is a rem (`gap_4`, `pt_4`, `pb_4`). It holds the tallest facts a tile shows (a video's
/// lanes, its name and a note: about 210 px) above a picture of [`PICTURE_LEAST`].
const LINE: f32 = 320.;

/// The least height of a version's picture, in rems: a stage too short to give every tile that
/// much over its facts scrolls, rather than letting the facts cover the picture.
const PICTURE_LEAST: f32 = 6.;

/// The loupe's surround: always this near-black, with light text, so a picture is judged on a
/// neutral ground in either theme; and the amber its losses read in on it.
const LOUPE_SURFACE: u32 = 0x09_09_0b;
const LOUPE_TEXT: u32 = 0xf4_f4_f5;
const LOUPE_LOSS: u32 = 0xfc_d3_4d;

/// The longest side a version tile's video frames are drawn at: about a tile's at most.
const TILE_VIDEO_SIDE: u32 = 1024;

/// Opens the top bar's Matching popover when the page first draws, for a check in a real window,
/// since this Mac allows no scripted clicks.
const MATCHING_VARIABLE: &str = "ORIEL_RS_DUPLICATES_MATCHING";

/// Lines above and below the screen whose pictures are decoded ahead of a scroll, but not drawn.
const NEAR_LINES: usize = 1;

/// The longest side the loupe decodes a picture at for actual size: GPUI's sprite atlas holds no
/// texture larger (Metal's and Direct3D's 16384), and one larger comes out blank. A panorama or a
/// scan past it shows at this size instead, and the loupe's actual size means it.
const MAX_PICTURE_SIDE: u32 = 16_384;

/// The loupe's picture before it is fitted, as decoding draws it: the file's size, or the size it
/// is held to on its longer side ([`MAX_PICTURE_SIDE`]).
fn actual_size(file: &FileRow) -> Option<(f32, f32)> {
    let (w, h) = file
        .width
        .zip(file.height)
        .filter(|(w, h)| *w > 0 && *h > 0)?;
    let scale = (MAX_PICTURE_SIDE as f32 / w.max(h) as f32).min(1.);
    Some((w as f32 * scale, h as f32 * scale))
}

/// A set's sets and the catalog version they were read at.
type Queue = (DuplicateSetPage, u64);

pub struct DuplicatesPage {
    state: Entity<TidyState>,
    thumbs: Entity<Thumbs>,
    focus: FocusHandle,
    /// The tab the owner chose; `None` until the first answer picks one.
    chosen_scope: Option<DuplicateScope>,
    queue: Loaded<Queue>,
    wanted: usize,
    active_index: usize,
    focused_row: usize,
    /// The focus is drawn only once the arrows move it, so a new set never looks half-picked.
    keyboard_focus: bool,
    hover_row: Option<usize>,
    looking: bool,
    zoomed: bool,
    /// The loupe's stage, which scrolls at actual size, and where to zoom in next: the point
    /// clicked or under the pointer, as shares of the picture, kept across flips.
    loupe_scroll: ScrollHandle,
    zoom_at: Option<(f32, f32)>,
    /// The pointer over the loupe's picture, as shares of it, for Z.
    pointer_at: Option<(f32, f32)>,
    /// A zoom that waits to centre its point, once the stage has its actual-size picture.
    center_zoom: bool,
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
    /// The video the loupe or the copy list plays, with its sound.
    video: Option<(FileId, Entity<TileVideo>)>,
    /// The version tiles' videos on screen, silent and looping, by file.
    tile_videos: HashMap<FileId, Entity<TileVideo>>,
    /// The tiles of the set on screen whose video the owner paused, which stay paused.
    paused_tiles: HashSet<FileId>,
    /// The scroll of the version grid drawn last, for the pages spike.
    grid_scroll: Option<ScrollHandle>,
    seen: (
        Option<RootId>,
        u64,
        Option<DuplicateScope>,
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
            queue: Loaded::default(),
            wanted: PAGE,
            active_index: 0,
            focused_row: 1,
            keyboard_focus: false,
            hover_row: None,
            looking: false,
            zoomed: false,
            loupe_scroll: ScrollHandle::new(),
            zoom_at: None,
            pointer_at: None,
            center_zoom: false,
            sound_on: true,
            overrides: HashMap::new(),
            skipped: HashSet::new(),
            hidden: HashMap::new(),
            return_to: None,
            freed_here: 0,
            armed_at: Instant::now(),
            active_key: None,
            video: None,
            tile_videos: HashMap::new(),
            paused_tiles: HashSet::new(),
            grid_scroll: None,
            seen: (None, 0, None, None),
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
        Some(if self.looking {
            format!("Keep {}", self.focus_row() + 1)
        } else {
            decision_label(&rows_of(set), &self.kept())
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
        // Another page on screen: Electron Oriel unmounts Duplicates, and its video with it.
        if !visible {
            self.video = None;
            self.tile_videos.clear();
        }
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
            dismissed: false,
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
            self.tile_videos.clear();
            self.paused_tiles.clear();
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

    /// N, Keep both or Keep all: keeps every version and marks the set as not duplicates, so it
    /// leaves review. Its Undo, in the toast, on ⌘Z or in History, brings it back.
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
                    let message = if set.kind == DuplicateKind::Exact {
                        "Kept every copy"
                    } else {
                        "Marked as not duplicates"
                    };
                    crate::widgets::show_toast(
                        window,
                        Toast::done(message).action("Undo", move |_, cx| {
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
                        Toast::error("Couldn't mark the set as not duplicates")
                            .detail(format!("{error:#}")),
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
        self.resolve_with(set, vec![row.file.id], window, cx);
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
        self.keep_video_in_sight();
        cx.notify();
    }

    /// Open in View, for one of the set's files (`useOpenInView`).
    fn open_in_view(&mut self, file: String, cx: &mut Context<Self>) {
        self.state
            .update(cx, |state, cx| state.open_in_view(file, cx));
    }

    fn open_loupe(&mut self, index: usize, cx: &mut Context<Self>) {
        self.focused_row = index;
        self.zoomed = false;
        self.looking = true;
        self.keep_video_in_sight();
        cx.notify();
    }

    /// Closing the loupe stops its video, as Electron Oriel's loupe unmounts its own.
    fn close_loupe(&mut self, cx: &mut Context<Self>) {
        self.looking = false;
        self.zoomed = false;
        self.video = None;
        cx.notify();
    }

    /// The loupe shows one version: a video of another would play on out of sight, with its
    /// sound, so a flip or a new focus stops it, as the loupe's `<video key={file.id}>` does in
    /// Electron Oriel. Dropping the player pauses it at once and gives its engine back.
    fn keep_video_in_sight(&mut self) {
        if !self.looking {
            return;
        }
        let shown = self.rows().get(self.focus_row()).map(|row| row.file.id);
        if self
            .video
            .as_ref()
            .is_some_and(|(id, _)| Some(*id) != shown)
        {
            self.video = None;
        }
    }

    /// Pauses the video playing, if any, as Electron Oriel pauses a hidden mode's media: Tidy
    /// left the screen. Coming back, it shows paused where it was.
    /// The tiles' videos go, giving their engines back, and start again when Tidy is back.
    pub fn pause_video(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if let Some((_, video)) = &self.video {
            video.update(cx, |video, cx| video.pause(window, cx));
        }
        self.tile_videos.clear();
    }

    /// The files whose tile video is playing.
    pub fn playing_tiles(&self, cx: &App) -> Vec<FileId> {
        let mut playing: Vec<FileId> = self
            .tile_videos
            .iter()
            .filter(|(_, video)| video.read(cx).is_playing())
            .map(|(id, _)| *id)
            .collect();
        playing.sort_unstable();
        playing
    }

    /// The files whose tile holds a video player, playing or paused.
    pub fn tile_players(&self) -> usize {
        self.tile_videos.len()
    }

    /// A click on a video tile's picture: pauses its video, or plays it again.
    fn toggle_tile(&mut self, file: FileId, window: &mut Window, cx: &mut Context<Self>) {
        match self.tile_videos.get(&file) {
            Some(video) => {
                let playing = video.update(cx, |video, cx| {
                    video.toggle(window, cx);
                    video.is_playing()
                });
                if playing {
                    self.paused_tiles.remove(&file);
                } else {
                    self.paused_tiles.insert(file);
                }
            }
            // Paused, then put away with Tidy hidden: the next frame opens it, playing.
            None => {
                self.paused_tiles.remove(&file);
            }
        }
        cx.notify();
    }

    /// Whether Tidy is the mode on screen, with no Settings over it.
    fn on_screen(&self, cx: &App) -> bool {
        let shell = self.state.read(cx).shell.read(cx);
        shell.mode() == oriel_ui::ModeId::Tidy && shell.settings().is_none()
    }

    /// Keeps a player for each video tile in `shown`, and none for any other: a tile opens its
    /// own when it comes on screen, playing unless the owner paused it, and gives it back as it
    /// leaves. So no more play than there are tiles on screen, each an engine from mpv's pool.
    fn keep_tile_videos(&mut self, shown: &[&FileRow], cx: &mut Context<Self>) {
        let wanted: HashSet<FileId> = shown
            .iter()
            .filter(|file| file.kind == FileKind::Video && file.probe_error.is_none())
            .map(|file| file.id)
            .collect();
        self.tile_videos.retain(|id, _| wanted.contains(id));
        for file in shown {
            if wanted.contains(&file.id)
                && !self.tile_videos.contains_key(&file.id)
                && !self.paused_tiles.contains(&file.id)
            {
                let path = Path::new(&file.abs_path).to_path_buf();
                let video = cx.new(|cx| TileVideo::silent(path, TILE_VIDEO_SIDE, cx));
                self.tile_videos.insert(file.id, video);
            }
        }
    }

    /// The file whose video plays, or shows paused, if one does.
    pub fn video_file(&self) -> Option<FileId> {
        self.video.as_ref().map(|(id, _)| *id)
    }

    /// Whether the video the page holds is playing.
    pub fn is_video_playing(&self, cx: &App) -> bool {
        self.video
            .as_ref()
            .is_some_and(|(_, video)| video.read(cx).is_playing())
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
        self.video = Some((file.id, cx.new(|cx| TileVideo::new(path, muted, cx))));
        cx.notify();
    }

    // What the pages spike (`crate::page_spike`) does in place of the owner's keys.

    /// The next set or the one before, as ↓ and ↑ show them.
    pub(crate) fn spike_move(&mut self, delta: isize, cx: &mut Context<Self>) {
        self.move_by(delta, cx);
    }

    /// Opens the loupe on the set's second version, as Space does, or closes it.
    pub(crate) fn spike_loupe(&mut self, open: bool, cx: &mut Context<Self>) {
        if open {
            self.open_loupe(1, cx);
        } else {
            self.close_loupe(cx);
        }
    }

    /// Goes to the first set with a video and plays it in its tile; false when there is none.
    pub(crate) fn spike_play_video(&mut self, window: &mut Window, cx: &mut Context<Self>) -> bool {
        let found = self.sets().iter().enumerate().find_map(|(index, set)| {
            let file = files_of(set)
                .into_iter()
                .find(|file| file.kind == FileKind::Video)?;
            Some((index, file.clone()))
        });
        let Some((index, file)) = found else {
            return false;
        };
        self.active_index = index;
        self.follow_active(cx);
        // A similar set's tiles play by themselves; the copy list plays on asking.
        if self
            .active()
            .is_some_and(|set| set.kind == DuplicateKind::Exact)
        {
            self.play(&file, window, cx);
        }
        true
    }

    /// Whether the set's first `count` versions show their pictures: what the grid shows before
    /// it is scrolled.
    pub(crate) fn spike_tiles_shown(&self, count: usize, cx: &App) -> bool {
        let thumbs = self.thumbs.read(cx);
        let rows = self.rows();
        !rows.is_empty()
            && rows
                .iter()
                .take(count)
                .all(|row| thumbs.is_done(Path::new(&row.file.abs_path), 768))
    }

    /// The version grid's scroll, while the set on screen has one.
    pub(crate) fn spike_grid_scroll_handle(&self) -> Option<ScrollHandle> {
        self.grid_scroll.clone()
    }

    /// Whether the video playing has shown its first picture.
    pub(crate) fn spike_video_shows(&self, cx: &App) -> bool {
        self.video
            .as_ref()
            .is_some_and(|(_, video)| video.read(cx).shows_picture())
            || self
                .tile_videos
                .values()
                .any(|video| video.read(cx).shows_picture())
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
        // ⌘, or Ctrl elsewhere, as Electron Oriel's `isCommandKey` reads either.
        let command = modifiers.platform || modifiers.control;
        if command && modifiers.shift && key == "r" {
            if let Some(row) = rows.get(self.target()) {
                cx.reveal_path(Path::new(&row.file.abs_path));
            }
            cx.stop_propagation();
            return;
        }
        if command && key == "y" {
            if let Some(row) = rows.get(self.target()) {
                quick_look(Path::new(&row.file.abs_path), window, cx);
            }
            cx.stop_propagation();
            return;
        }
        if modifiers.platform || modifiers.control || modifiers.alt {
            return;
        }
        if let Some(digit) = digit {
            if digit <= rows.len() {
                if modifiers.shift {
                    self.toggle_keep(digit - 1, cx);
                    self.focused_row = digit - 1;
                    self.keep_video_in_sight();
                } else {
                    self.keep_only(digit - 1, window, cx);
                }
            }
            cx.stop_propagation();
            return;
        }
        // Electron reads the key as typed, so ⇧ still means the letter, except for H and L,
        // which only move as lower case there.
        if modifiers.shift && matches!(key, "h" | "l") {
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
            "n" => self.dismiss(window, cx),
            "p" => {
                if let Some(row) = rows.get(self.target()) {
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
                    let zooming = !self.looking || !self.zoomed;
                    self.looking = true;
                    self.keep_video_in_sight();
                    self.toggle_zoom(zooming, self.pointer_at, cx);
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
                        quick_look(Path::new(&row.file.abs_path), window, cx);
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

    /// The page's title and what counts as a duplicate. How far the analysis has got (checking
    /// fingerprints, comparing similar pictures) is in the activity panel with the job's other
    /// work.
    fn render_top_bar(&self, cx: &mut Context<Self>) -> TopBar {
        let shell = self.state.read(cx).shell.clone();
        // What counts as similar matters only where similar versions are shown.
        let matching = self.scope(cx) != DuplicateScope::Exact;
        TopBar::new(&shell, "Duplicates")
            .when(matching, |bar| bar.trailing(self.render_matching(cx)))
    }

    /// "Matching: Balanced…": the settings that decide what counts as a duplicate, Settings ›
    /// Tidy's own, in a popover from the top bar, a control of the standard size.
    fn render_matching(&self, cx: &App) -> AnyElement {
        let level = self
            .state
            .read(cx)
            .settings()
            .map_or(SimilarityLevel::Balanced, |settings| settings.similarity);
        let state = self.state.clone();
        let open_at_start =
            std::env::var_os(MATCHING_VARIABLE).is_some_and(|value| !value.is_empty());
        Popover::new("duplicates-matching-popover")
            .anchor(Anchor::TopRight)
            .default_open(open_at_start)
            .trigger(Button::new("duplicates-matching").outline().label(format!(
                "Matching: {}…",
                crate::settings::similarity_label(level)
            )))
            .content(move |_, _, cx| {
                let Some(settings) = state.read(cx).settings().cloned() else {
                    return div().into_any_element();
                };
                crate::settings::matching_popover(&state, &settings, "duplicates", cx)
            })
            .into_any_element()
    }

    /// The queue's scopes as rows, in the pattern of the sidebar's: Similar, Variants (with Spot
    /// variants on) and Identical. A row with nothing in it is dimmed, but stays where it is.
    fn render_scope_list(&self, cx: &mut Context<Self>) -> AnyElement {
        let counts = self.page().map(|page| page.counts);
        let scope = self.scope(cx);
        let mut scopes = vec![(
            DuplicateScope::Similar,
            "Similar",
            IconName::Images,
            counts.map(|counts| counts.similar),
        )];
        if self.spot_variants(cx) {
            scopes.push((
                DuplicateScope::Variants,
                "Variants",
                IconName::GalleryVerticalEnd,
                counts.map(|counts| counts.variants),
            ));
        }
        scopes.push((
            DuplicateScope::Exact,
            "Identical",
            IconName::Copy,
            counts.map(|counts| counts.exact),
        ));
        let this = cx.entity().downgrade();
        let muted = cx.theme().muted_foreground;
        let rows = scopes.into_iter().map(|(value, label, icon, count)| {
            let this = this.clone();
            let current = value == scope;
            let shown = count.map(format::count);
            div()
                .when(count == Some(0) && !current, |this| this.opacity(0.5))
                .child(
                    NavItem::new(
                        SharedString::from(format!("scope-{value}")),
                        Icon::new(icon),
                        label,
                    )
                    .accessibility_label(match &shown {
                        Some(shown) => format!("{label} {shown}"),
                        None => label.to_string(),
                    })
                    .current(current)
                    .when_some(shown, |item, shown| {
                        item.trailing(
                            div()
                                .flex_shrink_0()
                                .text_xs()
                                .text_color(muted)
                                .child(shown),
                        )
                    })
                    .on_click(move |_, _, cx| {
                        this.update(cx, |this, cx| this.change_scope(value, cx))
                            .ok();
                    }),
                )
        });
        div()
            .id("duplicates-scopes")
            .test_support()
            .role(Role::Navigation)
            .aria_label("Duplicates to show")
            .flex()
            .flex_col()
            .gap_0p5()
            .children(rows)
            .into_any_element()
    }

    /// The queue's column: the scopes, then the sets of the scope on screen. `sets` is empty
    /// for a scope with nothing in it, where the column keeps only its scopes.
    fn render_queue(&self, sets: bool, cx: &mut Context<Self>) -> AnyElement {
        let theme = cx.theme();
        let (border, muted) = (theme.border, theme.muted_foreground);
        let header = self.render_scope_list(cx);
        let count = self.sets().len();
        let this = cx.entity().downgrade();
        div()
            .flex()
            .flex_col()
            .w(rems(16.))
            .flex_shrink_0()
            .h_full()
            .border_r_1()
            .border_color(border)
            .child(
                div()
                    .flex_shrink_0()
                    .px_2()
                    .pt_3()
                    .pb_2()
                    .when(sets, |this| this.border_b_1().border_color(border))
                    .child(header),
            )
            .when(sets, |this_column| {
                this_column.child(
                    uniform_list("duplicates-queue", count, move |range, _, cx| {
                        let Some(page) = this.upgrade() else {
                            return Vec::new();
                        };
                        range
                            .map(|index| render_queue_row(&page, index, muted, cx))
                            .collect()
                    })
                    .track_scroll(&self.queue_scroll)
                    .flex_1()
                    .px_2()
                    .pt_1()
                    .pb_3(),
                )
            })
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
        let line = (!reason.text.is_empty()).then(|| render_decision_line(&reason, cx));
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
            .flex()
            .flex_col()
            .flex_1()
            .min_w_0()
            .min_h_0()
            .child(
                // The loupe covers the decision line and the versions, never the bar.
                div()
                    .relative()
                    .flex()
                    .flex_col()
                    .flex_1()
                    .min_h_0()
                    .children(line)
                    .child(body)
                    .children(loupe),
            )
            .child(bar)
            .into_any_element()
    }

    /// The versions, a tile each: as many as fit fill the stage, and more scroll in lines of
    /// four. Only the lines on screen are drawn, and their videos play; the pictures of the lines
    /// just past the screen are decoded ahead; a line not drawn keeps its place, so the grid
    /// scrolls as if every line were there.
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
        let scrolls = count > FITS;
        let columns = match count {
            0..=1 => 1,
            2 => 2,
            3 => 3,
            4 => 2,
            5 | 6 => 3,
            _ => 4,
        };
        // Every tile carries the same lines, so the pictures above them stay the same height:
        // the name when two versions share a folder, the video lanes when one is a video, and
        // a line of notes when one has a note.
        let layout = TileLayout {
            names: {
                let mut seen = HashSet::new();
                rows.iter().any(|row| !seen.insert(row.file.dir.as_str()))
            },
            video: has_video(rows),
            notes: rows
                .iter()
                .enumerate()
                .any(|(index, row)| !tile_notes(set, row, index).is_empty()),
        };
        let several = kept.len() > 1;
        let focused = self.keyboard_focus.then(|| self.focus_row());
        let total_lines = count.div_ceil(columns);
        // The scroll lives as long as the set's grid is drawn frame after frame, as an element's
        // own would: a new set, or the page shown again, starts at the top.
        let scroll = scrolls.then(|| {
            window
                .use_keyed_state(
                    SharedString::from(format!("version-grid-{}", set.key)),
                    cx,
                    |_, _| ScrollHandle::new(),
                )
                .read(cx)
                .clone()
        });
        self.grid_scroll = scroll.clone();
        let (drawn, near) = match &scroll {
            Some(scroll) => lines_to_draw(scroll, total_lines, window),
            None => ((0..total_lines).collect(), Vec::new()),
        };
        // The videos of the tiles drawn play, while the grid is what shows: not under the loupe,
        // nor with Tidy hidden.
        if self.looking || !self.on_screen(cx) {
            self.tile_videos.clear();
        } else {
            let shown: Vec<&FileRow> = drawn
                .iter()
                .flat_map(|line| &rows[line * columns..((line + 1) * columns).min(count)])
                .map(|row| &row.file)
                .collect();
            self.keep_tile_videos(&shown, cx);
        }
        let gap = f32::from(window.rem_size());
        let mut lines = Vec::new();
        let mut next = 0;
        for line in drawn {
            if line > next {
                lines.push(skipped_lines(line - next, gap));
            }
            next = line + 1;
            let range = line * columns..((line + 1) * columns).min(count);
            let missing = columns - range.len();
            let tiles: Vec<AnyElement> = range
                .map(|index| {
                    let row = &rows[index];
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
                        layout,
                        several,
                        focused == Some(index),
                        cx,
                    )
                })
                .collect();
            lines.push(
                div()
                    .flex()
                    .flex_row()
                    .gap_4()
                    .when(!scrolls, |this| this.flex_1())
                    .when(scrolls, |this| this.h(px(LINE)).flex_shrink_0())
                    .children(tiles)
                    .children((0..missing).map(|_| div().flex_1()))
                    .into_any_element(),
            );
        }
        if total_lines > next {
            lines.push(skipped_lines(total_lines - next, gap));
        }
        // The lines just past the screen: their pictures are asked for after the ones on it, so
        // they decode next.
        if !near.is_empty() {
            self.thumbs.update(cx, |thumbs, cx| {
                for line in near {
                    for row in &rows[line * columns..((line + 1) * columns).min(count)] {
                        thumbs.get(&row.file, 768, cx);
                    }
                }
            });
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
            .pb_4()
            // A few versions fill the stage; on a stage too short for their least, they scroll.
            .overflow_y_scroll()
            .when_some(scroll, |this, scroll| this.track_scroll(&scroll))
            .on_hover(cx.listener(|this, hovered: &bool, _, cx| {
                if !*hovered {
                    this.hover_row = None;
                    cx.notify();
                }
            }))
            .children(lines)
            .into_any_element()
    }

    /// One version: its picture with its checkbox, number and menu, then what happens to it,
    /// its folder, and its lanes against the keeper. A plain click keeps only this one and goes
    /// on, as in Electron Oriel; the fate line and the tooltip say so.
    #[allow(clippy::too_many_arguments)]
    fn render_tile(
        &mut self,
        set: &DuplicateSet,
        row: &SetRow,
        index: usize,
        keeper: &FileRow,
        kept: &[FileId],
        reason: &model::Reason,
        layout: TileLayout,
        several: bool,
        focused: bool,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let theme = cx.theme();
        // The picture sits 6 px in from the tile's edge (its 2 px ring and 4 px padding), so
        // the tile's corners are the theme's radius plus that, and the picture's the radius
        // itself: concentric at the default 12 and 6 px.
        let (primary, foreground, border, muted, radius, inner_radius, card) = (
            theme.primary,
            theme.foreground,
            theme.border,
            theme.muted_foreground,
            theme.radius + px(6.),
            theme.radius,
            theme.group_box,
        );
        let file = row.file.clone();
        let number = index + 1;
        let is_kept = kept.contains(&file.id);
        let suggested = reason.close_call && is_kept && !self.overrides.contains_key(&set.key);
        let lanes = facts_of(&file, keeper, layout.video);
        let copy_of = copy_of_number(set, index);
        let notes = tile_notes(set, row, index);
        // A video plays over its thumbnail, which shows until its first frame does.
        let video = file.kind == FileKind::Video && file.probe_error.is_none();
        let tile_video = self.tile_videos.get(&file.id).cloned();
        let is_playing = tile_video
            .as_ref()
            .is_some_and(|video| video.read(cx).is_playing());
        let picture = rounded_picture(&self.thumbs, &file, 768, inner_radius, cx);
        let chip = cx.theme().background;
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
        let tooltip = if video {
            format!(
                "{}\nClick the picture to pause or play it, and below it to keep only this one \
                 and go on  {number}",
                file.rel_path
            )
        } else {
            format!(
                "{}\nClick to keep only this one and go on  {number}",
                file.rel_path
            )
        };
        let play_id = file.id;
        let menu = VersionMenu {
            page: cx.entity().downgrade(),
            state: self.state.clone(),
            index,
            file: file.clone(),
            similar: set.kind == DuplicateKind::Similar,
        };
        let context_menu = menu.clone();
        // What deciding does to this version: the icon, its colour, the words, and whether it
        // stays (which reads stronger).
        let (fate_icon, fate_color, fate, strong) = if suggested {
            (IconName::Check, foreground, "Suggested", true)
        } else if is_kept {
            (IconName::Check, foreground, "Keep", true)
        } else {
            (IconName::Archive, muted, "Goes to holding", false)
        };
        let tile = div()
            .id(("version", file.id as u64))
            .test_support()
            .aria_label(SharedString::from(file.name.clone()))
            .aria_selected(is_kept)
            .aria_description(SharedString::from(
                copy_of.map_or_else(String::new, |of| format!("Same picture as {of}")),
            ))
            .tooltip({
                let tooltip = SharedString::from(tooltip);
                move |window, cx| {
                    gpui_kit::component::tooltip::Tooltip::new(tooltip.clone()).build(window, cx)
                }
            })
            .flex()
            .flex_col()
            .flex_1()
            .min_w_0()
            .p_1()
            .rounded(radius)
            .border_2()
            .border_color(ring)
            .bg(card)
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
                    if event.click_count() > 1 {
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
                // The picture's place takes what the facts leave, but never less than its
                // least, so the facts below never cover it: a short window scrolls the grid
                // instead. The picture is fitted and rounded on its own, so the place shows no
                // ground of its own around it. A video's plays over it, and a click on it pauses
                // or plays that video rather than keeping the version.
                div()
                    .id(("version-picture", file.id as u64))
                    .test_support()
                    .group("version-picture")
                    .relative()
                    .flex_1()
                    .min_h(rems(PICTURE_LEAST))
                    .overflow_hidden()
                    .when(video, |this| {
                        this.on_click(cx.listener(move |this, _, window, cx| {
                            cx.stop_propagation();
                            this.toggle_tile(play_id, window, cx);
                        }))
                    })
                    .child(picture)
                    .children(tile_video)
                    .when(video, |this| this.child(play_badge(is_playing)))
                    .child(
                        // The checkbox, its number and the menu sit on chips of the standard
                        // 32 px control frame, so they are easy to hit over a small tile.
                        div()
                            .absolute()
                            .top_2()
                            .left_2()
                            .flex()
                            .flex_row()
                            .items_center()
                            .gap_1p5()
                            .child(
                                // The whole chip checks the box, as Electron Oriel's label did.
                                div()
                                    .id(("keep-version-chip", file.id as u64))
                                    .test_support()
                                    .size_8()
                                    .flex()
                                    .items_center()
                                    .justify_center()
                                    .rounded(inner_radius)
                                    .bg(chip)
                                    .border_1()
                                    .border_color(border)
                                    .on_click(cx.listener(move |this, _, _, cx| {
                                        cx.stop_propagation();
                                        this.toggle_keep(index, cx);
                                    }))
                                    .child(
                                        checkbox_target(Checkbox::new((
                                            "keep-version",
                                            file.id as u64,
                                        )))
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
                                        .on_click(
                                            cx.listener(move |this, _, _, cx| {
                                                cx.stop_propagation();
                                                this.toggle_keep(index, cx);
                                            }),
                                        ),
                                    ),
                            )
                            .child(number_badge(number, cx)),
                    )
                    .child(
                        // The menu's own click must not reach the tile, which would keep it.
                        div()
                            .absolute()
                            .top_2()
                            .right_2()
                            .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                            .child(
                                Button::new(("version-menu", file.id as u64))
                                    .icon(Icon::new(IconName::Ellipsis))
                                    .accessibility_label(SharedString::from(format!(
                                        "More for version {number}"
                                    )))
                                    .dropdown_menu_with_anchor(
                                        Anchor::TopRight,
                                        move |popup, _, _| menu.build(popup),
                                    ),
                            ),
                    ),
            )
            .child(
                div()
                    .flex()
                    .flex_col()
                    .gap_1()
                    .px_2()
                    .pt_2()
                    .pb_1p5()
                    .flex_shrink_0()
                    .child(
                        div()
                            .flex()
                            .flex_row()
                            .items_center()
                            .gap_1p5()
                            .text_sm()
                            .when(strong, |this| this.font_weight(FontWeight::MEDIUM))
                            .when(!strong, |this| this.text_color(muted))
                            .child(Icon::new(fate_icon).small().text_color(fate_color))
                            .child(fate),
                    )
                    .child(
                        // Two lines for the folder, always, so pictures keep one height.
                        div()
                            .h(rems(2.5))
                            .text_sm()
                            .line_height(rems(1.25))
                            .line_clamp(2)
                            .child(if file.dir.is_empty() {
                                "The top folder".to_string()
                            } else {
                                file.dir.clone()
                            }),
                    )
                    .when(layout.names, |this| {
                        this.child(widgets::caption(file.name.clone(), cx).truncate())
                    })
                    .child(render_lanes(&lanes, cx))
                    .when(layout.notes, |this| {
                        this.child(
                            widgets::caption(
                                if notes.is_empty() {
                                    "\u{a0}".to_string()
                                } else {
                                    notes.join(" · ")
                                },
                                cx,
                            )
                            .truncate(),
                        )
                    }),
            );
        tile.context_menu(move |popup, _, _| context_menu.build(popup))
            .into_any_element()
    }

    /// Byte-identical copies (`CopyList`): there is nothing to compare, so the picture shows once
    /// (a video plays, with its sound) and the choice is where the file stays. Clicking a place
    /// (or pressing its number) keeps the copy there and moves on; checking several (or
    /// ⇧-clicking) keeps the copy in each, for when one file belongs in more than one folder. Each
    /// place leads with its whole folder path, then the date (the oldest copy is the usual pick),
    /// and opens in Finder from its folder button. Below 680 px the list goes under the picture.
    fn render_copies(
        &mut self,
        set: &DuplicateSet,
        rows: &[SetRow],
        kept: &[FileId],
        reason: &str,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let Some(first) = rows.first().map(|row| row.file.clone()) else {
            return div().flex_1().into_any_element();
        };
        let focus = self.keyboard_focus.then(|| self.focus_row());
        let same_name = rows.iter().all(|row| row.file.name == first.name);
        // When two copies share a minute, "the oldest" needs the seconds to be seen to be true.
        let minutes: HashSet<String> = rows
            .iter()
            .map(|row| format::date_time(row.file.mtime_ms))
            .collect();
        let seconds = minutes.len() < rows.len();
        let aspect = match (first.width, first.height) {
            (Some(w), Some(h)) if w > 0 && h > 0 => w as f32 / h as f32,
            _ => 4. / 3.,
        };
        let shows =
            matches!(first.kind, FileKind::Image | FileKind::Video) && first.probe_error.is_none();
        let playing = self
            .video
            .as_ref()
            .filter(|(id, _)| *id == first.id)
            .map(|(_, video)| video.clone());
        let radius = cx.theme().radius;
        let picture: AnyElement = match playing {
            Some(video) => video.into_any_element(),
            None => rounded_picture(&self.thumbs, &first, 1024, radius, cx),
        };
        let theme = cx.theme();
        let (border, accent, muted) = (theme.border, theme.accent, theme.muted_foreground);
        let play = (shows && first.kind == FileKind::Video && self.video.is_none()).then(|| {
            let file = first.clone();
            // Large, in the middle of the picture, as the loupe's.
            div()
                .absolute()
                .inset_0()
                .flex()
                .items_center()
                .justify_center()
                .child(
                    Button::new("play-copy")
                        .page_size()
                        .icon(Icon::new(IconName::Play))
                        .label("Play")
                        .on_click(cx.listener(move |this, _, window, cx| {
                            cx.stop_propagation();
                            this.play(&file, window, cx);
                        })),
                )
        });
        // A tall picture is held to a height (32 rem) by its width, so the list of places stays
        // in reach.
        let well = div()
            .relative()
            .flex_1()
            .min_w_80()
            .max_w(rems(32. * aspect))
            .aspect_ratio(aspect)
            .overflow_hidden()
            .child(picture)
            .children(play);
        let summary = [
            same_name.then(|| first.name.clone()),
            Some(format::format_label(first.format).to_string()),
            Some(format::details(&first)).filter(|details| !details.is_empty()),
            Some(format!("{} each", format::bytes(first.size as f64))),
        ]
        .into_iter()
        .flatten()
        .collect::<Vec<_>>()
        .join(" · ");
        let linked = &set.hard_linked_ids;
        let lines: Vec<AnyElement> = rows
            .iter()
            .enumerate()
            .map(|(index, row)| {
                let file = &row.file;
                let is_kept = kept.contains(&file.id);
                let menu = VersionMenu {
                    page: cx.entity().downgrade(),
                    state: self.state.clone(),
                    index,
                    file: file.clone(),
                    similar: false,
                };
                let context_menu = menu.clone();
                let place = if file.dir.is_empty() {
                    "the top folder".to_string()
                } else {
                    file.dir.clone()
                };
                let check_tip: SharedString = if is_kept {
                    if reason.is_empty() {
                        format!("Keeping the copy in {place}").into()
                    } else {
                        reason.to_string().into()
                    }
                } else {
                    format!("Keep the copy in {place} as well  ⇧{}", index + 1).into()
                };
                let row_tip: SharedString = format!(
                    "{}\nClick to keep only this copy and go on  {}",
                    file.rel_path,
                    index + 1
                )
                .into();
                let date = if seconds {
                    format::date_time_seconds(file.mtime_ms)
                } else {
                    format::date_time(file.mtime_ms)
                };
                let note = [
                    Some(date),
                    (!same_name).then(|| file.name.clone()),
                    linked
                        .contains(&file.id)
                        .then(|| "a hard link, so it frees nothing".to_string()),
                ]
                .into_iter()
                .flatten()
                .collect::<Vec<_>>()
                .join(" · ");
                div()
                    .id(("version", file.id as u64))
                    .test_support()
                    .aria_label(SharedString::from(file.name.clone()))
                    .aria_selected(is_kept)
                    .group("copy")
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap_3()
                    .min_h_12()
                    .pl_3()
                    .pr_2()
                    .py_2()
                    .when(index > 0, |this| this.border_t_1().border_color(border))
                    .when(focus == Some(index), |this| this.bg(accent))
                    .cursor_pointer()
                    .hover(|style| style.bg(accent))
                    .tooltip(move |window, cx| {
                        gpui_kit::component::tooltip::Tooltip::new(row_tip.clone())
                            .build(window, cx)
                    })
                    .on_hover(cx.listener(move |this, hovered: &bool, _, cx| {
                        if *hovered {
                            this.hover_row = Some(index);
                            cx.notify();
                        }
                    }))
                    .on_click(
                        cx.listener(move |this, event: &gpui_kit::ClickEvent, window, cx| {
                            if event.click_count() > 1 {
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
                            .id(("keep-copy-tip", file.id as u64))
                            .tooltip(move |window, cx| {
                                gpui_kit::component::tooltip::Tooltip::new(check_tip.clone())
                                    .build(window, cx)
                            })
                            .child(
                                Checkbox::new(("keep-version", file.id as u64))
                                    .checked(is_kept)
                                    .accessibility_label(SharedString::from(format!(
                                        "Keep the copy in {place}"
                                    )))
                                    .on_click(cx.listener(move |this, _, _, cx| {
                                        cx.stop_propagation();
                                        this.toggle_keep(index, cx);
                                    })),
                            ),
                    )
                    .child(
                        div()
                            .flex_shrink_0()
                            .min_w_5()
                            .h_5()
                            .px_1()
                            .flex()
                            .items_center()
                            .justify_center()
                            .rounded(radius)
                            .border_1()
                            .border_color(border)
                            .text_xs()
                            .text_color(muted)
                            .child((index + 1).to_string()),
                    )
                    .child(
                        div()
                            .flex()
                            .flex_col()
                            .flex_1()
                            .min_w_0()
                            .child(div().text_sm().line_clamp(3).child(if file.dir.is_empty() {
                                "The top folder".to_string()
                            } else {
                                file.dir.clone()
                            }))
                            .child(widgets::caption(note, cx).truncate()),
                    )
                    .child(
                        div()
                            .flex_shrink_0()
                            .text_xs()
                            .when(is_kept, |this| this.font_weight(FontWeight::MEDIUM))
                            .when(!is_kept, |this| this.text_color(muted))
                            .child(if is_kept { "Keep" } else { "Goes to holding" }),
                    )
                    .child(
                        // The menu's own click must not reach the row, which would keep it.
                        div()
                            .flex_shrink_0()
                            .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                            .child(
                                Button::new(("version-menu", file.id as u64))
                                    .ghost()
                                    .row_size()
                                    .icon(Icon::new(IconName::Ellipsis))
                                    .accessibility_label(SharedString::from(format!(
                                        "More for the copy in {place}"
                                    )))
                                    .dropdown_menu_with_anchor(
                                        Anchor::TopRight,
                                        move |popup, _, _| menu.build(popup),
                                    ),
                            ),
                    )
                    .context_menu(move |popup, _, _| context_menu.build(popup))
                    .into_any_element()
            })
            .collect();
        let list =
            div()
                .flex()
                .flex_col()
                .flex_1()
                .min_w_80()
                .child(div().text_base().font_weight(FontWeight::SEMIBOLD).child(
                    format::plural_as(rows.len() as i64, "identical copy", "identical copies"),
                ))
                .child(widgets::caption(summary, cx).mt_1())
                .child(
                    div()
                        .mt_5()
                        .mb_2()
                        .flex()
                        .flex_row()
                        .flex_wrap()
                        .items_baseline()
                        .justify_between()
                        .gap_x_3()
                        .child(
                            div()
                                .text_xs()
                                .font_weight(FontWeight::MEDIUM)
                                .text_color(muted)
                                .child("Keep the copy in"),
                        )
                        .child(widgets::caption("Check more than one to keep several", cx)),
                )
                .child(widgets::card(cx).overflow_hidden().children(lines));
        div()
            .id("copy-list")
            .flex_1()
            .min_h_0()
            .overflow_y_scroll()
            .child(
                div()
                    .flex()
                    .flex_row()
                    .flex_wrap()
                    .items_start()
                    .gap_6()
                    .px_5()
                    .pt_4()
                    .pb_6()
                    .child(well)
                    .child(list),
            )
            .into_any_element()
    }

    /// Actual size at `at` (shares of the picture; its centre when none), or fitted again.
    fn toggle_zoom(&mut self, zoomed: bool, at: Option<(f32, f32)>, cx: &mut Context<Self>) {
        self.zoomed = zoomed;
        if zoomed {
            self.zoom_at = at;
            self.center_zoom = true;
        }
        cx.notify();
    }

    /// Where `position` falls on the fitted picture of `file` in the loupe's stage, as shares
    /// of the picture.
    fn share_of_picture(
        &self,
        file: &FileRow,
        position: gpui_kit::Point<gpui_kit::Pixels>,
    ) -> Option<(f32, f32)> {
        let bounds = self.loupe_scroll.bounds();
        let (width, height) = (f32::from(bounds.size.width), f32::from(bounds.size.height));
        if width <= 0. || height <= 0. {
            return None;
        }
        let aspect = match (file.width, file.height) {
            (Some(w), Some(h)) if w > 0 && h > 0 => w as f32 / h as f32,
            _ => width / height,
        };
        let (shown_w, shown_h) = if width / height > aspect {
            (height * aspect, height)
        } else {
            (width, width / aspect)
        };
        let left = f32::from(bounds.origin.x) + (width - shown_w) / 2.;
        let top = f32::from(bounds.origin.y) + (height - shown_h) / 2.;
        Some((
            ((f32::from(position.x) - left) / shown_w).clamp(0., 1.),
            ((f32::from(position.y) - top) / shown_h).clamp(0., 1.),
        ))
    }

    /// One version at a time over the page, as Lightroom's Loupe is used for culling (`Loupe`):
    /// ← and → flip between versions drawn in the same place at the same size, the next ones
    /// decoded ahead so a flip never blinks. A click on the picture (or Z) shows actual size at
    /// that point, from the file itself, and the pan is kept across flips: every version is drawn
    /// at the largest one's width, so the same region stays in view. Always dark, so a photo is
    /// judged on a neutral surround in either theme.
    fn render_loupe(
        &mut self,
        set: &DuplicateSet,
        rows: &[SetRow],
        kept: &[FileId],
        reason: &model::Reason,
        window: &mut Window,
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
        let is_video = file.kind == FileKind::Video && file.probe_error.is_none();
        // The largest version's width at actual size, which every version is drawn at when
        // zoomed.
        let widest = rows
            .iter()
            .filter_map(|row| actual_size(&row.file))
            .map(|(w, _)| w)
            .fold(0., f32::max);
        let zoomed = self.zoomed && !is_video && widest > 0.;
        // The shape of the picture drawn at `widest`: its height there.
        let tall = actual_size(&file).map_or(widest, |(w, h)| widest * h / w);
        let picture: AnyElement = match playing {
            Some(video) => video.into_any_element(),
            None if zoomed => {
                let longest = actual_size(&file)
                    .map_or(2048, |(w, h)| w.max(h).round() as u32)
                    .max(1);
                // A flip shows the version's fitted picture, already decoded, until its own
                // at actual size is, rather than a blank stage.
                div()
                    .w(px(widest))
                    .h(px(tall))
                    .flex_shrink_0()
                    .child(thumbs::picture_meanwhile(
                        &self.thumbs,
                        &file,
                        longest,
                        2048,
                        ObjectFit::Fill,
                        cx,
                    ))
                    .into_any_element()
            }
            None => rounded_picture(&self.thumbs, &file, 2048, cx.theme().radius, cx),
        };
        // The versions either side, so a flip finds its picture decoded.
        let neighbours: Vec<FileRow> = [focus.wrapping_sub(1), focus + 1]
            .into_iter()
            .filter_map(|index| rows.get(index))
            .map(|row| row.file.clone())
            .collect();
        self.thumbs.update(cx, |thumbs, cx| {
            for file in &neighbours {
                thumbs.get(file, 2048, cx);
            }
        });
        // Entering actual size centres the chosen point; flipping keeps the pan as it is.
        if zoomed && std::mem::take(&mut self.center_zoom) {
            let bounds = self.loupe_scroll.bounds();
            let (bw, bh) = (f32::from(bounds.size.width), f32::from(bounds.size.height));
            let (x, y) = self.zoom_at.unwrap_or((0.5, 0.5));
            let left = (x * widest - bw / 2.).clamp(0., (widest - bw).max(0.));
            let top = (y * tall - bh / 2.).clamp(0., (tall - bh).max(0.));
            self.loupe_scroll
                .set_offset(gpui_kit::point(px(-left), px(-top)));
        }
        let keeper = keeper_of(set, rows, focus, kept)
            .cloned()
            .unwrap_or_else(|| file.clone());
        let lanes = facts_of(&file, &keeper, has_video(rows));
        let close_call = reason.close_call;
        let wide = f32::from(window.viewport_size().width) >= 1024.;
        let amber = gpui_kit::rgb(LOUPE_LOSS);
        let chip = gpui_kit::rgb(LOUPE_TEXT).opacity(0.1);
        let mut caption = div()
            .flex()
            .flex_row()
            .overflow_hidden()
            .whitespace_nowrap()
            .text_xs()
            .opacity(0.7);
        // The same lanes as the tiles, on one line; a file without a value skips its lane.
        let shown = lanes.into_iter().filter(|lane| lane.value != "—");
        for (position, lane) in shown.enumerate() {
            if position > 0 {
                caption = caption.child(div().flex_shrink_0().child(" · "));
            }
            let worse = lane.worse();
            caption = caption.child(
                div()
                    .flex_shrink_0()
                    .when(worse, |this| {
                        this.text_color(amber).font_weight(FontWeight::MEDIUM)
                    })
                    .child(lane.value),
            );
        }
        if !is_kept {
            caption = caption.child(
                div()
                    .flex_shrink_0()
                    .child(format!(" · Suggested: {suggested}")),
            );
        }
        let badge = is_kept.then(|| {
            div()
                .flex_shrink_0()
                .flex()
                .flex_row()
                .items_center()
                .gap_1()
                .px_2()
                .py_0p5()
                .rounded(cx.theme().radius)
                .text_xs()
                .font_weight(FontWeight::MEDIUM)
                .map(|this| {
                    if close_call {
                        this.bg(chip).child("Suggested")
                    } else {
                        this.bg(cx.theme().primary)
                            .text_color(cx.theme().primary_foreground)
                            .child(Icon::new(IconName::Check).small())
                            .child("Keep")
                    }
                })
        });
        let stage_file = file.clone();
        let hover_file = file.clone();
        let play_file = file.clone();
        let start_play = (is_video && self.video.as_ref().is_none_or(|(id, _)| *id != file.id))
            .then(|| {
                div()
                    .absolute()
                    .inset_0()
                    .flex()
                    .items_center()
                    .justify_center()
                    .child(
                        Button::new("loupe-play")
                            .page_size()
                            .icon(Icon::new(IconName::Play))
                            .label("Play")
                            .tooltip("Play  Space")
                            .on_click(cx.listener(move |this, _, window, cx| {
                                this.play(&play_file, window, cx);
                            })),
                    )
            });
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
            .bg(gpui_kit::rgb(LOUPE_SURFACE))
            .text_color(gpui_kit::rgb(LOUPE_TEXT))
            .child(
                div()
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap_3()
                    .h_12()
                    .pl_5()
                    .pr_3()
                    .child(
                        div()
                            .flex_shrink_0()
                            .min_w_12()
                            .flex()
                            .justify_center()
                            .px_2()
                            .py_0p5()
                            .rounded(cx.theme().radius)
                            .bg(chip)
                            .text_xs()
                            .font_weight(FontWeight::MEDIUM)
                            .child(format!("{} of {}", focus + 1, rows.len())),
                    )
                    .children(badge)
                    .child(
                        div()
                            .flex()
                            .flex_col()
                            .flex_1()
                            .min_w_0()
                            .child(
                                div()
                                    .truncate()
                                    .text_sm()
                                    .font_weight(FontWeight::MEDIUM)
                                    .child(file.rel_path.clone()),
                            )
                            .child(caption),
                    )
                    .when(wide, |this| {
                        this.child(div().flex_shrink_0().text_xs().opacity(0.7).child(format!(
                            "← → flip · 1–{} or ↩ keep · Z or click: actual size",
                            rows.len()
                        )))
                    })
                    .child(
                        Button::new("loupe-reveal")
                            .ghost()
                            .row_size()
                            .icon(Icon::new(IconName::FolderOpen))
                            .accessibility_label("Show in Finder")
                            .tooltip("Show in Finder  ⇧⌘R")
                            .on_click({
                                let path = file.abs_path.clone();
                                move |_, _, cx| cx.reveal_path(Path::new(&path))
                            }),
                    )
                    .child(
                        Button::new("loupe-open-in-view")
                            .ghost()
                            .row_size()
                            .icon(Icon::new(IconName::Images))
                            .accessibility_label("Open in View")
                            .tooltip("Open in View")
                            .on_click({
                                let path = file.abs_path.clone();
                                cx.listener(move |this, _, _, cx| {
                                    this.open_in_view(path.clone(), cx);
                                })
                            }),
                    )
                    .child(
                        Button::new("loupe-close")
                            .ghost()
                            .row_size()
                            .icon(Icon::new(IconName::Close))
                            .accessibility_label("Back to the grid")
                            .tooltip("Back to the grid  Esc")
                            .on_click(cx.listener(|this, _, _, cx| this.close_loupe(cx))),
                    ),
            )
            .child(
                div()
                    .id("loupe-picture")
                    .relative()
                    .flex_1()
                    .min_h_0()
                    .track_scroll(&self.loupe_scroll)
                    .map(|this| {
                        if zoomed {
                            this.overflow_scroll().cursor(gpui_kit::CursorStyle::Arrow)
                        } else {
                            this.mx_5().mb_5().overflow_hidden()
                        }
                    })
                    .on_mouse_move(cx.listener(
                        move |this, event: &gpui_kit::MouseMoveEvent, _, _| {
                            if !this.zoomed {
                                this.pointer_at =
                                    this.share_of_picture(&hover_file, event.position);
                            }
                        },
                    ))
                    .on_click(
                        cx.listener(move |this, event: &gpui_kit::ClickEvent, _, cx| {
                            if this.zoomed {
                                this.toggle_zoom(false, None, cx);
                            } else {
                                let at = this.share_of_picture(&stage_file, event.position());
                                this.toggle_zoom(true, at, cx);
                            }
                        }),
                    )
                    .child(picture),
            )
            .children(start_play)
            .into_any_element()
    }

    /// The decision bar, docked at the foot of the stage: the commands, centred under the
    /// versions, a size up from the page's other buttons since every set ends here (GPUI Kit's
    /// large button keeps the medium's height, so the bar sets the next one), and the primary
    /// last. Each version's tile already says what happens to it, so the bar adds no
    /// summary of its own.
    fn render_decision_bar(
        &self,
        set: &DuplicateSet,
        rows: &[SetRow],
        kept: &[FileId],
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let removed = removal_of(set, kept).len();
        let focus = self.focus_row();
        let theme = cx.theme();
        let mut bar = div()
            .id("duplicates-decision-bar")
            .flex()
            .flex_row()
            .items_center()
            .justify_center()
            .flex_shrink_0()
            .gap_2()
            .px_5()
            .py_3()
            .border_t_1()
            .border_color(theme.border)
            .bg(theme.background);
        if self.looking {
            bar = bar
                .child(
                    Button::new("loupe-previous")
                        .ghost()
                        .large()
                        .size(px(44.))
                        .size_10()
                        .icon(Icon::new(IconName::ChevronLeft))
                        .accessibility_label("Previous version")
                        .tooltip("Previous version  ←")
                        .disabled(focus == 0)
                        .on_click(cx.listener(|this, _, _, cx| this.focus_by(-1, cx))),
                )
                .child(
                    Button::new("loupe-next")
                        .ghost()
                        .large()
                        .size(px(44.))
                        .size_10()
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
                .page_size()
                .label("Skip")
                .tooltip("Skip for now  S")
                .on_click(cx.listener(|this, _, _, cx| this.skip(cx))),
        );
        if removed > 0 {
            bar = bar.child(
                Button::new("duplicates-keep-every")
                    .outline()
                    .page_size()
                    .label(keep_every_label(rows))
                    .tooltip(if set.kind == DuplicateKind::Exact {
                        "Keep every copy  N"
                    } else {
                        "Keep every version: they are not duplicates  N"
                    })
                    .on_click(cx.listener(|this, _, window, cx| this.dismiss(window, cx))),
            );
        }
        let label = self.decision().unwrap_or_default();
        bar.child(
            widgets::primary_action("duplicates-decide", label, "↩")
                .page_size()
                .on_click(cx.listener(|this, _, window, cx| {
                    if this.looking {
                        let focus = this.focus_row();
                        this.keep_only(focus, window, cx);
                    } else {
                        this.decide(window, cx);
                    }
                })),
        )
        .into_any_element()
    }

    fn render_empty(&self, cx: &mut Context<Self>) -> AnyElement {
        let page = self.page();
        let scope = self.scope(cx);
        let fingerprinting = page.is_some_and(|page| page.fingerprinted < page.fingerprintable);
        let comparing = page.is_some_and(|page| page.compared < page.comparable);
        let title = match scope {
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
        };
        let body = if self.freed_here > 0 {
            Some(format!(
                "{} moved to holding.",
                format::bytes(self.freed_here as f64)
            ))
        } else if fingerprinting && scope == DuplicateScope::Similar {
            page.map(|page| {
                format!(
                    "Still checking for similar versions: {} of {}.",
                    format::count(page.fingerprinted),
                    format::count(page.fingerprintable)
                )
            })
        } else if scope == DuplicateScope::Variants {
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
        let mut actions = vec![
            Button::new("duplicates-back")
                .outline()
                .label("Back to Overview")
                .on_click(cx.listener(|this, _, _, cx| {
                    this.state
                        .update(cx, |state, cx| state.go(TidyPage::Overview, cx));
                }))
                .into_any_element(),
        ];
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
        let queue = self.render_queue(false, cx);
        div()
            .flex()
            .flex_row()
            .flex_1()
            .min_h_0()
            .child(queue)
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

/// The lines of a scrolling version grid to draw, in order: those on screen, whose videos play;
/// and the lines just past the screen, whose pictures are decoded ahead.
///
/// The screen is the window's height, which the grid never exceeds, so a frame after a resize
/// draws enough even before the grid's own bounds have caught up.
fn lines_to_draw(scroll: &ScrollHandle, total: usize, window: &Window) -> (Vec<usize>, Vec<usize>) {
    // The space between lines and above the first, a rem each.
    let gap = f32::from(window.rem_size());
    let pitch = LINE + gap;
    let screen = f32::from(window.viewport_size().height);
    // The space above the first line, the lines and the gaps between them, the space below.
    let content = total as f32 * pitch + gap;
    let bounds = f32::from(scroll.bounds().size.height);
    let most = if bounds > 0. {
        (content - bounds).max(0.)
    } else {
        content
    };
    let top = (-f32::from(scroll.offset().y)).clamp(0., most);
    let first = (((top - gap) / pitch).floor().max(0.) as usize).min(total);
    let last = (((top + screen - gap) / pitch).ceil().max(0.) as usize).clamp(first, total);
    let drawn: Vec<usize> = (first..last).collect();
    let near = (first.saturating_sub(NEAR_LINES)..first)
        .chain(last..(last + NEAR_LINES).min(total))
        .collect();
    (drawn, near)
}

/// The room `lines` lines of versions not drawn take, `gap` apart, less the gap the grid puts
/// after it.
fn skipped_lines(lines: usize, gap: f32) -> AnyElement {
    div()
        .flex_shrink_0()
        .h(px(lines as f32 * (LINE + gap) - gap))
        .into_any_element()
}

/// The lines every tile of a set carries, so tiles stay level with one another.
#[derive(Clone, Copy, Debug)]
struct TileLayout {
    /// The file's name, when two versions share a folder.
    names: bool,
    /// Length and Sound, when a version is a video.
    video: bool,
    /// A line of notes, when a version has one.
    notes: bool,
}

/// What a version's notes line says: the picture it repeats under Spot variants, the
/// byte-identical copies that go with it ("Also in …"), and a hard link that frees nothing.
fn tile_notes(set: &DuplicateSet, row: &SetRow, index: usize) -> Vec<String> {
    let mut notes = Vec::new();
    if let Some(of) = copy_of_number(set, index) {
        notes.push(format!("Same picture as {of}"));
    }
    match row.copies.as_slice() {
        [] => {}
        [copy] => notes.push(format!(
            "Also in {}",
            if copy.dir.is_empty() {
                "the top folder"
            } else {
                &copy.dir
            }
        )),
        copies => notes.push(format!("Also in {} other folders", copies.len())),
    }
    if set.hard_linked_ids.contains(&row.file.id) {
        notes.push("A hard link, so it frees nothing".into());
    }
    notes
}

/// A tile's lanes, a label and a value each, one line apiece: a loss reads in the warning
/// colour, a value the keeper shares is muted.
fn render_lanes(lanes: &[Lane], cx: &App) -> AnyElement {
    let theme = cx.theme();
    div()
        .flex()
        .flex_col()
        .text_xs()
        .children(lanes.iter().map(|lane| {
            div()
                .flex()
                .flex_row()
                .gap_2()
                .child(
                    div()
                        .w(rems(4.5))
                        .flex_shrink_0()
                        .text_color(theme.muted_foreground)
                        .child(lane.label),
                )
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .truncate()
                        .map(|this| match lane.standing {
                            Standing::Worse => this
                                .text_color(theme.warning)
                                .font_weight(FontWeight::MEDIUM),
                            Standing::Same => this.text_color(theme.muted_foreground),
                            Standing::Plain => this.text_color(theme.foreground),
                        })
                        .child(lane.value.clone()),
                )
        }))
        .into_any_element()
}

/// Why the suggestion keeps what it keeps, at the top of the stage: "Keeping 1: most pixels
/// (2560×1440 against 1280×720)". A close call leads with a warning sign and says so.
fn render_decision_line(reason: &model::Reason, cx: &App) -> AnyElement {
    let theme = cx.theme();
    div()
        .id("duplicates-decision-line")
        .test_support()
        .aria_label(SharedString::from(reason.text.clone()))
        .flex()
        .flex_row()
        .items_center()
        .gap_2()
        .flex_shrink_0()
        .px_5()
        .pt_4()
        .text_sm()
        .when(reason.close_call, |this| {
            this.child(
                Icon::new(IconName::TriangleAlert)
                    .small()
                    .text_color(theme.warning),
            )
        })
        .child(div().min_w_0().truncate().child(reason.text.clone()))
        .into_any_element()
}

/// A picture fitted inside its place, its own corners rounded to `radius`. GPUI clips a child to
/// its parent's rectangle, never to its rounded corners, so a picture that reached a rounded
/// place's edge would show square corners there; rounded itself, it sits inside the shape
/// wherever it lands. Until it is decoded, a rounded ground holds its place.
fn rounded_picture(
    thumbs: &Entity<Thumbs>,
    file: &FileRow,
    size: u32,
    radius: Pixels,
    cx: &mut App,
) -> AnyElement {
    let thumb = thumbs.update(cx, |thumbs, cx| thumbs.get(file, size, cx));
    let theme = cx.theme();
    match thumb {
        Thumb::Ready(image) => img(image)
            .size_full()
            .object_fit(ObjectFit::Contain)
            .rounded(radius)
            .into_any_element(),
        Thumb::Pending => div()
            .size_full()
            .rounded(radius)
            .bg(theme.muted)
            .into_any_element(),
        Thumb::Unavailable => div()
            .size_full()
            .flex()
            .items_center()
            .justify_center()
            .rounded(radius)
            .bg(theme.muted)
            .text_color(theme.muted_foreground)
            .child(Icon::new(thumbs::kind_icon(file.kind)))
            .into_any_element(),
    }
}

/// A version's number on its picture, which 1–9 keep it by.
fn number_badge(number: usize, cx: &App) -> AnyElement {
    let theme = cx.theme();
    div()
        .min_w_8()
        .h_8()
        .px_2()
        .flex()
        .items_center()
        .justify_center()
        .rounded(theme.radius)
        .bg(theme.background)
        .border_1()
        .border_color(theme.border)
        .text_color(theme.foreground)
        .text_sm()
        .font_weight(FontWeight::MEDIUM)
        .child(number.to_string())
        .into_any_element()
}

/// A video tile's play or pause sign, large in the middle of its picture, which is the control:
/// "play" while it is paused, and "pause" under the pointer while it plays. White on a dark disc,
/// as it sits on the video itself in either theme.
fn play_badge(playing: bool) -> AnyElement {
    div()
        .absolute()
        .inset_0()
        .flex()
        .items_center()
        .justify_center()
        .when(playing, |this| {
            this.invisible()
                .group_hover("version-picture", |style| style.visible())
        })
        .child(
            div()
                .size_12()
                .flex()
                .items_center()
                .justify_center()
                .rounded_full()
                .bg(gpui_kit::black().opacity(0.6))
                .text_color(gpui_kit::white())
                .child(
                    Icon::new(if playing {
                        IconName::Pause
                    } else {
                        IconName::Play
                    })
                    .size_6(),
                ),
        )
        .into_any_element()
}

/// A menu item with its key at the trailing edge, as menus show shortcuts.
fn menu_item(
    label: &'static str,
    keys: Option<&'static str>,
    handler: impl Fn(&mut Window, &mut App) + 'static,
) -> PopupMenuItem {
    PopupMenuItem::element(move |_, cx| {
        div()
            .flex()
            .flex_row()
            .flex_1()
            .items_center()
            .justify_between()
            .gap_4()
            .child(label)
            .children(
                keys.and_then(|keys| Keystroke::parse(keys).ok())
                    .map(|keys| {
                        div()
                            .text_color(cx.theme().muted_foreground)
                            .child(Kbd::new(keys).appearance(false))
                    }),
            )
    })
    .on_click(move |_, window, cx| handler(window, cx))
}

/// What a version's `…` button and its right-click offer: the commands that act on that one
/// version, each with the key that does the same.
#[derive(Clone)]
struct VersionMenu {
    page: WeakEntity<DuplicatesPage>,
    state: Entity<TidyState>,
    index: usize,
    file: FileRow,
    /// Similar versions open in the loupe; identical copies have nothing to compare.
    similar: bool,
}

impl VersionMenu {
    fn build(&self, menu: PopupMenu) -> PopupMenu {
        let (page, index) = (self.page.clone(), self.index);
        let look = self.similar.then(|| {
            menu_item("Look closer", Some("space"), move |_, cx| {
                page.update(cx, |page, cx| page.open_loupe(index, cx)).ok();
            })
        });
        let path = self.file.abs_path.clone();
        let quick = menu_item(QUICK_LOOK_LABEL, Some("cmd-y"), move |window, cx| {
            quick_look(Path::new(&path), window, cx);
        });
        let path = self.file.abs_path.clone();
        let reveal = menu_item("Show in Finder", Some("shift-cmd-r"), move |_, cx| {
            cx.reveal_path(Path::new(&path));
        });
        let (page, path) = (self.page.clone(), self.file.abs_path.clone());
        let view = menu_item("Open in View", None, move |_, cx| {
            page.update(cx, |page, cx| page.open_in_view(path.clone(), cx))
                .ok();
        });
        let (state, dir) = (self.state.clone(), self.file.dir.clone());
        let prefer = menu_item("Prefer this folder", Some("p"), move |window, cx| {
            crate::settings::prefer_folder(&state, dir.clone(), window, cx);
        });
        let mut menu = menu;
        if let Some(look) = look {
            menu = menu.item(look);
        }
        menu.item(quick)
            .item(reveal)
            .item(view)
            .separator()
            .item(prefer)
    }
}

/// One row of the queue: the keeper's thumbnail, its name, and what deciding the set frees; a
/// close call says so, with an amber dot beside the words, and a skipped set is dimmed.
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
            "{}{} · frees {}",
            if close_call { "Close call · " } else { "" },
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
        .h(rems(3.5))
        .my_0p5()
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
                .size_10()
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
                        .text_sm()
                        .font_weight(FontWeight::MEDIUM)
                        .child(keeper.map(|file| file.name).unwrap_or_default()),
                )
                .child(
                    div()
                        .flex()
                        .flex_row()
                        .items_center()
                        .gap_1p5()
                        .text_xs()
                        .text_color(muted)
                        .when(close_call && !skipped, |this| {
                            this.child(div().flex_shrink_0().size_1p5().rounded_full().bg(warning))
                        })
                        .child(div().truncate().child(caption)),
                ),
        )
        .into_any_element()
}

impl DuplicatesPage {
    /// The queue could not be read: what failed, why, and a way to try again.
    fn render_error(&self, error: SharedString, cx: &mut Context<Self>) -> AnyElement {
        widgets::empty_state(
            "duplicates-error",
            Some(IconName::CircleAlert),
            "Couldn't read duplicates",
            Some(div().child(error).into_any_element()),
            vec![
                Button::new("duplicates-try-again")
                    .outline()
                    .label("Try again")
                    .on_click(cx.listener(|this, _, _, cx| {
                        this.load(cx);
                        cx.notify();
                    }))
                    .into_any_element(),
            ],
            cx,
        )
        .into_any_element()
    }
}

impl Focusable for DuplicatesPage {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}

impl Render for DuplicatesPage {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let top_bar = self.render_top_bar(cx);
        let body: AnyElement = if let (None, Some(error)) = (self.page(), self.queue.error()) {
            let error = error.clone();
            self.render_error(error, cx)
        } else if self.page().is_none() {
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
            let queue = self.render_queue(true, cx);
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
