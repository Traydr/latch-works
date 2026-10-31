//! Fetching the pinned tools into a cache folder, for development and for packaging. The steps
//! are Electron Oriel's `ensureMediaTools`, so the folder has the same shape and the same
//! `pin.json`: each zip must hash to its pin before it is unpacked, and the unpacked binaries'
//! own hashes are recorded and checked on every later fetch, so a changed binary is fetched again
//! rather than used.
//!
//! It runs on demand (`cargo run -p oriel-tools --bin fetch-media-tools`), never from a build
//! script, so a build never touches the network.

use std::fs;
use std::io::{self, Read as _};
use std::path::{Path, PathBuf};
use std::process::Command;

use anyhow::{Context as _, bail, ensure};
use serde::{Deserialize, Serialize};
use sha2::{Digest as _, Sha256};

use crate::pins::{MediaToolsPin, PinnedArchive, tool_files};

/// The command that fills the development cache, for the messages that ask for it.
pub const FETCH_COMMAND: &str = "cargo run -p oriel-tools --bin fetch-media-tools";

/// The file beside the tools that records what was unpacked.
pub(crate) const MARKER_FILE: &str = "pin.json";

/// What `pin.json` holds: the pin's version and the unpacked binaries' SHA-256.
#[derive(Debug, Deserialize, Serialize, PartialEq, Eq)]
pub(crate) struct Marker {
    pub version: String,
    pub ffmpeg: String,
    pub ffprobe: String,
}

impl Marker {
    pub(crate) fn read(folder: &Path) -> Option<Self> {
        let text = fs::read_to_string(folder.join(MARKER_FILE)).ok()?;
        serde_json::from_str(&text).ok()
    }
}

/// `apps/oriel/.media-tools`, the cache development builds and tests look in and packaging
/// copies from, one folder per platform. It is git-ignored, as Electron Oriel's is.
pub fn dev_cache() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(2)
        .expect("crates/tools sits two folders under the workspace")
        .join(".media-tools")
}

/// Where [`ensure_media_tools`] left the tools, and whether it had to download them.
#[derive(Debug)]
pub struct Fetched {
    pub folder: PathBuf,
    pub downloaded: bool,
}

/// Makes sure `cache/<platform>` holds `pin`'s ffmpeg and ffprobe, downloading them when it does
/// not, and returns that folder.
pub fn ensure_media_tools(cache: &Path, pin: &MediaToolsPin) -> anyhow::Result<Fetched> {
    let folder = cache.join(pin.platform);
    if is_intact(&folder, pin) {
        return Ok(Fetched {
            folder,
            downloaded: false,
        });
    }

    if folder.exists() {
        fs::remove_dir_all(&folder).with_context(|| format!("emptying {}", folder.display()))?;
    }
    let downloads = folder.join("download");
    let unpacked = folder.join("unpacked");
    fs::create_dir_all(&downloads)?;
    fs::create_dir_all(&unpacked)?;

    for (index, archive) in pin.archives.iter().enumerate() {
        let zip = downloads.join(format!("{index}.zip"));
        download(archive, &zip)?;
        verify(archive, &zip)?;
        unzip(&zip, &unpacked)?;
        fs::remove_file(&zip)?;
    }

    // Keep the two tools, out of whatever folders the zips held them in, and drop the rest.
    for file in tool_files(pin.platform) {
        let source = find_file(&unpacked, file)?.with_context(|| {
            format!(
                "the pinned ffmpeg {} for {} holds no {file}",
                pin.version, pin.platform
            )
        })?;
        let target = folder.join(file);
        fs::rename(&source, &target)?;
        make_executable(&target)?;
    }
    fs::remove_dir_all(&unpacked)?;
    fs::remove_dir_all(&downloads)?;

    let [ffmpeg, ffprobe] = tool_files(pin.platform);
    let marker = Marker {
        version: pin.version.to_owned(),
        ffmpeg: sha256_file(&folder.join(ffmpeg))?,
        ffprobe: sha256_file(&folder.join(ffprobe))?,
    };
    fs::write(
        folder.join(MARKER_FILE),
        format!("{}\n", serde_json::to_string_pretty(&marker)?),
    )?;

    Ok(Fetched {
        folder,
        downloaded: true,
    })
}

/// Whether `folder` holds `pin`'s version, with both binaries still hashing to what was recorded
/// when they were unpacked.
pub(crate) fn is_intact(folder: &Path, pin: &MediaToolsPin) -> bool {
    let Some(marker) = Marker::read(folder) else {
        return false;
    };
    let [ffmpeg, ffprobe] = tool_files(pin.platform);
    marker.version == pin.version
        && sha256_file(&folder.join(ffmpeg)).is_ok_and(|hash| hash == marker.ffmpeg)
        && sha256_file(&folder.join(ffprobe)).is_ok_and(|hash| hash == marker.ffprobe)
}

/// Downloads `archive` with the system's curl, over HTTPS only, redirects included.
fn download(archive: &PinnedArchive, zip: &Path) -> anyhow::Result<()> {
    let status = Command::new(system_tool("curl"))
        .args(["--fail", "--location", "--silent", "--show-error"])
        .args(["--proto", "=https", "--proto-redir", "=https", "--output"])
        .arg(zip)
        .arg(archive.url)
        .status()
        .context("starting curl")?;
    ensure!(
        status.success(),
        "downloading {} failed: curl {status}",
        archive.url
    );
    Ok(())
}

/// Refuses `zip`, and deletes it, unless it hashes to `archive`'s pin.
fn verify(archive: &PinnedArchive, zip: &Path) -> anyhow::Result<()> {
    let actual = sha256_file(zip)?;
    if actual != archive.sha256 {
        let _ = fs::remove_file(zip);
        bail!(
            "{} hashed to {actual}, not the pinned {}",
            archive.url,
            archive.sha256
        );
    }
    Ok(())
}

/// Unpacks a zip into `folder`. `ditto` keeps a Mac binary's signature and mode; Windows 10 and
/// later ship bsdtar as `tar.exe`, which reads zip.
fn unzip(zip: &Path, folder: &Path) -> anyhow::Result<()> {
    let mut command = if cfg!(target_os = "macos") {
        let mut command = Command::new(system_tool("ditto"));
        command.args(["-x", "-k"]).arg(zip).arg(folder);
        command
    } else if cfg!(windows) {
        let mut command = Command::new(system_tool("tar"));
        command.arg("-x").arg("-f").arg(zip).arg("-C").arg(folder);
        command
    } else {
        bail!("no pinned ffmpeg is unpacked on this platform");
    };
    let status = command.status().context("starting the unzip tool")?;
    ensure!(
        status.success(),
        "unpacking {} failed: {status}",
        zip.display()
    );
    Ok(())
}

/// The system's own copy of a tool, by absolute path, so a `PATH` entry cannot stand in for it.
fn system_tool(name: &str) -> PathBuf {
    if cfg!(windows) {
        let root = std::env::var_os("SystemRoot").unwrap_or_else(|| r"C:\Windows".into());
        Path::new(&root)
            .join("System32")
            .join(format!("{name}.exe"))
    } else {
        Path::new("/usr/bin").join(name)
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

fn make_executable(path: &Path) -> io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        fs::set_permissions(path, fs::Permissions::from_mode(0o755))?;
    }
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}

pub(crate) fn sha256_file(path: &Path) -> io::Result<String> {
    let mut file = fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0; 1 << 20];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    let digest: [u8; 32] = hasher.finalize().into();
    Ok(digest.iter().map(|byte| format!("{byte:02x}")).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    const PIN: MediaToolsPin = MediaToolsPin {
        platform: "darwin-arm64",
        version: "9.0.2",
        archives: &[],
    };

    fn scratch(test: &str) -> PathBuf {
        let folder = std::env::temp_dir()
            .join("oriel-tools-fetch-tests")
            .join(format!("{test}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&folder);
        fs::create_dir_all(&folder).unwrap();
        folder
    }

    #[test]
    fn a_download_that_misses_its_hash_is_refused_and_deleted() {
        let zip = scratch("refused").join("0.zip");
        fs::write(&zip, b"not the pinned build").unwrap();
        let archive = PinnedArchive {
            url: "https://example.invalid/ffmpeg.zip",
            sha256: "c8ed4c4e6978a03c485edbfe4e0a5dc2380f8a30bba5150531b31b094492d924",
        };
        let error = verify(&archive, &zip).unwrap_err().to_string();
        assert!(error.contains("not the pinned c8ed4c4e"), "{error}");
        assert!(!zip.exists());
    }

    #[test]
    fn an_intact_cache_is_kept_and_a_changed_binary_is_not() {
        let cache = scratch("intact");
        let folder = cache.join(PIN.platform);
        fs::create_dir_all(&folder).unwrap();
        fs::write(folder.join("ffmpeg"), b"ffmpeg build").unwrap();
        fs::write(folder.join("ffprobe"), b"ffprobe build").unwrap();
        let marker = Marker {
            version: PIN.version.to_owned(),
            ffmpeg: sha256_file(&folder.join("ffmpeg")).unwrap(),
            ffprobe: sha256_file(&folder.join("ffprobe")).unwrap(),
        };
        fs::write(
            folder.join(MARKER_FILE),
            serde_json::to_string(&marker).unwrap(),
        )
        .unwrap();

        // The pin has no archives, so a download would have nothing to fetch.
        let fetched = ensure_media_tools(&cache, &PIN).unwrap();
        assert_eq!(
            (fetched.folder, fetched.downloaded),
            (folder.clone(), false)
        );

        fs::write(folder.join("ffprobe"), b"another build").unwrap();
        assert!(!is_intact(&folder, &PIN));
    }

    #[test]
    fn hashes_are_lowercase_hex() {
        let file = scratch("hash").join("empty");
        fs::write(&file, b"").unwrap();
        assert_eq!(
            sha256_file(&file).unwrap(),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
    }
}
