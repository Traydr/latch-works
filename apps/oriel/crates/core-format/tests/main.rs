//! The media format's integration tests, one binary for them all: each binary links on its own,
//! and cargo runs one after another.

mod support;

mod animation;
mod avif;
mod file_names;
mod still_policy;
mod video_policy;
