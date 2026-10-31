//! Makes the installer for a system (decision 19: unsigned, no updater):
//!
//! ```text
//! cargo run -p xtask -- package                      # on macOS: the DMG (`dmg`)
//! cargo run -p xtask -- package windows              # on Windows: Setup.exe through Velopack
//! cargo run -p xtask -- package windows --stage-only [--exe <oriel-rs.exe>]
//! ```
//!
//! For Windows it stages `release/package/windows/Oriel RS/` in the target folder, the folder
//! Setup.exe installs to `%LocalAppData%\OrielRS\current`:
//!
//! - `oriel-rs.exe`: `cargo build --profile dist -p oriel-rs`, or the file `--exe` names;
//! - `libmpv-2.dll`: shinchiro's `mpv-dev-x86_64` build, GPL (fine for the owner's own use);
//! - `libvips-42.dll`: sharp's `@img/sharp-libvips-win32-x64`, the libvips 8.18.7 the Mac's is,
//!   with libheif and aom, so it decodes AVIF and HEIC;
//! - `libavif\`: MSYS2's libavif 1.4.2 and the DLLs it needs, for Convert's AVIF encode
//!   (`libavif_windows`);
//! - `media-tools/ffmpeg.exe` and `ffprobe.exe`: `oriel-tools`' win32-x64 pin, Electron Oriel's;
//! - `licenses/`: each part's notices and `index.json`, as the Mac bundle has them.
//!
//! Then, on Windows, `vpk pack` makes `Oriel-RS-<version>-win-x64-Setup.exe` and a portable ZIP
//! in `release/package/windows/velopack/`, with the arguments Electron Oriel's Forge config gives
//! it, less the MSI and the splash. Every download is pinned by SHA-256. `--stage-only` stops
//! before `vpk`, and is the only way on a Mac, which has no .NET; there `--exe` takes a Windows
//! build made elsewhere (or none: the stage then lacks only the executable).

use std::ffi::{OsStr, OsString};
use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{Context as _, Result, bail};

use crate::bundle;
use crate::notices::{self, Notice};
use crate::support::{self, Download, log, run_here};

/// Velopack's id: the install folder is `%LocalAppData%\OrielRS`, beside Electron Oriel's
/// `Oriel`, so the two install side by side.
const PACK_ID: &str = "OrielRS";

const EXECUTABLE: &str = "oriel-rs.exe";

const TARGET: &str = "x86_64-pc-windows-msvc";

/// The `vpk` Electron Oriel packs with, and the `velopack` crate the app links, the same version.
const VPK_VERSION: &str = "1.3.39-g8d2844f";

/// One file out of a pinned archive.
struct PinnedFile {
    name: &'static str,
    version: &'static str,
    licence: &'static str,
    download: Download<'static>,
    /// The archive's member, and the name it is staged under.
    member: &'static str,
    staged: &'static str,
    /// Members copied into the set's licence folder.
    licence_members: &'static [&'static str],
    /// What the notice says about the source.
    source: &'static str,
}

const LIBMPV: PinnedFile = PinnedFile {
    name: "libmpv",
    version: "mpv-dev-x86_64-20261021-git-e471496c56",
    licence: "GPL-3.0-or-later",
    download: Download {
        urls: &[
            "https://github.com/shinchiro/mpv-winbuild-cmake/releases/download/20261021/mpv-dev-x86_64-20261021-git-e471496c56.7z",
        ],
        // GitHub's own digest of the release asset, and this file's.
        sha256: "efc719eff3dc5954b4a5efc800632808bcec01cc9034940dd14e5eb7fe9ea633",
        file: "mpv-dev-x86_64-20261021-git-e471496c56.7z",
        headers: &[],
    },
    member: "libmpv-2.dll",
    staged: "libmpv-2.dll",
    licence_members: &[],
    source: "shinchiro's mpv-winbuild-cmake, release 20261021: mpv at commit e471496c56 with \
             FFmpeg and its libraries built with GPL parts enabled. The build scripts and the \
             pinned versions of every library are at \
             https://github.com/shinchiro/mpv-winbuild-cmake/tree/20261021, and mpv's source at \
             https://github.com/mpv-player/mpv/commit/e471496c56.",
};

const LIBVIPS: PinnedFile = PinnedFile {
    name: "libvips",
    version: "vips-8.18.7-sharp-1.3.4",
    licence: "LGPL-3.0-or-later as a whole; README.md lists each library and its terms",
    download: Download {
        urls: &[
            "https://registry.npmjs.org/@img/sharp-libvips-win32-x64/-/sharp-libvips-win32-x64-1.3.4.tgz",
        ],
        // Checked against the npm registry's sha512 integrity, sha512-7q6lQ6O26YHPLJfF7kMpuE5ZB0Y
        // ht898FXlYEUBCLgc0ffmLvJpZ/jYq1FyjTRCDmgc/t7GYQySEfGgh7+b8VA==.
        sha256: "3d6d4c909ffcf72d70b7d42a29fd8c69b71fd8afa786ce46cd88ebadfd187114",
        file: "sharp-libvips-win32-x64-1.3.4.tgz",
        headers: &[],
    },
    member: "package/lib/libvips-42.dll",
    staged: "libvips-42.dll",
    licence_members: &[
        "package/README.md",
        "package/versions.json",
        "package/package.json",
    ],
    source: "sharp's prebuilt libvips, @img/sharp-libvips-win32-x64 1.3.4 on the npm registry, \
             built by https://github.com/lovell/sharp-libvips at v1.3.4.",
};

/// The folder beside the executable `oriel-avif` looks in for libavif on Windows
/// (`LIBAVIF_WINDOWS_FOLDER`).
const LIBAVIF_FOLDER: &str = "libavif";

struct Options {
    stage_only: bool,
    exe: Option<PathBuf>,
}

fn parse(args: &[String]) -> Result<Options> {
    let mut options = Options {
        stage_only: false,
        exe: None,
    };
    let mut rest = args.iter();
    while let Some(arg) = rest.next() {
        match arg.as_str() {
            "--stage-only" => options.stage_only = true,
            "--exe" => {
                options.exe = Some(PathBuf::from(rest.next().context("--exe needs a path")?));
            }
            other => bail!("package windows takes --stage-only and --exe <path>, not {other}"),
        }
    }
    Ok(options)
}

pub fn command(args: &[String]) -> Result<()> {
    match args.split_first() {
        Some((system, rest)) if system == "windows" => windows(&parse(rest)?),
        Some((system, rest)) if system == "macos" => mac(rest),
        Some((other, _)) if !other.starts_with('-') => bail!("no package for {other}"),
        _ if cfg!(windows) => windows(&parse(args)?),
        _ => mac(args),
    }
}

#[cfg(target_os = "macos")]
fn mac(args: &[String]) -> Result<()> {
    crate::dmg::command(args)
}

#[cfg(not(target_os = "macos"))]
fn mac(_: &[String]) -> Result<()> {
    bail!("the DMG is made on macOS")
}

fn windows(options: &Options) -> Result<()> {
    let stage_only = options.stage_only || !cfg!(windows);
    let workspace = support::workspace();
    let repository = workspace
        .ancestors()
        .nth(2)
        .context("apps/oriel-rs sits two folders under the repository")?;
    let version = bundle::crate_version(&workspace)?;
    let target = bundle::target_folder(&workspace);
    let folder = target.join("release").join("package").join("windows");
    let stage = folder.join(bundle::APP_NAME);
    if stage.exists() {
        fs::remove_dir_all(&stage)?;
    }
    fs::create_dir_all(stage.join("media-tools"))?;

    log("1. The executable");
    let exe = match &options.exe {
        Some(exe) => Some(exe.clone()),
        None if cfg!(windows) => {
            let cargo = std::env::var_os("CARGO").unwrap_or_else(|| OsString::from("cargo"));
            run_here(
                &cargo,
                &["build", "--profile", "dist", "-p", "oriel-rs"].map(OsStr::new),
                &workspace,
            )?;
            Some(target.join("dist").join(EXECUTABLE))
        }
        None => None,
    };
    match &exe {
        Some(exe) => {
            fs::copy(exe, stage.join(EXECUTABLE))
                .with_context(|| format!("copying {}", exe.display()))?;
        }
        None => log("  none given: the stage lacks oriel-rs.exe (pass --exe <path>)"),
    }

    log("\n2. libmpv, libvips and libavif");
    let downloads = workspace.join("target").join("vendor").join("downloads");
    let licenses = stage.join("licenses");
    let mut listed = vec![notices::oriel_rs(repository, &licenses, &version)?];
    for part in [&LIBMPV, &LIBVIPS] {
        listed.push(stage_file(part, &downloads, &stage, &licenses)?);
    }
    listed.push(crate::libavif_windows::fetch(
        &downloads,
        &stage.join(LIBAVIF_FOLDER),
        &licenses,
    )?);

    log("\n3. ffmpeg and ffprobe");
    let pin = oriel_tools::pin_for("win32-x64").context("oriel-tools pins no Windows ffmpeg")?;
    let tools = oriel_tools::ensure_media_tools(&oriel_tools::dev_cache(), pin)?;
    for tool in oriel_tools::tool_files(pin.platform) {
        fs::copy(
            tools.folder.join(tool),
            stage.join("media-tools").join(tool),
        )?;
    }
    listed.push(notices::media_tools_windows(pin, &licenses)?);

    log("\n4. The notices");
    listed.push(notices::rust_crates_for(&workspace, &licenses, TARGET)?);
    notices::write_index(&licenses, &version, &listed)?;
    log(format!(
        "\n{}: {}",
        stage.display(),
        support::megabytes(support::folder_bytes(&stage)?)
    ));

    if stage_only {
        log("\nStaged only: vpk runs on Windows, with the .NET SDK.");
        return Ok(());
    }
    if exe.is_none() {
        bail!("Setup.exe needs oriel-rs.exe");
    }
    pack(repository, &version, &stage, &folder.join("velopack"))
}

/// Extracts `part`'s file into the stage, and its notices into `licenses/<name>`.
fn stage_file(
    part: &PinnedFile,
    downloads: &Path,
    stage: &Path,
    licenses: &Path,
) -> Result<Notice> {
    log(format!(
        "  {} {} ({})",
        part.name, part.version, part.licence
    ));
    let archive = support::download(downloads, &part.download)?;
    let work = downloads.join(format!("{}.unpacked", part.download.file));
    if work.exists() {
        fs::remove_dir_all(&work)?;
    }
    fs::create_dir_all(&work)?;
    let mut members = vec![part.member];
    members.extend(part.licence_members);
    let mut args: Vec<&OsStr> = vec![
        "-xf".as_ref(),
        archive.as_os_str(),
        "-C".as_ref(),
        work.as_os_str(),
    ];
    args.extend(members.iter().map(OsStr::new));
    run_here(support::system_tool("tar"), &args, &work)?;
    fs::rename(work.join(part.member), stage.join(part.staged))?;

    let notices = licenses.join(part.name);
    fs::create_dir_all(&notices)?;
    for member in part.licence_members {
        let name = Path::new(member)
            .file_name()
            .context("a member has a name")?;
        fs::rename(work.join(member), notices.join(name))?;
    }
    let mut notice = vec![
        format!("{} {}, as {}", part.name, part.version, part.staged),
        String::new(),
        format!("Licence: {}.", part.licence),
        String::new(),
        "Fetched from, and checked by SHA-256 before use:".to_owned(),
    ];
    for url in part.download.urls {
        notice.push(format!("  {url}"));
    }
    notice.extend([
        format!("    SHA-256 {}", part.download.sha256),
        String::new(),
        format!("Source: {}", part.source),
        String::new(),
    ]);
    fs::write(notices.join("NOTICE.txt"), notice.join("\n"))?;
    fs::remove_dir_all(&work)?;
    Ok(Notice {
        folder: part.name.into(),
        name: part.name.into(),
        version: part.version.into(),
        licence: part.licence.into(),
    })
}

/// `vpk pack` over the stage, as Electron Oriel's Forge config runs it, then the installers
/// named with the version and architecture, as the DMG is.
fn pack(repository: &Path, version: &str, stage: &Path, out: &Path) -> Result<()> {
    if support::capture("vpk", &["--help".as_ref()]).is_err() {
        bail!(
            "Velopack's vpk did not run. Install it with: dotnet tool install -g vpk --version \
             {VPK_VERSION}"
        );
    }
    if out.exists() {
        fs::remove_dir_all(out)?;
    }
    let icon = support::workspace().join("assets/oriel-icon.ico");
    let args: Vec<&OsStr> = vec![
        "pack".as_ref(),
        "--packId".as_ref(),
        PACK_ID.as_ref(),
        "--packVersion".as_ref(),
        version.as_ref(),
        "--packTitle".as_ref(),
        bundle::APP_NAME.as_ref(),
        "--packAuthors".as_ref(),
        "Traydr".as_ref(),
        // Without it vpk marks the package x86, whatever the build's architecture.
        "--runtime".as_ref(),
        "win-x64".as_ref(),
        "--packDir".as_ref(),
        stage.as_os_str(),
        "--mainExe".as_ref(),
        EXECUTABLE.as_ref(),
        "--icon".as_ref(),
        icon.as_os_str(),
        "--outputDir".as_ref(),
        out.as_os_str(),
    ];
    run_here("vpk", &args, repository)?;
    // Velopack names them by channel alone.
    let name = format!("{}-{version}-win-x64", bundle::APP_NAME.replace(' ', "-"));
    for (from, to) in [
        (
            format!("{PACK_ID}-win-Setup.exe"),
            format!("{name}-Setup.exe"),
        ),
        (
            format!("{PACK_ID}-win-Portable.zip"),
            format!("{name}-Portable.zip"),
        ),
    ] {
        if out.join(&from).exists() {
            fs::rename(out.join(&from), out.join(&to))?;
            log(format!("  {}", out.join(&to).display()));
        }
    }
    Ok(())
}
