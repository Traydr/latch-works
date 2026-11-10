//! lockstep-core's conformance vectors, `conformance/lockstep-core/*.json`, which
//! `packages/lockstep-core/src/conformance.test.ts` writes from the TypeScript: the Rust must
//! scan, plan, cache, prune, check and post as the TypeScript does. A failure is a difference
//! between the two implementations; after a deliberate change on the TypeScript side, rewrite the
//! vectors with `ORIEL_UPDATE_VECTORS=1 pnpm --filter @latch-works/lockstep-core test` and port it.

mod doctor;
mod hash_cache;
mod plan;
mod prune;
mod rules;
mod scan;
mod wire;

use std::fs;
use std::path::Path;

use oriel_core_domain::{
    MediaItem, detect_media_type, get_base_name, get_extension, get_parent_path,
};
use serde::de::DeserializeOwned;

fn read_vectors<T: DeserializeOwned>(file_name: &str) -> T {
    let file = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../conformance/lockstep-core")
        .join(file_name);
    let json = fs::read_to_string(&file)
        .unwrap_or_else(|error| panic!("Could not read {}: {error}", file.display()));
    serde_json::from_str(&json)
        .unwrap_or_else(|error| panic!("{} does not parse: {error}", file.display()))
}

/// `mediaItem` in the TypeScript suite: a scanned file, and its hash when one is known.
fn media_item(path: &str, size: u64, sha256: Option<&str>) -> MediaItem {
    let name = get_base_name(path);
    MediaItem {
        id: sha256.unwrap_or(path).to_owned(),
        path: path.to_owned(),
        parent_path: get_parent_path(path),
        extension: get_extension(&name),
        media_type: detect_media_type(&name),
        name,
        size,
        mtime_ms: 1_700_000_000_000.0,
        sha256: sha256.map(str::to_owned),
        width: None,
        height: None,
        duration_ms: None,
        page_count: None,
        thumbnail_url: None,
        original_url: None,
    }
}

/// A symlink, as the scan and prune meet one. On Windows it needs developer mode or an elevated
/// prompt.
#[cfg(unix)]
fn symlink(target: &Path, link: &Path) {
    std::os::unix::fs::symlink(target, link).unwrap();
}

#[cfg(windows)]
fn symlink(target: &Path, link: &Path) {
    let resolved = link.parent().unwrap().join(target);
    if resolved.is_dir() {
        std::os::windows::fs::symlink_dir(target, link).unwrap();
    } else {
        std::os::windows::fs::symlink_file(target, link).unwrap();
    }
}
