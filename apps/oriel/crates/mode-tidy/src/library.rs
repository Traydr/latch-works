//! The Library (`views/LibraryView.tsx`): every file in the catalog, as a list in GPUI Kit's data
//! table or as a grid of tiles, paged in from the engine as it scrolls, with the search, the
//! filter menu and its chips, the Inspector (I), the selection bar, and the menu a right-click or
//! the bar's "⋯" opens.
//!
//! Finder's selection model, as `use-file-cursor.ts` has it: a click selects one file, ⌘-click
//! adds or removes one, ⇧-click extends from the last one clicked; the arrows move the cursor
//! (← → too in the grid) and ⇧ extends; Space shows the cursor's file in Quick Look, Return
//! renames it in place and Esc clears. The table's selected row is the cursor. Bulk actions take
//! the selection; without one, the Inspector acts on the cursor's file. A command that has run
//! leaves neither, so the file that slides into the place of those it moved is not a target until
//! the owner chooses it, and the arrows go on from that place, passing by the files commands have
//! taken that the list still shows. Esc and the bar's Clear, in the list or the grid, clear the
//! selection and leave the cursor where it is; Esc with nothing selected takes the list's cursor
//! too. The cursor stays with its file as the list reads itself again, and shows only a file the
//! list has read, the one selected; a new sort or query takes it away and keeps the selection.

mod grid;
pub mod menu;

use std::cell::Cell;
use std::collections::{BTreeSet, HashMap, HashSet};
use std::ops::Range;
use std::path::Path;
use std::rc::Rc;
use std::time::Duration;

use gpui_kit::assets::IconName;
use gpui_kit::base::actions::{Cancel, SelectDown, SelectUp};
use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::checkbox::Checkbox;
use gpui_kit::component::input::{Escape as InputEscape, Input, InputEvent, InputState};
use gpui_kit::component::popover::Popover;
use gpui_kit::component::table::{
    Column, ColumnSort, DataTable, TableDelegate, TableEvent, TableState,
};
use gpui_kit::component::{ActiveTheme as _, Icon, Sizable as _, WindowExt as _};
use gpui_kit::{
    AnyElement, App, AppContext as _, Bounds, ClickEvent, Context, Entity, FocusHandle, Focusable,
    FontWeight, InteractiveElement as _, IntoElement, KeyDownEvent, Modifiers, MouseDownEvent,
    ObjectFit, ParentElement as _, Pixels, Render, SharedString, Stateful,
    StatefulInteractiveElement as _, Styled as _, Subscription, Task, TestSupportExt as _,
    UniformListScrollHandle, Window, canvas, div, prelude::FluentBuilder as _, px,
};
pub use menu::{LibraryMenu, MenuChoice, last_menu};
use oriel_core_tidy::TidyEngine;
use oriel_core_tidy::contract::{
    AudioState, FileFacets, FileFilter, FileFlag, FileFormat, FileId, FileKind, FileQuery, FileRow,
    FileSortColumn, MAX_BULK_FILES, OptimizeCategory, RootId, SelectionSummary, VideoQuality,
};
use oriel_ui::{ControlSize as _, LocalStorage, MENU_ROW_HEIGHT, Toast, TopBar, checkbox_target};

use crate::actions::{OnUndone, PerformOptions};
use crate::changes::{PlanRequest, Rename};
use crate::format;
use crate::loaded::Loaded;
use crate::pages::TidyPage;
use crate::quick_look::quick_look;
use crate::state::{LibraryPreset, TidyState};
use crate::thumbs::{self, Thumbs};
use crate::widgets;

/// Rows read from the engine at once, as the table scrolls.
const PAGE: usize = 200;

/// Where the Inspector's choice is kept, Electron Oriel's key.
const INSPECTOR_KEY: &str = "glazier.library.inspector";

/// Where the choice of list or grid is kept, Electron Oriel's key.
const MODE_KEY: &str = "glazier.library.mode";

/// Room the selection bar covers at the bottom of the files, so the last ones scroll clear of it.
const BAR_INSET: f32 = 80.;

fn is_command(modifiers: &Modifiers) -> bool {
    oriel_ui::keys::command_held(modifiers)
}

/// The Library shown as a list or as a grid of tiles.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LibraryMode {
    List,
    Grid,
}

impl LibraryMode {
    fn key(self) -> &'static str {
        match self {
            LibraryMode::List => "list",
            LibraryMode::Grid => "grid",
        }
    }
}

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

/// The name's room before the table has been measured, and the least it keeps.
const NAME_WIDTH: f32 = 360.;
const MIN_NAME_WIDTH: f32 = 200.;
/// What the table's vertical scrollbar takes from the columns.
const SCROLLBAR: f32 = 16.;

/// The columns a list `width` wide shows, and the name's width (`columnsFor`): a narrow list
/// drops Modified first, then Dimensions, so the name keeps room to read, and the name takes
/// whatever the others leave.
fn columns_for(width: f32) -> (Vec<Col>, f32) {
    let mut columns = vec![Col::Select, Col::Name, Col::Format];
    if width >= 620. {
        columns.push(Col::Dimensions);
    }
    columns.push(Col::Size);
    if width >= 760. {
        columns.push(Col::Modified);
    }
    let fixed: f32 = columns.iter().map(|column| column.width()).sum();
    (columns, (width - fixed - SCROLLBAR).max(MIN_NAME_WIDTH))
}

impl Col {
    /// The column's width; the name's is whatever the others leave.
    fn width(self) -> f32 {
        match self {
            Col::Select => 44.,
            Col::Name => 0.,
            Col::Format => 110.,
            Col::Dimensions => 120.,
            Col::Size => 96.,
            Col::Modified => 130.,
        }
    }

    fn column(self, name_width: f32, sort: Option<ColumnSort>) -> Column {
        let column = match self {
            Col::Select => return Column::new("select", "").width(self.width()),
            Col::Name => Column::new("name", "Name").width(name_width),
            Col::Format => Column::new("format", "Format").width(self.width()),
            Col::Dimensions => Column::new("dimensions", "Dimensions").width(self.width()),
            Col::Size => Column::new("size", "Size").width(self.width()).text_right(),
            Col::Modified => Column::new("modified", "Modified")
                .width(self.width())
                .text_right(),
        };
        let mut column = column.sortable();
        column.sort = sort;
        column
    }

    /// Whether the first click sorts largest, newest or longest first, as Finder does
    /// (`DESCENDING_FIRST`); names and formats start from A.
    fn descending_first(self) -> bool {
        matches!(self, Col::Dimensions | Col::Size | Col::Modified)
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

/// What the header's checkbox calls to select every matching file: the page's ⌘A, which asks
/// the engine for the ids.
type SelectAll = Rc<dyn Fn(&mut Window, &mut App)>;

/// Where the cursor was when a command took its files, for the arrows to go on from. It is known by
/// the files either side, as the list may read itself again before an arrow is pressed.
struct Gap {
    /// The cursor's row, for when neither file beside it is among the rows read.
    index: usize,
    before: Beside,
    after: Beside,
    /// An arrow pressed while the row it goes to was not read yet: whether it went on or back.
    step: Option<bool>,
}

/// What lies on one side of a [`Gap`].
#[derive(Clone, Copy)]
enum Beside {
    File(FileId),
    /// There are more files that way, on a page not read when the gap opened.
    NotRead,
    /// The list ends on this side.
    End,
}

/// Where an arrow from a gap goes.
enum Step {
    To(usize, FileId),
    /// The row at this place has to be read first.
    Read(usize),
    Nowhere,
}

/// Files a command took from their places, which the list goes on showing until it reads itself
/// again after the command.
struct Taken {
    key: u64,
    files: BTreeSet<FileId>,
    /// The reading of the list when the command ended; a later one no longer shows them.
    ended: Option<u64>,
}

/// The table's rows: pages of the catalog, read as they come into view.
pub struct CatalogRows {
    engine: Option<TidyEngine>,
    query: Option<FileQuery>,
    total: Option<usize>,
    total_bytes: i64,
    pages: HashMap<usize, Vec<FileRow>>,
    requested: HashSet<usize>,
    /// The first page is on its way, and will replace the rest: a later page read now would count
    /// the list as it is, beside rows that count it as it was, and be dropped anyway.
    first_page_due: bool,
    generation: u64,
    selected: BTreeSet<FileId>,
    /// Where ⇧ extends from: the file last clicked, toggled or moved to without ⇧.
    anchor: Option<usize>,
    /// The selection a move of the cursor brings, in place of the cursor's file alone.
    pending: Option<BTreeSet<FileId>>,
    /// The cursor goes when the query changes, the selection stays.
    keep_selection: bool,
    /// Where the cursor was, while no file has taken its place.
    gap: Option<Gap>,
    taken: Vec<Taken>,
    next_taken: u64,
    /// The file the cursor is on, which it stays with as the list reads itself again; none while
    /// its row has not been read, when that row's file is selected once it is.
    cursor_file: Option<FileId>,
    /// The cursor's file, gone from the cursor's row when the list read itself again, and that
    /// row: the cursor is hidden until the file is found, so it never shows one file and selects
    /// another.
    lost: Option<(FileId, usize)>,
    /// The pages asked for whose rows have not come yet.
    in_flight: HashSet<usize>,
    /// The file being renamed in place, and its field.
    renaming: Option<(FileId, Entity<InputState>)>,
    /// Selects every matching file, from the header's checkbox.
    select_all: Option<SelectAll>,
    thumbs: Entity<Thumbs>,
    root_name: SharedString,
    /// The columns shown, as the list's width allows, and the name's width.
    cols: Vec<Col>,
    name_width: f32,
    /// The column the files are sorted by and whether largest first; none for the catalog's own
    /// order, by path.
    sorted: Option<(Col, bool)>,
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
            first_page_due: false,
            generation: 0,
            selected: BTreeSet::new(),
            anchor: None,
            pending: None,
            keep_selection: false,
            gap: None,
            taken: Vec::new(),
            next_taken: 0,
            cursor_file: None,
            lost: None,
            in_flight: HashSet::new(),
            renaming: None,
            select_all: None,
            thumbs: thumbs.clone(),
            root_name: SharedString::default(),
            cols: columns_for(f32::INFINITY).0,
            name_width: NAME_WIDTH,
            sorted: None,
            columns: Vec::new(),
            tasks: Vec::new(),
        }
        .with_columns()
    }

    fn with_columns(mut self) -> Self {
        self.rebuild_columns();
        self
    }

    /// The table's columns from what is shown and how it is sorted: the arrow on the column
    /// sorted by, the others ready to sort.
    fn rebuild_columns(&mut self) {
        self.columns = self
            .cols
            .iter()
            .map(|col| {
                let sort = col.sort().map(|_| match self.sorted {
                    Some((sorted, true)) if sorted == *col => ColumnSort::Descending,
                    Some((sorted, false)) if sorted == *col => ColumnSort::Ascending,
                    _ => ColumnSort::Default,
                });
                col.column(self.name_width, sort)
            })
            .collect();
    }

    /// Lays the columns out for a list `width` wide; true when they changed, and the table has
    /// to read them again.
    fn fit(&mut self, width: f32) -> bool {
        let (cols, name_width) = columns_for(width);
        if cols == self.cols && (name_width - self.name_width).abs() < 1. {
            return false;
        }
        self.cols = cols;
        self.name_width = name_width;
        self.rebuild_columns();
        true
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
        self.in_flight.clear();
        self.tasks.clear();
        self.first_page_due = true;
        self.request(0, cx);
    }

    /// Reads the same results again from the first page.
    fn read_again(&mut self, cx: &mut Context<TableState<Self>>) {
        if let (Some(engine), Some(query)) = (self.engine.clone(), self.query.clone()) {
            self.reset(engine, query, cx);
        }
    }

    fn request(&mut self, page: usize, cx: &mut Context<TableState<Self>>) {
        let (Some(engine), Some(query)) = (self.engine.clone(), self.query.clone()) else {
            return;
        };
        if (page != 0 && self.first_page_due) || !self.requested.insert(page) {
            return;
        }
        self.in_flight.insert(page);
        let generation = self.generation;
        let query = FileQuery {
            offset: (page * PAGE) as u32,
            limit: PAGE as u32,
            ..query
        };
        let answer = engine.list_files(query);
        let in_flight = crate::loaded::InFlight::start();
        self.tasks.push(cx.spawn(async move |table, cx| {
            let _in_flight = in_flight;
            let answer = answer.await;
            table
                .update(cx, |table, cx| {
                    let rows = table.delegate_mut();
                    if rows.generation != generation {
                        return;
                    }
                    rows.in_flight.remove(&page);
                    if page == 0 {
                        rows.first_page_due = false;
                    }
                    match answer {
                        Ok(result) => {
                            if page == 0 {
                                // A fresh first page replaces the rest, read again as they show.
                                rows.pages.clear();
                                rows.requested.retain(|requested| *requested == 0);
                                rows.taken.retain(|taken| {
                                    taken.ended.is_none_or(|ended| generation <= ended)
                                });
                            }
                            rows.total = Some(result.total.max(0) as usize);
                            rows.total_bytes = result.total_bytes;
                            rows.pages.insert(page, result.rows);
                            // The table asks for rows only when the range it shows changes, and
                            // what it shows has just gone.
                            if page == 0 {
                                let visible = table.visible_range().rows().clone();
                                table.delegate_mut().request_rows(visible, cx);
                            }
                            Self::settle_cursor(table, cx);
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

    fn request_rows(&mut self, rows: Range<usize>, cx: &mut Context<TableState<Self>>) {
        if rows.is_empty() {
            return;
        }
        for page in rows.start / PAGE..=(rows.end - 1) / PAGE {
            self.request(page, cx);
        }
    }

    fn set_selected(&mut self, selected: BTreeSet<FileId>, cx: &mut Context<TableState<Self>>) {
        self.selected = selected;
        cx.notify();
    }

    fn is_taken(&self, id: FileId) -> bool {
        self.taken.iter().any(|taken| taken.files.contains(&id))
    }

    /// The gap the cursor at `index` leaves when the command takes `leaving`.
    fn gap_at(&self, index: usize, leaving: &BTreeSet<FileId>) -> Gap {
        Gap {
            index,
            before: self.beside((0..index).rev(), leaving),
            after: self.beside(index..self.total.unwrap_or(0), leaving),
            step: None,
        }
    }

    /// The first file along `places` that is neither among `leaving` nor taken.
    fn beside(
        &self,
        mut places: impl Iterator<Item = usize>,
        leaving: &BTreeSet<FileId>,
    ) -> Beside {
        places
            .find_map(|place| match self.row(place) {
                None => Some(Beside::NotRead),
                Some(row) if leaving.contains(&row.id) || self.is_taken(row.id) => None,
                Some(row) => Some(Beside::File(row.id)),
            })
            .unwrap_or(Beside::End)
    }

    /// Where the file `id` is in the rows read so far.
    fn index_of(&self, id: FileId) -> Option<usize> {
        self.pages.iter().find_map(|(page, rows)| {
            let at = rows.iter().position(|row| row.id == id)?;
            Some(page * PAGE + at)
        })
    }

    /// Where the gap is among the rows read: after the file before it, or at the file after it.
    /// Neither found where the cursor was, once that row is read, they have gone, and the gap is
    /// taken to be where the cursor was; until then, it is not known.
    fn gap_place(&self, gap: &Gap) -> Option<usize> {
        let total = self.total.unwrap_or(0);
        let found = |side: Beside| match side {
            Beside::File(id) => self.index_of(id),
            _ => None,
        };
        if let Beside::End = gap.before {
            return Some(0);
        }
        found(gap.before)
            .map(|index| index + 1)
            .or_else(|| found(gap.after))
            .or_else(|| matches!(gap.after, Beside::End).then_some(total))
            .or_else(|| {
                let index = gap.index.min(total.saturating_sub(1));
                self.row(index).is_some().then_some(gap.index.min(total))
            })
    }

    /// The first file not taken from `place` on, or back from before it.
    fn walk(&self, place: usize, forward: bool) -> Step {
        let total = self.total.unwrap_or(0);
        let mut at = if forward { place } else { place.min(total) };
        loop {
            if forward && at >= total || !forward && at == 0 {
                return Step::Nowhere;
            }
            if !forward {
                at -= 1;
            }
            match self.row(at) {
                None => return Step::Read(at),
                Some(row) if !self.is_taken(row.id) => return Step::To(at, row.id),
                Some(_) => {}
            }
            if forward {
                at += 1;
            }
        }
    }

    /// Where an arrow goes from the gap: the first file that way, else the first the other way
    /// where the list ends.
    fn step(&self, gap: &Gap, forward: bool) -> Step {
        let Some(place) = self.gap_place(gap) else {
            return Step::Read(gap.index);
        };
        match self.walk(place, forward) {
            Step::Nowhere => self.walk(place, !forward),
            step => step,
        }
    }

    /// An arrow at the gap, or while the cursor is hidden: the row it goes to, with that file
    /// selected for the move to pick up, or `Some(None)` when it waits for a row to be read or has
    /// nowhere to go. `None` when the arrow is the table's.
    fn step_from_gap(
        &mut self,
        forward: bool,
        cx: &mut Context<TableState<Self>>,
    ) -> Option<Option<usize>> {
        if self.lost.is_some() {
            return Some(None);
        }
        let step = self.step(self.gap.as_ref()?, forward);
        Some(self.take_step(step, forward, cx))
    }

    fn take_step(
        &mut self,
        step: Step,
        forward: bool,
        cx: &mut Context<TableState<Self>>,
    ) -> Option<usize> {
        let gap = self.gap.as_mut()?;
        match step {
            Step::To(index, id) => {
                self.anchor = Some(index);
                self.pending = Some(BTreeSet::from([id]));
                Some(index)
            }
            Step::Read(at) => {
                gap.step = Some(forward);
                self.request(at / PAGE, cx);
                None
            }
            Step::Nowhere => {
                gap.step = None;
                None
            }
        }
    }

    /// Once rows have come: an arrow waiting at the gap goes on, and the cursor stays with its
    /// file, or is hidden while that file is not where it shows.
    fn settle_cursor(table: &mut TableState<Self>, cx: &mut Context<TableState<Self>>) {
        let rows = table.delegate_mut();
        if let Some((gap, forward)) = rows.gap.as_ref().and_then(|gap| Some((gap, gap.step?))) {
            let step = rows.step(gap, forward);
            if let Some(index) = rows.take_step(step, forward, cx) {
                table.set_selected_row(index, cx);
            }
            return;
        }
        if let Some((id, near)) = rows.lost {
            match rows.index_of(id) {
                Some(index) => {
                    rows.lost = None;
                    rows.anchor = Some(index);
                    rows.pending = Some(rows.selected.clone());
                    table.set_selected_row(index, cx);
                }
                // Not about where it was: it stays hidden.
                None if rows.row(near).is_some() => rows.lost = None,
                None => rows.request(near / PAGE, cx),
            }
            return;
        }
        let Some(cursor) = table.selected_row() else {
            return;
        };
        let rows = table.delegate_mut();
        match rows.cursor_file {
            Some(id) => match rows.index_of(id) {
                Some(index) if index == cursor => {}
                Some(index) => {
                    rows.anchor = Some(index);
                    rows.pending = Some(rows.selected.clone());
                    table.set_selected_row(index, cx);
                }
                None if rows.row(cursor).is_some() => {
                    rows.lost = Some((id, cursor));
                    rows.keep_selection = true;
                    table.clear_selection(cx);
                }
                None => {}
            },
            None => {
                let file = rows.row(cursor).map(|row| row.id);
                if let Some(id) = file
                    && rows.selected.is_empty()
                {
                    rows.cursor_file = Some(id);
                    rows.set_selected(BTreeSet::from([id]), cx);
                }
            }
        }
    }

    /// A command that took files has ended: the list reads itself again, and then no longer
    /// shows them.
    fn command_ended(&mut self, key: u64, cx: &mut Context<TableState<Self>>) {
        let generation = self.generation;
        if let Some(taken) = self.taken.iter_mut().find(|taken| taken.key == key) {
            taken.ended = Some(generation);
        }
        self.read_again(cx);
    }

    /// Whether every row asked for has come, and the cursor has found its place.
    pub fn settled(&self) -> bool {
        !self.first_page_due
            && self.in_flight.is_empty()
            && self.lost.is_none()
            && self.gap.as_ref().is_none_or(|gap| gap.step.is_none())
    }

    /// The files from `from` to `to`, both included, added to `base`.
    fn range(&self, from: usize, to: usize, base: &BTreeSet<FileId>) -> BTreeSet<FileId> {
        let mut next = base.clone();
        next.extend((from.min(to)..=from.max(to)).filter_map(|index| Some(self.row(index)?.id)));
        next
    }

    /// Checks or unchecks the file at `index`, which ⇧ then extends from.
    fn toggle(&mut self, index: usize, on: bool, cx: &mut Context<TableState<Self>>) {
        let Some(id) = self.row(index).map(|row| row.id) else {
            return;
        };
        let mut next = self.selected.clone();
        if on {
            next.insert(id);
        } else {
            next.remove(&id);
        }
        self.anchor = Some(index);
        self.set_selected(next, cx);
    }

    /// What a click on the file at `index` selects, with the keys held: ⇧ extends from the
    /// anchor (⇧⌘ keeps the rest too), ⌘ toggles, a plain click selects it alone.
    fn clicked(&mut self, index: usize, modifiers: Modifiers) -> BTreeSet<FileId> {
        if modifiers.shift
            && let Some(anchor) = self.anchor
        {
            let base = if is_command(&modifiers) {
                self.selected.clone()
            } else {
                BTreeSet::new()
            };
            return self.range(anchor, index, &base);
        }
        self.anchor = Some(index);
        let Some(id) = self.row(index).map(|row| row.id) else {
            return BTreeSet::new();
        };
        if is_command(&modifiers) {
            let mut next = self.selected.clone();
            if !next.remove(&id) {
                next.insert(id);
            }
            return next;
        }
        BTreeSet::from([id])
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
                    .child(match self.rename_field(row.id) {
                        // Return renames, Esc or clicking away keeps the name (`RenameField`).
                        Some(input) => Input::new(&input)
                            .row_size()
                            .aria_label(format!("New name for {}", row.name))
                            .into_any_element(),
                        None => div()
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
                            })
                            .into_any_element(),
                    })
                    .child(div().truncate().text_xs().text_color(muted).child(folder)),
            )
            .into_any_element()
    }
}

impl CatalogRows {
    /// The rename field, while `id` is being renamed.
    fn rename_field(&self, id: FileId) -> Option<Entity<InputState>> {
        self.renaming
            .as_ref()
            .filter(|(renamed, _)| *renamed == id)
            .map(|(_, input)| input.clone())
    }
}

impl TableDelegate for CatalogRows {
    fn columns_count(&self, _: &App) -> usize {
        self.columns.len()
    }

    /// A row takes ⌘- and ⇧-clicks, which the table leaves alone (`select_on_modifier_click`):
    /// they toggle and extend the selection and move the cursor there.
    fn render_tr(
        &mut self,
        row_ix: usize,
        _: &mut Window,
        cx: &mut Context<TableState<Self>>,
    ) -> Stateful<gpui_kit::Div> {
        div().id(("library-row", row_ix)).on_click(cx.listener(
            move |table, event: &ClickEvent, _, cx| {
                let modifiers = event.modifiers();
                if !(is_command(&modifiers) || modifiers.shift) {
                    return;
                }
                let rows = table.delegate_mut();
                let next = rows.clicked(row_ix, modifiers);
                rows.pending = Some(next);
                table.set_selected_row(row_ix, cx);
            },
        ))
    }

    /// The select column's header checks every matching file (`Select every matching file`).
    fn render_th(
        &mut self,
        col_ix: usize,
        _: &mut Window,
        cx: &mut Context<TableState<Self>>,
    ) -> impl IntoElement {
        if self.cols[col_ix] != Col::Select {
            return div()
                .size_full()
                .child(self.columns[col_ix].name.clone())
                .into_any_element();
        }
        let total = self.total.unwrap_or(0);
        let all = total > 0 && self.selected.len() >= total;
        let select_all = self.select_all.clone();
        let table = cx.entity().downgrade();
        checkbox_target(Checkbox::new("library-select-all"))
            .checked(all)
            .accessibility_label("Select every matching file")
            .tooltip("Select every matching file  ⌘A")
            .on_click(move |checked, window, cx| {
                if *checked {
                    if let Some(select_all) = &select_all {
                        select_all(window, cx);
                    }
                } else {
                    table
                        .update(cx, |table, cx| {
                            table.delegate_mut().set_selected(BTreeSet::new(), cx);
                        })
                        .ok();
                }
            })
            .into_any_element()
    }

    fn rows_count(&self, _: &App) -> usize {
        self.total.unwrap_or(0)
    }

    fn column(&self, col_ix: usize, _: &App) -> Column {
        self.columns[col_ix].clone()
    }

    /// A click on a header, as Electron Oriel's headers sort: the column sorted by turns around,
    /// another starts largest, newest or longest first for the size, the date and the length,
    /// and from A for the rest. The table's own cycle, which comes back to no order, is set
    /// aside: its arrows are drawn again from the delegate's.
    fn perform_sort(
        &mut self,
        col_ix: usize,
        _: ColumnSort,
        window: &mut Window,
        cx: &mut Context<TableState<Self>>,
    ) {
        let Some(col) = self.cols.get(col_ix).copied() else {
            return;
        };
        let (Some(engine), Some(mut query), Some(column)) =
            (self.engine.clone(), self.query.clone(), col.sort())
        else {
            return;
        };
        let descending = match self.sorted {
            Some((sorted, descending)) if sorted == col => !descending,
            _ => col.descending_first(),
        };
        self.sorted = Some((col, descending));
        (query.sort, query.descending) = (column, descending);
        self.rebuild_columns();
        // A new order: the cursor's place in the old one means nothing, as for a new query, and
        // the selection stays.
        self.gap = None;
        self.lost = None;
        cx.defer_in(window, |table, _, cx| {
            table.refresh(cx);
            if table.selected_row().is_some() {
                table.delegate_mut().keep_selection = true;
                table.clear_selection(cx);
            }
        });
        self.reset(engine, query, cx);
    }

    fn visible_rows_changed(
        &mut self,
        visible: Range<usize>,
        _: &mut Window,
        cx: &mut Context<TableState<Self>>,
    ) {
        self.request_rows(visible, cx);
    }

    fn render_td(
        &mut self,
        row_ix: usize,
        col_ix: usize,
        _: &mut Window,
        cx: &mut Context<TableState<Self>>,
    ) -> impl IntoElement {
        let col = self.cols[col_ix];
        // Each cell sits in the middle of its 44 px row, as the Electron list's grid centres
        // them, the size and the date against the right edge.
        let cell = div()
            .size_full()
            .flex()
            .flex_row()
            .items_center()
            .min_w_0()
            .when(matches!(col, Col::Size | Col::Modified), |this| {
                this.justify_end()
            });
        let Some(row) = self.row(row_ix).cloned() else {
            // Not read yet: a quiet placeholder, as the Electron list draws one.
            return cell.child(
                div()
                    .h(px(10.))
                    .w(px(if col == Col::Name { 160. } else { 40. }))
                    .rounded_full()
                    .bg(cx.theme().muted),
            );
        };
        let theme = cx.theme();
        let content = match col {
            Col::Select => {
                let id = row.id;
                let checked = self.selected.contains(&id);
                let table = cx.entity().downgrade();
                checkbox_target(Checkbox::new(("library-select", id as u64)))
                    .checked(checked)
                    .accessibility_label(SharedString::from(format!("Select {}", row.name)))
                    .on_click(move |checked, _, cx| {
                        let checked = *checked;
                        table
                            .update(cx, |table, cx| {
                                table.delegate_mut().toggle(row_ix, checked, cx);
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
                    let why = SharedString::from(format!(
                        "The file is {} but its extension is .{}",
                        format::format_label(row.format),
                        row.ext
                    ));
                    this.child(
                        div()
                            .id(("wrong-extension", row.id as u64))
                            .truncate()
                            .text_color(theme.warning)
                            .tooltip(move |window, cx| {
                                gpui_kit::component::tooltip::Tooltip::new(why.clone())
                                    .build(window, cx)
                            })
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
        };
        cell.child(content)
    }

    fn cell_label(&self, row_ix: usize, col_ix: usize, _: &App) -> Option<SharedString> {
        let row = self.row(row_ix)?;
        Some(match self.cols[col_ix] {
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
    mode: LibraryMode,
    /// The file being renamed in place: its id, its name before, and what watches its field.
    renaming: Option<(FileId, String, Subscription)>,
    /// The files the menu on screen acts on, and the one file it is about, if any.
    menu: Option<(Vec<FileId>, Option<FileRow>)>,
    /// The list's width when last drawn, which its columns fit.
    list_width: f32,
    /// The grid's width when last drawn, and the columns it had.
    grid_width: f32,
    grid_columns: usize,
    grid_scroll: UniformListScrollHandle,
    /// What the page last read for: the root, the catalog's version and the last preset.
    seen: (Option<RootId>, u64, u64),
    /// The selection bar where it was last drawn, and where a press on the files under it does
    /// nothing for a moment after one on the bar.
    bar_bounds: Rc<Cell<Bounds<Pixels>>>,
    guard: widgets::PressGuard,
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
        let mut rows = CatalogRows::new(thumbs);
        let page = cx.entity().downgrade();
        rows.select_all = Some(Rc::new(move |window, cx| {
            page.update(cx, |page, cx| page.select_all(window, cx)).ok();
        }));
        let table = cx.new(|cx| {
            TableState::new(rows, window, cx)
                .row_selectable(true)
                .row_header(false)
                .col_movable(false)
                .col_resizable(false)
                .col_selectable(false)
                // ⌘- and ⇧-clicks belong to the selection, not to the cursor.
                .select_on_modifier_click(false)
        });
        let search =
            cx.new(|cx| InputState::new(window, cx).placeholder("Search names and folders"));
        let folder_search = cx.new(|cx| InputState::new(window, cx).placeholder("Find a folder"));
        let inspector = match LocalStorage::get(cx, INSPECTOR_KEY) {
            Some(stored) => stored == "open",
            None => window.bounds().size.width >= px(1440.),
        };
        let mode = match LocalStorage::get(cx, MODE_KEY) {
            Some("grid") => LibraryMode::Grid,
            _ => LibraryMode::List,
        };
        let subscriptions = vec![
            cx.observe(state, |this, _, cx| this.sync(cx)),
            cx.observe(thumbs, |this, _, cx| {
                this.table.update(cx, |_, cx| cx.notify());
            }),
            cx.observe(&table, |this, _, cx| this.targets_changed(cx)),
            cx.subscribe_in(&table, window, |this, _, event: &TableEvent, window, cx| {
                this.on_table_event(event, window, cx);
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
            mode,
            renaming: None,
            menu: None,
            list_width: 0.,
            grid_width: 0.,
            grid_columns: 1,
            grid_scroll: UniformListScrollHandle::new(),
            seen: (None, 0, 0),
            bar_bounds: Rc::default(),
            guard: widgets::PressGuard::default(),
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

    /// Whether the files show as a list or a grid.
    pub fn mode(&self) -> LibraryMode {
        self.mode
    }

    /// Shows the files as a list or a grid, remembered for the next launch.
    pub fn set_mode(&mut self, mode: LibraryMode, cx: &mut Context<Self>) {
        if self.mode != mode {
            self.mode = mode;
            LocalStorage::set(cx, MODE_KEY, mode.key());
            cx.notify();
        }
    }

    /// The file being renamed in place, if any.
    pub fn renaming(&self) -> Option<FileId> {
        self.renaming.as_ref().map(|(id, _, _)| *id)
    }

    /// The files selected, in id order.
    pub fn selection(&self, cx: &App) -> Vec<FileId> {
        self.selected(cx)
    }

    /// The cursor's position among the matching files.
    pub fn cursor(&self, cx: &App) -> Option<usize> {
        self.table.read(cx).selected_row()
    }

    fn on_table_event(&mut self, event: &TableEvent, window: &mut Window, cx: &mut Context<Self>) {
        match event {
            // A click or an arrow moved the cursor: it selects that file alone, unless the move
            // brought a selection of its own (⌘, ⇧).
            TableEvent::SelectRow(index) => {
                let index = *index;
                self.table.update(cx, |table, cx| {
                    let rows = table.delegate_mut();
                    rows.gap = None;
                    rows.lost = None;
                    // Its row not read yet, its file is selected once it is.
                    rows.cursor_file = rows.row(index).map(|row| row.id);
                    let next = match rows.pending.take() {
                        Some(next) => next,
                        None => {
                            rows.anchor = Some(index);
                            rows.cursor_file.into_iter().collect()
                        }
                    };
                    rows.set_selected(next, cx);
                });
            }
            // Esc in the table clears its cursor, and with it the selection.
            TableEvent::ClearSelection => {
                let keep = self.table.update(cx, |table, _| {
                    let rows = table.delegate_mut();
                    rows.cursor_file = None;
                    std::mem::take(&mut rows.keep_selection)
                });
                if !keep {
                    self.clear_selection(cx);
                }
            }
            TableEvent::DoubleClickedRow(index) => self.open_file(*index, cx),
            TableEvent::RightClickedRow(Some(index)) => self.context_menu(*index, window, cx),
            _ => {}
        }
    }

    /// Double-click: the file in its default app.
    fn open_file(&mut self, index: usize, cx: &mut Context<Self>) {
        if let Some(row) = self.table.read(cx).delegate().row(index) {
            cx.open_with_system(Path::new(&row.abs_path));
        }
    }

    /// A click on a tile: the cursor moves there, and the selection as the keys held say.
    fn click_file(
        &mut self,
        index: usize,
        modifiers: Modifiers,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if !self.focus.contains_focused(window, cx) {
            self.focus.focus(window, cx);
        }
        self.table.update(cx, |table, cx| {
            let rows = table.delegate_mut();
            let next = rows.clicked(index, modifiers);
            rows.pending = Some(next);
            table.set_selected_row(index, cx);
        });
    }

    /// A tile's checkbox: the file in or out of the selection, the cursor where it is.
    fn toggle_file(&mut self, index: usize, on: bool, cx: &mut Context<Self>) {
        self.table.update(cx, |table, cx| {
            table.delegate_mut().toggle(index, on, cx);
        });
    }

    /// The arrows: the cursor `delta` files on, the selection with it, or ⇧ extending it from
    /// the anchor (`move`).
    fn move_cursor(&mut self, delta: isize, extend: bool, cx: &mut Context<Self>) {
        let cursor = self.cursor(cx);
        let total = self.total(cx).unwrap_or(0);
        if total == 0 {
            return;
        }
        let from_gap = self.table.update(cx, |table, cx| {
            table.delegate_mut().step_from_gap(delta > 0, cx)
        });
        let next = match from_gap {
            Some(None) => return,
            Some(Some(next)) => next,
            None => cursor.map_or(0, |cursor| {
                (cursor as isize + delta).clamp(0, total as isize - 1) as usize
            }),
        };
        self.table.update(cx, |table, cx| {
            if extend {
                let rows = table.delegate_mut();
                let anchor = *rows.anchor.get_or_insert(cursor.unwrap_or(next));
                rows.pending = Some(rows.range(anchor, next, &BTreeSet::new()));
            }
            table.set_selected_row(next, cx);
        });
        if self.mode == LibraryMode::Grid {
            self.reveal_in_grid(next);
        }
    }

    /// An arrow the table would take from its first row, having no cursor: it goes on from the
    /// gap a command left instead, or waits while the cursor is hidden.
    fn arrow_from_gap(&mut self, forward: bool, window: &mut Window, cx: &mut Context<Self>) {
        let focus = self.table.read(cx).focus_handle(cx);
        if !focus.contains_focused(window, cx) {
            return;
        }
        let step = self.table.update(cx, |table, cx| {
            let step = table.delegate_mut().step_from_gap(forward, cx);
            if let Some(Some(index)) = step {
                table.set_selected_row(index, cx);
            }
            step
        });
        if step.is_some() {
            cx.stop_propagation();
        }
    }

    /// A right-click on a file: the cursor moves there, and a file outside the selection is
    /// selected alone, before the menu asks what the files hold (`contextMenu`).
    fn context_menu(&mut self, index: usize, window: &mut Window, cx: &mut Context<Self>) {
        let Some(row) = self.table.read(cx).delegate().row(index).cloned() else {
            return;
        };
        self.table.update(cx, |table, cx| {
            let rows = table.delegate_mut();
            if !rows.selected.contains(&row.id) {
                rows.anchor = Some(index);
                rows.pending = Some(BTreeSet::from([row.id]));
            } else {
                rows.pending = Some(rows.selected.clone());
            }
            table.set_selected_row(index, cx);
        });
        self.run_menu(Some(row), window, cx);
    }

    /// The menu for a right-clicked file, or for the targets from the bar's "⋯": a file outside
    /// the selection acts alone, so its summary is asked for here rather than read from state
    /// that has not caught up yet (`runMenu`).
    fn run_menu(&mut self, row: Option<FileRow>, window: &mut Window, cx: &mut Context<Self>) {
        let selected = self.selected(cx);
        let files = match &row {
            Some(row) if !selected.contains(&row.id) => vec![row.id],
            _ => self.targets(cx),
        };
        let target = row.or_else(|| (files.len() == 1).then(|| self.single(cx)).flatten());
        let Some(engine) = self.state.read(cx).engine().cloned() else {
            return;
        };
        if files.is_empty() {
            return;
        }
        let position = window.mouse_position();
        let summary = crate::loaded::engine_call(
            engine.selection_summary(files.iter().copied().take(MAX_BULK_FILES).collect()),
            cx,
        );
        // Which codecs the menu offers; the engine asks ffmpeg the first time only.
        let capabilities = crate::loaded::engine_call(engine.capabilities(), cx);
        cx.spawn_in(window, async move |this, cx| {
            let held = summary.await.ok();
            let capabilities = capabilities.await.ok();
            this.update_in(cx, |this, window, cx| {
                let entries = menu::menu_entries(
                    &files,
                    target.as_ref(),
                    held.as_ref(),
                    capabilities.as_ref(),
                );
                this.menu = Some((files, target));
                // The menu's choice comes back as an action, through the focused element.
                if !this.focus.contains_focused(window, cx) {
                    this.focus.focus(window, cx);
                }
                menu::record(&entries);
                menu::native_menu(&entries).show(position, window, cx);
            })
            .ok();
        })
        .detach();
    }

    /// What the menu's choice does, to the files it was shown for.
    pub fn choose(&mut self, choice: MenuChoice, window: &mut Window, cx: &mut Context<Self>) {
        let Some((files, target)) = self.menu.take() else {
            return;
        };
        let path = target.as_ref().map(|row| row.abs_path.clone());
        match choice {
            MenuChoice::QuickLook => {
                if let Some(path) = path {
                    quick_look(Path::new(&path), window, cx);
                }
            }
            MenuChoice::Open => {
                if let Some(path) = path {
                    cx.open_with_system(Path::new(&path));
                }
            }
            MenuChoice::OpenInView => {
                if let Some(path) = path {
                    self.open_in_view(path, cx);
                }
            }
            MenuChoice::Reveal => {
                if let Some(path) = path {
                    cx.reveal_path(Path::new(&path));
                }
            }
            MenuChoice::Convert => self.convert(files, window, cx),
            MenuChoice::Reencode(codec) => {
                let quality = self
                    .state
                    .read(cx)
                    .settings()
                    .map_or(VideoQuality::High, |settings| settings.reencode_quality);
                self.perform(
                    PlanRequest::Reencode {
                        file_ids: files,
                        codec,
                        quality,
                    },
                    window,
                    cx,
                );
            }
            MenuChoice::StripAudio => {
                self.perform(PlanRequest::StripAudio { file_ids: files }, window, cx);
            }
            MenuChoice::FixExtension => {
                self.perform(PlanRequest::FixExtension { file_ids: files }, window, cx);
            }
            MenuChoice::Rename => {
                if let Some(row) = target {
                    self.start_rename(row, window, cx);
                }
            }
            MenuChoice::Prefer => {
                if let Some(row) = target {
                    crate::settings::prefer_folder(&self.state, row.dir, window, cx);
                }
            }
            MenuChoice::ShowFolder => {
                if let Some(row) = target {
                    let filters = Filters {
                        dir: Some(row.dir),
                        ..self.filters.clone()
                    };
                    self.set_filters(filters, cx);
                }
            }
            MenuChoice::Move => self.move_to(files, window, cx),
            MenuChoice::Hold => self.hold(files, window, cx),
        }
    }

    /// Return, or the menu's Rename: the name becomes a field, its stem selected
    /// (`RenameField`).
    fn start_rename(&mut self, row: FileRow, window: &mut Window, cx: &mut Context<Self>) {
        let input = cx.new(|cx| {
            let mut input = InputState::new(window, cx);
            input.set_value(row.name.clone(), window, cx);
            let stem = row.name.rfind('.').filter(|dot| *dot > 0);
            input.set_selected_range(0..stem.unwrap_or(row.name.len()), cx);
            input
        });
        let subscription =
            cx.subscribe_in(
                &input,
                window,
                |this, input, event, window, cx| match event {
                    InputEvent::PressEnter { .. } => {
                        let name = input.read(cx).value().to_string();
                        this.finish_rename(Some(name), window, cx);
                    }
                    InputEvent::Blur => this.finish_rename(None, window, cx),
                    _ => {}
                },
            );
        let focus = input.focus_handle(cx);
        self.table.update(cx, |table, cx| {
            table.delegate_mut().renaming = Some((row.id, input));
            cx.notify();
        });
        self.renaming = Some((row.id, row.name, subscription));
        window.focus(&focus, cx);
        cx.notify();
    }

    /// Ends the rename: a new name, trimmed, renames the file; none keeps it as it was.
    fn finish_rename(&mut self, name: Option<String>, window: &mut Window, cx: &mut Context<Self>) {
        let Some((id, before, _)) = self.renaming.take() else {
            return;
        };
        self.table.update(cx, |table, cx| {
            table.delegate_mut().renaming = None;
            cx.notify();
        });
        self.focus.focus(window, cx);
        let name = name.map(|name| name.trim().to_string());
        if let Some(name) = name.filter(|name| !name.is_empty() && *name != before) {
            self.state.update(cx, |state, cx| {
                let request = PlanRequest::Rename {
                    renames: vec![Rename { file_id: id, name }],
                };
                state.perform(request, PerformOptions::default(), window, cx);
            });
        }
        cx.notify();
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
        if !visible {
            self.table
                .update(cx, |table, _| table.delegate_mut().gap = None);
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
        let current = self.table.read(cx).delegate().query.clone();
        let query_changed = current.as_ref().is_some_and(|query| query.filter != filter);
        let query = {
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
            // The cursor points into one query's results; a new query starts without one, and
            // keeps the selection.
            if query_changed {
                let rows = table.delegate_mut();
                rows.gap = None;
                rows.lost = None;
            }
            if query_changed && table.selected_row().is_some() {
                table.delegate_mut().keep_selection = true;
                table.clear_selection(cx);
            }
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

    /// Esc, or the bar's Clear: nothing is selected, and the cursor stays where it is.
    fn clear_selection(&mut self, cx: &mut Context<Self>) {
        self.table.update(cx, |table, cx| {
            table.delegate_mut().set_selected(BTreeSet::new(), cx);
        });
    }

    /// A command has the files at hand. Nothing is chosen, and nothing is a target until the
    /// owner chooses: the cursor goes too, or the file it comes to rest on would be, and a list
    /// reading itself again would change which. With `taken`, the command takes the files from
    /// their places, and the arrows pass them by until the list no longer shows them.
    fn leave_gap(&mut self, taken: Option<u64>, cx: &mut Context<Self>) {
        let leaving: BTreeSet<FileId> = self.targets(cx).into_iter().collect();
        self.table.update(cx, |table, cx| {
            let cursor = table.selected_row();
            let rows = table.delegate_mut();
            rows.anchor = None;
            rows.lost = None;
            rows.set_selected(BTreeSet::new(), cx);
            if let Some(key) = taken {
                rows.taken.push(Taken {
                    key,
                    files: leaving.clone(),
                    ended: None,
                });
            }
            if let Some(index) = cursor.or(rows.gap.as_ref().map(|gap| gap.index)) {
                rows.gap = Some(rows.gap_at(index, &leaving));
            }
            if cursor.is_some() {
                rows.keep_selection = true;
                table.clear_selection(cx);
            }
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
                    Toast::error("Couldn't select every file").detail(format!("{error:#}")),
                    cx,
                ),
            })
            .ok();
        })
        .detach();
    }

    /// Runs a command on the files it was shown. Whatever takes their place is not chosen by that.
    fn perform(&mut self, request: PlanRequest, window: &mut Window, cx: &mut Context<Self>) {
        // These take the files from their places; the others leave them where they are.
        let takes = matches!(
            request,
            PlanRequest::Hold { .. } | PlanRequest::Move { .. } | PlanRequest::Optimize { .. }
        );
        let key = takes.then(|| {
            self.table.update(cx, |table, _| {
                let rows = table.delegate_mut();
                rows.next_taken += 1;
                rows.next_taken
            })
        });
        let mut options = PerformOptions::default();
        if let Some(key) = key {
            let table = self.table.downgrade();
            let ended: OnUndone = Rc::new(move |_, cx| {
                table
                    .update(cx, |table, cx| table.delegate_mut().command_ended(key, cx))
                    .ok();
            });
            options.on_failed = Some(ended.clone());
            options.on_done = Some(Rc::new(move |_, window, cx| ended(window, cx)));
        }
        self.state.update(cx, |state, cx| {
            state.perform(request, options, window, cx);
        });
        self.leave_gap(key, cx);
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

    // What the pages spike (`crate::page_spike`) does in place of the owner's clicks and keys.

    /// Sorts by the column `key` names, as a click on its header does.
    pub(crate) fn spike_sort(&mut self, key: &str, window: &mut Window, cx: &mut Context<Self>) {
        self.table.update(cx, |table, cx| {
            let rows = table.delegate_mut();
            if let Some(index) = rows.columns.iter().position(|column| column.key == key) {
                rows.perform_sort(index, ColumnSort::Default, window, cx);
            }
            table.refresh(cx);
        });
    }

    /// Types `text` into the search field where the cursor is, as a key press does.
    pub(crate) fn spike_type(&mut self, text: &str, window: &mut Window, cx: &mut Context<Self>) {
        let text = text.to_owned();
        self.search
            .update(cx, |search, cx| search.insert(text, window, cx));
    }

    /// Empties the search field, as ⌘A and Delete do.
    pub(crate) fn spike_clear_search(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.search
            .update(cx, |search, cx| search.set_value("", window, cx));
        self.search_changed(cx);
    }

    /// Sets the filters, as the filter menu and its chips do.
    pub(crate) fn spike_filters(&mut self, filters: Filters, cx: &mut Context<Self>) {
        self.set_filters(filters, cx);
    }

    /// Puts the cursor on the first file and opens or closes the Inspector.
    pub(crate) fn spike_inspector(&mut self, open: bool, cx: &mut Context<Self>) {
        if open {
            self.table
                .update(cx, |table, cx| table.set_selected_row(0, cx));
        }
        if self.inspector != open {
            self.toggle_inspector(cx);
        }
    }

    /// Whether the Inspector's reads of the files at hand have landed.
    pub(crate) fn spike_targets_read(&self) -> bool {
        self.summary.data().is_some() && self.sample.data().is_some()
    }

    /// The scroll handle of the list or the grid, whichever shows.
    pub(crate) fn spike_scroll_handle(&self, cx: &App) -> gpui_kit::ScrollHandle {
        match self.mode {
            LibraryMode::List => self
                .table
                .read(cx)
                .vertical_scroll_handle
                .0
                .borrow()
                .base_handle
                .clone(),
            LibraryMode::Grid => self.grid_scroll.0.borrow().base_handle.clone(),
        }
    }

    fn on_key_down(&mut self, event: &KeyDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        // It is the open menu's, or nothing's; the page must not act on it behind the menu.
        if oriel_ui::popups::popup_open(window, cx) {
            return;
        }
        let keys = &event.keystroke;
        let modifiers = keys.modifiers;
        // While a name is being edited, its field has the keys.
        if self.renaming.is_some() {
            return;
        }
        // Keys typed into a field belong to the field.
        if window.has_focused_input(cx) {
            return;
        }
        let selected = self.selected(cx);
        let command = is_command(&modifiers);
        // Ctrl is not the command key on macOS, but it still is not the plain key.
        let command_or_ctrl = modifiers.platform || modifiers.control;
        let grid = self.mode == LibraryMode::Grid;
        match keys.key.as_str() {
            "/" if !command_or_ctrl => self.search.focus_handle(cx).focus(window, cx),
            "i" if !modifiers.modified() => self.toggle_inspector(cx),
            "backspace" if command && !selected.is_empty() => self.hold(selected, window, cx),
            "m" if command && modifiers.shift && !selected.is_empty() => {
                self.move_to(selected, window, cx);
            }
            "r" if command && modifiers.shift => {
                if let Some(row) = self.single(cx) {
                    cx.reveal_path(Path::new(&row.abs_path));
                }
            }
            _ if command_or_ctrl || modifiers.alt => return,
            // The table moves its own cursor while it has the keys; ⇧ and the grid come here.
            "down" | "up" => {
                let step = if grid { self.grid_columns.max(1) } else { 1 } as isize;
                let delta = if keys.key == "down" { step } else { -step };
                self.move_cursor(delta, modifiers.shift, cx);
            }
            "right" | "left" if grid => {
                let delta = if keys.key == "right" { 1 } else { -1 };
                self.move_cursor(delta, modifiers.shift, cx);
            }
            // Space looks closer, as in Finder.
            "space" => {
                if let Some(row) = self.cursor_row(cx) {
                    quick_look(Path::new(&row.abs_path), window, cx);
                }
            }
            "enter" if !modifiers.shift => {
                if let Some(row) = self.cursor_row(cx)
                    && selected.len() <= 1
                {
                    self.start_rename(row, window, cx);
                }
            }
            "escape" if !selected.is_empty() => self.clear_selection(cx),
            _ => return,
        }
        cx.stop_propagation();
    }

    /// The list, its columns fitted to the width it was last drawn at.
    fn render_list(&mut self, cx: &mut Context<Self>) -> AnyElement {
        let width = self.list_width;
        if width > 0. {
            self.table.update(cx, |table, cx| {
                if table.delegate_mut().fit(width) {
                    table.refresh(cx);
                }
            });
        }
        let page = cx.entity().downgrade();
        div()
            .relative()
            .flex()
            .flex_col()
            .flex_1()
            .min_h_0()
            .size_full()
            .child(
                canvas(
                    move |bounds, _, cx| {
                        let width = f32::from(bounds.size.width);
                        page.update(cx, |page, cx| {
                            if (page.list_width - width).abs() >= 0.5 {
                                page.list_width = width;
                                cx.notify();
                            }
                        })
                        .ok();
                    },
                    |_, _, _, _| {},
                )
                .absolute()
                .size_full(),
            )
            // 44 px rows, as Electron Oriel's list has them, for the name over its folder.
            .child(
                DataTable::new(&self.table)
                    .stripe(false)
                    .bordered(false)
                    .with_size(px(44.))
                    .header_row_height(px(32.)),
            )
            .into_any_element()
    }

    /// List or grid (`Show as`).
    fn render_mode_switch(&self, cx: &mut Context<Self>) -> AnyElement {
        let theme = cx.theme();
        let item = |id: &'static str, icon: IconName, label: &'static str, mode: LibraryMode| {
            // The bar's type and icon in 28 px, on a track as high as the bar's other controls.
            Button::new(id)
                .ghost()
                .bar_size()
                .size(px(28.))
                .icon(Icon::new(icon))
                .accessibility_label(label)
                .tooltip(label)
                .toggled(self.mode == mode)
                .on_click(cx.listener(move |this, _, _, cx| this.set_mode(mode, cx)))
        };
        div()
            .id("library-mode")
            .test_support()
            .role(gpui_kit::Role::Group)
            .aria_label("Show as")
            .flex()
            .flex_row()
            .items_center()
            .gap(px(2.))
            .p(px(2.))
            .rounded(theme.radius)
            .bg(theme.tab_bar)
            .child(item(
                "library-mode-list",
                IconName::List,
                "List",
                LibraryMode::List,
            ))
            .child(item(
                "library-mode-grid",
                IconName::LayoutGrid,
                "Grid",
                LibraryMode::Grid,
            ))
            .into_any_element()
    }

    /// The bar's "⋯": the menu of what applies to the files at hand.
    fn more_button(&self, cx: &mut Context<Self>) -> Button {
        Button::new("library-more")
            .bar_size()
            .ghost()
            .icon(Icon::new(IconName::Ellipsis))
            .accessibility_label("More actions")
            .tooltip("More actions")
            .on_click(cx.listener(|this, _, window, cx| this.run_menu(None, window, cx)))
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
                .h(MENU_ROW_HEIGHT)
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
                    .bar_size()
                    .outline()
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
                        this.child(div().px_1().pb_1().child(Input::new(&self.folder_search)))
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
                        .h(px(30.))
                        .pl_2()
                        .pr(px(2.))
                        .rounded_full()
                        .bg(theme.muted)
                        .text_xs()
                        .child(div().max_w(px(280.)).truncate().child(label.clone()))
                        .child(
                            // The smallest target in the house scale, inside the chip.
                            Button::new(SharedString::from(id))
                                .ghost()
                                .row_size()
                                .rounded_full()
                                .icon(Icon::new(IconName::Close))
                                .accessibility_label(SharedString::from(format!("Remove {label}")))
                                .on_click(cx.listener(move |this, _, _, cx| {
                                    this.set_filters(next.clone(), cx);
                                })),
                        )
                }))
                .child(
                    Button::new("chips-clear")
                        .row_size()
                        .ghost()
                        .label("Clear")
                        .on_click(cx.listener(|this, _, _, cx| {
                            this.set_filters(Filters::default(), cx);
                        })),
                )
                .into_any_element(),
        )
    }

    fn render_selection_bar(&self, cx: &mut Context<Self>) -> AnyElement {
        let more = self.more_button(cx);
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
                    // A press here is the bar's alone, and the bar may go with it: the second press
                    // of a double-click must not reach the file under where it was. The wheel
                    // still scrolls the files.
                    .block_mouse_except_scroll()
                    .capture_any_mouse_up(cx.listener(|this, _, _, _| {
                        this.guard.arm(this.bar_bounds.get());
                    }))
                    .relative()
                    .child(widgets::measure(&self.bar_bounds))
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
                                    .bar_size()
                                    .primary()
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
                            .bar_size()
                            .outline()
                            .label("Move to holding")
                            .tooltip("Move to holding  ⌘⌫")
                            .on_click(cx.listener(move |this, _, window, cx| {
                                this.hold(hold_ids.clone(), window, cx);
                            })),
                    )
                    .child(
                        Button::new("selection-move")
                            .bar_size()
                            .outline()
                            .label("Move to…")
                            .tooltip("⇧⌘M")
                            .on_click(cx.listener(move |this, _, window, cx| {
                                this.move_to(move_ids.clone(), window, cx);
                            })),
                    )
                    .child(more)
                    .child(
                        Button::new("selection-clear")
                            .bar_size()
                            .ghost()
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
                            .bar_size()
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
                                .bar_size()
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
                                .bar_size()
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
                                .bar_size()
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
                                .bar_size()
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
                    .child(Input::new(&self.search).bar_size().cleanable(true)),
            )
            .trailing(filter)
            .trailing(self.render_mode_switch(cx))
            .trailing(
                Button::new("library-inspector-toggle")
                    .bar_size()
                    .ghost()
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
                        .bar_size()
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
            _ if self.mode == LibraryMode::Grid => {
                self.render_grid(if bar_visible { BAR_INSET } else { 0. }, cx)
            }
            _ => self.render_list(cx),
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
            .capture_action(cx.listener(|this, _: &SelectDown, window, cx| {
                this.arrow_from_gap(true, window, cx);
            }))
            .capture_action(cx.listener(|this, _: &SelectUp, window, cx| {
                this.arrow_from_gap(false, window, cx);
            }))
            // Esc with files selected clears them and keeps the cursor, before the table's own
            // Esc takes the cursor too.
            .capture_action(cx.listener(|this, _: &Cancel, _, cx| {
                if this.renaming.is_none() && !this.selected(cx).is_empty() {
                    this.clear_selection(cx);
                    cx.stop_propagation();
                }
            }))
            .on_action(cx.listener(|this, action: &LibraryMenu, window, cx| {
                this.choose(action.0, window, cx);
            }))
            // Esc in the rename field keeps the name, before the field or the table take it.
            .capture_action(cx.listener(|this, _: &InputEscape, window, cx| {
                if this.renaming.is_some() {
                    this.finish_rename(None, window, cx);
                    cx.stop_propagation();
                }
            }))
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
                            .capture_any_mouse_down(cx.listener(
                                |this, event: &MouseDownEvent, _, cx| {
                                    if this.guard.holds(event.position) {
                                        cx.stop_propagation();
                                    }
                                },
                            ))
                            .child(content)
                            .children(selection_bar),
                    )
                    .children(inspector),
            )
    }
}

#[cfg(test)]
mod tests {
    use super::{Col, columns_for};

    #[test]
    fn narrow_lists_drop_modified_then_dimensions() {
        let shown = |width: f32| columns_for(width).0;
        let all = vec![
            Col::Select,
            Col::Name,
            Col::Format,
            Col::Dimensions,
            Col::Size,
            Col::Modified,
        ];
        assert_eq!(shown(900.), all);
        assert_eq!(
            shown(700.),
            [
                Col::Select,
                Col::Name,
                Col::Format,
                Col::Dimensions,
                Col::Size
            ]
        );
        assert_eq!(
            shown(600.),
            [Col::Select, Col::Name, Col::Format, Col::Size]
        );
        // The name takes what the others leave, and never less than it needs to read.
        assert_eq!(columns_for(900.).1, 900. - 500. - 16.);
        assert_eq!(columns_for(300.).1, 200.);
    }
}
