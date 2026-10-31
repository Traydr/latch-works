//! Makes the disk image the owner hands on (decision 19), laid out as Electron Oriel's: a
//! 660 × 400 Finder window over the installer art, the app and a link to `/Applications` at
//! 128 px either side of its arrow, and the app's icon on the volume,
//!
//! ```text
//! cargo run -p xtask -- dmg [--app <Oriel.app>]
//! ```
//!
//! in `release/bundle` of the target folder, beside the app. Without `--app` it makes the bundle
//! first; with it, it packs a bundle already made from this checkout.
//!
//! It does what appdmg does for Electron Oriel's Forge config, in Rust: an HFS+ image, mounted,
//! filled, laid out with a `.DS_Store` written here (`ds_store`, `alias`, `bplist`) and no
//! Finder scripting, then compressed to ULFO. The background is the 1x and 2x pictures in
//! `crates/xtask/installer/`, joined into one HiDPI TIFF by macOS's `tiffutil`.

mod alias;
mod bplist;
mod ds_store;

use std::ffi::CString;
use std::fs;
use std::os::unix::ffi::OsStrExt as _;
use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{Context as _, Result, bail};

use crate::bundle::{self, APP_NAME, ICON_FILE};
use crate::support::{self, capture, log, run_here};

/// The volume's name, which Finder shows in its sidebar and the window's title.
const VOLUME_NAME: &str = APP_NAME;

/// The Finder window, as Electron Oriel's Forge config sets it.
const WINDOW_WIDTH: u32 = 660;
const WINDOW_HEIGHT: u32 = 400;
const ICON_SIZE: u32 = 128;
/// Where the icons' centres sit: the app left of the art's arrow, Applications right of it.
const APP_POSITION: (u32, u32) = (180, 180);
const APPLICATIONS_POSITION: (u32, u32) = (480, 180);

/// The hidden folder holding the background, and the picture's name in it.
const BACKGROUND_FOLDER: &str = ".background";
const BACKGROUND_FILE: &str = "dmg-background.tiff";

/// Finder's flags, in the first two bytes of the eight at offset 8 of `com.apple.FinderInfo`.
const HAS_CUSTOM_ICON: u8 = 0x04;
const IS_INVISIBLE: u8 = 0x40;

/// The image's file name, as Electron Oriel's Forge names its DMG: name, version, architecture.
fn image_name(version: &str, arch: &str) -> String {
    format!("{}-{version}-{arch}.dmg", APP_NAME.replace(' ', "-"))
}

pub fn command(args: &[String]) -> Result<()> {
    let image = match args {
        [] => make()?,
        [flag, app] if flag == "--app" => make_from(Path::new(app))?,
        [other, ..] => bail!("dmg takes only --app <Oriel.app>, not {other}"),
    };
    log(format!(
        "\nTry it without installing: hdiutil attach -nobrowse \"{}\"",
        image.display()
    ));
    Ok(())
}

/// Makes the bundle, then the image, and returns where the image is.
pub fn make() -> Result<PathBuf> {
    make_from(&bundle::make()?)
}

/// Makes the image of `app`, beside it, and returns where the image is.
fn make_from(app: &Path) -> Result<PathBuf> {
    let workspace = support::workspace();
    let version = bundle::crate_version(&workspace)?;
    let app = std::path::absolute(app)?;
    if !app.join("Contents/Info.plist").is_file() {
        bail!("{} is not an app bundle", app.display());
    }
    let folder = app.parent().context("the bundle sits in a folder")?;

    log("\n6. The disk image");
    let work = folder.join(".dmg-work");
    if work.exists() {
        // A run stopped midway may have left its image mounted there.
        let _ = detach(&work.join("mount"));
        fs::remove_dir_all(&work)?;
    }
    fs::create_dir_all(&work)?;
    let writable = work.join("writable.dmg");
    let image = folder.join(image_name(&version, "arm64"));
    let made = make_writable(&app, &workspace, &work, &writable).and_then(|()| {
        // ULFO is LZFSE, as Electron Oriel's DMG; it opens on macOS 10.11 and later, well under
        // the app's own floor.
        run_here(
            "/usr/bin/hdiutil",
            &[
                "convert".as_ref(),
                writable.as_os_str(),
                "-format".as_ref(),
                "ULFO".as_ref(),
                "-quiet".as_ref(),
                "-ov".as_ref(),
                "-o".as_ref(),
                image.as_os_str(),
            ],
            &workspace,
        )
    });
    fs::remove_dir_all(&work)?;
    made?;
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

/// Makes an HFS+ image at `writable` holding the app, the link, the background and the icon,
/// laid out for Finder, and leaves it unmounted.
fn make_writable(app: &Path, workspace: &Path, work: &Path, writable: &Path) -> Result<()> {
    // Room for the app's blocks and a margin for the file system, as appdmg sizes its image;
    // the free space compresses to nothing.
    let kilobytes: u64 = capture("/usr/bin/du", &["-sk".as_ref(), app.as_os_str()])?
        .split_whitespace()
        .next()
        .and_then(|size| size.parse().ok())
        .context("reading the app's size")?;
    let megabytes = kilobytes / 1024 * 5 / 4 + 32;
    run_here(
        "/usr/bin/hdiutil",
        &[
            "create".as_ref(),
            "-ov".as_ref(),
            "-fs".as_ref(),
            "HFS+".as_ref(),
            "-size".as_ref(),
            format!("{megabytes}m").as_ref(),
            "-volname".as_ref(),
            VOLUME_NAME.as_ref(),
            writable.as_os_str(),
        ],
        workspace,
    )?;

    let mount = work.join("mount");
    fs::create_dir_all(&mount)?;
    run_here(
        "/usr/bin/hdiutil",
        &[
            "attach".as_ref(),
            writable.as_os_str(),
            "-nobrowse".as_ref(),
            "-noverify".as_ref(),
            "-noautoopen".as_ref(),
            "-mountpoint".as_ref(),
            mount.as_os_str(),
        ],
        workspace,
    )?;
    let filled = fill(app, workspace, &mount);
    let detached = detach(&mount);
    filled?;
    detached
}

/// Puts the app, the link, the background and the volume's icon on the mounted image, then the
/// `.DS_Store` that lays them out.
fn fill(app: &Path, workspace: &Path, mount: &Path) -> Result<()> {
    // ditto keeps the signature, the symlinks inside the bundle and every attribute.
    let app_name = format!("{APP_NAME}.app");
    run_here(
        "/usr/bin/ditto",
        &[app.as_os_str(), mount.join(&app_name).as_os_str()],
        workspace,
    )?;
    std::os::unix::fs::symlink("/Applications", mount.join("Applications"))
        .context("linking /Applications into the image")?;

    // One TIFF with both pictures, so Finder draws the 2x one on a Retina display.
    let art = workspace.join("crates/xtask/installer");
    let background_folder = mount.join(BACKGROUND_FOLDER);
    fs::create_dir(&background_folder)?;
    run_here(
        "/usr/bin/tiffutil",
        &[
            "-cathidpicheck".as_ref(),
            art.join("dmg-background.png").as_os_str(),
            art.join("dmg-background@2x.png").as_os_str(),
            "-out".as_ref(),
            background_folder.join(BACKGROUND_FILE).as_os_str(),
        ],
        workspace,
    )?;

    // The volume shows the app's icon: `.VolumeIcon.icns` and the root's custom-icon flag, set
    // in its Finder info directly, as appdmg does, since SetFile comes only with Xcode.
    let volume_icon = mount.join(".VolumeIcon.icns");
    fs::copy(app.join("Contents/Resources").join(ICON_FILE), &volume_icon)
        .context("copying the app's icon onto the volume")?;
    set_finder_flags(mount, HAS_CUSTOM_ICON)?;
    // Their dot names hide them already; the flag hides them as Finder's own files are.
    set_finder_flags(&background_folder, IS_INVISIBLE)?;
    set_finder_flags(&volume_icon, IS_INVISIBLE)?;

    let background = alias::Target::read(mount, BACKGROUND_FOLDER, BACKGROUND_FILE, VOLUME_NAME)?;
    let mut records = vec![
        ds_store::Record::icon_position(&app_name, APP_POSITION.0, APP_POSITION.1),
        ds_store::Record::icon_position(
            "Applications",
            APPLICATIONS_POSITION.0,
            APPLICATIONS_POSITION.1,
        ),
    ];
    records.extend(ds_store::Record::window(&ds_store::Window {
        x: 100,
        y: 100,
        width: WINDOW_WIDTH,
        height: WINDOW_HEIGHT,
        icon_size: ICON_SIZE,
        background_alias: background.encode()?,
    }));
    fs::write(mount.join(".DS_Store"), ds_store::encode(records)?)
        .context("writing the image's .DS_Store")?;
    Ok(())
}

/// Sets `flags` in the first byte of an item's Finder flags, the rest of its Finder info empty.
fn set_finder_flags(path: &Path, flags: u8) -> Result<()> {
    let mut info = [0u8; 32];
    info[8] = flags;
    let path_c = CString::new(path.as_os_str().as_bytes())?;
    let name = c"com.apple.FinderInfo";
    // SAFETY: both strings are NUL-terminated and `info` outlives the call.
    let result = unsafe {
        libc::setxattr(
            path_c.as_ptr(),
            name.as_ptr(),
            info.as_ptr().cast(),
            info.len(),
            0,
            0,
        )
    };
    if result != 0 {
        return Err(std::io::Error::last_os_error())
            .with_context(|| format!("setting the Finder flags of {}", path.display()));
    }
    Ok(())
}

/// Unmounts the image, waiting for Spotlight or Finder to let go of it as appdmg does, and
/// forcing it the last time.
fn detach(mount: &Path) -> Result<()> {
    let mut wait = Duration::from_secs(1);
    for attempt in 1..=5 {
        let mut args = vec!["detach".as_ref(), mount.as_os_str()];
        if attempt == 5 {
            args.push("-force".as_ref());
        }
        match capture("/usr/bin/hdiutil", &args) {
            Ok(_) => return Ok(()),
            Err(error) if attempt == 5 => return Err(error),
            Err(_) => {
                std::thread::sleep(wait);
                wait *= 2;
            }
        }
    }
    unreachable!("the last attempt returns")
}
