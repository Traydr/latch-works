//! What the Tidy UI tests share: a copy of the archive glazier-core's differential suite scans
//! (`apps/oriel-rs/conformance/glazier-core/archive`, dates included) beside a data folder of its
//! own under the temp folder, Tidy alone in a window over it, and the steps a case takes.

#![allow(dead_code)]

use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::time::{Duration, SystemTime};

use gpui_kit::test::TestWindowExt as _;
use gpui_kit::{
    AnyWindowHandle, App, AppContext as _, Bounds, Context, ElementId, Entity, IntoElement,
    ParentElement as _, Render, Styled as _, TestAppContext, Window, WindowBounds, WindowOptions,
    div, px, size,
};
use oriel_core_paths::DataRoot;
use oriel_core_tidy::passes::Media;
use oriel_mode_tidy::changes::{Changes, EngineChanges, NotYet};
use oriel_mode_tidy::{TidyMode, TidyPage, TidyState};
use oriel_ui::{ModeId, ShellState};

/// The changes the read-side cases run with: "not available yet", as the app has them until the
/// executor is trusted with files.
pub fn not_yet() -> Changes {
    Rc::new(NotYet)
}

/// The changes the ignored cases run with: the engine's executor.
pub fn executor() -> Changes {
    Rc::new(EngineChanges)
}

pub fn conformance() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../conformance/glazier-core")
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    files: Vec<ManifestFile>,
    empty_folders: Vec<String>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManifestFile {
    path: String,
    mtime_ms: f64,
}

/// A folder of its own under the temp folder, which Tidy's sandbox admits.
pub fn scratch(test: &str) -> PathBuf {
    let folder = std::env::temp_dir()
        .join("oriel-mode-tidy-tests")
        .join(format!("{test}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&folder);
    std::fs::create_dir_all(&folder).unwrap();
    std::fs::canonicalize(folder).unwrap()
}

/// The committed archive, copied with its dates and its empty folder.
pub fn copy_archive(target: &Path) {
    let source = conformance().join("archive");
    let manifest: Manifest =
        serde_json::from_str(&std::fs::read_to_string(conformance().join("archive.json")).unwrap())
            .unwrap();
    for folder in &manifest.empty_folders {
        std::fs::create_dir_all(target.join(folder)).unwrap();
    }
    for file in &manifest.files {
        let to = target.join(&file.path);
        std::fs::create_dir_all(to.parent().unwrap()).unwrap();
        std::fs::copy(source.join(&file.path), &to).unwrap();
        std::fs::File::options()
            .write(true)
            .open(&to)
            .unwrap()
            .set_modified(SystemTime::UNIX_EPOCH + Duration::from_millis(file.mtime_ms as u64))
            .unwrap();
    }
}

/// Whether this machine has what a scan's analysis needs.
pub fn media_ready() -> bool {
    let media = Media::locate();
    let ready = media.vips.is_some() && media.ffmpeg.is_some() && media.ffprobe.is_some();
    if !ready {
        eprintln!("skipped: needs libvips and the pinned ffmpeg and ffprobe");
    }
    ready
}

/// Tidy alone in a window, with its Settings section drawn in place of the page while
/// `settings` is set, as the shell draws it.
pub struct Harness {
    pub tidy: Entity<TidyMode>,
    pub settings: bool,
}

impl Render for Harness {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        if self.settings {
            let section = self
                .tidy
                .update(cx, |tidy, cx| tidy.settings_section(window, cx));
            div().size_full().child(section).into_any_element()
        } else {
            self.tidy.clone().into_any_element()
        }
    }
}

pub struct Session {
    pub handle: AnyWindowHandle,
    pub harness: Entity<Harness>,
    pub shell: Entity<ShellState>,
    pub tidy: Entity<TidyMode>,
    pub state: Entity<TidyState>,
    pub root: PathBuf,
    pub archive: PathBuf,
}

pub fn launch(cx: &mut TestAppContext, test: &str) -> Session {
    launch_in(cx, scratch(test), not_yet())
}

/// Tidy changing files through the engine's executor.
pub fn launch_changing(cx: &mut TestAppContext, test: &str) -> Session {
    launch_in(cx, scratch(test), executor())
}

/// Tidy over a data folder in `root`, with the archive copied beside it.
pub fn launch_in(cx: &mut TestAppContext, root: PathBuf, changes: Changes) -> Session {
    // The engine's work runs on threads of its own, so the scheduler has to be allowed to wait.
    cx.executor().allow_parking();
    cx.update(|cx| {
        gpui_kit::init(cx);
        oriel_ui::theme::init(cx);
    });
    let archive = root.join("archive");
    copy_archive(&archive);
    let data = DataRoot::at(root.join("data")).unwrap();
    data.create_folders().unwrap();
    let mut parts = None;
    let (handle, harness) = cx.update(|cx| {
        gpui_kit::open_window(
            WindowOptions {
                window_bounds: Some(WindowBounds::Windowed(Bounds::new(
                    Default::default(),
                    size(px(1440.), px(900.)),
                ))),
                ..Default::default()
            },
            cx,
            |window, cx| {
                let shell = cx.new(|_| ShellState::new(ModeId::Tidy, false));
                let tidy =
                    cx.new(|cx| TidyMode::with_data(&shell, &data, changes.clone(), window, cx));
                parts = Some((tidy.clone(), shell));
                cx.new(|_| Harness {
                    tidy,
                    settings: false,
                })
            },
        )
        .expect("open the test window")
    });
    let (tidy, shell) = parts.unwrap();
    let state = cx.update(|cx| tidy.read(cx).state().clone());
    Session {
        handle,
        harness,
        shell,
        tidy,
        state,
        root,
        archive,
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

pub fn render(cx: &mut TestAppContext, session: &Session) {
    cx.update_window(session.handle, |_, window, cx| window.render_frame(cx))
        .unwrap();
}

/// Lets the engine's threads and the app's tasks run until `done` holds.
pub async fn wait_for(
    cx: &mut TestAppContext,
    session: &Session,
    what: &str,
    done: impl Fn(&App) -> bool,
) {
    for _ in 0..20_000 {
        cx.run_until_parked();
        render(cx, session);
        if cx.read(|cx| done(cx)) {
            return;
        }
        cx.background_executor
            .timer(Duration::from_millis(10))
            .await;
    }
    panic!("timed out waiting for {what}");
}

/// Waits until the engine is open, nothing runs, and Overview's numbers are in.
pub async fn settle(cx: &mut TestAppContext, session: &Session) {
    let state = session.state.clone();
    wait_for(cx, session, "Tidy to settle", move |cx| {
        let state = state.read(cx);
        state.is_ready()
            && !state.is_busy()
            && (state.root().is_none() || state.overview().is_some())
    })
    .await;
    // The pages' own reads land after the state's.
    for _ in 0..20 {
        cx.run_until_parked();
        render(cx, session);
        cx.background_executor
            .timer(Duration::from_millis(10))
            .await;
    }
}

pub fn click(cx: &mut TestAppContext, session: &Session, id: impl Into<ElementId>) {
    let id = id.into();
    cx.update_window(session.handle, |_, window, cx| {
        window.render_frame(cx);
        window.click(id, cx);
    })
    .unwrap();
    cx.run_until_parked();
    render(cx, session);
}

/// Edit › Undo (⌘Z), as the shell's menu sends it to the mode on screen.
pub fn undo(cx: &mut TestAppContext, session: &Session) {
    cx.update_window(session.handle, |_, window, cx| {
        window.dispatch_action(Box::new(oriel_ui::commands::UndoChange), cx);
    })
    .unwrap();
    cx.run_until_parked();
    render(cx, session);
}

pub fn press(cx: &mut TestAppContext, session: &Session, key: &'static str) {
    cx.update_window(session.handle, |_, window, cx| window.press(key, cx))
        .unwrap();
    cx.run_until_parked();
    render(cx, session);
}

/// The label of the element `id`, if it is drawn.
pub fn label(
    cx: &mut TestAppContext,
    session: &Session,
    id: impl Into<ElementId>,
) -> Option<String> {
    let id = id.into();
    cx.update_window(session.handle, |_, window, _| {
        window
            .try_find(id)
            .and_then(|element| element.label().map(str::to_owned))
    })
    .unwrap()
}

pub fn description(
    cx: &mut TestAppContext,
    session: &Session,
    id: impl Into<ElementId>,
) -> Option<String> {
    let id = id.into();
    cx.update_window(session.handle, |_, window, _| {
        window
            .try_find(id)
            .and_then(|element| element.description().map(str::to_owned))
    })
    .unwrap()
}

/// Adds the archive as Tidy's folder and waits for its scan and analysis.
pub async fn add_archive(cx: &mut TestAppContext, session: &Session) {
    settle(cx, session).await;
    let archive = session.archive.clone();
    cx.update_window(session.handle, |_, window, cx| {
        session
            .tidy
            .update(cx, |tidy, cx| tidy.add_folder(archive, window, cx));
    })
    .unwrap();
    let state = session.state.clone();
    wait_for(cx, session, "the scan", move |cx| {
        let state = state.read(cx);
        state.root().is_some_and(|root| root.last_scan_at.is_some())
    })
    .await;
    settle(cx, session).await;
}

pub fn go(cx: &mut TestAppContext, session: &Session, page: TidyPage) {
    click(cx, session, ElementId::Name(page.item_id().into()));
    assert_eq!(cx.read(|cx| session.state.read(cx).page()), page);
}

/// Duplicates' set whose files include `name`, by its position in the queue.
pub fn set_with(cx: &mut TestAppContext, session: &Session, name: &str) -> usize {
    cx.read(|cx| {
        let duplicates = session.tidy.read(cx).duplicates().read(cx);
        duplicates
            .sets()
            .iter()
            .position(|set| {
                set.versions
                    .iter()
                    .flat_map(|version| version.files.iter())
                    .any(|file| file.name == name)
            })
            .unwrap_or_else(|| panic!("no set holds {name}"))
    })
}

pub fn kept_names(cx: &mut TestAppContext, session: &Session) -> Vec<String> {
    cx.read(|cx| {
        let mut names = session.tidy.read(cx).duplicates().read(cx).kept_names();
        names.sort();
        names
    })
}

pub fn file_id(cx: &mut TestAppContext, session: &Session, name: &str) -> u64 {
    cx.read(|cx| {
        session
            .tidy
            .read(cx)
            .duplicates()
            .read(cx)
            .rows()
            .iter()
            .find(|row| row.file.name == name)
            .map(|row| row.file.id as u64)
            .unwrap_or_else(|| panic!("{name} is not on the stage"))
    })
}

/// Waits for the change running to finish.
pub async fn wait_for_change(cx: &mut TestAppContext, session: &Session) {
    let state = session.state.clone();
    wait_for(cx, session, "the change", move |cx| {
        !state.read(cx).is_busy()
    })
    .await;
    settle(cx, session).await;
}

pub fn held_files(session: &Session) -> Vec<String> {
    // Holding sits outside the root, in Tidy's data folder; the executor names it.
    let holding = session.root.join("data").join("tidy").join("holding");
    let mut held = Vec::new();
    let mut stack = vec![holding.clone()];
    while let Some(folder) = stack.pop() {
        for entry in std::fs::read_dir(&folder).into_iter().flatten().flatten() {
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
            } else {
                held.push(path.strip_prefix(&holding).unwrap().display().to_string());
            }
        }
    }
    held.sort();
    held
}
