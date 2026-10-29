//! Files in the catalog: what a walk records, and the Library's queries, from glazier-core's
//! `catalog/files.ts`.

use std::collections::BTreeSet;

use oriel_core_domain::{
    IMAGE_EXTENSIONS, MediaType, PDF_EXTENSIONS, VIDEO_EXTENSIONS, detect_media_type,
};
use rusqlite::types::Value;
use rusqlite::{Connection, ToSql};

use super::rows::{AUDIO_STATE_SQL, FILE_COLUMNS, FILES_FROM, FileRecord};
use super::transaction;
use crate::collation::numeric_order;
use crate::contract::{
    AudioState, Count, FacetCount, FileFacets, FileFilter, FileFlag, FileFormat, FileId,
    FileIdList, FileKind, FilePage, FileQuery, FileSortColumn, MAX_BULK_FILES, MAX_PAGE_ROWS,
    RootId, SelectionSummary,
};
use crate::scan::WalkedFile;

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

/// Columns derived from a file's bytes, and the value each returns to when the bytes change.
/// The walk's upsert resets them all whenever size, mtime or ctime moved, so nothing stale (a
/// hash, a probe, a fingerprint) outlives the content it describes.
const DERIVED_COLUMN_RESETS: [(&str, &str); 22] = [
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

/// Records a batch of walked files in one transaction, keeping what is known about each file
/// whose bytes did not change.
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
                    // glazier-core binds JavaScript numbers, which SQLite stores as REAL here.
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

/// The records of these files, in slices of 500 as glazier-core asks for them; missing ids are
/// left out.
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

/// Extensions some Latch Works app shows, as a SQL list; everything else is unsupported.
pub fn supported_extensions_sql() -> String {
    IMAGE_EXTENSIONS
        .iter()
        .chain(VIDEO_EXTENSIONS.iter())
        .chain(PDF_EXTENSIONS.iter())
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

/// What each Library flag matches, as a condition on `files f`.
pub fn flag_sql(flag: FileFlag) -> String {
    match flag {
        FileFlag::ExtensionMismatch => "f.ext_mismatch = 1".to_owned(),
        FileFlag::Undecodable => "f.probe_error IS NOT NULL".to_owned(),
        FileFlag::ZeroByte => "f.size = 0 AND f.is_junk = 0".to_owned(),
        FileFlag::Junk => "f.is_junk = 1".to_owned(),
        FileFlag::Animated => "COALESCE(f.frames, 1) > 1".to_owned(),
        FileFlag::Duplicate => "f.sha256 IN (SELECT sha256 FROM files WHERE sha256 IS NOT NULL
    GROUP BY sha256 HAVING COUNT(*) > 1)"
            .to_owned(),
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
fn js_trim(text: &str) -> &str {
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
            "({AUDIO_STATE_SQL}) IN ({})",
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

/// True when answering the filter needs the convertible files recorded first.
pub fn filter_needs_convertible(filter: &FileFilter) -> bool {
    filter.flags.contains(&FileFlag::Convertible)
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
        &format!("({AUDIO_STATE_SQL})"),
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
      SUM(f.ext_mismatch = 1) AS mismatches
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
    folders.sort_by(|left, right| numeric_order(left, right));
    Ok(folders)
}

/// Records a root's convertible files for Library queries on this connection to filter by.
pub fn record_convertible(
    connection: &mut Connection,
    root_id: RootId,
    file_ids: &[FileId],
) -> anyhow::Result<()> {
    transaction(connection, |transaction| {
        transaction.execute(
            "DELETE FROM temp.convertible_files WHERE root_id = ?1",
            [root_id],
        )?;
        let mut insert = transaction.prepare_cached(
            "INSERT OR IGNORE INTO temp.convertible_files (id, root_id) VALUES (?1, ?2)",
        )?;
        for &id in file_ids {
            insert.execute([id, root_id])?;
        }
        Ok(())
    })
}

/// Forgets every recorded convertible file, when the catalog changed under them.
pub fn forget_convertible(connection: &Connection) -> anyhow::Result<()> {
    connection.execute("DELETE FROM temp.convertible_files", [])?;
    Ok(())
}
