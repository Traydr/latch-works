//! Which libvips Tidy reads pictures through. Fingerprints match Electron Oriel's only through
//! sharp's libvips line, 8.18, any patch release (the owner's decision of 2026-10-29): 8.17
//! already prints CMYK differently. Tidy runs without libvips rather than through another one.

use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use oriel_vips::{Vips, VipsError};

pub fn accepts_libvips_version(version: &str) -> bool {
    version.starts_with("8.18.")
}

fn refused(version: &str, path: &Path) -> VipsError {
    VipsError(format!(
        "libvips {version} ({}) is not 8.18.x, so its fingerprints would not match Electron \
         Oriel's",
        path.display()
    ))
}

/// The process's libvips, to load on first use, unless its file's name already gives a release
/// outside the 8.18 line; [`libvips_loads`] checks the one it loads.
pub fn shared_libvips() -> Result<Arc<Vips>, VipsError> {
    let vips = Vips::shared()?;
    let named = vips
        .path()
        .file_name()
        .and_then(|name| name.to_str())
        .and_then(|name| name.strip_prefix("libvips-cpp.")?.strip_suffix(".dylib"))
        .filter(|version| version.split('.').all(|part| part.parse::<u32>().is_ok()));
    match named {
        Some(version) if !accepts_libvips_version(version) => Err(refused(version, vips.path())),
        _ => Ok(vips),
    }
}

/// Whether `vips` loads and is a release Tidy reads through, loading it now if it has not yet.
pub fn libvips_loads(vips: &Vips) -> bool {
    static WARNED: AtomicBool = AtomicBool::new(false);
    if !vips.loads() {
        return false;
    }
    let version = vips.version();
    let accepted = accepts_libvips_version(&version);
    if !accepted && !WARNED.swap(true, Ordering::Relaxed) {
        log::warn!(
            "Tidy runs without libvips: {}",
            refused(&version, vips.path())
        );
    }
    accepted
}

/// Finds libvips and loads it now, for tests and measurements, refusing a release outside the
/// 8.18 line.
pub fn open_libvips() -> Result<Vips, VipsError> {
    let (path, _) = oriel_vips::locate()?;
    let vips = Vips::open(&path)?;
    let version = vips.version();
    if !accepts_libvips_version(&version) {
        return Err(refused(&version, &path));
    }
    Ok(vips)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn any_8_18_release_is_accepted() {
        assert!(accepts_libvips_version("8.18.7"));
        assert!(accepts_libvips_version("8.18.0"));
        assert!(!accepts_libvips_version("8.17.3"));
        assert!(!accepts_libvips_version("8.19.0"));
        assert!(!accepts_libvips_version("8.180.1"));
    }
}
