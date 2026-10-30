//! The engine's values, as glazier-core's `contract.ts` names them: what a file is, what a query
//! asks for, and what Overview, the Library and Duplicates are shown. The serde forms are the
//! TypeScript's JSON, so the conformance vectors and the differential run compare them directly.

use serde::{Deserialize, Serialize};

/// A root's row id in the catalog.
pub type RootId = i64;

/// A file's row id in the catalog.
pub type FileId = i64;

/// Declares a string enum with the TypeScript's names, its SQL text and every value in order.
macro_rules! string_enum {
    ($(#[$meta:meta])* $name:ident { $($variant:ident = $text:literal),+ $(,)? }) => {
        $(#[$meta])*
        #[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
        pub enum $name {
            $(#[serde(rename = $text)] $variant),+
        }

        impl $name {
            /// Every value, in the TypeScript enum's order.
            pub const ALL: &'static [$name] = &[$($name::$variant),+];

            /// The name the TypeScript and the catalog use.
            pub fn as_str(self) -> &'static str {
                match self {
                    $($name::$variant => $text),+
                }
            }

            /// The value the catalog or the TypeScript names `text`, if any.
            pub fn parse(text: &str) -> Option<$name> {
                match text {
                    $($text => Some($name::$variant),)+
                    _ => None,
                }
            }
        }

        impl std::fmt::Display for $name {
            fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str(self.as_str())
            }
        }
    };
}

string_enum! {
    /// What a file is, from its bytes first and its extension second.
    FileKind {
        Image = "image",
        Video = "video",
        Audio = "audio",
        Pdf = "pdf",
        Other = "other",
        Junk = "junk",
    }
}

string_enum! {
    /// The format a file's first bytes identify, which can differ from what its extension claims.
    FileFormat {
        Png = "png",
        Jpeg = "jpeg",
        Gif = "gif",
        Webp = "webp",
        Bmp = "bmp",
        Tiff = "tiff",
        Avif = "avif",
        Heic = "heic",
        Psd = "psd",
        Svg = "svg",
        Mp4 = "mp4",
        Mov = "mov",
        Matroska = "matroska",
        Webm = "webm",
        Mpegts = "mpegts",
        Avi = "avi",
        Flv = "flv",
        Asf = "asf",
        Mp3 = "mp3",
        M4a = "m4a",
        Wav = "wav",
        Flac = "flac",
        Ogg = "ogg",
        Pdf = "pdf",
        Zip = "zip",
        Rar = "rar",
        SevenZ = "7z",
        Empty = "empty",
        Unknown = "unknown",
    }
}

string_enum! {
    /// Whether a video can be heard: no audio track, a silent track, a track with sound, or a
    /// track the loudness pass has not measured yet.
    AudioState {
        None = "none",
        Silent = "silent",
        Sound = "sound",
        Unmeasured = "unmeasured",
    }
}

string_enum! {
    /// A Library filter flag; a file matches when it has any of the flags asked for.
    FileFlag {
        ExtensionMismatch = "extension-mismatch",
        Undecodable = "undecodable",
        ZeroByte = "zero-byte",
        Junk = "junk",
        Animated = "animated",
        Duplicate = "duplicate",
        Unsupported = "unsupported",
        Convertible = "convertible",
    }
}

string_enum! {
    /// The Library's sort columns.
    FileSortColumn {
        Name = "name",
        Path = "path",
        Size = "size",
        Mtime = "mtime",
        Kind = "kind",
        Duration = "duration",
    }
}

string_enum! {
    /// Things a scan finds that need a look but that Tidy has no single fix for.
    FindingKind {
        Undecodable = "undecodable",
        ZeroByte = "zero-byte",
        Unsupported = "unsupported",
        PresignedDelivery = "presigned-delivery",
        UnconvertibleVideo = "unconvertible-video",
    }
}

string_enum! {
    /// Why the suggestion keeps a set's copy: the first keeper rule that decided, or
    /// `different-pictures` when Spot variants keeps every version as a picture of its own.
    KeepReason {
        PreferredFolder = "preferred-folder",
        HasSound = "has-sound",
        MorePixels = "more-pixels",
        Longer = "longer",
        HomeFolder = "home-folder",
        ArchiveFormat = "archive-format",
        RightExtension = "right-extension",
        LargerFile = "larger-file",
        OriginalName = "original-name",
        Oldest = "oldest",
        ShorterPath = "shorter-path",
        NameOrder = "name-order",
        DifferentPictures = "different-pictures",
    }
}

string_enum! {
    /// Which open duplicate sets to list. `variants` are similar sets Spot variants found to hold
    /// only variants; they are not duplicates, so `all` and `similar` leave them out.
    DuplicateScope {
        All = "all",
        Exact = "exact",
        Similar = "similar",
        Variants = "variants",
    }
}

string_enum! {
    /// How close two prints must be to count as one picture.
    SimilarityLevel {
        Strict = "strict",
        Balanced = "balanced",
        Loose = "loose",
    }
}

string_enum! {
    /// What Convert would do to a file.
    OptimizeCategory {
        StillToAvif = "still-to-avif",
        AnimationToMp4 = "animation-to-mp4",
        VideoRemux = "video-remux",
        VideoConvert = "video-convert",
        RenameAvif = "rename-avif",
        RenameMp4 = "rename-mp4",
    }
}

string_enum! {
    /// The quality every re-encode uses.
    VideoQuality {
        Medium = "medium",
        High = "high",
        VeryHigh = "very-high",
    }
}

string_enum! {
    /// Whether a duplicate set's files hold the same bytes or differ.
    DuplicateKind {
        Exact = "exact",
        Similar = "similar",
    }
}

/// A folder Tidy looks after.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Root {
    pub id: RootId,
    pub path: String,
    pub name: String,
    pub added_at: i64,
    pub last_scan_at: Option<i64>,
    pub file_count: i64,
    pub total_bytes: i64,
}

/// A file as the Library and Duplicates show it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileRow {
    pub id: FileId,
    pub root_id: RootId,
    /// Path inside the root with forward slashes, as Sync and Pane View name it.
    pub rel_path: String,
    pub abs_path: String,
    pub name: String,
    pub dir: String,
    pub ext: String,
    pub size: i64,
    pub mtime_ms: f64,
    pub kind: FileKind,
    pub format: Option<FileFormat>,
    pub extension_mismatch: bool,
    pub width: Option<i64>,
    pub height: Option<i64>,
    pub frames: Option<i64>,
    pub duration_ms: Option<f64>,
    pub video_codec: Option<String>,
    pub audio_codec: Option<String>,
    pub audio_state: Option<AudioState>,
    pub bitrate: Option<f64>,
    pub probe_error: Option<String>,
    pub sha256: Option<String>,
}

/// Which files the Library shows: each list matches any of its values, and the lists, the
/// search and the folder all have to match together.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileFilter {
    pub root_id: Option<RootId>,
    pub search: String,
    pub kinds: Vec<FileKind>,
    pub formats: Vec<FileFormat>,
    pub audio_states: Vec<AudioState>,
    pub flags: Vec<FileFlag>,
    /// Only files under this folder (relative to the root), when set.
    pub dir: Option<String>,
}

impl FileFilter {
    /// Every file of a root, or of every root.
    pub fn root(root_id: Option<RootId>) -> Self {
        Self {
            root_id,
            ..Self::default()
        }
    }
}

/// A page of the Library: which files, in which order, from where.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileQuery {
    #[serde(flatten)]
    pub filter: FileFilter,
    pub sort: FileSortColumn,
    pub descending: bool,
    pub offset: u32,
    /// At most [`MAX_PAGE_ROWS`].
    pub limit: u32,
}

/// The most rows one Library page carries.
pub const MAX_PAGE_ROWS: u32 = 1000;

/// How many files a bulk action takes at once, such as Select All.
pub const MAX_BULK_FILES: usize = 50_000;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FilePage {
    pub total: i64,
    pub total_bytes: i64,
    pub rows: Vec<FileRow>,
}

/// File ids for a bulk action, and whether there were more than it can take.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileIdList {
    pub ids: Vec<FileId>,
    pub truncated: bool,
}

/// How many files, of how many bytes, a filter value matches.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct FacetCount<T> {
    pub value: T,
    pub files: i64,
    pub bytes: i64,
}

/// File counts per filter value. Each facet is counted under every filter except its own, so the
/// filter menu can show what choosing a value would match.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileFacets {
    pub kinds: Vec<FacetCount<FileKind>>,
    pub formats: Vec<FacetCount<Option<FileFormat>>>,
    pub audio_states: Vec<FacetCount<AudioState>>,
    pub flags: Vec<FacetCount<FileFlag>>,
}

/// Files and bytes.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Count {
    pub files: i64,
    pub bytes: i64,
}

/// What a selection holds, so the selection bar offers only the actions that apply to it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SelectionSummary {
    pub files: i64,
    pub bytes: i64,
    /// Files the Convert step would convert or rename.
    pub convertible: Count,
    pub videos: i64,
    /// Videos with an audio track, which Strip audio applies to.
    pub with_audio: i64,
    pub extension_mismatches: i64,
}

/// Something that needs a look, with how many files and bytes it covers.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Finding {
    pub kind: FindingKind,
    pub count: i64,
    pub bytes: i64,
}

/// Distinct contents of a duplicate set, each with its byte-identical copies, best first.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct DuplicateVersion {
    pub files: Vec<FileRow>,
}

/// One picture or video and every version of it in the catalog. Byte-identical copies are one
/// version, so a file belongs to one set only, whether its twins are exact or similar.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DuplicateSet {
    /// Stable while the set's files stay the same: `exact:<sha256>` or `similar:<lowest id>`.
    pub key: String,
    pub kind: DuplicateKind,
    /// Distinct contents, best first; each lists its byte-identical copies, best first.
    pub versions: Vec<DuplicateVersion>,
    /// With Spot variants on, the picture each version shows, by position: versions that are
    /// copies of one picture share a number. `None` when Spot variants is off, for videos and
    /// animations, and until every version has a detail print.
    pub pictures: Option<Vec<i64>>,
    /// What resolving keeps unless told otherwise.
    pub keep: Vec<FileId>,
    /// Why the kept copy beat the runner-up (see [`deciding_versions`]).
    pub keep_reason: KeepReason,
    /// Bytes the suggested resolution frees; files hard-linked to a kept file free nothing.
    pub reclaimable_bytes: i64,
    /// Members that share their bytes on disk with another member (hard links).
    pub hard_linked_ids: Vec<FileId>,
    /// For similar sets, the largest fingerprint distance (of 64 bits) that joined them.
    pub distance: Option<u32>,
    /// Set when the owner said these files are not duplicates; such sets are hidden by default.
    pub dismissal_id: Option<i64>,
}

/// The versions the keep reason compares, by position: the kept one and the runner-up it beat.
/// With pictures that is the first picture holding two versions; `None` when none does.
pub fn deciding_versions(
    versions: &[DuplicateVersion],
    pictures: Option<&[i64]>,
) -> Option<(usize, usize)> {
    let Some(pictures) = pictures else {
        return (versions.len() > 1).then_some((0, 1));
    };
    (1..pictures.len())
        .find(|&index| pictures[index] == pictures[index - 1])
        .map(|index| (index - 1, index))
}

/// Whether a similar set's suggestion is a close call: its versions match on pixels, length,
/// sound and format, and a tie-breaker chose (a file under a tenth larger, the oldest, the
/// shortest path, the first name). The owner should look at those.
pub fn is_close_call(set: &DuplicateSet) -> bool {
    let tie_breaker = matches!(
        set.keep_reason,
        KeepReason::LargerFile
            | KeepReason::Oldest
            | KeepReason::ShorterPath
            | KeepReason::NameOrder
    );
    if set.kind != DuplicateKind::Similar || !tie_breaker {
        return false;
    }
    if set.keep_reason != KeepReason::LargerFile {
        return true;
    }
    let pair = deciding_versions(&set.versions, set.pictures.as_deref());
    let size = |index: usize| {
        set.versions
            .get(index)
            .and_then(|version| version.files.first())
            .map_or(0, |file| file.size)
    };
    let (best, next) = pair.map_or((0, 0), |(kept, runner_up)| (size(kept), size(runner_up)));
    next > 0 && (best as f64) / (next as f64) < 1.1
}

/// How many sets, the files their suggestions hold and the bytes that frees.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DuplicateTotals {
    pub sets: i64,
    /// Files the suggested resolutions move to holding.
    pub extra_copies: i64,
    pub reclaimable_bytes: i64,
}

/// What Duplicates asks for.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DuplicateSetRequest {
    pub root_id: Option<RootId>,
    pub offset: usize,
    pub limit: usize,
    pub level: SimilarityLevel,
    pub scope: DuplicateScope,
    /// The sets the owner dismissed, instead of the open ones.
    pub dismissed: bool,
}

/// Counts of open sets by kind, and of dismissed sets.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct DuplicateCounts {
    pub exact: i64,
    pub similar: i64,
    pub variants: i64,
    pub dismissed: i64,
}

/// One page of duplicate sets, with counts that ignore the scope.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DuplicateSetPage {
    /// Sets matching the request's scope.
    pub total: i64,
    pub reclaimable_bytes: i64,
    pub counts: DuplicateCounts,
    /// Bytes resolving every open set would free, identical and similar alike.
    pub open_reclaimable_bytes: i64,
    /// Similar sets need fingerprints; how far the analysis has come.
    pub fingerprinted: i64,
    pub fingerprintable: i64,
    /// With Spot variants on, how many stills in open similar sets have a detail print to
    /// compare by; both zero when it is off.
    pub compared: i64,
    pub comparable: i64,
    pub sets: Vec<DuplicateSet>,
}

/// What Convert would change, by category, and why other files are left alone.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct OptimizeSummary {
    pub categories: Vec<CategoryCount>,
    pub skipped: Vec<SkipCount>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct CategoryCount {
    pub category: OptimizeCategory,
    pub files: i64,
    pub bytes: i64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SkipCount {
    pub reason: String,
    pub files: i64,
}

/// One video Shrink would re-encode to AV1, with the size it is expected to come out at.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShrinkItem {
    pub file_id: FileId,
    pub bytes: i64,
    pub estimated_bytes: i64,
    pub duration_ms: f64,
    /// Roughly how long the encode takes, from its length and picture size.
    pub encode_ms: f64,
}

/// The videos under a root Shrink should re-encode, the most bytes saved first, and why the others
/// are left as they are. `preview` holds the first rows, for tiles.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShrinkSummary {
    pub items: Vec<ShrinkItem>,
    pub preview: Vec<FileRow>,
    pub skipped: Vec<SkipCount>,
    /// Encode times follow this machine's own SVT-AV1 encodes, not the M5 Pro's figures.
    pub speed_measured: bool,
}

/// The leading items whose originals add up to `limit_bytes` without going over, and always at
/// least one; every item when `limit_bytes` is `None`. Shrink's button and its plan both count a
/// batch this way, so they agree.
pub fn shrink_batch(items: &[ShrinkItem], limit_bytes: Option<f64>) -> &[ShrinkItem] {
    let Some(limit) = limit_bytes else {
        return items;
    };
    let mut total = 0.0;
    let mut taken = 0;
    for item in items {
        if taken > 0 && total + item.bytes as f64 > limit {
            break;
        }
        taken += 1;
        total += item.bytes as f64;
    }
    &items[..taken]
}

/// Videos Shrink would re-encode: how many, their bytes, and the bytes expected after.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShrinkTotals {
    pub files: i64,
    pub bytes: i64,
    pub estimated_bytes: i64,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct DuplicateTotalsByKind {
    pub exact: DuplicateTotals,
    pub similar: DuplicateTotals,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupCounts {
    pub junk: i64,
    pub empty_folders: i64,
    /// Extensions that do not match the bytes, plus AVIF and MP4 under other extensions.
    pub extensions: i64,
}

/// How far the background analysis has come.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalysisProgress {
    pub fingerprinted: i64,
    pub fingerprintable: i64,
    pub sound_measured: i64,
    pub sound_measurable: i64,
}

/// Overview's to-do list for a root, in the order the work should happen: duplicates, then
/// conversions, then silent soundtracks, then clean-up, then what needs a human look.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Tidy {
    pub files: i64,
    pub bytes: i64,
    pub last_scan_at: Option<i64>,
    pub duplicates: DuplicateTotalsByKind,
    pub convert: OptimizeSummary,
    pub shrink: ShrinkTotals,
    /// Videos whose audio track was measured as silent.
    pub silent_tracks: Count,
    pub cleanup: CleanupCounts,
    pub attention: Vec<Finding>,
    pub analysis: AnalysisProgress,
}

/// A folder whose copies duplicate review keeps first, relative to its root.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreferredFolder {
    pub root_id: RootId,
    pub dir: String,
}

/// Tidy's settings, stored in the catalog as glazier-core stores them.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub preferred_folders: Vec<PreferredFolder>,
    pub similarity: SimilarityLevel,
    /// Treat similar stills that differ in one area (a face, an outfit, a caption's language) as
    /// pictures of their own: keep each, and pick among the copies of each picture by sound,
    /// pixels and the folder holding most of the set.
    pub spot_variants: bool,
    /// The quality every re-encode uses.
    pub reencode_quality: VideoQuality,
    /// Find similar versions and measure soundtracks in the background after each scan.
    pub auto_analyze: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            preferred_folders: Vec::new(),
            similarity: SimilarityLevel::Balanced,
            spot_variants: false,
            reencode_quality: VideoQuality::High,
            auto_analyze: true,
        }
    }
}

/// The video encoders a re-encode can use (glazier-core's `EncoderCapabilities.video`).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoEncoders {
    pub avc: bool,
    pub hevc: bool,
    pub av1: bool,
}

/// What this machine can encode with, for Settings › Encoders and the Library's Re-encode menu
/// (glazier-core's `EncoderCapabilities`). Electron Oriel's video encoders are WebCodecs'; Oriel
/// RS has none, so its are the pinned ffmpeg's.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EncoderCapabilities {
    pub video: VideoEncoders,
    pub aac: bool,
    pub ffmpeg: bool,
    /// ffmpeg has SVT-AV1, which every AV1 encode uses.
    pub svt_av1: bool,
    pub ffprobe: bool,
    /// libavif loads, which Oriel RS encodes AVIF pictures with (Electron Oriel's are wasm).
    #[serde(default)]
    pub avif: bool,
}

// Changing the archive: plans, their steps, holding and the history (glazier-core's
// `PlanRequestSchema` and what follows it in `contract.ts`).

/// A plan's row id in the catalog.
pub type PlanId = i64;

/// A held file's row id in the catalog.
pub type HoldingId = i64;

string_enum! {
    /// The codec a re-encode writes.
    VideoCodecChoice {
        Avc = "avc",
        Hevc = "hevc",
        Av1 = "av1",
    }
}

/// One file to rename, and its new name.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Rename {
    pub file_id: FileId,
    pub name: String,
}

/// One duplicate decision: the files kept and the files moved to holding.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ResolveGroup {
    pub keep: Vec<FileId>,
    pub remove: Vec<FileId>,
}

/// What the owner asked to change, before the planner turns it into steps.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum PlanRequest {
    /// Move files to their root's holding folder.
    Hold {
        file_ids: Vec<FileId>,
    },
    /// Move files to an absolute folder; they keep their names.
    Move {
        file_ids: Vec<FileId>,
        target_dir: String,
    },
    Rename {
        renames: Vec<Rename>,
    },
    FixExtension {
        file_ids: Vec<FileId>,
    },
    /// Convert a root's candidates in these categories, or only these files of them.
    Optimize {
        root_id: RootId,
        categories: Vec<OptimizeCategory>,
        file_ids: Option<Vec<FileId>>,
    },
    Reencode {
        file_ids: Vec<FileId>,
        codec: VideoCodecChoice,
        quality: VideoQuality,
    },
    StripAudio {
        file_ids: Vec<FileId>,
    },
    /// Explicit decisions: each group keeps some files and moves others to holding. A group that
    /// keeps several files remembers them as not duplicates of each other until the plan is
    /// undone, so the set does not come back. A file hard-linked to a kept file is never removed.
    ResolveDuplicates {
        groups: Vec<ResolveGroup>,
    },
    CleanJunk {
        root_id: RootId,
    },
    RemoveEmptyFolders {
        root_id: RootId,
    },
    /// Junk to holding, empty folders removed, and every extension that does not match its
    /// bytes fixed (AVIF and MP4 under other extensions included), as one plan with one undo.
    Cleanup {
        root_id: RootId,
    },
    /// Re-encodes a root's videos to AV1, the most bytes saved first, until the originals add up
    /// to `limit_bytes` (every candidate when `None`). A result not at least 5% smaller is thrown
    /// away and the video is not offered again until its bytes change.
    ShrinkVideos {
        root_id: RootId,
        limit_bytes: Option<f64>,
    },
}

string_enum! {
    /// Every plan request's kind.
    PlanKind {
        Hold = "hold",
        Move = "move",
        Rename = "rename",
        FixExtension = "fix-extension",
        Optimize = "optimize",
        Reencode = "reencode",
        StripAudio = "strip-audio",
        ResolveDuplicates = "resolve-duplicates",
        CleanJunk = "clean-junk",
        RemoveEmptyFolders = "remove-empty-folders",
        Cleanup = "cleanup",
        ShrinkVideos = "shrink-videos",
    }
}

impl PlanRequest {
    pub fn kind(&self) -> PlanKind {
        match self {
            Self::Hold { .. } => PlanKind::Hold,
            Self::Move { .. } => PlanKind::Move,
            Self::Rename { .. } => PlanKind::Rename,
            Self::FixExtension { .. } => PlanKind::FixExtension,
            Self::Optimize { .. } => PlanKind::Optimize,
            Self::Reencode { .. } => PlanKind::Reencode,
            Self::StripAudio { .. } => PlanKind::StripAudio,
            Self::ResolveDuplicates { .. } => PlanKind::ResolveDuplicates,
            Self::CleanJunk { .. } => PlanKind::CleanJunk,
            Self::RemoveEmptyFolders { .. } => PlanKind::RemoveEmptyFolders,
            Self::Cleanup { .. } => PlanKind::Cleanup,
            Self::ShrinkVideos { .. } => PlanKind::ShrinkVideos,
        }
    }
}

string_enum! {
    /// What one step of a plan does to one file or folder.
    PlanStepAction {
        Hold = "hold",
        Move = "move",
        Rename = "rename",
        ConvertAvif = "convert-avif",
        ConvertAnimation = "convert-animation",
        ConvertVideo = "convert-video",
        RemoveFolder = "remove-folder",
    }
}

/// How many steps of a plan take one action.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ActionCount {
    pub action: PlanStepAction,
    pub steps: i64,
}

/// What a plan changes for Sync: media paths that go and media paths that come.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LockstepCounts {
    pub removed_paths: i64,
    pub added_paths: i64,
}

/// A saved draft plan, as the owner reviews it before applying.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanPreview {
    pub plan_id: PlanId,
    pub kind: PlanKind,
    pub steps: i64,
    pub by_action: Vec<ActionCount>,
    /// Bytes the plan moves into holding: removals and the originals conversions replace.
    pub bytes_to_holding: i64,
    pub bytes_touched: i64,
    pub lockstep: LockstepCounts,
    pub warnings: Vec<String>,
}

string_enum! {
    /// Where a plan is: drafted, running, finished in one of several ways, or undone.
    PlanStatus {
        Draft = "draft",
        Applying = "applying",
        Applied = "applied",
        Partial = "partial",
        Failed = "failed",
        Cancelled = "cancelled",
        Undone = "undone",
    }
}

/// Finished steps that put a file in holding.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct HeldCount {
    pub files: i64,
    pub bytes: i64,
}

/// One plan as History shows it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanSummary {
    pub id: PlanId,
    pub kind: PlanKind,
    pub created_at: i64,
    pub status: PlanStatus,
    /// What the plan did, in the past tense: "Converted 206 files", "Resolved 3 duplicate sets".
    pub title: String,
    /// What the plan is about, counted: duplicate sets for resolve plans, otherwise its steps.
    pub count: i64,
    pub steps: i64,
    pub done: i64,
    pub skipped: i64,
    pub failed: i64,
    pub undone: i64,
    pub bytes_before: i64,
    pub bytes_after: i64,
    /// Finished steps that put a file in holding: removals and replaced originals.
    pub held: HeldCount,
}

impl PlanSummary {
    /// Whether ⌘Z or History can take the plan back, as the renderer's `canUndo` decides.
    pub fn can_undo(&self) -> bool {
        self.done > 0
            && matches!(
                self.status,
                PlanStatus::Applied | PlanStatus::Partial | PlanStatus::Cancelled
            )
    }
}

string_enum! {
    /// Where one step is.
    StepStatus {
        Pending = "pending",
        Done = "done",
        Skipped = "skipped",
        Failed = "failed",
        Undone = "undone",
    }
}

/// One step of a plan, as History lists it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanStep {
    pub id: i64,
    pub action: PlanStepAction,
    pub from_path: String,
    pub to_path: Option<String>,
    pub status: StepStatus,
    pub message: Option<String>,
    pub bytes_before: i64,
    pub bytes_after: Option<i64>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct PlanStepPage {
    pub total: i64,
    pub steps: Vec<PlanStep>,
}

/// One file in holding: where it came from, where it is, and why.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HoldingItem {
    pub id: HoldingId,
    pub root_id: RootId,
    pub original_path: String,
    pub hold_path: String,
    pub size: i64,
    pub held_at: i64,
    pub plan_id: Option<PlanId>,
    pub reason: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HoldingList {
    pub total_bytes: i64,
    pub total: i64,
    pub items: Vec<HoldingItem>,
}

/// A page of a root's plans or holding: the root (or every root) and where the page starts.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanListRequest {
    pub root_id: Option<RootId>,
    pub offset: i64,
    /// At most [`MAX_HISTORY_ROWS`].
    pub limit: i64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanStepsRequest {
    pub plan_id: PlanId,
    pub offset: i64,
    pub limit: i64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HoldingRequest {
    pub root_id: RootId,
    pub offset: i64,
    pub limit: i64,
}

/// The most rows a page of plans, steps or holding carries, as glazier-core's paging allows.
pub const MAX_HISTORY_ROWS: i64 = 500;

/// What restoring held files did: how many came back, why the others did not, and the roots to
/// scan again for them.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreResult {
    pub restored: i64,
    pub failed: Vec<String>,
    /// The roots a restore put files back into, which want a scan (glazier-core queues one).
    pub rescan: Vec<RootId>,
}

/// What emptying a root's holding into the Trash did.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct EmptyHoldingResult {
    pub emptied: i64,
    /// Batch folders the Trash refused, with why; their files stay held.
    pub failed: Vec<String>,
}

/// What converting a category would save, from a sample converted into a temp folder.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OptimizeEstimate {
    pub category: OptimizeCategory,
    pub sampled: i64,
    /// Output size as a share of input size across the sample: the median, then the quartiles.
    pub ratio: f64,
    pub ratio_low: f64,
    pub ratio_high: f64,
}
