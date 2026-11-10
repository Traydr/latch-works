//! A file's catalog row, how queries select it, and the conditions on it that queries and Rust
//! both test, each written beside its twin.

use std::path::PathBuf;

use rusqlite::Row;

use crate::contract::{AudioState, FileFormat, FileId, FileKind, FileRow, RootId};
use crate::similarity::FINGERPRINT_VERSION;

/// A track whose loudest moment stays under this is silence (digital silence reads −91 dB).
pub const SILENCE_THRESHOLD_DB: f64 = -60.0;

/// [`FileRecord::audio_state`] as SQL over `files f`, for filtering in queries. A track the
/// loudness pass could not measure keeps its version and no level, and stays unmeasured.
pub fn audio_state_sql() -> String {
    format!(
        "CASE
  WHEN f.kind != 'video' OR f.probe_version = 0 THEN NULL
  WHEN COALESCE(f.audio_streams, 0) = 0 THEN 'none'
  WHEN f.loudness_version = 0 OR f.loudness_max_db IS NULL THEN 'unmeasured'
  WHEN f.loudness_max_db <= {SILENCE_THRESHOLD_DB:?} THEN 'silent'
  ELSE 'sound' END"
    )
}

/// Every column a file row query selects, with its root's path, as [`FileRecord::from_row`]
/// reads them by name.
pub const FILE_COLUMNS: &str = "f.id, f.root_id, r.path AS root_path, f.rel_path, f.dir, f.name, \
  f.ext, f.size, f.mtime_ms, f.ctime_ms, f.dev, f.ino, f.is_junk, f.kind, f.format, \
  f.ext_mismatch, f.probe_version, f.probe_error, f.width, f.height, f.frames, f.has_alpha, \
  f.duration_ms, f.video_codec, f.audio_codec, f.audio_streams, f.bitrate, f.sha256, \
  f.fingerprint, f.loudness_version, f.loudness_max_db, f.optimize_not_smaller, \
  f.shrink_not_smaller, f.reencoded, f.fingerprint_version";

pub const FILES_FROM: &str = "files f JOIN roots r ON r.id = f.root_id";

/// The files the similarity pass can fingerprint, as SQL over `files f`.
pub const FINGERPRINTABLE_SQL: &str = "f.is_junk = 0 AND f.probe_version > 0 \
  AND f.probe_error IS NULL AND f.width IS NOT NULL AND f.height IS NOT NULL \
  AND (f.kind = 'image' OR (f.kind = 'video' AND COALESCE(f.duration_ms, 0) > 0))";

/// A file as the catalog stores it, including what the Library never shows.
#[derive(Clone, Debug, PartialEq)]
pub struct FileRecord {
    pub id: FileId,
    pub root_id: RootId,
    pub root_path: String,
    pub rel_path: String,
    pub dir: String,
    pub name: String,
    pub ext: String,
    pub size: i64,
    pub mtime_ms: f64,
    pub ctime_ms: f64,
    pub dev: String,
    pub ino: String,
    pub is_junk: bool,
    pub kind: FileKind,
    pub format: Option<FileFormat>,
    pub ext_mismatch: bool,
    pub probe_version: i64,
    pub probe_error: Option<String>,
    pub width: Option<i64>,
    pub height: Option<i64>,
    pub frames: Option<i64>,
    pub has_alpha: Option<i64>,
    pub duration_ms: Option<f64>,
    pub video_codec: Option<String>,
    pub audio_codec: Option<String>,
    pub audio_streams: Option<i64>,
    pub bitrate: Option<f64>,
    pub sha256: Option<String>,
    pub fingerprint: Option<String>,
    pub loudness_version: i64,
    pub loudness_max_db: Option<f64>,
    /// Set once a Convert of these bytes came out no smaller and was not kept.
    pub optimize_not_smaller: bool,
    pub shrink_not_smaller: bool,
    /// These bytes are a re-encode Tidy made to save space, until they change.
    pub reencoded: bool,
    pub fingerprint_version: i64,
}

impl FileRecord {
    /// Reads a row selected with [`FILE_COLUMNS`], by column name.
    pub fn from_row(row: &Row<'_>) -> rusqlite::Result<Self> {
        let flag = |name: &str| row.get::<_, i64>(name).map(|value| value == 1);
        Ok(Self {
            id: row.get("id")?,
            root_id: row.get("root_id")?,
            root_path: row.get("root_path")?,
            rel_path: row.get("rel_path")?,
            dir: row.get("dir")?,
            name: row.get("name")?,
            ext: row.get("ext")?,
            size: row.get("size")?,
            mtime_ms: row.get("mtime_ms")?,
            ctime_ms: row.get("ctime_ms")?,
            dev: row.get("dev")?,
            ino: row.get("ino")?,
            is_junk: flag("is_junk")?,
            kind: kind_column(row, row.as_ref().column_index("kind")?)?,
            format: format_column(row, row.as_ref().column_index("format")?)?,
            ext_mismatch: flag("ext_mismatch")?,
            probe_version: row.get("probe_version")?,
            probe_error: row.get("probe_error")?,
            width: row.get("width")?,
            height: row.get("height")?,
            frames: row.get("frames")?,
            has_alpha: row.get("has_alpha")?,
            duration_ms: row.get("duration_ms")?,
            video_codec: row.get("video_codec")?,
            audio_codec: row.get("audio_codec")?,
            audio_streams: row.get("audio_streams")?,
            bitrate: row.get("bitrate")?,
            sha256: row.get("sha256")?,
            fingerprint: row.get("fingerprint")?,
            loudness_version: row.get("loudness_version")?,
            loudness_max_db: row.get("loudness_max_db")?,
            optimize_not_smaller: flag("optimize_not_smaller")?,
            shrink_not_smaller: flag("shrink_not_smaller")?,
            reencoded: flag("reencoded")?,
            fingerprint_version: row.get("fingerprint_version")?,
        })
    }

    /// What a probe must have found for a print: it read the file, with a size, and a still or a
    /// video with a length.
    fn probe_facts_allow_a_print(&self) -> bool {
        self.probe_error.is_none()
            && self.width.is_some()
            && self.height.is_some()
            && (self.kind == FileKind::Image
                || (self.kind == FileKind::Video && self.duration_ms.unwrap_or(0.0) > 0.0))
    }

    /// Whether this file has no print but the analysis will make one: it is
    /// [`Self::fingerprintable`], or not probed yet and so may yet be; one whose print failed or
    /// that can never have one (a junk file, one that will not open) is not waited for.
    pub fn awaits_print(&self) -> bool {
        let qualifies = self.probe_version == 0 || self.probe_facts_allow_a_print();
        self.fingerprint.is_none()
            && self.fingerprint_version < FINGERPRINT_VERSION
            && !self.is_junk
            && qualifies
    }

    /// Whether the video can be heard; `None` for anything else, or a video not probed yet.
    pub fn audio_state(&self) -> Option<AudioState> {
        if self.kind != FileKind::Video || self.probe_version == 0 {
            return None;
        }
        if self.audio_streams.unwrap_or(0) == 0 {
            return Some(AudioState::None);
        }
        match self.loudness_max_db {
            Some(_) if self.loudness_version == 0 => Some(AudioState::Unmeasured),
            None => Some(AudioState::Unmeasured),
            Some(peak) if peak <= SILENCE_THRESHOLD_DB => Some(AudioState::Silent),
            Some(_) => Some(AudioState::Sound),
        }
    }

    pub fn abs_path(&self) -> PathBuf {
        to_absolute_path(&self.root_path, &self.rel_path)
    }

    /// The file as the Library shows it.
    pub fn to_file_row(&self) -> FileRow {
        FileRow {
            id: self.id,
            root_id: self.root_id,
            rel_path: self.rel_path.clone(),
            abs_path: self.abs_path().to_string_lossy().into_owned(),
            name: self.name.clone(),
            dir: self.dir.clone(),
            ext: self.ext.clone(),
            size: self.size,
            mtime_ms: self.mtime_ms,
            ctime_ms: self.ctime_ms,
            kind: self.kind,
            format: self.format,
            extension_mismatch: self.ext_mismatch,
            width: self.width,
            height: self.height,
            frames: self.frames,
            duration_ms: self.duration_ms,
            video_codec: self.video_codec.clone(),
            audio_codec: self.audio_codec.clone(),
            audio_state: self.audio_state(),
            bitrate: self.bitrate,
            probe_error: self.probe_error.clone(),
            sha256: self.sha256.clone(),
        }
    }

    /// Device and inode: hard links to one file share both.
    pub fn inode(&self) -> String {
        format!("{}:{}", self.dev, self.ino)
    }
}

/// Joins an archive path (forward slashes) onto its root with the platform's separator.
pub fn to_absolute_path(root_path: &str, rel_path: &str) -> PathBuf {
    let mut path = PathBuf::from(root_path);
    for segment in rel_path.split('/').filter(|segment| !segment.is_empty()) {
        path.push(segment);
    }
    path
}

pub(crate) fn kind_column(row: &Row<'_>, index: usize) -> rusqlite::Result<FileKind> {
    let text: String = row.get(index)?;
    FileKind::parse(&text).ok_or_else(|| invalid_text(index, &text))
}

pub(crate) fn format_column(row: &Row<'_>, index: usize) -> rusqlite::Result<Option<FileFormat>> {
    let text: Option<String> = row.get(index)?;
    text.map(|text| FileFormat::parse(&text).ok_or_else(|| invalid_text(index, &text)))
        .transpose()
}

pub(crate) fn invalid_text(index: usize, text: &str) -> rusqlite::Error {
    rusqlite::Error::FromSqlConversionFailure(
        index,
        rusqlite::types::Type::Text,
        format!("{text:?} is not a value the catalog stores").into(),
    )
}

#[cfg(test)]
mod tests {
    use rusqlite::Connection;

    use super::*;
    use crate::catalog::MIGRATIONS;

    /// Every combination of what the two conditions read, so each SQL twin is held to its Rust.
    #[test]
    fn sql_and_rust_conditions_agree_on_every_row() {
        let connection = Connection::open_in_memory().unwrap();
        for migration in MIGRATIONS {
            connection.execute_batch(migration).unwrap();
        }
        connection
            .execute(
                "INSERT INTO roots (id, path, added_at) VALUES (1, '/r', 0)",
                [],
            )
            .unwrap();
        let mut id = 0;
        for kind in ["image", "video", "other"] {
            for junk in [0, 1] {
                for probe_version in [0, 1] {
                    for probe_error in [None, Some("bad")] {
                        for size in [None, Some(10)] {
                            for duration in [None, Some(0.0), Some(5.0)] {
                                for (streams, loudness_version, level) in [
                                    (None, 0, None),
                                    (Some(1), 0, None),
                                    (Some(1), 1, None),
                                    (Some(1), 1, Some(-70.0)),
                                    (Some(1), 1, Some(-60.0)),
                                    (Some(1), 1, Some(-20.0)),
                                ] {
                                    id += 1;
                                    connection
                                        .execute(
                                            "INSERT INTO files (id, root_id, rel_path, dir, name,
                                               ext, size, mtime_ms, ctime_ms, dev, ino, is_junk,
                                               last_seen_scan, kind, probe_version, probe_error,
                                               width, height, duration_ms, audio_streams,
                                               loudness_version, loudness_max_db)
                                             VALUES (?1, 1, ?1, '', ?1, 'x', 1, 0, 0, '1', ?1,
                                               ?2, 0, ?3, ?4, ?5, ?6, ?6, ?7, ?8, ?9, ?10)",
                                            rusqlite::params![
                                                id,
                                                junk,
                                                kind,
                                                probe_version,
                                                probe_error,
                                                size,
                                                duration,
                                                streams,
                                                loudness_version,
                                                level
                                            ],
                                        )
                                        .unwrap();
                                }
                            }
                        }
                    }
                }
            }
        }
        let mut statement = connection
            .prepare(&format!(
                "SELECT {FILE_COLUMNS}, ({}) AS audio_state_sql FROM {FILES_FROM}",
                audio_state_sql()
            ))
            .unwrap();
        let rows = statement
            .query_map([], |row| {
                Ok((
                    FileRecord::from_row(row)?,
                    row.get::<_, Option<String>>("audio_state_sql")?,
                ))
            })
            .unwrap();
        let mut checked = 0;
        for row in rows {
            let (record, audio_state) = row.unwrap();
            assert_eq!(
                record.audio_state().map(|state| state.as_str().to_owned()),
                audio_state,
                "{record:?}"
            );
            checked += 1;
        }
        assert_eq!(checked, id);
    }
}
