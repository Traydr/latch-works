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
//! Each package is pinned by SHA-256, checked against the `%SHA256SUM%` MSYS2's signed
//! repository database (`ucrt64.db`) lists for it on 2026-10-31. A package is a zstd-compressed
//! tar: the zstd comes off in Rust (`ruzstd`), then the system's bsdtar, which both systems carry,
//! unpacks the tar. The DLLs go into one folder, from which `oriel-avif` loads libavif with that
//! folder searched first for the rest; the command refuses a set where one DLL needs a DLL that
//! neither the set nor Windows provides.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use anyhow::{Context as _, Result, bail};

use crate::notices::Notice;
use crate::support::{self, Download, log, run_here};

/// MSYS2's UCRT64 repository, then its mirror service.
const MIRRORS: [&str; 2] = [
    "https://repo.msys2.org/mingw/ucrt64/",
    "https://mirror.msys2.org/mingw/ucrt64/",
];

/// One MSYS2 package, pinned.
struct Msys2Package {
    /// The name after `mingw-w64-ucrt-x86_64-`.
    name: &'static str,
    /// `pkgver-pkgrel`.
    version: &'static str,
    sha256: &'static str,
    /// The DLLs it gives the set, from its `ucrt64/bin`.
    dlls: &'static [&'static str],
    /// Its `.PKGINFO`'s licence.
    licence: &'static str,
}

impl Msys2Package {
    fn file(&self) -> String {
        format!(
            "mingw-w64-ucrt-x86_64-{}-{}-any.pkg.tar.zst",
            self.name, self.version
        )
    }
}

/// The set: libavif and every DLL it needs, read from each DLL's imports.
const PACKAGES: [Msys2Package; 11] = [
    Msys2Package {
        name: "libavif",
        version: "1.4.2-1",
        sha256: "9dea354b257d2e593c82c88390a178be547faaaa06f366070b4f8abc784277e6",
        dlls: &["libavif-16.dll"],
        licence: "BSD-2-Clause",
    },
    Msys2Package {
        name: "aom",
        version: "3.15.3-1",
        sha256: "0fcdc93058a9b937e4f4faa0d6b03aa901c2ef568f5bb68ed88bd9c05a7a33f7",
        dlls: &["libaom.dll"],
        licence: "BSD-2-Clause",
    },
    Msys2Package {
        name: "dav1d",
        version: "1.5.4-1",
        sha256: "ccf26c6f29fd36f5692d57fd5e0fe3becec492e0b875fd5e04f47a9582eb8b37",
        dlls: &["libdav1d-7.dll"],
        licence: "BSD-2-Clause",
    },
    Msys2Package {
        name: "rav1e",
        version: "0.8.1-1",
        sha256: "00a03a734f96f66405ad79bae2ffb1c5cf2b050ef90a4ffa508ddbfdb64c0fb1",
        dlls: &["librav1e.dll"],
        licence: "BSD-2-Clause",
    },
    Msys2Package {
        name: "svt-av1",
        version: "4.2.0-1",
        sha256: "87c97a68bab7dd67413ea0cae024c3d2e4bdc2f96fccf38365304642b1b44ee5",
        dlls: &["libSvtAv1Enc-4.dll"],
        licence: "BSD-3-Clause-Clear",
    },
    Msys2Package {
        name: "libyuv",
        version: "1924.r2921.644251f25-2",
        sha256: "3016e0f97bf38313bb336447739f636c8622fc0ca2236fe48e3f6cd662ef56cb",
        dlls: &["libyuv.dll"],
        licence: "BSD-3-Clause",
    },
    Msys2Package {
        name: "libwebp",
        version: "1.6.0-1",
        sha256: "34ff8396c403d484c8777ad49ad0fc06dfb94fadf6f14bcf84d50c45bc6fd17e",
        dlls: &["libsharpyuv-0.dll"],
        licence: "BSD-3-Clause",
    },
    Msys2Package {
        name: "libjpeg-turbo",
        version: "3.2.1-1",
        sha256: "8eed77c1e0d6de7f8822687f7b1dfa32cda09394806ef67b23399e63de1a92a6",
        dlls: &["libjpeg-8.dll"],
        licence: "IJG AND BSD-3-Clause AND Zlib",
    },
    Msys2Package {
        name: "libstdc++",
        version: "16.2.0-6",
        sha256: "33c5e58a85a538cf843a8672991cce591f0231d66da3b66a57629712d64be17f",
        dlls: &["libstdc++-6.dll"],
        licence: "GPL-3.0-or-later WITH GCC-exception-3.1",
    },
    Msys2Package {
        name: "libgcc",
        version: "16.2.0-6",
        sha256: "80b2497f019977dd9528b1abc8621b1328a0115ab1f724047ccbb56bf323f11d",
        dlls: &["libgcc_s_seh-1.dll"],
        licence: "GPL-3.0-or-later WITH GCC-exception-3.1",
    },
    Msys2Package {
        name: "libwinpthread",
        version: "14.0.0.r569.g34eeafb7d-1",
        sha256: "b4ebe2826e848c5e790e06ea7b37d3e0594e005f42382b0506886f17df8127da",
        dlls: &["libwinpthread-1.dll"],
        licence: "MIT AND BSD-3-Clause",
    },
];

/// The set's name on `vendor`'s command line.
pub const NAME: &str = "libavif-windows";

/// The set's version, as the notices list it.
const SET_VERSION: &str = "libavif 1.4.2-1 (MSYS2 UCRT64)";

/// Fetches the set into `out` (its DLLs, side by side) and its notices into
/// `licenses/libavif`, and returns the notice for `index.json`.
pub fn fetch(downloads: &Path, out: &Path, licenses: &Path) -> Result<Notice> {
    log(format!("  libavif for Windows: {SET_VERSION}"));
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
        format!("{SET_VERSION}: libavif-16.dll and the DLLs it needs, in libavif\\"),
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
    for package in &PACKAGES {
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
        version: SET_VERSION.into(),
        licence: "BSD-2-Clause, with BSD-licensed codecs and GCC's runtime (GPL-3.0-or-later \
                  WITH GCC-exception-3.1); NOTICE.txt lists each"
            .into(),
    })
}

/// `cargo run -p xtask -- vendor libavif-windows`: the set into
/// `apps/oriel/.vendor/libavif-windows`, where a development build on Windows finds it.
pub fn vendor() -> Result<()> {
    let workspace = support::workspace();
    let downloads = workspace.join("target").join("vendor").join("downloads");
    let out = workspace.join(".vendor").join("libavif-windows");
    let staging = workspace
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
