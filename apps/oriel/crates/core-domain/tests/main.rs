//! The media domain's integration tests, one binary for them all: each binary links on its own,
//! and cargo runs one after another.

mod support;

mod browser_entries;
mod comics;
mod conformance;
mod media;
mod name_ranks;
mod paths;
mod system_files;
