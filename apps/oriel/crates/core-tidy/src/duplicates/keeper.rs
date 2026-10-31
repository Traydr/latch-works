//! Which copy of a picture or video to keep, from glazier-core's `duplicates/keeper.ts`.

use std::cmp::Ordering;

use serde::{Deserialize, Serialize};

use crate::collation::{js_length, natural_order};
use crate::contract::{AudioState, FileFormat, FileId, FileKind, KeepReason};
use crate::number::js_round;
use crate::scan::preferred_extension;

/// What the keeper rules compare about each copy in a group.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KeeperCandidate {
    pub id: FileId,
    pub rel_path: String,
    pub kind: FileKind,
    pub format: Option<FileFormat>,
    /// Lowercased, without the dot.
    pub ext: String,
    /// The extension names a different format than the bytes hold.
    pub extension_mismatch: bool,
    pub video_codec: Option<String>,
    pub width: Option<i64>,
    pub height: Option<i64>,
    pub duration_ms: Option<f64>,
    pub audio_state: Option<AudioState>,
    pub size: i64,
    pub mtime_ms: f64,
    /// Inside a folder the owner prefers to keep copies in.
    pub is_preferred: bool,
    /// With Spot variants, inside the folder that holds the most of the set's pictures, so a
    /// picture's copies stay together with the rest of the set.
    pub in_home_folder: bool,
}

/// Hearing something beats not knowing, which beats a silent track, which beats no track.
fn audio_rank(state: Option<AudioState>) -> i32 {
    match state {
        Some(AudioState::Sound) => 3,
        Some(AudioState::Unmeasured) => 2,
        Some(AudioState::Silent) => 1,
        Some(AudioState::None) | None => 0,
    }
}

/// Already in the archive format: an AVIF still, or MP4 with a codec the archive keeps.
fn is_archive_format(candidate: &KeeperCandidate) -> bool {
    if candidate.kind == FileKind::Image {
        return candidate.format == Some(FileFormat::Avif);
    }
    candidate.format == Some(FileFormat::Mp4)
        && matches!(
            candidate.video_codec.as_deref(),
            Some("h264" | "hevc" | "av1")
        )
}

/// 2 for the format's own extension (`.mp4`), 1 for another it accepts (`.m4v`), 0 for a wrong
/// one.
fn extension_rank(candidate: &KeeperCandidate) -> i32 {
    if candidate.extension_mismatch {
        return 0;
    }
    let preferred = candidate.format.and_then(preferred_extension);
    if preferred == Some(candidate.ext.as_str()) {
        2
    } else {
        1
    }
}

/// The stem of a path's file name, lowercased.
fn stem_of(rel_path: &str) -> String {
    let name = rel_path.rsplit('/').next().unwrap_or(rel_path);
    let stem = match name.rfind('.') {
        Some(dot) if dot > 0 => &name[..dot],
        _ => name,
    };
    stem.to_lowercase()
}

/// ` (1)`, ` copy`, ` copy 2`, `-copy`, `_copy`, ` 2`: what systems append to a copy's name.
/// glazier-core's `/^(?: \(\d+\)| copy(?: \d+)?|[-_]copy(?:[-_ ]?\d+)?| \d+)$/i`, by hand.
fn is_copy_suffix(suffix: &str) -> bool {
    let digits = |text: &str| !text.is_empty() && text.bytes().all(|byte| byte.is_ascii_digit());
    let copy_word = |text: &str| {
        text.get(..4)
            .is_some_and(|word| word.eq_ignore_ascii_case("copy"))
    };
    if let Some(inner) = suffix
        .strip_prefix(" (")
        .and_then(|rest| rest.strip_suffix(')'))
    {
        return digits(inner);
    }
    if let Some(rest) = suffix.strip_prefix(' ') {
        if digits(rest) {
            return true;
        }
        if copy_word(rest) {
            let after = &rest[4..];
            return after.is_empty() || after.strip_prefix(' ').is_some_and(digits);
        }
        return false;
    }
    if let Some(rest) = suffix.strip_prefix(['-', '_'])
        && copy_word(rest)
    {
        let after = &rest[4..];
        if after.is_empty() || digits(after) {
            return true;
        }
        return after.strip_prefix(['-', '_', ' ']).is_some_and(digits);
    }
    false
}

/// True when `copy` is named like `original` plus a copy suffix: `sunset (1)` beside `sunset`.
fn is_copy_name_of(copy: &KeeperCandidate, original: &KeeperCandidate) -> bool {
    let copy_stem = stem_of(&copy.rel_path);
    let original_stem = stem_of(&original.rel_path);
    js_length(&copy_stem) > js_length(&original_stem)
        && copy_stem.starts_with(&original_stem)
        && is_copy_suffix(&copy_stem[original_stem.len()..])
}

fn pixels(candidate: &KeeperCandidate) -> i64 {
    candidate.width.unwrap_or(0) * candidate.height.unwrap_or(0)
}

/// Ascending numbers as an order, the sign of glazier-core's `left - right`.
fn by<T: PartialOrd>(left: T, right: T) -> Ordering {
    left.partial_cmp(&right).unwrap_or(Ordering::Equal)
}

/// The keeper rules, in order: anything in a preferred folder; for video, the copy you can hear;
/// more pixels; a longer video (to half a second, so a trimmed re-upload loses); with Spot
/// variants, the copy in the set's home folder; the archive format; the extension the format is
/// named with; more bytes, which at equal pixels is more detail; the name without a copy suffix;
/// the oldest file; the shortest path; and finally natural name order, so the choice never
/// depends on scan order. `Greater` means `left` is the better copy to keep.
/// One keeper rule: `Greater` when the first copy is the better one to keep.
type KeeperRule = fn(&KeeperCandidate, &KeeperCandidate) -> Ordering;

const KEEPER_RULES: [(KeepReason, KeeperRule); 12] = [
    (KeepReason::PreferredFolder, |left, right| {
        by(left.is_preferred, right.is_preferred)
    }),
    (KeepReason::HasSound, |left, right| {
        by(audio_rank(left.audio_state), audio_rank(right.audio_state))
    }),
    (KeepReason::MorePixels, |left, right| {
        by(pixels(left), pixels(right))
    }),
    (KeepReason::Longer, |left, right| {
        by(
            js_round(left.duration_ms.unwrap_or(0.0) / 500.0),
            js_round(right.duration_ms.unwrap_or(0.0) / 500.0),
        )
    }),
    (KeepReason::HomeFolder, |left, right| {
        by(left.in_home_folder, right.in_home_folder)
    }),
    (KeepReason::ArchiveFormat, |left, right| {
        by(is_archive_format(left), is_archive_format(right))
    }),
    (KeepReason::RightExtension, |left, right| {
        by(extension_rank(left), extension_rank(right))
    }),
    (KeepReason::LargerFile, |left, right| {
        by(left.size, right.size)
    }),
    (KeepReason::OriginalName, |left, right| {
        by(is_copy_name_of(right, left), is_copy_name_of(left, right))
    }),
    (KeepReason::Oldest, |left, right| {
        by(right.mtime_ms.trunc(), left.mtime_ms.trunc())
    }),
    (KeepReason::ShorterPath, |left, right| {
        by(js_length(&right.rel_path), js_length(&left.rel_path))
    }),
    (KeepReason::NameOrder, |left, right| {
        natural_order(&right.rel_path, &left.rel_path)
    }),
];

/// `Greater` when `left` is the better copy to keep; each rule only breaks ties of the one
/// before.
pub fn compare_keepers(left: &KeeperCandidate, right: &KeeperCandidate) -> Ordering {
    KEEPER_RULES
        .iter()
        .map(|(_, compare)| compare(left, right))
        .find(|order| order.is_ne())
        .unwrap_or(Ordering::Equal)
}

/// The first rule that tells two copies apart, which is why the winner is kept. Copies no rule
/// separates (the same path in two roots) are told apart by name order.
pub fn keep_reason(winner: &KeeperCandidate, loser: &KeeperCandidate) -> KeepReason {
    KEEPER_RULES
        .iter()
        .find(|(_, compare)| compare(winner, loser).is_ne())
        .map_or(KeepReason::NameOrder, |(reason, _)| *reason)
}

/// Copies, best keeper first, and the rule that put the first ahead of the second. The sort is
/// stable, as JavaScript's is, so copies no rule separates keep their order.
pub fn rank_keepers<T: AsRef<KeeperCandidate> + Clone>(
    candidates: &[T],
) -> (Vec<T>, Option<KeepReason>) {
    let mut ranked = candidates.to_vec();
    ranked.sort_by(|left, right| compare_keepers(right.as_ref(), left.as_ref()));
    let reason = match ranked.as_slice() {
        [first, second, ..] => Some(keep_reason(first.as_ref(), second.as_ref())),
        _ => None,
    };
    (ranked, reason)
}

impl AsRef<KeeperCandidate> for KeeperCandidate {
    fn as_ref(&self) -> &KeeperCandidate {
        self
    }
}
