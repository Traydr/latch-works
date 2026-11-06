//! lockstep-core's integration tests, one binary for them all: each binary links on its own, and
//! cargo runs one after another.

mod conformance;
mod runs;
mod stack;
