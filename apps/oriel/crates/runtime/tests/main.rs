//! The runtime's integration tests, one binary for them all: each binary links GPUI on its own,
//! and cargo runs one after another.

mod jobs;
mod sqlite;
mod tokio_runtime;
