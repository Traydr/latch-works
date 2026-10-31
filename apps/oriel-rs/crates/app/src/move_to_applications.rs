//! On macOS, offers to move an Oriel RS started outside Applications (from the disk image, or
//! Downloads) into it, as Electron Oriel's `offerMoveToApplications` does: once a launch, with
//! "Don't Ask Again" remembered in the shell's folder (`move-to-applications-declined`, the file
//! Electron Oriel writes).
//!
//! Moving copies the bundle into `/Applications` (`~/Applications` when that is not writable),
//! replacing an older copy only when the owner says so, moves the old copy to the Trash unless it
//! is on a read-only volume (the disk image, or App Translocation's mount), then quits and starts
//! again from Applications once this process has gone.
//!
//! The offer skips development builds, binaries outside a bundle and checks' runs: a run with
//! `ORIEL_RS_DATA_DIR` set is offered only with `ORIEL_RS_MOVE_OFFER=1`, and there
//! `ORIEL_RS_APPLICATIONS_DIR` names the folder to move into, so a check never touches the real
//! Applications.

use std::path::{Path, PathBuf};

/// The file whose presence says "Don't Ask Again", in the shell's folder.
pub const DECLINED_FILE: &str = "move-to-applications-declined";
/// `1` offers the move in a run with `ORIEL_RS_DATA_DIR` set, for a check; `move` takes the
/// offer there without asking, as clicking Move to Applications (and Replace) would.
pub const OFFER_VARIABLE: &str = "ORIEL_RS_MOVE_OFFER";
/// The folder a check's run moves into, in place of Applications; read only in such a run.
pub const APPLICATIONS_VARIABLE: &str = "ORIEL_RS_APPLICATIONS_DIR";

/// What the app knows at launch that decides the offer.
#[derive(Debug)]
pub struct Situation {
    pub executable: PathBuf,
    pub home: PathBuf,
    /// A debug build: `cargo run`, the tests.
    pub development: bool,
    /// A run with its own data folder (`ORIEL_RS_DATA_DIR`), as checks make.
    pub test_run: bool,
    /// [`OFFER_VARIABLE`] is `1`.
    pub forced: bool,
    /// [`DECLINED_FILE`] is there.
    pub declined: bool,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Decision {
    /// Ask whether to move `bundle`.
    Offer {
        bundle: PathBuf,
    },
    Skip(Skip),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Skip {
    Development,
    TestRun,
    NotABundle,
    InApplications,
    Declined,
}

pub fn decide(situation: &Situation) -> Decision {
    if situation.development {
        return Decision::Skip(Skip::Development);
    }
    if situation.test_run && !situation.forced {
        return Decision::Skip(Skip::TestRun);
    }
    let Some(bundle) = bundle_of(&situation.executable) else {
        return Decision::Skip(Skip::NotABundle);
    };
    if in_applications(&bundle, &situation.home) {
        return Decision::Skip(Skip::InApplications);
    }
    if situation.declined {
        return Decision::Skip(Skip::Declined);
    }
    Decision::Offer { bundle }
}

/// The `.app` whose `Contents/MacOS` holds `executable`.
pub fn bundle_of(executable: &Path) -> Option<PathBuf> {
    let macos = executable.parent()?;
    let contents = macos.parent()?;
    let bundle = contents.parent()?;
    (macos.file_name()? == "MacOS"
        && contents.file_name()? == "Contents"
        && bundle.extension()? == "app")
        .then(|| bundle.to_path_buf())
}

/// Whether `bundle` is in `/Applications` or `~/Applications`, at any depth, as Electron's
/// `isInApplicationsFolder` reads it.
pub fn in_applications(bundle: &Path, home: &Path) -> bool {
    bundle.starts_with("/Applications") || bundle.starts_with(home.join("Applications"))
}

/// Where the move goes: `/Applications` when it can be written to, else `~/Applications`, which
/// needs no administrator. Electron Oriel asks for an administrator's password instead; Oriel RS
/// keeps to what the owner can write.
pub fn destination(home: &Path, system_writable: bool) -> PathBuf {
    if system_writable {
        PathBuf::from("/Applications")
    } else {
        home.join("Applications")
    }
}

#[cfg(target_os = "macos")]
pub use mac::offer;

#[cfg(target_os = "macos")]
mod mac {
    use std::ffi::OsString;
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::process::Command;

    use gpui_kit::{AnyWindowHandle, App, AsyncWindowContext, PromptLevel};
    use oriel_core_paths::DataRoot;

    use super::{
        APPLICATIONS_VARIABLE, DECLINED_FILE, Decision, OFFER_VARIABLE, Situation, decide,
        destination,
    };

    impl Situation {
        fn now(data: &DataRoot) -> Option<Self> {
            Some(Self {
                executable: std::env::current_exe().ok()?,
                home: std::env::home_dir()?,
                development: cfg!(debug_assertions),
                test_run: data.is_sandboxed(),
                forced: std::env::var(OFFER_VARIABLE)
                    .is_ok_and(|value| value == "1" || value == "move"),
                declined: data.shell().join(DECLINED_FILE).exists(),
            })
        }
    }

    /// Asks over `window`, when [`decide`] says to, and moves the app if the owner agrees.
    pub fn offer(data: &DataRoot, window: AnyWindowHandle, cx: &mut App) {
        let Some(situation) = Situation::now(data) else {
            return;
        };
        let bundle = match decide(&situation) {
            Decision::Offer { bundle } => bundle,
            Decision::Skip(reason) => {
                log::debug!("no offer to move to Applications: {reason:?}");
                return;
            }
        };
        let folder = match std::env::var_os(APPLICATIONS_VARIABLE) {
            Some(folder) if situation.test_run && !folder.is_empty() => PathBuf::from(folder),
            _ => destination(&situation.home, writable(Path::new("/Applications"))),
        };
        // A check's own folder is where the moved copy starts again.
        if bundle.parent() == Some(folder.as_path()) {
            return;
        }
        let declined = data.shell().join(DECLINED_FILE);
        let unasked =
            situation.test_run && std::env::var(OFFER_VARIABLE).is_ok_and(|v| v == "move");
        window
            .update(cx, |_, window, cx| {
                window
                    .spawn(cx, async move |cx| {
                        ask(cx, bundle, folder, declined, unasked).await;
                    })
                    .detach();
            })
            .ok();
    }

    async fn ask(
        cx: &mut AsyncWindowContext,
        bundle: PathBuf,
        folder: PathBuf,
        declined: PathBuf,
        unasked: bool,
    ) {
        let answer = if unasked {
            Ok(0)
        } else {
            prompt_move(cx).await
        };
        match answer {
            Ok(0) => {}
            Ok(2) => {
                let now = std::time::SystemTime::now();
                let stamp = format!("{}\n", oriel_core_sync::iso_timestamp(now));
                if let Err(error) = fs::write(&declined, stamp) {
                    log::warn!("could not remember the declined move: {error}");
                }
                return;
            }
            _ => return,
        }
        let Some(name) = bundle.file_name().map(ToOwned::to_owned) else {
            return;
        };
        let target = folder.join(&name);
        if target.exists() {
            let replace = cx.prompt(
                PromptLevel::Warning,
                "Replace the Oriel RS in Applications?",
                Some(
                    "An older copy is there. Your folders, catalogs and settings are not touched.",
                ),
                &["Replace", "Cancel"],
            );
            if !unasked && replace.await != Ok(0) {
                return;
            }
            if is_running(&target) {
                failed(
                    cx,
                    "The copy in Applications is running. Quit it, then try again.",
                )
                .await;
                return;
            }
        }
        let copied = {
            let (bundle, folder) = (bundle.clone(), folder.clone());
            cx.background_executor()
                .spawn(async move { copy_into(&bundle, &folder) })
                .await
        };
        let target = match copied {
            Ok(target) => target,
            Err(error) => {
                failed(cx, &error).await;
                return;
            }
        };
        if !read_only(&bundle)
            && let Err(error) = trash(&bundle)
        {
            log::warn!("the old copy stays at {}: {error}", bundle.display());
        }
        if let Err(error) = relaunch(&target) {
            failed(
                cx,
                &format!("It is in Applications, but did not start: {error}"),
            )
            .await;
            return;
        }
        cx.update(|_, cx| cx.quit()).ok();
    }

    async fn prompt_move(
        cx: &mut AsyncWindowContext,
    ) -> Result<usize, futures::channel::oneshot::Canceled> {
        cx.prompt(
            PromptLevel::Info,
            "Move Oriel RS to Applications?",
            Some(
                "It runs from where it is, but from Applications it stays when the disk image is \
                 ejected or Downloads is cleared out.",
            ),
            &["Move to Applications", "Not Now", "Don't Ask Again"],
        )
        .await
    }

    async fn failed(cx: &mut AsyncWindowContext, detail: &str) {
        let shown = cx.prompt(
            PromptLevel::Critical,
            "Oriel RS could not move to Applications",
            Some(detail),
            &["OK"],
        );
        shown.await.ok();
    }

    fn writable(folder: &Path) -> bool {
        let Ok(path) = std::ffi::CString::new(folder.as_os_str().as_encoded_bytes()) else {
            return false;
        };
        // SAFETY: a NUL-terminated path, read for the call only.
        unsafe { libc::access(path.as_ptr(), libc::W_OK) == 0 }
    }

    /// Whether the volume `path` is on is mounted read-only, as a disk image is.
    fn read_only(path: &Path) -> bool {
        let Ok(text) = std::ffi::CString::new(path.as_os_str().as_encoded_bytes()) else {
            return true;
        };
        // SAFETY: plain data, filled by the call on success.
        let mut stats: libc::statfs = unsafe { std::mem::zeroed() };
        // SAFETY: a NUL-terminated path and a `statfs` to fill.
        if unsafe { libc::statfs(text.as_ptr(), &raw mut stats) } != 0 {
            return true;
        }
        stats.f_flags & libc::MNT_RDONLY as u32 != 0
    }

    /// Whether a process runs the executable of the bundle at `target`.
    fn is_running(target: &Path) -> bool {
        let inside = target.join("Contents").join("MacOS");
        Command::new("/bin/ps")
            .args(["-axo", "comm="])
            .output()
            .map(|output| {
                String::from_utf8_lossy(&output.stdout)
                    .lines()
                    .any(|line| Path::new(line.trim()).starts_with(&inside))
            })
            .unwrap_or(false)
    }

    /// Copies `bundle` into `folder` beside any copy already there, then swaps it in, so a
    /// failed copy leaves the old one as it was. ditto keeps the signature and every attribute.
    fn copy_into(bundle: &Path, folder: &Path) -> Result<PathBuf, String> {
        let name = bundle.file_name().ok_or("the app has no name")?;
        let describe = |error: std::io::Error| error.to_string();
        fs::create_dir_all(folder).map_err(describe)?;
        let target = folder.join(name);
        let mut staged = OsString::from(".");
        staged.push(name);
        let staging = folder.join(&staged).with_extension("moving");
        let replaced = folder.join(&staged).with_extension("replaced");
        for leftover in [&staging, &replaced] {
            if leftover.exists() {
                fs::remove_dir_all(leftover).map_err(describe)?;
            }
        }
        let copied = Command::new("/usr/bin/ditto")
            .arg(bundle)
            .arg(&staging)
            .status()
            .map_err(describe)?;
        if !copied.success() {
            fs::remove_dir_all(&staging).ok();
            return Err(format!(
                "ditto could not copy the app into {}",
                folder.display()
            ));
        }
        if target.exists() {
            fs::rename(&target, &replaced).map_err(describe)?;
        }
        if let Err(error) = fs::rename(&staging, &target) {
            fs::rename(&replaced, &target).ok();
            return Err(error.to_string());
        }
        if replaced.exists() {
            fs::remove_dir_all(&replaced).ok();
        }
        Ok(target)
    }

    /// Moves the old copy to the Trash, as Electron's move does, so it can be taken back.
    fn trash(path: &Path) -> Result<(), String> {
        use objc2_foundation::{NSFileManager, NSString, NSURL};

        let text = path.to_str().ok_or("its path is not Unicode")?;
        let url = NSURL::fileURLWithPath(&NSString::from_str(text));
        NSFileManager::defaultManager()
            .trashItemAtURL_resultingItemURL_error(&url, None)
            .map_err(|error| error.localizedDescription().to_string())
    }

    /// Starts the app at `target` through LaunchServices once this process has gone, so the two
    /// never hold the data folder at once. The check variables go along, since `open` passes
    /// no environment of its own.
    fn relaunch(target: &Path) -> std::io::Result<()> {
        let mut open = vec![OsString::from("/usr/bin/open")];
        for (name, value) in std::env::vars_os() {
            // The moved copy is not offered the move again.
            let passed = {
                let name = name.to_string_lossy();
                name.starts_with("ORIEL_RS_") && name != OFFER_VARIABLE
            };
            if passed {
                let mut pair = name;
                pair.push("=");
                pair.push(value);
                open.extend([OsString::from("--env"), pair]);
            }
        }
        open.push(target.as_os_str().to_owned());
        // `$0` is the process id; the rest is `open` and its arguments.
        Command::new("/bin/sh")
            .arg("-c")
            .arg("while /bin/kill -0 \"$0\" 2>/dev/null; do /bin/sleep 0.2; done; exec \"$@\"")
            .arg(std::process::id().to_string())
            .args(open)
            .spawn()
            .map(drop)
    }
}

#[cfg(test)]
mod tests {
    use std::path::{Path, PathBuf};

    use super::{Decision, Situation, Skip, decide, destination};

    fn situation(executable: &str) -> Situation {
        Situation {
            executable: PathBuf::from(executable),
            home: PathBuf::from("/Users/owner"),
            development: false,
            test_run: false,
            forced: false,
            declined: false,
        }
    }

    const IN_IMAGE: &str = "/Volumes/Oriel RS/Oriel RS.app/Contents/MacOS/oriel-rs";

    #[test]
    fn offers_a_bundle_started_from_the_disk_image_or_downloads() {
        for executable in [
            IN_IMAGE,
            "/Users/owner/Downloads/Oriel RS.app/Contents/MacOS/oriel-rs",
        ] {
            let bundle = Path::new(executable).ancestors().nth(3).unwrap();
            assert_eq!(
                decide(&situation(executable)),
                Decision::Offer {
                    bundle: bundle.to_path_buf()
                }
            );
        }
    }

    #[test]
    fn leaves_a_bundle_in_either_applications_folder_alone() {
        for executable in [
            "/Applications/Oriel RS.app/Contents/MacOS/oriel-rs",
            "/Applications/Utilities/Oriel RS.app/Contents/MacOS/oriel-rs",
            "/Users/owner/Applications/Oriel RS.app/Contents/MacOS/oriel-rs",
        ] {
            assert_eq!(
                decide(&situation(executable)),
                Decision::Skip(Skip::InApplications)
            );
        }
    }

    #[test]
    fn skips_development_builds_checks_and_a_declined_offer() {
        assert_eq!(
            decide(&situation("/repo/target/dist/oriel-rs")),
            Decision::Skip(Skip::NotABundle)
        );
        let mut development = situation(IN_IMAGE);
        development.development = true;
        assert_eq!(decide(&development), Decision::Skip(Skip::Development));
        let mut check = situation(IN_IMAGE);
        check.test_run = true;
        assert_eq!(decide(&check), Decision::Skip(Skip::TestRun));
        check.forced = true;
        assert!(matches!(decide(&check), Decision::Offer { .. }));
        let mut declined = situation(IN_IMAGE);
        declined.declined = true;
        assert_eq!(decide(&declined), Decision::Skip(Skip::Declined));
    }

    #[test]
    fn moves_into_the_home_applications_when_the_system_one_is_not_writable() {
        let home = Path::new("/Users/owner");
        assert_eq!(destination(home, true), Path::new("/Applications"));
        assert_eq!(
            destination(home, false),
            Path::new("/Users/owner/Applications")
        );
    }
}
