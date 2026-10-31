//! Running ffmpeg and ffprobe, ported from glazier-core's `media/run-tool.ts`: killed at its
//! timeout or when its token is cancelled, stdout kept as bytes up to a bound, the end of stderr
//! kept for messages, and the exit status. A non-zero exit is not an error; callers read the
//! status. As in the TypeScript, the kill is `SIGKILL` to the tool alone: ffmpeg and ffprobe start
//! no processes of their own, so there is no group to kill.

use std::collections::BTreeMap;
use std::ffi::OsString;
use std::fmt;
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError, mpsc};
use std::time::{Duration, Instant};

use oriel_runtime::CancelToken;

/// Most ffmpeg output Tidy reads is a 1 KiB frame or a JSON probe; 64 MiB bounds a runaway. A
/// run that writes more is killed, and keeps the first 64 MiB.
pub const MAX_STDOUT_BYTES: usize = 64 * 1024 * 1024;

/// ffmpeg's interesting lines are at the end of stderr; the last 64 KiB are kept.
pub const MAX_STDERR_BYTES: usize = 64 * 1024;

const READ_CHUNK: usize = 64 * 1024;

/// One run of a tool: what to run, with which arguments, for how long at most.
#[derive(Clone, Debug)]
pub struct ToolRun {
    executable: PathBuf,
    args: Vec<OsString>,
    timeout: Duration,
    cancel: Option<CancelToken>,
}

impl ToolRun {
    /// A run of `executable` that is killed if it lasts longer than `timeout`.
    pub fn new(executable: impl Into<PathBuf>, timeout: Duration) -> Self {
        Self {
            executable: executable.into(),
            args: Vec::new(),
            timeout,
            cancel: None,
        }
    }

    pub fn arg(mut self, arg: impl Into<OsString>) -> Self {
        self.args.push(arg.into());
        self
    }

    pub fn args<I>(mut self, args: I) -> Self
    where
        I: IntoIterator,
        I::Item: Into<OsString>,
    {
        self.args.extend(args.into_iter().map(Into::into));
        self
    }

    /// Kills the run when `token` is cancelled, and fails it with [`ToolError::Cancelled`].
    pub fn cancel_on(mut self, token: &CancelToken) -> Self {
        self.cancel = Some(token.clone());
        self
    }

    pub fn executable(&self) -> &Path {
        &self.executable
    }

    fn is_cancelled(&self) -> bool {
        self.cancel.as_ref().is_some_and(CancelToken::is_cancelled)
    }

    /// Runs the tool to its end, blocking this thread, so call it from background work. Fails
    /// only when the tool cannot start, when reading from it fails, or when it was cancelled.
    pub fn run(&self) -> Result<ToolOutput, ToolError> {
        if self.is_cancelled() {
            return Err(ToolError::Cancelled);
        }
        let mut command = Command::new(&self.executable);
        command
            .args(&self.args)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        hide_console_window(&mut command);
        let mut child = command.spawn().map_err(|source| ToolError::Start {
            executable: self.executable.clone(),
            source,
        })?;
        let stdout = child.stdout.take().expect("stdout is piped");
        let stderr = child.stderr.take().expect("stderr is piped");
        let running = Running::register(child);

        let (events, received) = mpsc::channel();
        let _cancel = self.cancel.as_ref().map(|token| {
            let events = events.clone();
            token.on_cancel(move || {
                let _ = events.send(Event::Cancel);
            })
        });
        let deadline = Instant::now().checked_add(self.timeout);

        let collected = std::thread::scope(|scope| {
            let stdout_events = events.clone();
            let stderr_events = events;
            let readers = std::thread::Builder::new()
                .name("tool stdout".to_owned())
                .spawn_scoped(scope, move || read_stdout(stdout, &stdout_events))
                .and_then(|_| {
                    std::thread::Builder::new()
                        .name("tool stderr".to_owned())
                        .spawn_scoped(scope, move || read_stderr(stderr, &stderr_events))
                });
            if let Err(error) = readers {
                // A reader that did start ends at the end of its pipe, once the tool is dead.
                running.kill();
                return Err(error);
            }
            Ok(collect(&received, deadline, &running))
        });
        let status = running.finish().map_err(ToolError::Io)?;
        let collected = collected.map_err(ToolError::Io)?;

        if collected.cancelled || self.is_cancelled() {
            return Err(ToolError::Cancelled);
        }
        Ok(ToolOutput {
            status,
            stdout: collected.stdout,
            stderr: collected.stderr,
            timed_out: collected.timed_out,
        })
    }
}

/// What a finished run produced.
#[derive(Debug)]
#[non_exhaustive]
pub struct ToolOutput {
    /// How the tool exited. One killed for its timeout, its stdout bound or
    /// [`kill_running_tools`] has no exit code.
    pub status: ExitStatus,
    pub stdout: Vec<u8>,
    /// The last [`MAX_STDERR_BYTES`] of stderr, as UTF-8 with bad bytes replaced.
    pub stderr: String,
    /// Whether the run was killed for lasting longer than its timeout.
    pub timed_out: bool,
}

impl ToolOutput {
    /// The exit code, `None` when the tool was killed.
    pub fn code(&self) -> Option<i32> {
        self.status.code()
    }

    pub fn success(&self) -> bool {
        self.status.success()
    }
}

/// Why a run produced no output.
#[derive(Debug)]
pub enum ToolError {
    /// The tool could not start: missing, not executable, or the system out of processes.
    Start {
        executable: PathBuf,
        source: io::Error,
    },
    /// The run's token was cancelled, before it started or while it ran; the tool was killed.
    Cancelled,
    /// Reading from the tool or waiting for it failed.
    Io(io::Error),
}

impl ToolError {
    pub fn is_cancelled(&self) -> bool {
        matches!(self, Self::Cancelled)
    }
}

impl fmt::Display for ToolError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Start { executable, .. } => write!(f, "starting {}", executable.display()),
            Self::Cancelled => f.write_str("cancelled"),
            Self::Io(_) => f.write_str("running the tool"),
        }
    }
}

impl std::error::Error for ToolError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Start { source, .. } | Self::Io(source) => Some(source),
            Self::Cancelled => None,
        }
    }
}

/// Kills every tool this process started that is still running. The app calls it as it quits: a
/// child process outlives its parent, and a long ffmpeg would keep running. Each run then
/// finishes with no exit code.
pub fn kill_running_tools() {
    for child in lock(&RUNNING).values() {
        let _ = lock(child).kill();
    }
}

/// Every tool still running, so [`kill_running_tools`] can reach it.
static RUNNING: Mutex<BTreeMap<u64, Arc<Mutex<Child>>>> = Mutex::new(BTreeMap::new());

static NEXT_RUN: AtomicU64 = AtomicU64::new(0);

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// A started tool, registered in [`RUNNING`] until it is reaped. Once reaped, its process id can
/// belong to another process, so it leaves the registry first and is killed only through its
/// `Child`, which knows when it has been reaped.
struct Running {
    id: u64,
    child: Arc<Mutex<Child>>,
}

impl Running {
    fn register(child: Child) -> Self {
        let id = NEXT_RUN.fetch_add(1, Ordering::Relaxed);
        let child = Arc::new(Mutex::new(child));
        lock(&RUNNING).insert(id, child.clone());
        Self { id, child }
    }

    fn kill(&self) {
        let _ = lock(&self.child).kill();
    }

    /// Leaves the registry and reaps the tool. Called once both pipes have ended, when the tool
    /// has exited or is exiting.
    fn finish(&self) -> io::Result<ExitStatus> {
        lock(&RUNNING).remove(&self.id);
        lock(&self.child).wait()
    }
}

impl Drop for Running {
    /// Leaves no tool running and no zombie behind if the run unwinds.
    fn drop(&mut self) {
        lock(&RUNNING).remove(&self.id);
        let mut child = lock(&self.child);
        let _ = child.kill();
        let _ = child.wait();
    }
}

enum Event {
    Stdout(Vec<u8>),
    Stderr(String),
    Overflow,
    Cancel,
}

struct Collected {
    stdout: Vec<u8>,
    stderr: String,
    timed_out: bool,
    cancelled: bool,
}

/// Waits for both pipes to end, killing the tool at the deadline, past the stdout bound, or on
/// cancel, then still waiting for the pipes, which end once the tool is dead.
fn collect(
    received: &mpsc::Receiver<Event>,
    deadline: Option<Instant>,
    running: &Running,
) -> Collected {
    let mut stdout = None;
    let mut stderr = None;
    let (mut timed_out, mut cancelled, mut killed) = (false, false, false);
    while stdout.is_none() || stderr.is_none() {
        let event = match deadline.filter(|_| !killed) {
            Some(deadline) => {
                match received.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
                    Ok(event) => Some(event),
                    Err(mpsc::RecvTimeoutError::Timeout) => {
                        timed_out = true;
                        killed = true;
                        running.kill();
                        continue;
                    }
                    Err(mpsc::RecvTimeoutError::Disconnected) => None,
                }
            }
            None => received.recv().ok(),
        };
        match event {
            Some(Event::Stdout(bytes)) => stdout = Some(bytes),
            Some(Event::Stderr(text)) => stderr = Some(text),
            Some(Event::Overflow) => {
                killed = true;
                running.kill();
            }
            Some(Event::Cancel) => {
                cancelled = true;
                killed = true;
                running.kill();
            }
            // Both readers are gone without a word, which only a panic in one does.
            None => break,
        }
    }
    Collected {
        stdout: stdout.unwrap_or_default(),
        stderr: stderr.unwrap_or_default(),
        timed_out,
        cancelled,
    }
}

/// Keeps the first [`MAX_STDOUT_BYTES`], asks for a kill past them, and drains the pipe to its
/// end so the tool never blocks on a full pipe.
fn read_stdout(mut pipe: impl Read, events: &mpsc::Sender<Event>) {
    let mut kept = Vec::new();
    let mut chunk = vec![0; READ_CHUNK];
    let mut overflowed = false;
    while let Some(read) = read_some(&mut pipe, &mut chunk) {
        if overflowed {
            continue;
        }
        let room = MAX_STDOUT_BYTES - kept.len();
        if read > room {
            kept.extend_from_slice(&chunk[..room]);
            overflowed = true;
            let _ = events.send(Event::Overflow);
        } else {
            kept.extend_from_slice(&chunk[..read]);
        }
    }
    let _ = events.send(Event::Stdout(kept));
}

/// Keeps the last [`MAX_STDERR_BYTES`]. The buffer may grow to twice that between trims, so a
/// chatty tool costs one copy per 64 KiB, not one per line.
fn read_stderr(mut pipe: impl Read, events: &mpsc::Sender<Event>) {
    let mut tail = Vec::new();
    let mut chunk = vec![0; READ_CHUNK];
    let mut cut = false;
    while let Some(read) = read_some(&mut pipe, &mut chunk) {
        tail.extend_from_slice(&chunk[..read]);
        if tail.len() > 2 * MAX_STDERR_BYTES {
            tail.drain(..tail.len() - MAX_STDERR_BYTES);
            cut = true;
        }
    }
    if tail.len() > MAX_STDERR_BYTES {
        tail.drain(..tail.len() - MAX_STDERR_BYTES);
        cut = true;
    }
    let _ = events.send(Event::Stderr(decode_tail(&tail, cut)));
}

/// The next read's length, or `None` at the end of the pipe or when it fails.
fn read_some(pipe: &mut impl Read, chunk: &mut [u8]) -> Option<usize> {
    loop {
        match pipe.read(chunk) {
            Ok(0) => return None,
            Ok(read) => return Some(read),
            Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
            Err(_) => return None,
        }
    }
}

/// Decodes the kept end of stderr. A cut can land inside a character; its leftover bytes are
/// dropped rather than shown as a replacement character.
fn decode_tail(tail: &[u8], cut: bool) -> String {
    let start = if cut {
        tail.iter()
            .take(3)
            .take_while(|byte| **byte & 0xC0 == 0x80)
            .count()
    } else {
        0
    };
    String::from_utf8_lossy(&tail[start..]).into_owned()
}

/// Windows would open a console window for each run; the TypeScript asks Node to hide it.
fn hide_console_window(command: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt as _;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(not(windows))]
    let _ = command;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_cut_tail_drops_the_rest_of_a_split_character() {
        let text = "é stays, ü too";
        let bytes = text.as_bytes();
        assert_eq!(decode_tail(&bytes[1..], true), " stays, ü too");
        assert_eq!(decode_tail(bytes, false), text);
    }
}
