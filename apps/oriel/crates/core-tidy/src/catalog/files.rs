//! Files in the catalog: what a walk records, what the passes learn about a file, what a change
//! does to a file's row, and the Library's queries.

use std::collections::BTreeSet;

use oriel_core_domain::{MediaType, detect_media_type, shown_extensions};
use rusqlite::types::Value;
use rusqlite::{Connection, OptionalExtension as _, ToSql, params};

use super::details::forget_details_of;
use super::rows::{FILE_COLUMNS, FILES_FROM, FileRecord, audio_state_sql};
use super::transaction;
use crate::contract::{
    AudioState, Count, FacetCount, FileFacets, FileFilter, FileFlag, FileFormat, FileId,
    FileIdList, FileKind, FilePage, FileQuery, FileSortColumn, MAX_BULK_FILES, MAX_PAGE_ROWS,
    OptimizeCategory, RootId, SelectionSummary,
};
use crate::passes::probe::PROBE_VERSION;
use crate::scan::WalkedFile;
use crate::scan::{dir_of, extension_of, is_extension_mismatch, name_of};
use oriel_core_domain::collation::Collation;

/// Named statement parameters, bound as `$name`, built up as a query is.
#[derive(Clone, Debug, Default)]
pub struct SqlParams(Vec<(String, Value)>);

impl SqlParams {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn set(&mut self, name: &str, value: impl Into<Value>) {
        let name = format!("${name}");
        match self.0.iter_mut().find(|(existing, _)| *existing == name) {
            Some(slot) => slot.1 = value.into(),
            None => self.0.push((name, value.into())),
        }
    }

    pub fn with(mut self, name: &str, value: impl Into<Value>) -> Self {
        self.set(name, value);
        self
    }

    /// The parameters as rusqlite binds named ones.
    pub fn named(&self) -> Vec<(&str, &dyn ToSql)> {
        self.0
            .iter()
            .map(|(name, value)| (name.as_str(), value as &dyn ToSql))
            .collect()
    }
}

/// Columns derived from a file's bytes, and the value each returns to when the bytes change: the
/// walk's upsert resets them all whenever size, mtime or ctime moved, a conversion's result
/// starts from them, and an undone conversion's original returns to them, so nothing stale (a
/// hash, a probe, a fingerprint) outlives the content it describes.
const DERIVED_COLUMN_RESETS: [(&str, &str); 23] = [
    ("format", "NULL"),
    ("ext_mismatch", "0"),
    ("probe_version", "0"),
    ("probe_error", "NULL"),
    ("width", "NULL"),
    ("height", "NULL"),
    ("frames", "NULL"),
    ("has_alpha", "NULL"),
    ("duration_ms", "NULL"),
    ("video_codec", "NULL"),
    ("audio_codec", "NULL"),
    ("audio_streams", "NULL"),
    ("bitrate", "NULL"),
    ("head_hash", "NULL"),
    ("sha256", "NULL"),
    ("fingerprint_version", "0"),
    ("fingerprint", "NULL"),
    ("fingerprint_error", "NULL"),
    ("loudness_version", "0"),
    ("loudness_max_db", "NULL"),
    ("optimize_not_smaller", "0"),
    ("shrink_not_smaller", "0"),
    ("reencoded", "0"),
];

const CHANGED: &str = "(files.size != excluded.size
  OR CAST(files.mtime_ms AS INTEGER) != CAST(excluded.mtime_ms AS INTEGER)
  OR CAST(files.ctime_ms AS INTEGER) != CAST(excluded.ctime_ms AS INTEGER))";

fn upsert_walked_sql() -> String {
    let resets: Vec<String> = DERIVED_COLUMN_RESETS
        .iter()
        .map(|(column, reset)| {
            format!("{column} = CASE WHEN {CHANGED} THEN {reset} ELSE files.{column} END")
        })
        .collect();
    format!(
        "INSERT INTO files
  (root_id, rel_path, dir, name, ext, size, mtime_ms, ctime_ms, dev, ino, is_junk, last_seen_scan, kind)
  VALUES ($root_id, $rel_path, $dir, $name, $ext, $size, $mtime_ms, $ctime_ms, $dev, $ino, $is_junk,
    $scan, $kind)
  ON CONFLICT (root_id, rel_path) DO UPDATE SET
    dir = excluded.dir,
    name = excluded.name,
    ext = excluded.ext,
    dev = excluded.dev,
    ino = excluded.ino,
    is_junk = excluded.is_junk,
    last_seen_scan = excluded.last_seen_scan,
    {},
    kind = CASE WHEN {CHANGED} OR files.format IS NULL THEN excluded.kind ELSE files.kind END,
    size = excluded.size,
    mtime_ms = excluded.mtime_ms,
    ctime_ms = excluded.ctime_ms",
        resets.join(",\n    ")
    )
}

/// What a file is before its bytes are read: its extension's media type, or junk.
pub fn initial_kind(name: &str, junk: bool) -> FileKind {
    if junk {
        return FileKind::Junk;
    }
    match detect_media_type(name) {
        MediaType::Image | MediaType::Gif => FileKind::Image,
        MediaType::Video => FileKind::Video,
        MediaType::Pdf => FileKind::Pdf,
        MediaType::Unknown => FileKind::Other,
    }
}

/// `column = reset` for every derived column but those in `except`.
fn derived_resets(except: &[&str]) -> String {
    DERIVED_COLUMN_RESETS
        .iter()
        .filter(|(column, _)| !except.contains(column))
        .map(|(column, reset)| format!("{column} = {reset}"))
        .collect::<Vec<_>>()
        .join(", ")
}

/// Records a batch of walked files in one transaction, keeping what is known about each file
/// whose bytes did not change. The prints of files whose bytes did are dropped with the rest;
/// the scan moves the prints' generation once its walk ends.
pub fn upsert_walked_files(
    connection: &mut Connection,
    root_id: RootId,
    scan_id: i64,
    files: &[WalkedFile],
) -> anyhow::Result<()> {
    let sql = upsert_walked_sql();
    transaction(connection, |transaction| {
        let mut statement = transaction.prepare_cached(&sql)?;
        for file in files {
            statement.execute(
                &*SqlParams::new()
                    .with("root_id", root_id)
                    .with("rel_path", file.rel_path.clone())
                    .with("dir", file.dir.clone())
                    .with("name", file.name.clone())
                    .with("ext", file.ext.clone())
                    .with("size", file.size)
                    // Stored as REAL, as Electron Oriel's catalogs hold them.
                    .with("mtime_ms", file.mtime_ms as f64)
                    .with("ctime_ms", file.ctime_ms as f64)
                    .with("dev", file.dev.clone())
                    .with("ino", file.ino.clone())
                    .with("is_junk", i64::from(file.junk))
                    .with("scan", scan_id)
                    .with(
                        "kind",
                        initial_kind(&file.name, file.junk).as_str().to_owned(),
                    )
                    .named(),
            )?;
        }
        Ok(())
    })
}

/// Drops files the latest walk of a root did not see: they were deleted or moved outside Tidy.
pub fn delete_unseen_files(
    connection: &Connection,
    root_id: RootId,
    scan_id: i64,
) -> anyhow::Result<usize> {
    Ok(connection.execute(
        "DELETE FROM files WHERE root_id = ?1 AND last_seen_scan != ?2",
        [root_id, scan_id],
    )?)
}

pub fn replace_empty_folders(
    connection: &mut Connection,
    root_id: RootId,
    folders: &[String],
) -> anyhow::Result<()> {
    transaction(connection, |transaction| {
        transaction.execute("DELETE FROM empty_folders WHERE root_id = ?1", [root_id])?;
        let mut insert = transaction
            .prepare_cached("INSERT INTO empty_folders (root_id, rel_path) VALUES (?1, ?2)")?;
        for folder in folders {
            insert.execute(rusqlite::params![root_id, folder])?;
        }
        Ok(())
    })
}

/// Runs a file query and reads each row as a [`FileRecord`].
pub fn query_records(
    connection: &Connection,
    sql: &str,
    params: &SqlParams,
) -> anyhow::Result<Vec<FileRecord>> {
    let mut statement = connection.prepare_cached(sql)?;
    let rows = statement.query_map(&*params.named(), FileRecord::from_row)?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

/// The records of these files, asked for in slices of 500; missing ids are left out.
pub fn get_file_records(
    connection: &Connection,
    file_ids: &[FileId],
) -> anyhow::Result<Vec<FileRecord>> {
    let mut records = Vec::with_capacity(file_ids.len());
    for slice in file_ids.chunks(500) {
        let mut params = SqlParams::new();
        let names: Vec<String> = slice
            .iter()
            .enumerate()
            .map(|(index, &id)| {
                params.set(&format!("id{index}"), id);
                format!("$id{index}")
            })
            .collect();
        records.extend(query_records(
            connection,
            &format!(
                "SELECT {FILE_COLUMNS} FROM {FILES_FROM} WHERE f.id IN ({})",
                names.join(", ")
            ),
            &params,
        )?);
    }
    Ok(records)
}

/// The extensions a Latch Works app shows, as a SQL list; everything else is unsupported.
pub fn supported_extensions_sql() -> String {
    shown_extensions()
        .map(|extension| format!("'{extension}'"))
        .collect::<Vec<_>>()
        .join(", ")
}

fn sort_sql(column: FileSortColumn) -> &'static str {
    match column {
        FileSortColumn::Name => "f.name COLLATE NOCASE",
        FileSortColumn::Path => "f.rel_path COLLATE NOCASE",
        FileSortColumn::Size => "f.size",
        FileSortColumn::Mtime => "f.mtime_ms",
        FileSortColumn::Kind => "f.kind, f.format",
        FileSortColumn::Duration => "f.duration_ms",
    }
}

/// Hashes held by more than one file on disk (hard links to one file count once), leaving out
/// junk and empty files: the identical copies Duplicates offers. A subquery over `files`
/// yielding `sha256`, within the root `root_sql` names, or across every root.
pub fn exact_copies_sql(root_sql: Option<&str>) -> String {
    let root = root_sql.map_or_else(String::new, |root| format!("AND root_id = {root}"));
    format!(
        "SELECT sha256 FROM files
    WHERE sha256 IS NOT NULL AND is_junk = 0 AND size > 0 {root}
    GROUP BY sha256
    HAVING COUNT(DISTINCT dev || ':' || ino) > 1"
    )
}

/// What each Library flag matches, as a condition on `files f`. Overview's findings of the same
/// names count by the same conditions.
pub fn flag_sql(flag: FileFlag) -> String {
    match flag {
        FileFlag::ExtensionMismatch => "f.ext_mismatch = 1".to_owned(),
        FileFlag::Undecodable => "f.probe_error IS NOT NULL".to_owned(),
        FileFlag::ZeroByte => "f.size = 0 AND f.is_junk = 0".to_owned(),
        FileFlag::Junk => "f.is_junk = 1".to_owned(),
        FileFlag::Animated => "COALESCE(f.frames, 1) > 1".to_owned(),
        // The files Duplicates' identical copies are made of.
        FileFlag::Duplicate => format!(
            "f.is_junk = 0 AND f.size > 0 AND f.sha256 IN ({})",
            exact_copies_sql(Some("f.root_id"))
        ),
        FileFlag::Unsupported => format!(
            "f.is_junk = 0 AND f.ext NOT IN ({})",
            supported_extensions_sql()
        ),
        // Filled per root from the engine's Convert candidates; see `record_convertible`.
        FileFlag::Convertible => "f.id IN (SELECT id FROM temp.convertible_files)".to_owned(),
    }
}

/// Escapes a term for `LIKE … ESCAPE '\'`.
fn escape_like(term: &str) -> String {
    let mut escaped = String::with_capacity(term.len());
    for character in term.chars() {
        if matches!(character, '\\' | '%' | '_') {
            escaped.push('\\');
        }
        escaped.push(character);
    }
    escaped
}

fn in_list(params: &mut SqlParams, prefix: &str, values: &[&str]) -> String {
    values
        .iter()
        .enumerate()
        .map(|(index, value)| {
            params.set(&format!("{prefix}{index}"), (*value).to_owned());
            format!("${prefix}{index}")
        })
        .collect::<Vec<_>>()
        .join(", ")
}

/// `String.prototype.trim`'s white space, which the search ignores at either end.
pub(crate) fn js_trim(text: &str) -> &str {
    text.trim_matches(|character: char| {
        (character.is_whitespace() && character != '\u{85}') || character == '\u{feff}'
    })
}

/// A filter as a WHERE clause over `files f` and the parameters it binds.
fn build_file_filter(filter: &FileFilter) -> (String, SqlParams) {
    let mut clauses = Vec::new();
    let mut params = SqlParams::new();
    if let Some(root_id) = filter.root_id {
        clauses.push("f.root_id = $root".to_owned());
        params.set("root", root_id);
    }
    let search = js_trim(&filter.search);
    if !search.is_empty() {
        clauses.push("f.rel_path LIKE $search ESCAPE '\\'".to_owned());
        params.set("search", format!("%{}%", escape_like(search)));
    }
    if !filter.kinds.is_empty() {
        let kinds: Vec<&str> = filter.kinds.iter().map(|kind| kind.as_str()).collect();
        clauses.push(format!(
            "f.kind IN ({})",
            in_list(&mut params, "kind", &kinds)
        ));
    }
    if !filter.formats.is_empty() {
        let formats: Vec<&str> = filter
            .formats
            .iter()
            .map(|format| format.as_str())
            .collect();
        clauses.push(format!(
            "f.format IN ({})",
            in_list(&mut params, "format", &formats)
        ));
    }
    if !filter.audio_states.is_empty() {
        let states: Vec<&str> = filter
            .audio_states
            .iter()
            .map(|state| state.as_str())
            .collect();
        clauses.push(format!(
            "({}) IN ({})",
            audio_state_sql(),
            in_list(&mut params, "audio", &states)
        ));
    }
    if !filter.flags.is_empty() {
        let flags: Vec<String> = filter
            .flags
            .iter()
            .map(|&flag| format!("({})", flag_sql(flag)))
            .collect();
        clauses.push(format!("({})", flags.join(" OR ")));
    }
    if let Some(dir) = filter.dir.as_deref().filter(|dir| !dir.is_empty()) {
        clauses.push("(f.dir = $dir OR f.dir LIKE $dir_prefix ESCAPE '\\')".to_owned());
        params.set("dir", dir.to_owned());
        params.set("dir_prefix", format!("{}/%", escape_like(dir)));
    }
    let clause = if clauses.is_empty() {
        String::new()
    } else {
        format!("WHERE {}", clauses.join(" AND "))
    };
    (clause, params)
}

/// One page of the Library, and how many files and bytes match in all.
pub fn list_files(connection: &Connection, query: &FileQuery) -> anyhow::Result<FilePage> {
    let (clause, params) = build_file_filter(&query.filter);
    let (total, total_bytes) = connection.query_row(
        &format!("SELECT COUNT(*) AS total, SUM(f.size) AS bytes FROM {FILES_FROM} {clause}"),
        &*params.named(),
        |row| Ok((row.get::<_, i64>(0)?, row.get::<_, Option<i64>>(1)?)),
    )?;
    let direction = if query.descending { "DESC" } else { "ASC" };
    let paged = params
        .clone()
        .with("limit", i64::from(query.limit.clamp(1, MAX_PAGE_ROWS)))
        .with("offset", i64::from(query.offset));
    let rows = query_records(
        connection,
        &format!(
            "SELECT {FILE_COLUMNS} FROM {FILES_FROM} {clause}
      ORDER BY {} {direction}, f.id {direction}
      LIMIT $limit OFFSET $offset",
            sort_sql(query.sort)
        ),
        &paged,
    )?;
    Ok(FilePage {
        total,
        total_bytes: total_bytes.unwrap_or(0),
        rows: rows.iter().map(FileRecord::to_file_row).collect(),
    })
}

/// Every matching file's id in path order, up to [`MAX_BULK_FILES`].
pub fn list_file_ids(connection: &Connection, filter: &FileFilter) -> anyhow::Result<FileIdList> {
    let (clause, params) = build_file_filter(filter);
    let params = params.with("limit", MAX_BULK_FILES as i64 + 1);
    let mut statement = connection.prepare_cached(&format!(
        "SELECT f.id FROM {FILES_FROM} {clause} ORDER BY {}, f.id LIMIT $limit",
        sort_sql(FileSortColumn::Path)
    ))?;
    let mut ids: Vec<FileId> = statement
        .query_map(&*params.named(), |row| row.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    let truncated = ids.len() > MAX_BULK_FILES;
    ids.truncate(MAX_BULK_FILES);
    Ok(FileIdList { ids, truncated })
}

/// Counts and bytes per kind, format, audio state and flag. Each list is counted under every
/// filter but its own, so choosing a value shows what it would add.
pub fn file_facets(connection: &Connection, filter: &FileFilter) -> anyhow::Result<FileFacets> {
    let grouped = |others: &FileFilter, value_sql: &str| -> anyhow::Result<Vec<GroupedRow>> {
        let (clause, params) = build_file_filter(others);
        let mut statement = connection.prepare_cached(&format!(
            "SELECT * FROM (SELECT {value_sql} AS value, COUNT(*) AS files, COALESCE(SUM(f.size), 0) AS bytes
        FROM {FILES_FROM} {clause} GROUP BY value) ORDER BY files DESC, value"
        ))?;
        let rows = statement.query_map(&*params.named(), |row| {
            Ok(GroupedRow {
                value: row.get(0)?,
                files: row.get(1)?,
                bytes: row.get(2)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    };

    let kinds = grouped(
        &FileFilter {
            kinds: Vec::new(),
            ..filter.clone()
        },
        "f.kind",
    )?
    .into_iter()
    .filter_map(|row| {
        let value = FileKind::parse(row.value.as_deref()?)?;
        Some(row.counted(value))
    })
    .collect();

    let formats = grouped(
        &FileFilter {
            formats: Vec::new(),
            ..filter.clone()
        },
        "f.format",
    )?
    .into_iter()
    .filter_map(|row| match row.value.as_deref() {
        None => Some(row.counted(None)),
        Some(text) => FileFormat::parse(text).map(|format| row.counted(Some(format))),
    })
    .collect();

    let audio_states = grouped(
        &FileFilter {
            audio_states: Vec::new(),
            ..filter.clone()
        },
        &format!("({})", audio_state_sql()),
    )?
    .into_iter()
    .filter_map(|row| {
        let value = AudioState::parse(row.value.as_deref()?)?;
        Some(row.counted(value))
    })
    .collect();

    let (clause, params) = build_file_filter(&FileFilter {
        flags: Vec::new(),
        ..filter.clone()
    });
    let sums: Vec<String> = FileFlag::ALL
        .iter()
        .enumerate()
        .map(|(index, &flag)| {
            let condition = flag_sql(flag);
            format!(
                "SUM(CASE WHEN {condition} THEN 1 ELSE 0 END) AS files{index},
      SUM(CASE WHEN {condition} THEN f.size ELSE 0 END) AS bytes{index}"
            )
        })
        .collect();
    let totals: Vec<Option<i64>> = connection.query_row(
        &format!("SELECT {} FROM {FILES_FROM} {clause}", sums.join(", ")),
        &*params.named(),
        |row| {
            (0..FileFlag::ALL.len() * 2)
                .map(|index| row.get(index))
                .collect()
        },
    )?;
    let flags = FileFlag::ALL
        .iter()
        .enumerate()
        .filter_map(|(index, &flag)| {
            let files = totals[index * 2].unwrap_or(0);
            (files > 0).then(|| FacetCount {
                value: flag,
                files,
                bytes: totals[index * 2 + 1].unwrap_or(0),
            })
        })
        .collect();

    Ok(FileFacets {
        kinds,
        formats,
        audio_states,
        flags,
    })
}

struct GroupedRow {
    value: Option<String>,
    files: i64,
    bytes: i64,
}

impl GroupedRow {
    fn counted<T>(&self, value: T) -> FacetCount<T> {
        FacetCount {
            value,
            files: self.files,
            bytes: self.bytes,
        }
    }
}

/// A list of ids as one JSON parameter, for `IN (SELECT value FROM json_each($ids))`.
pub fn ids_param(file_ids: &[FileId]) -> String {
    serde_json::to_string(file_ids).unwrap_or_else(|_| "[]".to_owned())
}

/// The roots the given files belong to.
pub fn roots_of_files(connection: &Connection, file_ids: &[FileId]) -> anyhow::Result<Vec<RootId>> {
    let mut statement = connection.prepare_cached(
        "SELECT DISTINCT root_id FROM files WHERE id IN (SELECT value FROM json_each($ids))",
    )?;
    let params = SqlParams::new().with("ids", ids_param(file_ids));
    let rows = statement.query_map(&*params.named(), |row| row.get(0))?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

/// What a selection holds. Convertible counts need the selection's roots recorded first.
pub fn selection_summary(
    connection: &Connection,
    file_ids: &[FileId],
) -> anyhow::Result<SelectionSummary> {
    let params = SqlParams::new().with("ids", ids_param(file_ids));
    Ok(connection.query_row(
        "SELECT COUNT(*) AS files, SUM(f.size) AS bytes,
      SUM(c.id IS NOT NULL) AS convertible,
      SUM(CASE WHEN c.id IS NOT NULL THEN f.size ELSE 0 END) AS convertible_bytes,
      SUM(f.kind = 'video') AS videos,
      SUM(f.kind = 'video' AND COALESCE(f.audio_streams, 0) > 0) AS with_audio,
      SUM(f.ext_mismatch = 1) AS mismatches,
      CASE WHEN COUNT(DISTINCT c.category) = 1 THEN MIN(c.category) END AS convert_as
      FROM files f LEFT JOIN temp.convertible_files c ON c.id = f.id
      WHERE f.id IN (SELECT value FROM json_each($ids))",
        &*params.named(),
        |row| {
            let number = |index| {
                row.get::<_, Option<i64>>(index)
                    .map(Option::unwrap_or_default)
            };
            Ok(SelectionSummary {
                files: number(0)?,
                bytes: number(1)?,
                convertible: Count {
                    files: number(2)?,
                    bytes: number(3)?,
                },
                videos: number(4)?,
                with_audio: number(5)?,
                extension_mismatches: number(6)?,
                convert_as: row
                    .get::<_, Option<String>>(7)?
                    .as_deref()
                    .and_then(OptimizeCategory::parse),
            })
        },
    )?)
}

/// The folders the last scan found empty, relative to the root, in path order.
pub fn list_empty_folders(connection: &Connection, root_id: RootId) -> anyhow::Result<Vec<String>> {
    let mut statement = connection.prepare_cached(
        "SELECT rel_path FROM empty_folders WHERE root_id = ?1 ORDER BY rel_path COLLATE NOCASE",
    )?;
    let rows = statement.query_map([root_id], |row| row.get(0))?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

/// Every folder that holds a file, and each folder above one, relative to the root, in natural
/// order.
pub fn list_folders(connection: &Connection, root_id: RootId) -> anyhow::Result<Vec<String>> {
    let mut statement = connection.prepare_cached(
        "SELECT DISTINCT dir FROM files WHERE root_id = ?1 ORDER BY dir COLLATE NOCASE",
    )?;
    let dirs: Vec<String> = statement
        .query_map([root_id], |row| row.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    let mut folders = BTreeSet::new();
    for dir in dirs {
        let segments: Vec<&str> = dir
            .split('/')
            .filter(|segment| !segment.is_empty())
            .collect();
        for depth in 1..=segments.len() {
            folders.insert(segments[..depth].join("/"));
        }
    }
    let mut folders: Vec<String> = folders.into_iter().collect();
    folders.sort_by(|left, right| Collation::Numeric.compare(left, right));
    Ok(folders)
}

/// Records a root's convertible files, with what Convert would do to each, for Library queries
/// on this connection to filter by.
pub fn record_convertible(
    connection: &mut Connection,
    root_id: RootId,
    files: &[(FileId, OptimizeCategory)],
) -> anyhow::Result<()> {
    transaction(connection, |transaction| {
        transaction.execute(
            "DELETE FROM temp.convertible_files WHERE root_id = ?1",
            [root_id],
        )?;
        let mut insert = transaction.prepare_cached(
            "INSERT OR IGNORE INTO temp.convertible_files (id, root_id, category)
          VALUES (?1, ?2, ?3)",
        )?;
        for &(id, category) in files {
            insert.execute(params![id, root_id, category.as_str()])?;
        }
        Ok(())
    })
}

/// The file at `rel_path` under a root, as the catalog has it.
pub(crate) fn file_record_at(
    connection: &Connection,
    root_id: RootId,
    rel_path: &str,
) -> anyhow::Result<Option<FileRecord>> {
    Ok(query_records(
        connection,
        &format!(
            "SELECT {FILE_COLUMNS} FROM {FILES_FROM} WHERE f.root_id = $root AND f.rel_path = $rel"
        ),
        &SqlParams::new()
            .with("root", root_id)
            .with("rel", rel_path.to_owned()),
    )?
    .pop())
}

/// Forgets a file that left its root (held, removed, moved outside every root).
pub(crate) fn forget_file(
    connection: &Connection,
    root_id: RootId,
    rel_path: &str,
) -> anyhow::Result<()> {
    connection.execute(
        "DELETE FROM files WHERE root_id = ?1 AND rel_path = ?2",
        params![root_id, rel_path],
    )?;
    Ok(())
}

/// Where a file is on its volume and when it last changed, as a walk records it.
#[derive(Clone, Debug)]
pub(crate) struct FileIdentity {
    pub ctime_ms: i64,
    pub dev: String,
    pub ino: String,
}

/// Points a file's row at its new place after a move or a rename, which leaves its bytes, and so
/// all that was read from them, as they were.
pub(crate) fn relocate_file(
    connection: &Connection,
    (root_id, from): (RootId, &str),
    (new_root, rel_path): (RootId, &str),
    identity: &FileIdentity,
) -> anyhow::Result<()> {
    let name = name_of(rel_path);
    let ext = extension_of(name);
    let format: Option<String> = connection
        .query_row(
            "SELECT format FROM files WHERE root_id = ?1 AND rel_path = ?2",
            params![root_id, from],
            |row| row.get(0),
        )
        .optional()?
        .flatten();
    let mismatch = format
        .as_deref()
        .and_then(FileFormat::parse)
        .is_some_and(|format| is_extension_mismatch(format, &ext));
    connection.execute(
        "UPDATE files SET root_id = ?1, rel_path = ?2, dir = ?3, name = ?4, ext = ?5,
      ctime_ms = ?6, dev = ?7, ino = ?8,
      ext_mismatch = CASE WHEN format IS NULL THEN 0 ELSE ?9 END
      WHERE root_id = ?10 AND rel_path = ?11",
        params![
            new_root,
            rel_path,
            dir_of(rel_path),
            name,
            ext,
            identity.ctime_ms,
            identity.dev,
            identity.ino,
            i64::from(mismatch),
            root_id,
            from
        ],
    )?;
    Ok(())
}

/// What a conversion wrote in place of a file, as its check found it.
#[derive(Clone, Debug)]
pub(crate) struct ConvertedFile {
    pub rel_path: String,
    pub size: i64,
    pub mtime_ms: i64,
    pub identity: FileIdentity,
    pub kind: &'static str,
    pub format: FileFormat,
    pub width: Option<i64>,
    pub height: Option<i64>,
    pub frames: Option<i64>,
    pub duration_ms: Option<f64>,
    pub video_codec: Option<String>,
    pub audio_codec: Option<String>,
    pub audio_streams: Option<i64>,
    pub bitrate: Option<f64>,
    /// Its head hash and SHA-256, when its source was one of a possible set of copies.
    pub hashes: Option<(String, String)>,
    /// The audio track was carried over, so its loudness stands.
    pub keep_loudness: bool,
    /// It was kept for being smaller, so it counts as re-encoded to save space.
    pub reencoded: bool,
}

/// Rewrites a converted file's row, which keeps its id and what the owner said about it: its
/// new place and bytes, the facts just checked, and every other derived column as for new bytes.
/// Other rows of the same inode, which a hard link of the result has just touched, take its
/// change time.
pub(crate) fn replace_converted_file(
    connection: &Connection,
    root_id: RootId,
    from: &str,
    file: &ConvertedFile,
) -> anyhow::Result<()> {
    const WRITTEN: [&str; 13] = [
        "format",
        "probe_version",
        "width",
        "height",
        "frames",
        "duration_ms",
        "video_codec",
        "audio_codec",
        "audio_streams",
        "bitrate",
        "head_hash",
        "sha256",
        "reencoded",
    ];
    let kept_loudness: &[&str] = if file.keep_loudness {
        &["loudness_version", "loudness_max_db"]
    } else {
        &[]
    };
    let except: Vec<&str> = WRITTEN.iter().chain(kept_loudness).copied().collect();
    let name = name_of(&file.rel_path);
    let params = SqlParams::new()
        .with("rel_path", file.rel_path.clone())
        .with("dir", dir_of(&file.rel_path).to_owned())
        .with("name", name.to_owned())
        .with("ext", extension_of(name))
        .with("size", file.size)
        .with("mtime_ms", file.mtime_ms)
        .with("ctime_ms", file.identity.ctime_ms)
        .with("dev", file.identity.dev.clone())
        .with("ino", file.identity.ino.clone())
        .with("kind", file.kind.to_owned())
        .with("format", file.format.as_str().to_owned())
        .with("probe_version", PROBE_VERSION)
        .with("width", file.width)
        .with("height", file.height)
        .with("frames", file.frames)
        .with("duration_ms", file.duration_ms)
        .with("video_codec", file.video_codec.clone())
        .with("audio_codec", file.audio_codec.clone())
        .with("audio_streams", file.audio_streams)
        .with("bitrate", file.bitrate)
        .with(
            "head_hash",
            file.hashes.as_ref().map(|hashes| hashes.0.clone()),
        )
        .with(
            "sha256",
            file.hashes.as_ref().map(|hashes| hashes.1.clone()),
        )
        .with("reencoded", i64::from(file.reencoded))
        .with("root_id", root_id)
        .with("from", from.to_owned());
    connection.execute(
        &format!(
            "UPDATE files SET rel_path = $rel_path, dir = $dir, name = $name, ext = $ext,
          size = $size, mtime_ms = $mtime_ms, ctime_ms = $ctime_ms, dev = $dev, ino = $ino,
          kind = $kind, {}, {}
          WHERE root_id = $root_id AND rel_path = $from",
            derived_resets(&except),
            WRITTEN
                .iter()
                .map(|column| format!("{column} = ${column}"))
                .collect::<Vec<_>>()
                .join(", ")
        ),
        &*params.named(),
    )?;
    connection.execute(
        "UPDATE files SET ctime_ms = ?1 WHERE dev = ?2 AND ino = ?3",
        params![file.identity.ctime_ms, file.identity.dev, file.identity.ino],
    )?;
    Ok(())
}

/// After a conversion's undo, points its row back at the original, so the file keeps its id and
/// what the owner said about it. What was read from the result goes, its prints with it, so the
/// scan an undo asks for reads the original afresh.
pub(crate) fn point_back_at_original(
    connection: &Connection,
    root_id: RootId,
    rel_path: &str,
    original: &str,
) -> anyhow::Result<()> {
    let id: Option<FileId> = connection
        .query_row(
            "SELECT id FROM files WHERE root_id = ?1 AND rel_path = ?2",
            params![root_id, rel_path],
            |row| row.get(0),
        )
        .optional()?;
    let Some(id) = id else {
        return Ok(());
    };
    let name = name_of(original);
    let moved = connection.execute(
        &format!(
            "UPDATE OR IGNORE files SET rel_path = ?1, dir = ?2, name = ?3, ext = ?4, {}
          WHERE id = ?5",
            derived_resets(&[])
        ),
        params![original, dir_of(original), name, extension_of(name), id],
    )?;
    if moved > 0 {
        forget_details_of(connection, id)?;
    }
    Ok(())
}

/// Which plan kind found a file would not get smaller, so it stops offering it until its bytes
/// change: Convert and Shrink each keep their own mark.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum NotSmaller {
    Convert,
    Shrink,
}

pub(crate) fn mark_not_smaller(
    connection: &Connection,
    mark: NotSmaller,
    root_id: RootId,
    rel_path: &str,
) -> anyhow::Result<()> {
    let column = match mark {
        NotSmaller::Convert => "optimize_not_smaller",
        NotSmaller::Shrink => "shrink_not_smaller",
    };
    connection.execute(
        &format!("UPDATE files SET {column} = 1 WHERE root_id = ?1 AND rel_path = ?2"),
        params![root_id, rel_path],
    )?;
    Ok(())
}

/// Records a file's fingerprint, or why there is none, on the row the pass selected while it is
/// unchanged. Says whether it was; the pass moves the fingerprints' generation once it ends.
pub(crate) fn record_fingerprint(
    connection: &Connection,
    file: &SelectedFile,
    version: i64,
    print: Option<String>,
    error: Option<String>,
) -> anyhow::Result<bool> {
    let params = same_row_params(file)
        .with("version", version)
        .with("print", print)
        .with("error", error.as_deref().map(error_text));
    let written = connection.execute(
        &format!(
            "UPDATE files SET fingerprint_version = $version, fingerprint = $print,
      fingerprint_error = $error WHERE {SAME_ROW_SQL}"
        ),
        &*params.named(),
    )?;
    Ok(written > 0)
}

// What the passes learn about a file.

/// A row as a pass selected it; the pass works on it only while the catalog still agrees.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct SelectedFile {
    pub id: FileId,
    pub root_id: RootId,
    pub rel_path: String,
    pub size: i64,
    pub mtime_ms: f64,
}

/// True when the file's row still has the path, size and mtime the pass selected it with. A
/// background pass can resume after a change moved, held or converted the file.
pub(crate) fn still_selected(connection: &Connection, file: &SelectedFile) -> anyhow::Result<bool> {
    let current: Option<(RootId, String, i64, f64)> = connection
        .query_row(
            "SELECT root_id, rel_path, size, mtime_ms FROM files WHERE id = ?1",
            [file.id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .optional()?;
    Ok(current.is_some_and(|(root_id, rel_path, size, mtime_ms)| {
        root_id == file.root_id
            && rel_path == file.rel_path
            && size == file.size
            && mtime_ms == file.mtime_ms
    }))
}

/// The WHERE condition that writes a pass's result only to the row it selected, unchanged.
pub(super) const SAME_ROW_SQL: &str = "id = $id AND root_id = $root_id AND rel_path = $rel_path
  AND size = $size AND mtime_ms = $mtime_ms";

pub(super) fn same_row_params(file: &SelectedFile) -> SqlParams {
    SqlParams::new()
        .with("id", file.id)
        .with("root_id", file.root_id)
        .with("rel_path", file.rel_path.clone())
        .with("size", file.size)
        .with("mtime_ms", file.mtime_ms)
}

/// At most 500 UTF-16 code units, as catalogs from Electron Oriel store them, of an error, cut at a
/// character.
pub(super) fn error_text(message: &str) -> String {
    let mut units = 0;
    let mut end = message.len();
    for (index, character) in message.char_indices() {
        units += character.len_utf16();
        if units > 500 {
            end = index;
            break;
        }
    }
    message[..end].to_owned()
}

/// Records a file's real format, and the kind and extension mismatch that follow from it.
pub(crate) fn record_format(
    connection: &Connection,
    id: FileId,
    format: FileFormat,
    kind: FileKind,
    mismatch: bool,
) -> anyhow::Result<()> {
    connection.execute(
        "UPDATE files SET format = ?1, kind = ?2, ext_mismatch = ?3 WHERE id = ?4",
        params![format.as_str(), kind.as_str(), i64::from(mismatch), id],
    )?;
    Ok(())
}

/// What libvips read of a still or an animation.
pub(crate) struct StillProbe {
    pub width: i64,
    pub height: i64,
    pub frames: i64,
    pub has_alpha: bool,
    pub duration_ms: Option<f64>,
}

pub(crate) fn record_still_probe(
    connection: &Connection,
    id: FileId,
    version: i64,
    probe: &StillProbe,
) -> anyhow::Result<()> {
    connection.execute(
        "UPDATE files SET probe_version = ?1, probe_error = NULL, width = ?2, height = ?3,
      frames = ?4, has_alpha = ?5, duration_ms = ?6 WHERE id = ?7",
        params![
            version,
            probe.width,
            probe.height,
            probe.frames,
            i64::from(probe.has_alpha),
            probe.duration_ms,
            id
        ],
    )?;
    Ok(())
}

/// Records what ffprobe read of a video. One with sound and no picture becomes audio.
pub(crate) fn record_video_probe(
    connection: &Connection,
    id: FileId,
    version: i64,
    probe: &oriel_tools::VideoProbe,
) -> anyhow::Result<()> {
    let params = SqlParams::new()
        .with("version", version)
        .with("width", probe.width)
        .with("height", probe.height)
        .with("duration", probe.duration_ms)
        .with("video", probe.video_codec.clone())
        .with("audio", probe.audio_codec.clone())
        .with("streams", probe.audio_streams)
        .with("bitrate", probe.bitrate)
        .with("id", id);
    connection.execute(
        "UPDATE files SET probe_version = $version, probe_error = NULL, width = $width,
      height = $height, duration_ms = $duration, video_codec = $video, audio_codec = $audio,
      audio_streams = $streams, bitrate = $bitrate,
      kind = CASE WHEN $video IS NULL AND $streams > 0 THEN 'audio' ELSE kind END
      WHERE id = $id",
        &*params.named(),
    )?;
    Ok(())
}

/// Records why a file could not be probed, which the "won't decode" finding lists.
pub(crate) fn record_probe_error(
    connection: &Connection,
    id: FileId,
    version: i64,
    message: &str,
) -> anyhow::Result<()> {
    connection.execute(
        "UPDATE files SET probe_version = ?1, probe_error = ?2 WHERE id = ?3",
        params![version, error_text(message), id],
    )?;
    Ok(())
}

/// Records the hash of a file's two ends, and its whole SHA-256 when reading the ends read it
/// all.
pub(crate) fn record_edge_hash(
    connection: &Connection,
    id: FileId,
    edge: &str,
    sha256: Option<&str>,
) -> anyhow::Result<()> {
    match sha256 {
        Some(sha256) => connection.execute(
            "UPDATE files SET head_hash = ?1, sha256 = ?2 WHERE id = ?3",
            params![edge, sha256, id],
        )?,
        None => connection.execute(
            "UPDATE files SET head_hash = ?1 WHERE id = ?2",
            params![edge, id],
        )?,
    };
    Ok(())
}

pub(crate) fn record_sha256(
    connection: &Connection,
    id: FileId,
    sha256: &str,
) -> anyhow::Result<()> {
    connection.execute(
        "UPDATE files SET sha256 = ?1 WHERE id = ?2",
        params![sha256, id],
    )?;
    Ok(())
}

/// Records a soundtrack's peak level, or that it was tried and has none, on the row the pass
/// selected while it is unchanged.
pub(crate) fn record_loudness(
    connection: &Connection,
    file: &SelectedFile,
    version: i64,
    peak: Option<f64>,
) -> anyhow::Result<()> {
    let params = same_row_params(file)
        .with("version", version)
        .with("peak", peak);
    connection.execute(
        &format!(
            "UPDATE files SET loudness_version = $version, loudness_max_db = $peak
      WHERE {SAME_ROW_SQL}"
        ),
        &*params.named(),
    )?;
    Ok(())
}

/// Forgets an empty folder a change removed.
pub(crate) fn forget_empty_folder(
    connection: &Connection,
    root_id: RootId,
    rel_path: &str,
) -> anyhow::Result<()> {
    connection.execute(
        "DELETE FROM empty_folders WHERE root_id = ?1 AND rel_path = ?2",
        params![root_id, rel_path],
    )?;
    Ok(())
}
