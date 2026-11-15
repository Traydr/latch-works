//! What Duplicates shows of a set: its rows, what resolving
//! keeps and moves, each version's facts against the keeper, and why the suggestion keeps what
//! it keeps.

use std::collections::BTreeSet;

use oriel_core_domain::format;
use oriel_core_tidy::contract::{
    AudioState, DuplicateKind, DuplicateSet, FileId, FileKind, FileRow, FolderStanding, KeepReason,
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

/// The index in the set's folders of the folder a file is in.
pub fn folder_index(set: &DuplicateSet, file: &FileRow) -> Option<usize> {
    set.folders
        .iter()
        .position(|folder| folder.root_id == file.root_id && folder.dir == file.dir)
}

/// What keeping from a folder keeps: that folder's copy of each picture, and the suggested copy of
/// any picture the folder lacks, so no picture is lost. Among a picture's versions in the folder,
/// the best ranked. Files kept for another reason that are not tiles (copies the owner said are
/// not duplicates) stay kept.
pub fn keep_from_folder(set: &DuplicateSet, folder: usize) -> Vec<FileId> {
    if folder >= set.folders.len() {
        return set.keep.clone();
    }
    let rows = rows_of(set);
    let picture_of = |index: usize| match set.kind {
        DuplicateKind::Exact => 0,
        DuplicateKind::Similar => set
            .pictures
            .as_ref()
            .and_then(|pictures| pictures.get(index).copied())
            .unwrap_or(0),
    };
    let mut pictures: Vec<i64> = Vec::new();
    for index in 0..rows.len() {
        if !pictures.contains(&picture_of(index)) {
            pictures.push(picture_of(index));
        }
    }
    let mut keep: Vec<FileId> = Vec::new();
    for picture in pictures {
        let members: Vec<&SetRow> = (0..rows.len())
            .filter(|index| picture_of(*index) == picture)
            .map(|index| &rows[index])
            .collect();
        if let Some(row) = members
            .iter()
            .find(|row| folder_index(set, &row.file) == Some(folder))
        {
            keep.push(row.file.id);
            continue;
        }
        let suggested: Vec<FileId> = members
            .iter()
            .map(|row| row.file.id)
            .filter(|id| set.keep.contains(id))
            .collect();
        match suggested.is_empty() {
            true => keep.extend(members.first().map(|row| row.file.id)),
            false => keep.extend(suggested),
        }
    }
    let tiles: BTreeSet<FileId> = rows.iter().map(|row| row.file.id).collect();
    keep.extend(set.keep.iter().filter(|id| !tiles.contains(id)));
    keep
}

/// The folder whose pick keeps exactly `kept`, if one does.
pub fn chosen_folder(set: &DuplicateSet, kept: &[FileId]) -> Option<usize> {
    let kept: BTreeSet<FileId> = kept.iter().copied().collect();
    (0..set.folders.len()).find(|folder| {
        keep_from_folder(set, *folder)
            .into_iter()
            .collect::<BTreeSet<_>>()
            == kept
    })
}

/// Each folder as the folder panel names it: the part of its path that tells it from the set's
/// other folders, the path parts they all start with left out.
pub fn folder_labels(set: &DuplicateSet) -> Vec<String> {
    let parts: Vec<Vec<&str>> = set
        .folders
        .iter()
        .map(|folder| {
            folder
                .dir
                .split('/')
                .filter(|part| !part.is_empty())
                .collect()
        })
        .collect();
    let shortest = parts.iter().map(Vec::len).min().unwrap_or(0);
    let shared = (0..shortest)
        .take_while(|at| parts.iter().all(|folder| folder[*at] == parts[0][*at]))
        .count();
    let shared = if set.folders.len() < 2 { 0 } else { shared };
    parts
        .iter()
        .map(|folder| match &folder[shared..] {
            [] if shared == 0 => labels::folder_capitalized("").to_string(),
            [] => folder[shared - 1].to_string(),
            rest => rest.join("/"),
        })
        .collect()
}

/// What the folder panel says under a folder: how many tiles it holds, and how the owner chose
/// between it and the first folder before.
pub fn folder_note(set: &DuplicateSet, folder: usize) -> String {
    let rows = rows_of(set);
    let held = rows
        .iter()
        .filter(|row| folder_index(set, &row.file) == Some(folder))
        .count() as i64;
    let noun = if set.kind == DuplicateKind::Exact {
        format::plural_as(held, "copy", "copies")
    } else {
        format::plural(held, "version")
    };
    let record = match set.folders.get(folder).and_then(|folder| folder.standing) {
        _ if folder == 0 => "suggested".to_string(),
        Some(FolderStanding::Ordered(false)) => "after 1 in your order".to_string(),
        Some(FolderStanding::Ordered(true)) => "before 1 in your order".to_string(),
        Some(FolderStanding::Record(won, lost)) => format!("1 won {lost}\u{2013}{won}"),
        None => "never compared".to_string(),
    };
    format!("{noun} \u{b7} {record}")
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

/// The most characters a list of versions takes where the stage is wide, and on the decision
/// line, which has a row of its own.
pub const NAMED_LONGEST: usize = 16;

/// "1", "1 and 3", "1, 2 and 4", with runs of three or more as ranges: "1–15", "1–3, 5 and 9–12".
pub fn version_numbers(numbers: &[usize]) -> String {
    let mut runs: Vec<String> = Vec::new();
    let mut index = 0;
    while index < numbers.len() {
        let mut end = index;
        while end + 1 < numbers.len() && numbers[end + 1] == numbers[end] + 1 {
            end += 1;
        }
        if end - index >= 2 {
            runs.push(format!("{}–{}", numbers[index], numbers[end]));
        } else {
            runs.extend(numbers[index..=end].iter().map(ToString::to_string));
        }
        index = end + 1;
    }
    match runs.as_slice() {
        [] => String::new(),
        [one] => one.clone(),
        [rest @ .., last] => format!("{} and {last}", rest.join(", ")),
    }
}

/// The versions kept, in at most `longest` characters where it can: by number ("1–15"), else by
/// those left out ("all but 3, 9 and 12"), else by count ("8 of 16").
pub fn kept_versions(numbers: &[usize], total: usize, longest: usize) -> String {
    if let Some(named) = short_version_numbers(numbers, longest) {
        return named;
    }
    let left_out: Vec<usize> = (1..=total).filter(|n| !numbers.contains(n)).collect();
    Some(format!("all but {}", version_numbers(&left_out)))
        .filter(|all_but| !left_out.is_empty() && all_but.chars().count() <= longest)
        .unwrap_or_else(|| format!("{} of {total}", numbers.len()))
}

/// The numbers as `version_numbers` says them, when that takes at most `longest` characters.
pub fn short_version_numbers(numbers: &[usize], longest: usize) -> Option<String> {
    Some(version_numbers(numbers)).filter(|named| named.chars().count() <= longest)
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

/// The primary button's label: the versions it keeps, in at most `longest` characters after
/// "Keep " where it can (see [`kept_versions`]).
pub fn decision_label(rows: &[SetRow], kept: &[FileId], longest: usize) -> String {
    let numbers: Vec<usize> = rows
        .iter()
        .enumerate()
        .filter(|(_, row)| kept.contains(&row.file.id))
        .map(|(index, _)| index + 1)
        .collect();
    if numbers.len() == rows.len() {
        return keep_every_label(rows);
    }
    format!("Keep {}", kept_versions(&numbers, rows.len(), longest))
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
                format!(
                    "Your pick: keep {}",
                    kept_versions(&numbers, rows.len(), NAMED_LONGEST)
                )
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
        KeepReason::FolderPriority => {
            let number = folder_index(set, keeper).map_or(1, |folder| folder + 1);
            // Standings are against the first folder, which holds the keeper.
            let standing = runner
                .and_then(|runner| folder_index(set, runner))
                .and_then(|folder| set.folders.get(folder))
                .and_then(|folder| folder.standing)
                .filter(|_| number == 1);
            match standing {
                Some(FolderStanding::Ordered(_)) => {
                    format!("Keeping {n}: folder {number} comes first in your order")
                }
                Some(FolderStanding::Record(won, lost)) => format!(
                    "Keeping {n}: you usually keep folder {number}'s copy ({lost}\u{2013}{won})"
                ),
                None => format!("Keeping {n}: you usually keep folder {number}'s copy"),
            }
        }
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
    use oriel_core_tidy::contract::{DuplicateVersion, SetFolder};

    fn file(id: FileId, dir: &str) -> FileRow {
        FileRow {
            id,
            root_id: 1,
            rel_path: format!("{dir}/{id}.avif"),
            abs_path: format!("/r/{dir}/{id}.avif"),
            name: format!("{id}.avif"),
            dir: dir.into(),
            ext: "avif".into(),
            size: 1,
            mtime_ms: 0.,
            ctime_ms: 0.,
            kind: FileKind::Image,
            format: None,
            extension_mismatch: false,
            width: None,
            height: None,
            frames: None,
            duration_ms: None,
            video_codec: None,
            audio_codec: None,
            audio_state: None,
            bitrate: None,
            probe_error: None,
            sha256: None,
        }
    }

    /// Versions (id, folder, picture) in tile order, keeping `keep`.
    fn similar(versions: &[(FileId, &str, i64)], keep: &[FileId]) -> DuplicateSet {
        let mut folders: Vec<SetFolder> = Vec::new();
        for (_, dir, _) in versions {
            if !folders.iter().any(|folder| folder.dir == *dir) {
                folders.push(SetFolder {
                    root_id: 1,
                    dir: (*dir).into(),
                    standing: None,
                });
            }
        }
        DuplicateSet {
            key: "set:1".into(),
            kind: DuplicateKind::Similar,
            versions: versions
                .iter()
                .map(|(id, dir, _)| DuplicateVersion {
                    files: vec![file(*id, dir)],
                })
                .collect(),
            pictures: Some(versions.iter().map(|(_, _, picture)| *picture).collect()),
            keep: keep.to_vec(),
            keep_reason: KeepReason::FolderPriority,
            reclaimable_bytes: 0,
            hard_linked_ids: Vec::new(),
            distance: Some(0),
            dismissal_id: None,
            folders,
        }
    }

    #[test]
    fn keeping_from_a_folder_never_drops_a_picture_it_lacks() {
        // Pictures 0 and 1 are in both folders; picture 2 only in the first.
        let set = similar(
            &[
                (1, "patreon/a", 0),
                (2, "twitter/a", 0),
                (3, "patreon/a", 1),
                (4, "twitter/a", 1),
                (5, "patreon/a", 2),
            ],
            &[1, 3, 5],
        );
        assert_eq!(keep_from_folder(&set, 1), vec![2, 4, 5]);
        assert_eq!(keep_from_folder(&set, 0), vec![1, 3, 5]);
        assert_eq!(chosen_folder(&set, &[5, 4, 2]), Some(1));
        assert_eq!(chosen_folder(&set, &[1, 4, 5]), None);
    }

    #[test]
    fn a_folder_with_two_copies_of_one_picture_keeps_the_best_ranked() {
        let set = similar(&[(1, "a", 0), (2, "b", 0), (3, "b", 0)], &[1]);
        assert_eq!(keep_from_folder(&set, 1), vec![2]);
    }

    #[test]
    fn folder_labels_leave_out_what_every_folder_starts_with() {
        let set = similar(
            &[
                (1, "nsfw/patreon/croove/2024", 0),
                (2, "nsfw/twitter/croove", 0),
            ],
            &[1],
        );
        assert_eq!(
            folder_labels(&set),
            ["patreon/croove/2024", "twitter/croove"]
        );
        let nested = similar(&[(1, "nsfw/a", 0), (2, "nsfw/a/b", 0)], &[1]);
        assert_eq!(folder_labels(&nested), ["a", "b"]);
    }

    #[test]
    fn names_versions_as_the_renderer_does() {
        assert_eq!(version_numbers(&[1]), "1");
        assert_eq!(version_numbers(&[1, 3]), "1 and 3");
        assert_eq!(version_numbers(&[1, 2, 4]), "1, 2 and 4");
        assert_eq!(version_numbers(&[1, 2, 3]), "1–3");
        assert_eq!(
            version_numbers(&[1, 2, 3, 5, 9, 10, 11, 12]),
            "1–3, 5 and 9–12"
        );
        let first: Vec<usize> = (1..=15).collect();
        assert_eq!(kept_versions(&first, 16, 7), "1–15");
        let all_but: Vec<usize> = (1..=16).filter(|n| ![3, 9, 12].contains(n)).collect();
        assert_eq!(kept_versions(&all_but, 16, 20), "all but 3, 9 and 12");
        assert_eq!(kept_versions(&all_but, 16, 16), "13 of 16");
        let odd: Vec<usize> = (1..=16).step_by(2).collect();
        assert_eq!(kept_versions(&odd, 16, 16), "8 of 16");
        assert_eq!(kept_versions(&[1, 3], 3, 7), "1 and 3");
        assert_eq!(
            kept_versions(&[1, 2, 3, 5, 9, 10, 11, 12], 16, 12),
            "8 of 16"
        );
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
