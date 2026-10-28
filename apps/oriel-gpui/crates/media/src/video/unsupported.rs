//! Video off macOS: nothing opens yet. Windows gets Media Foundation in plan 063's Phase 8.

use std::convert::Infallible;
use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::AtomicU64;
use std::time::Duration;

use super::{VideoError, VideoStatus};

/// A player that cannot exist, so the methods below are never reached.
pub(super) enum AvPlayer {}

impl AvPlayer {
    pub(super) fn open(_: &Path) -> Result<Self, VideoError> {
        Err(VideoError::Unavailable("on this platform yet"))
    }

    pub(super) fn status(&self) -> VideoStatus {
        match *self {}
    }

    pub(super) fn play(&self) {
        match *self {}
    }

    pub(super) fn pause(&self) {
        match *self {}
    }

    pub(super) fn rate(&self) -> f32 {
        match *self {}
    }

    pub(super) fn set_rate(&self, _: f32) {
        match *self {}
    }

    pub(super) fn default_rate(&self) -> f32 {
        match *self {}
    }

    pub(super) fn set_default_rate(&self, _: f32) {
        match *self {}
    }

    pub(super) fn current_time(&self) -> Duration {
        match *self {}
    }

    pub(super) fn duration(&self) -> Option<Duration> {
        match *self {}
    }

    pub(super) fn presentation_size(&self) -> (f64, f64) {
        match *self {}
    }

    pub(super) fn volume(&self) -> f32 {
        match *self {}
    }

    pub(super) fn set_volume(&self, _: f32) {
        match *self {}
    }

    pub(super) fn is_muted(&self) -> bool {
        match *self {}
    }

    pub(super) fn set_muted(&self, _: bool) {
        match *self {}
    }

    pub(super) fn seek(&self, _: Duration, _: bool, _: bool, _: u64, _: Arc<AtomicU64>) {
        match *self {}
    }

    pub(super) fn take_frame(&self, _: Duration) -> Option<(Infallible, Duration)> {
        match *self {}
    }

    pub(super) fn item_time_at(&self, _: Duration) -> Duration {
        match *self {}
    }
}
