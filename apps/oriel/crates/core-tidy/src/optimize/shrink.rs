//! What Shrink would re-encode, from glazier-core's `optimize/shrink.ts` and its estimate of
//! encode times, `optimize/encode-speed.ts`.

use std::collections::HashSet;

use indexmap::IndexMap;
use oriel_core_format::{ArchiveVideoCodec, ArchiveVideoPlan, plan_video_reencode};
use rusqlite::Connection;

use super::candidates::{
    CandidateHolds, SKIP_DUPLICATE, SKIP_REVIEW, SKIP_UNCHECKED, open_duplicate_copies,
    taken_paths, unchecked_files, video_source_of,
};
use crate::catalog::files::{SqlParams, query_records};
use crate::catalog::rows::{FILE_COLUMNS, FILES_FROM, FileRecord};
use crate::collation::locale_order;
use crate::contract::{FileId, RootId, ShrinkItem, ShrinkTotals};
use crate::number::js_round;

/// Below this many bits per pixel each second a video is already compact: an AV1 re-encode at
/// Tidy's settings saves little and can come out larger.
const COMPACT_BITS_PER_PIXEL_SECOND: f64 = 0.8;

/// The share of its bytes a video is expected to keep as AV1 (SVT-AV1, CRF 35), from its bits per
/// pixel each second. Fitted to measurements on the owner's library (plan 060). It ranks videos
/// and sizes batches; the encode itself decides what is kept.
pub fn expected_share(bits_per_pixel_second: f64) -> f64 {
    (0.55 / bits_per_pixel_second).clamp(0.2, 1.0)
}

/// SVT-AV1's speed as a multiple of real time, by picture size, measured on an M5 Pro at preset 6
/// (plan 060). It is the guess until this machine has timed encodes of its own.
const M5_PRO_SPEEDS: [(f64, f64); 3] =
    [(1_000_000.0, 3.5), (2_200_000.0, 2.4), (f64::INFINITY, 1.7)];

/// A size class needs this many timed encodes before its own speed counts.
const MIN_SAMPLES: usize = 3;

/// A size class's speed is the median of its latest this many encodes.
const RECENT: usize = 50;

/// Clips shorter than this mostly time ffmpeg starting up, so they say little about the encoder.
const MIN_MEDIA_MS: f64 = 10_000.0;

/// Timings read.
const KEPT: i64 = 500;

/// One timed SVT-AV1 encode.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct EncodeTiming {
    pub pixels: f64,
    pub media_ms: f64,
    pub wall_ms: f64,
}

/// This machine's SVT-AV1 speed: each size class with enough timed encodes uses their median,
/// and one without scales the M5 Pro's figure by how this machine compares in the classes it has
/// timed. With no timings yet, the M5 Pro's figures stand.
#[derive(Clone, Debug, PartialEq)]
pub struct EncodeSpeed {
    measured: [Option<f64>; 3],
    factor: f64,
}

fn median(values: &[f64]) -> f64 {
    let mut sorted = values.to_vec();
    sorted.sort_by(f64::total_cmp);
    sorted.get(sorted.len() / 2).copied().unwrap_or(0.0)
}

fn class_of(pixels: f64) -> Option<usize> {
    M5_PRO_SPEEDS
        .iter()
        .position(|&(max_pixels, _)| pixels <= max_pixels)
}

impl EncodeSpeed {
    /// The speed from timings, newest first, as the catalog lists them.
    pub fn from_timings(timings: &[EncodeTiming]) -> Self {
        let mut by_class: [Vec<f64>; 3] = Default::default();
        for timing in timings {
            if timing.media_ms < MIN_MEDIA_MS || timing.wall_ms <= 0.0 {
                continue;
            }
            if let Some(speeds) = class_of(timing.pixels).map(|class| &mut by_class[class])
                && speeds.len() < RECENT
            {
                speeds.push(timing.media_ms / timing.wall_ms);
            }
        }
        let measured =
            by_class.map(|speeds| (speeds.len() >= MIN_SAMPLES).then(|| median(&speeds)));
        let ratios: Vec<f64> = measured
            .iter()
            .zip(M5_PRO_SPEEDS)
            .filter_map(|(speed, (_, guess))| speed.map(|speed| speed / guess))
            .collect();
        Self {
            measured,
            factor: if ratios.is_empty() {
                1.0
            } else {
                median(&ratios)
            },
        }
    }

    /// The real-time multiple to expect for a video of this many pixels.
    pub fn at(&self, pixels: f64) -> f64 {
        match class_of(pixels) {
            Some(class) => self.measured[class].unwrap_or(M5_PRO_SPEEDS[class].1 * self.factor),
            None => 1.7 * self.factor,
        }
    }

    /// Whether the speeds come from this machine's encodes rather than the M5 Pro's.
    pub fn measured(&self) -> bool {
        self.measured.iter().any(Option::is_some)
    }
}

/// This machine's speed, from the catalog's latest timings.
pub fn encode_speed(connection: &Connection) -> anyhow::Result<EncodeSpeed> {
    let mut statement = connection.prepare_cached(
        "SELECT pixels, media_ms, wall_ms FROM encode_timings
      WHERE encoder = 'svt-av1' AND media_ms >= ?1 AND wall_ms > 0
      ORDER BY id DESC LIMIT ?2",
    )?;
    let rows = statement.query_map(rusqlite::params![MIN_MEDIA_MS, KEPT], |row| {
        Ok(EncodeTiming {
            pixels: row.get(0)?,
            media_ms: row.get(1)?,
            wall_ms: row.get(2)?,
        })
    })?;
    let timings: Vec<EncodeTiming> = rows.collect::<rusqlite::Result<_>>()?;
    Ok(EncodeSpeed::from_timings(&timings))
}

/// A video Shrink would re-encode.
#[derive(Clone, Debug, PartialEq)]
pub struct ShrinkCandidate {
    pub record: FileRecord,
    pub item: ShrinkItem,
}

/// Shrink's candidates under a root, most bytes saved first, and why others are left out.
#[derive(Clone, Debug, PartialEq)]
pub struct ShrinkScan {
    pub candidates: Vec<ShrinkCandidate>,
    pub skipped: IndexMap<String, i64>,
    pub speed_measured: bool,
}

impl ShrinkScan {
    pub fn totals(&self) -> ShrinkTotals {
        let mut totals = ShrinkTotals {
            files: self.candidates.len() as i64,
            ..ShrinkTotals::default()
        };
        for candidate in &self.candidates {
            totals.bytes += candidate.item.bytes;
            totals.estimated_bytes += candidate.item.estimated_bytes;
        }
        totals
    }
}

const SKIP_NOT_SMALLER: &str = "Came out no smaller as AV1";

/// Every video under a root that an AV1 re-encode should shrink, the most bytes saved first.
/// Videos already AV1 or already compact are left out, as are those duplicate review still needs
/// as they are (the same holds as Convert) and those an earlier attempt could not shrink.
pub fn find_shrink_candidates(
    connection: &Connection,
    root_id: RootId,
    holds: &CandidateHolds,
) -> anyhow::Result<ShrinkScan> {
    let records = query_records(
        connection,
        &format!(
            "SELECT {FILE_COLUMNS} FROM {FILES_FROM}
      WHERE f.root_id = $root AND f.kind = 'video' AND f.is_junk = 0 AND f.size > 0
        AND f.probe_version > 0"
        ),
        &SqlParams::new().with("root", root_id),
    )?;
    let taken = taken_paths(connection, root_id)?;
    let duplicates = open_duplicate_copies(connection, root_id)?;
    let unchecked = if holds.wait_for_fingerprints {
        unchecked_files(connection, root_id)?
    } else {
        HashSet::new()
    };
    let speed = encode_speed(connection)?;
    let mut candidates = Vec::new();
    let mut skipped: IndexMap<String, i64> = IndexMap::new();
    let mut skip = |reason: &str| *skipped.entry(reason.to_owned()).or_default() += 1;

    for record in records {
        if let Some(reason) = skip_reason(&record, &duplicates, &unchecked, holds) {
            skip(reason);
            continue;
        }
        let plan = video_source_of(&record)
            .map(|source| plan_video_reencode(&source, ArchiveVideoCodec::Av1));
        let Some(ArchiveVideoPlan::ConvertMp4 { file_name, .. }) = plan else {
            skip("Can't be re-encoded");
            continue;
        };
        let (Some(width), Some(height), Some(bitrate), Some(duration_ms)) = (
            record.width,
            record.height,
            record.bitrate,
            record.duration_ms,
        ) else {
            skip("Size or bitrate unknown");
            continue;
        };
        let pixels = (width * height) as f64;
        let bits_per_pixel_second = if pixels > 0.0 { bitrate / pixels } else { 0.0 };
        if bits_per_pixel_second < COMPACT_BITS_PER_PIXEL_SECOND {
            skip("Already compact");
            continue;
        }
        let target = if record.dir.is_empty() {
            file_name.clone()
        } else {
            format!("{}/{file_name}", record.dir)
        }
        .to_lowercase();
        if target != record.rel_path.to_lowercase() && taken.contains(&target) {
            skip("A file with the target name already exists");
            continue;
        }
        let item = ShrinkItem {
            file_id: record.id,
            bytes: record.size,
            estimated_bytes: js_round(record.size as f64 * expected_share(bits_per_pixel_second))
                as i64,
            duration_ms,
            encode_ms: js_round(duration_ms / speed.at(pixels)),
        };
        candidates.push(ShrinkCandidate { record, item });
    }

    let saved = |candidate: &ShrinkCandidate| candidate.item.bytes - candidate.item.estimated_bytes;
    candidates.sort_by(|left, right| {
        saved(right)
            .cmp(&saved(left))
            .then_with(|| locale_order(&left.record.rel_path, &right.record.rel_path))
    });
    Ok(ShrinkScan {
        candidates,
        skipped,
        speed_measured: speed.measured(),
    })
}

fn skip_reason(
    record: &FileRecord,
    duplicates: &HashSet<FileId>,
    unchecked: &HashSet<FileId>,
    holds: &CandidateHolds,
) -> Option<&'static str> {
    if record.probe_error.is_some() {
        return Some("Won't decode");
    }
    if record.video_codec.as_deref() == Some("av1") {
        return Some("Already AV1");
    }
    if record.shrink_not_smaller {
        return Some(SKIP_NOT_SMALLER);
    }
    if duplicates.contains(&record.id) {
        return Some(SKIP_DUPLICATE);
    }
    if holds.reviewing.contains(&record.id) {
        return Some(SKIP_REVIEW);
    }
    unchecked.contains(&record.id).then_some(SKIP_UNCHECKED)
}
