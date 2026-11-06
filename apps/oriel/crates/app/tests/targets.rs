//! What the shell must hold at every size, over what it really draws: every destination in the rail
//! in sight at every height the window can have, and every control over the 32 point floor in View,
//! Sync and Settings. Tidy's pages have their own walk.

mod support;

use std::time::Duration;

use gpui_kit::base::test_support::{ElementSnapshot, has_observed_focus, snapshots};
use gpui_kit::{
    AnyWindowHandle, AppContext as _, Bounds, ElementId, Pixels, Role, TestAppContext, px, size,
};
use oriel_core_paths::DataRoot;
use support::*;

const FLOOR: Pixels = px(32.);

/// The text inside a framed input, whose whole frame takes the click.
const NOT_TARGETS: [&str; 1] = ["input-state"];

/// A switch's own track, 44 × 24 in the kit, sits in a target of its own at the floor.
fn in_a_switch_target(element: &ElementSnapshot, elements: &[ElementSnapshot]) -> bool {
    element.role() == Some(Role::Switch)
        && elements.iter().any(|other| {
            other.bounds().size.height >= FLOOR
                && other.bounds().size.width >= element.bounds().size.width
                && other.bounds().origin.x <= element.bounds().origin.x
                && other.bounds().top() <= element.bounds().top()
                && other.bounds().bottom() >= element.bounds().bottom()
                && format!("{:?}", other.path().last()).contains("target")
        })
}

const TIDY_PAGES: [&str; 8] = [
    "tidy-Overview",
    "tidy-Duplicates",
    "tidy-Convert",
    "tidy-Clean up",
    "tidy-Shrink",
    "tidy-Library",
    "tidy-History",
    "tidy-Holding",
];

fn drawn(cx: &mut TestAppContext, handle: AnyWindowHandle) -> Vec<ElementSnapshot> {
    frame(cx, handle);
    cx.update_window(handle, |_, window, _| snapshots(window))
        .unwrap()
}

fn find(elements: &[ElementSnapshot], id: &str) -> Option<Bounds<Pixels>> {
    let id = ElementId::Name(id.to_owned().into());
    elements
        .iter()
        .find(|element| element.path().last() == Some(&id))
        .map(ElementSnapshot::bounds)
}

fn measure(cx: &mut TestAppContext, handle: AnyWindowHandle, state: &str, under: &mut Vec<String>) {
    let screen = cx
        .update_window(handle, |_, window, _| {
            Bounds::new(Default::default(), window.viewport_size())
        })
        .unwrap();
    let elements = drawn(cx, handle);
    for element in &elements {
        if in_a_switch_target(element, &elements) {
            continue;
        }
        let name = format!("{:?}", element.path().last().expect("a path"));
        let bounds = element.bounds();
        let control = matches!(
            element.role(),
            Some(
                Role::Button
                    | Role::CheckBox
                    | Role::Switch
                    | Role::Slider
                    | Role::Tab
                    | Role::MenuItem
                    | Role::ComboBox
                    | Role::TextInput
                    | Role::Link
            )
        );
        if control
            && element.visible()
            && bounds.intersect(&screen).size.height > px(0.)
            && !NOT_TARGETS.iter().any(|skip| name.contains(skip))
            && (bounds.size.width < FLOOR || bounds.size.height < FLOOR)
        {
            under.push(format!(
                "{state}: {name} {}x{}",
                f32::from(bounds.size.width),
                f32::from(bounds.size.height),
            ));
        }
    }
}

#[gpui_kit::test]
fn every_destination_stays_in_the_rail_at_every_height(cx: &mut TestAppContext) {
    let data = DataRoot::at(scratch("rail-heights").join("data")).unwrap();
    start(cx, &data);
    let opened = open_shell(cx, &data);
    let handle = opened.handle;
    press(cx, handle, "secondary-2");
    let mut hidden = Vec::new();
    for width in [960., 1100.] {
        for height in (640..=950).step_by(10) {
            cx.simulate_window_resize(handle, size(px(width), px(height as f32)));
            frame(cx, handle);
            frame(cx, handle);
            let elements = drawn(cx, handle);
            let list = find(&elements, "mode-navigation").expect("the rail's list");
            let foot = cx
                .update_window(handle, |_, window, _| window.viewport_size().height)
                .unwrap();
            for page in TIDY_PAGES {
                let Some(item) = find(&elements, page) else {
                    hidden.push(format!("{width}x{height}: {page} not drawn"));
                    continue;
                };
                // Holding sits in the foot, below the list, the others inside it.
                let bottom = if page == "tidy-Holding" {
                    foot
                } else {
                    list.bottom()
                };
                if item.bottom() > bottom {
                    hidden.push(format!(
                        "{width}x{height}: {page} ends at {} past {}",
                        f32::from(item.bottom()),
                        f32::from(bottom)
                    ));
                }
            }
        }
    }
    assert!(hidden.is_empty(), "out of the rail:\n{}", hidden.join("\n"));
}

#[gpui_kit::test]
fn every_control_in_view_sync_and_settings_meets_the_floor(cx: &mut TestAppContext) {
    let root = scratch("floor");
    let archive = root.join("archive");
    write_archive(&archive);
    let data = DataRoot::at(root.join("data")).unwrap();
    start(cx, &data);
    let opened = open_shell(cx, &data);
    let handle = opened.handle;
    let mut under = Vec::new();
    for (width, height) in [(1320., 860.), (960., 640.)] {
        cx.simulate_window_resize(handle, size(px(width), px(height)));
        press(cx, handle, "secondary-1");
        cx.update(|cx| {
            let view = opened.shell.read(cx).view().clone();
            view.update(cx, |view, cx| view.open_folder(archive.clone(), cx));
        });
        wait_until(cx, handle, "the folder", |cx| {
            view_shows(&opened, &archive, cx)
        });
        cx.executor().advance_clock(Duration::from_millis(400));
        frame(cx, handle);
        measure(cx, handle, &format!("View {width}"), &mut under);
        click(cx, handle, "folders");
        measure(cx, handle, &format!("Folders {width}"), &mut under);
        press(cx, handle, "escape");
        press(cx, handle, "secondary-3");
        measure(cx, handle, &format!("Sync {width}"), &mut under);
        click(cx, handle, "settings-item");
        for section in ["general", "view", "tidy", "sync"] {
            click(
                cx,
                handle,
                ElementId::Name(format!("settings-section-{section}").into()),
            );
            measure(
                cx,
                handle,
                &format!("Settings {section} {width}"),
                &mut under,
            );
        }
        click(cx, handle, "settings-back");
    }
    under.sort();
    under.dedup();
    assert!(under.is_empty(), "under the floor:\n{}", under.join("\n"));
}

#[gpui_kit::test]
fn tab_keeps_focus_in_sight_in_settings_at_the_least_height(cx: &mut TestAppContext) {
    let data = DataRoot::at(scratch("settings-tab").join("data")).unwrap();
    start(cx, &data);
    let opened = open_shell(cx, &data);
    let handle = opened.handle;
    cx.simulate_window_resize(handle, size(px(960.), px(640.)));
    frame(cx, handle);
    click(cx, handle, "settings-item");
    let mut hidden = Vec::new();
    for section in ["general", "view", "tidy", "sync"] {
        click(
            cx,
            handle,
            ElementId::Name(format!("settings-section-{section}").into()),
        );
        let mut seen = Vec::new();
        for _ in 0..40 {
            cx.update_window(handle, |_, window, cx| window.focus_next(cx))
                .unwrap();
            frame(cx, handle);
            frame(cx, handle);
            let focused = cx
                .update_window(handle, |_, window, _| {
                    snapshots(window)
                        .into_iter()
                        .filter(|element| has_observed_focus(window, element.path()))
                        .min_by_key(|element| {
                            (f32::from(element.bounds().size.width)
                                * f32::from(element.bounds().size.height))
                                as i64
                        })
                        .map(|element| {
                            (
                                format!("{:?}", element.path().last()),
                                element.bounds(),
                                element.visible(),
                            )
                        })
                })
                .unwrap();
            let Some((name, bounds, visible)) = focused else {
                continue;
            };
            if seen.contains(&name) {
                break;
            }
            seen.push(name.clone());
            // Above the window and not visible is what an undrawn element left behind.
            let left_behind = bounds.top() < px(0.) && !visible;
            if !left_behind && (bounds.top() < px(0.) || bounds.bottom() > px(640.)) {
                hidden.push(format!(
                    "{section}: {name} at {} to {}",
                    f32::from(bounds.top()),
                    f32::from(bounds.bottom())
                ));
            }
        }
    }
    assert!(hidden.is_empty(), "out of sight:\n{}", hidden.join("\n"));
}
