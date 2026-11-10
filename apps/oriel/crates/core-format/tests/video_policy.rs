//! Checks the video policy against `conformance/media-format/video-policy.json`, frozen from the
//! TypeScript that first held it.

use crate::support::{check, fail_with, json, read_vectors};
use oriel_core_format::{
    ArchiveVideoCodec, ArchiveVideoSource, AudioCodec, VideoCodec, VideoContainer,
    is_archive_video_codec, plan_archive_video, plan_strip_audio, plan_video_reencode,
};
use serde::Deserialize;
use serde_json::Value;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct VideoVectors {
    is_archive_video_codec: Vec<CodecCase>,
    archive_video: Vec<PlanCase>,
    reencode: Vec<ReencodeCase>,
    strip_audio: Vec<PlanCase>,
}

#[derive(Deserialize)]
struct CodecCase {
    codec: VideoCodec,
    archive: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PlanCase {
    file_name: String,
    container: VideoContainer,
    video_codec: Option<VideoCodec>,
    audio_codec: Option<AudioCodec>,
    /// The TypeScript's plan as JSON, so its form is checked too.
    plan: Value,
}

impl PlanCase {
    fn source(&self) -> ArchiveVideoSource<'_> {
        ArchiveVideoSource {
            file_name: &self.file_name,
            container: self.container,
            video_codec: self.video_codec,
            audio_codec: self.audio_codec,
        }
    }
}

#[derive(Deserialize)]
struct ReencodeCase {
    #[serde(flatten)]
    case: PlanCase,
    codec: ArchiveVideoCodec,
}

fn vectors() -> VideoVectors {
    read_vectors("video-policy.json")
}

#[test]
fn tells_archive_video_codecs_from_the_rest() {
    let mut problems = Vec::new();
    for case in &vectors().is_archive_video_codec {
        check(
            &mut problems,
            || format!("isArchiveVideoCodec({:?})", case.codec),
            &case.archive,
            &is_archive_video_codec(case.codec),
        );
    }
    fail_with(&problems, "codecs differ");
}

#[test]
fn plans_videos_as_the_typescript_does() {
    let mut problems = Vec::new();
    for case in &vectors().archive_video {
        let source = case.source();
        check(
            &mut problems,
            || format!("planArchiveVideo({source:?})"),
            &case.plan,
            &json(&plan_archive_video(&source)),
        );
    }
    fail_with(&problems, "video plans differ");
}

#[test]
fn plans_re_encodes_and_stripped_audio_as_the_typescript_does() {
    let vectors = vectors();
    let mut problems = Vec::new();
    for reencode in &vectors.reencode {
        let source = reencode.case.source();
        check(
            &mut problems,
            || format!("planVideoReencode({source:?}, {:?})", reencode.codec),
            &reencode.case.plan,
            &json(&plan_video_reencode(&source, reencode.codec)),
        );
    }
    for case in &vectors.strip_audio {
        let source = case.source();
        check(
            &mut problems,
            || format!("planStripAudio({source:?})"),
            &case.plan,
            &json(&plan_strip_audio(&source)),
        );
    }
    fail_with(&problems, "re-encode or strip plans differ");
}
