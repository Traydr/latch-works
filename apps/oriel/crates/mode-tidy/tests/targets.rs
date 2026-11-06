//! What every page must hold, walked over what it really draws rather than read from each control's
//! code: every control meets the 32 point floor, Tab's focus stays in sight however short the
//! window, Space and Enter press a plain button, and Escape gives focus back.

use std::time::Duration;

use crate::support::*;
use gpui_kit::base::test_support::{ElementSnapshot, has_observed_focus, snapshots};
use gpui_kit::test::TestWindowExt as _;
use gpui_kit::{
    AppContext as _, Bounds, ElementId, Modifiers, Pixels, Role, TestAppContext, px, size,
};
use oriel_mode_tidy::TidyPage;
use oriel_ui::toast::ToastExt as _;

const FLOOR: Pixels = px(32.);

/// What the walk finds under the floor that is not a target of its own: the text inside a framed
/// input, whose whole frame takes the click, and the kit's sort arrow, inside a header cell whose
/// whole width sorts.
const NOT_TARGETS: [&str; 2] = ["input-state", "icon-sort"];

/// What the pages scroll in.
const SCROLLERS: [&str; 7] = [
    "version-grid",
    "copy-rows",
    "overview-scroll",
    "cleanup-scroll",
    "convert-scroll",
    "history-scroll",
    "holding-scroll",
];

const PAGES: [TidyPage; 8] = [
    TidyPage::Overview,
    TidyPage::Duplicates,
    TidyPage::Convert,
    TidyPage::CleanUp,
    TidyPage::Shrink,
    TidyPage::Library,
    TidyPage::History,
    TidyPage::Holding,
];

fn drawn(cx: &mut TestAppContext, session: &Session) -> Vec<ElementSnapshot> {
    render(cx, session);
    cx.update_window(session.handle, |_, window, _| snapshots(window))
        .unwrap()
}

fn is_control(role: Option<Role>) -> bool {
    matches!(
        role,
        Some(
            Role::Button
                | Role::CheckBox
                | Role::Switch
                | Role::RadioButton
                | Role::Slider
                | Role::Tab
                | Role::MenuItem
                | Role::ComboBox
                | Role::TextInput
                | Role::Link
                | Role::ListBoxOption
        )
    )
}

fn name_of(element: &ElementSnapshot) -> String {
    format!("{:?}", element.path().last().expect("a path"))
}

fn viewport(cx: &mut TestAppContext, session: &Session) -> Bounds<Pixels> {
    cx.update_window(session.handle, |_, window, _| {
        Bounds::new(Default::default(), window.viewport_size())
    })
    .unwrap()
}

/// Adds each control on screen that is under the floor to `under`.
fn measure(cx: &mut TestAppContext, session: &Session, state: &str, under: &mut Vec<String>) {
    let screen = viewport(cx, session);
    for element in drawn(cx, session) {
        let name = name_of(&element);
        let bounds = element.bounds();
        if !is_control(element.role())
            || !element.visible()
            || bounds.intersect(&screen).size.height <= px(0.)
            || NOT_TARGETS.iter().any(|skip| name.contains(skip))
        {
            continue;
        }
        // A menu's separators are items to the kit, and a 2 point line to the owner.
        let separator = bounds.size.height <= px(2.);
        if !separator && (bounds.size.width < FLOOR || bounds.size.height < FLOOR) {
            under.push(format!(
                "{state}: {name} {}x{}",
                f32::from(bounds.size.width),
                f32::from(bounds.size.height),
            ));
        }
    }
}

/// Clicks `id` where the page draws it, which the fixture's data decides.
fn click_if_drawn(cx: &mut TestAppContext, session: &Session, id: &str) -> bool {
    let found = drawn(cx, session)
        .iter()
        .any(|element| element.path().last() == Some(&ElementId::Name(id.to_owned().into())));
    if found {
        click(cx, session, ElementId::Name(id.to_owned().into()));
    }
    found
}

fn focused_control(
    cx: &mut TestAppContext,
    session: &Session,
) -> Option<(String, Bounds<Pixels>, bool)> {
    render(cx, session);
    cx.update_window(session.handle, |_, window, _| {
        snapshots(window)
            .into_iter()
            .filter(|element| has_observed_focus(window, element.path()))
            .min_by_key(|element| {
                (f32::from(element.bounds().size.width) * f32::from(element.bounds().size.height))
                    as i64
            })
            .map(|element| (name_of(&element), element.bounds(), element.visible()))
    })
    .unwrap()
}

/// The scroller the control named `name` sits in, if a page's scroller holds it.
fn scroller_of(cx: &mut TestAppContext, session: &Session, name: &str) -> Option<Bounds<Pixels>> {
    let elements = drawn(cx, session);
    let control = elements.iter().find(|element| name_of(element) == name)?;
    elements
        .iter()
        .filter(|element| {
            SCROLLERS
                .iter()
                .any(|scroller| name_of(element).contains(scroller))
                && control.path().starts_with(element.path())
        })
        .map(ElementSnapshot::bounds)
        .next()
}

fn focused_name(cx: &mut TestAppContext, session: &Session) -> Option<(String, Bounds<Pixels>)> {
    focused_control(cx, session).map(|(name, bounds, _)| (name, bounds))
}

fn tab(cx: &mut TestAppContext, session: &Session) {
    cx.update_window(session.handle, |_, window, cx| window.focus_next(cx))
        .unwrap();
    cx.run_until_parked();
    render(cx, session);
    render(cx, session);
}

/// Tabs until the control named `id` has focus.
fn tab_to(cx: &mut TestAppContext, session: &Session, id: &str) {
    for _ in 0..80 {
        tab(cx, session);
        if focused_name(cx, session).is_some_and(|(name, _)| name.contains(id)) {
            return;
        }
    }
    panic!("Tab never reached {id}");
}

#[gpui_kit::test]
async fn every_control_on_every_page_meets_the_floor(cx: &mut TestAppContext) {
    if !media_ready() {
        return;
    }
    let session = launch_changing(cx, "targets-floor");
    add_archive(cx, &session).await;
    let mut under = Vec::new();
    for (width, height) in [(1320., 860.), (960., 640.)] {
        cx.simulate_window_resize(session.handle, size(px(width), px(height)));
        for page in PAGES {
            go(cx, &session, page);
            settle(cx, &session).await;
            measure(cx, &session, &format!("{page:?} {width}"), &mut under);
        }
        go(cx, &session, TidyPage::Duplicates);
        settle(cx, &session).await;
        if click_if_drawn(cx, &session, "scope-exact") {
            settle(cx, &session).await;
            measure(cx, &session, &format!("identical {width}"), &mut under);
        }
        press(cx, &session, "space");
        settle(cx, &session).await;
        measure(cx, &session, &format!("loupe {width}"), &mut under);
        press(cx, &session, "escape");
        go(cx, &session, TidyPage::Library);
        settle(cx, &session).await;
        for state in [
            "library-mode-grid",
            "library-mode-list",
            "library-inspector-toggle",
        ] {
            if click_if_drawn(cx, &session, state) {
                settle(cx, &session).await;
                measure(cx, &session, &format!("{state} {width}"), &mut under);
            }
        }
        if click_if_drawn(cx, &session, "library-filter") {
            settle(cx, &session).await;
            measure(cx, &session, &format!("filter {width}"), &mut under);
            press(cx, &session, "escape");
        }
        click(cx, &session, "location-switcher");
        settle(cx, &session).await;
        measure(cx, &session, &format!("folder menu {width}"), &mut under);
        let root = cx.read(|cx| session.state.read(cx).root().unwrap().name.clone());
        click(
            cx,
            &session,
            ElementId::Name(format!("Forget “{root}”…").into()),
        );
        cx.executor().advance_clock(Duration::from_millis(500));
        settle(cx, &session).await;
        measure(cx, &session, &format!("Forget {width}"), &mut under);
        press(cx, &session, "escape");
        cx.executor().advance_clock(Duration::from_millis(500));
        settle(cx, &session).await;
        press(cx, &session, "?");
        cx.executor().advance_clock(Duration::from_millis(500));
        settle(cx, &session).await;
        measure(cx, &session, &format!("Shortcuts {width}"), &mut under);
        press(cx, &session, "escape");
        cx.executor().advance_clock(Duration::from_millis(500));
        settle(cx, &session).await;
    }
    under.sort();
    under.dedup();
    assert!(under.is_empty(), "under the floor:\n{}", under.join("\n"));
}

#[gpui_kit::test]
async fn tab_keeps_focus_in_sight_however_short_the_window(cx: &mut TestAppContext) {
    if !media_ready() {
        return;
    }
    let session = launch_changing(cx, "targets-tab");
    add_archive(cx, &session).await;
    // A real run, so that History and Holding have rows to Tab through.
    click(cx, &session, "overview-tidy-up");
    wait_for_change(cx, &session).await;
    let mut hidden = Vec::new();
    for (width, height) in [(1320., 860.), (960., 640.), (960., 420.)] {
        if height < 640. {
            // Below the app's least height only the pages are being pushed, as with the sidebar
            // below. The run's toast stays its five seconds into this walk or not as the machine
            // is fast or slow, so it goes first.
            cx.update_window(session.handle, |_, window, cx| window.dismiss_toast(cx))
                .unwrap();
            settle(cx, &session).await;
        }
        cx.simulate_window_resize(session.handle, size(px(width), px(height)));
        let screen = viewport(cx, &session);
        for page in PAGES {
            // Shorter than the app lets a window be, to overflow every page: the rail may not show
            // the page's own button then.
            session.state.update(cx, |state, cx| state.go(page, cx));
            cx.run_until_parked();
            settle(cx, &session).await;
            let mut seen = Vec::new();
            for _ in 0..70 {
                tab(cx, &session);
                let Some((name, bounds, visible)) = focused_control(cx, &session) else {
                    continue;
                };
                // In sight means inside what it scrolls in, not just inside the window: a tile
                // scrolled under the page's header is on the window and out of sight.
                let view = scroller_of(cx, &session, &name).unwrap_or(screen);
                if seen.contains(&name) {
                    break;
                }
                seen.push(name.clone());
                // The sidebar has all its rows in sight from the app's least height, 640: below
                // that, as here, only the pages are being pushed.
                let page_control = !name.contains("tidy-");
                // A line scrolled far up is no longer drawn, and leaves behind what it last said,
                // above the screen and not visible: focus is not there.
                let left_behind = bounds.top() < px(0.) && !visible;
                if page_control
                    && !left_behind
                    && (bounds.top() < view.top() || bounds.bottom() > view.bottom())
                {
                    hidden.push(format!(
                        "{page:?} {width}x{height}: {name} at {} to {} in {} to {}",
                        f32::from(bounds.top()),
                        f32::from(bounds.bottom()),
                        f32::from(view.top()),
                        f32::from(view.bottom())
                    ));
                }
            }
        }
    }
    assert!(hidden.is_empty(), "out of sight:\n{}", hidden.join("\n"));
}

#[gpui_kit::test]
async fn space_and_enter_press_a_plain_button(cx: &mut TestAppContext) {
    if !media_ready() {
        return;
    }
    let session = launch_changing(cx, "targets-keys");
    add_archive(cx, &session).await;
    for key in ["space", "enter"] {
        go(cx, &session, TidyPage::Overview);
        settle(cx, &session).await;
        tab_to(cx, &session, "overview-review-similar");
        press(cx, &session, key);
        assert_eq!(
            cx.read(|cx| session.state.read(cx).page()),
            TidyPage::Duplicates,
            "{key} did not press Review"
        );
    }
}

#[gpui_kit::test]
async fn escape_gives_focus_back_to_what_opened_the_overlay(cx: &mut TestAppContext) {
    if !media_ready() {
        return;
    }
    let session = launch_changing(cx, "targets-escape");
    add_archive(cx, &session).await;
    let root = cx.read(|cx| session.state.read(cx).root().unwrap().name.clone());
    go(cx, &session, TidyPage::Overview);
    settle(cx, &session).await;

    // The folder's menu, from the keyboard.
    tab_to(cx, &session, "location-switcher");
    press(cx, &session, "enter");
    press(cx, &session, "escape");
    let back = focused_name(cx, &session).map(|(name, _)| name);
    assert!(back.is_some_and(|name| name.contains("location-switcher")));

    // Forget, through that menu.
    press(cx, &session, "enter");
    settle(cx, &session).await;
    click(
        cx,
        &session,
        ElementId::Name(format!("Forget “{root}”…").into()),
    );
    settle(cx, &session).await;
    press(cx, &session, "escape");
    // A dialog gives focus back once its exit is over.
    cx.executor().advance_clock(Duration::from_millis(500));
    settle(cx, &session).await;
    let back = focused_name(cx, &session).map(|(name, _)| name);
    assert!(back.is_some_and(|name| name.contains("location-switcher")));

    // Library's filter menu.
    go(cx, &session, TidyPage::Library);
    settle(cx, &session).await;
    tab_to(cx, &session, "library-filter");
    press(cx, &session, "enter");
    settle(cx, &session).await;
    press(cx, &session, "escape");
    settle(cx, &session).await;
    let back = focused_name(cx, &session).map(|(name, _)| name);
    assert!(back.is_some_and(|name| name.contains("library-filter")));

    // Move to, from the inspector.
    let command = cx.update(|cx| Modifiers::secondary_key(cx));
    cx.update_window(session.handle, |_, window, cx| {
        window.render_frame(cx);
        window.click_with_modifiers(("library-row", 0usize), command, cx);
    })
    .unwrap();
    settle(cx, &session).await;
    tab_to(cx, &session, "inspector-move");
    press(cx, &session, "enter");
    cx.executor().advance_clock(Duration::from_millis(500));
    settle(cx, &session).await;
    press(cx, &session, "escape");
    cx.executor().advance_clock(Duration::from_millis(500));
    settle(cx, &session).await;
    let back = focused_name(cx, &session).map(|(name, _)| name);
    assert!(
        back.as_ref()
            .is_some_and(|name| name.contains("inspector-move")),
        "{back:?}"
    );
}

fn open_sets(cx: &mut TestAppContext, session: &Session) -> usize {
    let tidy = session.tidy.clone();
    cx.read(|cx| tidy.read(cx).duplicates().read(cx).sets().len())
}

#[gpui_kit::test]
async fn enter_on_a_button_presses_only_that_button(cx: &mut TestAppContext) {
    if !media_ready() {
        return;
    }
    let session = launch_changing(cx, "targets-enter");
    add_archive(cx, &session).await;
    go(cx, &session, TidyPage::Duplicates);
    settle(cx, &session).await;
    let held = held_files(&session).len();
    let sets = open_sets(cx, &session);
    assert!(sets > 0);

    // By keyboard, Skip skips, and the page's ↩ does not also decide the set.
    tab_to(cx, &session, "duplicates-skip");
    press(cx, &session, "enter");
    settle(cx, &session).await;
    assert_eq!(
        held_files(&session).len(),
        held,
        "Enter on Skip moved files"
    );
    assert_eq!(open_sets(cx, &session), sets);

    // After a click on it, ↩ is the page's again, and keeps the suggestion once.
    click(cx, &session, "duplicates-skip");
    settle(cx, &session).await;
    press(cx, &session, "enter");
    wait_for_change(cx, &session).await;
    assert_eq!(
        open_sets(cx, &session),
        sets - 1,
        "one press decided one set"
    );
}

fn heading(cx: &mut TestAppContext, session: &Session) -> String {
    label(cx, session, "duplicates-decision-line").unwrap_or_default()
}

#[gpui_kit::test]
async fn a_chip_toggles_once_a_press_and_the_heading_tells_the_truth(cx: &mut TestAppContext) {
    if !media_ready() {
        return;
    }
    let session = launch_changing(cx, "targets-chip");
    add_archive(cx, &session).await;
    go(cx, &session, TidyPage::Duplicates);
    settle(cx, &session).await;
    let suggestion = heading(cx, &session);
    assert!(!suggestion.starts_with("Your pick"), "{suggestion}");
    let kept = kept_names(cx, &session).len();

    // Tab to the second tile's chip, past the first's and its menu.
    tab_to(cx, &session, "keep-version-chip");
    tab(cx, &session);
    tab(cx, &session);
    for key in ["enter", "space"] {
        press(cx, &session, key);
        assert_eq!(
            kept_names(cx, &session).len(),
            kept + 1,
            "{key} kept one more"
        );
        assert!(heading(cx, &session).starts_with("Your pick"));
        press(cx, &session, key);
        assert_eq!(kept_names(cx, &session).len(), kept, "{key} put it back");
        assert_eq!(
            heading(cx, &session),
            suggestion,
            "{key} is the suggestion again"
        );
    }
}

#[gpui_kit::test]
async fn tab_leaves_the_library_table_and_a_digit_works_from_the_sidebar(cx: &mut TestAppContext) {
    if !media_ready() {
        return;
    }
    let session = launch_changing(cx, "targets-table");
    add_archive(cx, &session).await;
    go(cx, &session, TidyPage::Library);
    settle(cx, &session).await;
    tab_to(cx, &session, "table");
    press(cx, &session, "tab");
    let after = focused_name(cx, &session).map(|(name, _)| name);
    assert!(after.is_some_and(|name| !name.contains("table")));

    go(cx, &session, TidyPage::Duplicates);
    settle(cx, &session).await;
    let sets = open_sets(cx, &session);
    tab_to(cx, &session, "tidy-Overview");
    press(cx, &session, "2");
    wait_for_change(cx, &session).await;
    assert_eq!(
        open_sets(cx, &session),
        sets - 1,
        "the digit decided the set"
    );
}
