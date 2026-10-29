//! What duplicate sets read from the catalog, from glazier-core's `duplicates/queries.ts`.

use rusqlite::Connection;

use super::keeper::KeeperCandidate;
use crate::catalog::files::SqlParams;
use crate::catalog::rows::{FINGERPRINTABLE_SQL, FileRecord};
use crate::contract::{RootId, Settings, SimilarityLevel};
use crate::similarity::{Fingerprint, FingerprintedFile, SimilarCluster, group_similar_files};

/// Whether a file sits in one of the owner's preferred folders.
fn is_preferred_path(settings: &Settings, record: &FileRecord) -> bool {
    settings.preferred_folders.iter().any(|folder| {
        folder.root_id == record.root_id
            && (folder.dir.is_empty()
                || record.dir == folder.dir
                || record.dir.starts_with(&format!("{}/", folder.dir)))
    })
}

pub fn to_keeper_candidate(record: &FileRecord, settings: &Settings) -> KeeperCandidate {
    KeeperCandidate {
        id: record.id,
        rel_path: record.rel_path.clone(),
        kind: record.kind,
        format: record.format,
        ext: record.ext.clone(),
        extension_mismatch: record.ext_mismatch,
        video_codec: record.video_codec.clone(),
        width: record.width,
        height: record.height,
        duration_ms: record.duration_ms,
        audio_state: record.audio_state(),
        size: record.size,
        mtime_ms: record.mtime_ms,
        is_preferred: is_preferred_path(settings, record),
        in_home_folder: false,
    }
}

/// Hashes held by more than one file on disk (hard links to one file count once), as a subquery
/// over `files` yielding `sha256`. Sets `$root` in `params` when a root is given.
pub fn exact_group_sql(root_id: Option<RootId>, params: &mut SqlParams) -> String {
    if let Some(root_id) = root_id {
        params.set("root", root_id);
    }
    format!(
        "SELECT sha256 FROM files
    WHERE sha256 IS NOT NULL AND is_junk = 0 AND size > 0 {}
    GROUP BY sha256
    HAVING COUNT(DISTINCT dev || ':' || ino) > 1",
        if root_id.is_some() {
            "AND root_id = $root"
        } else {
            ""
        }
    )
}

/// How many files can be fingerprinted, and how many have been (or failed).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct FingerprintCoverage {
    pub fingerprinted: i64,
    pub fingerprintable: i64,
}

pub fn fingerprint_coverage(
    connection: &Connection,
    root_id: Option<RootId>,
) -> anyhow::Result<FingerprintCoverage> {
    let mut params = SqlParams::new();
    let mut root_filter = "";
    if let Some(root_id) = root_id {
        params.set("root", root_id);
        root_filter = "AND f.root_id = $root";
    }
    Ok(connection.query_row(
        &format!(
            "SELECT COUNT(*) AS total, SUM(f.fingerprint IS NOT NULL OR f.fingerprint_error IS NOT NULL) AS done
      FROM files f WHERE {FINGERPRINTABLE_SQL} {root_filter}"
        ),
        &*params.named(),
        |row| {
            Ok(FingerprintCoverage {
                fingerprintable: row.get(0)?,
                fingerprinted: row.get::<_, Option<i64>>(1)?.unwrap_or(0),
            })
        },
    )?)
}

/// Every fingerprinted file under a root (or all roots), as the similar-set search reads them.
/// A malformed stored print is skipped; the next fingerprint version rewrites it.
pub fn fingerprinted_files(
    connection: &Connection,
    root_id: Option<RootId>,
) -> anyhow::Result<Vec<FingerprintedFile>> {
    let mut params = SqlParams::new();
    let mut root_filter = "";
    if let Some(root_id) = root_id {
        params.set("root", root_id);
        root_filter = "AND f.root_id = $root";
    }
    let mut statement = connection.prepare_cached(&format!(
        "SELECT f.id, f.width, f.height, f.fingerprint FROM files f
      WHERE f.fingerprint IS NOT NULL AND {FINGERPRINTABLE_SQL} {root_filter}"
    ))?;
    let rows = statement.query_map(&*params.named(), |row| {
        Ok((
            row.get::<_, i64>(0)?,
            row.get::<_, f64>(1)?,
            row.get::<_, f64>(2)?,
            row.get::<_, String>(3)?,
        ))
    })?;
    let mut files = Vec::new();
    for row in rows {
        let (id, width, height, stored) = row?;
        if height == 0.0 {
            continue;
        }
        if let Some(fingerprint) = Fingerprint::parse(&stored) {
            files.push(FingerprintedFile {
                id,
                aspect: width / height,
                fingerprint,
            });
        }
    }
    Ok(files)
}

/// Groups every fingerprinted file under a root (or all roots) at a similarity level.
pub fn compute_similar_clusters(
    connection: &Connection,
    root_id: Option<RootId>,
    level: SimilarityLevel,
) -> anyhow::Result<Vec<SimilarCluster>> {
    Ok(group_similar_files(
        &fingerprinted_files(connection, root_id)?,
        level,
    ))
}
