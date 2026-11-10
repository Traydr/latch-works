//! The engine's work on a thread of its own, as the Tidy UI runs it, with what it reported: its
//! phases, whether it waits for its turn or runs in the background, and its pause and stop.

use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::Duration;

use oriel_core_tidy::{Progress, Queued, Quiet};
use oriel_runtime::{CancelToken, Cancelled, PauseToken};

/// What a piece of work said about itself.
#[derive(Default)]
struct Seen {
    phases: Vec<String>,
    waiting: bool,
    background: bool,
}

/// Progress the test watches, pauses and stops. Its pause holds the tools of asked-for work, as
/// the UI's jobs do; background work lets them finish their file.
#[derive(Default)]
pub struct Watched {
    quiet: Quiet,
    seen: Mutex<Seen>,
}

impl Watched {
    pub fn phases(&self) -> Vec<String> {
        self.seen.lock().unwrap().phases.clone()
    }

    pub fn is_waiting(&self) -> bool {
        self.seen.lock().unwrap().waiting
    }

    pub fn is_background(&self) -> bool {
        self.seen.lock().unwrap().background
    }

    pub fn is_paused(&self) -> bool {
        self.quiet.pause().is_paused()
    }

    pub fn pause(&self) {
        self.quiet.pause().pause();
    }

    pub fn resume(&self) {
        self.quiet.pause().resume();
    }

    pub fn cancel(&self) {
        self.quiet.pause().resume();
        self.quiet.token().cancel();
    }
}

impl Progress for Watched {
    fn phase(&self, label: &str, _: u64) {
        let mut seen = self.seen.lock().unwrap();
        if seen.phases.last().map(String::as_str) != Some(label) {
            seen.phases.push(label.to_owned());
        }
    }

    fn done(&self, _: u64) {}

    fn cancel_token(&self) -> Option<&CancelToken> {
        Some(self.quiet.token())
    }

    fn pause_token(&self) -> Option<&PauseToken> {
        Some(self.quiet.pause())
    }

    fn waiting(&self, waiting: bool) {
        self.seen.lock().unwrap().waiting = waiting;
    }

    fn background(&self, background: bool) {
        self.seen.lock().unwrap().background = background;
        self.quiet.pause().set_background(background);
    }
}

/// Queued work running on a thread of its own.
pub struct Running<T> {
    pub progress: Arc<Watched>,
    thread: Option<JoinHandle<anyhow::Result<T>>>,
}

impl<T: Send + 'static> Running<T> {
    pub fn start(work: Queued<T>) -> Self {
        let progress = Arc::new(Watched::default());
        let watched = progress.clone();
        Self {
            progress,
            thread: Some(std::thread::spawn(move || work.run(watched.as_ref()))),
        }
    }

    pub fn is_running(&self) -> bool {
        self.thread
            .as_ref()
            .is_some_and(|thread| !thread.is_finished())
    }

    /// Its result, once it ends.
    pub fn finish(mut self) -> anyhow::Result<T> {
        self.thread
            .take()
            .expect("finished once")
            .join()
            .expect("the work panicked")
    }
}

/// Whether `error` says the work was stopped.
pub fn is_cancelled(error: &anyhow::Error) -> bool {
    error.chain().any(|cause| cause.is::<Cancelled>())
}

/// Waits, a few milliseconds at a time, until `ready` holds; fails after a minute.
pub fn until(what: &str, ready: impl Fn() -> bool) {
    for _ in 0..6000 {
        if ready() {
            return;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    panic!("gave up waiting for {what}");
}
