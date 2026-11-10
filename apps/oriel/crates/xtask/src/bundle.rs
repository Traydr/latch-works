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
//!   not ([`crate::fetch`]);
//! - `Contents/Resources/licenses/<set>`: each set's licences and manifest, and the notices for
//!   Oriel itself, ffmpeg and ffprobe, and the Rust crates in the binary, with `index.json`
//!   listing them for the About dialog ([`notices`]);
//! - Electron Oriel's icon, an `Info.plist`, and a signature over the whole: ad hoc, or with the
//!   identity `ORIEL_MACOS_SIGN_IDENTITY` names, as Electron Oriel's Forge config does.
//!
//! Every place is `oriel_core_paths::Package`'s, which the app reads too, and once the bundle is
//! made each library and the programs are found in it by the app's own search, and each library
//! loads. `LSMinimumSystemVersion` is the newest macOS any part needs, so the app never starts
//! where a library it carries would not load. The bundle carries no data: the app keeps
//! everything in `~/.latch-works/oriel`, as a development build does.

use std::ffi::OsStr;
use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{Context as _, Result, bail};
use oriel_core_paths::{APP_NAME, BUNDLE_ID, MAC_EXECUTABLE, NativeSet, Notice, Package, Places};

use crate::libmpv::{self, BuildOptions, sources::DEPLOYMENT_TARGET};
use crate::notices;
use crate::pins;
use crate::support::{self, capture, compare_versions, is_system, log, read_macho, run_here};
use crate::vendor;

/// The workspace's version, which every crate inherits, xtask included.
pub(crate) const VERSION: &str = env!("CARGO_PKG_VERSION");

pub(crate) const ICON_FILE: &str = "oriel.icns";

/// Names the signing identity, as for Electron Oriel; without it the bundle is signed ad hoc.
const SIGN_IDENTITY_VARIABLE: &str = "ORIEL_MACOS_SIGN_IDENTITY";

/// One set of libraries packed into `Contents/Frameworks`.
struct PackedSet {
    name: &'static str,
    /// How the app finds it.
    native: &'static NativeSet,
    id: String,
    /// The folder its dylibs are in.
    libraries: PathBuf,
    /// The folder its `licenses/` and `manifest.json` are in.
    folder: PathBuf,
    /// The library the app loads from it.
    entry: String,
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
        ("CFBundleExecutable", MAC_EXECUTABLE),
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
    let mut files = vec![(MAC_EXECUTABLE.to_owned(), binary.to_path_buf())];
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

/// Finds each set's entry library and the programs in the finished bundle by the app's own
/// search, and loads each library, as the app will.
fn check_loads(package: &Package, sets: &[PackedSet]) -> Result<()> {
    let places = Places {
        package: Some(package.clone()),
        variable: None,
        development: PathBuf::new(),
        fallback: None,
    };
    for set in sets {
        let found = set.native.locate_in(&places)?;
        if found.path.file_name() != Some(set.entry.as_ref()) {
            bail!(
                "the app would load {} rather than {}",
                found.path.display(),
                set.entry
            );
        }
        // SAFETY: loading runs the library's initialisers, which have no preconditions; nothing
        // is called and the library stays loaded until this short-lived process exits.
        let library = unsafe { libloading::Library::new(&found.path) }
            .with_context(|| format!("{} does not load from the bundle", set.entry))?;
        std::mem::forget(library);
        log(format!("  the app finds and loads {}", set.entry));
    }
    NativeSet::MEDIA_TOOLS.locate_in(&places)?;
    log("  the app finds ffmpeg and ffprobe");
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
    let workspace = oriel_core_paths::workspace();
    let repository = &support::repository();

    log("1. The LGPL libmpv set");
    let libmpv = libmpv::ensure_libmpv(&BuildOptions::default())?;

    log("\n2. The vendored libvips and libavif");
    let libvips = vendor::ensure(&pins::LIBVIPS)?;
    let libavif = vendor::ensure(&pins::LIBAVIF)?;

    log("\n3. The pinned ffmpeg and ffprobe");
    let platform = oriel_core_paths::media_tools_platform();
    let pin = pins::media_tools_for(&platform)
        .with_context(|| format!("no ffmpeg is pinned for {platform}"))?;
    let media_tools = crate::fetch::ensure_media_tools(pin)?;

    log("\n4. The release build, with fat LTO");
    let binary = support::build_app()?.join(MAC_EXECUTABLE);
    let version = VERSION;

    log("\n5. The bundle");
    let bundle_folder = support::bundle_folder();
    let app = bundle_folder.join(format!("{APP_NAME}.app"));
    let staging = bundle_folder.join(format!(".{APP_NAME}.app.staging"));
    let contents = staging.join("Contents");
    let package = Package::MacBundle(contents.clone());
    let frameworks = package.libraries();
    let resources = package.resources();
    if staging.exists() {
        fs::remove_dir_all(&staging)?;
    }
    fs::create_dir_all(package.executable_folder())?;
    fs::create_dir_all(&frameworks)?;
    fs::create_dir_all(package.media_tools())?;

    let executable = package.executable_folder().join(MAC_EXECUTABLE);
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
            native: &NativeSet::LIBMPV,
            id: libmpv.id.clone(),
            libraries: libmpv.folder.clone(),
            folder: libmpv.folder.clone(),
            entry: libmpv::LIBMPV_FILE.to_owned(),
        },
        PackedSet {
            name: libvips.set.name,
            native: &NativeSet::LIBVIPS,
            id: libvips.id.clone(),
            libraries: libvips.library_folder(),
            folder: libvips.folder.clone(),
            entry: libvips.set.entry.to_owned(),
        },
        PackedSet {
            name: libavif.set.name,
            native: &NativeSet::LIBAVIF,
            id: libavif.id.clone(),
            libraries: libavif.library_folder(),
            folder: libavif.folder.clone(),
            entry: libavif.set.entry.to_owned(),
        },
    ];
    let packed = pack_frameworks(&sets, &frameworks)?;
    check_links(&frameworks)?;
    let licenses = package.licenses();
    let mut listed = vec![notices::oriel(repository, &licenses, version)?];
    for set in &sets {
        let folder = licenses.join(set.name);
        support::copy_tree(&set.folder.join("licenses"), &folder)?;
        let manifest = set.folder.join(crate::set::MANIFEST_FILE);
        fs::copy(&manifest, folder.join(crate::set::MANIFEST_FILE))?;
        listed.push(Notice {
            folder: set.name.into(),
            name: set.name.into(),
            version: set.id.clone(),
            licence: notices::set_licence(&manifest)?,
        });
    }
    listed.push(notices::media_tools(&media_tools, pin, &licenses)?);
    listed.push(notices::rust_crates(&workspace, &licenses)?);
    notices::write_index(&licenses, version, &listed)?;

    for tool in oriel_core_paths::media_tools_files(&platform) {
        copy_executable(&media_tools.join(tool), &package.media_tools().join(tool))?;
    }

    let (floor, needed_by) = minimum_macos(&executable, &frameworks)?;
    if floor != DEPLOYMENT_TARGET {
        log(format!(
            "  macOS {floor} and later: {needed_by} needs it, above Oriel's own {DEPLOYMENT_TARGET}"
        ));
    }
    fs::write(contents.join("Info.plist"), info_plist(version, &floor))?;

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
    let package = Package::MacBundle(app.join("Contents"));
    check_loads(&package, &sets)?;

    log(format!(
        "\n{}: {}, version {version}, macOS {floor} and later",
        app.display(),
        size_of(&app)?
    ));
    log(format!(
        "  {:>6}  the app",
        size_of(&package.executable_folder())?
    ));
    let final_frameworks = package.libraries();
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
        size_of(&package.media_tools())?
    ));
    Ok(app)
}
