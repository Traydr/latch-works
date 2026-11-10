//! The engine's integration tests, one binary for them all but `quit.rs`, which stops every tool
//! in the process: each binary links on its own, and cargo runs one after another.

mod engine;
mod fingerprint;
mod jobs;
mod round_trip;
mod running;
mod support;
