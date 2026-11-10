//! What Duplicates shows of a set: its rows, what resolving
//! keeps and moves, each version's facts against the keeper, and why the suggestion keeps what
//! it keeps.

use std::collections::BTreeSet;

use oriel_core_domain::format;
use oriel_core_tidy::contract::{
    AudioState, DuplicateKind, DuplicateSet, FileId, FileKind, FileRow, KeepReason,
    deciding_versions, is_close_call,
};

use crate::labels;

/// One tile of a set: a version, or for identical copies, one copy.
#[derive(Clone, Debug, PartialEq)]
pub struct SetRow {
    pub file: FileRow,
    /// Byte-identical copies that go with this version.
    pub copies: Vec<FileRow>,
}

pub fn rows_of(set: &DuplicateSet) -> Vec<SetRow> {
    if set.kind == DuplicateKind::Exact {
        return set
            .versions
            .first()
            .map(|version| {
                version
                    .files
                    .iter()
                    .map(|file| SetRow {
                        file: file.clone(),
                        copies: Vec::new(),
                    })
                    .collect()
            })
            .unwrap_or_default();
    }
    set.versions
        .iter()
        .filter_map(|version| {
            let (file, copies) = version.files.split_first()?;
            Some(SetRow {
                file: file.clone(),
                copies: copies.to_vec(),
            })
        })
        .collect()
}

pub fn files_of(set: &DuplicateSet) -> Vec<&FileRow> {
    set.versions
        .iter()
        .flat_map(|version| version.files.iter())
        .collect()
}

/// What resolving keeps: the owner's choice while it still names files of the set, else the
/// suggestion.
pub fn kept_ids(set: &DuplicateSet, overridden: Option<&[FileId]>) -> Vec<FileId> {
    let members: BTreeSet<FileId> = files_of(set).iter().map(|file| file.id).collect();
    match overridden {
        Some(keep) if !keep.is_empty() && keep.iter().all(|id| members.contains(id)) => {
            keep.to_vec()
        }
        _ => set.keep.clone(),
    }
}

pub fn removal_of<'a>(set: &'a DuplicateSet, kept: &[FileId]) -> Vec<&'a FileRow> {
    files_of(set)
        .into_iter()
        .filter(|file| !kept.contains(&file.id))
        .collect()
}

/// With Spot variants, the version a row's facts compare against: the kept copy of the same
/// picture; otherwise the first kept file.
pub fn keeper_of<'a>(
    set: &DuplicateSet,
    rows: &'a [SetRow],
    index: usize,
    kept: &[FileId],
) -> Option<&'a FileRow> {
    let first = rows
        .iter()
        .find(|row| kept.contains(&row.file.id))
        .or(rows.first())
        .map(|row| &row.file);
    let Some(picture) = set
        .pictures
        .as_ref()
        .and_then(|pictures| pictures.get(index))
    else {
        return first;
    };
    let pictures = set.pictures.as_ref()?;
    rows.iter()
        .enumerate()
        .find(|(other, row)| pictures.get(*other) == Some(picture) && kept.contains(&row.file.id))
        .map(|(_, row)| &row.file)
        .or(first)
}

/// The number of the version a row is a copy of, when Spot variants found it one.
pub fn copy_of_number(set: &DuplicateSet, index: usize) -> Option<usize> {
    let pictures = set.pictures.as_ref()?;
    let picture = pictures.get(index)?;
    let first = pictures.iter().position(|other| other == picture)?;
    (first < index).then_some(first + 1)
}

/// Bytes resolving frees; a file hard-linked to a kept one frees nothing.
pub fn freed_bytes(set: &DuplicateSet, removed: &[&FileRow]) -> i64 {
    removed
        .iter()
        .filter(|file| !set.hard_linked_ids.contains(&file.id))
        .map(|file| file.size)
        .sum()
}

fn pixels_of(file: &FileRow) -> Option<i64> {
    Some(file.width? * file.height?)
}

/// A share below the keeper's in the fewest letters, as [`ratio_label`] words it: "1/4", "92%".
fn ratio_share(ratio: f64) -> String {
    if ratio <= 0.55 {
        format!("1/{}", (1. / ratio).round())
    } else {
        format!("{}%", (ratio * 100.).round())
    }
}

fn ratio_label(ratio: f64, noun: &str) -> Option<String> {
    if ratio > 0.97 && ratio < 1.03 {
        return None;
    }
    if ratio < 1. {
        return Some(if ratio <= 0.55 {
            format!("1/{} the {noun}", (1. / ratio).round())
        } else {
            format!("{}% of the {noun}", (ratio * 100.).round())
        });
    }
    Some(if ratio >= 10. {
        format!("{ratio:.0}× the {noun}")
    } else {
        format!("{ratio:.1}× the {noun}")
    })
}

/// How a version's value compares with the keeper's, which decides how a lane draws it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Standing {
    /// The keeper's own value, or one that differs without being a loss.
    Plain,
    /// The same as the keeper's.
    Same,
    /// What this version loses against the keeper.
    Worse,
}

/// One labelled row under a tile ("Dimensions 1280×720 (1/4 the pixels)"). Every tile of a set
/// shows the same lanes in the same order, so versions line up for comparison.
#[derive(Clone, Debug, PartialEq)]
pub struct Lane {
    pub label: &'static str,
    pub value: String,
    pub standing: Standing,
    /// The value with its comparison cut down, where a narrow tile would cut the whole off:
    /// "1152×3456 · 92%".
    compact: Option<String>,
}

impl Lane {
    fn new(label: &'static str, value: String, standing: Standing) -> Self {
        Self {
            label,
            value,
            standing,
            compact: None,
        }
    }

    fn compact(mut self, compact: String) -> Self {
        self.compact = Some(compact);
        self
    }

    /// The value where its label does not show: "Yes" says nothing without "Sound" before it.
    pub fn said_alone(&self) -> String {
        match (self.label, self.value.as_str()) {
            ("Sound", "Yes") => "Sound".to_owned(),
            ("Sound", "Not checked") => "Sound not checked".to_owned(),
            _ => self.value.clone(),
        }
    }

    fn whole(&self, labelled: bool) -> String {
        if labelled {
            self.value.clone()
        } else {
            self.said_alone()
        }
    }

    /// Whether `room` letters would cut this value off when it has a shorter form to take instead.
    pub fn overflows(&self, room: usize, labelled: bool) -> bool {
        self.compact.is_some() && self.whole(labelled).chars().count() > room
    }

    /// What a tile shows, with its label beside it or not: the whole value, or its compact form.
    pub fn shown(&self, compact: bool, labelled: bool) -> String {
        match &self.compact {
            Some(short) if compact => short.clone(),
            _ => self.whole(labelled),
        }
    }

    /// Whether this version loses on this lane.
    pub fn worse(&self) -> bool {
        self.standing == Standing::Worse
    }
}

/// What a lane shows when the file has no such value.
const NONE: &str = "—";

/// Whether a set's tiles carry the video lanes (Length and Sound): when any version is a video,
/// every tile does, so the lanes stay level across the set.
pub fn has_video(rows: &[SetRow]) -> bool {
    rows.iter().any(|row| row.file.kind == FileKind::Video)
}

fn audio_label(audio: AudioState) -> &'static str {
    match audio {
        AudioState::None => "No sound track",
        AudioState::Silent => "Silent",
        AudioState::Sound => "Yes",
        AudioState::Unmeasured => "Not checked",
    }
}

/// A version's lanes against the keeper, as labelled rows: Dimensions; Length and
/// Sound when `video`; Size; Format. A loss names its difference.
pub fn facts_of(file: &FileRow, keeper: &FileRow, video: bool) -> Vec<Lane> {
    let same = file.id == keeper.id;
    let compare = |equal: bool| {
        if equal && !same {
            Standing::Same
        } else {
            Standing::Plain
        }
    };
    let mut lanes = Vec::new();
    lanes.push(match labels::dimensions(file) {
        Some(dimensions) => {
            let ratio = match (pixels_of(file), pixels_of(keeper)) {
                (Some(pixels), Some(keeper_pixels)) if !same && keeper_pixels > 0 => {
                    pixels as f64 / keeper_pixels as f64
                }
                _ => 1.,
            };
            match (ratio < 0.97)
                .then(|| ratio_label(ratio, "pixels"))
                .flatten()
            {
                Some(label) => Lane::new(
                    "Dimensions",
                    format!("{dimensions} ({label})"),
                    Standing::Worse,
                )
                .compact(format!("{dimensions} · {}", ratio_share(ratio))),
                None => Lane::new(
                    "Dimensions",
                    dimensions.clone(),
                    compare(labels::dimensions(keeper) == Some(dimensions)),
                ),
            }
        }
        None => Lane::new("Dimensions", NONE.into(), compare(true)),
    });
    if video {
        lanes.push(
            match file.duration_ms.filter(|_| file.kind == FileKind::Video) {
                Some(duration) => {
                    let seconds = match keeper.duration_ms {
                        Some(keeper_duration) if !same => {
                            ((duration - keeper_duration) / 1000.).round() as i64
                        }
                        _ => 0,
                    };
                    if seconds < 0 {
                        Lane::new(
                            "Length",
                            format!(
                                "{} ({} s shorter)",
                                format::duration(Some(duration)),
                                -seconds
                            ),
                            Standing::Worse,
                        )
                    } else {
                        Lane::new(
                            "Length",
                            format::duration(Some(duration)),
                            compare(seconds == 0),
                        )
                    }
                }
                None => Lane::new("Length", NONE.into(), compare(keeper.duration_ms.is_none())),
            },
        );
        lanes.push(
            match file.audio_state.filter(|_| file.kind == FileKind::Video) {
                Some(audio) => {
                    let silent = matches!(audio, AudioState::None | AudioState::Silent);
                    let lost = !same && silent && keeper.audio_state == Some(AudioState::Sound);
                    Lane::new(
                        "Sound",
                        audio_label(audio).into(),
                        if lost {
                            Standing::Worse
                        } else {
                            compare(keeper.audio_state == Some(audio))
                        },
                    )
                }
                None => Lane::new("Sound", NONE.into(), compare(keeper.audio_state.is_none())),
            },
        );
    }
    let difference = file.size - keeper.size;
    let size = format::bytes(file.size as f64);
    let apart = format::bytes(difference.unsigned_abs() as f64);
    lanes.push(if same || difference == 0 {
        Lane::new("Size", size, compare(difference == 0))
    } else {
        let (words, sign) = if difference < 0 {
            ("smaller", "−")
        } else {
            ("larger", "+")
        };
        Lane::new(
            "Size",
            format!("{size} ({apart} {words})"),
            compare(difference == 0),
        )
        .compact(format!("{size} · {sign}{apart}"))
    });
    lanes.push(Lane::new(
        "Format",
        labels::format_label(file.format).into(),
        compare(file.format == keeper.format),
    ));
    lanes
}

/// "1", "1 and 3", "1, 2 and 3".
pub fn version_numbers(numbers: &[usize]) -> String {
    match numbers {
        [] => String::new(),
        [one] => one.to_string(),
        [rest @ .., last] => format!(
            "{} and {last}",
            rest.iter()
                .map(ToString::to_string)
                .collect::<Vec<_>>()
                .join(", ")
        ),
    }
}

/// What keeping every version is called, for either kind: "Keep both", or "Keep all". The set
/// is then marked as not duplicates; the command never takes that name.
pub fn keep_every_label(rows: &[SetRow]) -> String {
    if rows.len() == 2 {
        "Keep both".into()
    } else {
        "Keep all".into()
    }
}

/// The primary button's label: the versions it keeps, by number.
pub fn decision_label(rows: &[SetRow], kept: &[FileId]) -> String {
    let numbers: Vec<usize> = rows
        .iter()
        .enumerate()
        .filter(|(_, row)| kept.contains(&row.file.id))
        .map(|(index, _)| index + 1)
        .collect();
    if numbers.len() == rows.len() {
        return keep_every_label(rows);
    }
    format!("Keep {}", version_numbers(&numbers))
}

/// Why the suggested version is the one to keep, naming the value that decided it.
#[derive(Clone, Debug, PartialEq)]
pub struct Reason {
    pub text: String,
    pub close_call: bool,
}

/// Why the versions kept are the ones to keep, or why the owner's own choice differs.
pub fn reason_of(set: &DuplicateSet, rows: &[SetRow], kept: &[FileId], overridden: bool) -> Reason {
    let numbers: Vec<usize> = rows
        .iter()
        .enumerate()
        .filter(|(_, row)| kept.contains(&row.file.id))
        .map(|(index, _)| index + 1)
        .collect();
    if overridden {
        return Reason {
            text: if numbers.len() == rows.len() {
                "You are keeping every version".into()
            } else {
                format!("Your pick: keep {}", version_numbers(&numbers))
            },
            close_call: false,
        };
    }
    if set.keep_reason == KeepReason::DifferentPictures {
        return Reason {
            text: "Every version differs in one area, so each one stays".into(),
            close_call: false,
        };
    }
    let pair = (set.kind == DuplicateKind::Similar)
        .then(|| deciding_versions(&set.versions, set.pictures.as_deref()))
        .flatten();
    let keeper_index = match pair {
        Some((kept, _)) => kept,
        None => rows
            .iter()
            .position(|row| set.keep.first() == Some(&row.file.id))
            .unwrap_or(0),
    };
    let runner_index = match pair {
        Some((_, runner)) => runner,
        None if keeper_index == 0 => 1,
        None => 0,
    };
    let Some(keeper) = rows.get(keeper_index).map(|row| &row.file) else {
        return Reason {
            text: String::new(),
            close_call: false,
        };
    };
    let runner = rows.get(runner_index).map(|row| &row.file);
    let (n, m) = (keeper_index + 1, runner_index + 1);
    let folder = crate::labels::folder_capitalized(&keeper.dir).to_owned();
    let close_call = is_close_call(set);
    let pictures = set
        .pictures
        .as_ref()
        .map_or(0, |pictures| pictures.iter().collect::<BTreeSet<_>>().len());
    let lead = if pictures > 1 {
        format!("{pictures} different pictures, each kept once. ")
    } else {
        String::new()
    };
    let exact = set.kind == DuplicateKind::Exact;
    let text = match set.keep_reason {
        KeepReason::PreferredFolder => format!("Keeping {n}: {folder} is a preferred folder"),
        KeepReason::HasSound => format!("Keeping {n}: it has sound, {m} does not"),
        KeepReason::MorePixels => format!(
            "Keeping {n}: most pixels ({} against {})",
            labels::dimensions(keeper).unwrap_or_default(),
            runner
                .and_then(labels::dimensions)
                .unwrap_or_else(|| "unknown".into())
        ),
        KeepReason::Longer => format!(
            "Keeping {n}: longest ({} against {})",
            format::duration(keeper.duration_ms),
            format::duration(runner.and_then(|runner| runner.duration_ms))
        ),
        KeepReason::HomeFolder => format!("Keeping {n}: {folder} holds the rest of this set"),
        KeepReason::ArchiveFormat => {
            format!(
                "Keeping {n}: already {}",
                labels::format_label(keeper.format)
            )
        }
        KeepReason::RightExtension => format!("Keeping {n}: its extension matches its contents"),
        KeepReason::OriginalName => format!(
            "Keeping {n}: {} looks like a copy",
            runner.map_or_else(|| m.to_string(), |runner| runner.name.clone())
        ),
        KeepReason::AlreadyReencoded => format!(
            "Keeping {n}: Tidy already shrank it, {} smaller than {m}",
            format::bytes((runner.map_or(0, |runner| runner.size) - keeper.size).max(0) as f64)
        ),
        KeepReason::LargerFile if close_call => format!(
            "Close call: {n} is only {} larger",
            format::bytes((keeper.size - runner.map_or(0, |runner| runner.size)).max(0) as f64)
        ),
        KeepReason::LargerFile => {
            format!("Keeping {n}: the largest file, so the least compressed")
        }
        KeepReason::Oldest if exact => format!(
            "Keeping {n}: the oldest copy ({})",
            format::date_time(keeper.mtime_ms)
        ),
        KeepReason::Oldest => format!("Close call: {n} is the oldest"),
        KeepReason::ShorterPath if exact => format!("Keeping {n}: the shortest path"),
        KeepReason::ShorterPath => format!("Close call: {n} has the shortest path"),
        KeepReason::NameOrder if exact => format!("Keeping {n}: first by name"),
        KeepReason::NameOrder => format!("Close call: {n} comes first by name"),
        KeepReason::DifferentPictures => unreachable!("handled above"),
    };
    Reason {
        text: format!("{lead}{text}"),
        close_call,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_versions_as_the_renderer_does() {
        assert_eq!(version_numbers(&[1]), "1");
        assert_eq!(version_numbers(&[1, 3]), "1 and 3");
        assert_eq!(version_numbers(&[1, 2, 4]), "1, 2 and 4");
        assert_eq!(
            ratio_label(0.25, "pixels").as_deref(),
            Some("1/4 the pixels")
        );
        assert_eq!(
            ratio_label(0.75, "pixels").as_deref(),
            Some("75% of the pixels")
        );
        assert_eq!(ratio_label(1.0, "pixels"), None);
        assert_eq!(ratio_share(0.25), "1/4");
        assert_eq!(ratio_share(0.92), "92%");
    }
}
