//! The small rules a push applies, from lockstep-core's `push-helpers.ts` and
//! sync-protocol's `objects.ts`; `conformance/lockstep-core/rules.json` pins them.

use std::path::{Component, Path, PathBuf};

/// How many uploads run at once by default (plan 036).
pub(crate) const DEFAULT_UPLOAD_CONCURRENCY: usize = 3;

const MIN_UPLOAD_CONCURRENCY: usize = 1;
const MAX_UPLOAD_CONCURRENCY: usize = 8;

/// `resolveUploadConcurrency`.
pub(crate) fn resolve_upload_concurrency(value: Option<usize>) -> anyhow::Result<usize> {
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

/// `contentTypeForExtension`: the type an upload declares, which Pane View signs into its URL.
pub(crate) fn content_type_for_extension(extension: &str) -> &'static str {
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
pub(crate) fn resolve_local_file_path(
    source_root: &Path,
    archive_path: &str,
) -> anyhow::Result<PathBuf> {
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
