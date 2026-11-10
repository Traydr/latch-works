//! Duplicate sets: byte-identical copies and similar
//! versions, each set with the copy to keep, and with Spot variants the pictures among them.

use std::collections::{HashMap, HashSet};

use indexmap::IndexMap;
use rusqlite::Connection;

use super::dismissals::Dismissals;
use super::keeper::{KeeperCandidate, keep_reason, rank_keepers};
use super::queries::{exact_group_sql, to_keeper_candidate};
use crate::catalog::details::{
    Comparisons, Readings, load_comparisons, load_details, load_readings,
};
use crate::catalog::files::{SqlParams, get_file_records};
use crate::catalog::rows::FileRecord;
use crate::collation::js_string_order;
use crate::contract::{
    DuplicateCounts, DuplicateKind, DuplicateScope, DuplicateSet, DuplicateSetPage,
    DuplicateTotals, DuplicateVersion, FileFormat, FileId, KeepReason, RootId, Settings,
    deciding_versions,
};
use crate::similarity::{
    DisjointSets, Fingerprint, SimilarCluster, frames_show_variant, is_variant, normalize_detail,
};

/// A duplicate set as computed from the catalog, before the owner's dismissals apply.
#[derive(Clone, Debug, PartialEq)]
pub struct ComputedSet {
    /// The set, with no dismissal yet.
    pub set: DuplicateSet,
    pub file_ids: Vec<FileId>,
    /// Files the suggested resolution moves to holding.
    pub extra_copies: i64,
    /// Which those are.
    pub removable: Vec<FileId>,
    /// Spot variants found every version a picture of its own, so the set is not duplicates.
    pub variants: bool,
    /// With Spot variants on, the set's stills and how many of them have a print (or failed one)
    /// and no closer look still due.
    pub comparable: i64,
    pub compared: i64,
    /// Pairs the prints call copies that have had no closer look yet, smaller id first.
    pub awaiting: Vec<(FileId, FileId)>,
    /// A still has no print yet or a pair no answer, so nothing is known about the set. It keeps
    /// every file and waits out of every queue, where neither a suggestion to remove a picture nor
    /// a lasting "not duplicates" can be taken from it.
    pub checking: bool,
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
    let held_sources = held_sources(connection)?;
    let dismissals = Dismissals::load(connection)?;
    let stills: Vec<FileId> = records
        .iter()
        .filter(|record| is_still(record))
        .map(|record| record.id)
        .collect();
    let (details, readings) = if settings.spot_variants {
        let details = Details {
            prints: load_details(connection, &stills)?,
            comparisons: load_comparisons(connection, &stills)?,
        };
        (Some(details), Readings::new())
    } else {
        (None, load_readings(connection, &stills)?)
    };

    let mut sets: Vec<ComputedSet> = components
        .iter()
        .filter_map(|(distance, ids)| {
            let files: Vec<FileRecord> = ids
                .iter()
                .filter_map(|id| by_id.get(id).map(|record| (*record).clone()))
                .collect();
            let comparing = match &details {
                Some(details) => Comparing::Pictures(details),
                None => Comparing::Readings(&readings),
            };
            build_set(
                &files,
                *distance,
                settings,
                &held_sources,
                comparing,
                &dismissals,
            )
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

/// Each Shrink result whose original is still in holding, by path: its size and its original's
/// hash. Only these can say they lost nothing a holding could not give back.
type HeldSources = HashMap<String, (i64, String)>;

fn held_sources(connection: &Connection) -> anyhow::Result<HeldSources> {
    let mut statement = connection.prepare_cached(
        "SELECT s.to_abs, s.bytes_after, s.source_sha256 FROM plan_steps s
          JOIN holding h ON h.id = s.holding_id
          WHERE s.status = 'done' AND s.action = 'convert-video' AND h.state = 'held'
            AND s.source_sha256 IS NOT NULL AND s.to_abs IS NOT NULL AND s.bytes_after IS NOT NULL
          ORDER BY s.id",
    )?;
    let rows = statement.query_map([], |row| Ok((row.get(0)?, (row.get(1)?, row.get(2)?))))?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

/// What Spot variants has found about a set's stills.
struct Details {
    prints: HashMap<FileId, Option<Vec<u8>>>,
    comparisons: Comparisons,
}

/// What a set's versions are compared by.
#[derive(Clone, Copy)]
enum Comparing<'a> {
    /// Spot variants: which of them show different pictures.
    Pictures(&'a Details),
    /// Spot variants off: nothing judges that, but what a removal rests on must have been read.
    Readings(&'a Readings),
}

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
        .is_some_and(crate::similarity::is_still_print)
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

/// A version's print with the file it stands for: its copies hold the same bytes, so the smallest
/// id of those with a print, or `None` when none has one.
fn print_of(version: &Version, details: &Details) -> Option<(FileId, Vec<f32>)> {
    version
        .iter()
        .filter_map(|entry| {
            let id = entry.candidate.id;
            let print = details.prints.get(&id)?.as_deref()?;
            Some((id, print))
        })
        .min_by_key(|(id, _)| *id)
        .map(|(id, print)| (id, normalize_detail(print)))
}

/// Which picture each version shows, by content, and what is still to be found out.
struct Pictures {
    picture_of: HashMap<String, i64>,
    awaiting: Vec<(FileId, FileId)>,
    /// A still has no print yet, not even a failed one.
    unprinted: bool,
}

/// Two videos' lengths may differ by this for their sample frames to still line up.
const SAME_LENGTH_MS: f64 = 100.0;

/// Which piece of footage each version of a set of videos shows, by its sample frames, as
/// [`pictures_of`] sorts stills. Only videos of one size and length can tell; those that differ
/// stay one. `None` when a version is not a video, or when all of them show one piece of footage,
/// which is a set like any other.
fn footage_of(
    files: &[FileRecord],
    versions: &[Version],
    dismissals: &Dismissals,
) -> Option<Pictures> {
    struct Footage<'a> {
        record: &'a FileRecord,
        frames: Vec<crate::similarity::Hash64>,
        version: &'a Version,
    }
    let mut heads: Vec<Footage<'_>> = Vec::new();
    let mut picture_of = HashMap::new();
    let mut without_print: Vec<&Version> = Vec::new();
    for version in versions {
        // A new copy of a video joins by its bytes before it has a print of its own: any copy's
        // print speaks for the version.
        let Some(record) = version
            .iter()
            .map(|entry| &files[entry.record])
            .find(|record| record.fingerprint.is_some())
        else {
            without_print.push(version);
            continue;
        };
        let Some(Fingerprint::Motion { frames, .. }) =
            Fingerprint::parse(record.fingerprint.as_deref()?)
        else {
            return None;
        };
        let lines_up = |head: &FileRecord| {
            (head.width, head.height) == (record.width, record.height)
                && head
                    .duration_ms
                    .zip(record.duration_ms)
                    .is_some_and(|(left, right)| (left - right).abs() <= SAME_LENGTH_MS)
        };
        let joined = heads.iter().position(|head| {
            let distances: Vec<u32> = head
                .frames
                .iter()
                .zip(&frames)
                .map(|(left, right)| left.distance(*right))
                .collect();
            !said_apart(version, head.version, dismissals)
                && (!lines_up(head.record) || !frames_show_variant(&distances))
        });
        let picture = joined.unwrap_or_else(|| {
            heads.push(Footage {
                record,
                frames,
                version,
            });
            heads.len() - 1
        });
        picture_of.insert(content_of(record), picture as i64);
    }
    if heads.is_empty() {
        return None;
    }
    let mut unprinted = false;
    let mut pictures = heads.len() as i64;
    for version in &without_print {
        unprinted |= holds_for_print(files, version);
        picture_of.insert(content_of(&files[version.first()?.record]), pictures);
        pictures += 1;
    }
    (pictures > 1).then_some(Pictures {
        picture_of,
        awaiting: Vec::new(),
        unprinted,
    })
}

/// Whether a version without a print holds its set until it has one. A version with none shows a
/// picture nobody has compared yet, as when Convert has just rewritten it under the clusters kept
/// through the change, so nothing may be suggested about it. One whose print failed for good is
/// a picture of its own, and is not waited for, or the set would wait for ever.
fn holds_for_print(files: &[FileRecord], version: &Version) -> bool {
    version
        .iter()
        .any(|entry| files[entry.record].awaits_print())
}

/// Which picture each version shows. In ranked order, a version joins the first picture whose best
/// version it is a copy of (by its print, and a closer look agrees), or starts a picture when it is
/// a variant of all of them. A still whose print failed has its answer: it is a picture of its own,
/// which keeps the file, and among stills so is a version of frames alone. `None` when no version
/// holds a still to compare, and frames are all there is to go by.
fn pictures_of(
    files: &[FileRecord],
    versions: &[Version],
    details: &Details,
    dismissals: &Dismissals,
) -> Option<Pictures> {
    let holds_a_still = versions
        .iter()
        .flatten()
        .any(|entry| is_still(&files[entry.record]));
    let mut heads: Vec<(FileId, Vec<f32>, i64, &Version)> = Vec::new();
    let mut pictures = 0;
    let mut picture_of = HashMap::new();
    let mut awaiting = Vec::new();
    let mut unprinted = false;
    for version in versions {
        let first = version.first()?;
        let content = content_of(&files[first.record]);
        let stills: Vec<&Ranked> = version
            .iter()
            .filter(|entry| is_still(&files[entry.record]))
            .collect();
        if stills.is_empty() {
            let printless = version
                .iter()
                .all(|entry| files[entry.record].fingerprint.is_none());
            if !printless && !holds_a_still {
                return None;
            }
            unprinted |= printless && holds_for_print(files, version);
            picture_of.insert(content, pictures);
            pictures += 1;
            continue;
        }
        let Some((id, print)) = print_of(version, details) else {
            unprinted |= stills
                .iter()
                .any(|entry| !details.prints.contains_key(&entry.candidate.id));
            picture_of.insert(content, pictures);
            pictures += 1;
            continue;
        };
        let mut joined = None;
        for (picture, (head_id, head, _, head_version)) in heads.iter().enumerate() {
            if said_apart(version, head_version, dismissals) || is_variant(head, &print) {
                continue;
            }
            let pair = (id.min(*head_id), id.max(*head_id));
            match details.comparisons.get(&pair) {
                Some(false) => {
                    joined = Some(picture);
                    break;
                }
                Some(true) => {}
                // One look at a time: the version counts as this picture's for now, so those after
                // it are not compared with it too, and the set offers nothing until it is answered.
                None => {
                    awaiting.push(pair);
                    joined = Some(picture);
                    break;
                }
            }
        }
        match joined {
            Some(picture) => {
                picture_of.insert(content, heads[picture].2);
            }
            None => {
                picture_of.insert(content, pictures);
                heads.push((id, print, pictures, version));
                pictures += 1;
            }
        }
    }
    Some(Pictures {
        picture_of,
        awaiting,
        unprinted,
    })
}

/// Whether a still's fingerprint may rest on the Mac's hardware route, which reads damaged AVIFs
/// that libvips refuses. It goes by the bytes' brands, which HEIF files can also carry, and a file
/// not yet told apart could be either. Elsewhere there is no such route.
fn may_be_read_by_hardware(record: &FileRecord) -> bool {
    cfg!(target_os = "macos")
        && is_still(record)
        && matches!(
            record.format,
            None | Some(FileFormat::Avif) | Some(FileFormat::Heic)
        )
}

/// With Spot variants off a set keeps one file, whatever its versions show, but no removal may rest
/// on the hardware route alone: where one of a pair could have come through it, a closer look reads
/// both through libvips first. Any answer that read them will do; a pair it could not read is two
/// pictures, which keeps both. Identical bytes rest on their hash, and need no version of this.
/// `None` when there is one picture and nothing to wait for, which is the set as it always was.
fn read_pictures(
    files: &[FileRecord],
    versions: &[Version],
    readings: &Readings,
    dismissals: &Dismissals,
) -> Option<Pictures> {
    let mut heads: Vec<(FileId, bool, i64, &Version)> = Vec::new();
    let mut pictures = 0;
    let mut picture_of = HashMap::new();
    let mut awaiting = Vec::new();
    let mut unprinted = false;
    for version in versions {
        let first = version.first()?;
        let content = content_of(&files[first.record]);
        if version
            .iter()
            .all(|entry| files[entry.record].fingerprint.is_none())
        {
            unprinted |= holds_for_print(files, version);
            picture_of.insert(content, pictures);
            pictures += 1;
            continue;
        }
        // Only copies with prints count: one with none was not read by anything yet, and a closer
        // look stores no answer about it.
        let printed = || {
            version
                .iter()
                .filter(|entry| files[entry.record].fingerprint.is_some())
        };
        let id = printed().map(|entry| entry.candidate.id).min()?;
        let needs_reading = printed().any(|entry| may_be_read_by_hardware(&files[entry.record]));
        let mut joined = None;
        for (picture, (head_id, head_needs_reading, _, head_version)) in heads.iter().enumerate() {
            if said_apart(version, head_version, dismissals) {
                continue;
            }
            if !needs_reading && !head_needs_reading {
                joined = Some(picture);
                break;
            }
            let pair = (id.min(*head_id), id.max(*head_id));
            match readings.get(&pair) {
                Some(true) => {
                    joined = Some(picture);
                    break;
                }
                Some(false) => {}
                // One look at a time: the set offers nothing until it is answered.
                None => {
                    awaiting.push(pair);
                    joined = Some(picture);
                    break;
                }
            }
        }
        match joined {
            Some(picture) => {
                picture_of.insert(content, heads[picture].2);
            }
            None => {
                picture_of.insert(content, pictures);
                heads.push((id, needs_reading, pictures, version));
                pictures += 1;
            }
        }
    }
    (pictures > 1 || unprinted || !awaiting.is_empty()).then_some(Pictures {
        picture_of,
        awaiting,
        unprinted,
    })
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

/// A set's versions in order, and what comparing them has found.
struct GroupedPictures {
    versions: Vec<Version>,
    /// Each version's picture, when they were compared.
    pictures: Option<Vec<i64>>,
    awaiting: Vec<(FileId, FileId)>,
    /// A still has no print yet, not even a failed one.
    unprinted: bool,
}

/// What comparing these versions, in this order, finds: each is compared with the best version of
/// each picture before it. `None` when there is nothing to compare.
fn pictures_found(
    files: &[FileRecord],
    versions: &[Version],
    comparing: Comparing<'_>,
    dismissals: &Dismissals,
) -> Option<Pictures> {
    if versions.len() < 2 {
        return None;
    }
    match comparing {
        Comparing::Pictures(details) => footage_of(files, versions, dismissals)
            .or_else(|| pictures_of(files, versions, details, dismissals)),
        Comparing::Readings(readings) => read_pictures(files, versions, readings, dismissals),
    }
}

/// Whether the owner said a file of one version is no duplicate of a file of the other: "Keep
/// these" holds in any set they later fall into, so those are two pictures, whatever prints and
/// closer looks say.
fn said_apart(left: &Version, right: &Version, dismissals: &Dismissals) -> bool {
    left.iter().any(|one| {
        right
            .iter()
            .any(|other| dismissals.apart(one.candidate.id, other.candidate.id))
    })
}

/// Versions grouped into pictures, picture by picture with each one's best version first, and the
/// home folder ranking copies; versions alone when there is nothing to compare.
///
/// The home folder is found from a first sorting, and changes which version is best. Pictures are
/// then worked out again in the new order, so each version going has been compared with the one
/// staying: thresholds do not chain, so a copy of a copy may not be a copy. This is two sortings,
/// never more, so it cannot go round; each pair either asks for is one a closer look answers once.
fn group_pictures(
    files: &[FileRecord],
    candidates: &[Ranked],
    comparing: Comparing<'_>,
    dismissals: &Dismissals,
) -> GroupedPictures {
    let versions = versions_of(files, rank_keepers(candidates).0);
    let Some(first) = pictures_found(files, &versions, comparing, dismissals) else {
        return GroupedPictures {
            versions,
            pictures: None,
            awaiting: Vec::new(),
            unprinted: false,
        };
    };

    let flat: Vec<&Ranked> = versions.iter().flatten().collect();
    let home = home_folder(files, &flat, &first.picture_of);
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
    let ids = |versions: &[Version]| -> Vec<FileId> {
        versions
            .iter()
            .flatten()
            .map(|entry| entry.candidate.id)
            .collect()
    };
    let (picture_of, mut awaiting, unprinted) = if ids(&reranked) == ids(&versions) {
        (first.picture_of, first.awaiting, first.unprinted)
    } else {
        let Some(second) = pictures_found(files, &reranked, comparing, dismissals) else {
            // The versions all show one picture, seen from the version that stays.
            return GroupedPictures {
                versions: reranked,
                pictures: None,
                awaiting: first.awaiting,
                unprinted: first.unprinted,
            };
        };
        let mut awaiting = second.awaiting;
        awaiting.extend(first.awaiting);
        (
            second.picture_of,
            awaiting,
            second.unprinted || first.unprinted,
        )
    };
    awaiting.sort_unstable();
    awaiting.dedup();

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
    GroupedPictures {
        versions: numbered.into_iter().map(|(version, _)| version).collect(),
        pictures: Some(pictures),
        awaiting,
        unprinted,
    }
}

fn build_set(
    files: &[FileRecord],
    distance: u32,
    settings: &Settings,
    held_sources: &HeldSources,
    comparing: Comparing<'_>,
    dismissals: &Dismissals,
) -> Option<ComputedSet> {
    let candidates: Vec<Ranked> = files
        .iter()
        .enumerate()
        .map(|(index, record)| {
            let mut candidate = to_keeper_candidate(record, settings);
            if record.reencoded
                && let Some((size, source)) =
                    held_sources.get(record.abs_path().to_string_lossy().as_ref())
                && *size == record.size
            {
                candidate.reencoded_from = Some(source.clone());
            }
            Ranked {
                candidate,
                record: index,
            }
        })
        .collect();
    let GroupedPictures {
        versions,
        pictures,
        awaiting,
        unprinted,
    } = group_pictures(files, &candidates, comparing, dismissals);
    let details = match comparing {
        Comparing::Pictures(details) => Some(details),
        Comparing::Readings(_) => None,
    };
    let checking = unprinted || !awaiting.is_empty();
    let pictures = pictures.filter(|_| !checking);
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

    // Each picture keeps its best version's best copy; without pictures, the set keeps one file,
    // unless what they are is still being found out, when it keeps them all.
    let mut keep: Vec<FileId> = match &pictures {
        None if checking => files.iter().map(|record| record.id).collect(),
        None => vec![best.candidate.id],
        Some(pictures) => versions
            .iter()
            .enumerate()
            .filter(|(index, _)| *index == 0 || pictures[*index] != pictures[index - 1])
            .filter_map(|(_, version)| version.first().map(|entry| entry.candidate.id))
            .collect(),
    };

    // Identical copies are one version, but the owner's word holds for them too.
    let kept_apart: Vec<FileId> = files
        .iter()
        .map(|record| record.id)
        .filter(|id| !keep.contains(id) && keep.iter().any(|kept| dismissals.apart(*kept, *id)))
        .collect();
    keep.extend(kept_apart);

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
        .filter(|record| {
            details.is_some_and(|details| details.prints.contains_key(&record.id))
                && !awaiting
                    .iter()
                    .any(|pair| pair.0 == record.id || pair.1 == record.id)
        })
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
        key: format!("set:{}", file_ids.iter().min().copied().unwrap_or_default()),
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
        removable: removed.iter().map(|record| record.id).collect(),
        variants,
        comparable: stills.len() as i64,
        compared: compared as i64,
        awaiting,
        checking,
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
    if entry.checking {
        return false;
    }
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

/// The stills Spot variants should print: those of similar sets the owner has not dismissed that
/// it has not already found to be all variants.
pub fn stills_to_print(computed: &[ComputedSet], dismissals: &Dismissals) -> Vec<FileId> {
    computed
        .iter()
        .filter(|entry| {
            entry.set.kind == DuplicateKind::Similar
                && !entry.variants
                && dismissals.covering(&entry.file_ids).is_none()
        })
        .flat_map(|entry| entry.file_ids.iter().copied())
        .collect()
}

/// The pairs waiting for a closer look in sets the owner has not dismissed.
pub fn pairs_to_compare(
    computed: &[ComputedSet],
    dismissals: &Dismissals,
) -> Vec<(FileId, FileId)> {
    computed
        .iter()
        .filter(|entry| dismissals.covering(&entry.file_ids).is_none())
        .flat_map(|entry| entry.awaiting.iter().copied())
        .collect()
}

/// Whether a set the owner has not dismissed is still being checked.
pub fn checking_sets(computed: &[ComputedSet], dismissals: &Dismissals) -> bool {
    computed
        .iter()
        .any(|entry| entry.checking && dismissals.covering(&entry.file_ids).is_none())
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
        } else if entry.checking {
            counts.checking += 1;
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
    use std::sync::atomic::{AtomicU64, Ordering};

    use super::*;
    use crate::catalog::Catalog;
    use crate::contract::{SimilarityLevel, is_close_call};
    use crate::duplicates::queries::compute_similar_clusters;
    use crate::similarity::ClusterKind;
    use crate::similarity::DETAIL_VERSION;
    use crate::similarity::FINGERPRINT_VERSION;
    use crate::similarity::detail::DETAIL_SIZE;

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

    /// Tells scratch folders apart: macOS clocks tick in microseconds, too coarse for tests that
    /// run in parallel, and two tests sharing a catalog fail with `database is locked`.
    static SCRATCH_COUNT: AtomicU64 = AtomicU64::new(0);

    fn catalog(stills: &[Still]) -> Scratch {
        let folder = std::env::temp_dir().join(format!(
            "oriel-tidy-sets-{}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
            SCRATCH_COUNT.fetch_add(1, Ordering::Relaxed)
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

    /// Records what a closer look at two stills found.
    fn compare(scratch: &Scratch, left: FileId, right: FileId, variant: bool) {
        scratch
            .catalog
            .blocking(move |connection| {
                connection.execute(
                    "INSERT INTO file_comparisons (left_id, right_id, version, left_size,
                       left_mtime_ms, right_size, right_mtime_ms, variant)
                     SELECT l.id, r.id, ?3, l.size, l.mtime_ms, r.size, r.mtime_ms, ?4
                       FROM files l, files r WHERE l.id = ?1 AND r.id = ?2",
                    rusqlite::params![left, right, DETAIL_VERSION, variant],
                )?;
                Ok(())
            })
            .unwrap();
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

    /// Says what a file is by its bytes, as a scan does.
    fn is_format(scratch: &Scratch, ids: &[FileId], format: &'static str) {
        let ids = ids.to_vec();
        scratch
            .catalog
            .blocking(move |connection| {
                for id in ids {
                    connection.execute(
                        "UPDATE files SET format = ?1 WHERE id = ?2",
                        rusqlite::params![format, id],
                    )?;
                }
                Ok(())
            })
            .unwrap();
    }

    /// Records a pair that could not be read.
    fn could_not_read(scratch: &Scratch, left: FileId, right: FileId) {
        compare(scratch, left, right, false);
        scratch
            .catalog
            .blocking(move |connection| {
                connection.execute(
                    "UPDATE file_comparisons SET variant = 2 WHERE left_id = ?1 AND right_id = ?2",
                    [left, right],
                )?;
                Ok(())
            })
            .unwrap();
    }

    /// With Spot variants off nothing judges whether two stills differ, but a removal still may not
    /// rest on the hardware route, which reads damaged AVIFs: libvips reads them first.
    #[test]
    fn with_spot_variants_off_an_avif_is_read_before_anything_goes() {
        let scratch = catalog(&[
            still(1, "a/photo.avif", "aa", 0),
            Still {
                size: 5000,
                ..still(2, "b/photo.png", "bb", 0b1)
            },
        ]);
        is_format(&scratch, &[1], "avif");

        let waiting = sets(&scratch, SimilarityLevel::Balanced, false);
        assert_eq!(waiting[0].awaiting, [(1, 2)]);
        assert!(waiting[0].checking);
        assert_eq!(waiting[0].set.keep, [1, 2]);
        assert!(waiting[0].removable.is_empty());

        // Unread keeps both, whichever would have been kept.
        could_not_read(&scratch, 1, 2);
        let unread = sets(&scratch, SimilarityLevel::Balanced, false);
        assert!(!unread[0].checking);
        assert_eq!(unread[0].set.keep.len(), 2);
        assert!(unread[0].removable.is_empty());
        assert_eq!(unread[0].set.reclaimable_bytes, 0);
    }

    #[test]
    fn with_spot_variants_off_any_answer_that_read_the_files_is_enough() {
        for different_pictures in [false, true] {
            let scratch = catalog(&[
                still(1, "a/photo.avif", "aa", 0),
                Still {
                    size: 5000,
                    ..still(2, "b/photo.png", "bb", 0b1)
                },
            ]);
            is_format(&scratch, &[1], "avif");
            compare(&scratch, 1, 2, different_pictures);
            let read = sets(&scratch, SimilarityLevel::Balanced, false);
            assert!(!read[0].checking);
            assert_eq!(read[0].set.keep, [1], "the judgement stays off");
            assert_eq!(read[0].set.pictures, None);
            assert_eq!(read[0].set.keep_reason, KeepReason::ArchiveFormat);
            assert_eq!(read[0].removable, [2]);
        }
    }

    /// What the hardware route cannot have read needs no reading, and identical bytes rest on
    /// their hash, so Spot variants off costs nothing there.
    #[test]
    fn with_spot_variants_off_only_files_the_hardware_route_can_print_wait() {
        let pngs = catalog(&[
            still(1, "a/photo.png", "aa", 0),
            Still {
                size: 5000,
                ..still(2, "b/photo.png", "bb", 0b1)
            },
        ]);
        let plain = sets(&pngs, SimilarityLevel::Balanced, false);
        assert!(plain[0].awaiting.is_empty());
        assert_eq!(plain[0].set.keep, [2]);

        let copies = catalog(&[
            still(1, "a/photo.avif", "aa", 0),
            still(2, "b/photo.avif", "aa", 0),
        ]);
        is_format(&copies, &[1, 2], "avif");
        let identical = sets(&copies, SimilarityLevel::Balanced, false);
        assert_eq!(identical[0].set.kind, DuplicateKind::Exact);
        assert!(identical[0].awaiting.is_empty());
        assert!(!identical[0].checking);
        assert_eq!(identical[0].removable.len(), 1);
    }

    /// An animated AVIF's and a video's frames never come through the hardware route.
    #[test]
    fn with_spot_variants_off_frames_are_not_waited_for() {
        let scratch = catalog(&[
            still(1, "a/clip.avif", "aa", 0),
            Still {
                size: 5000,
                ..still(2, "b/clip.mp4", "bb", 0b1)
            },
        ]);
        is_format(&scratch, &[1], "avif");
        scratch
            .catalog
            .blocking(|connection| {
                let frames = ["0000000000000000"; 5].join(".");
                connection.execute(
                    "UPDATE files SET fingerprint = ?1, duration_ms = 60000",
                    [format!("m:60000:{frames}")],
                )?;
                Ok(())
            })
            .unwrap();
        let moving = sets(&scratch, SimilarityLevel::Balanced, false);
        assert_eq!(moving.len(), 1);
        assert!(moving[0].awaiting.is_empty());
        assert!(!moving[0].checking);
        assert_eq!(moving[0].removable.len(), 1);
    }

    /// Gives a file's copy a print that failed, as a failed read or a stopped pass leaves it.
    fn print_failed(scratch: &Scratch, id: FileId) {
        scratch
            .catalog
            .blocking(move |connection| {
                connection.execute(
                    "UPDATE files SET fingerprint = NULL, fingerprint_error = 'unread' WHERE id = ?1",
                    [id],
                )?;
                Ok(())
            })
            .unwrap();
    }

    /// The copy ranked first has no print and its twin has one from the hardware route: the twin
    /// is what must be read, and is what a closer look can store an answer about.
    #[test]
    fn with_spot_variants_off_a_version_is_judged_by_its_copies_with_prints() {
        let scratch = catalog(&[
            still(1, "a/photo.avif", "aa", 0),
            still(2, "bb/photo.avif", "aa", 0),
            Still {
                size: 500,
                ..still(3, "c/photo.png", "cc", 0b1)
            },
        ]);
        is_format(&scratch, &[1, 2], "avif");
        print_failed(&scratch, 1);
        let clusters = vec![SimilarCluster {
            kind: ClusterKind::Image,
            distance: 1,
            ids: vec![1, 2, 3],
        }];
        let settings = Settings {
            spot_variants: false,
            ..Settings::default()
        };
        let build = |scratch: &Scratch| {
            let (settings, clusters) = (settings.clone(), clusters.clone());
            scratch
                .catalog
                .blocking(move |connection| {
                    build_duplicate_sets(connection, Some(1), &settings, &clusters)
                })
                .unwrap()
        };
        let waiting = build(&scratch);
        assert_eq!(waiting[0].awaiting, [(2, 3)]);
        assert!(waiting[0].removable.is_empty());

        could_not_read(&scratch, 2, 3);
        let unread = build(&scratch);
        assert!(!unread[0].checking);
        assert!(unread[0].set.keep.contains(&3), "the PNG stays");
    }

    /// A closer look stores no answer about a file with no print. Whatever a set's copies have,
    /// what it waits for can be answered, so no set is hidden for good.
    #[test]
    fn with_spot_variants_off_every_pair_waited_for_can_be_answered() {
        let mut state = 0x0bad_cafe_dead_beef_u64;
        let mut next = move |below: u64| {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            state % below
        };
        let paths = [
            "a/1.avif", "b/2.avif", "c/3.avif", "d/4.avif", "e/5.avif", "f/6.avif",
        ];
        let contents = ["aa", "aa", "bb", "bb", "cc", "dd"];
        let mut held_back = 0;
        for _ in 0..100 {
            let stills: Vec<Still> = (0..6)
                .map(|index: usize| still(index as FileId + 1, paths[index], contents[index], 0))
                .collect();
            let scratch = catalog(&stills);
            is_format(&scratch, &[1, 2, 3, 4, 5, 6], "avif");
            let mut printless = Vec::new();
            for id in 1..=6 {
                if next(3) == 0 {
                    print_failed(&scratch, id);
                    printless.push(id);
                    held_back += 1;
                }
            }
            let clusters = vec![SimilarCluster {
                kind: ClusterKind::Image,
                distance: 0,
                ids: vec![1, 2, 3, 4, 5, 6],
            }];
            let settings = Settings {
                spot_variants: false,
                ..Settings::default()
            };
            for _ in 0..16 {
                let (settings, clusters) = (settings.clone(), clusters.clone());
                let found = scratch
                    .catalog
                    .blocking(move |connection| {
                        build_duplicate_sets(connection, Some(1), &settings, &clusters)
                    })
                    .unwrap();
                let Some(set) = found.first() else {
                    break;
                };
                if set.awaiting.is_empty() {
                    break;
                }
                for &(left, right) in &set.awaiting {
                    assert!(
                        !printless.contains(&left) && !printless.contains(&right),
                        "({left}, {right}) has no print, so no answer can be stored"
                    );
                    compare(&scratch, left, right, false);
                }
            }
        }
        assert!(held_back > 0);
    }

    /// A mixed set, which nothing makes today: stills are still compared, and a video among them is
    /// a picture of its own, rather than the whole set keeping one file.
    #[test]
    fn a_motion_only_version_is_a_picture_of_its_own_among_stills() {
        let scratch = catalog(&[
            Still {
                detail: Some(print()),
                ..still(1, "a/photo.png", "aa", 0)
            },
            Still {
                size: 3000,
                detail: Some(print()),
                ..still(2, "b/photo.png", "bb", 0b1)
            },
            Still {
                size: 9000,
                ..still(3, "c/clip.mp4", "mm", 0)
            },
            Still {
                size: 9000,
                ..still(4, "d/clip.mp4", "mm", 0)
            },
        ]);
        scratch
            .catalog
            .blocking(|connection| {
                let frames = ["0000000000000000"; 5].join(".");
                connection.execute(
                    "UPDATE files SET fingerprint = ?1, duration_ms = 60000, kind = 'video'
                      WHERE id IN (3, 4)",
                    [format!("m:60000:{frames}")],
                )?;
                Ok(())
            })
            .unwrap();
        let clusters = vec![SimilarCluster {
            kind: ClusterKind::Image,
            distance: 1,
            ids: vec![1, 2, 3, 4],
        }];
        let waiting = built(&scratch, clusters.clone());
        assert_eq!(waiting[0].awaiting, [(1, 2)]);
        assert!(waiting[0].removable.is_empty());

        compare(&scratch, 1, 2, false);
        let settled = built(&scratch, clusters);
        assert!(!settled[0].checking);
        let mut removable = settled[0].removable.clone();
        removable.sort_unstable();
        // One of the two copies of the clip, and the smaller of the two stills; never a picture.
        assert_eq!(removable.len(), 2, "{:?}", settled[0].set.keep);
        assert!(settled[0].set.keep.contains(&2));
        assert!(settled[0].set.keep.iter().any(|id| [3, 4].contains(id)));
    }

    /// `count` versions of one still, in folders of their own.
    fn versions_of_one_still(count: usize, ext: &str) -> Scratch {
        let stills: Vec<Still> = (0..count)
            .map(|index| {
                let path: &'static str =
                    Box::leak(format!("f{index}/photo.{ext}").into_boxed_str());
                let sha: &'static str = Box::leak(format!("sha{index}").into_boxed_str());
                Still {
                    size: 1000 + index as i64,
                    detail: Some(print()),
                    ..still(index as FileId + 1, path, sha, 0)
                }
            })
            .collect();
        catalog(&stills)
    }

    /// Answers everything the set waits for, as each round of closer looks does, until it waits for
    /// nothing; returns how many pairs it asked about, and in how many rounds.
    fn looks_until_settled(scratch: &Scratch, spot: bool, different: bool) -> (usize, usize) {
        let (mut asked, mut rounds) = (0, 0);
        loop {
            let found = sets(scratch, SimilarityLevel::Balanced, spot);
            if found[0].awaiting.is_empty() {
                return (asked, rounds);
            }
            rounds += 1;
            for &(left, right) in &found[0].awaiting {
                compare(scratch, left, right, different);
                asked += 1;
            }
        }
    }

    /// Versions that are copies take one look each: what a decision waits for grows with the set,
    /// and not with its square.
    #[test]
    fn a_first_look_asks_once_for_each_version_that_is_a_copy() {
        let on = versions_of_one_still(60, "png");
        assert_eq!(looks_until_settled(&on, true, false), (59, 1));
        let settled = sets(&on, SimilarityLevel::Balanced, true);
        assert_eq!(settled[0].removable.len(), 59);

        let off = versions_of_one_still(60, "avif");
        let ids: Vec<FileId> = (1..=60).collect();
        is_format(&off, &ids, "avif");
        assert_eq!(looks_until_settled(&off, false, false), (59, 1));

        // Reading is all it needs with Spot variants off, whatever the look thought of them.
        let judged = versions_of_one_still(60, "avif");
        is_format(&judged, &ids, "avif");
        assert_eq!(looks_until_settled(&judged, false, true), (59, 1));
    }

    /// All different takes every pair, a round for each picture, and removes nothing.
    #[test]
    fn versions_that_all_differ_are_asked_about_until_each_is_a_picture() {
        let scratch = versions_of_one_still(8, "png");
        assert_eq!(looks_until_settled(&scratch, true, true), (28, 7));
        let settled = sets(&scratch, SimilarityLevel::Balanced, true);
        assert!(settled[0].removable.is_empty());
        assert_eq!(settled[0].set.keep.len(), 8);
    }

    /// Records the owner's "Keep these".
    fn keep_these(scratch: &Scratch, ids: &'static [FileId]) {
        scratch
            .catalog
            .blocking(move |connection| {
                crate::duplicates::add_dismissal(connection, ids, None)?;
                Ok(())
            })
            .unwrap();
    }

    fn removable_sorted(set: &ComputedSet) -> Vec<FileId> {
        let mut removable = set.removable.clone();
        removable.sort_unstable();
        removable
    }

    /// The set gained a file, so it comes back, but what the owner said to keep is still kept:
    /// here with no print or look to go by.
    #[test]
    fn with_spot_variants_off_a_dismissed_pair_stays_two_pictures() {
        let scratch = catalog(&[
            Still {
                size: 3000,
                ..still(1, "a/photo.png", "aa", 0)
            },
            Still {
                size: 2000,
                ..still(2, "b/photo.png", "bb", 0b1)
            },
            still(3, "c/photo.png", "cc", 0b11),
        ]);
        let before = sets(&scratch, SimilarityLevel::Balanced, false);
        assert_eq!(removable_sorted(&before[0]), [2, 3]);

        keep_these(&scratch, &[1, 2]);
        let after = sets(&scratch, SimilarityLevel::Balanced, false);
        let mut keep = after[0].set.keep.clone();
        keep.sort_unstable();
        assert_eq!(keep, [1, 2]);
        assert_eq!(after[0].removable, [3]);
        assert_eq!(after[0].set.pictures.as_deref(), Some(&[0, 0, 1][..]));
    }

    /// A copy-by-look answer does not outrank the owner's word.
    #[test]
    fn with_spot_variants_on_a_dismissed_pair_stays_two_pictures() {
        let scratch = catalog(&[
            Still {
                size: 3000,
                detail: Some(print()),
                ..still(1, "a/photo.png", "aa", 0)
            },
            Still {
                size: 2000,
                detail: Some(print()),
                ..still(2, "b/photo.png", "bb", 0b1)
            },
            Still {
                detail: Some(print()),
                ..still(3, "c/photo.png", "cc", 0b11)
            },
        ]);
        compare(&scratch, 1, 2, false);
        compare(&scratch, 1, 3, false);
        keep_these(&scratch, &[1, 2]);
        let after = sets(&scratch, SimilarityLevel::Balanced, true);
        assert!(!after[0].checking);
        assert_eq!(after[0].removable, [3]);
        assert!(
            after[0].awaiting.is_empty(),
            "no look is asked for the pair"
        );
    }

    #[test]
    fn identical_copies_the_owner_kept_stay_when_another_arrives() {
        let scratch = catalog(&[
            still(1, "a/photo.png", "aa", 0),
            still(2, "b/photo.png", "aa", 0),
            still(3, "c/photo.png", "aa", 0),
        ]);
        keep_these(&scratch, &[1, 2]);
        let after = sets(&scratch, SimilarityLevel::Balanced, false);
        assert_eq!(after[0].set.kind, DuplicateKind::Exact);
        assert_eq!(after[0].removable, [3]);
    }

    /// Video too, by its frames.
    #[test]
    fn videos_the_owner_kept_stay_two_pictures() {
        let scratch = catalog(&[
            Still {
                size: 3000,
                ..still(1, "a/clip.mp4", "aa", 0)
            },
            still(2, "b/clip.mp4", "bb", 0),
        ]);
        scratch
            .catalog
            .blocking(|connection| {
                let frames = ["0000000000000000"; 5].join(".");
                connection.execute(
                    "UPDATE files SET kind = 'video', fingerprint = ?1, duration_ms = 60000",
                    [format!("m:60000:{frames}")],
                )?;
                Ok(())
            })
            .unwrap();
        assert_eq!(
            sets(&scratch, SimilarityLevel::Balanced, true)[0].removable,
            [2]
        );
        keep_these(&scratch, &[1, 2]);
        let dismissed = sets(&scratch, SimilarityLevel::Balanced, true);
        assert!(dismissed[0].removable.is_empty());
    }

    /// B, the head at first by its size, and C each a copy of A only; D another picture in B's
    /// folder, which makes that folder home and B the file kept. C may only go once it has been
    /// compared with B, what it would go in favour of.
    #[test]
    fn a_file_goes_only_after_a_closer_look_against_the_file_kept() {
        let scratch = catalog(&[
            Still {
                size: 9000,
                detail: Some(print()),
                ..still(1, "a/photo.png", "aa", 0)
            },
            Still {
                size: 5000,
                detail: Some(print()),
                ..still(2, "b/photo.png", "bb", 0b1)
            },
            Still {
                size: 3000,
                detail: Some(print()),
                ..still(3, "c/photo.png", "cc", 0b11)
            },
            Still {
                size: 2000,
                detail: Some(print_with_patch()),
                ..still(4, "b/other.png", "dd", 0b111)
            },
        ]);
        compare(&scratch, 1, 2, false);
        compare(&scratch, 1, 3, false);
        let held = sets(&scratch, SimilarityLevel::Balanced, true);
        assert_eq!(held[0].awaiting, [(2, 3)], "{:?}", held[0].removable);
        assert!(held[0].checking);
        assert!(held[0].removable.is_empty());

        // A copy of the file kept: it goes.
        compare(&scratch, 2, 3, false);
        let settled = sets(&scratch, SimilarityLevel::Balanced, true);
        assert!(settled[0].awaiting.is_empty());
        assert_eq!(settled[0].set.keep, [2, 4]);
        let mut removable = settled[0].removable.clone();
        removable.sort_unstable();
        assert_eq!(removable, [1, 3]);
    }

    /// The same, where the file kept shows C to be a picture of its own: thresholds do not chain.
    #[test]
    fn a_copy_of_a_copy_can_be_a_picture_of_its_own() {
        let scratch = catalog(&[
            Still {
                size: 9000,
                detail: Some(print()),
                ..still(1, "a/photo.png", "aa", 0)
            },
            Still {
                size: 5000,
                detail: Some(print()),
                ..still(2, "b/photo.png", "bb", 0b1)
            },
            Still {
                size: 3000,
                detail: Some(print()),
                ..still(3, "c/photo.png", "cc", 0b11)
            },
            Still {
                size: 2000,
                detail: Some(print_with_patch()),
                ..still(4, "b/other.png", "dd", 0b111)
            },
        ]);
        compare(&scratch, 1, 2, false);
        compare(&scratch, 1, 3, false);
        compare(&scratch, 2, 3, true);
        let set = &sets(&scratch, SimilarityLevel::Balanced, true)[0];
        assert!(!set.checking);
        assert!(set.set.keep.contains(&3), "{:?}", set.set.keep);
        assert_eq!(set.removable, [1]);
    }

    /// Answering what a set waits for, however it answers, ends in a set that waits for nothing
    /// and removes a file only for a copy kept that it was compared with.
    #[test]
    fn every_set_settles_and_every_removal_rests_on_a_look_at_the_file_kept() {
        let mut state = 0x0123_4567_89ab_cdef_u64;
        let mut next = move |below: u64| {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            state % below
        };
        let folders = [
            "a/1.png", "a/2.png", "b/1.png", "b/2.png", "c/1.png", "c/2.png",
        ];
        for _ in 0..40 {
            let stills: Vec<Still> = (0..6)
                .map(|index| Still {
                    size: 1000 + next(5) as i64 * 500,
                    detail: Some(if next(4) == 0 {
                        print_with_patch()
                    } else {
                        print()
                    }),
                    ..still(
                        index + 1,
                        folders[index as usize],
                        ["aa", "bb", "cc", "dd", "ee", "ff"][index as usize],
                        index as u64,
                    )
                })
                .collect();
            let scratch = catalog(&stills);
            let mut asked = 0;
            let settled = loop {
                let found = sets(&scratch, SimilarityLevel::Balanced, true);
                assert_eq!(found.len(), 1);
                if found[0].awaiting.is_empty() {
                    break found.into_iter().next().unwrap();
                }
                for &(left, right) in &found[0].awaiting {
                    let answered: i64 = scratch
                        .catalog
                        .blocking(move |connection| {
                            Ok(connection.query_row(
                                "SELECT COUNT(*) FROM file_comparisons
                                  WHERE left_id = ?1 AND right_id = ?2",
                                [left, right],
                                |row| row.get(0),
                            )?)
                        })
                        .unwrap();
                    assert_eq!(answered, 0, "asked twice about ({left}, {right})");
                    compare(&scratch, left, right, next(3) == 0);
                    asked += 1;
                }
                assert!(asked <= 15, "more asked than there are pairs");
            };
            assert!(!settled.checking);
            let answers: Vec<(FileId, FileId, bool)> = scratch
                .catalog
                .blocking(|connection| {
                    let mut statement = connection
                        .prepare("SELECT left_id, right_id, variant FROM file_comparisons")?;
                    let rows = statement
                        .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?;
                    Ok(rows.collect::<rusqlite::Result<_>>()?)
                })
                .unwrap();
            for &removed in &settled.removable {
                assert!(
                    settled.set.keep.iter().any(|&kept| {
                        let pair = (kept.min(removed), kept.max(removed));
                        answers.contains(&(pair.0, pair.1, false))
                    }),
                    "{removed} goes for {:?} with no look: {answers:?}",
                    settled.set.keep
                );
            }
        }
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
        assert_eq!(set.set.key, "set:1");
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

        // The print calls the other site's file a copy, but nothing is offered for removal on its
        // word alone: until a closer look agrees, the set keeps everything and is being checked.
        let waiting = sets(&scratch, SimilarityLevel::Balanced, true);
        assert_eq!(waiting[0].awaiting, [(1, 3)]);
        assert!(waiting[0].checking);
        assert!(!waiting[0].variants);
        assert_eq!(waiting[0].set.keep.len(), 3);
        assert_eq!(waiting[0].extra_copies, 0);
        assert_eq!(waiting[0].set.reclaimable_bytes, 0);
        assert_eq!((waiting[0].comparable, waiting[0].compared), (3, 1));

        compare(&scratch, 1, 3, false);
        let on = sets(&scratch, SimilarityLevel::Balanced, true);
        assert_eq!(on.len(), 1, "{on:#?}");
        let computed = &on[0];
        assert!(computed.awaiting.is_empty());
        assert!(!computed.checking);
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
    fn a_closer_look_overrules_a_print_until_a_file_changes() {
        let scratch = catalog(&[
            Still {
                detail: Some(print()),
                ..still(1, "alt/eyes-open.png", "aa", 0)
            },
            Still {
                detail: Some(print()),
                ..still(2, "alt/eyes-closed.png", "bb", 0b1)
            },
        ]);
        compare(&scratch, 1, 2, true);
        let on = sets(&scratch, SimilarityLevel::Balanced, true);
        assert!(on[0].variants);
        assert_eq!(on[0].set.keep.len(), 2);
        assert!(on[0].awaiting.is_empty());

        // A file that changed has no answer any more, so its pair waits for another look.
        scratch
            .catalog
            .blocking(|connection| {
                connection.execute("UPDATE files SET size = 2000 WHERE id = 2", [])?;
                connection.execute("UPDATE file_details SET size = 2000 WHERE file_id = 2", [])?;
                Ok(())
            })
            .unwrap();
        let changed = sets(&scratch, SimilarityLevel::Balanced, true);
        assert_eq!(changed[0].awaiting, [(1, 2)]);
        assert!(changed[0].checking);
    }

    /// How many prints and answers the catalog holds.
    fn details_kept(scratch: &Scratch) -> (i64, i64) {
        scratch
            .catalog
            .blocking(|connection| {
                Ok((
                    connection
                        .query_row("SELECT COUNT(*) FROM file_details", [], |row| row.get(0))?,
                    connection.query_row("SELECT COUNT(*) FROM file_comparisons", [], |row| {
                        row.get(0)
                    })?,
                ))
            })
            .unwrap()
    }

    #[test]
    fn prints_and_answers_go_when_tidy_takes_a_file_as_changed_even_at_one_size_and_date() {
        let answered = || {
            let scratch = catalog(&[
                Still {
                    detail: Some(print()),
                    ..still(1, "alt/a.png", "aa", 0)
                },
                Still {
                    detail: Some(print()),
                    ..still(2, "alt/b.png", "bb", 0b1)
                },
            ]);
            compare(&scratch, 1, 2, false);
            assert_eq!(details_kept(&scratch), (2, 1));
            scratch
        };
        // A conversion or a scan clears the fingerprint, whatever the size and date came to be.
        let converted = answered();
        converted
            .catalog
            .blocking(|connection| {
                connection.execute("UPDATE files SET fingerprint = NULL WHERE id = 2", [])?;
                Ok(())
            })
            .unwrap();
        assert_eq!(details_kept(&converted), (1, 0));
        // An undo points the row back at the original.
        let undone = answered();
        undone
            .catalog
            .blocking(|connection| {
                let root_id: i64 =
                    connection.query_row("SELECT root_id FROM files WHERE id = 1", [], |row| {
                        row.get(0)
                    })?;
                crate::catalog::files::point_back_at_original(
                    connection,
                    root_id,
                    "alt/a.png",
                    "alt/a.jpg",
                )
            })
            .unwrap();
        assert_eq!(details_kept(&undone), (1, 0));
        // A new fingerprint alone says nothing about the bytes; nor does a move.
        let moved = answered();
        moved
            .catalog
            .blocking(|connection| {
                connection.execute(
                    "UPDATE files SET rel_path = 'alt/c.png', name = 'c.png', ctime_ms = 5,
                       fingerprint = 's:0000000000000003' WHERE id = 2",
                    [],
                )?;
                Ok(())
            })
            .unwrap();
        assert_eq!(details_kept(&moved), (2, 1));
    }

    #[test]
    fn a_set_being_checked_offers_nothing_and_waits_outside_every_queue() {
        let scratch = catalog(&[
            Still {
                detail: Some(print()),
                ..still(1, "alt/a.png", "aa", 0)
            },
            still(2, "alt/b.png", "bb", 0b1111),
            still(3, "other/c.png", "cc", u64::MAX),
            Still {
                ino: "9".into(),
                ..still(4, "other/c-again.png", "cc", u64::MAX)
            },
        ]);
        let computed = sets(&scratch, SimilarityLevel::Balanced, true);
        let dismissals = Dismissals::default();
        let held = computed
            .iter()
            .find(|entry| entry.set.kind == DuplicateKind::Similar)
            .unwrap();
        assert!(held.checking);
        assert_eq!(held.set.pictures, None);
        assert_eq!(held.set.keep.len(), 2);
        assert_eq!(held.extra_copies, 0);
        assert!(held.removable.is_empty());
        assert_eq!(held.set.reclaimable_bytes, 0);
        for (scope, count) in [
            (DuplicateScope::Similar, 0),
            (DuplicateScope::Variants, 0),
            // Identical bytes need no comparing, so they stay open.
            (DuplicateScope::Exact, 1),
            (DuplicateScope::All, 1),
        ] {
            let page = page_duplicate_sets(
                &computed,
                &dismissals,
                PageRequest {
                    scope,
                    dismissed: false,
                    offset: 0,
                    limit: 10,
                },
            );
            assert_eq!(page.total, count, "{scope:?}");
            assert_eq!(page.counts.checking, 1);
            assert_eq!(page.counts.similar, 0);
            assert_eq!(page.counts.variants, 0);
            assert_eq!(page.counts.exact, 1);
        }
        assert!(checking_sets(&computed, &dismissals));
        // Its still still gets printed, or it would never come back.
        assert_eq!(stills_to_print(&computed, &dismissals), [1, 2]);

        // A set the owner dismissed asks for nothing.
        let dismissed = scratch
            .catalog
            .blocking(|connection| {
                super::super::dismissals::add_dismissal(connection, &[1, 2], None)?;
                Dismissals::load(connection)
            })
            .unwrap();
        assert!(!checking_sets(&computed, &dismissed));
        assert!(stills_to_print(&computed, &dismissed).is_empty());
    }

    #[test]
    fn a_print_that_failed_is_a_final_answer_that_keeps_the_file() {
        let scratch = catalog(&[
            Still {
                detail: Some(print()),
                ..still(1, "alt/a.png", "aa", 0)
            },
            Still {
                detail: Some(print()),
                ..still(2, "alt/b.png", "bb", 0b1)
            },
            still(3, "alt/unreadable.png", "cc", 0b11),
        ]);
        compare(&scratch, 1, 2, false);
        scratch
            .catalog
            .blocking(|connection| {
                connection.execute(
                    "INSERT INTO file_details (file_id, version, size, mtime_ms, error)
                     SELECT id, ?1, size, mtime_ms, 'bad' FROM files WHERE id = 3",
                    [DETAIL_VERSION],
                )?;
                Ok(())
            })
            .unwrap();
        let computed = sets(&scratch, SimilarityLevel::Balanced, true);
        assert!(!computed[0].checking);
        assert_eq!((computed[0].comparable, computed[0].compared), (3, 3));
        // The two that compare are one picture; the unreadable one stays, as one of its own.
        assert_eq!(computed[0].set.keep.len(), 2);
        assert!(computed[0].set.keep.contains(&3));
        assert_eq!(computed[0].extra_copies, 1);
    }

    /// Stores two videos of one size and length, with these frames, and returns their one set.
    fn videos(frames: [u64; 5], other: [u64; 5], second_length_ms: f64) -> ComputedSet {
        let scratch = catalog(&[
            still(1, "clips/cut-a.mp4", "aa", 0),
            still(2, "clips/cut-b.mp4", "bb", 0),
        ]);
        let print = |frames: [u64; 5], length: f64| {
            let hashes: Vec<String> = frames.iter().map(|hash| format!("{hash:016x}")).collect();
            format!("m:{length}:{}", hashes.join("."))
        };
        let first = print(frames, 60_000.0);
        let second = print(other, second_length_ms);
        scratch
            .catalog
            .blocking(move |connection| {
                for (id, fingerprint, length) in
                    [(1, first, 60_000.0), (2, second, second_length_ms)]
                {
                    connection.execute(
                        "UPDATE files SET kind = 'video', fingerprint = ?2, duration_ms = ?3
                          WHERE id = ?1",
                        rusqlite::params![id, fingerprint, length],
                    )?;
                }
                Ok(())
            })
            .unwrap();
        sets(&scratch, SimilarityLevel::Balanced, true).remove(0)
    }

    #[test]
    fn videos_of_one_size_and_length_are_sorted_by_their_frames() {
        let six_bits = 0b11_1111;
        // A re-encode moves a frame or two a little, and stays one set that keeps one.
        let copy = videos([0; 5], [six_bits, 0b1111, 0b11, 0, 0], 60_000.0);
        assert_eq!(copy.set.pictures, None);
        assert_eq!(copy.set.keep.len(), 1);
        // Another cut moves most of them, but still matches well enough to be found.
        let cut = videos([0; 5], [six_bits, six_bits, six_bits, 0, 0], 60_000.0);
        assert!(cut.variants);
        assert_eq!(cut.set.keep.len(), 2);
        // A second off, the frames do not line up, so they say nothing.
        let trimmed = videos([0; 5], [six_bits, six_bits, six_bits, 0, 0], 59_000.0);
        assert_eq!(trimmed.set.pictures, None);
        assert_eq!(trimmed.set.keep.len(), 1);
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
    }

    /// The sets built from clusters made earlier, as the engine keeps them through a change.
    fn built(scratch: &Scratch, clusters: Vec<SimilarCluster>) -> Vec<ComputedSet> {
        let settings = Settings {
            spot_variants: true,
            ..Settings::default()
        };
        scratch
            .catalog
            .blocking(move |connection| {
                build_duplicate_sets(connection, Some(1), &settings, &clusters)
            })
            .unwrap()
    }

    /// Three stills a closer look found all different pictures, then what Convert leaves of the
    /// third until the analysis after it: no print, and the clusters still holding it.
    fn a_converted_variant(fingerprint_version: i64, error: Option<&str>) -> ComputedSet {
        let scratch = catalog(&[
            Still {
                detail: Some(print()),
                ..still(1, "alt/a.png", "aa", 0)
            },
            Still {
                detail: Some(print()),
                ..still(2, "alt/b.png", "bb", 0b1)
            },
            Still {
                detail: Some(print()),
                ..still(3, "alt/c.png", "cc", 0b11)
            },
        ]);
        compare(&scratch, 1, 2, true);
        compare(&scratch, 1, 3, true);
        compare(&scratch, 2, 3, true);
        let clusters = scratch
            .catalog
            .blocking(|connection| {
                compute_similar_clusters(connection, Some(1), SimilarityLevel::Balanced)
            })
            .unwrap();
        let before = built(&scratch, clusters.clone());
        assert_eq!(before[0].set.keep, [1, 2, 3]);
        assert!(before[0].variants);
        let error = error.map(str::to_owned);
        scratch
            .catalog
            .blocking(move |connection| {
                connection.execute(
                    "UPDATE files SET rel_path = 'alt/c.avif', name = 'c.avif', ext = 'avif',
                      format = 'avif', size = 500, sha256 = 'dd', fingerprint = NULL,
                      fingerprint_version = ?1, fingerprint_error = ?2 WHERE id = 3",
                    rusqlite::params![fingerprint_version, error],
                )?;
                Ok(())
            })
            .unwrap();
        built(&scratch, clusters).remove(0)
    }

    #[test]
    fn a_version_due_a_print_holds_its_set_and_offers_nothing() {
        let set = a_converted_variant(0, None);
        assert!(set.checking);
        assert_eq!(set.set.keep, [1, 2, 3]);
        assert!(set.removable.is_empty());
        assert!(!in_scope(&set, DuplicateScope::All));
    }

    #[test]
    fn a_version_whose_print_failed_for_good_is_a_picture_of_its_own() {
        let set = a_converted_variant(FINGERPRINT_VERSION, Some("no pixels"));
        assert!(!set.checking, "it would wait for ever");
        assert_eq!(set.set.keep.len(), 3);
        assert!(set.removable.is_empty());
    }

    #[test]
    fn a_new_copy_without_a_print_leaves_two_cuts_of_a_video_apart() {
        let scratch = catalog(&[
            still(1, "clips/cut-a.mp4", "aa", 0),
            still(2, "clips/cut-b.mp4", "bb", 0),
            Still {
                mtime_ms: 1_000_000_000_000.0,
                ..still(3, "clips/cut-a-older.mp4", "aa", 0)
            },
        ]);
        let six: u64 = 0b11_1111;
        let print = |frames: [u64; 5]| {
            let hashes: Vec<String> = frames.iter().map(|hash| format!("{hash:016x}")).collect();
            format!("m:60000:{}", hashes.join("."))
        };
        let (first, second) = (print([0; 5]), print([six, six, six, 0, 0]));
        scratch
            .catalog
            .blocking(move |connection| {
                for (id, fingerprint) in [(1, Some(first)), (2, Some(second)), (3, None)] {
                    connection.execute(
                        "UPDATE files SET kind = 'video', fingerprint = ?2, duration_ms = 60000,
                          fingerprint_version = CASE WHEN ?2 IS NULL THEN 0 ELSE 1 END
                          WHERE id = ?1",
                        rusqlite::params![id, fingerprint],
                    )?;
                }
                Ok(())
            })
            .unwrap();
        let computed = sets(&scratch, SimilarityLevel::Balanced, true);
        assert_eq!(computed[0].set.keep.len(), 2, "one copy of each cut");
        assert!(computed[0].set.keep.contains(&2));
        assert_eq!(computed[0].removable.len(), 1);
        assert!(!computed[0].removable.contains(&2));
    }
}
