//! What a push learns about a video's content beyond its type, from lockstep-core's
//! `media-facts.ts`: whether it has audio, which Pane View's gallery filters on.
//!
//! Videos are probed with the pinned ffprobe (`oriel-tools`), never one on `PATH`, where
//! lockstep-core runs `ffprobe` from `PATH`. Without it a push still uploads, and Pane View leaves
//! those videos' audio unknown until a later push can probe them.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

use futures::StreamExt as _;
use oriel_core_domain::MediaType;
use oriel_runtime::{CancelToken, Cancelled};
use oriel_tools::{MediaTools, ToolError, probe_video};

use crate::api::{MAX_MEDIA_FACTS_PER_REQUEST, PaneViewClient, types};
use crate::events::{Observer, status};
use crate::format::format_push_error;
use crate::plan::is_cancelled;
use crate::rules::resolve_local_file_path;
use crate::sync_plan::{SyncPlanAction, SyncPlanItem};

/// How many videos are probed at once while reporting facts.
const PROBE_CONCURRENCY: usize = 4;

/// A kept video whose audio Pane View does not know: what a push probes and reports.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct MissingAudioFact {
    pub(crate) path: String,
    pub(crate) sha256: String,
    pub(crate) size: u64,
}

/// `videosMissingAudioFacts`: the kept videos whose remote entry carries no `hasAudio`. Only those
/// whose local hash is known to match the remote one qualify, since a fact describes the bytes
/// Pane View holds.
pub(crate) fn videos_missing_audio_facts(items: &[SyncPlanItem]) -> Vec<MissingAudioFact> {
    items
        .iter()
        .filter(|item| item.action == SyncPlanAction::Keep)
        .filter_map(|item| {
            let local = item.local.as_ref()?;
            let remote = item.remote.as_ref()?;
            let sha256 = remote.sha256.as_ref()?;
            (local.media_type == MediaType::Video
                && remote.has_audio.is_none()
                && local.sha256.as_ref() == Some(sha256))
            .then(|| MissingAudioFact {
                path: local.path.clone(),
                sha256: sha256.clone(),
                size: remote.size,
            })
        })
        .collect()
}

/// `mediaFactsRequests`: the facts as the request bodies that carry them, in order, at most the
/// route's limit each.
pub(crate) fn media_facts_requests(
    facts: &[types::MediaFact],
) -> Vec<types::ReportMediaFactsRequest> {
    facts
        .chunks(MAX_MEDIA_FACTS_PER_REQUEST)
        .map(|facts| types::ReportMediaFactsRequest {
            facts: facts.to_vec(),
        })
        .collect()
}

/// What one probe found.
enum Probed {
    Audio(bool),
    /// ffprobe cannot run here; the probe said so once.
    Unavailable,
    /// This file could not be probed.
    Failed(String),
}

/// The pinned ffprobe, asked whether videos have audio. When it cannot be found or started it
/// warns once and answers "unavailable" from then on without trying again, so neither the uploads
/// nor the facts phase spawn a tool that cannot start.
#[derive(Default)]
pub(crate) struct AudioProbe {
    unavailable: AtomicBool,
}

impl AudioProbe {
    /// Whether the file at `file_path` has at least one audio stream. Fails only when cancelled.
    async fn probe(
        &self,
        file_path: PathBuf,
        observer: Option<&Observer>,
        cancel: &CancelToken,
    ) -> anyhow::Result<Probed> {
        if self.unavailable.load(Ordering::Relaxed) {
            return Ok(Probed::Unavailable);
        }
        cancel.check()?;
        let token = cancel.clone();
        let probed = tokio::task::spawn_blocking(move || {
            let tools = MediaTools::shared().map_err(|error| Err(error.to_string()))?;
            probe_video(tools.ffprobe(), &file_path, Some(&token)).map_err(Ok)
        })
        .await?;
        let unavailable = |reason: String| {
            if !self.unavailable.swap(true, Ordering::Relaxed) {
                status(
                    observer,
                    format!(
                        "Warning: ffprobe was not found ({reason}); videos' audio is not \
                         reported to Pane View."
                    ),
                );
            }
            Probed::Unavailable
        };
        Ok(match probed {
            Ok(probe) => Probed::Audio(probe.audio_streams > 0),
            Err(Err(not_located)) => unavailable(not_located),
            Err(Ok(ToolError::Cancelled)) => return Err(Cancelled.into()),
            Err(Ok(error @ ToolError::Start { .. })) => {
                unavailable(format!("{:#}", anyhow::Error::new(error)))
            }
            Err(Ok(error)) => Probed::Failed(format!("{:#}", anyhow::Error::new(error))),
        })
    }

    /// A video's audio for its registration: `None` for other media, and for a video that could
    /// not be probed, with a warning.
    pub(crate) async fn upload_audio(
        &self,
        source_root: &Path,
        archive_path: &str,
        media_type: MediaType,
        observer: Option<&Observer>,
        cancel: &CancelToken,
    ) -> anyhow::Result<Option<bool>> {
        if media_type != MediaType::Video {
            return Ok(None);
        }
        let file_path = resolve_local_file_path(source_root, archive_path)?;
        Ok(match self.probe(file_path, observer, cancel).await? {
            Probed::Audio(has_audio) => Some(has_audio),
            Probed::Unavailable => None,
            Probed::Failed(error) => {
                warn_unprobed(observer, archive_path, &error);
                None
            }
        })
    }

    /// `probeAudioFacts`: probes every video in `missing`, four at once, and returns the facts it
    /// learned, in `missing`'s order. A video that fails to probe is left out with a warning.
    async fn audio_facts(
        &self,
        source_root: &Path,
        missing: &[MissingAudioFact],
        observer: Option<&Observer>,
        cancel: &CancelToken,
    ) -> anyhow::Result<Vec<types::MediaFact>> {
        // The probes are made up front, so the stream holds futures rather than a closure that
        // borrows, which a run's future could not be sent across threads with.
        let probes: Vec<_> = missing
            .iter()
            .map(|video| self.audio_fact(source_root, video, observer, cancel))
            .collect();
        let mut facts = Vec::new();
        let mut probing = futures::stream::iter(probes).buffered(PROBE_CONCURRENCY);
        while let Some(fact) = probing.next().await {
            facts.extend(fact?);
        }
        Ok(facts)
    }

    /// One video's fact, or `None` with a warning when it cannot be probed.
    async fn audio_fact(
        &self,
        source_root: &Path,
        video: &MissingAudioFact,
        observer: Option<&Observer>,
        cancel: &CancelToken,
    ) -> anyhow::Result<Option<types::MediaFact>> {
        let probed = match resolve_local_file_path(source_root, &video.path) {
            Ok(file_path) => self.probe(file_path, observer, cancel).await?,
            Err(error) => Probed::Failed(format_push_error(&error)),
        };
        Ok(match probed {
            Probed::Audio(has_audio) => Some(types::MediaFact {
                has_audio,
                sha256: video.sha256.clone(),
                size: video.size as f64,
            }),
            Probed::Unavailable => None,
            Probed::Failed(error) => {
                warn_unprobed(observer, &video.path, &error);
                None
            }
        })
    }
}

fn warn_unprobed(observer: Option<&Observer>, archive_path: &str, error: &str) {
    status(
        observer,
        format!("Warning: could not probe {archive_path} for audio: {error}"),
    );
}

/// `reportMissingAudioFacts`: probes the kept videos Pane View has no audio fact for and reports
/// what it learns; returns how many facts Pane View accepted. A failed report is a warning, not a
/// failed push: the uploads are already done, and the next push tries again. A cancel stops the
/// probing and reports nothing more.
pub(crate) async fn report_missing_audio_facts(
    items: &[SyncPlanItem],
    source_root: &Path,
    probe: &AudioProbe,
    client: &PaneViewClient,
    observer: Option<&Observer>,
    cancel: &CancelToken,
) -> usize {
    let missing = videos_missing_audio_facts(items);
    if missing.is_empty() || cancel.is_cancelled() {
        return 0;
    }
    status(
        observer,
        format!("Checking {} synced video(s) for audio.", missing.len()),
    );
    let Ok(facts) = probe
        .audio_facts(source_root, &missing, observer, cancel)
        .await
    else {
        return 0;
    };
    let mut reported = 0;
    for body in media_facts_requests(&facts) {
        match client.report_media_facts(&body, Some(cancel)).await {
            Ok(updated) => reported += updated,
            Err(error) => {
                if !is_cancelled(&error) {
                    status(
                        observer,
                        format!(
                            "Warning: videos' audio could not be reported: {}",
                            format_push_error(&error)
                        ),
                    );
                }
                break;
            }
        }
    }
    reported
}
