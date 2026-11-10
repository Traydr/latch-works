//! Makes the installer for a system (decision 19: unsigned, no updater):
//!
//! ```text
//! cargo run -p xtask -- package                      # on macOS: the DMG (`dmg`)
//! cargo run -p xtask -- package windows              # on Windows: Setup.exe through Velopack
//! cargo run -p xtask -- package windows --stage-only [--exe <oriel.exe>]
//! ```
//!
//! For Windows it stages `release/package/windows/Oriel/` in the target folder, the folder
//! Setup.exe installs to `%LocalAppData%\Oriel\current`, laid out as
//! `oriel_core_paths::Package::WindowsFolder`:
//!
//! - `oriel.exe`: `cargo build --profile dist -p oriel`, or the file `--exe` names;
//! - `libmpv-2.dll` and `libvips-42.dll` ([`pins::WINDOWS_LIBMPV`], [`pins::WINDOWS_LIBVIPS`]);
//! - `libavif\`: MSYS2's libavif and the DLLs it needs, for Convert's AVIF encode
//!   (`libavif_windows`);
//! - `media-tools/ffmpeg.exe` and `ffprobe.exe`: the win32-x64 pin;
//! - `licenses/`: each part's notices and their index, as the Mac bundle has them.
//!
//! Then, on Windows, `vpk pack` makes `Oriel-<version>-win-x64-Setup.exe` and a portable ZIP
//! in `release/package/windows/velopack/`, with the arguments Electron Oriel's Forge config gives
//! it, less the MSI and the splash: `vpk` is the release of the `velopack` crate in `Cargo.lock`.
//! Every download is pinned by SHA-256. `--stage-only` stops before `vpk`, and is the only way
//! on a Mac, which has no .NET; there `--exe` takes a Windows
//! build made elsewhere (or none: the stage then lacks only the executable).

use std::ffi::OsStr;
use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{Context as _, Result, bail};
use oriel_core_paths::{APP_NAME, NativeSet, Notice, Package, Places, WINDOWS_EXECUTABLE};

use crate::bundle;
use crate::notices;
use crate::pins::{self, PinnedFile, WINDOWS_LIBMPV, WINDOWS_LIBVIPS};
use crate::support::{self, log, run_here};

/// Velopack's id, Electron Oriel's: the install folder is `%LocalAppData%\Oriel`.
const PACK_ID: &str = "Oriel";

const TARGET: &str = "x86_64-pc-windows-msvc";

/// The `velopack` crate's version in `Cargo.lock`. `vpk` must be the same release as the crate
/// the app links.
fn vpk_version(workspace: &Path) -> Result<String> {
    let lock = fs::read_to_string(workspace.join("Cargo.lock"))?;
    lock.split("[[package]]")
        .find(|entry| entry.lines().any(|line| line == "name = \"velopack\""))
        .and_then(|entry| {
            entry
                .lines()
                .find_map(|line| line.strip_prefix("version = \"")?.strip_suffix('"'))
        })
        .map(str::to_owned)
        .context("Cargo.lock has no velopack")
}

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
    let workspace = oriel_core_paths::workspace();
    let repository = &support::repository();
    let version = bundle::VERSION;
    let folder = support::target_folder()
        .join("release")
        .join("package")
        .join("windows");
    let stage = folder.join(APP_NAME);
    let package = Package::WindowsFolder(stage.clone());
    if stage.exists() {
        fs::remove_dir_all(&stage)?;
    }
    fs::create_dir_all(package.media_tools())?;

    log("1. The executable");
    let exe = match &options.exe {
        Some(exe) => Some(exe.clone()),
        None if cfg!(windows) => Some(support::build_app()?.join(WINDOWS_EXECUTABLE)),
        None => None,
    };
    match &exe {
        Some(exe) => {
            fs::copy(exe, package.executable_folder().join(WINDOWS_EXECUTABLE))
                .with_context(|| format!("copying {}", exe.display()))?;
        }
        None => log("  none given: the stage lacks oriel.exe (pass --exe <path>)"),
    }

    log("\n2. libmpv, libvips and libavif");
    let downloads = support::workspace_downloads();
    let licenses = package.licenses();
    let mut listed = vec![notices::oriel(repository, &licenses, version)?];
    for part in [&WINDOWS_LIBMPV, &WINDOWS_LIBVIPS] {
        listed.push(stage_file(
            part,
            &downloads,
            &package.libraries(),
            &licenses,
        )?);
    }
    listed.push(crate::libavif_windows::fetch(
        &downloads,
        &package.libavif(),
        &licenses,
    )?);

    log("\n3. ffmpeg and ffprobe");
    let pin = &pins::WINDOWS_MEDIA_TOOLS;
    let tools = crate::fetch::ensure_media_tools(pin)?;
    for tool in oriel_core_paths::media_tools_files(pin.platform) {
        fs::copy(tools.join(tool), package.media_tools().join(tool))?;
    }
    listed.push(notices::media_tools_windows(pin, &licenses)?);

    log("\n4. The notices");
    listed.push(notices::rust_crates_for(&workspace, &licenses, TARGET)?);
    notices::write_index(&licenses, version, &listed)?;
    check_finds(&package)?;
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
        bail!("Setup.exe needs oriel.exe");
    }
    let setup = pack(repository, version, &stage, &folder.join("velopack"))?;
    // What install-windows.ps1 installs and compares, so it spells no path of its own.
    let outputs = serde_json::json!({
        "setup": setup,
        "executable": package.executable_folder().join(WINDOWS_EXECUTABLE),
    });
    fs::write(folder.join(OUTPUTS_FILE), support::format_json(&outputs)?)?;
    Ok(())
}

/// The file in the package's folder naming Setup.exe and the staged executable.
const OUTPUTS_FILE: &str = "outputs.json";

/// On Windows, finds each library and the programs in the stage by the app's own search, as the
/// installed app will. Elsewhere the search looks for another system's files, so it is skipped.
fn check_finds(package: &Package) -> Result<()> {
    if !cfg!(windows) {
        return Ok(());
    }
    let places = Places {
        package: Some(package.clone()),
        variable: None,
        development: PathBuf::new(),
        fallback: None,
    };
    for set in [
        &NativeSet::LIBMPV,
        &NativeSet::LIBVIPS,
        &NativeSet::LIBAVIF,
        &NativeSet::MEDIA_TOOLS,
    ] {
        let found = set.locate_in(&places)?;
        log(format!(
            "  the app finds {}: {}",
            set.name,
            found.path.display()
        ));
    }
    Ok(())
}

/// Extracts `part`'s file into `folder`, and its notices into `licenses/<name>`.
fn stage_file(
    part: &PinnedFile,
    downloads: &Path,
    folder: &Path,
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
    fs::rename(work.join(part.member), folder.join(part.staged))?;

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
/// Packs the stage into Setup.exe and a portable zip in `out`, and returns Setup.exe's path.
fn pack(repository: &Path, version: &str, stage: &Path, out: &Path) -> Result<PathBuf> {
    if support::capture("vpk", &["--help".as_ref()]).is_err() {
        bail!(
            "Velopack's vpk did not run. Install it with: dotnet tool install -g vpk --version {}",
            vpk_version(&oriel_core_paths::workspace())?
        );
    }
    if out.exists() {
        fs::remove_dir_all(out)?;
    }
    let icon = oriel_core_paths::workspace().join("assets/oriel-icon.ico");
    let args: Vec<&OsStr> = vec![
        "pack".as_ref(),
        "--packId".as_ref(),
        PACK_ID.as_ref(),
        "--packVersion".as_ref(),
        version.as_ref(),
        "--packTitle".as_ref(),
        APP_NAME.as_ref(),
        "--packAuthors".as_ref(),
        "Traydr".as_ref(),
        // Without it vpk marks the package x86, whatever the build's architecture.
        "--runtime".as_ref(),
        "win-x64".as_ref(),
        "--packDir".as_ref(),
        stage.as_os_str(),
        "--mainExe".as_ref(),
        WINDOWS_EXECUTABLE.as_ref(),
        "--icon".as_ref(),
        icon.as_os_str(),
        "--outputDir".as_ref(),
        out.as_os_str(),
    ];
    run_here("vpk", &args, repository)?;
    // Velopack names them by channel alone.
    let name = format!("{APP_NAME}-{version}-win-x64");
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
        fs::rename(out.join(&from), out.join(&to))
            .with_context(|| format!("vpk made no {from} in {}", out.display()))?;
        log(format!("  {}", out.join(&to).display()));
    }
    Ok(out.join(format!("{name}-Setup.exe")))
}
