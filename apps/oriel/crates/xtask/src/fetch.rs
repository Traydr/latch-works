//! Fetches a platform's pinned ffmpeg and ffprobe ([`pins::MEDIA_TOOLS`]) into the development
//! cache, `apps/oriel/.media-tools/<platform>`, where the app finds them while developing and
//! `bundle` and `package` copy them from:
//!
//! ```text
//! cargo run -p xtask -- fetch-media-tools [<cache folder>]
//! ```
//!
//! Each zip must hash to its pin before it is unpacked, and the unpacked programs' own hashes are
//! recorded in the folder's marker and checked on every later fetch, so a changed program is
//! fetched again rather than used. It runs on demand, never from a build script, so a build never
//! touches the network.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use anyhow::{Context as _, Result, bail, ensure};
use oriel_core_paths::{MEDIA_TOOLS_VERSION, MediaToolsMarker, media_tools_files};

use crate::pins::{self, MediaToolsPin};
use crate::support::{self, Download, log, run_here, sha256_file};

/// `fetch-media-tools [<cache folder>]`: this platform's pin into the development cache, or the
/// folder named.
pub fn command(args: &[String]) -> Result<()> {
    let cache = match args {
        [] => oriel_core_paths::media_tools_cache(),
        [folder] => std::env::current_dir()?.join(folder),
        _ => bail!("fetch-media-tools takes at most one folder"),
    };
    let platform = oriel_core_paths::media_tools_platform();
    let pin = pins::media_tools_for(&platform)
        .with_context(|| format!("no ffmpeg is pinned for {platform}"))?;
    ensure_in(&cache, pin)?;
    Ok(())
}

/// Makes sure the development cache holds `pin`'s ffmpeg and ffprobe, as `bundle` and `package`
/// need them, and returns their folder.
pub fn ensure_media_tools(pin: &MediaToolsPin) -> Result<PathBuf> {
    ensure_in(&oriel_core_paths::media_tools_cache(), pin)
}

fn ensure_in(cache: &Path, pin: &MediaToolsPin) -> Result<PathBuf> {
    let folder = cache.join(pin.platform);
    log(format!(
        "ffmpeg {MEDIA_TOOLS_VERSION} for {} in {}",
        pin.platform,
        folder.display()
    ));
    if is_intact(&folder, pin) {
        log("  already intact");
        return Ok(folder);
    }

    if folder.exists() {
        fs::remove_dir_all(&folder).with_context(|| format!("emptying {}", folder.display()))?;
    }
    let downloads = support::workspace_downloads();
    let unpacked = folder.join("unpacked");
    fs::create_dir_all(&unpacked)?;
    for (index, archive) in pin.archives.iter().enumerate() {
        let file = format!("ffmpeg-{MEDIA_TOOLS_VERSION}-{}-{index}.zip", pin.platform);
        let zip = support::download(
            &downloads,
            &Download {
                urls: &[archive.url],
                sha256: archive.sha256,
                file: &file,
                headers: &[],
            },
        )?;
        unzip(&zip, &unpacked)?;
    }

    // Keep the two programs, out of whatever folders the zips held them in, and drop the rest.
    let files = media_tools_files(pin.platform);
    for file in files {
        let source = find_file(&unpacked, file)?.with_context(|| {
            format!(
                "the pinned ffmpeg {MEDIA_TOOLS_VERSION} for {} holds no {file}",
                pin.platform
            )
        })?;
        let target = folder.join(file);
        fs::rename(&source, &target)?;
        make_executable(&target)?;
    }
    fs::remove_dir_all(&unpacked)?;

    let [ffmpeg, ffprobe] = files;
    let marker = MediaToolsMarker {
        version: MEDIA_TOOLS_VERSION.to_owned(),
        archives: archive_hashes(pin),
        ffmpeg: sha256_file(&folder.join(ffmpeg))?,
        ffprobe: sha256_file(&folder.join(ffprobe))?,
    };
    fs::write(
        folder.join(MediaToolsMarker::FILE),
        format!("{}\n", serde_json::to_string_pretty(&marker)?),
    )?;
    log("  fetched and verified");
    Ok(folder)
}

fn archive_hashes(pin: &MediaToolsPin) -> Vec<String> {
    pin.archives
        .iter()
        .map(|archive| archive.sha256.to_owned())
        .collect()
}

/// Whether `folder` holds the pinned version, unpacked from the pinned archives, with both
/// programs still hashing to what was recorded when they were unpacked.
fn is_intact(folder: &Path, pin: &MediaToolsPin) -> bool {
    let Some(marker) = MediaToolsMarker::read(folder) else {
        return false;
    };
    let [ffmpeg, ffprobe] = media_tools_files(pin.platform);
    marker.version == MEDIA_TOOLS_VERSION
        && marker.archives == archive_hashes(pin)
        && sha256_file(&folder.join(ffmpeg)).is_ok_and(|hash| hash == marker.ffmpeg)
        && sha256_file(&folder.join(ffprobe)).is_ok_and(|hash| hash == marker.ffprobe)
}

/// Unpacks a zip into `folder`. `ditto` keeps a Mac program's signature and mode; Windows 10 and
/// later ship bsdtar as `tar.exe`, which reads zip.
fn unzip(zip: &Path, folder: &Path) -> Result<()> {
    if cfg!(target_os = "macos") {
        run_here(
            support::system_tool("ditto"),
            &[
                "-x".as_ref(),
                "-k".as_ref(),
                zip.as_os_str(),
                folder.as_os_str(),
            ],
            folder,
        )
    } else if cfg!(windows) {
        run_here(
            support::system_tool("tar"),
            &[
                "-x".as_ref(),
                "-f".as_ref(),
                zip.as_os_str(),
                "-C".as_ref(),
                folder.as_os_str(),
            ],
            folder,
        )
    } else {
        bail!("no pinned ffmpeg is unpacked on this platform")
    }
}

/// The first file named `name` under `folder`, not following symlinks.
fn find_file(folder: &Path, name: &str) -> io::Result<Option<PathBuf>> {
    for entry in fs::read_dir(folder)? {
        let entry = entry?;
        let kind = entry.file_type()?;
        if kind.is_file() && entry.file_name() == name {
            return Ok(Some(entry.path()));
        }
        if kind.is_dir()
            && let Some(found) = find_file(&entry.path(), name)?
        {
            return Ok(Some(found));
        }
    }
    Ok(None)
}

fn make_executable(path: &Path) -> Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        fs::set_permissions(path, fs::Permissions::from_mode(0o755))?;
    }
    #[cfg(not(unix))]
    let _ = path;
    ensure!(path.is_file(), "{} is missing", path.display());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const PIN: MediaToolsPin = MediaToolsPin {
        platform: "darwin-arm64",
        archives: &[],
    };

    #[test]
    fn an_intact_cache_is_kept_and_a_changed_program_is_not() {
        let cache = std::env::temp_dir()
            .join("oriel-xtask-fetch-tests")
            .join(std::process::id().to_string());
        let _ = fs::remove_dir_all(&cache);
        let folder = cache.join(PIN.platform);
        fs::create_dir_all(&folder).unwrap();
        fs::write(folder.join("ffmpeg"), b"ffmpeg build").unwrap();
        fs::write(folder.join("ffprobe"), b"ffprobe build").unwrap();
        let marker = MediaToolsMarker {
            version: MEDIA_TOOLS_VERSION.to_owned(),
            archives: archive_hashes(&PIN),
            ffmpeg: sha256_file(&folder.join("ffmpeg")).unwrap(),
            ffprobe: sha256_file(&folder.join("ffprobe")).unwrap(),
        };
        fs::write(
            folder.join(MediaToolsMarker::FILE),
            serde_json::to_string(&marker).unwrap(),
        )
        .unwrap();

        // The pin has no archives, so only a kept cache gives the tools back.
        assert_eq!(ensure_in(&cache, &PIN).unwrap(), folder);

        fs::write(folder.join("ffprobe"), b"another build").unwrap();
        assert!(!is_intact(&folder, &PIN));
        fs::remove_dir_all(&cache).unwrap();
    }
}
