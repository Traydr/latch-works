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
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError, mpsc};
use std::time::{Duration, Instant};

use oriel_runtime::CancelToken;

/// Most ffmpeg output Tidy reads is a 1 KiB frame or a JSON probe; 64 MiB bounds a runaway. A
/// run that writes more is killed, and keeps the first 64 MiB.
pub const MAX_STDOUT_BYTES: usize = 64 * 1024 * 1024;

/// ffmpeg's interesting lines are at the end of stderr; the last 64 KiB are kept.
pub const MAX_STDERR_BYTES: usize = 64 * 1024;

const READ_CHUNK: usize = 64 * 1024;

/// What hears each piece of a tool's stdout as it arrives.
type OnStdout<'a> = dyn Fn(&[u8]) + Send + Sync + 'a;

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
        self.run_reading(None)
    }

    /// [`Self::run`] for a tool that reports as it goes: `on_stdout` sees each piece of its stdout
    /// as it arrives, none of which is kept, so a run of any length stays within the bound.
    pub fn run_streaming(&self, on_stdout: &OnStdout) -> Result<ToolOutput, ToolError> {
        self.run_reading(Some(on_stdout))
    }

    fn run_reading(&self, on_stdout: Option<&OnStdout<'_>>) -> Result<ToolOutput, ToolError> {
        if self.is_cancelled() || quitting() {
            return Err(ToolError::Cancelled);
        }
        let mut command = Command::new(&self.executable);
        command
            .args(&self.args)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        hide_console_window(&mut command);
        let mut child = spawn(&mut command).map_err(|source| ToolError::Start {
            executable: self.executable.clone(),
            source,
        })?;
        let stdout = child.stdout.take().expect("stdout is piped");
        let stderr = child.stderr.take().expect("stderr is piped");
        let running = Running::register(child);
        // Registered as the quit went through the list, so the quit may not have seen it.
        if quitting() {
            running.kill();
        }

        let (events, received) = mpsc::channel();
        let _cancel = self.cancel.as_ref().map(|token| {
            let events = events.clone();
            token.on_cancel(move || {
                let _ = events.send(Event::Cancel);
            })
        });
        let _hold = self.cancel.as_ref().map(|token| {
            let events = events.clone();
            token.on_hold(move |held| {
                let _ = events.send(Event::Hold(held));
            })
        });
        let deadline = Instant::now().checked_add(self.timeout);

        let collected = std::thread::scope(|scope| {
            let stdout_events = events.clone();
            let stderr_events = events;
            let readers = std::thread::Builder::new()
                .name("tool stdout".to_owned())
                .spawn_scoped(scope, move || {
                    read_stdout(stdout, &stdout_events, on_stdout)
                })
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
        let (status, killed) = running.finish().map_err(ToolError::Io)?;
        let collected = collected.map_err(ToolError::Io)?;

        if collected.cancelled || self.is_cancelled() || quitting() {
            return Err(ToolError::Cancelled);
        }
        if !killed && told_to_stop(&status) {
            return Err(ToolError::Killed);
        }
        Ok(ToolOutput {
            status,
            stdout: collected.stdout,
            stderr: collected.stderr,
            timed_out: collected.timed_out,
            killed,
        })
    }
}

/// What a finished run produced.
#[derive(Debug)]
#[non_exhaustive]
pub struct ToolOutput {
    /// How the tool exited. Windows gives a killed tool an exit code here, so read the code from
    /// [`ToolOutput::code`].
    pub status: ExitStatus,
    pub stdout: Vec<u8>,
    /// The last [`MAX_STDERR_BYTES`] of stderr, as UTF-8 with bad bytes replaced.
    pub stderr: String,
    /// Whether the run was killed for lasting longer than its timeout.
    pub timed_out: bool,
    /// Whether the tool was killed, for its timeout or its stdout bound.
    killed: bool,
}

impl ToolOutput {
    /// The exit code, `None` when the tool was killed. A process Windows terminates still
    /// has an exit code (1, from `TerminateProcess`), so the kill is checked there too.
    pub fn code(&self) -> Option<i32> {
        if cfg!(windows) && self.killed {
            return None;
        }
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
    /// The run's token was cancelled or the app is quitting, before it started or while it ran;
    /// the tool was killed.
    Cancelled,
    /// Something other than this app stopped the tool: the system, short of memory, or the owner.
    /// That says nothing about what it was reading, so a pass records nothing and goes on.
    Killed,
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
            Self::Killed => f.write_str("the tool was stopped from outside the app"),
            Self::Io(_) => f.write_str("running the tool"),
        }
    }
}

impl std::error::Error for ToolError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Start { source, .. } | Self::Io(source) => Some(source),
            Self::Cancelled | Self::Killed => None,
        }
    }
}

/// Set, tools run on when their job is paused, as they do where they cannot be suspended, to see
/// what the app says then on a machine where they can.
pub const KEEP_RUNNING_VARIABLE: &str = "ORIEL_TOOLS_KEEP_RUNNING";

/// Whether a tool in the middle of a file stops at once when its job is paused. Where it cannot,
/// it runs to the end of that file, and the app says "Pausing" until it has.
pub fn tools_suspend() -> bool {
    cfg!(unix) && std::env::var_os(KEEP_RUNNING_VARIABLE).is_none()
}

/// Kills every tool this process started that is still running, and refuses any more. The app
/// calls it as it quits: a child process outlives its parent, and a long ffmpeg would keep
/// running. Each run then finishes as [`ToolError::Cancelled`], so the work that asked for it
/// records nothing about the file before the process ends.
pub fn kill_running_tools() {
    QUITTING.store(true, Ordering::SeqCst);
    for tool in lock(&RUNNING).values() {
        lock(tool).kill();
    }
}

/// Set by [`kill_running_tools`], for good: the process is on its way out.
static QUITTING: AtomicBool = AtomicBool::new(false);

fn quitting() -> bool {
    QUITTING.load(Ordering::SeqCst)
}

/// Whether the tool ended on a signal that says stop rather than what it was reading: `SIGSEGV` on
/// a bad file stays that file's failure. Windows does not say how a process was ended.
#[cfg(unix)]
fn told_to_stop(status: &ExitStatus) -> bool {
    use std::os::unix::process::ExitStatusExt as _;
    matches!(status.signal(), Some(libc::SIGKILL | libc::SIGTERM))
}

#[cfg(not(unix))]
fn told_to_stop(_: &ExitStatus) -> bool {
    false
}

/// Every tool still running, so [`kill_running_tools`] can reach it.
static RUNNING: Mutex<BTreeMap<u64, Arc<Mutex<Tool>>>> = Mutex::new(BTreeMap::new());

static NEXT_RUN: AtomicU64 = AtomicU64::new(0);

/// Held while a process starts. On macOS the standard library makes a pipe and marks it
/// close-on-exec in two steps, so a process another thread started in between inherited the pipe.
/// A quick probe then read no end of output until that process, perhaps an encode of several
/// minutes, ended, and the pass waiting on the probe waited as long.
static STARTING: Mutex<()> = Mutex::new(());

/// Starts `command` as no other process this app starts through here is starting, so neither
/// inherits the other's pipes. Only starts made through here are kept apart: anything that runs
/// alongside tools should start this way.
pub fn spawn(command: &mut Command) -> std::io::Result<Child> {
    let _starting = lock(&STARTING);
    command.spawn()
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// A started tool, registered in [`RUNNING`] until it is reaped. Once reaped, its process id can
/// belong to another process, so it leaves the registry first and is killed only through its
/// `Child`, which knows when it has been reaped.
struct Running {
    id: u64,
    tool: Arc<Mutex<Tool>>,
}

/// A tool's process, and whether anything has killed it.
struct Tool {
    child: Child,
    killed: bool,
    /// While the tool is suspended, what kills it should this app die first.
    watcher: Option<Child>,
}

impl Tool {
    fn kill(&mut self) {
        self.killed = true;
        self.end_watcher();
        // A suspended process takes a kill as any other does.
        let _ = self.child.kill();
    }

    fn end_watcher(&mut self) {
        if let Some(mut watcher) = self.watcher.take() {
            let _ = watcher.kill();
            let _ = watcher.wait();
        }
    }

    /// Stops the process where it is, keeping what it holds in memory and its files open. Left
    /// suspended it would never end by itself, so a small shell waits on a pipe only this app
    /// holds: if the app dies, the pipe closes, and the shell kills the tool.
    #[cfg(unix)]
    fn suspend(&mut self) {
        let pid = self.child.id();
        self.watcher = spawn(
            Command::new("/bin/sh")
                .args(["-c", "read -r _; kill -KILL \"$1\"", "oriel-tool-watch"])
                .arg(pid.to_string())
                .stdin(Stdio::piped())
                .stdout(Stdio::null())
                .stderr(Stdio::null()),
        )
        .ok();
        // SAFETY: `kill` takes no pointers, and this child has not been waited for, so its id
        // cannot have been given to another process.
        unsafe { libc::kill(pid as libc::pid_t, libc::SIGSTOP) };
    }

    #[cfg(unix)]
    fn resume(&mut self) {
        self.end_watcher();
        // SAFETY: as in `suspend`.
        unsafe { libc::kill(self.child.id() as libc::pid_t, libc::SIGCONT) };
    }

    /// Windows has no documented call to suspend a process, so a tool runs to its end there and
    /// the app says so: see [`tools_suspend`].
    #[cfg(not(unix))]
    fn suspend(&mut self) {}

    #[cfg(not(unix))]
    fn resume(&mut self) {}
}

impl Running {
    fn register(child: Child) -> Self {
        let id = NEXT_RUN.fetch_add(1, Ordering::Relaxed);
        let tool = Arc::new(Mutex::new(Tool {
            child,
            killed: false,
            watcher: None,
        }));
        lock(&RUNNING).insert(id, tool.clone());
        Self { id, tool }
    }

    fn suspend(&self) {
        lock(&self.tool).suspend();
    }

    fn resume(&self) {
        lock(&self.tool).resume();
    }

    fn kill(&self) {
        lock(&self.tool).kill();
    }

    /// Leaves the registry and reaps the tool, giving how it exited and whether it was killed.
    /// Called once both pipes have ended, when the tool has exited or is exiting.
    fn finish(&self) -> io::Result<(ExitStatus, bool)> {
        lock(&RUNNING).remove(&self.id);
        let mut tool = lock(&self.tool);
        Ok((tool.child.wait()?, tool.killed))
    }
}

impl Drop for Running {
    /// Leaves no tool running and no zombie behind if the run unwinds.
    fn drop(&mut self) {
        lock(&RUNNING).remove(&self.id);
        let mut tool = lock(&self.tool);
        tool.kill();
        let _ = tool.child.wait();
    }
}

enum Event {
    /// The tool's job was paused, or went on.
    Hold(bool),
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
    let mut deadline = deadline;
    // While the tool is held it does no work, so none of its time passes.
    let mut held_since = None;
    while stdout.is_none() || stderr.is_none() {
        let event = match deadline.filter(|_| !killed && held_since.is_none()) {
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
            Some(Event::Hold(true)) if !killed && held_since.is_none() && tools_suspend() => {
                running.suspend();
                held_since = Some(Instant::now());
            }
            Some(Event::Hold(false)) => {
                if let Some(since) = held_since.take() {
                    running.resume();
                    deadline = deadline.and_then(|at| at.checked_add(since.elapsed()));
                }
            }
            Some(Event::Hold(true)) => {}
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
fn read_stdout(
    mut pipe: impl Read,
    events: &mpsc::Sender<Event>,
    on_stdout: Option<&OnStdout<'_>>,
) {
    let mut kept = Vec::new();
    let mut chunk = vec![0; READ_CHUNK];
    let mut overflowed = false;
    while let Some(read) = read_some(&mut pipe, &mut chunk) {
        if let Some(on_stdout) = on_stdout {
            on_stdout(&chunk[..read]);
            continue;
        }
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

    /// A tool that counts up on stdout, a little at a time, and how many it has said.
    #[cfg(unix)]
    fn counter(token: &CancelToken) -> (ToolRun, Arc<std::sync::atomic::AtomicUsize>) {
        let run = ToolRun::new("/bin/sh", Duration::from_secs(60))
            .args([
                "-c",
                "i=0; while [ $i -lt 40 ]; do echo $i; i=$((i+1)); sleep 0.05; done",
            ])
            .cancel_on(token);
        (run, Arc::default())
    }

    #[cfg(unix)]
    fn wait_for(what: &str, ready: impl Fn() -> bool) {
        let deadline = Instant::now() + Duration::from_secs(20);
        while !ready() {
            assert!(Instant::now() < deadline, "timed out waiting for {what}");
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    #[cfg(unix)]
    #[test]
    fn a_held_tool_stops_where_it_is_and_finishes_when_let_go() {
        let token = CancelToken::new();
        let (run, said) = counter(&token);
        let counted = said.clone();
        let tool = std::thread::spawn(move || {
            run.run_streaming(&|piece: &[u8]| {
                let lines = piece.iter().filter(|byte| **byte == b'\n').count();
                counted.fetch_add(lines, Ordering::SeqCst);
            })
        });
        wait_for("the tool to start", || said.load(Ordering::SeqCst) >= 3);
        token.hold(true);
        std::thread::sleep(Duration::from_millis(300));
        let at_hold = said.load(Ordering::SeqCst);
        std::thread::sleep(Duration::from_millis(500));
        assert_eq!(
            said.load(Ordering::SeqCst),
            at_hold,
            "it went on while held"
        );
        token.hold(false);
        let output = tool.join().unwrap().unwrap();
        assert!(output.success());
        assert_eq!(said.load(Ordering::SeqCst), 40);
    }

    #[cfg(unix)]
    #[test]
    fn a_held_tool_stops_for_good_when_cancelled() {
        let token = CancelToken::new();
        let (run, said) = counter(&token);
        let counted = said.clone();
        let tool = std::thread::spawn(move || {
            run.run_streaming(&|piece: &[u8]| {
                let lines = piece.iter().filter(|byte| **byte == b'\n').count();
                counted.fetch_add(lines, Ordering::SeqCst);
            })
        });
        wait_for("the tool to start", || said.load(Ordering::SeqCst) >= 3);
        token.hold(true);
        std::thread::sleep(Duration::from_millis(200));
        token.cancel();
        assert!(matches!(tool.join().unwrap(), Err(ToolError::Cancelled)));
    }

    #[test]
    fn a_cut_tail_drops_the_rest_of_a_split_character() {
        let text = "é stays, ü too";
        let bytes = text.as_bytes();
        assert_eq!(decode_tail(&bytes[1..], true), " stays, ü too");
        assert_eq!(decode_tail(bytes, false), text);
    }
}
