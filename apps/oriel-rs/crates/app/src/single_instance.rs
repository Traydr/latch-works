//! One Oriel RS per data folder, as Electron Oriel's `requestSingleInstanceLock` keeps it.
//!
//! macOS needs nothing here: LaunchServices keeps one instance of a bundle and hands a second
//! launch's files to the running one (`on_open_urls`, `on_reopen`). Windows has no such thing,
//! so there the first instance holds a named mutex and listens on a named pipe, and a second
//! launch writes its paths into the pipe and exits; the first opens them in View, or comes to
//! the front when there are none, as Electron Oriel's `second-instance` handler does. Both names
//! carry the data folder, so a check's run with its own `ORIEL_RS_DATA_DIR` starts beside the
//! owner's, as Electron Oriel's lock keys on its data folder.

use std::path::{Path, PathBuf};

use futures::channel::mpsc::UnboundedSender;
use oriel_core_paths::DataRoot;

/// Whether this launch is the one that runs.
pub enum Claim {
    /// This is the first instance for the data folder; [`Instance::listen`] takes the others'.
    First(Instance),
    /// Another instance runs and has this launch's paths; this one must exit.
    Handed,
}

/// The lock, held for the life of the process.
pub struct Instance {
    #[cfg(windows)]
    name: String,
}

/// The name the lock and the pipe share for `data`: the app's id and a stable hash of the
/// folder (FNV-1a, so every build of the app reads the same name).
pub fn lock_name(root: &Path) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in root.as_os_str().as_encoded_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("dev.traydr.latchworks.oriel-rs-{hash:016x}")
}

/// The paths a launch hands over, one per line; an empty message asks for the window.
pub fn encode(paths: &[PathBuf]) -> String {
    paths
        .iter()
        .map(|path| path.to_string_lossy())
        .collect::<Vec<_>>()
        .join("\n")
}

pub fn decode(message: &str) -> Vec<PathBuf> {
    message
        .lines()
        .filter(|line| !line.is_empty())
        .map(PathBuf::from)
        .collect()
}

/// Takes the lock for `data`, or hands `paths` (this launch's, absolute) to the instance that
/// holds it.
pub fn claim(data: &DataRoot, paths: &[PathBuf]) -> Claim {
    #[cfg(windows)]
    return windows::claim(lock_name(data.root()), paths);
    #[cfg(not(windows))]
    {
        let _ = (data, paths);
        Claim::First(Instance {})
    }
}

impl Instance {
    /// Sends what each later launch hands over to `opened`: its paths, or none for "show the
    /// window".
    pub fn listen(self, opened: UnboundedSender<Vec<PathBuf>>) {
        #[cfg(windows)]
        windows::listen(self.name, opened);
        #[cfg(not(windows))]
        let _ = opened;
    }
}

#[cfg(windows)]
mod windows {
    use std::fs::{File, OpenOptions};
    use std::io::{Read as _, Write as _};
    use std::os::windows::io::FromRawHandle as _;
    use std::path::PathBuf;
    use std::time::{Duration, Instant};

    use futures::channel::mpsc::UnboundedSender;
    use windows::Win32::Foundation::{ERROR_ALREADY_EXISTS, ERROR_PIPE_CONNECTED, GetLastError};
    use windows::Win32::Storage::FileSystem::PIPE_ACCESS_INBOUND;
    use windows::Win32::System::Pipes::{
        ConnectNamedPipe, CreateNamedPipeW, PIPE_READMODE_BYTE, PIPE_REJECT_REMOTE_CLIENTS,
        PIPE_TYPE_BYTE, PIPE_UNLIMITED_INSTANCES, PIPE_WAIT,
    };
    use windows::Win32::System::Threading::CreateMutexW;
    use windows::Win32::UI::WindowsAndMessaging::{ASFW_ANY, AllowSetForegroundWindow};
    use windows::core::HSTRING;

    use super::{Claim, Instance, decode, encode};

    /// How long a second launch tries the pipe, which the first opens a moment after its lock.
    const HAND_OVER_FOR: Duration = Duration::from_secs(5);

    fn pipe_path(name: &str) -> String {
        format!(r"\\.\pipe\{name}")
    }

    pub(super) fn claim(name: String, paths: &[PathBuf]) -> Claim {
        let mutex_name = HSTRING::from(format!(r"Local\{name}"));
        // SAFETY: a named mutex with the default security, owned by this process until it
        // exits; the handle is kept open for that long on purpose.
        let created = unsafe { CreateMutexW(None, true, &mutex_name) };
        // SAFETY: read straight after the call that set it.
        let existed = unsafe { GetLastError() } == ERROR_ALREADY_EXISTS;
        match created {
            Ok(_handle) if !existed => Claim::First(Instance { name }),
            // The lock could not be made at all: run, rather than refuse to start.
            Err(error) => {
                log::warn!("no single-instance lock: {error}");
                Claim::First(Instance { name })
            }
            Ok(_) => {
                hand_over(&name, paths);
                Claim::Handed
            }
        }
    }

    fn hand_over(name: &str, paths: &[PathBuf]) {
        // The running instance may bring its window to the front for this launch.
        // SAFETY: no preconditions.
        unsafe { AllowSetForegroundWindow(ASFW_ANY) }.ok();
        let started = Instant::now();
        loop {
            match OpenOptions::new().write(true).open(pipe_path(name)) {
                Ok(mut pipe) => {
                    if let Err(error) = pipe.write_all(encode(paths).as_bytes()) {
                        log::warn!("could not hand the launch over: {error}");
                    }
                    return;
                }
                Err(_) if started.elapsed() < HAND_OVER_FOR => {
                    std::thread::sleep(Duration::from_millis(100));
                }
                Err(error) => {
                    log::warn!("the running Oriel RS did not answer: {error}");
                    return;
                }
            }
        }
    }

    pub(super) fn listen(name: String, opened: UnboundedSender<Vec<PathBuf>>) {
        let path = HSTRING::from(pipe_path(&name));
        let spawned = std::thread::Builder::new()
            .name("single-instance".into())
            .spawn(move || {
                loop {
                    // SAFETY: a fresh inbound pipe instance for one client at a time; only this
                    // user's processes can write to it under the default security.
                    let pipe = unsafe {
                        CreateNamedPipeW(
                            &path,
                            PIPE_ACCESS_INBOUND,
                            PIPE_TYPE_BYTE
                                | PIPE_READMODE_BYTE
                                | PIPE_WAIT
                                | PIPE_REJECT_REMOTE_CLIENTS,
                            PIPE_UNLIMITED_INSTANCES,
                            0,
                            64 * 1024,
                            0,
                            None,
                        )
                    };
                    if pipe.is_invalid() {
                        log::warn!(
                            "no single-instance pipe: {}",
                            std::io::Error::last_os_error()
                        );
                        return;
                    }
                    // SAFETY: the pipe just made; a client that connected first is fine too.
                    let connected = unsafe { ConnectNamedPipe(pipe, None) };
                    if let Err(error) = connected
                        && error.code() != ERROR_PIPE_CONNECTED.to_hresult()
                    {
                        // SAFETY: the handle is ours, and dropping the file closes it.
                        drop(unsafe { File::from_raw_handle(pipe.0) });
                        continue;
                    }
                    // SAFETY: the handle is ours from here; the file closes it.
                    let mut client = unsafe { File::from_raw_handle(pipe.0) };
                    let mut message = String::new();
                    if client.read_to_string(&mut message).is_ok()
                        && opened.unbounded_send(decode(&message)).is_err()
                    {
                        return;
                    }
                }
            });
        if let Err(error) = spawned {
            log::warn!("no single-instance listener: {error}");
        }
    }
}

#[cfg(test)]
mod tests {
    use std::path::{Path, PathBuf};

    use super::{decode, encode, lock_name};

    #[test]
    fn hands_paths_over_one_per_line_and_none_as_show_the_window() {
        let paths = [
            PathBuf::from("/Users/owner/Pictures/Holiday 2024"),
            PathBuf::from("/tmp/a.jpg"),
        ];
        assert_eq!(decode(&encode(&paths)), paths);
        assert!(decode(&encode(&[])).is_empty());
    }

    #[test]
    fn names_the_lock_after_the_data_folder() {
        let owner = lock_name(Path::new("/Users/owner/.latch-works/oriel-rs"));
        assert_eq!(
            owner,
            lock_name(Path::new("/Users/owner/.latch-works/oriel-rs"))
        );
        assert_ne!(owner, lock_name(Path::new("/tmp/check/data")));
        assert!(owner.starts_with("dev.traydr.latchworks.oriel-rs-"));
    }
}
