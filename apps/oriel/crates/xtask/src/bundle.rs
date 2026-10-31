//! Makes `apps/oriel/target/release/bundle/Oriel.app` for the owner to double-click (plan
//! 063), or `release/bundle` in `CARGO_TARGET_DIR` when that is set:
//!
//! ```text
//! cargo run -p xtask -- bundle
//! ```
//!
//! - `Contents/MacOS/oriel`: `cargo build --profile dist -p oriel`, the release build with
//!   fat LTO (the workspace's `Cargo.toml` says why), in Cargo's own target folder
//!   (`CARGO_TARGET_DIR` if set), without its symbol table. The build in the target folder keeps
//!   it, under the same UUID, so `atos -o <target>/dist/oriel` still reads a crash report;
//! - `Contents/Frameworks`: the LGPL libmpv set, built first if it is not, and the vendored
//!   libvips and libavif sets, fetched first if they are not. Where two sets carry the same file
//!   (both have dav1d 1.5.4 as `libdav1d.7.dylib`), the first set's copy serves both;
//! - `Contents/Resources/media-tools`: the pinned ffmpeg and ffprobe, fetched first if they are
//!   not, through `oriel-tools`' own code, where `oriel-tools` looks for them in a bundle;
//! - `Contents/Resources/licenses/<set>`: each set's licences and manifest, and the notices for
//!   Oriel itself, ffmpeg and ffprobe, and the Rust crates in the binary, with `index.json`
//!   listing them for the About dialog ([`notices`]);
//! - Electron Oriel's icon, an `Info.plist`, and a signature over the whole: ad hoc, or with the
//!   identity `ORIEL_MACOS_SIGN_IDENTITY` names, as Electron Oriel's Forge config does.
//!
//! `LSMinimumSystemVersion` is the newest macOS any part needs, so the app never starts where a
//! library it carries would not load. The bundle carries no data: the app keeps everything in
//! `~/.latch-works/oriel`, as a development build does.

use std::ffi::{OsStr, OsString};
use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{Context as _, Result, bail};

use crate::libmpv::{self, BuildOptions, sources::DEPLOYMENT_TARGET};
use crate::notices::{self, Notice};
use crate::support::{self, capture, compare_versions, is_system, log, read_macho, run_here};
use crate::vendor::{self, pins};

pub(crate) const APP_NAME: &str = "Oriel";

const BUNDLE_ID: &str = "dev.traydr.latchworks.oriel";

const EXECUTABLE: &str = "oriel";

pub(crate) const ICON_FILE: &str = "oriel.icns";

/// Names the signing identity, as for Electron Oriel; without it the bundle is signed ad hoc.
const SIGN_IDENTITY_VARIABLE: &str = "ORIEL_MACOS_SIGN_IDENTITY";

/// One set of libraries packed into `Contents/Frameworks`.
struct PackedSet {
    name: &'static str,
    id: String,
    /// The folder its dylibs are in.
    libraries: PathBuf,
    /// The folder its `licenses/` and `manifest.json` are in.
    folder: PathBuf,
    /// The library the app loads from it.
    entry: String,
}

/// The workspace's version, which every crate inherits, from `[workspace.package]`.
pub(crate) fn crate_version(workspace: &Path) -> Result<String> {
    let manifest = fs::read_to_string(workspace.join("Cargo.toml"))?;
    let section = manifest
        .split_once("[workspace.package]")
        .map(|(_, rest)| rest.split_once("\n[").map_or(rest, |(section, _)| section))
        .context("Cargo.toml has no [workspace.package]")?;
    section
        .lines()
        .find_map(|line| line.strip_prefix("version = \""))
        .and_then(|rest| rest.strip_suffix('"'))
        .map(str::to_owned)
        .context("Cargo.toml's [workspace.package] has no version")
}

/// The profile the bundle's binary is built with, `[profile.dist]` in the workspace's manifest.
const PROFILE: &str = "dist";

/// Cargo's target folder, honouring `CARGO_TARGET_DIR` as Cargo does.
pub(crate) fn target_folder(workspace: &Path) -> PathBuf {
    std::env::var_os("CARGO_TARGET_DIR")
        .filter(|value| !value.is_empty())
        .map_or_else(|| workspace.join("target"), |folder| workspace.join(folder))
}

fn escape_xml(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

fn info_plist(version: &str, minimum_macos: &str) -> String {
    let strings = [
        ("CFBundleDevelopmentRegion", "en"),
        ("CFBundleDisplayName", APP_NAME),
        ("CFBundleName", APP_NAME),
        ("CFBundleExecutable", EXECUTABLE),
        ("CFBundleIdentifier", BUNDLE_ID),
        ("CFBundleIconFile", ICON_FILE),
        ("CFBundleInfoDictionaryVersion", "6.0"),
        ("CFBundlePackageType", "APPL"),
        ("CFBundleShortVersionString", version),
        ("CFBundleVersion", version),
        // The newest macOS the binary or a library it carries needs.
        ("LSMinimumSystemVersion", minimum_macos),
        // Oriel views and tidies an archive of photos and videos.
        (
            "LSApplicationCategoryType",
            "public.app-category.photography",
        ),
    ];
    let mut entries: Vec<String> = strings
        .iter()
        .map(|(key, value)| {
            format!(
                "  <key>{}</key>\n  <string>{}</string>",
                escape_xml(key),
                escape_xml(value)
            )
        })
        .collect();
    entries.push("  <key>NSHighResolutionCapable</key>\n  <true/>".to_owned());
    [
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>".to_owned(),
        "<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \
         \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">"
            .to_owned(),
        "<plist version=\"1.0\">".to_owned(),
        "<dict>".to_owned(),
        entries.join("\n"),
        "</dict>".to_owned(),
        "</plist>".to_owned(),
        String::new(),
    ]
    .join("\n")
}

pub(crate) fn size_of(target: &Path) -> Result<String> {
    let output = capture("/usr/bin/du", &["-sh".as_ref(), target.as_os_str()])?;
    Ok(output.split('\t').next().unwrap_or_default().to_owned())
}

fn dylibs_in(folder: &Path) -> Result<Vec<String>> {
    let mut files: Vec<String> = fs::read_dir(folder)?
        .filter_map(|entry| entry.ok()?.file_name().into_string().ok())
        .filter(|file| file.ends_with(".dylib"))
        .collect();
    files.sort();
    Ok(files)
}

fn copy_executable(from: &Path, to: &Path) -> Result<()> {
    fs::copy(from, to).with_context(|| format!("copying {}", from.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        fs::set_permissions(to, fs::Permissions::from_mode(0o755))?;
    }
    Ok(())
}

/// Copies each set's dylibs into `frameworks`, and returns what each file came from. A file
/// already there from an earlier set is left as it is when it has the same install name.
fn pack_frameworks(sets: &[PackedSet], frameworks: &Path) -> Result<Vec<(String, &'static str)>> {
    let mut packed: Vec<(String, &'static str)> = Vec::new();
    for set in sets {
        for file in dylibs_in(&set.libraries)? {
            let from = set.libraries.join(&file);
            if let Some((_, first)) = packed.iter().find(|(existing, _)| *existing == file) {
                let ours = read_macho(&from)?.id;
                let theirs = read_macho(&frameworks.join(&file))?.id;
                if ours != theirs {
                    bail!(
                        "{} and {first} both carry {file}, under different install names",
                        set.name
                    );
                }
                log(format!(
                    "  {file}: {first}'s copy serves {} too, under the same install name",
                    set.name
                ));
                continue;
            }
            copy_executable(&from, &frameworks.join(&file))?;
            packed.push((file, set.name));
        }
    }
    Ok(packed)
}

/// Every library in `frameworks` links only the system and each other, so dyld finds all of
/// them inside the bundle.
fn check_links(frameworks: &Path) -> Result<()> {
    let files = dylibs_in(frameworks)?;
    let mut problems = Vec::new();
    for file in &files {
        for link in read_macho(&frameworks.join(file))?.links {
            let inside = link
                .strip_prefix("@rpath/")
                .is_some_and(|name| files.iter().any(|file| file == name));
            if !is_system(&link) && !inside {
                problems.push(format!("{file} links {link}"));
            }
        }
    }
    if !problems.is_empty() {
        bail!(
            "libraries in the bundle link outside it:\n  {}",
            problems.join("\n  ")
        );
    }
    Ok(())
}

/// The newest macOS the binary and the libraries need, and which file needs it.
fn minimum_macos(binary: &Path, frameworks: &Path) -> Result<(String, String)> {
    let mut floor = (DEPLOYMENT_TARGET.to_owned(), "Oriel".to_owned());
    let mut files = vec![(EXECUTABLE.to_owned(), binary.to_path_buf())];
    files.extend(
        dylibs_in(frameworks)?
            .into_iter()
            .map(|file| (file.clone(), frameworks.join(file))),
    );
    for (file, path) in files {
        if let Some(minos) = read_macho(&path)?.minos
            && compare_versions(&minos, &floor.0).is_gt()
        {
            floor = (minos, file);
        }
    }
    Ok(floor)
}

/// Loads each set's entry library from the finished bundle, as the app will.
fn check_loads(frameworks: &Path, sets: &[PackedSet]) -> Result<()> {
    for set in sets {
        let path = frameworks.join(&set.entry);
        // SAFETY: loading runs the library's initialisers, which have no preconditions; nothing
        // is called and the library stays loaded until this short-lived process exits.
        let library = unsafe { libloading::Library::new(&path) }
            .with_context(|| format!("{} does not load from the bundle", set.entry))?;
        std::mem::forget(library);
        log(format!("  {} loads from Contents/Frameworks", set.entry));
    }
    Ok(())
}

pub fn command(args: &[String]) -> Result<()> {
    if let Some(extra) = args.first() {
        bail!("bundle takes no options, not {extra}");
    }
    let app = make()?;
    log(format!("\nOpen it with: open \"{}\"", app.display()));
    Ok(())
}

/// Makes the bundle and returns where it is.
pub fn make() -> Result<PathBuf> {
    if !support::is_mac_arm64() {
        bail!("Oriel is bundled on macOS arm64 only");
    }
    let workspace = support::workspace();
    let repository = workspace
        .ancestors()
        .nth(2)
        .context("apps/oriel sits two folders under the repository")?;

    log("1. The LGPL libmpv set");
    let libmpv = libmpv::ensure_libmpv(&BuildOptions::default())?;

    log("\n2. The vendored libvips and libavif");
    let libvips = vendor::ensure(&pins::LIBVIPS)?;
    let libavif = vendor::ensure(&pins::LIBAVIF)?;

    log("\n3. The pinned ffmpeg and ffprobe");
    let platform = oriel_tools::current_platform();
    let pin = oriel_tools::pin_for(&platform)
        .with_context(|| format!("no ffmpeg is pinned for {platform}"))?;
    let media_tools = oriel_tools::ensure_media_tools(&oriel_tools::dev_cache(), pin)?;
    log(format!(
        "{} {}",
        if media_tools.downloaded {
            "Fetched and verified"
        } else {
            "Already intact:"
        },
        media_tools.folder.display()
    ));

    log("\n4. The release build, with fat LTO");
    let cargo = std::env::var_os("CARGO").unwrap_or_else(|| OsString::from("cargo"));
    run_here(
        &cargo,
        &[
            "build".as_ref(),
            "--profile".as_ref(),
            PROFILE.as_ref(),
            "-p".as_ref(),
            "oriel".as_ref(),
        ],
        &workspace,
    )?;
    let binary = target_folder(&workspace).join(PROFILE).join(EXECUTABLE);
    let version = crate_version(&workspace)?;

    log("\n5. The bundle");
    // In the target folder of the build it packs, so two target folders make two bundles.
    let bundle_folder = target_folder(&workspace).join("release").join("bundle");
    let app = bundle_folder.join(format!("{APP_NAME}.app"));
    let staging = bundle_folder.join(format!(".{APP_NAME}.app.staging"));
    let contents = staging.join("Contents");
    let frameworks = contents.join("Frameworks");
    let resources = contents.join("Resources");
    if staging.exists() {
        fs::remove_dir_all(&staging)?;
    }
    fs::create_dir_all(contents.join("MacOS"))?;
    fs::create_dir_all(&frameworks)?;
    fs::create_dir_all(resources.join("media-tools"))?;

    let executable = contents.join("MacOS").join(EXECUTABLE);
    copy_executable(&binary, &executable)?;
    // The symbol table is a fifth of the binary, and nothing reads it at run time.
    capture("/usr/bin/strip", &["-x".as_ref(), executable.as_os_str()])?;
    fs::write(contents.join("PkgInfo"), "APPL????")?;
    // The same artwork as Electron Oriel's icon, for the same app.
    fs::copy(
        workspace.join("assets/oriel-icon.icns"),
        resources.join(ICON_FILE),
    )?;

    let sets = [
        PackedSet {
            name: "libmpv",
            id: libmpv.id.clone(),
            libraries: libmpv.folder.clone(),
            folder: libmpv.folder.clone(),
            entry: libmpv::LIBMPV_FILE.to_owned(),
        },
        PackedSet {
            name: libvips.set.name,
            id: libvips.id.clone(),
            libraries: libvips.library_folder(),
            folder: libvips.folder.clone(),
            entry: libvips.set.entry.to_owned(),
        },
        PackedSet {
            name: libavif.set.name,
            id: libavif.id.clone(),
            libraries: libavif.library_folder(),
            folder: libavif.folder.clone(),
            entry: libavif.set.entry.to_owned(),
        },
    ];
    let packed = pack_frameworks(&sets, &frameworks)?;
    check_links(&frameworks)?;
    let licenses = resources.join("licenses");
    let mut listed = vec![notices::oriel(repository, &licenses, &version)?];
    for set in &sets {
        let folder = licenses.join(set.name);
        support::copy_tree(&set.folder.join("licenses"), &folder)?;
        fs::copy(
            set.folder.join("manifest.json"),
            folder.join("manifest.json"),
        )?;
        listed.push(Notice {
            folder: set.name.into(),
            name: set.name.into(),
            version: set.id.clone(),
            licence: notices::set_licence(&set.folder.join("manifest.json"))?,
        });
    }
    listed.push(notices::media_tools(&media_tools.folder, pin, &licenses)?);
    listed.push(notices::rust_crates(&workspace, &licenses)?);
    notices::write_index(&licenses, &version, &listed)?;

    for tool in oriel_tools::tool_files(&platform) {
        copy_executable(
            &media_tools.folder.join(tool),
            &resources.join("media-tools").join(tool),
        )?;
    }

    let (floor, needed_by) = minimum_macos(&executable, &frameworks)?;
    if floor != DEPLOYMENT_TARGET {
        log(format!(
            "  macOS {floor} and later: {needed_by} needs it, above Oriel's own {DEPLOYMENT_TARGET}"
        ));
    }
    fs::write(contents.join("Info.plist"), info_plist(&version, &floor))?;

    let staging_arg: &OsStr = staging.as_os_str();
    run_here(
        "/usr/bin/plutil",
        &["-lint".as_ref(), contents.join("Info.plist").as_os_str()],
        &workspace,
    )?;
    let mut sign: Vec<&OsStr> = vec!["--force".as_ref(), "--deep".as_ref()];
    let identity = std::env::var(SIGN_IDENTITY_VARIABLE).unwrap_or_default();
    let identity = identity.trim();
    if identity.is_empty() {
        sign.extend(["--sign", "-"].map(OsStr::new));
    } else {
        // A Developer ID signature, as Electron Oriel's Forge config makes one: with the
        // hardened runtime and a timestamp, which notarization will want.
        log(format!("  signing as {identity}"));
        sign.extend(["--options", "runtime", "--timestamp", "--sign", identity].map(OsStr::new));
    }
    sign.push(staging_arg);
    run_here("/usr/bin/codesign", &sign, &workspace)?;
    run_here(
        "/usr/bin/codesign",
        &[
            "--verify".as_ref(),
            "--deep".as_ref(),
            "--strict".as_ref(),
            staging_arg,
        ],
        &workspace,
    )?;
    if app.exists() {
        fs::remove_dir_all(&app)?;
    }
    fs::rename(&staging, &app)?;
    check_loads(&app.join("Contents").join("Frameworks"), &sets)?;

    log(format!(
        "\n{}: {}, version {version}, macOS {floor} and later",
        app.display(),
        size_of(&app)?
    ));
    log(format!(
        "  {:>6}  the app",
        size_of(&app.join("Contents/MacOS"))?
    ));
    let final_frameworks = app.join("Contents").join("Frameworks");
    for set in &sets {
        let files: Vec<&String> = packed
            .iter()
            .filter(|(_, from)| *from == set.name)
            .map(|(file, _)| file)
            .collect();
        let bytes: u64 = files
            .iter()
            .map(|file| fs::metadata(final_frameworks.join(file)).map_or(0, |meta| meta.len()))
            .sum();
        log(format!(
            "  {:>6}  {} set {} ({} dylibs)",
            support::megabytes(bytes),
            set.name,
            set.id,
            files.len()
        ));
    }
    log(format!(
        "  {:>6}  ffmpeg and ffprobe",
        size_of(&app.join("Contents/Resources/media-tools"))?
    ));
    Ok(app)
}
