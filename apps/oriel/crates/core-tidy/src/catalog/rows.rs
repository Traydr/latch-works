//! A file's catalog row, as glazier-core's `catalog/file-rows.ts` selects and reads it.

use std::path::{MAIN_SEPARATOR_STR, Path, PathBuf};

use rusqlite::Row;

use crate::contract::{AudioState, FileFormat, FileId, FileKind, FileRow, RootId};

/// A track whose loudest moment stays under this is silence (digital silence reads −91 dB).
pub const SILENCE_THRESHOLD_DB: f64 = -60.0;

/// Bumped when the probe reads more, so old rows are probed again.
pub const PROBE_VERSION: i64 = 1;

pub const FINGERPRINT_VERSION: i64 = 1;

pub const LOUDNESS_VERSION: i64 = 1;

/// The SQL twin of [`FileRecord::audio_state`], for filtering in queries. A track the loudness
/// pass could not measure keeps its version and no level, and stays unmeasured.
pub const AUDIO_STATE_SQL: &str = "CASE
  WHEN f.kind != 'video' OR f.probe_version = 0 THEN NULL
  WHEN COALESCE(f.audio_streams, 0) = 0 THEN 'none'
  WHEN f.loudness_version = 0 OR f.loudness_max_db IS NULL THEN 'unmeasured'
  WHEN f.loudness_max_db <= -60 THEN 'silent'
  ELSE 'sound' END";

/// Every column a file row query selects, with its root's path, in [`FileRecord::from_row`]'s
/// order.
pub const FILE_COLUMNS: &str = "f.id, f.root_id, r.path AS root_path, f.rel_path, f.dir, f.name, \
  f.ext, f.size, f.mtime_ms, f.ctime_ms, f.dev, f.ino, f.is_junk, f.kind, f.format, \
  f.ext_mismatch, f.probe_version, f.probe_error, f.width, f.height, f.frames, f.has_alpha, \
  f.duration_ms, f.video_codec, f.audio_codec, f.audio_streams, f.bitrate, f.sha256, \
  f.fingerprint, f.loudness_version, f.loudness_max_db, f.optimize_not_smaller, \
  f.shrink_not_smaller";

pub const FILES_FROM: &str = "files f JOIN roots r ON r.id = f.root_id";

/// Files the similarity pass can fingerprint, as a SQL condition on `files f`.
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
}

impl FileRecord {
    /// Reads a row selected with [`FILE_COLUMNS`].
    pub fn from_row(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            id: row.get(0)?,
            root_id: row.get(1)?,
            root_path: row.get(2)?,
            rel_path: row.get(3)?,
            dir: row.get(4)?,
            name: row.get(5)?,
            ext: row.get(6)?,
            size: row.get(7)?,
            mtime_ms: row.get(8)?,
            ctime_ms: row.get(9)?,
            dev: row.get(10)?,
            ino: row.get(11)?,
            is_junk: row.get::<_, i64>(12)? == 1,
            kind: kind_column(row, 13)?,
            format: format_column(row, 14)?,
            ext_mismatch: row.get::<_, i64>(15)? == 1,
            probe_version: row.get(16)?,
            probe_error: row.get(17)?,
            width: row.get(18)?,
            height: row.get(19)?,
            frames: row.get(20)?,
            has_alpha: row.get(21)?,
            duration_ms: row.get(22)?,
            video_codec: row.get(23)?,
            audio_codec: row.get(24)?,
            audio_streams: row.get(25)?,
            bitrate: row.get(26)?,
            sha256: row.get(27)?,
            fingerprint: row.get(28)?,
            loudness_version: row.get(29)?,
            loudness_max_db: row.get(30)?,
            optimize_not_smaller: row.get::<_, i64>(31)? == 1,
            shrink_not_smaller: row.get::<_, i64>(32)? == 1,
        })
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

/// The archive path of `path` under `root`, with forward slashes, if it is under it.
pub fn to_archive_path(root: &Path, path: &Path) -> Option<String> {
    let relative = path.strip_prefix(root).ok()?;
    Some(
        relative
            .to_string_lossy()
            .split(MAIN_SEPARATOR_STR)
            .collect::<Vec<_>>()
            .join("/"),
    )
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
