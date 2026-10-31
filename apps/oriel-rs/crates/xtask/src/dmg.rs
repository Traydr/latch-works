//! Makes the disk image the owner hands on (decision 19): the bundle `bundle` makes, beside a
//! link to `/Applications`, in a compressed DMG named with the version and architecture,
//!
//! ```text
//! cargo run -p xtask -- dmg
//! ```
//!
//! in `release/bundle` of the target folder, beside the app. It is signed ad hoc as the bundle
//! is and carries no background art: Finder shows the two icons, and the move-to-Applications
//! offer covers anyone who opens the app from the image instead.

use std::fs;
use std::path::PathBuf;

use anyhow::{Context as _, Result, bail};

use crate::bundle::{self, APP_NAME};
use crate::support::{self, log, run_here};

/// The volume's name, which Finder shows in its sidebar while the image is mounted.
const VOLUME_NAME: &str = APP_NAME;

/// The image's file name, as Electron Oriel's Forge names its DMG: name, version, architecture.
fn image_name(version: &str, arch: &str) -> String {
    format!("{}-{version}-{arch}.dmg", APP_NAME.replace(' ', "-"))
}

pub fn command(args: &[String]) -> Result<()> {
    if let Some(extra) = args.first() {
        bail!("dmg takes no options, not {extra}");
    }
    let image = make()?;
    log(format!(
        "\nTry it without installing: hdiutil attach -nobrowse \"{}\"",
        image.display()
    ));
    Ok(())
}

/// Makes the bundle, then the image, and returns where the image is.
pub fn make() -> Result<PathBuf> {
    let app = bundle::make()?;
    let workspace = support::workspace();
    let version = bundle::crate_version(&workspace)?;
    let folder = app.parent().context("the bundle sits in a folder")?;

    log("\n6. The disk image");
    let staging = folder.join(".dmg-staging");
    if staging.exists() {
        fs::remove_dir_all(&staging)?;
    }
    fs::create_dir_all(&staging)?;
    let copied = staging.join(format!("{APP_NAME}.app"));
    // ditto keeps the signature, the symlinks inside the bundle and every attribute.
    run_here(
        "/usr/bin/ditto",
        &[app.as_os_str(), copied.as_os_str()],
        &workspace,
    )?;
    std::os::unix::fs::symlink("/Applications", staging.join("Applications"))
        .context("linking /Applications into the image")?;

    let image = folder.join(image_name(&version, "arm64"));
    // ULFO is LZFSE, as Electron Oriel's DMG; it opens on macOS 10.11 and later, well under the
    // app's own floor.
    let created = run_here(
        "/usr/bin/hdiutil",
        &[
            "create".as_ref(),
            "-volname".as_ref(),
            VOLUME_NAME.as_ref(),
            "-srcfolder".as_ref(),
            staging.as_os_str(),
            "-format".as_ref(),
            "ULFO".as_ref(),
            "-ov".as_ref(),
            image.as_os_str(),
        ],
        &workspace,
    );
    fs::remove_dir_all(&staging)?;
    created?;
    run_here(
        "/usr/bin/hdiutil",
        &["verify".as_ref(), "-quiet".as_ref(), image.as_os_str()],
        &workspace,
    )?;
    log(format!(
        "\n{}: {}, the app {} unpacked",
        image.display(),
        support::megabytes(fs::metadata(&image)?.len()),
        bundle::size_of(&app)?
    ));
    Ok(image)
}
