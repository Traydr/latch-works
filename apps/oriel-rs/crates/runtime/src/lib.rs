//! Oriel RS's background work, with no domain logic in it:
//!
//! - [`Job`]: work on GPUI's background executor that reports progress, can be cancelled, and
//!   finishes with a value or an error, all observed by the UI as an entity;
//! - [`CancelToken`]: the cooperative cancellation jobs, tool runs and catalogs share;
//! - [`PauseToken`]: the cooperative pause beside it, which the work waits on between steps;
//! - [`TokioRuntime`]: a tokio runtime on its own thread, for the HTTP clients that need one;
//! - [`Database`]: one SQLite connection per catalog, on its own thread, called from async code;
//! - [`release_free_memory`]: heavy work hands its memory back to the system when it is done;
//! - [`fs_meta`]: a file's size, times and identity as Node's `fs.stat` gives them, on Windows too;
//! - [`paths`]: paths as Node writes them on Windows, and the long form a C library opens.

mod cancel;
pub mod fs_meta;
mod job;
mod memory;
pub mod paths;
mod pause;
mod sqlite;
mod tokio_runtime;

use std::any::Any;

pub use cancel::{CancelCallback, CancelToken, Cancelled};
pub use job::{Job, JobError, JobEvent, JobProgress, JobReporter, JobStatus};
pub use memory::release_free_memory;
pub use pause::{PauseCallback, PauseToken};
pub use sqlite::{Database, migrate};
pub use tokio_runtime::{TokioHandle, TokioRuntime, TokioTask};

/// The message a panic carried, for the error that reports it.
pub(crate) fn panic_message(payload: Box<dyn Any + Send>) -> String {
    payload
        .downcast_ref::<&str>()
        .map(|message| (*message).to_owned())
        .or_else(|| payload.downcast_ref::<String>().cloned())
        .unwrap_or_else(|| "no message".to_owned())
}
