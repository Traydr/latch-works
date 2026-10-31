//! The small rules a push applies, from `push-helpers.ts`, `push-changes.ts` and
//! `remote-api.ts`; `conformance/lockstep-core/rules.json` pins them.

use std::path::{Component, Path, PathBuf};

use crate::plan::HashMode;

/// How many uploads run at once by default (plan 036).
pub const DEFAULT_UPLOAD_CONCURRENCY: usize = 3;

const MIN_UPLOAD_CONCURRENCY: usize = 1;
const MAX_UPLOAD_CONCURRENCY: usize = 8;

/// `resolveUploadConcurrency`: 3 when unset, else a whole number from 1 to 8.
pub fn resolve_upload_concurrency(value: Option<usize>) -> anyhow::Result<usize> {
    match value {
        None => Ok(DEFAULT_UPLOAD_CONCURRENCY),
        Some(value) if (MIN_UPLOAD_CONCURRENCY..=MAX_UPLOAD_CONCURRENCY).contains(&value) => {
            Ok(value)
        }
        Some(_) => anyhow::bail!(
            "uploadConcurrency must be an integer between {MIN_UPLOAD_CONCURRENCY} and \
             {MAX_UPLOAD_CONCURRENCY}"
        ),
    }
}

/// `resolveHashMode`: the mode asked for; else `hashFiles` as all or none; else the default, or
/// none.
pub fn resolve_hash_mode(
    hash_files: Option<bool>,
    hash_mode: Option<HashMode>,
    default_mode: Option<HashMode>,
) -> HashMode {
    if let Some(mode) = hash_mode {
        return mode;
    }
    match hash_files {
        Some(true) => HashMode::All,
        Some(false) => HashMode::None,
        None => default_mode.unwrap_or(HashMode::None),
    }
}

/// `contentTypeForExtension`: the type an upload declares, which Pane View signs into its URL.
pub fn content_type_for_extension(extension: &str) -> &'static str {
    match extension {
        "jpg" | "jpeg" => "image/jpeg",
        "png" => "image/png",
        "webp" => "image/webp",
        "gif" => "image/gif",
        "avif" => "image/avif",
        "mp4" | "m4v" => "video/mp4",
        "webm" => "video/webm",
        "mov" => "video/quicktime",
        "pdf" => "application/pdf",
        _ => "application/octet-stream",
    }
}

/// `resolveLocalFilePath`: an archive path under the source folder, refused when it leaves it.
pub fn resolve_local_file_path(source_root: &Path, archive_path: &str) -> anyhow::Result<PathBuf> {
    let root = resolve(source_root);
    let mut file = root.clone();
    for segment in archive_path.split('/') {
        match segment {
            "" | "." => {}
            ".." => {
                file.pop();
            }
            segment => file.push(segment),
        }
    }
    anyhow::ensure!(
        file.starts_with(&root),
        "Local path escapes source root: {archive_path}"
    );
    Ok(file)
}

/// `path.resolve`: absolute, with `.` and `..` folded lexically and no trailing separator.
pub(crate) fn resolve(path: &Path) -> PathBuf {
    let absolute = std::path::absolute(path).unwrap_or_else(|_| path.to_path_buf());
    let mut normalized = PathBuf::new();
    for component in absolute.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                normalized.pop();
            }
            other => normalized.push(other),
        }
    }
    normalized
}
