//! What Convert would change, from glazier-core's `optimize/candidates.ts`: every file the archive
//! policy (`oriel-core-format`) would convert or rename, and why the others are left alone.

use std::collections::{HashMap, HashSet};

use indexmap::IndexMap;
use oriel_core_format::{
    ArchiveImageFormat, ArchiveImageSource, ArchiveMediaAction, ArchiveVideoPlan,
    ArchiveVideoSource, AudioCodec, AudioTrackPlan, VideoCodec, VideoContainer, VideoTrackPlan,
    plan_archive_image, plan_archive_video, replace_file_extension,
};
use rusqlite::Connection;

use crate::catalog::files::{SqlParams, query_records};
use crate::catalog::rows::{
    FILE_COLUMNS, FILES_FROM, FINGERPRINT_VERSION, FINGERPRINTABLE_SQL, FileRecord,
};
use crate::contract::{
    CategoryCount, FileFormat, FileId, OptimizeCategory, OptimizeSummary, RootId, SkipCount,
};
use crate::duplicates::Dismissals;
use crate::duplicates::queries::exact_group_sql;
use crate::scan::preferred_extension;

/// A file the archive policy would change, and how.
#[derive(Clone, Debug, PartialEq)]
pub struct OptimizeCandidate {
    pub category: OptimizeCategory,
    pub record: FileRecord,
    pub target_name: String,
    /// For an animation, the MIME type its frames are read as.
    pub mime_type: Option<&'static str>,
    /// For a video, what happens to each track.
    pub tracks: Option<(VideoTrackPlan, AudioTrackPlan)>,
}

/// Convert's candidates under a root, and how many files each reason left out, in the order the
/// reasons first came up.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct CandidateScan {
    pub candidates: Vec<OptimizeCandidate>,
    pub skipped: IndexMap<String, i64>,
}

/// Why a file the policy would change is left out of the Convert step.
pub const SKIP_DUPLICATE: &str = "Identical copies (resolve duplicates first)";

const SKIP_NOT_SMALLER: &str = "Already as small as they get";

pub const SKIP_REVIEW: &str = "Similar versions (review them first)";

pub const SKIP_UNCHECKED: &str = "Not checked for similar versions yet";

/// Files Convert leaves alone for now because duplicate review still needs them as they are: the
/// members of open similar sets, and (while background analysis is on, so the check will come)
/// files not yet checked for similar versions, which may turn out to belong to such a set.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct CandidateHolds {
    pub reviewing: HashSet<FileId>,
    pub wait_for_fingerprints: bool,
}

fn image_format(format: Option<FileFormat>) -> Option<ArchiveImageFormat> {
    Some(match format? {
        FileFormat::Png => ArchiveImageFormat::Png,
        FileFormat::Jpeg => ArchiveImageFormat::Jpeg,
        FileFormat::Gif => ArchiveImageFormat::Gif,
        FileFormat::Webp => ArchiveImageFormat::Webp,
        FileFormat::Bmp => ArchiveImageFormat::Bmp,
        FileFormat::Avif => ArchiveImageFormat::Avif,
        _ => return None,
    })
}

fn video_container(format: Option<FileFormat>) -> Option<VideoContainer> {
    Some(match format? {
        FileFormat::Mp4 => VideoContainer::Mp4,
        FileFormat::Mov => VideoContainer::Mov,
        FileFormat::Matroska => VideoContainer::Matroska,
        FileFormat::Webm => VideoContainer::Webm,
        FileFormat::Mpegts => VideoContainer::Mpegts,
        FileFormat::Avi => VideoContainer::Avi,
        FileFormat::Flv => VideoContainer::Flv,
        FileFormat::Asf => VideoContainer::Asf,
        _ => return None,
    })
}

/// ffprobe's video codec names, as Mediabunny names them.
fn ffprobe_video_codec(name: &str) -> VideoCodec {
    match name {
        "h264" => VideoCodec::Avc,
        "hevc" => VideoCodec::Hevc,
        "av1" => VideoCodec::Av1,
        "vp9" => VideoCodec::Vp9,
        "vp8" => VideoCodec::Vp8,
        "prores" => VideoCodec::Prores,
        _ => VideoCodec::Other,
    }
}

/// ffprobe's audio codec names, as Mediabunny names them.
fn ffprobe_audio_codec(name: &str) -> AudioCodec {
    match name {
        "aac" => AudioCodec::Aac,
        "mp3" => AudioCodec::Mp3,
        "opus" => AudioCodec::Opus,
        "vorbis" => AudioCodec::Vorbis,
        "flac" => AudioCodec::Flac,
        "ac3" => AudioCodec::Ac3,
        "eac3" => AudioCodec::Eac3,
        "dts" => AudioCodec::Dts,
        "pcm_s16le" => AudioCodec::PcmS16,
        "pcm_s16be" => AudioCodec::PcmS16be,
        "pcm_s24le" => AudioCodec::PcmS24,
        "pcm_s32le" => AudioCodec::PcmS32,
        "pcm_f32le" => AudioCodec::PcmF32,
        "pcm_u8" => AudioCodec::PcmU8,
        _ => AudioCodec::Other,
    }
}

/// What the video policy knows of a catalogued video, or `None` for a format no container is.
pub fn video_source_of(record: &FileRecord) -> Option<ArchiveVideoSource<'_>> {
    Some(ArchiveVideoSource {
        file_name: &record.name,
        container: video_container(record.format)?,
        video_codec: record.video_codec.as_deref().map(ffprobe_video_codec),
        audio_codec: if record.audio_streams.unwrap_or(0) == 0 {
            None
        } else {
            record.audio_codec.as_deref().map(ffprobe_audio_codec)
        },
    })
}

fn rel_path_beside(record: &FileRecord, name: &str) -> String {
    if record.dir.is_empty() {
        name.to_owned()
    } else {
        format!("{}/{name}", record.dir)
    }
}

/// Files of a root fingerprinting has not reached yet.
pub fn unchecked_files(
    connection: &Connection,
    root_id: RootId,
) -> anyhow::Result<HashSet<FileId>> {
    let params = SqlParams::new()
        .with("root", root_id)
        .with("version", FINGERPRINT_VERSION);
    let mut statement = connection.prepare_cached(&format!(
        "SELECT f.id FROM files f
          WHERE f.root_id = $root AND f.fingerprint_version < $version AND {FINGERPRINTABLE_SQL}"
    ))?;
    let rows = statement.query_map(&*params.named(), |row| row.get(0))?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

/// Every file in an open set of identical copies. Converting one of them, even the keeper, turns
/// the set from identical copies into similar versions that need a closer look, so the whole set
/// waits until its duplicates are resolved or dismissed.
pub fn open_duplicate_copies(
    connection: &Connection,
    root_id: RootId,
) -> anyhow::Result<HashSet<FileId>> {
    let mut params = SqlParams::new();
    let groups = exact_group_sql(Some(root_id), &mut params);
    let mut statement = connection.prepare_cached(&format!(
        "SELECT f.id, f.sha256 FROM files f
      WHERE f.sha256 IN ({groups})
        AND f.root_id = $root AND f.is_junk = 0 AND f.size > 0"
    ))?;
    let members: Vec<(FileId, String)> = statement
        .query_map(&*params.named(), |row| Ok((row.get(0)?, row.get(1)?)))?
        .collect::<rusqlite::Result<_>>()?;
    let mut groups: HashMap<String, Vec<FileId>> = HashMap::new();
    for (id, sha256) in members {
        groups.entry(sha256).or_default().push(id);
    }
    let dismissals = Dismissals::load(connection)?;
    Ok(groups
        .into_values()
        .filter(|ids| dismissals.covering(ids).is_none())
        .flatten()
        .collect())
}

/// The lowercased paths of every file under a root, which a conversion's target must not take.
pub fn taken_paths(connection: &Connection, root_id: RootId) -> anyhow::Result<HashSet<String>> {
    let mut statement =
        connection.prepare_cached("SELECT rel_path FROM files WHERE root_id = ?1")?;
    let rows = statement.query_map([root_id], |row| row.get::<_, String>(0))?;
    rows.map(|row| Ok(row?.to_lowercase())).collect()
}

/// Every file under a root the archive policy would convert or rename. A conversion whose target
/// name is already taken is skipped, never overwritten; identical copies wait for duplicate
/// review, as do the files `holds` names, and a file an earlier conversion could not shrink is
/// left as it is.
pub fn find_optimize_candidates(
    connection: &Connection,
    root_id: RootId,
    holds: &CandidateHolds,
) -> anyhow::Result<CandidateScan> {
    let records = query_records(
        connection,
        &format!(
            "SELECT {FILE_COLUMNS} FROM {FILES_FROM}
      WHERE f.root_id = $root AND f.is_junk = 0 AND f.size > 0 AND f.kind IN ('image', 'video')
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
    let mut scan = CandidateScan::default();

    for record in records {
        if record.probe_error.is_some() {
            skip_one(&mut scan.skipped, "Won't decode");
            continue;
        }
        let candidate = if record.kind == crate::contract::FileKind::Image {
            image_candidate(&record, &mut |reason| skip_one(&mut scan.skipped, reason))
        } else {
            video_candidate(&record, &mut |reason| skip_one(&mut scan.skipped, reason))
        };
        let Some(candidate) = candidate else {
            continue;
        };
        if duplicates.contains(&record.id) {
            skip_one(&mut scan.skipped, SKIP_DUPLICATE);
            continue;
        }
        if holds.reviewing.contains(&record.id) {
            skip_one(&mut scan.skipped, SKIP_REVIEW);
            continue;
        }
        if unchecked.contains(&record.id) {
            skip_one(&mut scan.skipped, SKIP_UNCHECKED);
            continue;
        }
        if record.optimize_not_smaller {
            skip_one(&mut scan.skipped, SKIP_NOT_SMALLER);
            continue;
        }
        let target = rel_path_beside(&record, &candidate.target_name).to_lowercase();
        if target != record.rel_path.to_lowercase() && taken.contains(&target) {
            skip_one(
                &mut scan.skipped,
                "A file with the target name already exists",
            );
            continue;
        }
        scan.candidates.push(candidate);
    }
    Ok(scan)
}

fn image_candidate(record: &FileRecord, skip: &mut dyn FnMut(&str)) -> Option<OptimizeCandidate> {
    let Some(format) = image_format(record.format) else {
        if let Some(format @ (FileFormat::Tiff | FileFormat::Heic)) = record.format {
            skip(&format!(
                "{} stills are left as they are",
                format.as_str().to_uppercase()
            ));
        }
        return None;
    };
    let plan = plan_archive_image(&ArchiveImageSource {
        file_name: &record.name,
        format,
        frame_count: record.frames.unwrap_or(1).clamp(0, i64::from(u32::MAX)) as u32,
    })?;
    let candidate = |category, mime_type| OptimizeCandidate {
        category,
        record: record.clone(),
        target_name: plan.file_name.clone(),
        mime_type,
        tracks: None,
    };
    match plan.action {
        ArchiveMediaAction::ConvertAvif => Some(candidate(OptimizeCategory::StillToAvif, None)),
        ArchiveMediaAction::RenameAvif => Some(candidate(OptimizeCategory::RenameAvif, None)),
        ArchiveMediaAction::ConvertMp4 => {
            let mime_type = match format {
                ArchiveImageFormat::Gif => "image/gif",
                ArchiveImageFormat::Webp => "image/webp",
                ArchiveImageFormat::Png => "image/png",
                _ => return None,
            };
            Some(candidate(OptimizeCategory::AnimationToMp4, Some(mime_type)))
        }
        ArchiveMediaAction::RenameMp4 => None,
    }
}

fn video_candidate(record: &FileRecord, skip: &mut dyn FnMut(&str)) -> Option<OptimizeCandidate> {
    let source = video_source_of(record)?;
    match plan_archive_video(&source)? {
        ArchiveVideoPlan::RenameMp4 { file_name } => Some(OptimizeCandidate {
            category: OptimizeCategory::RenameMp4,
            record: record.clone(),
            target_name: file_name,
            mime_type: None,
            tracks: None,
        }),
        ArchiveVideoPlan::ConvertMp4 {
            file_name,
            video,
            audio,
        } => Some(OptimizeCandidate {
            category: if video == VideoTrackPlan::Copy && audio == AudioTrackPlan::Copy {
                OptimizeCategory::VideoRemux
            } else {
                OptimizeCategory::VideoConvert
            },
            record: record.clone(),
            target_name: file_name,
            mime_type: None,
            tracks: Some((video, audio)),
        }),
        ArchiveVideoPlan::Unsupported { reason } => {
            skip(&reason);
            None
        }
    }
}

fn skip_one(skipped: &mut IndexMap<String, i64>, reason: &str) {
    *skipped.entry(reason.to_owned()).or_default() += 1;
}

const CATEGORY_ORDER: [OptimizeCategory; 6] = [
    OptimizeCategory::StillToAvif,
    OptimizeCategory::AnimationToMp4,
    OptimizeCategory::VideoRemux,
    OptimizeCategory::VideoConvert,
    OptimizeCategory::RenameAvif,
    OptimizeCategory::RenameMp4,
];

pub fn summarize_candidates(scan: &CandidateScan) -> OptimizeSummary {
    OptimizeSummary {
        categories: CATEGORY_ORDER
            .iter()
            .map(|&category| {
                let mut count = CategoryCount {
                    category,
                    files: 0,
                    bytes: 0,
                };
                for candidate in scan.candidates.iter().filter(|c| c.category == category) {
                    count.files += 1;
                    count.bytes += candidate.record.size;
                }
                count
            })
            .collect(),
        skipped: skip_counts(&scan.skipped),
    }
}

pub fn skip_counts(skipped: &IndexMap<String, i64>) -> Vec<SkipCount> {
    skipped
        .iter()
        .map(|(reason, &files)| SkipCount {
            reason: reason.clone(),
            files,
        })
        .collect()
}

/// The extensions Clean up would fix: AVIF and MP4 under other names from Convert's candidates,
/// then every other file whose extension does not name its bytes, by id.
pub fn extension_fixes(
    connection: &Connection,
    root_id: RootId,
    candidates: &[OptimizeCandidate],
) -> anyhow::Result<Vec<(FileRecord, String)>> {
    let mut fixes: IndexMap<FileId, (FileRecord, String)> = IndexMap::new();
    for candidate in candidates {
        if matches!(
            candidate.category,
            OptimizeCategory::RenameAvif | OptimizeCategory::RenameMp4
        ) {
            fixes.insert(
                candidate.record.id,
                (candidate.record.clone(), candidate.target_name.clone()),
            );
        }
    }
    let mismatched = query_records(
        connection,
        &format!(
            "SELECT {FILE_COLUMNS} FROM {FILES_FROM}
      WHERE f.root_id = $root AND f.ext_mismatch = 1 AND f.is_junk = 0 ORDER BY f.id"
        ),
        &SqlParams::new().with("root", root_id),
    )?;
    for record in mismatched {
        if let Some(extension) = record.format.and_then(preferred_extension)
            && !fixes.contains_key(&record.id)
        {
            let name = replace_file_extension(&record.name, extension);
            fixes.insert(record.id, (record, name));
        }
    }
    Ok(fixes.into_values().collect())
}
