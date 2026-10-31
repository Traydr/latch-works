//! The parts of Overview the catalog answers directly, from glazier-core's `catalog/tidy.ts`.

use rusqlite::Connection;
use serde::Serialize;

use super::files::{SqlParams, supported_extensions_sql};
use super::rows::{AUDIO_STATE_SQL, FINGERPRINTABLE_SQL, LOUDNESS_VERSION};
use crate::contract::{AnalysisProgress, Count, Finding, FindingKind, RootId};

/// Pane View serves originals with these extensions by presigned URL instead of Shutter.
const PRESIGNED_EXTENSIONS_SQL: &str = "'mkv', 'bmp'";

/// What each finding counts, as a condition on `files f`.
fn finding_sql(kind: FindingKind) -> String {
    match kind {
        FindingKind::Undecodable => "f.probe_error IS NOT NULL".to_owned(),
        FindingKind::ZeroByte => "f.size = 0 AND f.is_junk = 0".to_owned(),
        FindingKind::Unsupported => format!(
            "f.is_junk = 0 AND f.ext NOT IN ({})",
            supported_extensions_sql()
        ),
        FindingKind::PresignedDelivery => format!("f.ext IN ({PRESIGNED_EXTENSIONS_SQL})"),
        FindingKind::UnconvertibleVideo => {
            "f.kind = 'video' AND f.format IN ('avi', 'flv', 'asf')".to_owned()
        }
    }
}

/// Totals, silent soundtracks, junk, empty folders, the findings that need a human look (only
/// those with files) and how far the background analysis has come.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogTidy {
    pub files: i64,
    pub bytes: i64,
    pub last_scan_at: Option<i64>,
    pub silent_tracks: Count,
    pub attention: Vec<Finding>,
    pub analysis: AnalysisProgress,
    pub junk: i64,
    pub empty_folders: i64,
}

const COLUMNS: [&str; 9] = [
    "files",
    "bytes",
    "junk",
    "silent",
    "silent_bytes",
    "measurable",
    "measured",
    "fingerprintable",
    "fingerprinted",
];

pub fn catalog_tidy(connection: &Connection, root_id: RootId) -> anyhow::Result<CatalogTidy> {
    let finding_sums: Vec<String> = FindingKind::ALL
        .iter()
        .enumerate()
        .map(|(index, &kind)| {
            let condition = finding_sql(kind);
            format!(
                "SUM(CASE WHEN {condition} THEN 1 ELSE 0 END) AS finding{index},
      SUM(CASE WHEN {condition} THEN f.size ELSE 0 END) AS finding_bytes{index}"
            )
        })
        .collect();
    let sql = format!(
        "SELECT COUNT(*) AS files, SUM(f.size) AS bytes,
        SUM(f.is_junk = 1) AS junk,
        SUM(({AUDIO_STATE_SQL}) = 'silent') AS silent,
        SUM(CASE WHEN ({AUDIO_STATE_SQL}) = 'silent' THEN f.size ELSE 0 END) AS silent_bytes,
        SUM(f.kind = 'video' AND f.probe_version > 0 AND COALESCE(f.audio_streams, 0) > 0)
          AS measurable,
        SUM(f.kind = 'video' AND f.probe_version > 0 AND COALESCE(f.audio_streams, 0) > 0
          AND f.loudness_version >= $loudness) AS measured,
        SUM({FINGERPRINTABLE_SQL}) AS fingerprintable,
        SUM(({FINGERPRINTABLE_SQL})
          AND (f.fingerprint IS NOT NULL OR f.fingerprint_error IS NOT NULL)) AS fingerprinted,
        {},
        (SELECT COUNT(*) FROM empty_folders e WHERE e.root_id = $root) AS empty_folders
        FROM files f WHERE f.root_id = $root",
        finding_sums.join(",\n        ")
    );
    let params = SqlParams::new()
        .with("root", root_id)
        .with("loudness", LOUDNESS_VERSION);
    let column_count = COLUMNS.len() + FindingKind::ALL.len() * 2 + 1;
    let values: Vec<i64> = connection.query_row(&sql, &*params.named(), |row| {
        (0..column_count)
            .map(|index| {
                row.get::<_, Option<i64>>(index)
                    .map(Option::unwrap_or_default)
            })
            .collect()
    })?;
    let count = |name: &str| {
        COLUMNS
            .iter()
            .position(|column| *column == name)
            .map_or(0, |index| values[index])
    };
    let attention = FindingKind::ALL
        .iter()
        .enumerate()
        .filter_map(|(index, &kind)| {
            let files = values[COLUMNS.len() + index * 2];
            (files > 0).then(|| Finding {
                kind,
                count: files,
                bytes: values[COLUMNS.len() + index * 2 + 1],
            })
        })
        .collect();
    let last_scan_at: Option<i64> = connection
        .query_row(
            "SELECT last_scan_at AS last FROM roots WHERE id = ?1",
            [root_id],
            |row| row.get(0),
        )
        .unwrap_or(None);

    Ok(CatalogTidy {
        files: count("files"),
        bytes: count("bytes"),
        last_scan_at,
        silent_tracks: Count {
            files: count("silent"),
            bytes: count("silent_bytes"),
        },
        attention,
        analysis: AnalysisProgress {
            fingerprinted: count("fingerprinted"),
            fingerprintable: count("fingerprintable"),
            sound_measured: count("measured"),
            sound_measurable: count("measurable"),
        },
        junk: count("junk"),
        empty_folders: values[column_count - 1],
    })
}
