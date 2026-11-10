//! Tidy's UI tests, one binary for them all: each binary links GPUI on its own, and cargo runs
//! one binary after another, so seven of them took seven links and ran no two files' tests at
//! once. `cargo test -p oriel-mode-tidy --test main cases::` runs one file's.

mod support;

mod activity;
mod cases;
mod decisions;
mod duplicates;
mod library_commands;
mod pages;
mod targets;
