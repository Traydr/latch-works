//! Every control of Sync's plan and its run meets the 32 point floor, over what they really draw.
//! They are reached through the check that shows them without a server.

use gpui_kit::base::test_support::snapshots;
use gpui_kit::{AppContext as _, Bounds, Role, TestAppContext, px, size};
use oriel::Launch;
use oriel_core_paths::DataRoot;
use oriel_launch::Variables;
use oriel_mode_sync::SYNC_CHECK;

use crate::support::*;

#[gpui_kit::test]
fn sync_plan_and_run_controls_meet_the_floor(cx: &mut TestAppContext) {
    let mut under = Vec::new();
    for check in ["plan", "run", "done", "clean", "log"] {
        let root = scratch(&format!("sync-floor-{check}"));
        let data = DataRoot::at(root.join("data")).unwrap();
        start(cx, &data);
        let launch = Launch {
            variables: Variables::from_pairs([(SYNC_CHECK, check)]),
            ..Launch::of(data)
        };
        let opened = open_launch(cx, launch);
        let handle = opened.handle;
        press(cx, handle, "secondary-3");
        assert!(
            is_drawn(cx, handle, "plan-filter"),
            "{check} shows the check's plan"
        );
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
