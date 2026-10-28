//! Oriel GPUI's background work, with no domain logic in it:
//!
//! - [`Job`]: work on GPUI's background executor that reports progress, can be cancelled, and
//!   finishes with a value or an error, all observed by the UI as an entity;
//! - [`CancelToken`]: the cooperative cancellation jobs, tool runs and catalogs share;
//! - [`TokioRuntime`]: a tokio runtime on its own thread, for the HTTP clients that need one;
//! - [`Database`]: one SQLite connection per catalog, on its own thread, called from async code.

mod cancel;
mod job;
mod sqlite;
mod tokio_runtime;

use std::any::Any;

pub use cancel::{CancelCallback, CancelToken, Cancelled};
pub use job::{Job, JobError, JobEvent, JobProgress, JobReporter, JobStatus};
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
