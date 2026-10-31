//! Phase 0's Library: GPUI Kit's data table with synthetic rows, to measure it with 100,000 of
//! them (sort, scroll and select). The real Library reads the catalog ([`crate::library`]); this
//! one shows only when the spike asks for it with `ORIEL_SPIKE_LIBRARY`.

use std::time::{Duration, Instant};

use gpui_kit::component::table::{Column, ColumnSort, DataTable, TableDelegate, TableState};
use gpui_kit::{
    App, AppContext as _, Context, Entity, IntoElement, ParentElement as _, Render, SharedString,
    Styled as _, Window, div,
};
use oriel_core_domain::{NamedPath, compare_by_name, name_ranks};

use crate::spike::LibrarySpike;

/// Rows tied in a column's value from which ranking every row by name is the cheaper way to
/// break their ties, as `name_ranks` itself keys a list from this length.
const RANK_TIES_FROM: usize = 256;

/// A row's place, packed in the low bits of its number in [`LibraryDelegate::order`].
fn place(packed: u128) -> usize {
    (packed & u128::from(u32::MAX)) as usize
}

/// The runs of `order` whose rows tie in the column's value, longer than one.
fn tie_runs(order: &[u128]) -> Vec<std::ops::Range<usize>> {
    let mut runs = Vec::new();
    let mut start = 0;
    for end in 1..=order.len() {
        if end == order.len() || order[end] >> 64 != order[start] >> 64 {
            if end - start > 1 {
                runs.push(start..end);
            }
            start = end;
        }
    }
    runs
}

/// One file, as the Library lists it.
#[derive(Clone, Debug)]
pub struct LibraryRow {
    name: SharedString,
    folder: SharedString,
    path: String,
    kind: FileKind,
    format: &'static str,
    bytes: u64,
    width: u32,
    height: u32,
    duration_ms: Option<u32>,
    modified_ms: i64,
    /// Where the row falls in natural order by name, and by folder, the path breaking ties in
    /// each; set by [`LibraryDelegate::rank`] before the first sort that needs them.
    name_rank: u32,
    folder_rank: u32,
}

impl NamedPath for LibraryRow {
    fn name(&self) -> &str {
        &self.name
    }

    fn path(&self) -> &str {
        &self.path
    }
}

/// A row seen by its folder, so folders sort in the same natural order as names.
struct ByFolder<'a>(&'a LibraryRow);

impl NamedPath for ByFolder<'_> {
    #[expect(
        clippy::misnamed_getters,
        reason = "the folder stands in for the name on purpose"
    )]
    fn name(&self) -> &str {
        &self.0.folder
    }

    fn path(&self) -> &str {
        &self.0.path
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum FileKind {
    Image,
    Video,
    Animation,
}

impl FileKind {
    fn label(self) -> &'static str {
        match self {
            FileKind::Image => "Image",
            FileKind::Video => "Video",
            FileKind::Animation => "Animation",
        }
    }
}

/// The table's columns, in order.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LibraryColumn {
    Name,
    Folder,
    Kind,
    Format,
    Size,
    Dimensions,
    Duration,
    Modified,
}

impl LibraryColumn {
    pub const ALL: [LibraryColumn; 8] = [
        LibraryColumn::Name,
        LibraryColumn::Folder,
        LibraryColumn::Kind,
        LibraryColumn::Format,
        LibraryColumn::Size,
        LibraryColumn::Dimensions,
        LibraryColumn::Duration,
        LibraryColumn::Modified,
    ];

    pub(crate) fn key(self) -> &'static str {
        match self {
            LibraryColumn::Name => "name",
            LibraryColumn::Folder => "folder",
            LibraryColumn::Kind => "kind",
            LibraryColumn::Format => "format",
            LibraryColumn::Size => "size",
            LibraryColumn::Dimensions => "dimensions",
            LibraryColumn::Duration => "duration",
            LibraryColumn::Modified => "modified",
        }
    }

    fn title(self) -> &'static str {
        match self {
            LibraryColumn::Name => "Name",
            LibraryColumn::Folder => "Folder",
            LibraryColumn::Kind => "Kind",
            LibraryColumn::Format => "Format",
            LibraryColumn::Size => "Size",
            LibraryColumn::Dimensions => "Dimensions",
            LibraryColumn::Duration => "Length",
            LibraryColumn::Modified => "Modified",
        }
    }

    fn column(self) -> Column {
        let column = Column::new(self.key(), self.title()).sortable();
        match self {
            LibraryColumn::Name => column.width(280.),
            LibraryColumn::Folder => column.width(200.),
            LibraryColumn::Kind | LibraryColumn::Format => column.width(96.),
            LibraryColumn::Size | LibraryColumn::Duration => column.width(96.).text_right(),
            LibraryColumn::Dimensions => column.width(120.).text_right(),
            LibraryColumn::Modified => column.width(160.).text_right(),
        }
    }

    /// A row's value in this column as one number that orders as the column does ascending:
    /// names and folders by their ranks in the shared natural order, as Electron Oriel's
    /// Library sorts them (the ranks answer as `compare_by_name` does), formats by their place
    /// among `formats`, sorted. Every column but those two breaks its ties by name.
    fn value(self, row: &LibraryRow, formats: &[&str]) -> u64 {
        match self {
            LibraryColumn::Name => u64::from(row.name_rank),
            LibraryColumn::Folder => u64::from(row.folder_rank),
            LibraryColumn::Kind => row.kind as u64,
            LibraryColumn::Format => formats.binary_search(&row.format).unwrap_or(0) as u64,
            LibraryColumn::Size => row.bytes,
            LibraryColumn::Dimensions => u64::from(row.width) * u64::from(row.height),
            // No length before every length.
            LibraryColumn::Duration => row.duration_ms.map_or(0, |ms| u64::from(ms) + 1),
            // Flipping the sign bit orders the times as unsigned numbers.
            LibraryColumn::Modified => (row.modified_ms as u64) ^ (1 << 63),
        }
    }

    /// Whether rows that tie in this column are ordered by name.
    fn ties_by_name(self) -> bool {
        !matches!(self, LibraryColumn::Name | LibraryColumn::Folder)
    }
}

pub struct LibraryDelegate {
    rows: Vec<LibraryRow>,
    columns: Vec<Column>,
    last_sort: Option<Duration>,
    /// Whether the rows' ranks by name and by folder are set.
    ranked: (bool, bool),
}

impl LibraryDelegate {
    pub fn new(rows: Vec<LibraryRow>) -> Self {
        Self {
            rows,
            columns: LibraryColumn::ALL.map(LibraryColumn::column).to_vec(),
            last_sort: None,
            ranked: (false, false),
        }
    }

    /// Ranks the rows in natural order once, by name for the name's column and by folder for
    /// the folder's, so later sorts compare numbers. The other columns break their ties by
    /// name, through the ranks once they are made ([`Self::sort_by`]).
    fn rank(&mut self, column: LibraryColumn) {
        if column == LibraryColumn::Name && !self.ranked.0 {
            let ranks = name_ranks(&self.rows);
            for (row, rank) in self.rows.iter_mut().zip(ranks) {
                row.name_rank = rank;
            }
            self.ranked.0 = true;
        }
        if column == LibraryColumn::Folder && !self.ranked.1 {
            let folders: Vec<ByFolder<'_>> = self.rows.iter().map(ByFolder).collect();
            let ranks = name_ranks(&folders);
            for (row, rank) in self.rows.iter_mut().zip(ranks) {
                row.folder_rank = rank;
            }
            self.ranked.1 = true;
        }
    }

    pub fn rows(&self) -> &[LibraryRow] {
        &self.rows
    }

    /// How long the last sort took, rows only, without drawing.
    pub fn last_sort(&self) -> Option<Duration> {
        self.last_sort
    }

    pub fn sort(&mut self, column: LibraryColumn, sort: ColumnSort) {
        let started = Instant::now();
        match sort {
            ColumnSort::Ascending => self.sort_by(column, false),
            ColumnSort::Descending => self.sort_by(column, true),
            // Back to the catalog's own order: by path, as the scan found them.
            ColumnSort::Default => self.rows.sort_by(|a, b| a.path.cmp(&b.path)),
        }
        self.last_sort = Some(started.elapsed());
    }

    /// Sorts by `column`, as a stable sort by the column's comparison would, either way round:
    /// by the column's value, then by name, rows that still tie keeping their order.
    ///
    /// Each row's value, its rank by name and its place are packed into one number, and the
    /// numbers are sorted rather than the rows, which are then moved once. The ranks are made
    /// only when the sort needs them: for the name's column, or for ties enough that ranking
    /// every row costs less than comparing the tied ones through the collator.
    fn sort_by(&mut self, column: LibraryColumn, descending: bool) {
        self.rank(column);
        let mut formats: Vec<&'static str> = Vec::new();
        if column == LibraryColumn::Format {
            formats = self.rows.iter().map(|row| row.format).collect();
            formats.sort_unstable();
            formats.dedup();
        }
        let by_name = column.ties_by_name();
        let mut order = self.order(column, &formats, by_name && self.ranked.0, descending);
        if by_name && !self.ranked.0 {
            let ties = tie_runs(&order);
            if ties.iter().map(ExactSizeIterator::len).sum::<usize>() >= RANK_TIES_FROM {
                self.rank(LibraryColumn::Name);
                order = self.order(column, &formats, true, descending);
            } else {
                // A stable sort, so rows whose names tie too keep their order.
                let rows = &self.rows;
                for run in ties {
                    order[run].sort_by(|a, b| {
                        let (a, b) = (&rows[place(*a)], &rows[place(*b)]);
                        if descending {
                            compare_by_name(b, a)
                        } else {
                            compare_by_name(a, b)
                        }
                    });
                }
            }
        }
        let mut rows: Vec<Option<LibraryRow>> = std::mem::take(&mut self.rows)
            .into_iter()
            .map(Some)
            .collect();
        self.rows = order
            .into_iter()
            .map(|packed| rows[place(packed)].take().expect("each row moves once"))
            .collect();
    }

    /// Each row as one number, sorted: its value in `column` above its rank by name (with
    /// `ranked`) above its place, each flipped for `descending` but the place, so equal rows
    /// keep their order either way round, as a stable sort keeps them.
    fn order(
        &self,
        column: LibraryColumn,
        formats: &[&str],
        ranked: bool,
        descending: bool,
    ) -> Vec<u128> {
        let mut order: Vec<u128> = self
            .rows
            .iter()
            .enumerate()
            .map(|(index, row)| {
                let (mut value, mut rank) = (
                    column.value(row, formats),
                    if ranked { row.name_rank } else { 0 },
                );
                if descending {
                    (value, rank) = (!value, !rank);
                }
                (u128::from(value) << 64) | (u128::from(rank) << 32) | index as u128
            })
            .collect();
        order.sort_unstable();
        order
    }

    fn text(&self, row_ix: usize, column: LibraryColumn) -> SharedString {
        let Some(row) = self.rows.get(row_ix) else {
            return SharedString::default();
        };
        match column {
            LibraryColumn::Name => row.name.clone(),
            LibraryColumn::Folder => row.folder.clone(),
            LibraryColumn::Kind => row.kind.label().into(),
            LibraryColumn::Format => row.format.into(),
            LibraryColumn::Size => format_bytes(row.bytes).into(),
            LibraryColumn::Dimensions => format!("{} × {}", row.width, row.height).into(),
            LibraryColumn::Duration => row
                .duration_ms
                .map(format_duration)
                .unwrap_or_default()
                .into(),
            LibraryColumn::Modified => format_date(row.modified_ms).into(),
        }
    }
}

impl TableDelegate for LibraryDelegate {
    fn columns_count(&self, _: &App) -> usize {
        self.columns.len()
    }

    fn rows_count(&self, _: &App) -> usize {
        self.rows.len()
    }

    fn column(&self, col_ix: usize, _: &App) -> Column {
        self.columns[col_ix].clone()
    }

    fn perform_sort(
        &mut self,
        col_ix: usize,
        sort: ColumnSort,
        _: &mut Window,
        _: &mut Context<TableState<Self>>,
    ) {
        if let Some(column) = LibraryColumn::ALL.get(col_ix) {
            self.sort(*column, sort);
        }
    }

    fn render_td(
        &mut self,
        row_ix: usize,
        col_ix: usize,
        _: &mut Window,
        _: &mut Context<TableState<Self>>,
    ) -> impl IntoElement {
        div()
            .truncate()
            .child(self.text(row_ix, LibraryColumn::ALL[col_ix]))
    }

    fn cell_label(&self, row_ix: usize, col_ix: usize, _: &App) -> Option<SharedString> {
        Some(self.text(row_ix, LibraryColumn::ALL[col_ix]))
    }
}

/// The spike's Library page.
pub struct SyntheticLibrary {
    table: Entity<TableState<LibraryDelegate>>,
    spike: Option<LibrarySpike>,
}

impl SyntheticLibrary {
    pub fn new(
        rows: Vec<LibraryRow>,
        spike: Option<LibrarySpike>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let table = cx.new(|cx| {
            TableState::new(LibraryDelegate::new(rows), window, cx)
                .row_selectable(true)
                .col_movable(false)
        });
        Self { table, spike }
    }

    pub fn table(&self) -> &Entity<TableState<LibraryDelegate>> {
        &self.table
    }
}

impl Render for SyntheticLibrary {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        if let Some(mut spike) = self.spike.take() {
            spike.on_frame(self, window, cx);
            self.spike = Some(spike);
        }
        div()
            .flex_1()
            .min_h_0()
            .size_full()
            .child(DataTable::new(&self.table).stripe(false).bordered(false))
    }
}

/// `count` synthetic rows, the same every time: names that natural order cares about
/// (`IMG_9` before `IMG_10`), a few thousand folders, the archive's formats in rough proportion.
pub fn synthetic_rows(count: usize) -> Vec<LibraryRow> {
    let mut seed: u64 = 0x5eed_0063;
    let mut next = move || {
        // xorshift64*: deterministic, and enough for spreading values.
        seed ^= seed >> 12;
        seed ^= seed << 25;
        seed ^= seed >> 27;
        seed.wrapping_mul(0x2545_f491_4f6c_dd1d)
    };
    let prefixes = ["IMG_", "DSC", "Screenshot ", "clip-", "scan ", "PXL_"];
    (0..count)
        .map(|index| {
            let roll = next();
            let (kind, format, extension) = match roll % 20 {
                0..=8 => (FileKind::Image, "AVIF", "avif"),
                9..=14 => (FileKind::Image, "JPEG", "jpg"),
                15 => (FileKind::Image, "PNG", "png"),
                16 => (FileKind::Animation, "GIF", "gif"),
                17 | 18 => (FileKind::Video, "MP4", "mp4"),
                _ => (FileKind::Video, "MKV", "mkv"),
            };
            let folder: SharedString = format!(
                "Archive {}/Roll {}",
                (roll >> 8) % 40 + 1,
                (roll >> 16) % 100 + 1
            )
            .into();
            let prefix = prefixes[((roll >> 24) % prefixes.len() as u64) as usize];
            let name: SharedString = format!("{prefix}{index}.{extension}").into();
            let path = format!("{folder}/{name}");
            let landscape = (roll >> 32) % 3 != 0;
            let (long, short) = (
                1600 + ((roll >> 34) % 2400) as u32,
                900 + ((roll >> 40) % 1800) as u32,
            );
            let (width, height) = if landscape {
                (long, short)
            } else {
                (short, long)
            };
            LibraryRow {
                name,
                folder,
                path,
                kind,
                format,
                bytes: 40_000 + next() % 400_000_000,
                width,
                height,
                duration_ms: (kind != FileKind::Image).then(|| 1_000 + (next() % 3_600_000) as u32),
                modified_ms: 1_262_304_000_000 + (next() % 504_576_000_000) as i64,
                name_rank: 0,
                folder_rank: 0,
            }
        })
        .collect()
}

fn format_bytes(bytes: u64) -> String {
    const UNITS: [&str; 4] = ["KB", "MB", "GB", "TB"];
    let mut value = bytes as f64 / 1000.;
    let mut unit = 0;
    while value >= 1000. && unit < UNITS.len() - 1 {
        value /= 1000.;
        unit += 1;
    }
    if value < 10. {
        format!("{value:.1} {}", UNITS[unit])
    } else {
        format!("{value:.0} {}", UNITS[unit])
    }
}

fn format_duration(ms: u32) -> String {
    let seconds = ms / 1000;
    let (hours, minutes, seconds) = (seconds / 3600, seconds / 60 % 60, seconds % 60);
    if hours > 0 {
        format!("{hours}:{minutes:02}:{seconds:02}")
    } else {
        format!("{minutes}:{seconds:02}")
    }
}

/// A date as year, month and day, from milliseconds since 1970 (UTC; the spike has no time
/// zone).
fn format_date(ms: i64) -> String {
    let days = ms.div_euclid(86_400_000);
    // Howard Hinnant's days-to-civil.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!("{year}-{month:02}-{day:02}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sorts_names_in_natural_order_and_back() {
        let mut delegate = LibraryDelegate::new(synthetic_rows(2_000));
        delegate.sort(LibraryColumn::Name, ColumnSort::Ascending);
        // Every name is a prefix, the row's number and an extension; within one prefix the
        // numbers must rise by value, so `IMG_9` comes before `IMG_10`.
        let numbers: Vec<u64> = delegate
            .rows()
            .iter()
            .filter_map(|row| row.name.strip_prefix("IMG_"))
            .map(|rest| rest.split('.').next().unwrap().parse().unwrap())
            .collect();
        assert!(numbers.len() > 100);
        assert!(
            numbers.windows(2).all(|pair| pair[0] < pair[1]),
            "{numbers:?}"
        );

        let first = delegate.rows()[0].path.clone();
        delegate.sort(LibraryColumn::Name, ColumnSort::Descending);
        assert_eq!(delegate.rows().last().unwrap().path, first);
    }

    #[test]
    fn formats_cells_as_the_library_does() {
        assert_eq!(format_bytes(1_500), "1.5 KB");
        assert_eq!(format_bytes(250_000_000), "250 MB");
        assert_eq!(format_duration(65_000), "1:05");
        assert_eq!(format_duration(3_725_000), "1:02:05");
        assert_eq!(format_date(0), "1970-01-01");
        assert_eq!(format_date(1_700_000_000_000), "2023-11-14");
    }
}
