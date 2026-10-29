//! The Library (`views/LibraryView.tsx`): every file in the catalog in GPUI Kit's data table,
//! paged in from the engine as it scrolls, with the search, the filter menu and its chips, the
//! Inspector (I), the selection bar and its More… menu.
//!
//! The table's selected row is the cursor; the checkboxes are the selection, which bulk actions
//! take. Without a selection, the Inspector and the shortcuts act on the cursor's file.

use std::collections::{BTreeSet, HashMap, HashSet};
use std::path::Path;
use std::time::Duration;

use gpui_kit::assets::IconName;
use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::checkbox::Checkbox;
use gpui_kit::component::input::{Input, InputEvent, InputState};
use gpui_kit::component::menu::{DropdownMenu as _, PopupMenuItem};
use gpui_kit::component::popover::Popover;
use gpui_kit::component::table::{
    Column, ColumnSort, DataTable, TableDelegate, TableEvent, TableState,
};
use gpui_kit::component::{ActiveTheme as _, Icon, Sizable as _, WindowExt as _};
use gpui_kit::{
    AnyElement, App, AppContext as _, Context, Entity, FocusHandle, Focusable, FontWeight,
    InteractiveElement as _, IntoElement, KeyDownEvent, ObjectFit, ParentElement as _, Render,
    SharedString, StatefulInteractiveElement as _, Styled as _, Subscription, Task,
    TestSupportExt as _, Window, div, prelude::FluentBuilder as _, px,
};
use oriel_core_tidy::TidyEngine;
use oriel_core_tidy::contract::{
    AudioState, FileFacets, FileFilter, FileFlag, FileFormat, FileId, FileKind, FileQuery, FileRow,
    FileSortColumn, MAX_BULK_FILES, OptimizeCategory, RootId, SelectionSummary, VideoQuality,
};
use oriel_ui::{LocalStorage, Toast, TopBar};

use crate::actions::PerformOptions;
use crate::changes::{PlanRequest, Rename, VideoCodecChoice};
use crate::format;
use crate::loaded::Loaded;
use crate::pages::TidyPage;
use crate::state::{LibraryPreset, TidyState};
use crate::thumbs::{self, Thumbs};
use crate::widgets;

/// Rows read from the engine at once, as the table scrolls.
const PAGE: usize = 200;

/// Where the Inspector's choice is kept, Electron Oriel's key.
const INSPECTOR_KEY: &str = "glazier.library.inspector";

/// Folders the filter lists at once; its field narrows the rest.
const FOLDER_LIMIT: usize = 200;

const ALL_CATEGORIES: [OptimizeCategory; 6] = [
    OptimizeCategory::StillToAvif,
    OptimizeCategory::AnimationToMp4,
    OptimizeCategory::VideoRemux,
    OptimizeCategory::VideoConvert,
    OptimizeCategory::RenameAvif,
    OptimizeCategory::RenameMp4,
];

/// The Library's filters: everything in a preset but the search, which has its own field.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Filters {
    pub kinds: Vec<FileKind>,
    pub formats: Vec<FileFormat>,
    pub audio_states: Vec<AudioState>,
    pub flags: Vec<FileFlag>,
    pub dir: Option<String>,
}

impl Filters {
    pub fn active(&self) -> usize {
        self.kinds.len()
            + self.formats.len()
            + self.audio_states.len()
            + self.flags.len()
            + usize::from(self.dir.is_some())
    }
}

fn toggled<T: PartialEq + Copy>(values: &[T], value: T, on: bool) -> Vec<T> {
    let mut next: Vec<T> = values
        .iter()
        .copied()
        .filter(|entry| *entry != value)
        .collect();
    if on {
        next.push(value);
    }
    next
}

/// The table's columns, in order.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Col {
    Select,
    Name,
    Format,
    Dimensions,
    Size,
    Modified,
}

const COLUMNS: [Col; 6] = [
    Col::Select,
    Col::Name,
    Col::Format,
    Col::Dimensions,
    Col::Size,
    Col::Modified,
];

impl Col {
    fn column(self) -> Column {
        match self {
            Col::Select => Column::new("select", "").width(40.).resizable(false),
            Col::Name => Column::new("name", "Name").width(360.).sortable(),
            Col::Format => Column::new("format", "Format").width(110.).sortable(),
            Col::Dimensions => Column::new("dimensions", "Dimensions")
                .width(120.)
                .sortable(),
            Col::Size => Column::new("size", "Size")
                .width(96.)
                .text_right()
                .sortable(),
            Col::Modified => Column::new("modified", "Modified")
                .width(130.)
                .text_right()
                .sortable(),
        }
    }

    /// The catalog's order for this column, as Electron Oriel's headers sort: the format by
    /// kind, the dimensions by length.
    fn sort(self) -> Option<FileSortColumn> {
        match self {
            Col::Select => None,
            Col::Name => Some(FileSortColumn::Name),
            Col::Format => Some(FileSortColumn::Kind),
            Col::Dimensions => Some(FileSortColumn::Duration),
            Col::Size => Some(FileSortColumn::Size),
            Col::Modified => Some(FileSortColumn::Mtime),
        }
    }
}

/// Pixels for pictures, the length for videos, and why a file shows nothing (`dimensionsOf`).
fn dimensions_text(row: &FileRow) -> String {
    if row.probe_error.is_some() {
        return "Won't open".into();
    }
    if row.kind == FileKind::Video && row.duration_ms.is_some() {
        return format::duration(row.duration_ms);
    }
    format::dimensions(row).unwrap_or_default()
}

/// The table's rows: pages of the catalog, read as they come into view.
pub struct CatalogRows {
    engine: Option<TidyEngine>,
    query: Option<FileQuery>,
    total: Option<usize>,
    total_bytes: i64,
    pages: HashMap<usize, Vec<FileRow>>,
    requested: HashSet<usize>,
    generation: u64,
    selected: BTreeSet<FileId>,
    thumbs: Entity<Thumbs>,
    root_name: SharedString,
    columns: Vec<Column>,
    tasks: Vec<Task<()>>,
}

impl CatalogRows {
    fn new(thumbs: &Entity<Thumbs>) -> Self {
        Self {
            engine: None,
            query: None,
            total: None,
            total_bytes: 0,
            pages: HashMap::new(),
            requested: HashSet::new(),
            generation: 0,
            selected: BTreeSet::new(),
            thumbs: thumbs.clone(),
            root_name: SharedString::default(),
            columns: COLUMNS.map(Col::column).to_vec(),
            tasks: Vec::new(),
        }
    }

    /// How many files match, once the first page has said.
    pub fn total(&self) -> Option<usize> {
        self.total
    }

    pub fn total_bytes(&self) -> i64 {
        self.total_bytes
    }

    pub fn selected(&self) -> &BTreeSet<FileId> {
        &self.selected
    }

    /// The row at `index`, once its page is in.
    pub fn row(&self, index: usize) -> Option<&FileRow> {
        self.pages.get(&(index / PAGE))?.get(index % PAGE)
    }

    /// The rows read so far, in order.
    pub fn loaded_rows(&self) -> Vec<&FileRow> {
        let mut pages: Vec<_> = self.pages.iter().collect();
        pages.sort_by_key(|(page, _)| **page);
        pages
            .into_iter()
            .flat_map(|(_, rows)| rows.iter())
            .collect()
    }

    /// Reads the query's results again from the first page.
    fn reset(&mut self, engine: TidyEngine, query: FileQuery, cx: &mut Context<TableState<Self>>) {
        self.engine = Some(engine);
        self.query = Some(query);
        self.generation += 1;
        self.requested.clear();
        self.tasks.clear();
        self.request(0, cx);
    }

    fn request(&mut self, page: usize, cx: &mut Context<TableState<Self>>) {
        let (Some(engine), Some(query)) = (self.engine.clone(), self.query.clone()) else {
            return;
        };
        if !self.requested.insert(page) {
            return;
        }
        let generation = self.generation;
        let query = FileQuery {
            offset: (page * PAGE) as u32,
            limit: PAGE as u32,
            ..query
        };
        let answer = engine.list_files(query);
        self.tasks.push(cx.spawn(async move |table, cx| {
            let answer = answer.await;
            table
                .update(cx, |table, cx| {
                    let rows = table.delegate_mut();
                    if rows.generation != generation {
                        return;
                    }
                    match answer {
                        Ok(result) => {
                            if page == 0 {
                                // A fresh first page replaces the rest, read again as they show.
                                rows.pages.clear();
                                rows.requested.retain(|requested| *requested == 0);
                            }
                            rows.total = Some(result.total.max(0) as usize);
                            rows.total_bytes = result.total_bytes;
                            rows.pages.insert(page, result.rows);
                        }
                        Err(error) => {
                            log::warn!("The Library could not read the catalog: {error:#}")
                        }
                    }
                    cx.notify();
                })
                .ok();
        }));
    }

    fn set_selected(&mut self, selected: BTreeSet<FileId>, cx: &mut Context<TableState<Self>>) {
        self.selected = selected;
        cx.notify();
    }

    fn render_name(&self, row: &FileRow, cx: &mut Context<TableState<Self>>) -> AnyElement {
        let theme = cx.theme();
        let (muted, radius) = (theme.muted_foreground, theme.radius);
        let mute = format::is_mute_video(row);
        let folder = if row.dir.is_empty() {
            self.root_name.to_string()
        } else {
            row.dir.clone()
        };
        let picture = thumbs::picture(&self.thumbs, row, 64, ObjectFit::Cover, cx);
        div()
            .flex()
            .flex_row()
            .items_center()
            .gap_3()
            .min_w_0()
            .child(
                div()
                    .size(px(32.))
                    .flex_shrink_0()
                    .rounded(radius)
                    .overflow_hidden()
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
                            .flex()
                            .flex_row()
                            .items_center()
                            .gap(px(6.))
                            .min_w_0()
                            .child(div().truncate().child(row.name.clone()))
                            .when(mute, |this| {
                                this.child(
                                    Icon::new(IconName::VolumeX).size(px(14.)).text_color(muted),
                                )
                            }),
                    )
                    .child(div().truncate().text_xs().text_color(muted).child(folder)),
            )
            .into_any_element()
    }
}

impl TableDelegate for CatalogRows {
    fn columns_count(&self, _: &App) -> usize {
        self.columns.len()
    }

    fn rows_count(&self, _: &App) -> usize {
        self.total.unwrap_or(0)
    }

    fn column(&self, col_ix: usize, _: &App) -> Column {
        self.columns[col_ix].clone()
    }

    fn perform_sort(
        &mut self,
        col_ix: usize,
        sort: ColumnSort,
        _: &mut Window,
        cx: &mut Context<TableState<Self>>,
    ) {
        let (Some(engine), Some(mut query)) = (self.engine.clone(), self.query.clone()) else {
            return;
        };
        let column = COLUMNS[col_ix].sort();
        (query.sort, query.descending) = match (column, sort) {
            (Some(column), ColumnSort::Ascending) => (column, false),
            (Some(column), ColumnSort::Descending) => (column, true),
            // Back to the catalog's own order: by path, as the scan found them.
            _ => (FileSortColumn::Path, false),
        };
        self.reset(engine, query, cx);
    }

    fn visible_rows_changed(
        &mut self,
        visible: std::ops::Range<usize>,
        _: &mut Window,
        cx: &mut Context<TableState<Self>>,
    ) {
        if visible.is_empty() {
            return;
        }
        for page in visible.start / PAGE..=(visible.end.saturating_sub(1)) / PAGE {
            self.request(page, cx);
        }
    }

    fn render_td(
        &mut self,
        row_ix: usize,
        col_ix: usize,
        _: &mut Window,
        cx: &mut Context<TableState<Self>>,
    ) -> impl IntoElement {
        let Some(row) = self.row(row_ix).cloned() else {
            // Not read yet: a quiet placeholder, as the Electron list draws one.
            return div()
                .h(px(10.))
                .w(px(if col_ix == 1 { 160. } else { 40. }))
                .rounded_full()
                .bg(cx.theme().muted)
                .into_any_element();
        };
        let theme = cx.theme();
        match COLUMNS[col_ix] {
            Col::Select => {
                let id = row.id;
                let checked = self.selected.contains(&id);
                let table = cx.entity().downgrade();
                Checkbox::new(("library-select", id as u64))
                    .checked(checked)
                    .accessibility_label(SharedString::from(format!("Select {}", row.name)))
                    .on_click(move |checked, _, cx| {
                        let checked = *checked;
                        table
                            .update(cx, |table, cx| {
                                let rows = table.delegate_mut();
                                let mut selected = rows.selected.clone();
                                if checked {
                                    selected.insert(id);
                                } else {
                                    selected.remove(&id);
                                }
                                rows.set_selected(selected, cx);
                            })
                            .ok();
                    })
                    .into_any_element()
            }
            Col::Name => self.render_name(&row, cx),
            Col::Format => div()
                .flex()
                .flex_row()
                .gap(px(6.))
                .min_w_0()
                .child(div().truncate().child(format::format_label(row.format)))
                .when(row.extension_mismatch, |this| {
                    this.child(
                        div()
                            .truncate()
                            .text_color(theme.warning)
                            .child(format!(".{}", row.ext)),
                    )
                })
                .into_any_element(),
            Col::Dimensions => div()
                .truncate()
                .text_color(theme.muted_foreground)
                .child(dimensions_text(&row))
                .into_any_element(),
            Col::Size => div()
                .truncate()
                .child(format::bytes(row.size as f64))
                .into_any_element(),
            Col::Modified => div()
                .truncate()
                .text_color(theme.muted_foreground)
                .child(format::date(row.mtime_ms))
                .into_any_element(),
        }
    }

    fn cell_label(&self, row_ix: usize, col_ix: usize, _: &App) -> Option<SharedString> {
        let row = self.row(row_ix)?;
        Some(match COLUMNS[col_ix] {
            Col::Select => return None,
            Col::Name => row.name.clone().into(),
            Col::Format => format::format_label(row.format).into(),
            Col::Dimensions => dimensions_text(row).into(),
            Col::Size => format::bytes(row.size as f64).into(),
            Col::Modified => format::date(row.mtime_ms).into(),
        })
    }
}

pub struct LibraryPage {
    state: Entity<TidyState>,
    thumbs: Entity<Thumbs>,
    focus: FocusHandle,
    table: Entity<TableState<CatalogRows>>,
    search: Entity<InputState>,
    folder_search: Entity<InputState>,
    filters: Filters,
    /// The search the query uses, after typing pauses.
    applied_search: String,
    facets: Loaded<FileFacets>,
    folders: Loaded<Vec<String>>,
    summary: Loaded<SelectionSummary>,
    sample: Loaded<Vec<FileRow>>,
    inspector: bool,
    filter_open: bool,
    /// What the page last read for: the root, the catalog's version and the last preset.
    seen: (Option<RootId>, u64, u64),
    targets_seen: (Vec<FileId>, u64),
    search_timer: Option<Task<()>>,
    targets_timer: Option<Task<()>>,
    _subscriptions: Vec<Subscription>,
}

impl LibraryPage {
    pub fn new(
        state: &Entity<TidyState>,
        thumbs: &Entity<Thumbs>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let rows = CatalogRows::new(thumbs);
        let table = cx.new(|cx| {
            TableState::new(rows, window, cx)
                .row_selectable(true)
                .row_header(false)
                .col_movable(false)
                .col_selectable(false)
        });
        let search =
            cx.new(|cx| InputState::new(window, cx).placeholder("Search names and folders"));
        let folder_search = cx.new(|cx| InputState::new(window, cx).placeholder("Find a folder"));
        let inspector = match LocalStorage::get(cx, INSPECTOR_KEY) {
            Some(stored) => stored == "open",
            None => window.bounds().size.width >= px(1440.),
        };
        let subscriptions = vec![
            cx.observe(state, |this, _, cx| this.sync(cx)),
            cx.observe(thumbs, |this, _, cx| {
                this.table.update(cx, |_, cx| cx.notify());
            }),
            cx.observe(&table, |this, _, cx| this.targets_changed(cx)),
            cx.subscribe(&table, |this, _, event: &TableEvent, cx| {
                if let TableEvent::DoubleClickedRow(index) = event
                    && let Some(row) = this.table.read(cx).delegate().row(*index)
                {
                    cx.open_with_system(Path::new(&row.abs_path));
                }
            }),
            cx.subscribe_in(&search, window, |this, _, event: &InputEvent, _, cx| {
                if matches!(event, InputEvent::Change) {
                    this.search_changed(cx);
                }
            }),
            cx.subscribe(&folder_search, |_, _, event: &InputEvent, cx| {
                if matches!(event, InputEvent::Change) {
                    cx.notify();
                }
            }),
        ];
        Self {
            state: state.clone(),
            thumbs: thumbs.clone(),
            focus: cx.focus_handle(),
            table,
            search,
            folder_search,
            filters: Filters::default(),
            applied_search: String::new(),
            facets: Loaded::default(),
            folders: Loaded::default(),
            summary: Loaded::default(),
            sample: Loaded::default(),
            inspector,
            filter_open: false,
            seen: (None, 0, 0),
            targets_seen: (Vec::new(), 0),
            search_timer: None,
            targets_timer: None,
            _subscriptions: subscriptions,
        }
    }

    pub fn table(&self) -> &Entity<TableState<CatalogRows>> {
        &self.table
    }

    pub fn filters(&self) -> &Filters {
        &self.filters
    }

    pub fn facets(&self) -> Option<&FileFacets> {
        self.facets.data()
    }

    pub fn total(&self, cx: &App) -> Option<usize> {
        self.table.read(cx).delegate().total()
    }

    fn filter(&self, root_id: RootId) -> FileFilter {
        FileFilter {
            root_id: Some(root_id),
            search: self.applied_search.clone(),
            kinds: self.filters.kinds.clone(),
            formats: self.filters.formats.clone(),
            audio_states: self.filters.audio_states.clone(),
            flags: self.filters.flags.clone(),
            dir: self.filters.dir.clone(),
        }
    }

    /// Follows the state: a preset another page linked with, a new root, a changed catalog.
    fn sync(&mut self, cx: &mut Context<Self>) {
        let state = self.state.read(cx);
        let preset = state.library_request().cloned();
        let visible = state.page() == TidyPage::Library;
        let key = (
            state.root_id(),
            state.catalog_version(),
            preset.as_ref().map_or(0, |(number, _)| *number),
        );
        if let Some((number, preset)) = preset
            && number != self.seen.2
        {
            self.apply_preset(preset, cx);
        }
        if visible && key != self.seen {
            let root_changed = key.0 != self.seen.0;
            self.seen = key;
            if root_changed {
                self.table.update(cx, |table, cx| {
                    table.delegate_mut().set_selected(BTreeSet::new(), cx);
                });
            }
            self.reload(cx);
        }
        cx.notify();
    }

    fn apply_preset(&mut self, preset: LibraryPreset, cx: &mut Context<Self>) {
        self.filters = Filters {
            kinds: preset.kinds,
            formats: preset.formats,
            audio_states: preset.audio_states,
            flags: preset.flags,
            dir: preset.dir,
        };
        self.applied_search = preset.search.clone();
        self.table.update(cx, |table, cx| {
            table.delegate_mut().set_selected(BTreeSet::new(), cx);
        });
        // The field shows the preset's search once the page draws again.
        self.search_timer = None;
    }

    /// Reads the rows, the filter's counts and the folders again.
    fn reload(&mut self, cx: &mut Context<Self>) {
        let state = self.state.read(cx);
        let (Some(engine), Some(root)) = (state.engine().cloned(), state.root().cloned()) else {
            return;
        };
        let filter = self.filter(root.id);
        let query = {
            let current = self.table.read(cx).delegate().query.clone();
            FileQuery {
                filter: filter.clone(),
                sort: current
                    .as_ref()
                    .map_or(FileSortColumn::Path, |query| query.sort),
                descending: current.as_ref().is_some_and(|query| query.descending),
                offset: 0,
                limit: PAGE as u32,
            }
        };
        let root_name: SharedString = root.name.clone().into();
        self.table.update(cx, |table, cx| {
            table.delegate_mut().root_name = root_name;
            table.delegate_mut().reset(engine.clone(), query, cx);
        });
        self.facets
            .load(engine.file_facets(filter), |this| &mut this.facets, cx);
        self.folders
            .load(engine.list_folders(root.id), |this| &mut this.folders, cx);
        self.targets_seen.1 = u64::MAX;
        self.targets_changed(cx);
    }

    fn set_filters(&mut self, filters: Filters, cx: &mut Context<Self>) {
        if self.filters != filters {
            self.filters = filters;
            self.reload(cx);
            cx.notify();
        }
    }

    fn search_changed(&mut self, cx: &mut Context<Self>) {
        let text = self.search.read(cx).value().to_string();
        self.search_timer = Some(cx.spawn(async move |this, cx| {
            cx.background_executor()
                .timer(Duration::from_millis(200))
                .await;
            this.update(cx, |this, cx| {
                if this.applied_search != text {
                    this.applied_search = text;
                    this.reload(cx);
                }
            })
            .ok();
        }));
    }

    /// The files the Inspector and the shortcuts act on: the selection, or else the cursor's.
    fn targets(&self, cx: &App) -> Vec<FileId> {
        let table = self.table.read(cx);
        let rows = table.delegate();
        if !rows.selected().is_empty() {
            return rows.selected().iter().copied().collect();
        }
        table
            .selected_row()
            .and_then(|index| rows.row(index))
            .map(|row| vec![row.id])
            .unwrap_or_default()
    }

    fn cursor_row(&self, cx: &App) -> Option<FileRow> {
        let table = self.table.read(cx);
        table
            .selected_row()
            .and_then(|index| table.delegate().row(index))
            .cloned()
    }

    /// Asks what the targets hold, so the bar and the Inspector offer only what applies.
    fn targets_changed(&mut self, cx: &mut Context<Self>) {
        let targets = self.targets(cx);
        let version = self.state.read(cx).catalog_version();
        if (targets.clone(), version) == self.targets_seen {
            cx.notify();
            return;
        }
        self.targets_seen = (targets.clone(), version);
        let Some(engine) = self.state.read(cx).engine().cloned() else {
            return;
        };
        if targets.is_empty() {
            self.summary.clear();
            self.sample.clear();
            cx.notify();
            return;
        }
        self.targets_timer = Some(cx.spawn(async move |this, cx| {
            cx.background_executor()
                .timer(Duration::from_millis(80))
                .await;
            this.update(cx, |this, cx| {
                let bulk: Vec<FileId> = targets.iter().copied().take(MAX_BULK_FILES).collect();
                this.summary
                    .load(engine.selection_summary(bulk), |this| &mut this.summary, cx);
                let sample: Vec<FileId> = targets.iter().copied().take(3).collect();
                this.sample
                    .load(engine.get_files(sample), |this| &mut this.sample, cx);
            })
            .ok();
        }));
        cx.notify();
    }

    fn selected(&self, cx: &App) -> Vec<FileId> {
        self.table
            .read(cx)
            .delegate()
            .selected()
            .iter()
            .copied()
            .collect()
    }

    fn clear_selection(&mut self, cx: &mut Context<Self>) {
        self.table.update(cx, |table, cx| {
            table.delegate_mut().set_selected(BTreeSet::new(), cx);
        });
    }

    /// Selects every matching file, up to what a bulk action takes (⌘A).
    pub fn select_all(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let state = self.state.read(cx);
        let (Some(engine), Some(root_id)) = (state.engine().cloned(), state.root_id()) else {
            return;
        };
        let ids = engine.list_file_ids(self.filter(root_id));
        cx.spawn_in(window, async move |this, cx| {
            let ids = ids.await;
            this.update_in(cx, |this, window, cx| match ids {
                Ok(list) => {
                    this.table.update(cx, |table, cx| {
                        table
                            .delegate_mut()
                            .set_selected(list.ids.into_iter().collect(), cx);
                    });
                    if list.truncated {
                        crate::widgets::show_toast(
                            window,
                            Toast::info(format!(
                                "Selected the first {} files",
                                format::count(MAX_BULK_FILES as i64)
                            ))
                            .detail("Narrow the filter to act on the rest."),
                            cx,
                        );
                    }
                }
                Err(error) => crate::widgets::show_toast(
                    window,
                    Toast::error("Something went wrong").detail(format!("{error:#}")),
                    cx,
                ),
            })
            .ok();
        })
        .detach();
    }

    fn perform(&mut self, request: PlanRequest, window: &mut Window, cx: &mut Context<Self>) {
        self.state.update(cx, |state, cx| {
            state.perform(request, PerformOptions::default(), window, cx);
        });
        self.clear_selection(cx);
    }

    fn hold(&mut self, ids: Vec<FileId>, window: &mut Window, cx: &mut Context<Self>) {
        if !ids.is_empty() {
            self.perform(PlanRequest::Hold { file_ids: ids }, window, cx);
        }
    }

    fn convert(&mut self, ids: Vec<FileId>, window: &mut Window, cx: &mut Context<Self>) {
        let Some(root_id) = self.state.read(cx).root_id() else {
            return;
        };
        if !ids.is_empty() {
            self.perform(
                PlanRequest::Optimize {
                    root_id,
                    categories: ALL_CATEGORIES.to_vec(),
                    file_ids: Some(ids),
                },
                window,
                cx,
            );
        }
    }

    /// Move to…: a folder inside the root, from Tidy's picker.
    fn move_to(&mut self, ids: Vec<FileId>, window: &mut Window, cx: &mut Context<Self>) {
        let Some(root) = self.state.read(cx).root().cloned() else {
            return;
        };
        if ids.is_empty() {
            return;
        }
        let options = crate::folder_picker::PickOptions {
            title: format!("Move {} to", format::plural(ids.len() as i64, "file")).into(),
            action: "Move here".into(),
            start: None,
            select: None,
            within: Some((root.path.clone().into(), root.name.clone())),
            sandbox: None,
        };
        let page = cx.entity().downgrade();
        crate::folder_picker::open(options, window, cx, move |folder, window, cx| {
            let ids = ids.clone();
            page.update(cx, |page, cx| {
                page.perform(
                    PlanRequest::Move {
                        file_ids: ids,
                        target_dir: folder.to_string_lossy().into_owned(),
                    },
                    window,
                    cx,
                );
            })
            .ok();
        });
    }

    fn rename(&mut self, row: FileRow, window: &mut Window, cx: &mut Context<Self>) {
        let input = cx.new(|cx| {
            let mut state = InputState::new(window, cx);
            state.set_value(row.name.clone(), window, cx);
            state
        });
        let page = cx.entity().downgrade();
        let field = input.clone();
        window.open_dialog(cx, move |dialog, _, _| {
            let (page, field, id) = (page.clone(), field.clone(), row.id);
            dialog
                .title(format!("Rename “{}”", row.name))
                .w(px(420.))
                .child(Input::new(&input))
                .footer(div().flex().flex_row().justify_end().gap_2().child(
                    Button::new("rename-ok").primary().label("Rename").on_click(
                        move |_, window, cx| {
                            let name = field.read(cx).value().trim().to_string();
                            window.close_dialog(cx);
                            if name.is_empty() {
                                return;
                            }
                            page.update(cx, |page, cx| {
                                page.perform(
                                    PlanRequest::Rename {
                                        renames: vec![Rename { file_id: id, name }],
                                    },
                                    window,
                                    cx,
                                );
                            })
                            .ok();
                        },
                    ),
                ))
        });
    }

    fn toggle_inspector(&mut self, cx: &mut Context<Self>) {
        self.inspector = !self.inspector;
        LocalStorage::set(
            cx,
            INSPECTOR_KEY,
            if self.inspector { "open" } else { "closed" },
        );
        cx.notify();
    }

    /// Open in View, for a file of the Library's (`useOpenInView`).
    fn open_in_view(&mut self, file: String, cx: &mut Context<Self>) {
        self.state
            .update(cx, |state, cx| state.open_in_view(file, cx));
    }

    /// The search the rows are filtered by, as the field shows it once drawn.
    pub fn search(&self) -> &str {
        &self.applied_search
    }

    fn on_key_down(&mut self, event: &KeyDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        let keys = &event.keystroke;
        let typing = window.has_focused_input(cx);
        let selected = self.selected(cx);
        if keys.key == "/" && !keys.modifiers.modified() && !typing {
            self.search.focus_handle(cx).focus(window, cx);
        } else if keys.key == "i" && !keys.modifiers.modified() && !typing {
            self.toggle_inspector(cx);
        } else if keys.key == "escape" && !typing && !selected.is_empty() {
            self.clear_selection(cx);
        } else if keys.modifiers.platform && keys.key == "backspace" && !selected.is_empty() {
            self.hold(selected, window, cx);
        } else if keys.modifiers.platform && keys.modifiers.shift && keys.key == "m" {
            self.move_to(selected, window, cx);
        } else if keys.modifiers.platform && keys.modifiers.shift && keys.key == "r" {
            if let Some(row) = self.cursor_row(cx) {
                cx.reveal_path(Path::new(&row.abs_path));
            }
        } else if keys.key == "enter" && !keys.modifiers.modified() && !typing {
            if let Some(row) = self.cursor_row(cx) {
                self.rename(row, window, cx);
            }
        } else {
            return;
        }
        cx.stop_propagation();
    }

    /// The More… menu: what applies to the files at hand (`moreEntries`).
    fn more_menu(&self, cx: &mut Context<Self>) -> impl IntoElement + use<> {
        let page = cx.entity().downgrade();
        let summary = self.summary.data().cloned();
        let single = self.single(cx);
        let ids = self.targets(cx);
        let quality = self
            .state
            .read(cx)
            .settings()
            .map_or(VideoQuality::High, |settings| settings.reencode_quality);
        Button::new("library-more")
            .ghost()
            .small()
            .icon(Icon::new(IconName::Ellipsis))
            .accessibility_label("More actions")
            .tooltip("More actions")
            .dropdown_menu(move |menu, _, _| {
                let mut menu = menu;
                let act = |request: PlanRequest| {
                    let page = page.clone();
                    move |_: &gpui_kit::ClickEvent, window: &mut Window, cx: &mut App| {
                        let request = request.clone();
                        page.update(cx, |page, cx| page.perform(request, window, cx))
                            .ok();
                    }
                };
                if let Some(row) = &single {
                    let (open, reveal) = (row.abs_path.clone(), row.abs_path.clone());
                    let (shown, viewing) = (row.abs_path.clone(), page.clone());
                    menu = menu
                        .item(PopupMenuItem::new("Open").on_click(move |_, _, cx| {
                            cx.open_with_system(Path::new(&open));
                        }))
                        .item(
                            PopupMenuItem::new("Open in View").on_click(move |_, _, cx| {
                                let file = shown.clone();
                                viewing
                                    .update(cx, |page, cx| page.open_in_view(file, cx))
                                    .ok();
                            }),
                        )
                        .item(
                            PopupMenuItem::new("Show in Finder  ⇧⌘R")
                                .on_click(move |_, _, cx| cx.reveal_path(Path::new(&reveal))),
                        )
                        .separator();
                }
                if let Some(summary) = &summary {
                    if summary.convertible.files > 0 {
                        let page = page.clone();
                        let ids = ids.clone();
                        menu = menu.item(
                            PopupMenuItem::new(format!(
                                "Convert {} to AVIF or MP4",
                                format::count(summary.convertible.files)
                            ))
                            .on_click(move |_, window, cx| {
                                let ids = ids.clone();
                                page.update(cx, |page, cx| page.convert(ids, window, cx))
                                    .ok();
                            }),
                        );
                    }
                    if summary.videos > 0 {
                        for (codec, label) in [
                            (VideoCodecChoice::Hevc, "HEVC"),
                            (VideoCodecChoice::Av1, "AV1"),
                            (VideoCodecChoice::Avc, "H.264"),
                        ] {
                            menu = menu.item(
                                PopupMenuItem::new(format!(
                                    "Re-encode {} as {label}",
                                    format::plural(summary.videos, "video")
                                ))
                                .on_click(act(
                                    PlanRequest::Reencode {
                                        file_ids: ids.clone(),
                                        codec,
                                        quality,
                                    },
                                )),
                            );
                        }
                    }
                    if summary.with_audio > 0 {
                        menu = menu.item(
                            PopupMenuItem::new(format!(
                                "Remove the audio track from {}",
                                format::plural(summary.with_audio, "video")
                            ))
                            .on_click(act(PlanRequest::StripAudio {
                                file_ids: ids.clone(),
                            })),
                        );
                    }
                    if summary.extension_mismatches > 0 {
                        menu = menu.item(
                            PopupMenuItem::new(format!(
                                "Fix {}",
                                format::plural(summary.extension_mismatches, "extension")
                            ))
                            .on_click(act(
                                PlanRequest::FixExtension {
                                    file_ids: ids.clone(),
                                },
                            )),
                        );
                    }
                }
                if let Some(row) = &single
                    && ids.len() <= 1
                {
                    let folder = if row.dir.is_empty() {
                        "the top folder".to_string()
                    } else {
                        row.dir.clone()
                    };
                    let (rename, prefer, only) = (page.clone(), page.clone(), page.clone());
                    let (renamed, dir, shown) = (row.clone(), row.dir.clone(), row.dir.clone());
                    menu = menu
                        .item(
                            PopupMenuItem::new("Rename…  ↩").on_click(move |_, window, cx| {
                                let row = renamed.clone();
                                rename
                                    .update(cx, |page, cx| page.rename(row, window, cx))
                                    .ok();
                            }),
                        )
                        .separator()
                        .item(
                            PopupMenuItem::new(format!("Prefer {folder} for duplicates")).on_click(
                                move |_, window, cx| {
                                    let dir = dir.clone();
                                    prefer
                                        .update(cx, |page, cx| {
                                            crate::settings::prefer_folder(
                                                &page.state,
                                                dir,
                                                window,
                                                cx,
                                            );
                                        })
                                        .ok();
                                },
                            ),
                        )
                        .item(PopupMenuItem::new(format!("Show only {folder}")).on_click(
                            move |_, _, cx| {
                                let dir = shown.clone();
                                only.update(cx, |page, cx| {
                                    let filters = Filters {
                                        dir: Some(dir),
                                        ..page.filters.clone()
                                    };
                                    page.set_filters(filters, cx);
                                })
                                .ok();
                            },
                        ));
                }
                let (move_page, hold_page) = (page.clone(), page.clone());
                let (move_ids, hold_ids) = (ids.clone(), ids.clone());
                menu.separator()
                    .item(
                        PopupMenuItem::new("Move to…  ⇧⌘M").on_click(move |_, window, cx| {
                            let ids = move_ids.clone();
                            move_page
                                .update(cx, |page, cx| page.move_to(ids, window, cx))
                                .ok();
                        }),
                    )
                    .item(PopupMenuItem::new("Move to holding  ⌘⌫").on_click(
                        move |_, window, cx| {
                            let ids = hold_ids.clone();
                            hold_page
                                .update(cx, |page, cx| page.hold(ids, window, cx))
                                .ok();
                        },
                    ))
            })
    }

    /// The one file shown: the cursor's without a selection, or the one selected.
    fn single(&self, cx: &App) -> Option<FileRow> {
        let selected = self.selected(cx);
        match selected.as_slice() {
            [] => self.cursor_row(cx),
            [only] => self
                .cursor_row(cx)
                .filter(|row| row.id == *only)
                .or_else(|| {
                    self.sample
                        .data()
                        .and_then(|rows| rows.iter().find(|row| row.id == *only).cloned())
                }),
            _ => None,
        }
    }

    fn render_filter(&self, root_name: &str, cx: &mut Context<Self>) -> impl IntoElement + use<> {
        let (border, muted) = (cx.theme().border, cx.theme().muted_foreground);
        let facets = self.facets.data().cloned();
        let filters = self.filters.clone();
        let active = filters.active();
        let count_of = |files: i64| format::count(files);

        let check = |id: String,
                     label: String,
                     count: Option<i64>,
                     checked: bool,
                     next: Filters,
                     close: bool,
                     cx: &mut Context<Self>| {
            let theme = cx.theme();
            let text = match count {
                Some(count) => format!("{label} {}", count_of(count)),
                None => label.clone(),
            };
            div()
                .id(SharedString::from(id))
                .test_support()
                .aria_label(SharedString::from(text))
                .aria_selected(checked)
                .flex()
                .flex_row()
                .items_center()
                .gap_2()
                .h(px(28.))
                .px_2()
                .rounded(theme.radius)
                .text_size(px(13.))
                .cursor_pointer()
                .hover(|style| style.bg(theme.accent))
                .on_click(cx.listener(move |this, _, _, cx| {
                    this.set_filters(next.clone(), cx);
                    if close {
                        this.filter_open = false;
                    }
                }))
                .child(div().w(px(16.)).flex_shrink_0().when(checked, |this| {
                    this.child(Icon::new(IconName::Check).size(px(14.)))
                }))
                .child(div().flex_1().min_w_0().truncate().child(label))
                .when_some(count, |this, count| {
                    this.child(
                        div()
                            .flex_shrink_0()
                            .text_xs()
                            .text_color(theme.muted_foreground)
                            .child(count_of(count)),
                    )
                })
                .into_any_element()
        };

        let group = |label: &'static str, items: Vec<AnyElement>, cx: &App| -> Option<AnyElement> {
            (!items.is_empty()).then(|| {
                div()
                    .flex()
                    .flex_col()
                    .pb_1()
                    .child(
                        div()
                            .px_2()
                            .py_1()
                            .text_xs()
                            .font_weight(FontWeight::MEDIUM)
                            .text_color(cx.theme().muted_foreground)
                            .child(label),
                    )
                    .children(items)
                    .into_any_element()
            })
        };

        let files = |list: Option<i64>| list.unwrap_or(0);
        let mut kinds = Vec::new();
        for kind in FileKind::ALL.iter().copied() {
            let count = files(facets.as_ref().and_then(|facets| {
                facets
                    .kinds
                    .iter()
                    .find(|entry| entry.value == kind)
                    .map(|entry| entry.files)
            }));
            let checked = filters.kinds.contains(&kind);
            if count > 0 || checked {
                let next = Filters {
                    kinds: toggled(&filters.kinds, kind, !checked),
                    ..filters.clone()
                };
                kinds.push(check(
                    format!("filter-kind-{kind}"),
                    format::kind_label(kind).into(),
                    Some(count),
                    checked,
                    next,
                    false,
                    cx,
                ));
            }
        }
        let mut formats = Vec::new();
        let mut format_values: Vec<(FileFormat, i64)> = facets
            .as_ref()
            .map(|facets| {
                facets
                    .formats
                    .iter()
                    .filter_map(|entry| entry.value.map(|value| (value, entry.files)))
                    .collect()
            })
            .unwrap_or_default();
        for format in &filters.formats {
            if !format_values.iter().any(|(value, _)| value == format) {
                format_values.push((*format, 0));
            }
        }
        for (format, count) in format_values {
            let checked = filters.formats.contains(&format);
            let next = Filters {
                formats: toggled(&filters.formats, format, !checked),
                ..filters.clone()
            };
            formats.push(check(
                format!("filter-format-{format}"),
                format::format_label(Some(format)).into(),
                Some(count),
                checked,
                next,
                false,
                cx,
            ));
        }
        let mut sounds = Vec::new();
        for audio in AudioState::ALL.iter().copied() {
            let count = files(facets.as_ref().and_then(|facets| {
                facets
                    .audio_states
                    .iter()
                    .find(|entry| entry.value == audio)
                    .map(|entry| entry.files)
            }));
            let checked = filters.audio_states.contains(&audio);
            if count > 0 || checked {
                let next = Filters {
                    audio_states: toggled(&filters.audio_states, audio, !checked),
                    ..filters.clone()
                };
                sounds.push(check(
                    format!("filter-sound-{audio}"),
                    format::audio_label(audio).into(),
                    Some(count),
                    checked,
                    next,
                    false,
                    cx,
                ));
            }
        }
        let mut issues = Vec::new();
        for flag in format::issue_flags() {
            let count = files(facets.as_ref().and_then(|facets| {
                facets
                    .flags
                    .iter()
                    .find(|entry| entry.value == flag)
                    .map(|entry| entry.files)
            }));
            let checked = filters.flags.contains(&flag);
            if count > 0 || checked {
                let next = Filters {
                    flags: toggled(&filters.flags, flag, !checked),
                    ..filters.clone()
                };
                issues.push(check(
                    format!("filter-flag-{flag}"),
                    format::flag_label(flag).into(),
                    Some(count),
                    checked,
                    next,
                    false,
                    cx,
                ));
            }
        }
        let needle = self.folder_search.read(cx).value().trim().to_lowercase();
        let all_folders = self.folders.data().cloned().unwrap_or_default();
        let mut folders = vec![check(
            "filter-folder-all".into(),
            format!("All of {root_name}"),
            None,
            filters.dir.is_none(),
            Filters {
                dir: None,
                ..filters.clone()
            },
            true,
            cx,
        )];
        for folder in all_folders
            .iter()
            .filter(|folder| !folder.is_empty() && folder.to_lowercase().contains(&needle))
            .take(FOLDER_LIMIT)
        {
            let checked = filters.dir.as_deref() == Some(folder.as_str());
            folders.push(check(
                format!("filter-folder-{folder}"),
                folder.clone(),
                None,
                checked,
                Filters {
                    dir: (!checked).then(|| folder.clone()),
                    ..filters.clone()
                },
                true,
                cx,
            ));
        }
        let left = div()
            .flex()
            .flex_col()
            .flex_1()
            .children(group("Kind", kinds, cx))
            .children(group("Sound", sounds, cx));
        let right = div()
            .flex()
            .flex_col()
            .flex_1()
            .children(group("Format", formats, cx))
            .children(group("Issues", issues, cx));
        let many_folders = all_folders.len() > 8;

        Popover::new("library-filter-menu")
            .anchor(gpui_kit::Anchor::TopRight)
            .open(self.filter_open)
            .on_open_change(cx.listener(|this, open: &bool, _, cx| {
                this.filter_open = *open;
                cx.notify();
            }))
            .trigger(
                Button::new("library-filter")
                    .outline()
                    .small()
                    .icon(Icon::new(IconName::ListFilter))
                    .label(if active > 0 {
                        format!("Filter {}", format::count(active as i64))
                    } else {
                        "Filter".into()
                    }),
            )
            .w(px(520.))
            .max_h(px(640.))
            .child(
                div()
                    .id("library-filter-content")
                    .flex()
                    .flex_col()
                    .max_h(px(600.))
                    .overflow_y_scroll()
                    .child(div().flex().flex_row().gap_1().child(left).child(right))
                    .child(div().my_1().h(px(1.)).bg(border))
                    .child(
                        div()
                            .px_2()
                            .py_1()
                            .text_xs()
                            .font_weight(FontWeight::MEDIUM)
                            .text_color(muted)
                            .child("Folder"),
                    )
                    .when(many_folders, |this| {
                        this.child(
                            div()
                                .px_1()
                                .pb_1()
                                .child(Input::new(&self.folder_search).small()),
                        )
                    })
                    .child(div().flex().flex_col().children(folders)),
            )
    }

    fn render_chips(&self, root_name: &str, cx: &mut Context<Self>) -> Option<AnyElement> {
        let filters = self.filters.clone();
        if filters.active() == 0 {
            return None;
        }
        let theme = cx.theme();
        let mut chips: Vec<(String, String, Filters)> = Vec::new();
        for kind in &filters.kinds {
            chips.push((
                format!("chip-kind-{kind}"),
                format::kind_label(*kind).into(),
                Filters {
                    kinds: toggled(&filters.kinds, *kind, false),
                    ..filters.clone()
                },
            ));
        }
        for format_value in &filters.formats {
            chips.push((
                format!("chip-format-{format_value}"),
                format::format_label(Some(*format_value)).into(),
                Filters {
                    formats: toggled(&filters.formats, *format_value, false),
                    ..filters.clone()
                },
            ));
        }
        for audio in &filters.audio_states {
            chips.push((
                format!("chip-sound-{audio}"),
                format::audio_label(*audio).into(),
                Filters {
                    audio_states: toggled(&filters.audio_states, *audio, false),
                    ..filters.clone()
                },
            ));
        }
        for flag in &filters.flags {
            chips.push((
                format!("chip-flag-{flag}"),
                format::flag_label(*flag).into(),
                Filters {
                    flags: toggled(&filters.flags, *flag, false),
                    ..filters.clone()
                },
            ));
        }
        if let Some(dir) = &filters.dir {
            chips.push((
                "chip-dir".into(),
                format!("In {}", if dir.is_empty() { root_name } else { dir }),
                Filters {
                    dir: None,
                    ..filters.clone()
                },
            ));
        }
        Some(
            div()
                .flex()
                .flex_row()
                .flex_shrink_0()
                .items_center()
                .gap(px(6.))
                .h(px(40.))
                .px_5()
                .border_b_1()
                .border_color(theme.border)
                .children(chips.into_iter().map(|(id, label, next)| {
                    div()
                        .flex()
                        .flex_row()
                        .items_center()
                        .gap_1()
                        .h(px(24.))
                        .pl_2()
                        .pr_1()
                        .rounded_full()
                        .bg(theme.muted)
                        .text_xs()
                        .child(div().max_w(px(280.)).truncate().child(label.clone()))
                        .child(
                            Button::new(SharedString::from(id))
                                .ghost()
                                .xsmall()
                                .icon(Icon::new(IconName::Close))
                                .accessibility_label(SharedString::from(format!("Remove {label}")))
                                .on_click(cx.listener(move |this, _, _, cx| {
                                    this.set_filters(next.clone(), cx);
                                })),
                        )
                }))
                .child(
                    Button::new("chips-clear")
                        .ghost()
                        .xsmall()
                        .label("Clear")
                        .on_click(cx.listener(|this, _, _, cx| {
                            this.set_filters(Filters::default(), cx);
                        })),
                )
                .into_any_element(),
        )
    }

    fn render_selection_bar(&self, cx: &mut Context<Self>) -> AnyElement {
        let more = self.more_menu(cx);
        let theme = cx.theme();
        let selected = self.selected(cx);
        let summary = self.summary.data().cloned();
        let label = format!(
            "{} selected{}",
            format::count(selected.len() as i64),
            summary
                .as_ref()
                .map(|summary| format!(" · {}", format::bytes(summary.bytes as f64)))
                .unwrap_or_default()
        );
        let (convert_ids, hold_ids, move_ids) = (selected.clone(), selected.clone(), selected);
        div()
            .absolute()
            .bottom(px(20.))
            .left_0()
            .right_0()
            .flex()
            .justify_center()
            .child(
                div()
                    .id("library-selection")
                    .test_support()
                    .aria_label(SharedString::from(label.clone()))
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap(px(6.))
                    .p(px(6.))
                    .rounded(theme.radius_lg)
                    .bg(theme.popover)
                    .border_1()
                    .border_color(theme.border)
                    .shadow_lg()
                    .child(widgets::caption(label, cx).px_2())
                    .child(div().h(px(20.)).w(px(1.)).bg(theme.border))
                    .when_some(
                        summary.filter(|summary| summary.convertible.files > 0),
                        |this, summary| {
                            this.child(
                                Button::new("selection-convert")
                                    .primary()
                                    .small()
                                    .label(format::convert_label(
                                        summary.convertible.files,
                                        summary.files,
                                    ))
                                    .on_click(cx.listener(move |this, _, window, cx| {
                                        this.convert(convert_ids.clone(), window, cx);
                                    })),
                            )
                        },
                    )
                    .child(
                        Button::new("selection-hold")
                            .outline()
                            .small()
                            .label("Move to holding")
                            .tooltip("⌘⌫")
                            .on_click(cx.listener(move |this, _, window, cx| {
                                this.hold(hold_ids.clone(), window, cx);
                            })),
                    )
                    .child(
                        Button::new("selection-move")
                            .outline()
                            .small()
                            .label("Move to…")
                            .tooltip("⇧⌘M")
                            .on_click(cx.listener(move |this, _, window, cx| {
                                this.move_to(move_ids.clone(), window, cx);
                            })),
                    )
                    .child(more)
                    .child(
                        Button::new("selection-clear")
                            .ghost()
                            .small()
                            .icon(Icon::new(IconName::Close))
                            .accessibility_label("Clear selection")
                            .tooltip("Esc")
                            .on_click(cx.listener(|this, _, _, cx| this.clear_selection(cx))),
                    ),
            )
            .into_any_element()
    }

    fn render_inspector(&self, primary: bool, cx: &mut Context<Self>) -> AnyElement {
        let theme = cx.theme();
        let targets = self.targets(cx);
        let summary = self.summary.data().cloned();
        let single = self.single(cx);
        let mut panel = div()
            .id("library-inspector")
            .flex()
            .flex_col()
            .w(px(320.))
            .flex_shrink_0()
            .h_full()
            .overflow_y_scroll()
            .border_l_1()
            .border_color(theme.border)
            .p_4();
        if targets.is_empty() {
            return panel
                .child(
                    div()
                        .flex()
                        .flex_col()
                        .flex_1()
                        .items_center()
                        .justify_center()
                        .gap_2()
                        .pb(px(64.))
                        .child(
                            Icon::new(IconName::MousePointerClick)
                                .size(px(32.))
                                .text_color(theme.muted_foreground),
                        )
                        .child(widgets::caption("Select a file to see it here", cx)),
                )
                .into_any_element();
        }
        let convert_label = match (&single, &summary) {
            (Some(row), _) if targets.len() == 1 => {
                format!("Convert to {}", format::convert_target(row))
            }
            (_, Some(summary)) => format::convert_label(summary.convertible.files, summary.files),
            _ => "Convert".into(),
        };
        if targets.len() == 1 {
            let Some(row) = single.clone() else {
                return panel.into_any_element();
            };
            let (width, height) = (
                row.width.unwrap_or(16) as f32,
                row.height.unwrap_or(9) as f32,
            );
            let scale = (288. / width).min(288. / height);
            panel = panel.child(
                div().flex().justify_center().child(
                    div()
                        .w(px((width * scale).round()))
                        .h(px((height * scale).round()))
                        .rounded(theme.radius_lg)
                        .overflow_hidden()
                        .bg(theme.muted)
                        .child(thumbs::picture(
                            &self.thumbs,
                            &row,
                            640,
                            ObjectFit::Contain,
                            cx,
                        )),
                ),
            );
        } else {
            panel = panel.child(
                div()
                    .mt_3()
                    .text_center()
                    .text_size(px(13.))
                    .font_weight(FontWeight::MEDIUM)
                    .child(format!(
                        "{}{}",
                        format::plural(targets.len() as i64, "file"),
                        summary
                            .as_ref()
                            .map(|summary| format!(" · {}", format::bytes(summary.bytes as f64)))
                            .unwrap_or_default()
                    )),
            );
        }
        let convertible = summary
            .as_ref()
            .is_some_and(|summary| summary.convertible.files > 0);
        let (convert_ids, hold_ids, move_ids) = (targets.clone(), targets.clone(), targets.clone());
        let reveal = single
            .clone()
            .or_else(|| self.sample.data().and_then(|rows| rows.first().cloned()));
        let shown = reveal.clone();
        let several = targets.len() > 1;
        panel = panel.child(
            div()
                .mt_4()
                .flex()
                .flex_col()
                .gap_2()
                .when(convertible, |this| {
                    this.child(
                        Button::new("inspector-convert")
                            .map(|button| {
                                if primary {
                                    button.primary()
                                } else {
                                    button.outline()
                                }
                            })
                            .w_full()
                            .label(convert_label)
                            .on_click(cx.listener(move |this, _, window, cx| {
                                this.convert(convert_ids.clone(), window, cx);
                            })),
                    )
                })
                .child(
                    div()
                        .flex()
                        .flex_row()
                        .gap_2()
                        .child(
                            Button::new("inspector-hold")
                                .outline()
                                .flex_1()
                                .label("Move to holding")
                                .tooltip("Move to holding  ⌘⌫")
                                .on_click(cx.listener(move |this, _, window, cx| {
                                    this.hold(hold_ids.clone(), window, cx);
                                })),
                        )
                        .child(
                            Button::new("inspector-move")
                                .outline()
                                .flex_1()
                                .label("Move to…")
                                .tooltip("Move to…  ⇧⌘M")
                                .on_click(cx.listener(move |this, _, window, cx| {
                                    this.move_to(move_ids.clone(), window, cx);
                                })),
                        )
                        .child(
                            Button::new("inspector-reveal")
                                .outline()
                                .icon(Icon::new(IconName::FolderOpen))
                                .accessibility_label("Show in Finder")
                                .tooltip(if several {
                                    "Show the first file in Finder  ⇧⌘R"
                                } else {
                                    "Show in Finder  ⇧⌘R"
                                })
                                .on_click(move |_, _, cx| {
                                    if let Some(row) = &reveal {
                                        cx.reveal_path(Path::new(&row.abs_path));
                                    }
                                }),
                        )
                        .child(
                            Button::new("inspector-open-in-view")
                                .outline()
                                .icon(Icon::new(IconName::Images))
                                .accessibility_label("Open in View")
                                .tooltip(if several {
                                    "Open the first file in View"
                                } else {
                                    "Open in View"
                                })
                                .on_click(cx.listener(move |this, _, _, cx| {
                                    if let Some(row) = &shown {
                                        this.open_in_view(row.abs_path.clone(), cx);
                                    }
                                })),
                        ),
                ),
        );
        if targets.len() == 1
            && let Some(row) = single
        {
            panel = panel.child(details(&row, cx));
        }
        panel.into_any_element()
    }
}

/// The file's facts, under the Inspector's actions.
fn details(row: &FileRow, cx: &App) -> AnyElement {
    let theme = cx.theme();
    let fact = |label: &'static str, value: String| {
        div()
            .flex()
            .flex_col()
            .child(widgets::caption(label, cx))
            .child(div().mt_0p5().text_size(px(13.)).child(value))
    };
    let mut issues = Vec::new();
    if row.probe_error.is_some() {
        issues.push("Won't open".to_string());
    }
    if row.size == 0 {
        issues.push("Empty file".into());
    }
    if row.extension_mismatch {
        issues.push(format!("Wrong extension (.{})", row.ext));
    }
    if row.kind == FileKind::Junk {
        issues.push("System junk".into());
    }
    let video = row.kind == FileKind::Video;
    div()
        .id("inspector-details")
        .mt_5()
        .pt_4()
        .border_t_1()
        .border_color(theme.border)
        .flex()
        .flex_col()
        .gap_3()
        .child(fact("Path", row.rel_path.clone()))
        .child(fact(
            "Format",
            format!(
                "{} · {}",
                format::format_label(row.format),
                format::kind_label(row.kind)
            ),
        ))
        .when_some(format::dimensions(row), |this, dimensions| {
            let frames = row.frames.unwrap_or(1);
            this.child(fact(
                "Dimensions",
                if frames > 1 {
                    format!("{dimensions} · {}", format::plural(frames, "frame"))
                } else {
                    dimensions.replace('×', " × ")
                },
            ))
        })
        .when(video && row.duration_ms.is_some(), |this| {
            this.child(fact("Duration", format::duration(row.duration_ms)))
        })
        .when_some(row.audio_state.filter(|_| video), |this, audio| {
            this.child(fact("Sound", format::audio_label(audio).into()))
        })
        .child(fact("Size", format::bytes(row.size as f64)))
        .child(fact("Modified", format::date_time(row.mtime_ms)))
        .when(!issues.is_empty(), |this| {
            this.child(
                div()
                    .flex()
                    .flex_col()
                    .child(widgets::caption("Issues", cx))
                    .child(
                        div()
                            .mt_0p5()
                            .text_size(px(13.))
                            .text_color(theme.warning)
                            .child(issues.join(" · ")),
                    ),
            )
        })
        .into_any_element()
}

impl Focusable for LibraryPage {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}

impl Render for LibraryPage {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        // ⌘F from another page: the search, focused.
        if self.state.read(cx).page() == TidyPage::Library
            && self
                .state
                .update(cx, |state, _| state.take_search_request())
        {
            let focus = self.search.focus_handle(cx);
            cx.defer_in(window, move |_, window, cx| focus.focus(window, cx));
        }
        if let Some((number, preset)) = self.state.read(cx).library_request().cloned()
            && number != self.seen.2
            && self.search.read(cx).value() != preset.search.as_str()
        {
            self.search.update(cx, |input, cx| {
                input.set_value(preset.search.clone(), window, cx)
            });
        }
        let (root, shell) = {
            let state = self.state.read(cx);
            (state.root().cloned(), state.shell.clone())
        };
        let root_name = root
            .as_ref()
            .map_or_else(|| "Top folder".to_string(), |root| root.name.clone());
        let filter = self.render_filter(&root_name, cx);
        let chips = self.render_chips(&root_name, cx);
        let theme = cx.theme();
        let rows = self.table.read(cx).delegate();
        let total = rows.total();
        let total_bytes = rows.total_bytes();
        let selected = rows.selected().len();
        let filtered = self.filters.active() > 0 || !self.applied_search.is_empty();
        let caption = total.map(|total| match &root {
            Some(root) if filtered => format!(
                "{} of {} · {}",
                format::count(total as i64),
                format::plural(root.file_count, "file"),
                format::bytes(total_bytes as f64)
            ),
            _ => format!(
                "{} · {}",
                format::plural(total as i64, "file"),
                format::bytes(total_bytes as f64)
            ),
        });
        let bar_visible = selected > 0 && (!self.inspector || selected >= 2);

        let top_bar = TopBar::new(&shell, "Library")
            .when_some(caption, |bar, caption| {
                bar.trailing(
                    div()
                        .id("library-meta")
                        .test_support()
                        .aria_label(SharedString::from(caption.clone()))
                        .text_xs()
                        .text_color(theme.muted_foreground)
                        .child(caption),
                )
            })
            .trailing(
                div()
                    .w(px(260.))
                    .child(Input::new(&self.search).small().cleanable(true)),
            )
            .trailing(filter)
            .trailing(
                Button::new("library-inspector-toggle")
                    .ghost()
                    .small()
                    .icon(Icon::new(IconName::PanelRight))
                    .accessibility_label("Inspector")
                    .tooltip("Inspector  I")
                    .toggled(self.inspector)
                    .on_click(cx.listener(|this, _, _, cx| this.toggle_inspector(cx))),
            );

        let content: AnyElement = match total {
            Some(0) if filtered => widgets::empty_state(
                "library-empty",
                Some(IconName::Search),
                "No files match",
                None,
                vec![
                    Button::new("library-clear-filters")
                        .outline()
                        .label("Clear filters")
                        .on_click(cx.listener(|this, _, window, cx| {
                            this.search
                                .update(cx, |input, cx| input.set_value("", window, cx));
                            this.applied_search.clear();
                            this.filters = Filters::default();
                            this.reload(cx);
                        }))
                        .into_any_element(),
                ],
                cx,
            )
            .into_any_element(),
            Some(0) => widgets::empty_state(
                "library-empty",
                Some(IconName::FolderOpen),
                "This folder has no files yet",
                None,
                Vec::new(),
                cx,
            )
            .into_any_element(),
            // 44 px rows, as Electron Oriel's list has them, for the name over its folder.
            _ => DataTable::new(&self.table)
                .stripe(false)
                .bordered(false)
                .with_size(px(44.))
                .header_row_height(px(32.))
                .into_any_element(),
        };
        let selection_bar = bar_visible.then(|| self.render_selection_bar(cx));
        let inspector = self
            .inspector
            .then(|| self.render_inspector(!bar_visible, cx));

        div()
            .id("library")
            .track_focus(&self.focus)
            .key_context("TidyLibrary")
            .on_key_down(cx.listener(Self::on_key_down))
            .flex()
            .flex_col()
            .size_full()
            .min_h_0()
            .child(top_bar)
            .children(chips)
            .child(
                div()
                    .flex()
                    .flex_row()
                    .flex_1()
                    .min_h_0()
                    .items_stretch()
                    .child(
                        div()
                            .relative()
                            .flex()
                            .flex_col()
                            .flex_1()
                            .min_w_0()
                            .child(content)
                            .children(selection_bar),
                    )
                    .children(inspector),
            )
    }
}
