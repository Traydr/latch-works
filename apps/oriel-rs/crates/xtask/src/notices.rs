//! The licence notices `Oriel RS.app` carries in `Contents/Resources/licenses/`, beside the ones
//! each library set brings (`libmpv/`, `libvips/`, `libavif/`):
//!
//! - `oriel-rs/`: the repository's own licence, which Oriel RS is under;
//! - `media-tools/`: ffmpeg and ffprobe. They are Martin Riedl's static builds, configured with
//!   `--enable-gpl --enable-version3`, so GPL-3.0-or-later: the GPL's text and FFmpeg's
//!   `LICENSE.md`, from the FFmpeg 9.0.2 source release the libmpv set is built from (the same
//!   pinned, hash-checked tarball), and a notice saying what the two programs are, how they were
//!   fetched, how they were configured, and where their corresponding source is. They run as
//!   separate programs, so their licence does not reach Oriel RS's own code;
//! - `rust-crates/`: every crate compiled into the app, with the licence files its package
//!   carries, listed in `README.txt` with its licence expression, from `cargo metadata`;
//! - `index.json`: one entry per folder, which the app's About dialog lists.

use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{Context as _, Result, bail};
use serde::Serialize;
use serde_json::Value;

use crate::libmpv::{self, sources::source_by_name};
use crate::support::{self, Download, capture, log};

/// The target the app is built for, whose dependencies the bundle carries.
const TARGET: &str = "aarch64-apple-darwin";

/// Where Martin Riedl publishes the scripts his ffmpeg builds are made with.
const MEDIA_TOOLS_BUILD_SCRIPT: &str = "https://git.martin-riedl.de/ffmpeg/build-script";

/// One folder of notices, as `index.json` lists it for the About dialog.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Notice {
    /// The folder under `licenses/`.
    pub folder: String,
    pub name: String,
    /// The version or set id.
    pub version: String,
    /// An SPDX expression, or a short phrase where there are many.
    pub licence: String,
}

#[derive(Serialize)]
struct Index<'a> {
    app: &'a str,
    version: &'a str,
    notices: &'a [Notice],
}

/// Writes `licenses/index.json`.
pub fn write_index(licenses: &Path, version: &str, notices: &[Notice]) -> Result<()> {
    let index = Index {
        app: "Oriel RS",
        version,
        notices,
    };
    fs::write(
        licenses.join("index.json"),
        format!("{}\n", support::format_json(&index)?),
    )?;
    Ok(())
}

/// The licence a set's manifest names for the whole set: `LGPL-2.1-or-later as a whole: …` reads
/// `LGPL-2.1-or-later`.
pub fn set_licence(manifest: &Path) -> Result<String> {
    let manifest: Value = serde_json::from_str(&fs::read_to_string(manifest)?)?;
    let licence = manifest["licence"]
        .as_str()
        .context("the set's manifest names no licence")?;
    Ok(short_licence(licence).to_owned())
}

fn short_licence(sentence: &str) -> &str {
    sentence
        .split_once(" as a whole")
        .map_or(sentence, |(licence, _)| licence)
        .trim()
}

/// `licenses/oriel-rs/`: the repository's licence.
pub fn oriel_rs(repository: &Path, licenses: &Path, version: &str) -> Result<Notice> {
    let folder = licenses.join("oriel-rs");
    fs::create_dir_all(&folder)?;
    fs::copy(repository.join("LICENSE"), folder.join("LICENSE"))
        .context("copying the repository's LICENSE")?;
    Ok(Notice {
        folder: "oriel-rs".into(),
        name: "Oriel RS".into(),
        version: version.into(),
        licence: "MIT".into(),
    })
}

/// What ffmpeg says about itself: its first line, and how it was configured.
struct ToolBuild {
    banner: String,
    configuration: String,
}

fn read_build(ffmpeg: &Path) -> Result<ToolBuild> {
    let text = capture(ffmpeg, &["-hide_banner".as_ref(), "-version".as_ref()])
        .or_else(|_| capture(ffmpeg, &["-version".as_ref()]))?;
    let banner = text.lines().next().unwrap_or_default().trim().to_owned();
    let configuration = text
        .lines()
        .find_map(|line| line.trim().strip_prefix("configuration:"))
        .unwrap_or_default()
        .trim()
        .to_owned();
    Ok(ToolBuild {
        banner,
        configuration,
    })
}

/// The GPL's conditions as the configuration chooses them: GPL-3.0-or-later with
/// `--enable-version3`, else GPL-2.0-or-later; LGPL without `--enable-gpl`.
fn tool_licence(configuration: &str) -> &'static str {
    let flags: Vec<&str> = configuration.split_whitespace().collect();
    match (
        flags.contains(&"--enable-gpl"),
        flags.contains(&"--enable-version3"),
    ) {
        (true, true) => "GPL-3.0-or-later",
        (true, false) => "GPL-2.0-or-later",
        (false, true) => "LGPL-3.0-or-later",
        (false, false) => "LGPL-2.1-or-later",
    }
}

fn media_tools_text(pin: &oriel_tools::MediaToolsPin, build: &ToolBuild, licence: &str) -> String {
    let ffmpeg = source_by_name("ffmpeg");
    let mut text = vec![
        format!(
            "ffmpeg and ffprobe {}, in Contents/Resources/media-tools",
            pin.version
        ),
        String::new(),
        "Oriel RS runs these two programs as separate processes, to read and convert media. \
         They are not linked into Oriel RS."
            .to_owned(),
        String::new(),
        format!("Licence: {licence}. COPYING.GPLv3 here is the licence's text, and LICENSE.md"),
        "is FFmpeg's own account of its licensing; both come from the FFmpeg source release"
            .to_owned(),
        "named below.".to_owned(),
        String::new(),
        "Where they come from: Martin Riedl's static builds for macOS, which ffmpeg.org's"
            .to_owned(),
        "download page links to. Oriel RS fetches them from these addresses and checks each"
            .to_owned(),
        "download's SHA-256 before using it:".to_owned(),
    ];
    for archive in pin.archives {
        text.push(format!("  {}", archive.url));
        text.push(format!("    SHA-256 {}", archive.sha256));
    }
    text.extend([
        String::new(),
        "What they report:".to_owned(),
        format!("  {}", build.banner),
        format!("  configuration: {}", build.configuration),
        String::new(),
        "Corresponding source:".to_owned(),
        format!(
            "  FFmpeg {}: {}",
            ffmpeg.version,
            ffmpeg.archive.urls.first().copied().unwrap_or_default()
        ),
        format!("    SHA-256 {}", ffmpeg.archive.sha256),
        format!("  The scripts the builds are made with: {MEDIA_TOOLS_BUILD_SCRIPT}"),
        "  The libraries the configuration names are fetched by those scripts from their"
            .to_owned(),
        "  publishers, at the versions the scripts pin.".to_owned(),
        String::new(),
    ]);
    text.join("\n")
}

/// One file out of a tarball, as text.
fn read_member(archive: &Path, member: &str) -> Result<String> {
    capture(
        "/usr/bin/tar",
        &["-xOf".as_ref(), archive.as_os_str(), member.as_ref()],
    )
    .with_context(|| format!("reading {member} from {}", archive.display()))
}

/// `licenses/media-tools/`: the GPL's text and FFmpeg's `LICENSE.md` from the pinned FFmpeg
/// source release, and the notice above.
pub fn media_tools(
    tools: &Path,
    pin: &oriel_tools::MediaToolsPin,
    licenses: &Path,
) -> Result<Notice> {
    let ffmpeg = source_by_name("ffmpeg");
    let downloads = libmpv::BuildOptions::default().work.join("downloads");
    let archive = support::download(
        &downloads,
        &Download {
            urls: ffmpeg.archive.urls,
            sha256: ffmpeg.archive.sha256,
            file: ffmpeg.archive.file,
            headers: &[],
        },
    )?;
    let root = format!("ffmpeg-{}", ffmpeg.version);
    let folder = licenses.join("media-tools");
    fs::create_dir_all(&folder)?;
    for file in ["COPYING.GPLv3", "LICENSE.md"] {
        fs::write(
            folder.join(file),
            read_member(&archive, &format!("{root}/{file}"))?,
        )?;
    }
    let build = read_build(&tools.join(oriel_tools::tool_files(pin.platform)[0]))?;
    let licence = tool_licence(&build.configuration);
    if !licence.starts_with("GPL-3.0") {
        bail!("the pinned ffmpeg reports {licence}, not the GPL-3.0 its notice is written for");
    }
    fs::write(
        folder.join("NOTICE.txt"),
        media_tools_text(pin, &build, licence),
    )?;
    Ok(Notice {
        folder: "media-tools".into(),
        name: "ffmpeg and ffprobe".into(),
        version: pin.version.into(),
        licence: licence.into(),
    })
}

/// A crate compiled into the app.
#[derive(Clone, Debug, PartialEq, Eq)]
struct ShippedCrate {
    name: String,
    version: String,
    licence: String,
    repository: Option<String>,
    authors: Vec<String>,
    folder: PathBuf,
    licence_file: Option<PathBuf>,
}

/// The crates `root` is built from on `cargo metadata`'s resolved graph: its normal dependencies,
/// followed through theirs, but not build or dev dependencies, which never reach the binary,
/// nor the workspace's own crates, which are under the repository's licence. Sorted by name and
/// version.
fn shipped_crates(metadata: &Value, root: &str) -> Result<Vec<ShippedCrate>> {
    let packages = metadata["packages"]
        .as_array()
        .context("cargo metadata has no packages")?;
    let by_id = |id: &str| packages.iter().find(|package| package["id"] == id);
    let members: Vec<&str> = metadata["workspace_members"]
        .as_array()
        .map(|ids| ids.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default();
    let root_id = packages
        .iter()
        .find(|package| {
            package["name"] == root && members.contains(&package["id"].as_str().unwrap_or(""))
        })
        .and_then(|package| package["id"].as_str())
        .with_context(|| format!("cargo metadata has no workspace member {root}"))?;
    let nodes = metadata["resolve"]["nodes"]
        .as_array()
        .context("cargo metadata has no resolved graph")?;

    let mut seen: Vec<&str> = vec![root_id];
    let mut queue = vec![root_id];
    while let Some(id) = queue.pop() {
        let Some(node) = nodes.iter().find(|node| node["id"] == id) else {
            continue;
        };
        for dep in node["deps"].as_array().into_iter().flatten() {
            let normal = dep["dep_kinds"]
                .as_array()
                .into_iter()
                .flatten()
                .any(|kind| kind["kind"].is_null());
            let Some(dep_id) = dep["pkg"].as_str() else {
                continue;
            };
            if normal && !seen.contains(&dep_id) {
                seen.push(dep_id);
                queue.push(dep_id);
            }
        }
    }

    let mut crates: Vec<ShippedCrate> = seen
        .into_iter()
        .filter(|id| !members.contains(id))
        .filter_map(by_id)
        .map(|package| {
            let folder = Path::new(package["manifest_path"].as_str().unwrap_or_default())
                .parent()
                .unwrap_or(Path::new(""))
                .to_path_buf();
            ShippedCrate {
                name: package["name"].as_str().unwrap_or_default().to_owned(),
                version: package["version"].as_str().unwrap_or_default().to_owned(),
                licence: package["license"]
                    .as_str()
                    .unwrap_or("not stated")
                    .to_owned(),
                repository: package["repository"].as_str().map(str::to_owned),
                authors: package["authors"]
                    .as_array()
                    .map(|authors| {
                        authors
                            .iter()
                            .filter_map(Value::as_str)
                            .map(str::to_owned)
                            .collect()
                    })
                    .unwrap_or_default(),
                licence_file: package["license_file"]
                    .as_str()
                    .map(|file| folder.join(file)),
                folder,
            }
        })
        .collect();
    crates.sort_by(|a, b| (&a.name, &a.version).cmp(&(&b.name, &b.version)));
    Ok(crates)
}

/// Whether a file at a package's top is a licence or notice: `LICENSE`, `LICENSE-MIT`,
/// `LICENCE.txt`, `COPYING`, `NOTICE`, `UNLICENSE`, `COPYRIGHT`, in any case.
fn is_licence_file(name: &str) -> bool {
    let name = name.to_ascii_uppercase();
    [
        "LICENSE",
        "LICENCE",
        "COPYING",
        "NOTICE",
        "UNLICENSE",
        "COPYRIGHT",
    ]
    .iter()
    .any(|prefix| name.starts_with(prefix))
}

/// The MIT licence's terms, for a crate under MIT whose package carries no copy of them.
const MIT_TERMS: &str = "MIT License

Copyright (c) the crate's authors, as README.txt lists them beside it

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the \"Software\"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED \"AS IS\", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
";

/// Which of the shared texts in `_texts/` holds the terms of a crate that carries none: MIT's
/// where its expression offers MIT, else Apache-2.0's where it offers that.
fn shared_text(licence: &str) -> Option<&'static str> {
    let offers = |id: &str| {
        licence
            .split(|c: char| !(c.is_ascii_alphanumeric() || c == '-' || c == '.'))
            .any(|part| part == id)
    };
    if offers("MIT") {
        Some("MIT.txt")
    } else if offers("Apache-2.0") {
        Some("Apache-2.0.txt")
    } else {
        None
    }
}

fn licence_files(krate: &ShippedCrate) -> Result<Vec<PathBuf>> {
    let mut files: Vec<PathBuf> = fs::read_dir(&krate.folder)
        .with_context(|| format!("reading {}", krate.folder.display()))?
        .filter_map(|entry| entry.ok())
        .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_file()))
        .filter(|entry| is_licence_file(&entry.file_name().to_string_lossy()))
        .map(|entry| entry.path())
        .collect();
    if let Some(file) = &krate.licence_file
        && file.is_file()
        && !files.contains(file)
    {
        files.push(file.clone());
    }
    files.sort();
    Ok(files)
}

/// `licenses/rust-crates/`: each crate's licence files in a folder of its own, and `README.txt`
/// listing every crate with its licence.
pub fn rust_crates(workspace: &Path, licenses: &Path) -> Result<Notice> {
    let cargo = std::env::var_os("CARGO").unwrap_or_else(|| "cargo".into());
    let manifest = workspace.join("Cargo.toml");
    let text = capture(
        &cargo,
        &[
            "metadata".as_ref(),
            "--format-version".as_ref(),
            "1".as_ref(),
            "--filter-platform".as_ref(),
            TARGET.as_ref(),
            "--manifest-path".as_ref(),
            manifest.as_os_str(),
        ],
    )?;
    let metadata: Value = serde_json::from_str(&text).context("reading cargo metadata")?;
    let crates = shipped_crates(&metadata, "oriel-rs")?;

    let folder = licenses.join("rust-crates");
    fs::create_dir_all(&folder)?;
    let mut index = vec![
        "The Rust crates compiled into Oriel RS, each with its licence. Each crate's folder here"
            .to_owned(),
        "holds the licence and notice files its package carries.".to_owned(),
        String::new(),
    ];
    let mut without_files = 0;
    let mut apache_text: Option<PathBuf> = None;
    let mut shared_used = false;
    for krate in &crates {
        let files = licence_files(krate)?;
        let name = format!("{}-{}", krate.name, krate.version);
        if apache_text.is_none() {
            apache_text = files
                .iter()
                .find(|file| {
                    file.file_name()
                        .is_some_and(|name| name.to_string_lossy().starts_with("LICENSE-APACHE"))
                })
                .cloned();
        }
        if files.is_empty() {
            without_files += 1;
        } else {
            let target = folder.join(&name);
            fs::create_dir_all(&target)?;
            for file in &files {
                fs::copy(
                    file,
                    target.join(file.file_name().context("a licence file has no name")?),
                )?;
            }
        }
        let missing = if files.is_empty() {
            let terms = shared_text(&krate.licence);
            shared_used |= terms.is_some();
            format!(
                " (its package carries no licence file{}{})",
                terms
                    .map(|text| format!("; the terms are in _texts/{text}"))
                    .unwrap_or_default(),
                if krate.authors.is_empty() {
                    String::new()
                } else {
                    format!("; copyright {}", krate.authors.join(", "))
                }
            )
        } else {
            String::new()
        };
        index.push(format!(
            "{name}: {}{}{missing}",
            krate.licence,
            krate
                .repository
                .as_deref()
                .map(|url| format!(", {url}"))
                .unwrap_or_default(),
        ));
    }
    index.push(String::new());
    if shared_used {
        let texts = folder.join("_texts");
        fs::create_dir_all(&texts)?;
        fs::write(texts.join("MIT.txt"), MIT_TERMS)?;
        let apache = apache_text.context("no crate carries the Apache-2.0 text to share")?;
        fs::copy(apache, texts.join("Apache-2.0.txt"))?;
    }
    fs::write(folder.join("README.txt"), index.join("\n"))?;
    log(format!(
        "  {} Rust crates' licences ({without_files} without a licence file of their own)",
        crates.len()
    ));
    Ok(Notice {
        folder: "rust-crates".into(),
        name: format!("{} Rust crates", crates.len()),
        version: String::new(),
        // Each crate's own is in README.txt.
        licence: "MIT, Apache-2.0 and others".into(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn sets_name_their_licence_before_the_detail() {
        assert_eq!(
            short_licence("LGPL-2.1-or-later as a whole: mpv, FFmpeg, … are LGPL"),
            "LGPL-2.1-or-later"
        );
        assert_eq!(short_licence("BSD-2-Clause"), "BSD-2-Clause");
    }

    #[test]
    fn the_configuration_decides_the_tools_licence() {
        assert_eq!(
            tool_licence("--prefix=/out --enable-version3 --enable-gpl --enable-libx264"),
            "GPL-3.0-or-later"
        );
        assert_eq!(tool_licence("--enable-gpl"), "GPL-2.0-or-later");
        assert_eq!(tool_licence("--enable-shared"), "LGPL-2.1-or-later");
    }

    #[test]
    fn a_crate_without_a_licence_file_points_at_the_shared_terms() {
        assert_eq!(shared_text("MIT OR Apache-2.0"), Some("MIT.txt"));
        assert_eq!(shared_text("Apache-2.0/MIT"), Some("MIT.txt"));
        assert_eq!(shared_text("Zlib OR Apache-2.0"), Some("Apache-2.0.txt"));
        assert_eq!(shared_text("BSD-3-Clause"), None);
        assert_eq!(shared_text("MIT-0"), None);
    }

    #[test]
    fn licence_files_are_found_by_name() {
        for name in [
            "LICENSE",
            "LICENSE-MIT",
            "license-apache",
            "LICENCE.txt",
            "COPYING",
            "NOTICE",
        ] {
            assert!(is_licence_file(name), "{name}");
        }
        for name in ["README.md", "Cargo.toml", "src"] {
            assert!(!is_licence_file(name), "{name}");
        }
    }

    #[test]
    fn only_normal_dependencies_outside_the_workspace_ship() {
        let package = |name: &str, licence: Option<&str>| {
            json!({
                "id": format!("{name} 1.0.0"),
                "name": name,
                "version": "1.0.0",
                "license": licence,
                "license_file": null,
                "repository": null,
                "manifest_path": format!("/registry/{name}/Cargo.toml"),
            })
        };
        let dep = |name: &str, kind: Option<&str>| json!({ "pkg": format!("{name} 1.0.0"), "dep_kinds": [{ "kind": kind, "target": null }] });
        let metadata = json!({
            "packages": [
                package("oriel-rs", Some("MIT")),
                package("oriel-ui", Some("MIT")),
                package("gpui", Some("Apache-2.0")),
                package("serde", Some("MIT OR Apache-2.0")),
                package("cc", Some("MIT OR Apache-2.0")),
                package("tempfile", Some("MIT OR Apache-2.0")),
                package("unrelated", Some("MIT")),
            ],
            "workspace_members": ["oriel-rs 1.0.0", "oriel-ui 1.0.0"],
            "resolve": { "nodes": [
                { "id": "oriel-rs 1.0.0", "deps": [
                    dep("oriel-ui", None), dep("gpui", None), dep("tempfile", Some("dev")),
                ] },
                { "id": "oriel-ui 1.0.0", "deps": [dep("serde", None)] },
                { "id": "gpui 1.0.0", "deps": [dep("cc", Some("build")), dep("serde", None)] },
                { "id": "serde 1.0.0", "deps": [] },
            ] },
        });
        let shipped: Vec<(String, String)> = shipped_crates(&metadata, "oriel-rs")
            .unwrap()
            .into_iter()
            .map(|krate| (krate.name, krate.licence))
            .collect();
        assert_eq!(
            shipped,
            [
                ("gpui".to_owned(), "Apache-2.0".to_owned()),
                ("serde".to_owned(), "MIT OR Apache-2.0".to_owned()),
            ]
        );
    }
}
