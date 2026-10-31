//! Similar groups, from glazier-core's `similarity/group.ts`: files whose fingerprints say they
//! show the same picture or the same footage, however they were encoded.
//!
//! The thresholds were measured on the owner's library and are glazier-core's exactly. Which
//! file becomes a group's first member and which link sets its distance follow the order
//! glazier-core walks its JavaScript `Map`s in, insertion order, so the groups here equal its
//! groups member for member; `IndexMap` keeps that order.

use std::collections::HashMap;
use std::hash::Hash;

use indexmap::IndexMap;
use serde::{Deserialize, Serialize};

use super::fingerprint::Fingerprint;
use super::phash::Hash64;
use crate::contract::{FileId, SimilarityLevel};
use crate::number::{js_round, v8_log};

/// Two prints can match only when their aspect ratios differ by less than about 3%.
const ASPECT_TOLERANCE: f64 = 0.03;

/// Two motion prints can match only when their durations differ by less than this…
const DURATION_TOLERANCE_MS: f64 = 1500.0;

/// …or this share of the longer one, whichever is larger.
const DURATION_TOLERANCE_RATIO: f64 = 0.03;

/// The largest bit distance (of 64) that still counts as the same picture. Recompression and
/// resizing land well under 8; a different crop or an overlay lands past 12.
pub fn still_threshold(level: SimilarityLevel) -> u32 {
    match level {
        SimilarityLevel::Strict => 4,
        SimilarityLevel::Balanced => 8,
        SimilarityLevel::Loose => 12,
    }
}

/// For motion, the median of the five frame distances must be under this.
pub fn motion_threshold(level: SimilarityLevel) -> u32 {
    match level {
        SimilarityLevel::Strict => 5,
        SimilarityLevel::Balanced => 9,
        SimilarityLevel::Loose => 13,
    }
}

/// A file with a print, and the shape of its picture.
#[derive(Clone, Debug, PartialEq)]
pub struct FingerprintedFile {
    pub id: FileId,
    /// Display width over height.
    pub aspect: f64,
    pub fingerprint: Fingerprint,
}

/// Whether a group is of stills or of anything that moves.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ClusterKind {
    Image,
    Video,
}

/// Files that show one picture or one piece of footage.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SimilarCluster {
    pub kind: ClusterKind,
    /// The largest distance on a link that joined this group.
    pub distance: u32,
    pub ids: Vec<FileId>,
}

struct StillEntry {
    id: FileId,
    log_aspect: f64,
    hash: Hash64,
}

struct MotionEntry {
    id: FileId,
    log_aspect: f64,
    duration_ms: f64,
    frames: Vec<Hash64>,
}

trait Entry {
    fn id(&self) -> FileId;
    fn log_aspect(&self) -> f64;
}

impl Entry for StillEntry {
    fn id(&self) -> FileId {
        self.id
    }

    fn log_aspect(&self) -> f64 {
        self.log_aspect
    }
}

impl Entry for MotionEntry {
    fn id(&self) -> FileId {
        self.id
    }

    fn log_aspect(&self) -> f64 {
        self.log_aspect
    }
}

/// Groups files whose prints say they show the same picture or the same footage. Stills only
/// meet stills and motion only motion. Candidates are binned by aspect ratio so most pairs are
/// never compared.
pub fn group_similar_files(
    files: &[FingerprintedFile],
    level: SimilarityLevel,
) -> Vec<SimilarCluster> {
    let mut stills = Vec::new();
    let mut motions = Vec::new();
    for file in files {
        // `!(aspect > 0)` in glazier-core, which NaN also fails.
        if file.aspect.partial_cmp(&0.0) != Some(std::cmp::Ordering::Greater)
            || !file.aspect.is_finite()
        {
            continue;
        }
        let log_aspect = v8_log(file.aspect);
        match &file.fingerprint {
            Fingerprint::Still(hash) => stills.push(StillEntry {
                id: file.id,
                log_aspect,
                hash: *hash,
            }),
            Fingerprint::Motion {
                duration_ms,
                frames,
            } if !frames.is_empty() => motions.push(MotionEntry {
                id: file.id,
                log_aspect,
                duration_ms: *duration_ms,
                frames: frames.clone(),
            }),
            Fingerprint::Motion { .. } => {}
        }
    }

    let still_limit = still_threshold(level);
    let still_clusters = cluster_within_aspect_bins(&stills, |left, right| {
        let distance = left.hash.distance(right.hash);
        (distance <= still_limit).then_some(distance)
    });
    let motion_limit = motion_threshold(level);
    let motion_clusters = cluster_within_aspect_bins(&motions, |left, right| {
        motion_distance(left, right, motion_limit)
    });

    still_clusters
        .into_iter()
        .map(|(distance, ids)| SimilarCluster {
            kind: ClusterKind::Image,
            distance,
            ids,
        })
        .chain(
            motion_clusters
                .into_iter()
                .map(|(distance, ids)| SimilarCluster {
                    kind: ClusterKind::Video,
                    distance,
                    ids,
                }),
        )
        .collect()
}

/// The median frame distance when two motion prints match, or `None` when they do not.
fn motion_distance(left: &MotionEntry, right: &MotionEntry, threshold: u32) -> Option<u32> {
    let longer = left.duration_ms.max(right.duration_ms);
    let tolerance = DURATION_TOLERANCE_MS.max(longer * DURATION_TOLERANCE_RATIO);
    if (left.duration_ms - right.duration_ms).abs() > tolerance {
        return None;
    }
    let mut distances: Vec<u32> = left
        .frames
        .iter()
        .zip(&right.frames)
        .map(|(left, right)| left.distance(*right))
        .collect();
    distances.sort_unstable();
    let median = distances.get(distances.len() / 2).copied()?;
    (median <= threshold).then_some(median)
}

fn cluster_within_aspect_bins<T: Entry>(
    entries: &[T],
    matches: impl Fn(&T, &T) -> Option<u32>,
) -> Vec<(u32, Vec<FileId>)> {
    let mut bins: IndexMap<i64, Vec<&T>> = IndexMap::new();
    for entry in entries {
        let bin = js_round(entry.log_aspect() / ASPECT_TOLERANCE) as i64;
        bins.entry(bin).or_default().push(entry);
    }

    let mut sets = DisjointSets::default();
    let compare = |sets: &mut DisjointSets<FileId>, left: &T, right: &T| {
        if (left.log_aspect() - right.log_aspect()).abs() > ASPECT_TOLERANCE {
            return;
        }
        if let Some(distance) = matches(left, right) {
            sets.union(left.id(), right.id(), distance);
        }
    };

    for (bin, members) in &bins {
        // Each bin meets itself and the next one up, so every neighbouring pair is seen once.
        let neighbours = bins.get(&(bin + 1)).map_or(&[][..], Vec::as_slice);
        for (left_index, left) in members.iter().enumerate() {
            for right in &members[left_index + 1..] {
                compare(&mut sets, left, right);
            }
            for right in neighbours {
                compare(&mut sets, left, right);
            }
        }
    }
    sets.clusters()
}

/// Union–find over ids, tracking the largest link distance in each set. It keeps glazier-core's
/// order: ids in the order first seen, and each set's root the one its first union named.
#[derive(Debug)]
pub struct DisjointSets<K> {
    parent: IndexMap<K, K>,
    distance: HashMap<K, u32>,
}

impl<K> Default for DisjointSets<K> {
    fn default() -> Self {
        Self {
            parent: IndexMap::new(),
            distance: HashMap::new(),
        }
    }
}

impl<K: Copy + Eq + Hash> DisjointSets<K> {
    pub fn union(&mut self, left: K, right: K, link_distance: u32) {
        let left_root = self.find(left);
        let right_root = self.find(right);
        let distance = link_distance
            .max(self.distance.get(&left_root).copied().unwrap_or(0))
            .max(self.distance.get(&right_root).copied().unwrap_or(0));
        if left_root != right_root {
            self.parent.insert(right_root, left_root);
        }
        self.distance.insert(left_root, distance);
    }

    /// Each set of two or more, in the order its first member was seen, with its largest link
    /// distance.
    pub fn clusters(&mut self) -> Vec<(u32, Vec<K>)> {
        let keys: Vec<K> = self.parent.keys().copied().collect();
        let mut by_root: IndexMap<K, Vec<K>> = IndexMap::new();
        for key in keys {
            let root = self.find(key);
            by_root.entry(root).or_default().push(key);
        }
        by_root
            .into_iter()
            .filter(|(_, ids)| ids.len() > 1)
            .map(|(root, ids)| (self.distance.get(&root).copied().unwrap_or(0), ids))
            .collect()
    }

    fn find(&mut self, key: K) -> K {
        if !self.parent.contains_key(&key) {
            self.parent.insert(key, key);
            return key;
        }
        let mut root = key;
        while let Some(&next) = self.parent.get(&root) {
            if next == root {
                break;
            }
            root = next;
        }
        // Path compression keeps later finds short.
        let mut current = key;
        while current != root {
            let next = self.parent.get(&current).copied();
            self.parent.insert(current, root);
            match next {
                Some(next) => current = next,
                None => break,
            }
        }
        root
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A hash `bits` bits away from zero, flipping from the lowest bit up.
    fn bits(bits: u32) -> Hash64 {
        Hash64(if bits == 64 {
            u64::MAX
        } else {
            (1u64 << bits) - 1
        })
    }

    fn still(id: FileId, hash: Hash64) -> FingerprintedFile {
        FingerprintedFile {
            id,
            aspect: 4.0 / 3.0,
            fingerprint: Fingerprint::Still(hash),
        }
    }

    fn motion(id: FileId, duration_ms: f64, frames: [u32; 5]) -> FingerprintedFile {
        FingerprintedFile {
            id,
            aspect: 16.0 / 9.0,
            fingerprint: Fingerprint::Motion {
                duration_ms,
                frames: frames.into_iter().map(bits).collect(),
            },
        }
    }

    /// The groups at `level`, as each one's distance and its ids in order.
    fn groups(files: &[FingerprintedFile], level: SimilarityLevel) -> Vec<(u32, Vec<FileId>)> {
        group_similar_files(files, level)
            .into_iter()
            .map(|cluster| {
                let mut ids = cluster.ids;
                ids.sort_unstable();
                (cluster.distance, ids)
            })
            .collect()
    }

    #[test]
    fn two_stills_are_one_picture_up_to_each_levels_distance() {
        use SimilarityLevel::*;
        // Strict takes 4 bits of 64, Balanced 8 and Loose 12.
        for (distance, strict, balanced, loose) in [
            (0, true, true, true),
            (4, true, true, true),
            (5, false, true, true),
            (8, false, true, true),
            (9, false, false, true),
            (12, false, false, true),
            (13, false, false, false),
        ] {
            let files = [still(1, bits(0)), still(2, bits(distance))];
            for (level, grouped) in [(Strict, strict), (Balanced, balanced), (Loose, loose)] {
                let expected = if grouped {
                    vec![(distance, vec![1, 2])]
                } else {
                    Vec::new()
                };
                assert_eq!(
                    groups(&files, level),
                    expected,
                    "{distance} bits at {level}"
                );
            }
        }
    }

    #[test]
    fn links_chain_and_the_group_keeps_its_largest_link() {
        // 1 and 3 are 8 bits apart, past Strict, but each is 4 from 2.
        let files = [
            still(1, Hash64(0x0f)),
            still(2, Hash64(0x00)),
            still(3, Hash64(0xf0)),
        ];
        assert_eq!(
            groups(&files, SimilarityLevel::Strict),
            [(4, vec![1, 2, 3])]
        );
    }

    #[test]
    fn only_pictures_of_one_shape_are_compared() {
        let shaped = |id, aspect| FingerprintedFile {
            aspect,
            ..still(id, bits(0))
        };
        // Within about 3% of each other they can match; past it, the same hash does not.
        assert_eq!(
            groups(&[shaped(1, 1.5), shaped(2, 1.53)], SimilarityLevel::Loose),
            [(0, vec![1, 2])]
        );
        assert!(groups(&[shaped(1, 1.5), shaped(2, 1.6)], SimilarityLevel::Loose).is_empty());
        // No shape at all is no picture.
        assert!(groups(&[shaped(1, 0.0), shaped(2, 0.0)], SimilarityLevel::Loose).is_empty());
    }

    #[test]
    fn stills_never_meet_motion() {
        let files = [
            FingerprintedFile {
                aspect: 16.0 / 9.0,
                ..still(1, bits(0))
            },
            motion(2, 3000.0, [0; 5]),
        ];
        assert!(groups(&files, SimilarityLevel::Loose).is_empty());
    }

    #[test]
    fn footage_matches_by_its_median_frame_and_a_close_length() {
        use SimilarityLevel::*;
        let base = motion(1, 60_000.0, [0; 5]);
        // Two frames far off (a new intro, a watermark) and three close: the median, 5, is
        // within Strict's 5; at 6 it is past it, and within Balanced's 9.
        let recut = motion(2, 60_000.0, [40, 40, 5, 5, 0]);
        assert_eq!(
            groups(&[base.clone(), recut.clone()], Strict),
            [(5, vec![1, 2])]
        );
        let worse = motion(3, 60_000.0, [40, 40, 6, 6, 0]);
        assert!(groups(&[base.clone(), worse.clone()], Strict).is_empty());
        assert_eq!(groups(&[base.clone(), worse], Balanced), [(6, vec![1, 3])]);
        // Lengths may differ by 1.5 s or 3% of the longer, whichever is more: 1.8 s at a minute.
        let trimmed = motion(4, 58_200.0, [0; 5]);
        assert_eq!(groups(&[base.clone(), trimmed], Strict), [(0, vec![1, 4])]);
        let shorter = motion(5, 58_100.0, [0; 5]);
        assert!(groups(&[base, shorter], Loose).is_empty());
        // A short clip gets the 1.5 s.
        let clip = motion(6, 4_000.0, [0; 5]);
        let longer = motion(7, 5_500.0, [0; 5]);
        assert_eq!(groups(&[clip, longer], Strict), [(0, vec![6, 7])]);
    }
}
