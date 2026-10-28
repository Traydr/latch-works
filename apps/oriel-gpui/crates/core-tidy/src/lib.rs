//! Tidy's engine, ported from `glazier-core` (plan 063).
//!
//! Phase 0 ports only what Spot variants' thresholds read: the fingerprint and the detail print,
//! made through the same libvips build sharp ships so that they match glazier-core's bit for bit.
//! Phase 5 grows the rest of the similarity pass here.

pub mod similarity;
