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

#[cfg(test)]
mod tests {
    use super::*;

    /// A 1000×1000 PNG of a megabyte, in a folder of no preference: the copy every case varies.
    fn copy(id: FileId, rel_path: &str) -> KeeperCandidate {
        KeeperCandidate {
            id,
            rel_path: rel_path.into(),
            kind: FileKind::Image,
            format: Some(FileFormat::Png),
            ext: "png".into(),
            extension_mismatch: false,
            video_codec: None,
            width: Some(1000),
            height: Some(1000),
            duration_ms: None,
            audio_state: None,
            size: 1_000_000,
            mtime_ms: 1_700_000_000_000.0,
            is_preferred: false,
            in_home_folder: false,
        }
    }

    fn video(id: FileId, rel_path: &str) -> KeeperCandidate {
        KeeperCandidate {
            kind: FileKind::Video,
            format: Some(FileFormat::Mp4),
            ext: "mp4".into(),
            video_codec: Some("h264".into()),
            duration_ms: Some(30_000.0),
            ..copy(id, rel_path)
        }
    }

    /// The ids best first, and why the first beat the second.
    fn ranked(candidates: &[KeeperCandidate]) -> (Vec<FileId>, Option<KeepReason>) {
        let (ranked, reason) = rank_keepers(candidates);
        (
            ranked.iter().map(|candidate| candidate.id).collect(),
            reason,
        )
    }

    #[test]
    fn a_preferred_folder_beats_every_other_rule() {
        let big = KeeperCandidate {
            width: Some(4000),
            height: Some(3000),
            ..copy(1, "copies/1.png")
        };
        let preferred = KeeperCandidate {
            is_preferred: true,
            ..copy(2, "copies/2.png")
        };
        assert_eq!(
            ranked(&[big, preferred]),
            (vec![2, 1], Some(KeepReason::PreferredFolder))
        );
    }

    #[test]
    fn a_video_you_can_hear_beats_more_pixels_and_silence_beats_no_track() {
        let with = |id, audio_state, width| KeeperCandidate {
            audio_state: Some(audio_state),
            width: Some(width),
            ..video(id, &format!("clips/{id}.mp4"))
        };
        assert_eq!(
            ranked(&[
                with(1, AudioState::None, 1920),
                with(2, AudioState::Silent, 1920),
                with(3, AudioState::Sound, 1280),
                with(4, AudioState::Unmeasured, 1280),
            ]),
            (vec![3, 4, 2, 1], Some(KeepReason::HasSound))
        );
    }

    #[test]
    fn pixels_beat_bytes() {
        let heavy = KeeperCandidate {
            size: 3_000_000,
            ..copy(1, "a/photo.png")
        };
        let sharp = KeeperCandidate {
            width: Some(2000),
            height: Some(2000),
            ..copy(2, "b/photo.png")
        };
        assert_eq!(
            ranked(&[heavy, sharp]),
            (vec![2, 1], Some(KeepReason::MorePixels))
        );
    }

    #[test]
    fn a_longer_video_wins_only_by_half_a_second() {
        // 30,249 ms rounds to the same half second as 30,000; 30,250 does not.
        let long = |id, duration_ms| KeeperCandidate {
            duration_ms: Some(duration_ms),
            ..video(id, &format!("clips/{id}.mp4"))
        };
        assert_eq!(
            ranked(&[long(1, 30_000.0), long(2, 30_249.0), long(3, 30_250.0)]),
            (vec![3, 1, 2], Some(KeepReason::Longer))
        );
    }

    #[test]
    fn the_home_folder_beats_format_and_size() {
        let home = KeeperCandidate {
            in_home_folder: true,
            ..copy(1, "pages/1.png")
        };
        let heavier_avif = KeeperCandidate {
            format: Some(FileFormat::Avif),
            ext: "avif".into(),
            size: 3_000_000,
            ..copy(2, "other/1.avif")
        };
        assert_eq!(
            ranked(&[home, heavier_avif]),
            (vec![1, 2], Some(KeepReason::HomeFolder))
        );
    }

    #[test]
    fn the_archive_format_beats_bytes() {
        let png = KeeperCandidate {
            size: 2_000_000,
            ..copy(1, "a/photo.png")
        };
        let avif = KeeperCandidate {
            format: Some(FileFormat::Avif),
            ext: "avif".into(),
            size: 300_000,
            ..copy(2, "b/photo.avif")
        };
        assert_eq!(
            ranked(&[png, avif]),
            (vec![2, 1], Some(KeepReason::ArchiveFormat))
        );
        // MP4 counts only with a codec the archive keeps.
        let mpeg4 = KeeperCandidate {
            video_codec: Some("mpeg4".into()),
            size: 2_000_000,
            ..video(3, "a/clip.mp4")
        };
        assert_eq!(
            ranked(&[mpeg4, video(4, "b/clip.mp4")]),
            (vec![4, 3], Some(KeepReason::ArchiveFormat))
        );
    }

    #[test]
    fn the_formats_own_extension_beats_another_it_accepts() {
        let m4v = KeeperCandidate {
            ext: "m4v".into(),
            ..video(1, "misc/loop.m4v")
        };
        assert_eq!(
            ranked(&[m4v, video(2, "clips/loop.mp4")]),
            (vec![2, 1], Some(KeepReason::RightExtension))
        );
    }

    #[test]
    fn at_equal_pixels_more_bytes_is_more_detail() {
        let larger = KeeperCandidate {
            size: 1_200_000,
            ..copy(2, "b/photo.png")
        };
        assert_eq!(
            ranked(&[copy(1, "a/photo.png"), larger]),
            (vec![2, 1], Some(KeepReason::LargerFile))
        );
    }

    #[test]
    fn a_name_with_a_copy_suffix_loses_to_the_original() {
        for suffixed in [
            "photos/sunset (1).png",
            "photos/sunset copy.png",
            "photos/sunset copy 2.png",
            "photos/sunset-copy.png",
            "photos/sunset_copy3.png",
            "photos/sunset 2.png",
        ] {
            assert_eq!(
                ranked(&[copy(1, suffixed), copy(2, "photos/sunset.png")]),
                (vec![2, 1], Some(KeepReason::OriginalName)),
                "{suffixed}"
            );
        }
        // Not a copy suffix: the shorter path decides instead.
        assert_eq!(
            ranked(&[
                copy(1, "photos/sunset-2024.png"),
                copy(2, "photos/sunset.png")
            ])
            .1,
            Some(KeepReason::ShorterPath)
        );
    }

    #[test]
    fn the_oldest_wins_by_whole_milliseconds() {
        let newer = KeeperCandidate {
            mtime_ms: 1_700_000_000_999.9,
            ..copy(1, "copies/1.png")
        };
        let older = KeeperCandidate {
            mtime_ms: 1_700_000_000_000.1,
            ..copy(2, "copies/2.png")
        };
        assert_eq!(
            ranked(&[newer, older]),
            (vec![2, 1], Some(KeepReason::Oldest))
        );
        // The same millisecond is a tie, left to the rules after.
        let same = KeeperCandidate {
            mtime_ms: 1_700_000_000_000.9,
            ..copy(3, "copies/3.png")
        };
        assert_eq!(
            ranked(&[copy(4, "copies/4.png"), same]),
            (vec![3, 4], Some(KeepReason::NameOrder))
        );
    }

    #[test]
    fn the_shorter_path_then_name_order_break_the_last_ties() {
        assert_eq!(
            ranked(&[copy(1, "deep/er/path.png"), copy(2, "short/path.png")]),
            (vec![2, 1], Some(KeepReason::ShorterPath))
        );
        // Natural order: 9 before 10, then case, then accents.
        assert_eq!(
            ranked(&[
                copy(1, "b/photo10.png"),
                copy(2, "b/photo9.png"),
                copy(3, "b/Photo9.png"),
                copy(4, "b/phöto9.png"),
            ]),
            (vec![2, 3, 4, 1], Some(KeepReason::NameOrder))
        );
    }

    #[test]
    fn copies_no_rule_tells_apart_keep_their_order() {
        // The same path in two roots.
        assert_eq!(
            ranked(&[copy(1, "same/path.png"), copy(2, "same/path.png")]),
            (vec![1, 2], Some(KeepReason::NameOrder))
        );
        assert_eq!(ranked(&[copy(1, "only.png")]), (vec![1], None));
    }
}
