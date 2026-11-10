//! Driving a window in a headless GPUI test as the owner would: draw it, click and press, read
//! what an element is named, and wait for work that runs on threads of its own. With the
//! `test-support` feature only.

use std::time::{Duration, Instant};

use gpui_kit::test::TestWindowExt as _;
use gpui_kit::{AnyWindowHandle, AppContext as _, ElementId, TestAppContext};

#[derive(Clone, Copy, Debug)]
pub struct TestWindow {
    handle: AnyWindowHandle,
    /// How many times [`Self::render`] lets the app's tasks run and draws.
    rounds: usize,
}

impl TestWindow {
    pub fn new(handle: AnyWindowHandle) -> Self {
        Self { handle, rounds: 1 }
    }

    /// Lets the app's tasks run and draws `rounds` times per [`Self::render`]: for a mode whose
    /// work comes back in steps (a scan's batches, then its thumbnails, then their decodes).
    pub fn settling(self, rounds: usize) -> Self {
        Self { rounds, ..self }
    }

    pub fn handle(&self) -> AnyWindowHandle {
        self.handle
    }

    /// Lets the app's tasks run until they wait, and draws what they left.
    pub fn render(&self, cx: &mut TestAppContext) {
        for _ in 0..self.rounds {
            cx.run_until_parked();
            cx.update_window(self.handle, |_, window, cx| window.render_frame(cx))
                .expect("the test window is open");
        }
    }

    pub fn click(&self, cx: &mut TestAppContext, id: impl Into<ElementId>) {
        let id = id.into();
        cx.update_window(self.handle, |_, window, cx| window.click(id, cx))
            .expect("the test window is open");
        self.render(cx);
    }

    pub fn double_click(&self, cx: &mut TestAppContext, id: impl Into<ElementId>) {
        let id = id.into();
        cx.update_window(self.handle, |_, window, cx| window.double_click(id, cx))
            .expect("the test window is open");
        self.render(cx);
    }

    pub fn press(&self, cx: &mut TestAppContext, key: &str) {
        cx.update_window(self.handle, |_, window, cx| window.press(key, cx))
            .expect("the test window is open");
        self.render(cx);
    }

    /// The accessible name of element `id`, if it is drawn.
    pub fn label(&self, cx: &mut TestAppContext, id: impl Into<ElementId>) -> Option<String> {
        let id = id.into();
        cx.update_window(self.handle, |_, window, _| {
            window
                .try_find(id)
                .and_then(|element| element.label().map(str::to_owned))
        })
        .expect("the test window is open")
    }

    /// Waits up to `limit`, in real time, for `ready`, drawing between looks: for what runs on
    /// threads of its own, as a video engine does. Whether `ready` held in the end.
    pub fn wait_for(
        &self,
        cx: &mut TestAppContext,
        limit: Duration,
        mut ready: impl FnMut(&mut TestAppContext) -> bool,
    ) -> bool {
        let deadline = Instant::now() + limit;
        while Instant::now() < deadline {
            if ready(cx) {
                return true;
            }
            std::thread::sleep(Duration::from_millis(20));
            self.render(cx);
        }
        ready(cx)
    }
}
