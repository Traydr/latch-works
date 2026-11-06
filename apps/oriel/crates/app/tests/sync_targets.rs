//! Every control of Sync's plan and its run meets the 32 point floor, over what they really draw.
//! They are reached through the check that shows them without a server, which is read from the
//! environment, so this has a test binary of its own.

mod support;

use gpui_kit::base::test_support::snapshots;
use gpui_kit::{AppContext as _, Bounds, Role, TestAppContext, px, size};
use oriel_core_paths::DataRoot;
use support::*;

#[gpui_kit::test]
fn sync_plan_and_run_controls_meet_the_floor(cx: &mut TestAppContext) {
    let mut under = Vec::new();
    for check in ["plan", "run", "done", "clean", "log"] {
        let root = scratch(&format!("sync-floor-{check}"));
        let data = DataRoot::at(root.join("data")).unwrap();
        // SAFETY: this binary has this one test, and nothing else reads the environment meanwhile.
        unsafe {
            std::env::set_var("ORIEL_SYNC_CHECK", check);
            std::env::set_var("ORIEL_DATA_DIR", data.root());
        }
        start(cx, &data);
        let opened = open_shell(cx, &data);
        let handle = opened.handle;
        press(cx, handle, "secondary-3");
        for (width, height) in [(1320., 860.), (960., 640.)] {
            cx.simulate_window_resize(handle, size(px(width), px(height)));
            frame(cx, handle);
            let screen = cx
                .update_window(handle, |_, window, _| {
                    Bounds::new(Default::default(), window.viewport_size())
                })
                .unwrap();
            let elements = cx
                .update_window(handle, |_, window, _| snapshots(window))
                .unwrap();
            for element in elements {
                let bounds = element.bounds();
                let name = format!("{:?}", element.path().last());
                if matches!(
                    element.role(),
                    Some(
                        Role::Button | Role::CheckBox | Role::Switch | Role::Tab | Role::TextInput
                    )
                ) && element.visible()
                    && bounds.intersect(&screen).size.height > px(0.)
                    && !name.contains("input-state")
                    && (bounds.size.width < px(32.) || bounds.size.height < px(32.))
                {
                    under.push(format!(
                        "{check} {width}: {name} {}x{}",
                        f32::from(bounds.size.width),
                        f32::from(bounds.size.height),
                    ));
                }
            }
        }
    }
    under.sort();
    under.dedup();
    assert!(under.is_empty(), "under the floor:\n{}", under.join("\n"));
}
