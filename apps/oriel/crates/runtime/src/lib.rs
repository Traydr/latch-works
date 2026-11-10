//! Oriel's background work, with no domain logic and no UI in it (jobs the UI observes are
//! `oriel_ui::job`'s, built on these):
//!
//! - [`CancelToken`]: the cooperative cancellation jobs, tool runs and catalogs share;
//! - [`PauseToken`]: the cooperative pause beside it, which the work waits on between steps;
//! - [`TokioRuntime`]: a tokio runtime on its own thread, for the HTTP clients that need one;
//! - [`Database`]: one SQLite connection per catalog, on its own thread, called from async code;
//! - [`release_free_memory`]: heavy work hands its memory back to the system when it is done;
//! - [`ProcessUsage`]: a process's memory and CPU time, for the spikes and xtask's `measure`;
//! - [`run_queue`]: a bounded pool of worker threads that tasks can add to;
//! - [`fs_meta`]: a file's size, times and identity as Node's `fs.stat` gives them, on Windows too,
//!   and a folder's entries with them;
//! - [`paths`]: a folder's real path as Node writes it on Windows.

mod cancel;
pub mod fs_meta;
mod memory;
pub mod paths;
mod pause;
mod pool;
mod process;
mod sqlite;
mod tokio_runtime;
mod watchers;

use std::any::Any;

pub use cancel::{
    CancelCallback, CancelToken, Cancelled, HoldWatch, set_keep_running, tools_suspend,
};
pub use memory::release_free_memory;
pub use pause::{PauseCallback, PauseToken};
pub use pool::{Queue, run_queue};
pub use process::{ProcessUsage, thread_cpu_ms};
pub use sqlite::Database;
pub use tokio_runtime::{TokioHandle, TokioRuntime, TokioTask};

/// The message a panic carried, for the error that reports it.
pub fn panic_message(payload: Box<dyn Any + Send>) -> String {
    payload
        .downcast_ref::<&str>()
        .map(|message| (*message).to_owned())
        .or_else(|| payload.downcast_ref::<String>().cloned())
        .unwrap_or_else(|| "no message".to_owned())
}
