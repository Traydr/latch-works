//! Duplicate sets, from glazier-core's `duplicates/sets.ts`: byte-identical copies and similar
//! versions, each set with the copy to keep, and with Spot variants the pictures among them.

use std::collections::{HashMap, HashSet};

use indexmap::IndexMap;
use rusqlite::Connection;

use super::dismissals::Dismissals;
use super::keeper::{KeeperCandidate, keep_reason, rank_keepers};
use super::queries::{exact_group_sql, to_keeper_candidate};
use crate::catalog::files::{SqlParams, get_file_records};
use crate::catalog::rows::FileRecord;
use crate::collation::js_string_order;
use crate::contract::{
    DuplicateCounts, DuplicateKind, DuplicateScope, DuplicateSet, DuplicateSetPage,
    DuplicateTotals, DuplicateVersion, FileId, KeepReason, RootId, Settings, deciding_versions,
};
use crate::passes::detail::load_details;
use crate::similarity::{DisjointSets, SimilarCluster, is_variant, normalize_detail};

/// A duplicate set as computed from the catalog, before the owner's dismissals apply.
#[derive(Clone, Debug, PartialEq)]
pub struct ComputedSet {
    /// The set, with no dismissal yet.
    pub set: DuplicateSet,
    pub file_ids: Vec<FileId>,
    /// Files the suggested resolution moves to holding.
    pub extra_copies: i64,
    /// Spot variants found every version a picture of its own, so the set is not duplicates.
    pub variants: bool,
    /// With Spot variants on, the set's stills and how many of them have a print (or failed one).
    pub comparable: i64,
    pub compared: i64,
}

/// The files a resolution keeping `keep` moves to holding: every other file, except those that
/// share their bytes on disk with a kept file, since holding a hard link frees nothing.
pub fn removals_for<'a>(files: &'a [FileRecord], keep: &[FileId]) -> Vec<&'a FileRecord> {
    let kept_inodes: HashSet<String> = files
        .iter()
        .filter(|file| keep.contains(&file.id))
        .map(FileRecord::inode)
        .collect();
    files
        .iter()
        .filter(|file| !keep.contains(&file.id) && !kept_inodes.contains(&file.inode()))
        .collect()
}

/// Every duplicate set under a root (or all roots). Byte-identical files (same SHA-256 on more
/// than one inode) and similar clusters link files; each connected group is one set, so a file is
/// in one set only. A set needs two versions, or one version on two inodes: hard links of one
/// file are not duplicates. Sorted by bytes to reclaim, most first.
pub fn build_duplicate_sets(
    connection: &Connection,
    root_id: Option<RootId>,
    settings: &Settings,
    clusters: &[SimilarCluster],
) -> anyhow::Result<Vec<ComputedSet>> {
    let mut params = SqlParams::new();
    let groups = exact_group_sql(root_id, &mut params);
    let mut statement = connection.prepare_cached(&format!(
        "SELECT f.id, f.sha256 FROM files f
      WHERE f.sha256 IN ({groups}) AND f.is_junk = 0 AND f.size > 0
        {}",
        if root_id.is_some() {
            "AND f.root_id = $root"
        } else {
            ""
        }
    ))?;
    let members: Vec<(FileId, String)> = statement
        .query_map(&*params.named(), |row| Ok((row.get(0)?, row.get(1)?)))?
        .collect::<rusqlite::Result<_>>()?;

    let mut links = DisjointSets::default();
    let mut first_by_sha: HashMap<String, FileId> = HashMap::new();
    for (id, sha256) in members {
        match first_by_sha.get(&sha256) {
            Some(&first) => links.union(first, id, 0),
            None => {
                first_by_sha.insert(sha256, id);
            }
        }
    }
    for cluster in clusters {
        if let Some((&first, rest)) = cluster.ids.split_first() {
            for &id in rest {
                links.union(first, id, cluster.distance);
            }
        }
    }
    let components = links.clusters();

    let all_ids: Vec<FileId> = components
        .iter()
        .flat_map(|(_, ids)| ids.iter().copied())
        .collect();
    let records = get_file_records(connection, &all_ids)?;
    let by_id: HashMap<FileId, &FileRecord> =
        records.iter().map(|record| (record.id, record)).collect();
    let details = if settings.spot_variants {
        let stills: Vec<FileId> = records
            .iter()
            .filter(|record| is_still(record))
            .map(|record| record.id)
            .collect();
        Some(load_details(connection, &stills)?)
    } else {
        None
    };

    let mut sets: Vec<ComputedSet> = components
        .iter()
        .filter_map(|(distance, ids)| {
            let files: Vec<FileRecord> = ids
                .iter()
                .filter_map(|id| by_id.get(id).map(|record| (*record).clone()))
                .collect();
            build_set(&files, *distance, settings, details.as_ref())
        })
        .collect();
    sets.sort_by(|left, right| {
        right
            .set
            .reclaimable_bytes
            .cmp(&left.set.reclaimable_bytes)
            .then_with(|| js_string_order(&left.set.key, &right.set.key))
    });
    Ok(sets)
}

type Details = HashMap<FileId, Option<Vec<u8>>>;

/// A candidate with the record it came from, by position in the set's files.
#[derive(Clone, Debug)]
struct Ranked {
    candidate: KeeperCandidate,
    record: usize,
}

impl AsRef<KeeperCandidate> for Ranked {
    fn as_ref(&self) -> &KeeperCandidate {
        &self.candidate
    }
}

/// Files of one content: byte-identical copies, best first.
type Version = Vec<Ranked>;

/// Only stills get detail prints; a video's or animation's frames never line up well enough.
fn is_still(record: &FileRecord) -> bool {
    record
        .fingerprint
        .as_deref()
        .is_some_and(|print| print.starts_with("s:"))
}

fn content_of(record: &FileRecord) -> String {
    record
        .sha256
        .clone()
        .unwrap_or_else(|| format!("file:{}", record.id))
}

fn folder_of(record: &FileRecord) -> String {
    format!("{}:{}", record.root_id, record.dir)
}

/// Ranked order grouped into versions, best first, each with its copies best first.
fn versions_of(files: &[FileRecord], ranked: Vec<Ranked>) -> Vec<Version> {
    let mut by_content: IndexMap<String, Version> = IndexMap::new();
    for entry in ranked {
        by_content
            .entry(content_of(&files[entry.record]))
            .or_default()
            .push(entry);
    }
    by_content.into_values().collect()
}

/// A version's print: any of its copies' (they hold the same bytes), or `None` when none has one.
fn print_of(version: &Version, details: &Details) -> Option<Vec<f32>> {
    version.iter().find_map(|entry| {
        details
            .get(&entry.candidate.id)
            .and_then(Option::as_deref)
            .map(normalize_detail)
    })
}

/// Which picture each version shows, by content. In ranked order, a version joins the first
/// picture whose best version it is a copy of, or starts a picture when it is a variant of all
/// of them. `None` when a version has no print to compare.
fn pictures_of(
    files: &[FileRecord],
    versions: &[Version],
    details: &Details,
) -> Option<HashMap<String, i64>> {
    let mut heads: Vec<Vec<f32>> = Vec::new();
    let mut picture_of = HashMap::new();
    for version in versions {
        let print = print_of(version, details)?;
        let first = version.first()?;
        let content = content_of(&files[first.record]);
        match heads.iter().position(|head| !is_variant(head, &print)) {
            Some(picture) => {
                picture_of.insert(content, picture as i64);
            }
            None => {
                picture_of.insert(content, heads.len() as i64);
                heads.push(print);
            }
        }
    }
    Some(picture_of)
}

/// The folder holding the most of the set's pictures, where every picture's copy is best kept so
/// the set stays together; the best-ranked file's folder breaks a tie. `None` when no folder
/// holds two pictures, since then there is nothing to keep together.
fn home_folder(
    files: &[FileRecord],
    ranked: &[&Ranked],
    picture_of: &HashMap<String, i64>,
) -> Option<String> {
    let mut pictures_in: HashMap<String, HashSet<i64>> = HashMap::new();
    for entry in ranked {
        let record = &files[entry.record];
        pictures_in
            .entry(folder_of(record))
            .or_default()
            .insert(picture_of.get(&content_of(record)).copied().unwrap_or(-1));
    }
    let most = pictures_in.values().map(HashSet::len).max()?;
    if most < 2 {
        return None;
    }
    ranked
        .iter()
        .map(|entry| folder_of(&files[entry.record]))
        .find(|folder| pictures_in.get(folder).map(HashSet::len) == Some(most))
}

/// Versions grouped into pictures, picture by picture with each one's best version first, and the
/// home folder ranking copies; versions alone when there is nothing to compare.
fn group_pictures(
    files: &[FileRecord],
    candidates: &[Ranked],
    details: Option<&Details>,
) -> (Vec<Version>, Option<Vec<i64>>) {
    let versions = versions_of(files, rank_keepers(candidates).0);
    let picture_of = match details {
        Some(details) if versions.len() >= 2 => pictures_of(files, &versions, details),
        _ => None,
    };
    let Some(picture_of) = picture_of else {
        return (versions, None);
    };

    let flat: Vec<&Ranked> = versions.iter().flatten().collect();
    let home = home_folder(files, &flat, &picture_of);
    let rehomed: Vec<Ranked> = candidates
        .iter()
        .map(|entry| {
            let mut entry = entry.clone();
            entry.candidate.in_home_folder =
                home.as_deref() == Some(folder_of(&files[entry.record]).as_str());
            entry
        })
        .collect();
    let reranked = versions_of(files, rank_keepers(&rehomed).0);

    // Pictures are numbered by their best version, and a picture's versions sit together.
    let picture_of_version = |version: &Version| {
        version
            .first()
            .and_then(|first| picture_of.get(&content_of(&files[first.record])).copied())
            .unwrap_or(0)
    };
    let mut order: IndexMap<i64, i64> = IndexMap::new();
    for version in &reranked {
        let picture = picture_of_version(version);
        if !order.contains_key(&picture) {
            let next = order.len() as i64;
            order.insert(picture, next);
        }
    }
    let mut numbered: Vec<(Version, i64)> = reranked
        .into_iter()
        .map(|version| {
            let picture = order
                .get(&picture_of_version(&version))
                .copied()
                .unwrap_or(0);
            (version, picture)
        })
        .collect();
    numbered.sort_by_key(|(_, picture)| *picture);
    let pictures = numbered.iter().map(|(_, picture)| *picture).collect();
    (
        numbered.into_iter().map(|(version, _)| version).collect(),
        Some(pictures),
    )
}

fn build_set(
    files: &[FileRecord],
    distance: u32,
    settings: &Settings,
    details: Option<&Details>,
) -> Option<ComputedSet> {
    let candidates: Vec<Ranked> = files
        .iter()
        .enumerate()
        .map(|(index, record)| Ranked {
            candidate: to_keeper_candidate(record, settings),
            record: index,
        })
        .collect();
    let (versions, pictures) = group_pictures(files, &candidates, details);
    let best_version = versions.first()?;
    let best = best_version.first()?;
    let inodes: HashSet<String> = best_version
        .iter()
        .map(|entry| files[entry.record].inode())
        .collect();
    let exact = versions.len() < 2;
    if exact && inodes.len() < 2 {
        return None;
    }

    // Each picture keeps its best version's best copy; without pictures, the set keeps one file.
    let keep: Vec<FileId> = match &pictures {
        None => vec![best.candidate.id],
        Some(pictures) => versions
            .iter()
            .enumerate()
            .filter(|(index, _)| *index == 0 || pictures[*index] != pictures[index - 1])
            .filter_map(|(_, version)| version.first().map(|entry| entry.candidate.id))
            .collect(),
    };

    let removed = removals_for(files, &keep);
    let mut freed: HashMap<String, i64> = HashMap::new();
    for record in &removed {
        freed.insert(record.inode(), record.size);
    }
    let mut link_counts: HashMap<String, usize> = HashMap::new();
    for record in files {
        *link_counts.entry(record.inode()).or_default() += 1;
    }
    let file_ids: Vec<FileId> = files.iter().map(|record| record.id).collect();
    let variants = pictures
        .as_ref()
        .is_some_and(|pictures| pictures.iter().collect::<HashSet<_>>().len() == versions.len());
    let stills: Vec<&FileRecord> = match details {
        Some(_) if !exact => files.iter().filter(|record| is_still(record)).collect(),
        _ => Vec::new(),
    };
    let compared = stills
        .iter()
        .filter(|record| details.is_some_and(|details| details.contains_key(&record.id)))
        .count();

    let set_versions: Vec<DuplicateVersion> = versions
        .iter()
        .map(|version| DuplicateVersion {
            files: version
                .iter()
                .map(|entry| files[entry.record].to_file_row())
                .collect(),
        })
        .collect();
    let keep_reason = deciding_reason(&versions, &set_versions, pictures.as_deref());
    let set = DuplicateSet {
        key: if exact {
            format!(
                "exact:{}",
                files[best.record].sha256.as_deref().unwrap_or("null")
            )
        } else {
            format!(
                "similar:{}",
                file_ids.iter().min().copied().unwrap_or_default()
            )
        },
        kind: if exact {
            DuplicateKind::Exact
        } else {
            DuplicateKind::Similar
        },
        versions: set_versions,
        pictures,
        keep,
        keep_reason,
        reclaimable_bytes: freed.values().sum(),
        hard_linked_ids: files
            .iter()
            .filter(|record| link_counts.get(&record.inode()).copied().unwrap_or(0) > 1)
            .map(|record| record.id)
            .collect(),
        distance: (!exact).then_some(distance),
        dismissal_id: None,
    };
    Some(ComputedSet {
        set,
        file_ids,
        extra_copies: removed.len() as i64,
        variants,
        comparable: stills.len() as i64,
        compared: compared as i64,
    })
}

/// The rule that kept the deciding version over its runner-up (see [`deciding_versions`]).
fn deciding_reason(
    versions: &[Version],
    set_versions: &[DuplicateVersion],
    pictures: Option<&[i64]>,
) -> KeepReason {
    let pair = deciding_versions(set_versions, pictures);
    let (kept, runner_up) = match pair {
        Some((kept, runner_up)) => (
            versions.get(kept).and_then(|version| version.first()),
            versions.get(runner_up).and_then(|version| version.first()),
        ),
        None => (
            versions.first().and_then(|version| version.first()),
            versions.first().and_then(|version| version.get(1)),
        ),
    };
    match (kept, runner_up) {
        (Some(kept), Some(runner_up)) => keep_reason(&kept.candidate, &runner_up.candidate),
        _ if pictures.is_none() => KeepReason::NameOrder,
        _ => KeepReason::DifferentPictures,
    }
}

fn in_scope(entry: &ComputedSet, scope: DuplicateScope) -> bool {
    match scope {
        DuplicateScope::All => !entry.variants,
        DuplicateScope::Exact => entry.set.kind == DuplicateKind::Exact,
        DuplicateScope::Similar => entry.set.kind == DuplicateKind::Similar && !entry.variants,
        DuplicateScope::Variants => entry.variants,
    }
}

/// The sets the owner has not dismissed, in a scope, most bytes to reclaim first.
pub fn open_sets<'a>(
    computed: &'a [ComputedSet],
    dismissals: &Dismissals,
    scope: DuplicateScope,
) -> Vec<&'a ComputedSet> {
    computed
        .iter()
        .filter(|entry| in_scope(entry, scope) && dismissals.covering(&entry.file_ids).is_none())
        .collect()
}

/// Totals over sets: how many, the files their suggestions hold and the bytes that frees.
pub fn duplicate_totals<'a>(sets: impl IntoIterator<Item = &'a ComputedSet>) -> DuplicateTotals {
    let mut totals = DuplicateTotals::default();
    for entry in sets {
        totals.sets += 1;
        totals.extra_copies += entry.extra_copies;
        totals.reclaimable_bytes += entry.set.reclaimable_bytes;
    }
    totals
}

/// What [`page_duplicate_sets`] is asked for.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PageRequest {
    pub scope: DuplicateScope,
    pub dismissed: bool,
    pub offset: usize,
    pub limit: usize,
}

/// One page of open (or dismissed) sets in a scope, with counts that ignore the scope. The
/// fingerprint coverage is left at zero for the caller to fill in.
pub fn page_duplicate_sets(
    computed: &[ComputedSet],
    dismissals: &Dismissals,
    request: PageRequest,
) -> DuplicateSetPage {
    let mut counts = DuplicateCounts::default();
    let mut selected = Vec::new();
    let mut open_reclaimable_bytes = 0;
    let mut comparable = 0;
    let mut compared = 0;
    for entry in computed {
        let dismissal_id = dismissals.covering(&entry.file_ids);
        if dismissal_id.is_some() {
            counts.dismissed += 1;
        } else if entry.variants {
            counts.variants += 1;
        } else {
            match entry.set.kind {
                DuplicateKind::Exact => counts.exact += 1,
                DuplicateKind::Similar => counts.similar += 1,
            }
            open_reclaimable_bytes += entry.set.reclaimable_bytes;
        }
        if dismissal_id.is_none() {
            comparable += entry.comparable;
            compared += entry.compared;
        }
        // Dismissed sets are listed whatever Spot variants made of them.
        let listed = request.dismissed || in_scope(entry, request.scope);
        if dismissal_id.is_some() == request.dismissed && listed {
            let mut set = entry.set.clone();
            set.dismissal_id = dismissal_id;
            selected.push(set);
        }
    }
    DuplicateSetPage {
        total: selected.len() as i64,
        reclaimable_bytes: selected.iter().map(|set| set.reclaimable_bytes).sum(),
        counts,
        open_reclaimable_bytes,
        fingerprinted: 0,
        fingerprintable: 0,
        compared,
        comparable,
        sets: selected
            .into_iter()
            .skip(request.offset)
            .take(request.limit)
            .collect(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::catalog::Catalog;
    use crate::contract::{SimilarityLevel, is_close_call};
    use crate::duplicates::queries::compute_similar_clusters;
    use crate::similarity::{DETAIL_SIZE, DETAIL_VERSION};

    /// A still as a catalog row: a 1000×750 PNG of a kilobyte, alone on its inode.
    #[derive(Clone)]
    struct Still {
        id: FileId,
        rel_path: &'static str,
        sha256: &'static str,
        /// The fingerprint's 64 bits.
        hash: u64,
        width: i64,
        height: i64,
        size: i64,
        mtime_ms: f64,
        ino: String,
        /// The detail print, when Spot variants has one.
        detail: Option<Vec<u8>>,
    }

    fn still(id: FileId, rel_path: &'static str, sha256: &'static str, hash: u64) -> Still {
        Still {
            id,
            rel_path,
            sha256,
            hash,
            width: 1000,
            height: 750,
            size: 1000,
            mtime_ms: 1_700_000_000_000.0,
            ino: id.to_string(),
            detail: None,
        }
    }

    /// A catalog in a folder of its own, removed when dropped.
    struct Scratch {
        catalog: Catalog,
        folder: std::path::PathBuf,
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.folder);
        }
    }

    fn catalog(stills: &[Still]) -> Scratch {
        let folder = std::env::temp_dir().join(format!(
            "oriel-tidy-sets-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&folder).unwrap();
        let catalog = Catalog::open_blocking(folder.join("catalog.sqlite")).unwrap();
        let stills = stills.to_vec();
        catalog
            .blocking(move |connection| {
                connection.execute(
                    "INSERT INTO roots (id, path, added_at) VALUES (1, '/archive', 0)",
                    [],
                )?;
                for still in stills {
                    let (dir, name) = still.rel_path.rsplit_once('/').unwrap_or(("", still.rel_path));
                    connection.execute(
                        "INSERT INTO files (id, root_id, rel_path, dir, name, ext, size, mtime_ms,
                           ctime_ms, dev, ino, is_junk, last_seen_scan, kind, format, probe_version,
                           width, height, frames, has_alpha, sha256, fingerprint_version, fingerprint)
                         VALUES (?1, 1, ?2, ?3, ?4, 'png', ?5, ?6, ?6, '1', ?7, 0, 1, 'image', 'png',
                           1, ?8, ?9, 1, 0, ?10, 1, ?11)",
                        rusqlite::params![
                            still.id,
                            still.rel_path,
                            dir,
                            name,
                            still.size,
                            still.mtime_ms,
                            still.ino,
                            still.width,
                            still.height,
                            still.sha256,
                            format!("s:{:016x}", still.hash),
                        ],
                    )?;
                    if let Some(print) = still.detail {
                        connection.execute(
                            "INSERT INTO file_details (file_id, version, size, mtime_ms, print)
                             VALUES (?1, ?2, ?3, ?4, ?5)",
                            rusqlite::params![
                                still.id,
                                DETAIL_VERSION,
                                still.size,
                                still.mtime_ms,
                                print
                            ],
                        )?;
                    }
                }
                Ok(())
            })
            .unwrap();
        Scratch { catalog, folder }
    }

    fn sets(scratch: &Scratch, level: SimilarityLevel, spot_variants: bool) -> Vec<ComputedSet> {
        let settings = Settings {
            spot_variants,
            ..Settings::default()
        };
        scratch
            .catalog
            .blocking(move |connection| {
                let clusters = compute_similar_clusters(connection, Some(1), level)?;
                build_duplicate_sets(connection, Some(1), &settings, &clusters)
            })
            .unwrap()
    }

    /// Each version's file ids, best first.
    fn versions(set: &DuplicateSet) -> Vec<Vec<FileId>> {
        set.versions
            .iter()
            .map(|version| version.files.iter().map(|file| file.id).collect())
            .collect()
    }

    #[test]
    fn identical_bytes_on_two_inodes_are_a_set_and_hard_links_free_nothing() {
        let original = Still {
            mtime_ms: 1_600_000_000_000.0,
            ..still(1, "photos/sunset.png", "aa", 0)
        };
        let copy = still(2, "photos/sunset (1).png", "aa", 0);
        let link = Still {
            ino: "1".into(),
            ..still(3, "dup/sunset.png", "aa", 0)
        };
        // Two names of one file, and two empty files, are no one's duplicates.
        let lone_link = still(4, "other/a.png", "bb", u64::MAX);
        let lone_link_too = Still {
            ino: "4".into(),
            ..still(5, "other/b.png", "bb", u64::MAX)
        };
        // The empty files' prints are far apart, so only their bytes could join them.
        let empty = |id, rel_path, hash| Still {
            size: 0,
            ..still(id, rel_path, "e3b0", hash)
        };
        let scratch = catalog(&[
            original,
            copy,
            link,
            lone_link,
            lone_link_too,
            empty(6, "blank-1.png", 0x5555_5555_5555_5555),
            empty(7, "blank-2.png", 0xaaaa_aaaa_aaaa_aaaa),
        ]);
        let sets = sets(&scratch, SimilarityLevel::Balanced, false);
        assert_eq!(sets.len(), 1, "{sets:#?}");
        let set = &sets[0];
        assert_eq!(set.set.kind, DuplicateKind::Exact);
        assert_eq!(set.set.key, "exact:aa");
        assert_eq!(versions(&set.set), [vec![1, 3, 2]]);
        // The oldest is kept; its hard link stays with it, so only the copy goes.
        assert_eq!(set.set.keep, [1]);
        assert_eq!(set.set.keep_reason, KeepReason::Oldest);
        assert_eq!(set.extra_copies, 1);
        assert_eq!(set.set.reclaimable_bytes, 1000);
        assert_eq!(set.set.hard_linked_ids, [1, 3]);
        assert_eq!(set.set.distance, None);
    }

    #[test]
    fn similar_versions_join_by_fingerprint_with_their_identical_copies() {
        // Six bits apart: past Strict's 4, within Balanced's 8.
        let large = still(1, "photos/sunset.png", "aa", 0);
        let small = Still {
            width: 500,
            height: 375,
            ..still(2, "photos/sunset-small.jpg", "bb", 0b11_1111)
        };
        let copy = still(3, "dup/sunset copy.png", "aa", 0);
        let scratch = catalog(&[large, small, copy]);

        // At Strict only the identical copies are a set.
        let strict = sets(&scratch, SimilarityLevel::Strict, false);
        assert_eq!(strict.len(), 1);
        assert_eq!(strict[0].set.kind, DuplicateKind::Exact);

        let balanced = sets(&scratch, SimilarityLevel::Balanced, false);
        assert_eq!(balanced.len(), 1, "{balanced:#?}");
        let set = &balanced[0].set;
        assert_eq!(set.kind, DuplicateKind::Similar);
        assert_eq!(set.distance, Some(6));
        assert_eq!(versions(set), [vec![1, 3], vec![2]]);
        assert_eq!(set.keep, [1]);
        assert_eq!(set.keep_reason, KeepReason::MorePixels);
        assert!(!is_close_call(set));
        assert_eq!(balanced[0].extra_copies, 2);
    }

    #[test]
    fn a_tie_broken_by_a_few_percent_more_bytes_is_a_close_call() {
        let close = |larger| {
            let scratch = catalog(&[
                still(1, "a/photo.png", "aa", 0),
                Still {
                    size: larger,
                    ..still(2, "b/photo.png", "bb", 0b11)
                },
            ]);
            let sets = sets(&scratch, SimilarityLevel::Balanced, false);
            let set = &sets[0].set;
            assert_eq!(set.keep, [2]);
            assert_eq!(set.keep_reason, KeepReason::LargerFile);
            is_close_call(set)
        };
        assert!(close(1050), "5% larger is a close call");
        assert!(!close(2000), "twice the bytes is not");
    }

    /// A detail print with structure everywhere: a diagonal ramp.
    fn print() -> Vec<u8> {
        (0..DETAIL_SIZE * DETAIL_SIZE)
            .map(|index| ((index % DETAIL_SIZE) * 2 + (index / DETAIL_SIZE)) as u8)
            .collect()
    }

    /// The print with one patch changed, as another face or a caption changes it.
    fn print_with_patch() -> Vec<u8> {
        let mut changed = print();
        for row in 8..16 {
            for column in 8..16 {
                changed[row * DETAIL_SIZE + column] = 255;
            }
        }
        changed
    }

    #[test]
    fn spot_variants_keeps_a_copy_of_each_picture_from_the_folder_holding_most() {
        let plain = Still {
            detail: Some(print()),
            ..still(1, "fanbox/101_jp.png", "aa", 0)
        };
        let faced = Still {
            detail: Some(print_with_patch()),
            ..still(2, "fanbox/101_clean.png", "bb", 0b1)
        };
        // Another site's copy of the plain page, larger, with its tones shifted by a re-encode:
        // a copy of the first picture, not a picture of its own.
        let copy = Still {
            size: 3000,
            detail: Some(print().iter().map(|value| value + 3).collect()),
            ..still(3, "pixiv/900_p0.png", "cc", 0b10)
        };
        let scratch = catalog(&[plain, faced, copy]);

        // Off, it is one set that keeps one file.
        let off = sets(&scratch, SimilarityLevel::Balanced, false);
        assert_eq!(off[0].set.keep, [3]);
        assert_eq!(off[0].set.pictures, None);

        let on = sets(&scratch, SimilarityLevel::Balanced, true);
        assert_eq!(on.len(), 1, "{on:#?}");
        let computed = &on[0];
        let set = &computed.set;
        // The folder that holds both pictures is home: its copy of the plain page beats the
        // larger one elsewhere.
        assert_eq!(versions(set), [vec![1], vec![3], vec![2]]);
        assert_eq!(set.pictures.as_deref(), Some(&[0, 0, 1][..]));
        assert_eq!(set.keep, [1, 2]);
        assert_eq!(set.keep_reason, KeepReason::HomeFolder);
        assert!(!computed.variants);
        assert_eq!((computed.comparable, computed.compared), (3, 3));
        assert_eq!(computed.extra_copies, 1);
    }

    #[test]
    fn a_set_of_nothing_but_variants_keeps_every_version() {
        let scratch = catalog(&[
            Still {
                detail: Some(print()),
                ..still(1, "alt/outfit-a.png", "aa", 0)
            },
            Still {
                detail: Some(print_with_patch()),
                ..still(2, "alt/outfit-b.png", "bb", 0b1111)
            },
        ]);
        let on = sets(&scratch, SimilarityLevel::Balanced, true);
        let computed = &on[0];
        assert!(computed.variants);
        assert_eq!(computed.set.pictures.as_deref(), Some(&[0, 1][..]));
        assert_eq!(computed.set.keep.len(), 2);
        assert_eq!(computed.set.keep_reason, KeepReason::DifferentPictures);
        assert_eq!(computed.set.reclaimable_bytes, 0);
        // Until every version has a print there is nothing to compare, and it stays one set.
        let unprinted = catalog(&[
            Still {
                detail: Some(print()),
                ..still(1, "alt/outfit-a.png", "aa", 0)
            },
            still(2, "alt/outfit-b.png", "bb", 0b1111),
        ]);
        let on = sets(&unprinted, SimilarityLevel::Balanced, true);
        assert_eq!(on[0].set.pictures, None);
        assert_eq!(on[0].set.keep.len(), 1);
    }
}
