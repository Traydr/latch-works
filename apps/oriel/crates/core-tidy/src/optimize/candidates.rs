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

use crate::catalog::files::{SqlParams, get_file_records, query_records};
use crate::catalog::rows::{FILE_COLUMNS, FILES_FROM, FileRecord, format_column, kind_column};
use crate::contract::{
    CategoryCount, FileFormat, FileId, OptimizeCategory, OptimizeSummary, RootId, SkipCount,
};
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

const SKIP_NOT_SMALLER: &str = "Already as small as they get";

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
    video_source(
        &record.name,
        record.format,
        record.video_codec.as_deref(),
        record.audio_streams,
        record.audio_codec.as_deref(),
    )
}

fn video_source<'a>(
    file_name: &'a str,
    format: Option<FileFormat>,
    video_codec: Option<&str>,
    audio_streams: Option<i64>,
    audio_codec: Option<&str>,
) -> Option<ArchiveVideoSource<'a>> {
    Some(ArchiveVideoSource {
        file_name,
        container: video_container(format)?,
        video_codec: video_codec.map(ffprobe_video_codec),
        audio_codec: if audio_streams.unwrap_or(0) == 0 {
            None
        } else {
            audio_codec.map(ffprobe_audio_codec)
        },
    })
}

/// The lowercased paths of every file under a root, which a conversion's target must not take.
pub fn taken_paths(connection: &Connection, root_id: RootId) -> anyhow::Result<HashSet<String>> {
    let mut statement =
        connection.prepare_cached("SELECT rel_path FROM files WHERE root_id = ?1")?;
    let rows = statement.query_map([root_id], |row| row.get::<_, String>(0))?;
    rows.map(|row| Ok(row?.to_lowercase())).collect()
}

/// Every file under a root the archive policy would convert or rename. A conversion whose target
/// name is already taken, by a file or an earlier candidate, is skipped, never overwritten, and a
/// file an earlier conversion could not shrink is left as it is. Members of duplicate sets are
/// converted like any other: identical copies share one encode and stay identical (`executor`).
///
/// The policy reads the row where it lies: an archive already in its formats has few candidates,
/// so only those are read as whole records, and the paths taken only once one needs them.
pub fn find_optimize_candidates(
    connection: &Connection,
    root_id: RootId,
) -> anyhow::Result<CandidateScan> {
    let params = SqlParams::new().with("root", root_id);
    let mut statement = connection.prepare_cached(&format!(
        "SELECT f.id, f.kind, f.format, f.name, f.frames, f.probe_error IS NOT NULL, f.video_codec,
        f.audio_streams, f.audio_codec, f.optimize_not_smaller, f.dir, f.rel_path
      FROM {FILES_FROM}
      WHERE f.root_id = $root AND f.is_junk = 0 AND f.size > 0 AND f.kind IN ('image', 'video')
        AND f.probe_version > 0"
    ))?;
    let mut rows = statement.query(&*params.named())?;
    let mut taken: Option<HashSet<String>> = None;
    let mut scan = CandidateScan::default();
    let mut planned: Vec<(FileId, Planned)> = Vec::new();

    while let Some(row) = rows.next()? {
        if row.get::<_, i64>(5)? == 1 {
            skip_one(&mut scan.skipped, "Won't decode");
            continue;
        }
        let format = format_column(row, 2)?;
        let name = row.get_ref(3)?.as_str()?;
        let mut skip = |reason: &str| skip_one(&mut scan.skipped, reason);
        let plan = if kind_column(row, 1)? == crate::contract::FileKind::Image {
            image_plan(format, name, row.get(4)?, &mut skip)
        } else {
            video_source(
                name,
                format,
                row.get_ref(6)?.as_str_or_null()?,
                row.get(7)?,
                row.get_ref(8)?.as_str_or_null()?,
            )
            .and_then(|source| video_plan(&source, &mut skip))
        };
        let Some(plan) = plan else {
            continue;
        };
        if row.get::<_, i64>(9)? == 1 {
            skip_one(&mut scan.skipped, SKIP_NOT_SMALLER);
            continue;
        }
        let dir = row.get_ref(10)?.as_str()?;
        let target = if dir.is_empty() {
            plan.target_name.to_lowercase()
        } else {
            format!("{dir}/{}", plan.target_name).to_lowercase()
        };
        let taken = match &mut taken {
            Some(taken) => taken,
            None => taken.insert(taken_paths(connection, root_id)?),
        };
        if target != row.get_ref(11)?.as_str()?.to_lowercase() && taken.contains(&target) {
            skip_one(
                &mut scan.skipped,
                "A file with the target name already exists",
            );
            continue;
        }
        taken.insert(target);
        planned.push((row.get(0)?, plan));
    }

    let ids: Vec<FileId> = planned.iter().map(|(id, _)| *id).collect();
    let mut records: HashMap<FileId, FileRecord> = get_file_records(connection, &ids)?
        .into_iter()
        .map(|record| (record.id, record))
        .collect();
    scan.candidates = planned
        .into_iter()
        .filter_map(|(id, plan)| {
            Some(OptimizeCandidate {
                category: plan.category,
                record: records.remove(&id)?,
                target_name: plan.target_name,
                mime_type: plan.mime_type,
                tracks: plan.tracks,
            })
        })
        .collect();
    Ok(scan)
}

/// What the archive policy would do with a file.
struct Planned {
    category: OptimizeCategory,
    target_name: String,
    mime_type: Option<&'static str>,
    tracks: Option<(VideoTrackPlan, AudioTrackPlan)>,
}

fn image_plan(
    format: Option<FileFormat>,
    file_name: &str,
    frames: Option<i64>,
    skip: &mut dyn FnMut(&str),
) -> Option<Planned> {
    let Some(archive_format) = image_format(format) else {
        if let Some(format @ (FileFormat::Tiff | FileFormat::Heic)) = format {
            skip(&format!(
                "{} stills are left as they are",
                format.as_str().to_uppercase()
            ));
        }
        return None;
    };
    let plan = plan_archive_image(&ArchiveImageSource {
        file_name,
        format: archive_format,
        frame_count: frames.unwrap_or(1).clamp(0, i64::from(u32::MAX)) as u32,
    })?;
    let planned = |category, mime_type| Planned {
        category,
        target_name: plan.file_name.clone(),
        mime_type,
        tracks: None,
    };
    match plan.action {
        ArchiveMediaAction::ConvertAvif => Some(planned(OptimizeCategory::StillToAvif, None)),
        ArchiveMediaAction::RenameAvif => Some(planned(OptimizeCategory::RenameAvif, None)),
        ArchiveMediaAction::ConvertMp4 => {
            let mime_type = match archive_format {
                ArchiveImageFormat::Gif => "image/gif",
                ArchiveImageFormat::Webp => "image/webp",
                ArchiveImageFormat::Png => "image/png",
                _ => return None,
            };
            Some(planned(OptimizeCategory::AnimationToMp4, Some(mime_type)))
        }
        ArchiveMediaAction::RenameMp4 => None,
    }
}

fn video_plan(source: &ArchiveVideoSource<'_>, skip: &mut dyn FnMut(&str)) -> Option<Planned> {
    match plan_archive_video(source)? {
        ArchiveVideoPlan::RenameMp4 { file_name } => Some(Planned {
            category: OptimizeCategory::RenameMp4,
            target_name: file_name,
            mime_type: None,
            tracks: None,
        }),
        ArchiveVideoPlan::ConvertMp4 {
            file_name,
            video,
            audio,
        } => Some(Planned {
            category: if video == VideoTrackPlan::Copy && audio == AudioTrackPlan::Copy {
                OptimizeCategory::VideoRemux
            } else {
                OptimizeCategory::VideoConvert
            },
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

/// What Convert would change, by category. `removable` names the files the open duplicate sets'
/// suggestions would remove.
pub fn summarize_candidates(scan: &CandidateScan, removable: &HashSet<FileId>) -> OptimizeSummary {
    let mut counted = HashSet::new();
    OptimizeSummary {
        categories: CATEGORY_ORDER
            .iter()
            .map(|&category| {
                let mut count = CategoryCount {
                    category,
                    files: 0,
                    bytes: 0,
                    duplicate_bytes: 0,
                };
                for candidate in scan.candidates.iter().filter(|c| c.category == category) {
                    count.files += 1;
                    if counted.insert(candidate.record.inode()) {
                        count.bytes += candidate.record.size;
                        if removable.contains(&candidate.record.id) {
                            count.duplicate_bytes += candidate.record.size;
                        }
                    }
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
