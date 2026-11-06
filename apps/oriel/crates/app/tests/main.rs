//! The shell's integration tests, one binary for them all but `sync_targets.rs`, which sets the
//! environment: each binary links GPUI on its own, and cargo runs one after another.

mod support;

mod links;
mod shell;
mod targets;
mod toast;
mod welcome;
