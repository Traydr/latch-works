//! Fetches the prebuilt native libraries in [`pins`] into `apps/oriel-rs/.vendor/<name>/<id>/`,
//! git-ignored, with `.vendor/<name>/current` pointing at the newest:
//!
//! ```text
//! cargo run -p xtask -- vendor [libvips] [libavif]
//! ```
//!
//! Each package must hash to its pin before it is unpacked. A set holds its dylibs, the licence
//! files its packages carry, `manifest.json` (versions, URLs, hashes, licences, each library's
//! links and minimum macOS) and `SHA256SUMS`, which a later run and the bundle check the files
//! against. A relocated set's libraries are renamed `@rpath/<file>` and find each other through
//! `@loader_path`, so nothing in it names Homebrew's prefix; the command refuses a set where
//! anything still does.

pub mod pins;

use std::fs;
use std::path::{Path, PathBuf};
use std::time::Instant;

use anyhow::{Context as _, Result, bail};
use serde::Serialize;

use crate::libmpv::is_intact;
use crate::support::{
    self, Download, Step, compare_versions, format_json, is_system, log, megabytes, read_macho,
    sha256_file, sha256_text,
};
use pins::{Layout, Package, SETS, VENDOR_REVISION, VendorSet};

const CHECKSUMS_FILE: &str = "SHA256SUMS";

/// `apps/oriel-rs/.vendor`, one folder per set name.
pub fn vendor_root() -> PathBuf {
    support::workspace().join(".vendor")
}

/// A fetched set: which one, its id and its folder.
pub struct Vendored {
    pub set: &'static VendorSet,
    pub id: String,
    pub folder: PathBuf,
}

impl Vendored {
    /// The folder the set's dylibs are in.
    pub fn library_folder(&self) -> PathBuf {
        match self.set.layout {
            Layout::PackageLib => self.folder.join("lib"),
            Layout::Relocated => self.folder.clone(),
        }
    }
}

/// The entry library's path inside the set, as `SHA256SUMS` names it.
fn entry_path(set: &VendorSet) -> String {
    match set.layout {
        Layout::PackageLib => format!("lib/{}", set.entry),
        Layout::Relocated => set.entry.to_owned(),
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RecipePackage {
    name: &'static str,
    version: &'static str,
    sha256: &'static str,
    strip: u32,
    libraries: &'static [&'static str],
    licence_files: &'static [&'static str],
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Recipe {
    revision: u32,
    relocated: bool,
    entry: &'static str,
    include: &'static [&'static str],
    packages: Vec<RecipePackage>,
    notices: Vec<(&'static str, &'static str)>,
}

/// The set's id: its label and a hash of everything that shapes it. URLs are left out: the
/// hashes say what was fetched.
fn set_id(set: &VendorSet) -> String {
    let recipe = Recipe {
        revision: VENDOR_REVISION,
        relocated: set.layout == Layout::Relocated,
        entry: set.entry,
        include: set.include,
        packages: set
            .packages
            .iter()
            .map(|package| RecipePackage {
                name: package.name,
                version: package.version,
                sha256: package.sha256,
                strip: package.strip,
                libraries: package.libraries,
                licence_files: package.licence_files,
            })
            .collect(),
        notices: set
            .notices
            .iter()
            .map(|notice| (notice.sha256, notice.member))
            .collect(),
    };
    let text = serde_json::to_string(&recipe).expect("the recipe serialises");
    format!("{}-{}", set.label, &sha256_text(&text)[..10])
}

#[derive(Serialize)]
struct Library {
    file: String,
    package: &'static str,
    licence: &'static str,
    bytes: u64,
    sha256: String,
    minos: String,
    links: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ManifestPackage {
    name: &'static str,
    version: &'static str,
    url: &'static str,
    sha256: &'static str,
    hash_checked_against: &'static str,
    licence: &'static str,
    licence_files: &'static [&'static str],
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ManifestNotice {
    package: &'static str,
    url: &'static str,
    sha256: &'static str,
    hash_checked_against: &'static str,
    member: &'static str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Manifest<'a> {
    id: &'a str,
    name: &'static str,
    fetched_at: String,
    platform: &'static str,
    minimum_macos: String,
    licence: &'static str,
    entry: String,
    total_bytes: u64,
    libraries: &'a [Library],
    packages: Vec<ManifestPackage>,
    notices: Vec<ManifestNotice>,
}

/// The package that provides `file`.
fn package_of(set: &'static VendorSet, file: &str) -> Result<&'static Package> {
    set.packages
        .iter()
        .find(|package| package.libraries.contains(&file))
        .with_context(|| format!("no package pinned for {} provides {file}", set.name))
}

/// The set's file a link names, or `None` for a system library. Bottles name their libraries
/// under Homebrew's placeholders, which `brew` rewrites when it installs them.
fn member_of(set: &'static VendorSet, link: &str) -> Result<Option<String>> {
    if is_system(link) {
        return Ok(None);
    }
    let known = ["@rpath/", "@@HOMEBREW_PREFIX@@/", "@@HOMEBREW_CELLAR@@/"];
    if !known.iter().any(|prefix| link.starts_with(prefix)) {
        bail!(
            "a {} library links {link}, which is neither the set's nor the system's",
            set.name
        );
    }
    let file = Path::new(link)
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .with_context(|| format!("{link} names no file"))?;
    package_of(set, &file)?;
    Ok(Some(file))
}

fn record(set: &'static VendorSet, path: &Path, file: &str, members: &[String]) -> Result<Library> {
    let macho = read_macho(path)?;
    let mut problems = support::set_member_problems(&macho, file, members);
    // sharp's dylib keeps its own rpaths; only the relocated sets are given `@loader_path`.
    if set.layout == Layout::PackageLib {
        problems.retain(|problem| !problem.starts_with("its rpaths"));
    }
    for link in macho.links.iter().chain(&macho.rpaths) {
        if link.contains("/opt/homebrew") || link.contains("@@HOMEBREW") {
            problems.push(format!("it still names {link}"));
        }
    }
    if !problems.is_empty() {
        bail!(
            "{file} is not fit for the {} set: {}",
            set.name,
            problems.join("; ")
        );
    }
    let package = package_of(set, file)?;
    let own = format!("@rpath/{file}");
    Ok(Library {
        file: file.to_owned(),
        package: package.name,
        licence: package.licence,
        bytes: fs::metadata(path)?.len(),
        sha256: sha256_file(path)?,
        minos: macho.minos.unwrap_or_default(),
        links: macho
            .links
            .into_iter()
            .filter(|link| *link != own)
            .collect(),
    })
}

/// Copies the entry library and every library it needs out of the unpacked bottles, renamed
/// `@rpath/<file>` with `@loader_path` as their only rpath, and signs each ad hoc again.
fn assemble_relocated(
    set: &'static VendorSet,
    unpacked: &Path,
    out: &Path,
) -> Result<Vec<Library>> {
    let source = |file: &str| -> Result<PathBuf> {
        let package = package_of(set, file)?;
        let path = unpacked.join(package.name).join("lib").join(file);
        fs::canonicalize(&path).with_context(|| format!("{} holds no {file}", package.name))
    };

    let mut members: Vec<String> = Vec::new();
    let mut queue = vec![set.entry.to_owned()];
    while !queue.is_empty() {
        let file = queue.remove(0);
        if members.contains(&file) {
            continue;
        }
        for link in read_macho(&source(&file)?)?.links {
            if let Some(member) = member_of(set, &link)?
                && member != file
            {
                queue.push(member);
            }
        }
        members.push(file);
    }

    for file in &members {
        let target = out.join(file);
        fs::copy(source(file)?, &target)?;
        set_mode(&target, 0o755)?;
        let mut relink = Vec::new();
        for link in read_macho(&target)?.links {
            if let Some(member) = member_of(set, &link)? {
                relink.push((link, member));
            }
        }
        support::relocate(&target, file, &relink)?;
    }

    members
        .iter()
        .map(|file| record(set, &out.join(file), file, &members))
        .collect()
}

/// Copies the package's `lib/` as it is, and checks its libraries need only each other and the
/// system.
fn assemble_package_lib(
    set: &'static VendorSet,
    unpacked: &Path,
    out: &Path,
) -> Result<Vec<Library>> {
    let package = &set.packages[0];
    support::copy_tree(&unpacked.join(package.name).join("lib"), &out.join("lib"))?;
    let members: Vec<String> = package
        .libraries
        .iter()
        .map(|file| (*file).to_owned())
        .collect();
    members
        .iter()
        .map(|file| record(set, &out.join("lib").join(file), file, &members))
        .collect()
}

fn set_mode(path: &Path, mode: u32) -> Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        fs::set_permissions(path, fs::Permissions::from_mode(mode))?;
    }
    #[cfg(not(unix))]
    let _ = (path, mode);
    Ok(())
}

fn copy_licences(set: &'static VendorSet, unpacked: &Path, out: &Path) -> Result<()> {
    for package in set.packages {
        let folder = out.join("licenses").join(package.name);
        fs::create_dir_all(&folder)?;
        for file in package.licence_files {
            let from = unpacked.join(package.name).join(file);
            let name = Path::new(file)
                .file_name()
                .context("a licence file has no name")?;
            fs::copy(&from, folder.join(name))
                .with_context(|| format!("copying {}", from.display()))?;
        }
    }
    for notice in set.notices {
        let from = unpacked.join("notices").join(notice.member);
        let name = Path::new(notice.member)
            .file_name()
            .context("a notice has no name")?;
        let folder = out.join("licenses").join(notice.package);
        fs::create_dir_all(&folder)?;
        fs::copy(&from, folder.join(name))
            .with_context(|| format!("copying {}", from.display()))?;
    }
    Ok(())
}

/// Makes sure the pinned set is fetched and intact, fetching it when it is not, and returns it.
/// The bundle calls this; it is quick once the set exists.
pub fn ensure(set: &'static VendorSet) -> Result<Vendored> {
    let id = set_id(set);
    let root = vendor_root().join(set.name);
    let folder = root.join(&id);

    if is_intact(&folder, &entry_path(set)) {
        log(format!(
            "The {} set {id} is in place: {}",
            set.name,
            folder.display()
        ));
        support::point_current_at(&root, &id)?;
        return Ok(Vendored { set, id, folder });
    }
    if !support::is_mac_arm64() {
        bail!("the vendored libraries are for macOS arm64 only");
    }

    let started = Instant::now();
    log(format!("Fetching the {} set {id}", set.name));
    let workspace = support::workspace();
    let downloads = workspace.join("target").join("vendor").join("downloads");
    let work = workspace.join("target").join("vendor").join(&id);
    if work.exists() {
        fs::remove_dir_all(&work)?;
    }
    let logs = work.join("logs");

    for package in set.packages {
        log(format!(
            "  {} {} ({})",
            package.name, package.version, package.licence
        ));
        let archive = support::download(
            &downloads,
            &Download {
                urls: &[package.url],
                sha256: package.sha256,
                file: package.file,
                headers: package.headers,
            },
        )?;
        support::unpack(
            &archive,
            &work.join(package.name),
            package.strip,
            logs.join(format!("{}-unpack.log", package.name)),
        )?;
    }
    for notice in set.notices {
        log(format!("  {}'s {}", notice.package, notice.member));
        let archive = support::download(
            &downloads,
            &Download {
                urls: &[notice.url],
                sha256: notice.sha256,
                file: notice.file,
                headers: &[],
            },
        )?;
        let folder = work.join("notices");
        fs::create_dir_all(&folder)?;
        support::run(&Step {
            label: format!("unpack {}", notice.member),
            program: "/usr/bin/tar".into(),
            args: vec![
                "-xf".into(),
                archive.into(),
                "-C".into(),
                folder.clone().into(),
                notice.member.into(),
            ],
            cwd: &folder,
            env: &[("PATH".into(), "/usr/bin:/bin".into())],
            log: logs.join("notices-unpack.log"),
        })?;
    }

    let partial = root.join(format!("{id}.partial"));
    if partial.exists() {
        fs::remove_dir_all(&partial)?;
    }
    fs::create_dir_all(&partial)?;
    let libraries = match set.layout {
        Layout::PackageLib => assemble_package_lib(set, &work, &partial)?,
        Layout::Relocated => assemble_relocated(set, &work, &partial)?,
    };
    let entry_package = package_of(set, set.entry)?;
    for include in set.include {
        support::copy_tree(
            &work.join(entry_package.name).join(include),
            &partial.join(include),
        )?;
    }
    copy_licences(set, &work, &partial)?;

    let minimum_macos = libraries
        .iter()
        .map(|library| library.minos.as_str())
        .max_by(|a, b| compare_versions(a, b))
        .unwrap_or_default()
        .to_owned();
    let manifest = Manifest {
        id: &id,
        name: set.name,
        fetched_at: support::iso_now(),
        platform: "darwin-arm64",
        minimum_macos: minimum_macos.clone(),
        licence: set.licence,
        entry: entry_path(set),
        total_bytes: libraries.iter().map(|library| library.bytes).sum(),
        libraries: &libraries,
        packages: set
            .packages
            .iter()
            .map(|package| ManifestPackage {
                name: package.name,
                version: package.version,
                url: package.url,
                sha256: package.sha256,
                hash_checked_against: package.hash_checked_against,
                licence: package.licence,
                licence_files: package.licence_files,
            })
            .collect(),
        notices: set
            .notices
            .iter()
            .map(|notice| ManifestNotice {
                package: notice.package,
                url: notice.url,
                sha256: notice.sha256,
                hash_checked_against: notice.hash_checked_against,
                member: notice.member,
            })
            .collect(),
    };
    fs::write(partial.join("manifest.json"), format_json(&manifest)?)?;
    let prefix = match set.layout {
        Layout::PackageLib => "lib/",
        Layout::Relocated => "",
    };
    let sums: String = libraries
        .iter()
        .map(|library| format!("{}  {prefix}{}\n", library.sha256, library.file))
        .collect();
    fs::write(partial.join(CHECKSUMS_FILE), sums)?;

    if folder.exists() {
        fs::remove_dir_all(&folder)?;
    }
    fs::rename(&partial, &folder)?;
    support::point_current_at(&root, &id)?;
    fs::remove_dir_all(&work)?;

    log(format!(
        "The {} set {id} is in place in {:.1} s: {}",
        set.name,
        started.elapsed().as_secs_f64(),
        folder.display()
    ));
    for library in &libraries {
        log(format!(
            "  {:<28} {:>9}  {}, macOS {} and later",
            library.file,
            megabytes(library.bytes),
            library.licence,
            library.minos
        ));
    }
    log(format!(
        "  total {}, licences and manifest included; macOS {minimum_macos} and later",
        megabytes(support::folder_bytes(&folder)?)
    ));
    Ok(Vendored { set, id, folder })
}

/// `vendor [libvips] [libavif]`: the named sets, or all of them.
pub fn command(args: &[String]) -> Result<()> {
    let chosen: Vec<&'static VendorSet> = if args.is_empty() {
        SETS.to_vec()
    } else {
        args.iter()
            .map(|name| {
                SETS.iter()
                    .copied()
                    .find(|set| set.name == name)
                    .with_context(|| format!("vendor: no set named {name}; try libvips or libavif"))
            })
            .collect::<Result<_>>()?
    };
    for (index, set) in chosen.iter().enumerate() {
        if index > 0 {
            log("");
        }
        ensure(set)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bottle_placeholders_and_rpaths_name_set_members() {
        assert_eq!(
            member_of(
                &pins::LIBAVIF,
                "@@HOMEBREW_PREFIX@@/opt/aom/lib/libaom.3.dylib"
            )
            .unwrap(),
            Some("libaom.3.dylib".to_owned())
        );
        assert_eq!(
            member_of(&pins::LIBAVIF, "/usr/lib/libSystem.B.dylib").unwrap(),
            None
        );
        assert!(member_of(&pins::LIBAVIF, "/opt/homebrew/opt/aom/lib/libaom.3.dylib").is_err());
        assert!(member_of(&pins::LIBAVIF, "@rpath/libjxl.0.dylib").is_err());
    }

    #[test]
    fn each_set_has_its_own_id() {
        let ids: Vec<String> = SETS.iter().map(|set| set_id(set)).collect();
        assert!(ids[0].starts_with("vips-8.18.7-sharp-1.3.4-"), "{}", ids[0]);
        assert!(ids[1].starts_with("avif-1.4.2-aom-3.15.2-"), "{}", ids[1]);
    }
}
