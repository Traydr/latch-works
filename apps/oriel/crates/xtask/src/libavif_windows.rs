//! libavif for Windows, which Convert's AVIF encode and View's AVIF decode load at run time as the
//! Mac's does (`oriel-avif`). It is MSYS2's UCRT64 build, the same libavif 1.4.2 as the Mac's
//! Homebrew bottle, with aom (the encoder the archive settings use), dav1d, rav1e, SVT-AV1,
//! libyuv and libsharpyuv, and MinGW's C++ runtime, which libyuv needs:
//!
//! ```text
//! cargo run -p xtask -- vendor libavif-windows   # into apps/oriel/.vendor/libavif-windows
//! cargo run -p xtask -- package windows          # into the stage's libavif\ folder
//! ```
//!
//! Each package is pinned by SHA-256 ([`WINDOWS_LIBAVIF`]). A package is a zstd-compressed
//! tar: the zstd comes off in Rust (`ruzstd`), then the system's bsdtar, which both systems carry,
//! unpacks the tar. The DLLs go into one folder, from which `oriel-avif` loads libavif with that
//! folder searched first for the rest; the command refuses a set where one DLL needs a DLL that
//! neither the set nor Windows provides.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use anyhow::{Context as _, Result, bail};

use oriel_core_paths::Notice;

use crate::pins::{Msys2Package, WINDOWS_LIBAVIF, WINDOWS_LIBAVIF_VERSION};
use crate::support::{self, Download, log, run_here};

/// MSYS2's UCRT64 repository, then its mirror service.
const MIRRORS: [&str; 2] = [
    "https://repo.msys2.org/mingw/ucrt64/",
    "https://mirror.msys2.org/mingw/ucrt64/",
];

/// The set's name on `vendor`'s command line.
pub const NAME: &str = "libavif-windows";

/// Fetches the set into `out` (its DLLs, side by side) and its notices into
/// `licenses/libavif`, and returns the notice for `index.json`.
pub fn fetch(downloads: &Path, out: &Path, licenses: &Path) -> Result<Notice> {
    log(format!("  libavif for Windows: {WINDOWS_LIBAVIF_VERSION}"));
    if out.exists() {
        fs::remove_dir_all(out)?;
    }
    fs::create_dir_all(out)?;
    let notices = licenses.join("libavif");
    if notices.exists() {
        fs::remove_dir_all(&notices)?;
    }
    fs::create_dir_all(&notices)?;
    let mut notice = vec![
        format!("{WINDOWS_LIBAVIF_VERSION}: libavif-16.dll and the DLLs it needs, in libavif\\"),
        String::new(),
        "Each package was fetched from MSYS2's UCRT64 repository and checked by SHA-256 before \
         use, against the hash MSYS2's signed repository database lists for it."
            .to_owned(),
        "Each package's build recipe (PKGBUILD) and the patches it applies are at \
         https://github.com/msys2/MINGW-packages/tree/master/mingw-w64-<name>, and each \
         package's source at the URL its recipe names."
            .to_owned(),
        String::new(),
    ];
    for package in &WINDOWS_LIBAVIF {
        let unpacked = unpack(downloads, package)?;
        for dll in package.dlls {
            let from = unpacked.join("ucrt64").join("bin").join(dll);
            fs::copy(&from, out.join(dll))
                .with_context(|| format!("copying {}", from.display()))?;
        }
        let licence_folder = unpacked
            .join("ucrt64")
            .join("share")
            .join("licenses")
            .join(package.name);
        support::copy_tree(&licence_folder, &notices.join(package.name))
            .with_context(|| format!("copying {}'s licences", package.name))?;
        notice.extend([
            format!(
                "{} {}: {}",
                package.name,
                package.version,
                package.dlls.join(", ")
            ),
            format!("  Licence: {}.", package.licence),
            format!("  {}{}", MIRRORS[0], url_name(&package.file())),
            format!("    SHA-256 {}", package.sha256),
            String::new(),
        ]);
        fs::remove_dir_all(&unpacked)?;
    }
    fs::write(notices.join("NOTICE.txt"), notice.join("\n"))?;
    check_closure(out)?;
    Ok(Notice {
        folder: "libavif".into(),
        name: "libavif".into(),
        version: WINDOWS_LIBAVIF_VERSION.into(),
        licence: "BSD-2-Clause, with BSD-licensed codecs and GCC's runtime (GPL-3.0-or-later \
                  WITH GCC-exception-3.1); NOTICE.txt lists each"
            .into(),
    })
}

/// `cargo run -p xtask -- vendor libavif-windows`: the set into
/// `apps/oriel/.vendor/libavif-windows`, where a development build on Windows finds it.
pub fn vendor() -> Result<()> {
    let downloads = support::workspace_downloads();
    let out = oriel_core_paths::vendored_libavif_windows();
    let staging = oriel_core_paths::workspace()
        .join("target")
        .join("vendor")
        .join("libavif-windows.licenses");
    fetch(&downloads, &out, &staging)?;
    let licenses = out.join("licenses");
    support::copy_tree(&staging.join("libavif"), &licenses)?;
    fs::remove_dir_all(&staging)?;
    log(format!(
        "  {}: {}",
        out.display(),
        support::megabytes(support::folder_bytes(&out)?)
    ));
    Ok(())
}

/// A file name as a URL path segment: MSYS2's `libstdc++` is `libstdc%2B%2B` there.
fn url_name(file: &str) -> String {
    file.replace('+', "%2B")
}

/// Downloads and checks one package, then unpacks it into a fresh folder beside the download.
fn unpack(downloads: &Path, package: &Msys2Package) -> Result<PathBuf> {
    let file = package.file();
    let urls: Vec<String> = MIRRORS
        .iter()
        .map(|mirror| format!("{mirror}{}", url_name(&file)))
        .collect();
    let urls: Vec<&str> = urls.iter().map(String::as_str).collect();
    let archive = support::download(
        downloads,
        &Download {
            urls: &urls,
            sha256: package.sha256,
            file: &file,
            headers: &[],
        },
    )?;
    let unpacked = downloads.join(format!("{file}.unpacked"));
    if unpacked.exists() {
        fs::remove_dir_all(&unpacked)?;
    }
    fs::create_dir_all(&unpacked)?;
    let tar = unpacked.join("package.tar");
    {
        let compressed = io::BufReader::new(fs::File::open(&archive)?);
        let mut decoder = ruzstd::decoding::StreamingDecoder::new(compressed)
            .map_err(|error| anyhow::anyhow!("{file} is not zstd: {error}"))?;
        let mut plain = io::BufWriter::new(fs::File::create(&tar)?);
        io::copy(&mut decoder, &mut plain).with_context(|| format!("decompressing {file}"))?;
    }
    run_here(
        support::system_tool("tar"),
        &[
            "-xf".as_ref(),
            tar.as_os_str(),
            "-C".as_ref(),
            unpacked.as_os_str(),
        ],
        &unpacked,
    )?;
    fs::remove_file(&tar)?;
    Ok(unpacked)
}

/// DLLs every Windows 10 and 11 has: the system's own and the Universal CRT's API sets.
fn is_system_dll(name: &str) -> bool {
    let name = name.to_ascii_lowercase();
    name.starts_with("api-ms-win-")
        || [
            "kernel32.dll",
            "ntdll.dll",
            "user32.dll",
            "advapi32.dll",
            "bcrypt.dll",
            "bcryptprimitives.dll",
            "ws2_32.dll",
            "ucrtbase.dll",
        ]
        .contains(&name.as_str())
}

/// Refuses a set where a DLL needs another that neither the set nor Windows provides, which
/// would fail only when Convert first encodes on the owner's machine.
fn check_closure(folder: &Path) -> Result<()> {
    let members: Vec<String> = fs::read_dir(folder)?
        .filter_map(|entry| entry.ok()?.file_name().into_string().ok())
        .filter(|name| name.to_ascii_lowercase().ends_with(".dll"))
        .collect();
    let lowered: Vec<String> = members
        .iter()
        .map(|name| name.to_ascii_lowercase())
        .collect();
    let mut missing = Vec::new();
    for member in &members {
        let data = fs::read(folder.join(member))?;
        let file = object::read::pe::PeFile64::parse(&*data)
            .with_context(|| format!("{member} is not a 64-bit Windows DLL"))?;
        for import in object::Object::imports(&file)? {
            let import = import?;
            let library = String::from_utf8_lossy(import.library()).into_owned();
            if !is_system_dll(&library) && !lowered.contains(&library.to_ascii_lowercase()) {
                missing.push(format!("{member} needs {library}"));
            }
        }
    }
    missing.sort();
    missing.dedup();
    if !missing.is_empty() {
        bail!("the libavif set is incomplete: {}", missing.join("; "));
    }
    Ok(())
}
