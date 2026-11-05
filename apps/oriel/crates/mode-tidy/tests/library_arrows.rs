//! The Library's arrows, ⌘⌫ and Esc in random runs, against a model of the list read from the
//! engine: the cursor shows the file selected, no file selected is in holding, and each arrow goes
//! to the next file or the one before, passing none over. `ORIEL_LIBRARY_SEEDS` runs other seeds:
//! `20` for the first twenty, `21-40` for those.

mod support;

use std::collections::BTreeSet;

use gpui_kit::component::table::{ColumnSort, TableDelegate as _};
use gpui_kit::{AppContext as _, Entity, TestAppContext};
use oriel_core_tidy::contract::{FileFilter, FileId, FileQuery, FileSortColumn};
use oriel_mode_tidy::{LibraryPage, TidyPage};
use support::*;

/// More than two pages of files.
const MANY: usize = 460;
const STEPS: usize = 40;

fn library(cx: &mut TestAppContext, session: &Session) -> Entity<LibraryPage> {
    cx.read(|cx| session.tidy.read(cx).library().clone())
}

/// A small generator of its own, so a seed always makes the same run.
struct Random(u64);

impl Random {
    fn below(&mut self, bound: usize) -> usize {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        (self.0 % bound as u64) as usize
    }
}

#[derive(Clone, Copy, Debug)]
enum Key {
    Down,
    Up,
    Hold,
    /// ⌘⌫ and then an arrow at once, before the list has read itself again.
    HoldThen(bool),
    Escape,
    /// A click on the Name column's header.
    Sort,
    /// A click on the row at this place, about a page's end.
    Click(usize),
}

/// What the Library should show, and the files in the order it lists them.
#[derive(Default)]
struct Model {
    order: Vec<FileId>,
    cursor: Option<FileId>,
    selected: Option<FileId>,
    /// The files either side of the one a command took, while no file has been chosen since.
    gap: Option<(Option<FileId>, Option<FileId>)>,
    held: BTreeSet<FileId>,
}

impl Model {
    fn neighbours(&self, file: FileId) -> (Option<FileId>, Option<FileId>) {
        let at = self.order.iter().position(|id| *id == file).unwrap();
        (
            at.checked_sub(1).map(|before| self.order[before]),
            self.order.get(at + 1).copied(),
        )
    }

    fn choose(&mut self, file: Option<FileId>) {
        self.cursor = file;
        self.selected = file;
        self.gap = None;
    }

    fn arrow(&mut self, forward: bool) {
        let file = if let Some((before, after)) = self.gap {
            // At the end of the list it turns back.
            if forward {
                after.or(before)
            } else {
                before.or(after)
            }
        } else if let Some(cursor) = self.cursor {
            // The list's own arrows go round from one end to the other.
            let (before, after) = self.neighbours(cursor);
            if forward {
                after.or(self.order.first().copied())
            } else {
                before.or(self.order.last().copied())
            }
        } else if forward {
            self.order.first().copied()
        } else {
            self.order.last().copied()
        };
        self.choose(file);
    }

    fn hold(&mut self) {
        let Some(file) = self.selected else {
            return;
        };
        self.gap = self.cursor.map(|_| self.neighbours(file));
        self.held.insert(file);
        self.cursor = None;
        self.selected = None;
    }

    fn escape(&mut self) {
        if self.selected.take().is_none() {
            self.cursor = None;
        }
    }
}

/// The list as the engine has it, in the order shown.
async fn order(
    cx: &mut TestAppContext,
    session: &Session,
    descending: Option<bool>,
) -> Vec<FileId> {
    let (engine, root_id) = cx.read(|cx| {
        let state = session.state.read(cx);
        (state.engine().cloned().unwrap(), state.root_id())
    });
    let query = FileQuery {
        filter: FileFilter::root(root_id),
        sort: descending.map_or(FileSortColumn::Path, |_| FileSortColumn::Name),
        descending: descending.unwrap_or(false),
        offset: 0,
        limit: 1000,
    };
    let page = engine.list_files(query).await.unwrap();
    page.rows.iter().map(|row| row.id).collect()
}

/// Waits until no change runs and the Library has read what it asked for.
async fn settle_library(cx: &mut TestAppContext, session: &Session) {
    wait_for_change(cx, session).await;
    let library = library(cx, session);
    wait_for(cx, session, "the Library to settle", move |cx| {
        library.read(cx).table().read(cx).delegate().settled()
    })
    .await;
}

/// What the Library shows: the cursor's file, if its row is read, and the selection.
fn shown(
    cx: &mut TestAppContext,
    session: &Session,
) -> (Option<usize>, Option<FileId>, Vec<FileId>) {
    let library = library(cx, session);
    cx.read(|cx| {
        let library = library.read(cx);
        let table = library.table().read(cx);
        let cursor = table.selected_row();
        let file = cursor
            .and_then(|index| table.delegate().row(index))
            .map(|row| row.id);
        (cursor, file, library.selection(cx))
    })
}

fn sort_by_name(cx: &mut TestAppContext, session: &Session) {
    let library = library(cx, session);
    cx.update_window(session.handle, |_, window, cx| {
        let table = library.read(cx).table().clone();
        table.update(cx, |table, cx| {
            table
                .delegate_mut()
                .perform_sort(1, ColumnSort::Default, window, cx);
        });
    })
    .unwrap();
    cx.run_until_parked();
    render(cx, session);
}

fn click_row(cx: &mut TestAppContext, session: &Session, index: usize) {
    let library = library(cx, session);
    cx.update(|cx| {
        let table = library.read(cx).table().clone();
        table.update(cx, |table, cx| table.set_selected_row(index, cx));
    });
    cx.run_until_parked();
    render(cx, session);
}

fn key(random: &mut Random, total: usize) -> Key {
    match random.below(100) {
        0..30 => Key::Down,
        30..48 => Key::Up,
        48..64 => Key::Hold,
        64..76 => Key::HoldThen(random.below(2) == 0),
        76..82 => Key::Escape,
        82..86 => Key::Sort,
        _ => {
            let near = [0, 200, 400][random.below(3)];
            Key::Click((near + random.below(8)).saturating_sub(4).min(total - 1))
        }
    }
}

#[gpui_kit::test]
async fn the_arrows_hold_and_esc_agree_with_the_list(cx: &mut TestAppContext) {
    if !media_ready() {
        return;
    }
    let seeds = std::env::var("ORIEL_LIBRARY_SEEDS").unwrap_or_else(|_| "1".into());
    let seeds = match seeds.split_once('-') {
        Some((first, last)) => first.parse::<u64>().unwrap()..=last.parse().unwrap(),
        None => 1..=seeds.parse().unwrap(),
    };
    let session = launch_changing(cx, "library-arrows");
    let picture = session.archive.join("photos/sunset-small.jpg");
    let folder = session.archive.join("many");
    std::fs::create_dir_all(&folder).unwrap();
    for number in 0..MANY {
        std::fs::copy(&picture, folder.join(format!("{number:04}.jpg"))).unwrap();
    }
    add_archive(cx, &session).await;
    go(cx, &session, TidyPage::Library);
    settle(cx, &session).await;
    // The table has the keys, as after a click on a row.
    cx.update_window(session.handle, |_, window, cx| {
        use gpui_kit::test::TestWindowExt as _;
        window.click(("library-row", 0usize), cx);
    })
    .unwrap();
    settle_library(cx, &session).await;

    let mut model = Model::default();
    // The order: by path, or by name, descending or not.
    let mut sorted: Option<bool> = None;
    for seed in seeds {
        // Each seed goes on from where the last one left the Library.
        let mut random = Random(seed.wrapping_mul(0x9e37_79b9_7f4a_7c15) | 1);
        for step in 0..STEPS {
            model.order = order(cx, &session, sorted).await;
            let key = key(&mut random, model.order.len());
            match key {
                Key::Down | Key::Up => {
                    let forward = matches!(key, Key::Down);
                    press(cx, &session, if forward { "down" } else { "up" });
                    model.arrow(forward);
                }
                Key::Hold => {
                    press(cx, &session, "secondary-backspace");
                    model.hold();
                }
                Key::HoldThen(forward) => {
                    press(cx, &session, "secondary-backspace");
                    press(cx, &session, if forward { "down" } else { "up" });
                    model.hold();
                    model.arrow(forward);
                }
                Key::Escape => {
                    press(cx, &session, "escape");
                    model.escape();
                }
                Key::Sort => {
                    sort_by_name(cx, &session);
                    // The header goes from A first to Z first, and back.
                    sorted = Some(!sorted.unwrap_or(true));
                    model.cursor = None;
                    model.gap = None;
                }
                Key::Click(index) => {
                    click_row(cx, &session, index);
                    model.choose(model.order.get(index).copied());
                }
            }
            settle_library(cx, &session).await;
            let (cursor, file, selection) = shown(cx, &session);
            let what = format!("seed {seed}, step {step}, {key:?}");
            if let (Some(file), false) = (file, selection.is_empty()) {
                assert_eq!(selection, [file], "{what}: the cursor shows another file");
            }
            assert!(
                selection.iter().all(|id| !model.held.contains(id)),
                "{what}: a file in holding is selected"
            );
            assert_eq!(
                selection,
                Vec::from_iter(model.selected),
                "{what}: selection"
            );
            assert_eq!(
                cursor.map(|_| file),
                model.cursor.map(Some),
                "{what}: cursor"
            );
        }
    }
    assert!(!model.held.is_empty());
}
