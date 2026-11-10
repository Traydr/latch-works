//! The shell's integration tests, one binary for them all: each binary links GPUI on its own, and
//! cargo runs one after another.

mod support;

mod links;
mod shell;
mod sync_targets;
mod targets;
mod toast;
mod welcome;
