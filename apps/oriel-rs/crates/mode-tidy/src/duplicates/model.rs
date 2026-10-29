//! What Duplicates shows of a set (`components/duplicates/model.ts`): its rows, what resolving
//! keeps and moves, each version's facts against the keeper, and why the suggestion keeps what
//! it keeps.

use std::collections::BTreeSet;

use oriel_core_tidy::contract::{
    AudioState, DuplicateKind, DuplicateSet, FileId, FileKind, FileRow, KeepReason,
    deciding_versions, is_close_call,
};

use crate::format;

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
/// suggestion (`keptIds`).
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
/// picture; otherwise the first kept file (`keeperOf`).
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

/// The number of the version a row is a copy of, when Spot variants found it one
/// (`copyOfNumber`).
pub fn copy_of_number(set: &DuplicateSet, index: usize) -> Option<usize> {
    let pictures = set.pictures.as_ref()?;
    let picture = pictures.get(index)?;
    let first = pictures.iter().position(|other| other == picture)?;
    (first < index).then_some(first + 1)
}

/// Bytes resolving frees; a file hard-linked to a kept one frees nothing (`freedBytes`).
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

/// One fact under a tile; `worse` ones are what this version loses against the keeper.
#[derive(Clone, Debug, PartialEq)]
pub struct Fact {
    pub text: String,
    pub worse: bool,
}

/// A version's facts, each compared with the keeper's where a loss would matter (`factsOf`).
pub fn facts_of(file: &FileRow, keeper: &FileRow) -> Vec<Fact> {
    let mut facts = Vec::new();
    let same = file.id == keeper.id;
    if let Some(dimensions) = format::dimensions(file) {
        let ratio = match (pixels_of(file), pixels_of(keeper)) {
            (Some(pixels), Some(keeper_pixels)) if !same && keeper_pixels > 0 => {
                pixels as f64 / keeper_pixels as f64
            }
            _ => 1.,
        };
        let label = (ratio < 0.97)
            .then(|| ratio_label(ratio, "pixels"))
            .flatten();
        facts.push(Fact {
            text: match &label {
                Some(label) => format!("{dimensions} ({label})"),
                None => dimensions,
            },
            worse: label.is_some(),
        });
    }
    if file.kind == FileKind::Video
        && let Some(duration) = file.duration_ms
    {
        let seconds = match keeper.duration_ms {
            Some(keeper_duration) if !same => ((duration - keeper_duration) / 1000.).round() as i64,
            _ => 0,
        };
        facts.push(Fact {
            text: if seconds < 0 {
                format!(
                    "{} ({} s shorter)",
                    format::duration(Some(duration)),
                    -seconds
                )
            } else {
                format::duration(Some(duration))
            },
            worse: seconds < 0,
        });
    }
    if file.kind == FileKind::Video
        && let Some(audio) = file.audio_state
    {
        let silent = matches!(audio, AudioState::None | AudioState::Silent);
        facts.push(Fact {
            text: match audio {
                AudioState::None => "no sound track",
                AudioState::Silent => "silent",
                AudioState::Sound => "sound",
                AudioState::Unmeasured => "sound not checked",
            }
            .into(),
            worse: !same && silent && keeper.audio_state == Some(AudioState::Sound),
        });
    }
    facts.push(Fact {
        text: format::bytes(file.size as f64),
        worse: false,
    });
    facts.push(Fact {
        text: format::format_label(file.format).into(),
        worse: false,
    });
    facts
}

fn version_numbers(numbers: &[usize]) -> String {
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

/// What keeping every version is called: identical copies are kept both (or all); similar
/// versions are not duplicates (`keepEveryLabel`).
pub fn keep_every_label(set: &DuplicateSet, rows: &[SetRow]) -> String {
    if set.kind == DuplicateKind::Similar {
        return "Not duplicates".into();
    }
    if rows.len() == 2 {
        "Keep both".into()
    } else {
        format!("Keep all {}", rows.len())
    }
}

/// The primary button's label: the versions it keeps, by number (`decisionLabel`).
pub fn decision_label(set: &DuplicateSet, rows: &[SetRow], kept: &[FileId]) -> String {
    let numbers: Vec<usize> = rows
        .iter()
        .enumerate()
        .filter(|(_, row)| kept.contains(&row.file.id))
        .map(|(index, _)| index + 1)
        .collect();
    if numbers.len() == rows.len() {
        return keep_every_label(set, rows);
    }
    format!("Keep {}", version_numbers(&numbers))
}

/// Where resolving sends files: "3 versions and 2 copies go to holding · 120 KB"
/// (`holdingSummary`).
pub fn holding_summary(set: &DuplicateSet, rows: &[SetRow], kept: &[FileId]) -> String {
    let removed = removal_of(set, kept);
    if removed.is_empty() {
        return "Nothing goes to holding".into();
    }
    let bytes = format::bytes(freed_bytes(set, &removed) as f64);
    if set.kind == DuplicateKind::Exact {
        return format!(
            "{} to holding · {bytes}",
            if removed.len() == 1 {
                "1 copy goes".to_string()
            } else {
                format!("{} copies go", removed.len())
            }
        );
    }
    let versions = rows
        .iter()
        .filter(|row| !kept.contains(&row.file.id))
        .count();
    let copies = removed.len() - versions;
    let parts: Vec<String> = [
        (versions > 0).then(|| {
            if versions == 1 {
                "1 version".to_string()
            } else {
                format!("{versions} versions")
            }
        }),
        (copies > 0).then(|| {
            if copies == 1 {
                "1 copy".to_string()
            } else {
                format!("{copies} copies")
            }
        }),
    ]
    .into_iter()
    .flatten()
    .collect();
    format!(
        "{} {} to holding · {bytes}",
        parts.join(" and "),
        if removed.len() == 1 { "goes" } else { "go" }
    )
}

/// Why the suggested version is the one to keep, naming the value that decided it.
#[derive(Clone, Debug, PartialEq)]
pub struct Reason {
    pub text: String,
    pub close_call: bool,
}

/// `reasonOf`.
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
    let folder = if keeper.dir.is_empty() {
        "The top folder".to_string()
    } else {
        keeper.dir.clone()
    };
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
            format::dimensions(keeper).unwrap_or_default(),
            runner
                .and_then(format::dimensions)
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
                format::format_label(keeper.format)
            )
        }
        KeepReason::RightExtension => format!("Keeping {n}: its extension matches its contents"),
        KeepReason::OriginalName => format!(
            "Keeping {n}: {} looks like a copy",
            runner.map_or_else(|| m.to_string(), |runner| runner.name.clone())
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
    }
}
