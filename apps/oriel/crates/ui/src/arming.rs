//! A moment in which presses do nothing, from when something new came under the pointer: a press
//! then was meant for what went.

use std::time::{Duration, Instant};

use gpui_kit::App;

/// How long a press on what has just come under the pointer does nothing. The default
/// double-click time on macOS and Windows, so a double-click's second press is never the first
/// press on something new.
pub const ARM_DELAY: Duration = Duration::from_millis(500);

/// Presses held back for [`ARM_DELAY`] from when it was armed. Timed by GPUI's clock, which tests
/// move by hand.
#[derive(Clone, Copy, Default)]
pub struct Arming(Option<Instant>);

impl Arming {
    /// Holds back presses for [`ARM_DELAY`] from now.
    pub fn arm(&mut self, cx: &App) {
        self.0 = Some(cx.background_executor().now() + ARM_DELAY);
    }

    pub fn holds(&self, cx: &App) -> bool {
        self.0
            .is_some_and(|until| cx.background_executor().now() < until)
    }
}
