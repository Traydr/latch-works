//! One Oriel per data folder, as Electron Oriel's `requestSingleInstanceLock` keeps it.
//!
//! On macOS LaunchServices keeps one instance of a bundle and hands a second launch's files to
//! the running one (`on_open_urls`, `on_reopen`), but two copies of the bundle (the disk image's
//! and Applications') are two apps to it, and both would run on one data folder, where two Tidy
//! engines would open one catalog. So the first instance also holds an exclusive `flock` on
//! `instance.lock` in the data folder, taken before anything opens and kept for the life of the
//! process, and listens on `instance.sock` beside it. A later start that finds the lock taken
//! writes its paths into the socket and exits at once, opening nothing itself; the first opens
//! them, or comes to the front when there are none. The system drops the lock when the process
//! ends, however it ends, and the next first instance replaces the socket left behind.
//!
//! Windows has no LaunchServices, so there the first instance holds a named mutex and listens on
//! a named pipe, and a second launch writes its paths into the pipe and exits; the first opens
//! them in View, or comes to the front when there are none, as Electron Oriel's
//! `second-instance` handler does. The names, like the lock file, go with the data folder, so a
//! check's run with its own `ORIEL_DATA_DIR` starts beside the owner's, as Electron Oriel's
//! lock keys on its data folder.

use std::path::{Path, PathBuf};

use futures::channel::mpsc::UnboundedSender;
use oriel_core_paths::DataRoot;

/// Whether this launch is the one that runs.
pub enum Claim {
    /// This is the first instance for the data folder; [`Instance::listen`] takes the others'.
    First(Instance),
    /// Another instance runs on the data folder (on Windows it has this launch's paths); this
    /// one must exit.
    Handed,
}

/// The lock, held for the life of the process.
pub struct Instance {
    #[cfg(windows)]
    name: String,
    /// `instance.lock`, locked; `None` when the lock could not be made at all. [`Self::listen`]
    /// keeps it open until the process ends.
    #[cfg(not(windows))]
    lock: Option<std::fs::File>,
    /// Where a later start hands its paths over.
    #[cfg(not(windows))]
    socket: PathBuf,
}

/// The lock file in the data folder, beside the modes' folders.
#[cfg(not(windows))]
pub const LOCK_FILE: &str = "instance.lock";
/// The socket a later start hands its paths into, beside [`LOCK_FILE`].
#[cfg(not(windows))]
pub const SOCKET_FILE: &str = "instance.sock";

/// Why [`lock`] did not take the data folder.
#[cfg(not(windows))]
#[derive(Debug)]
pub enum LockError {
    /// Another process holds it: an Oriel runs on this data folder.
    Taken,
    /// The lock file could not be opened or locked.
    Failed(std::io::Error),
}

/// Takes the exclusive lock on `root`'s [`LOCK_FILE`], which holds while the file stays open.
#[cfg(not(windows))]
pub fn lock(root: &Path) -> Result<std::fs::File, LockError> {
    let file = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(root.join(LOCK_FILE))
        .map_err(LockError::Failed)?;
    match file.try_lock() {
        Ok(()) => Ok(file),
        Err(std::fs::TryLockError::WouldBlock) => Err(LockError::Taken),
        Err(std::fs::TryLockError::Error(error)) => Err(LockError::Failed(error)),
    }
}

/// The name the lock and the pipe share for `data`: the app's id and a stable hash of the
/// folder (FNV-1a, so every build of the app reads the same name).
pub fn lock_name(root: &Path) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in root.as_os_str().as_encoded_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("dev.traydr.latchworks.oriel-{hash:016x}")
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
        let socket = data.root().join(SOCKET_FILE);
        match lock(data.root()) {
            Ok(file) => Claim::First(Instance {
                lock: Some(file),
                socket,
            }),
            Err(LockError::Taken) => {
                let handed = unix::hand_over(&socket, paths);
                let message = format!(
                    "Oriel is already running on {}; this start exits without opening \
                     anything{}.",
                    data.root().display(),
                    match handed {
                        Ok(()) if paths.is_empty() => ", and the running one comes to the front",
                        Ok(()) => ", and the running one opens its files",
                        Err(_) => "",
                    }
                );
                if let Err(error) = handed {
                    log::warn!("the running Oriel did not answer: {error}");
                }
                log::error!("{message}");
                eprintln!("{message}");
                Claim::Handed
            }
            // The lock could not be made at all: run, rather than refuse to start.
            Err(LockError::Failed(error)) => {
                log::warn!("no single-instance lock: {error}");
                Claim::First(Instance { lock: None, socket })
            }
        }
    }
}

impl Instance {
    /// Sends what each later launch hands over to `opened`: its paths, or none for "show the
    /// window". The lock stays held from here until the process ends.
    pub fn listen(self, opened: UnboundedSender<Vec<PathBuf>>) {
        #[cfg(windows)]
        windows::listen(self.name, opened);
        #[cfg(not(windows))]
        {
            if let Some(lock) = self.lock {
                // Closing the file would free the lock; the process ending frees it instead.
                std::mem::forget(lock);
                unix::listen(&self.socket, opened);
            }
        }
    }
}

#[cfg(not(windows))]
mod unix {
    use std::io::{Read as _, Write as _};
    use std::os::unix::net::{UnixListener, UnixStream};
    use std::path::{Path, PathBuf};

    use futures::channel::mpsc::UnboundedSender;

    use super::{decode, encode};

    /// Writes `paths` to the running instance's socket.
    pub(super) fn hand_over(socket: &Path, paths: &[PathBuf]) -> std::io::Result<()> {
        let mut stream = UnixStream::connect(socket)?;
        stream.write_all(encode(paths).as_bytes())
    }

    /// Listens on `socket`, replacing the one a previous instance left, and sends each later
    /// start's paths to `opened`. Called only while this process holds the lock, so whatever is
    /// at `socket` is stale.
    pub(super) fn listen(socket: &Path, opened: UnboundedSender<Vec<PathBuf>>) {
        let _ = std::fs::remove_file(socket);
        let listener = match UnixListener::bind(socket) {
            Ok(listener) => listener,
            Err(error) => {
                log::warn!("no single-instance socket at {}: {error}", socket.display());
                return;
            }
        };
        let spawned = std::thread::Builder::new()
            .name("single-instance".into())
            .spawn(move || {
                for client in listener.incoming() {
                    let Ok(mut client) = client else {
                        continue;
                    };
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
                    log::warn!("the running Oriel did not answer: {error}");
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

    /// The rule that keeps a second copy of the app off a data folder in use: the lock holds
    /// while its file is open, against any other open of it, and frees when the holder ends.
    #[cfg(not(windows))]
    #[test]
    fn a_second_start_on_the_same_data_folder_finds_it_taken() {
        let root = std::env::temp_dir().join(format!("oriel-lock-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let held = super::lock(&root).unwrap();
        assert!(matches!(super::lock(&root), Err(super::LockError::Taken)));
        // The same folder by another spelling is the same file.
        let linked = std::env::temp_dir().join(format!("oriel-lock-link-{}", std::process::id()));
        let _ = std::fs::remove_file(&linked);
        std::os::unix::fs::symlink(&root, &linked).unwrap();
        assert!(matches!(super::lock(&linked), Err(super::LockError::Taken)));
        drop(held);
        let again = super::lock(&linked).unwrap();
        drop(again);
        std::fs::remove_file(&linked).unwrap();
        std::fs::remove_dir_all(&root).unwrap();
    }

    /// A second start finds the first listening and hands its paths over, or none for "show
    /// the window", rather than running beside it.
    #[cfg(not(windows))]
    #[test]
    fn a_second_start_hands_its_paths_to_the_first() {
        use futures::StreamExt as _;

        use super::{Claim, claim};

        let root = std::env::temp_dir().join(format!("oriel-hand-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let data = oriel_core_paths::DataRoot::at(root.clone()).unwrap();
        let Claim::First(first) = claim(&data, &[]) else {
            panic!("the first start did not take the lock");
        };
        let (opened, mut received) = futures::channel::mpsc::unbounded();
        first.listen(opened);
        let paths = [PathBuf::from("/tmp/a.jpg"), PathBuf::from("/tmp/Holiday")];
        assert!(matches!(claim(&data, &paths), Claim::Handed));
        assert_eq!(
            futures::executor::block_on(received.next()),
            Some(paths.to_vec())
        );
        assert!(matches!(claim(&data, &[]), Claim::Handed));
        assert_eq!(futures::executor::block_on(received.next()), Some(vec![]));
        // The lock outlives `listen`, so a third start is still turned away.
        assert!(matches!(super::lock(&root), Err(super::LockError::Taken)));
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn names_the_lock_after_the_data_folder() {
        let owner = lock_name(Path::new("/Users/owner/.latch-works/oriel"));
        assert_eq!(
            owner,
            lock_name(Path::new("/Users/owner/.latch-works/oriel"))
        );
        assert_ne!(owner, lock_name(Path::new("/tmp/check/data")));
        assert!(owner.starts_with("dev.traydr.latchworks.oriel-"));
    }
}
