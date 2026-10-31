//! Builds Oriel's LGPL libmpv for macOS arm64 from the pinned sources in [`sources`], and
//! installs it as one folder of dylibs that can sit in an app's `Contents/Frameworks`:
//!
//! ```text
//! cargo run -p xtask -- libmpv [--jobs 12] [--work <dir>] [--out <dir>] [--keep-work]
//! ```
//!
//! The set lands in `apps/oriel/.libmpv/<id>/` (`--out` moves the parent, to build a second
//! copy for comparison), where the id names mpv's and FFmpeg's versions and a hash of every pin
//! and flag, and `.libmpv/current` points at the newest. Each dylib is named `@rpath/<file>` and
//! finds the others through `@loader_path`, links nothing but the set and the system, and is
//! signed ad hoc. `manifest.json` beside them records versions, hashes, flags, licences and what
//! the libraries said about themselves; `SHA256SUMS` lets a later run, and the bundle, check the
//! files are still the ones built.
//!
//! Resumable: downloads are kept by hash, and each step of each source leaves a stamp, so an
//! interrupted run picks up at the step that did not finish. Only meson, ninja and pkgconf are
//! needed beyond Xcode; the builds see them, the system and nothing else on `PATH`, and
//! pkg-config sees only the set's own libraries, so nothing from Homebrew can be linked in.

pub mod sources;

use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Instant;

use anyhow::{Context as _, Result, bail};
use serde::Serialize;

use crate::support::{
    self, Download, MachO, Pairs, Step, capture, compare_versions, find_on_path, format_json,
    is_system, log, megabytes, read_macho, run, sha256_file, sha256_text,
};
use sources::{
    BuildSystem, DEPLOYMENT_TARGET, PinnedArchive, RECIPE_REVISION, SOURCES, Source,
    source_by_name, source_of_library,
};

const LGPL: &str = "LGPL version 2.1 or later";

/// The set's own name for the library the player loads.
pub const LIBMPV_FILE: &str = "libmpv.2.dylib";

const CHECKSUMS_FILE: &str = "SHA256SUMS";

/// The program that asks the built set what it is.
const CHECK_PROGRAM: &str = include_str!("check-libmpv.c");

pub struct BuildOptions {
    pub jobs: usize,
    /// Sources, builds and the staging prefix.
    pub work: PathBuf,
    /// The folder holding one folder per built set and the `current` link.
    pub out: PathBuf,
    pub keep_work: bool,
}

impl Default for BuildOptions {
    /// The defaults the command line and the bundle share.
    fn default() -> Self {
        let workspace = support::workspace();
        Self {
            jobs: std::thread::available_parallelism().map_or(1, usize::from),
            // Under Cargo's target folder, which tools ignore.
            work: workspace.join("target").join("libmpv"),
            // `apps/oriel/.libmpv`, git-ignored.
            out: workspace.join(".libmpv"),
            keep_work: false,
        }
    }
}

/// A built set: its id and folder.
pub struct LibmpvSet {
    pub id: String,
    pub folder: PathBuf,
}

/// Where one set's sources, builds and staging prefix live while it is built.
struct WorkTree {
    root: PathBuf,
    downloads: PathBuf,
    src: PathBuf,
    build: PathBuf,
    prefix: PathBuf,
    logs: PathBuf,
    stamps: PathBuf,
    tools: PathBuf,
}

impl WorkTree {
    fn new(base: &Path, id: &str) -> Self {
        let root = base.join(id);
        Self {
            downloads: base.join("downloads"),
            src: root.join("src"),
            build: root.join("build"),
            prefix: root.join("prefix"),
            logs: root.join("logs"),
            stamps: root.join("stamps"),
            tools: root.join("tools"),
            root,
        }
    }

    fn source_dir(&self, source: &Source) -> PathBuf {
        self.src.join(format!("{}-{}", source.name, source.version))
    }
}

#[derive(Serialize)]
struct Library {
    file: String,
    source: &'static str,
    licence: &'static str,
    bytes: u64,
    sha256: String,
    minos: String,
    links: Vec<String>,
}

/// What the set's id hashes, as the TypeScript's `JSON.stringify` wrote it.
#[derive(Serialize)]
struct Recipe {
    #[serde(rename = "RECIPE_REVISION")]
    revision: u32,
    #[serde(rename = "DEPLOYMENT_TARGET")]
    deployment_target: &'static str,
    #[serde(rename = "SOURCES")]
    sources: &'static [Source],
}

/// The set's id: mpv's and FFmpeg's versions, and a hash of everything that shapes the build.
pub fn set_id() -> String {
    let recipe = serde_json::to_string(&Recipe {
        revision: RECIPE_REVISION,
        deployment_target: DEPLOYMENT_TARGET,
        sources: SOURCES,
    })
    .expect("the recipe serialises");
    format!(
        "mpv-{}-ffmpeg-{}-lgpl-{}",
        source_by_name("mpv").version,
        source_by_name("ffmpeg").version,
        &sha256_text(&recipe)[..10]
    )
}

/// Runs `body` unless its stamp says it finished on an earlier run.
fn stamped(work: &WorkTree, step: &str, body: impl FnOnce() -> Result<()>) -> Result<()> {
    let stamp = work.stamps.join(step);
    if stamp.exists() {
        log(format!("    {step}: done on an earlier run"));
        return Ok(());
    }
    body()?;
    fs::create_dir_all(&work.stamps)?;
    fs::write(&stamp, format!("{}\n", support::iso_now()))?;
    Ok(())
}

fn fetch(work: &WorkTree, archive: &PinnedArchive) -> Result<PathBuf> {
    support::download(
        &work.downloads,
        &Download {
            urls: archive.urls,
            sha256: archive.sha256,
            file: archive.file,
            headers: &[],
        },
    )
}

/// A folder holding only the build tools the builds may run beyond the system's, so the builds'
/// `PATH` need not include Homebrew's folder and whatever else it holds.
fn link_tools(work: &WorkTree) -> Result<()> {
    support::link_tools(
        &work.tools,
        &[
            ("meson", find_on_path(&["meson"])?),
            ("ninja", find_on_path(&["ninja"])?),
            ("pkg-config", find_on_path(&["pkgconf", "pkg-config"])?),
        ],
    )
}

/// The environment every build runs in, built from nothing rather than from the caller's.
fn build_env(work: &WorkTree, sdk: &str) -> Vec<(String, OsString)> {
    let home = std::env::var_os("HOME").unwrap_or_default();
    let mut path = OsString::from(&work.tools);
    path.push(":/usr/bin:/bin:/usr/sbin:/sbin");
    let mut env = vec![
        ("HOME".to_owned(), home),
        ("PATH".to_owned(), path),
        ("TMPDIR".to_owned(), std::env::temp_dir().into_os_string()),
        ("LANG".to_owned(), "en_US.UTF-8".into()),
        (
            "MACOSX_DEPLOYMENT_TARGET".to_owned(),
            DEPLOYMENT_TARGET.into(),
        ),
        ("SDKROOT".to_owned(), sdk.into()),
        // Replaces pkg-config's search path: only the set's own libraries are found.
        (
            "PKG_CONFIG_LIBDIR".to_owned(),
            work.prefix.join("lib").join("pkgconfig").into(),
        ),
        // The sources are release archives, not checkouts, but the work tree sits inside the
        // latch-works checkout: without a ceiling, the `git describe` that libass's and
        // libplacebo's builds run finds that checkout and writes its commit into the libraries.
        // Git does not step up into the work tree's root, so it finds no repository at all.
        (
            "GIT_CEILING_DIRECTORIES".to_owned(),
            work.root.clone().into(),
        ),
        // ld64 hashes a library's debug map, object files' times included, into its LC_UUID;
        // this has it write those times as zero, so the UUID follows the content alone.
        ("ZERO_AR_DATE".to_owned(), "1".into()),
    ];
    if let Some(developer_dir) = std::env::var_os("DEVELOPER_DIR") {
        env.push(("DEVELOPER_DIR".to_owned(), developer_dir));
    }
    env
}

fn os_args(args: &[String]) -> Vec<OsString> {
    args.iter().map(OsString::from).collect()
}

fn build_source(
    work: &WorkTree,
    source: &Source,
    env: &[(String, OsString)],
    jobs: usize,
) -> Result<()> {
    log(format!(
        "\n{} {} ({})",
        source.name, source.version, source.licence
    ));
    let src = work.source_dir(source);
    let build = work.build.join(source.name);
    let log_file = |step: &str| work.logs.join(format!("{}-{step}.log", source.name));
    let meson = source.build_system == BuildSystem::Meson;

    stamped(work, &format!("{}.unpack", source.name), || {
        let archive = fetch(work, &source.archive)?;
        support::unpack(&archive, &src, 1, log_file("unpack"))?;
        for part in source.parts {
            let archive = fetch(work, &part.archive)?;
            support::unpack(
                &archive,
                &src.join(part.folder),
                1,
                work.logs
                    .join(format!("{}-{}-unpack.log", source.name, part.name)),
            )?;
        }
        Ok(())
    })?;

    stamped(work, &format!("{}.configure", source.name), || {
        if build.exists() {
            fs::remove_dir_all(&build)?;
        }
        fs::create_dir_all(&build)?;
        let prefix = format!("--prefix={}", work.prefix.display());
        let (program, args): (OsString, Vec<String>) = if meson {
            let mut args = vec![
                "setup".to_owned(),
                build.display().to_string(),
                src.display().to_string(),
                prefix,
                "--libdir=lib".to_owned(),
                "--buildtype=release".to_owned(),
                "--default-library=shared".to_owned(),
                "-Db_ndebug=true".to_owned(),
                // Never a subproject in place of a missing dependency, and never a download.
                "--wrap-mode=nofallback".to_owned(),
            ];
            args.extend(source.options.iter().map(|option| (*option).to_owned()));
            ("meson".into(), args)
        } else {
            let mut args = vec![
                prefix,
                "--install-name-dir=@rpath".to_owned(),
                "--pkg-config=pkg-config".to_owned(),
            ];
            args.extend(source.options.iter().map(|option| (*option).to_owned()));
            (src.join("configure").into(), args)
        };
        run(&Step {
            label: if meson { "meson setup" } else { "configure" }.to_owned(),
            program,
            args: os_args(&args),
            cwd: &build,
            env,
            log: log_file("configure"),
        })
    })?;

    stamped(work, &format!("{}.build", source.name), || {
        let jobs = format!("-j{jobs}");
        let args = if meson {
            vec!["-C".to_owned(), build.display().to_string(), jobs]
        } else {
            vec![jobs]
        };
        run(&Step {
            label: "build".to_owned(),
            program: if meson { "ninja" } else { "make" }.into(),
            args: os_args(&args),
            cwd: &build,
            env,
            log: log_file("build"),
        })
    })?;

    stamped(work, &format!("{}.install", source.name), || {
        let args = if meson {
            vec![
                "install".to_owned(),
                "-C".to_owned(),
                build.display().to_string(),
                "--no-rebuild".to_owned(),
            ]
        } else {
            vec!["install".to_owned()]
        };
        run(&Step {
            label: "install".to_owned(),
            program: if meson { "meson" } else { "make" }.into(),
            args: os_args(&args),
            cwd: &build,
            env,
            log: log_file("install"),
        })
    })
}

/// The set's file a link names, or `None` for a system library; anything else stops the build.
fn member_of(work: &WorkTree, link: &str) -> Result<Option<String>> {
    if is_system(link) {
        return Ok(None);
    }
    let prefix = format!("{}/", work.prefix.display());
    if link.starts_with("@rpath/") || link.starts_with(&prefix) {
        return Ok(Some(file_name_of(link)));
    }
    bail!("a library links {link}, which is neither the set's nor the system's")
}

fn file_name_of(link: &str) -> String {
    Path::new(link)
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| link.to_owned())
}

/// Copies libmpv and every library it needs from the staging prefix into `out`, names each
/// `@rpath/<file>` with `@loader_path` as its only rpath, strips local symbols and signs ad hoc.
fn assemble(work: &WorkTree, out: &Path) -> Result<Vec<Library>> {
    let lib = work.prefix.join("lib");
    let mut members: Vec<String> = Vec::new();
    let mut queue = vec![LIBMPV_FILE.to_owned()];

    while !queue.is_empty() {
        let file = queue.remove(0);
        if members.contains(&file) {
            continue;
        }
        for link in read_macho(&lib.join(&file))?.links {
            if let Some(member) = member_of(work, &link)?
                && member != file
            {
                queue.push(member);
            }
        }
        members.push(file);
    }

    log(format!(
        "\nAssembling {} libraries into {}",
        members.len(),
        out.display()
    ));
    if out.exists() {
        fs::remove_dir_all(out)?;
    }
    fs::create_dir_all(out)?;

    for file in &members {
        let target = out.join(file);
        fs::copy(fs::canonicalize(lib.join(file))?, &target)?;
        make_executable(&target)?;
        capture("/usr/bin/strip", &["-x".as_ref(), target.as_os_str()])?;
        let mut relink = Vec::new();
        for link in read_macho(&target)?.links {
            if let Some(member) = member_of(work, &link)? {
                relink.push((link, member));
            }
        }
        // The builds leave rpaths to their own folders and Xcode's Swift libraries; the set
        // needs only its own folder, wherever it is copied.
        support::relocate(&target, file, &relink)?;
    }

    let mut libraries = Vec::new();
    for file in &members {
        let target = out.join(file);
        let macho = read_macho(&target)?;
        let mut problems = support::set_member_problems(&macho, file, &members);
        let minos = macho.minos.clone();
        if minos
            .as_deref()
            .is_none_or(|minos| compare_versions(minos, DEPLOYMENT_TARGET).is_gt())
        {
            problems.push(format!(
                "it needs macOS {minos:?}, above {DEPLOYMENT_TARGET}"
            ));
        }
        if !problems.is_empty() {
            bail!("{file} is not fit for the set: {}", problems.join("; "));
        }
        let source = source_of_library(file)
            .with_context(|| format!("no libmpv source is known to make {file}"))?;
        libraries.push(Library {
            file: file.clone(),
            source: source.name,
            licence: source.licence,
            bytes: fs::metadata(&target)?.len(),
            sha256: sha256_file(&target)?,
            minos: minos.unwrap_or_default(),
            links: links_but_self(&macho, file),
        });
    }

    Ok(libraries)
}

fn links_but_self(macho: &MachO, file: &str) -> Vec<String> {
    let own = format!("@rpath/{file}");
    macho
        .links
        .iter()
        .filter(|link| **link != own)
        .cloned()
        .collect()
}

fn make_executable(path: &Path) -> Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        fs::set_permissions(path, fs::Permissions::from_mode(0o755))?;
    }
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}

/// One thing the set must say about itself.
struct Expectation {
    key: String,
    holds: Box<dyn Fn(&str) -> bool>,
    wanted: &'static str,
}

impl Expectation {
    fn new(key: &str, wanted: &'static str, holds: impl Fn(&str) -> bool + 'static) -> Self {
        Self {
            key: key.to_owned(),
            holds: Box::new(holds),
            wanted,
        }
    }
}

/// Whether FFmpeg's configuration turns on a licence the set must not have: `--enable-gpl`,
/// `--enable-nonfree` or `--enable-version3`, each as a whole word.
fn enables_non_lgpl(configuration: &str) -> bool {
    ["gpl", "nonfree", "version3"].iter().any(|flag| {
        let needle = format!("--enable-{flag}");
        configuration.match_indices(&needle).any(|(at, _)| {
            configuration[at + needle.len()..]
                .chars()
                .next()
                .is_none_or(|next| !(next.is_ascii_alphanumeric() || next == '_'))
        })
    })
}

/// Builds and runs `check-libmpv.c` against the assembled set, and refuses a set that is not
/// LGPL.
fn check_set(work: &WorkTree, out: &Path, env: &[(String, OsString)]) -> Result<Pairs> {
    log("\nChecking what the set says about itself");
    let program = work.root.join("check-libmpv");
    let source = work.root.join("check-libmpv.c");
    fs::write(&source, CHECK_PROGRAM)?;
    let mut linked: Vec<String> = fs::read_dir(out)?
        .filter_map(|entry| entry.ok()?.file_name().into_string().ok())
        .filter(|file| file.ends_with(".dylib"))
        .collect();
    linked.sort();
    let mut args: Vec<OsString> = vec![
        source.into(),
        "-o".into(),
        program.clone().into(),
        format!("-I{}", work.prefix.join("include").display()).into(),
    ];
    args.extend(linked.iter().map(|file| out.join(file).into_os_string()));
    args.push(format!("-Wl,-rpath,{}", out.display()).into());
    run(&Step {
        label: "compile check-libmpv.c".to_owned(),
        program: "/usr/bin/clang".into(),
        args,
        cwd: &work.root,
        env,
        log: work.logs.join("check-compile.log"),
    })?;

    let mut report = Pairs::default();
    for line in capture(&program, &[])?.split('\n') {
        if let Some(tab) = line.find('\t')
            && tab > 0
        {
            report.set(&line[..tab], line[tab + 1..].to_owned());
        }
    }

    let features: Vec<String> = report
        .get("mpv_features")
        .unwrap_or_default()
        .split(' ')
        .map(str::to_owned)
        .collect();

    let mut expectations: Vec<Expectation> = [
        "avutil",
        "avcodec",
        "avformat",
        "avfilter",
        "swscale",
        "swresample",
    ]
    .iter()
    .map(|library| Expectation::new(&format!("{library}_license"), LGPL, |value| value == LGPL))
    .collect();
    expectations.push(Expectation::new(
        "ffmpeg_configuration",
        "no --enable-gpl, --enable-nonfree or --enable-version3",
        |value| !enables_non_lgpl(value),
    ));
    expectations.push(Expectation::new(
        "mpv_client_api_version",
        "2.5, the API the player's FFI follows",
        |value| value == "2.5",
    ));
    expectations.push(Expectation::new(
        "mpv-configuration",
        "-Dgpl=false",
        |value| value.contains("-Dgpl=false"),
    ));
    expectations.push(Expectation::new(
        "mpv_features",
        "videotoolbox-gl and not gpl",
        move |_| {
            !features.iter().any(|feature| feature == "gpl")
                && features.iter().any(|feature| feature == "videotoolbox-gl")
        },
    ));
    for codec in ["h264", "hevc", "av1", "vp9"] {
        expectations.push(Expectation::new(
            &format!("decoder.{codec}"),
            "decoding through VideoToolbox",
            |value| value == "videotoolbox",
        ));
    }
    expectations.push(Expectation::new(
        "decoder.libdav1d",
        "dav1d, for AV1 in software",
        |value| value == "software",
    ));
    for (key, _) in &report.0 {
        if key.starts_with("demuxer.") {
            expectations.push(Expectation::new(key, "present", |value| value == "present"));
        }
    }
    expectations.push(Expectation::new(
        "encoder.h264",
        "missing: a player's set has no encoders",
        |value| value == "missing",
    ));

    let failures: Vec<String> = expectations
        .iter()
        .filter_map(|expectation| {
            let value = report.get(&expectation.key).unwrap_or("(missing)");
            (!(expectation.holds)(value)).then(|| {
                format!(
                    "{} is \"{value}\", expected {}",
                    expectation.key, expectation.wanted
                )
            })
        })
        .collect();
    if !failures.is_empty() {
        bail!("the set failed its checks:\n  {}", failures.join("\n  "));
    }

    for key in [
        "avcodec_license",
        "mpv_client_api_version",
        "mpv-version",
        "ffmpeg-version",
    ] {
        log(format!(
            "    {key}: {}",
            report.get(key).unwrap_or("undefined")
        ));
    }
    log(format!(
        "    mpv features: {}",
        report.get("mpv_features").unwrap_or("undefined")
    ));

    Ok(report)
}

/// Copies each shipped source's licence files into `out/licenses/<source>/`.
fn copy_licences(work: &WorkTree, out: &Path) -> Result<()> {
    for source in SOURCES {
        let from = work.source_dir(source);
        let mut entries: Vec<(String, PathBuf)> = source
            .licence_files
            .iter()
            .map(|file| (source.name.to_owned(), from.join(file)))
            .collect();
        for part in source.parts.iter().filter(|part| part.ships) {
            entries.extend(part.licence_files.iter().map(|file| {
                (
                    format!("{}-{}", source.name, part.name),
                    from.join(part.folder).join(file),
                )
            }));
        }
        for (name, file) in entries {
            let folder = out.join("licenses").join(name);
            fs::create_dir_all(&folder)?;
            let target = folder.join(file.file_name().context("a licence file has no name")?);
            fs::copy(&file, &target).with_context(|| format!("copying {}", file.display()))?;
        }
    }
    Ok(())
}

fn first_line(text: &str) -> String {
    text.split('\n')
        .next()
        .unwrap_or_default()
        .trim()
        .to_owned()
}

fn toolchain() -> Result<Pairs> {
    let version = |program: &Path| -> Result<String> {
        Ok(first_line(&capture(program, &["--version".as_ref()])?))
    };
    let mut pairs = Pairs::default();
    pairs.set(
        "clang",
        first_line(&capture("/usr/bin/clang", &["--version".as_ref()])?),
    );
    pairs.set(
        "swiftc",
        first_line(&capture(
            "/usr/bin/xcrun",
            &["swiftc".as_ref(), "--version".as_ref()],
        )?),
    );
    pairs.set(
        "sdk",
        first_line(&capture(
            "/usr/bin/xcrun",
            &["--show-sdk-version".as_ref()],
        )?),
    );
    pairs.set("meson", version(&find_on_path(&["meson"])?)?);
    pairs.set("ninja", version(&find_on_path(&["ninja"])?)?);
    pairs.set(
        "pkgconf",
        version(&find_on_path(&["pkgconf", "pkg-config"])?)?,
    );
    Ok(pairs)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ManifestPart {
    name: &'static str,
    folder: &'static str,
    urls: &'static [&'static str],
    sha256: &'static str,
    licence: &'static str,
    ships: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ManifestSource {
    name: &'static str,
    version: &'static str,
    urls: &'static [&'static str],
    sha256: &'static str,
    hash_checked_against: &'static str,
    licence: &'static str,
    build_system: BuildSystem,
    options: &'static [&'static str],
    parts: Vec<ManifestPart>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Manifest<'a> {
    id: &'a str,
    built_at: String,
    run_seconds: u64,
    platform: &'static str,
    deployment_target: &'static str,
    licence: &'static str,
    toolchain: Pairs,
    total_bytes: u64,
    libraries: &'a [Library],
    sources: Vec<ManifestSource>,
    reported: &'a Pairs,
}

fn write_manifest(
    set: &LibmpvSet,
    libraries: &[Library],
    report: &Pairs,
    seconds: f64,
) -> Result<()> {
    let manifest = Manifest {
        id: &set.id,
        built_at: support::iso_now(),
        run_seconds: seconds.round() as u64,
        platform: "darwin-arm64",
        deployment_target: DEPLOYMENT_TARGET,
        licence: "LGPL-2.1-or-later as a whole: mpv, FFmpeg, libplacebo and FriBidi are LGPL; \
                  libass, FreeType, HarfBuzz and dav1d are permissive. Sources and flags are \
                  below.",
        toolchain: toolchain()?,
        total_bytes: libraries.iter().map(|library| library.bytes).sum(),
        libraries,
        sources: SOURCES
            .iter()
            .map(|source| ManifestSource {
                name: source.name,
                version: source.version,
                urls: source.archive.urls,
                sha256: source.archive.sha256,
                hash_checked_against: source.hash_checked_against,
                licence: source.licence,
                build_system: source.build_system,
                options: source.options,
                parts: source
                    .parts
                    .iter()
                    .map(|part| ManifestPart {
                        name: part.name,
                        folder: part.folder,
                        urls: part.archive.urls,
                        sha256: part.archive.sha256,
                        licence: part.licence,
                        ships: part.ships,
                    })
                    .collect(),
            })
            .collect(),
        reported: report,
    };

    fs::write(set.folder.join("manifest.json"), format_json(&manifest)?)?;
    let sums: String = libraries
        .iter()
        .map(|library| format!("{}  {}\n", library.sha256, library.file))
        .collect();
    fs::write(set.folder.join(CHECKSUMS_FILE), sums)?;
    Ok(())
}

/// Whether `folder` holds a whole set whose files still hash to what was recorded, with
/// `entry` among them.
pub fn is_intact(folder: &Path, entry: &str) -> bool {
    if !folder.join("manifest.json").is_file() {
        return false;
    }
    let Ok(sums) = fs::read_to_string(folder.join(CHECKSUMS_FILE)) else {
        return false;
    };
    let lines: Vec<&str> = sums.split('\n').filter(|line| !line.is_empty()).collect();
    for line in &lines {
        let Some((sha256, file)) = line.split_once("  ") else {
            return false;
        };
        let well_formed = sha256.len() == 64
            && sha256
                .chars()
                .all(|c| c.is_ascii_digit() || ('a'..='f').contains(&c))
            && !file.is_empty()
            && !file.chars().any(char::is_whitespace);
        if !well_formed {
            return false;
        }
        let target = folder.join(file);
        if !target.is_file() || sha256_file(&target).ok().as_deref() != Some(sha256) {
            return false;
        }
    }
    lines
        .iter()
        .any(|line| line.ends_with(&format!("  {entry}")))
}

/// Makes sure the pinned set is built and intact, building it when it is not, and returns it.
/// The bundle calls this; it is quick once the set exists.
pub fn ensure_libmpv(options: &BuildOptions) -> Result<LibmpvSet> {
    let id = set_id();
    let folder = options.out.join(&id);

    if is_intact(&folder, LIBMPV_FILE) {
        log(format!(
            "The LGPL libmpv set {id} is built: {}",
            folder.display()
        ));
        support::point_current_at(&options.out, &id)?;
        return Ok(LibmpvSet { id, folder });
    }

    if !support::is_mac_arm64() {
        bail!("the LGPL libmpv set is built on macOS arm64 only");
    }

    let started = Instant::now();
    let work = WorkTree::new(&options.work, &id);
    log(format!("Building the LGPL libmpv set {id}"));
    log(format!(
        "  work tree: {} (resumable; safe to delete once the set is built)",
        work.root.display()
    ));
    log(format!(
        "  jobs: {}, macOS {DEPLOYMENT_TARGET} and later",
        options.jobs
    ));
    fs::create_dir_all(&work.root)?;
    link_tools(&work)?;
    let sdk = capture("/usr/bin/xcrun", &["--show-sdk-path".as_ref()])?
        .trim()
        .to_owned();
    let env = build_env(&work, &sdk);

    for source in SOURCES {
        build_source(&work, source, &env, options.jobs)?;
    }

    let partial = options.out.join(format!("{id}.partial"));
    let libraries = assemble(&work, &partial)?;
    let report = check_set(&work, &partial, &env)?;
    copy_licences(&work, &partial)?;
    let seconds = started.elapsed().as_secs_f64();
    write_manifest(
        &LibmpvSet {
            id: id.clone(),
            folder: partial.clone(),
        },
        &libraries,
        &report,
        seconds,
    )?;
    if folder.exists() {
        fs::remove_dir_all(&folder)?;
    }
    fs::rename(&partial, &folder)?;
    support::point_current_at(&options.out, &id)?;

    log(format!(
        "\nThe LGPL libmpv set {id} is built in {} s: {}",
        seconds.round(),
        folder.display()
    ));
    for library in &libraries {
        log(format!(
            "  {:<28} {:>9}  {}",
            library.file,
            megabytes(library.bytes),
            library.licence
        ));
    }
    log(format!(
        "  total {}, licences and manifest included",
        megabytes(support::folder_bytes(&folder)?)
    ));

    if options.keep_work {
        log(format!("  the work tree stays in {}", work.root.display()));
    } else {
        fs::remove_dir_all(&work.root)?;
        log(format!(
            "  removed the work tree; the downloads stay in {}",
            work.downloads.display()
        ));
    }

    Ok(LibmpvSet { id, folder })
}

/// `libmpv [--jobs N] [--work <dir>] [--out <dir>] [--keep-work]`.
pub fn command(args: &[String]) -> Result<()> {
    let mut options = BuildOptions::default();
    let current = std::env::current_dir()?;
    let mut args = args.iter();
    while let Some(flag) = args.next() {
        let mut value = || {
            args.next()
                .with_context(|| format!("{flag} needs a value"))
                .cloned()
        };
        match flag.as_str() {
            "--jobs" => options.jobs = value()?.parse::<usize>().unwrap_or(1).max(1),
            "--work" => options.work = current.join(value()?),
            "--out" => options.out = current.join(value()?),
            "--keep-work" => options.keep_work = true,
            other => bail!("libmpv: unknown option {other}"),
        }
    }
    ensure_libmpv(&options)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The id hashes the recipe as the TypeScript this was ported from did (revision 1 gave
    /// `adabfe19d7` in both), so a change to how it is hashed shows here rather than as a second
    /// copy of the same set. Revision 2 is the first the TypeScript never built.
    #[test]
    fn the_id_hashes_the_recipe_as_the_typescript_did() {
        assert_eq!(set_id(), "mpv-0.41.0-ffmpeg-9.0.2-lgpl-83e766fd1f");
    }

    #[test]
    fn only_whole_licence_flags_count() {
        assert!(enables_non_lgpl("--prefix=/x --enable-gpl --enable-shared"));
        assert!(enables_non_lgpl("--enable-version3"));
        assert!(!enables_non_lgpl("--enable-gplv3ish_name"));
        assert!(!enables_non_lgpl("--disable-gpl --enable-shared"));
    }

    #[test]
    fn every_source_with_a_library_is_known() {
        for (file, source) in [
            ("libmpv.2.dylib", "mpv"),
            ("libavcodec.63.dylib", "ffmpeg"),
            ("libdav1d.7.dylib", "dav1d"),
        ] {
            assert_eq!(
                source_of_library(file).map(|found| found.name),
                Some(source)
            );
        }
        assert!(source_of_library("libunknown.1.dylib").is_none());
    }
}
