//! The folders the modes work on, and how one mode hands a file or folder to another: what
//! Electron Oriel's `KnownFolder`, `HandOffTarget`, `paths.ts` and `OfferedFolders.tsx` do.
//!
//! Each mode keeps its own folders (View the folder it opened, Tidy its roots, Sync its profiles'
//! sources). The shell gathers them into [`KnownFolder`]s on [`crate::ShellState`], and a mode's
//! empty state offers the ones the other modes use with [`OfferedFolders`]: one click starts this
//! mode on the same folder.

use std::path::{Component, Path, PathBuf};
use std::rc::Rc;

use gpui_kit::assets::IconName;
use gpui_kit::component::{ActiveTheme as _, Icon};
use gpui_kit::{
    App, ElementId, FontWeight, InteractiveElement as _, IntoElement, ParentElement as _,
    RenderOnce, Role, SharedString, StatefulInteractiveElement as _, Styled as _,
    TestSupportExt as _, Window, div, px,
};

use crate::shell::ModeId;

/// How many folders an empty state offers, as Electron Oriel's `folders.slice(0, 4)`.
pub const OFFERED_LIMIT: usize = 4;

/// A file or folder the owner chose in one mode and asked to see in another (`HandOffTarget`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum HandOff {
    File(PathBuf),
    Folder(PathBuf),
}

impl HandOff {
    pub fn path(&self) -> &Path {
        match self {
            HandOff::File(path) | HandOff::Folder(path) => path,
        }
    }

    /// The folder the hand-off is about: a file's folder, or the folder itself.
    pub fn folder(&self) -> &Path {
        match self {
            HandOff::File(path) => path.parent().unwrap_or(path),
            HandOff::Folder(path) => path,
        }
    }
}

/// A folder one of the modes works on, with the modes that use it (`KnownFolder`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct KnownFolder {
    path: PathBuf,
    modes: Vec<ModeId>,
}

impl KnownFolder {
    pub fn new(path: impl Into<PathBuf>, modes: impl IntoIterator<Item = ModeId>) -> Self {
        Self {
            path: path.into(),
            modes: modes.into_iter().collect(),
        }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn modes(&self) -> &[ModeId] {
        &self.modes
    }

    pub fn is_used_by(&self, mode: ModeId) -> bool {
        self.modes.contains(&mode)
    }

    /// The folder's own name, as the offer shows it (`baseName`).
    pub fn name(&self) -> String {
        self.path
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_else(|| self.path.display().to_string())
    }

    /// Which modes use the folder, as "In View and Sync" (`usedBy`).
    pub fn describe_use(&self) -> String {
        describe_use(&self.modes)
    }

    /// Every folder the modes work on, with the modes that use each, in the order first found
    /// (`knownFolders`): the sources in the order given, View's, Tidy's and Sync's. A folder two
    /// modes use is one entry; paths count as the same once `.` and `..` are resolved, so callers
    /// resolve symlinks first if two spellings should meet.
    pub fn collect<'a>(sources: impl IntoIterator<Item = (ModeId, &'a [PathBuf])>) -> Vec<Self> {
        let mut known: Vec<Self> = Vec::new();
        for (mode, folders) in sources {
            for folder in folders {
                let path = normalize(folder);
                match known.iter_mut().find(|known| known.path == path) {
                    Some(known) => {
                        if !known.modes.contains(&mode) {
                            known.modes.push(mode);
                        }
                    }
                    None => known.push(Self::new(path, [mode])),
                }
            }
        }
        known
    }
}

/// Which of the modes use a folder, as "In View and Sync" (`usedBy`); every known folder has at
/// least one.
pub fn describe_use(modes: &[ModeId]) -> String {
    let labels: Vec<&str> = modes.iter().map(|mode| mode.label()).collect();
    match labels.as_slice() {
        [] => String::new(),
        [only] => format!("In {only}"),
        [rest @ .., last] => format!("In {} and {last}", rest.join(", ")),
    }
}

/// `target`'s place inside `folder` with `/` between names, "" for the folder itself, or `None`
/// when it is not inside (`relativeInside`).
pub fn relative_inside(folder: &Path, target: &Path) -> Option<String> {
    let relative = normalize(target)
        .strip_prefix(normalize(folder))
        .ok()?
        .to_path_buf();
    let names: Vec<String> = relative
        .components()
        .map(|component| component.as_os_str().to_string_lossy().into_owned())
        .collect();
    Some(names.join("/"))
}

/// The one of `folders` that holds `target` most closely, if any (`closestFolder`).
pub fn closest_folder<'a, T>(
    folders: impl IntoIterator<Item = &'a T>,
    target: &Path,
    path_of: impl Fn(&T) -> &Path,
) -> Option<&'a T>
where
    T: 'a,
{
    folders
        .into_iter()
        .filter(|folder| relative_inside(path_of(folder), target).is_some())
        .max_by_key(|folder| path_of(folder).as_os_str().len())
}

/// `path` with `.` and `..` resolved by name, as Node's `path.resolve` does for an absolute path.
fn normalize(path: &Path) -> PathBuf {
    let mut normal = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                normal.pop();
            }
            other => normal.push(other),
        }
    }
    normal
}

type ChooseHandler = Rc<dyn Fn(&KnownFolder, &mut Window, &mut App)>;

/// The folders the other modes work on, offered in a mode's empty state (`OfferedFolders`): one
/// click starts this mode on the same folder. It draws nothing when there are none. Each row is
/// a button named for the folder, whose description says which modes use it; its tooltip is the
/// whole path.
#[derive(IntoElement)]
pub struct OfferedFolders {
    id: ElementId,
    title: SharedString,
    folders: Vec<KnownFolder>,
    on_choose: Option<ChooseHandler>,
}

impl OfferedFolders {
    pub fn new(id: impl Into<ElementId>, folders: impl IntoIterator<Item = KnownFolder>) -> Self {
        Self {
            id: id.into(),
            title: "Or one you already use".into(),
            folders: folders.into_iter().take(OFFERED_LIMIT).collect(),
            on_choose: None,
        }
    }

    /// The line above the folders: "Or open one you already use", for one.
    pub fn title(mut self, title: impl Into<SharedString>) -> Self {
        self.title = title.into();
        self
    }

    /// What a click on a folder does.
    pub fn on_choose(
        mut self,
        choose: impl Fn(&KnownFolder, &mut Window, &mut App) + 'static,
    ) -> Self {
        self.on_choose = Some(Rc::new(choose));
        self
    }
}

/// The element id of the offer of `folder` (`data-offered-folder`).
pub fn offered_folder_id(folder: &Path) -> ElementId {
    ElementId::Name(format!("offered-folder:{}", folder.display()).into())
}

impl RenderOnce for OfferedFolders {
    fn render(self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        let theme = cx.theme();
        let mut section = div()
            .id(self.id)
            .test_support()
            .role(Role::Group)
            .aria_label("Folders from the other modes")
            .flex()
            .flex_col()
            .w_full()
            .max_w(px(400.))
            .text_left();
        if self.folders.is_empty() {
            return section;
        }
        let count = self.folders.len();
        let rows = self.folders.into_iter().enumerate().map(|(index, folder)| {
            let on_choose = self.on_choose.clone();
            let tooltip = SharedString::from(folder.path().display().to_string());
            gpui_kit::base::Button::new(offered_folder_id(folder.path()))
                .accessibility_label(folder.name())
                .aria_description(folder.describe_use())
                .flex()
                .flex_row()
                .items_center()
                .gap_3()
                .w_full()
                .px(px(14.))
                .py(px(10.))
                .border_2()
                .border_color(theme.transparent)
                .when_not_last(index + 1 < count, theme.border)
                .hover(|style| style.bg(theme.accent))
                .focus_visible(|style| style.border_color(theme.ring))
                .tooltip(move |window, cx| {
                    gpui_kit::component::tooltip::Tooltip::new(tooltip.clone()).build(window, cx)
                })
                .child(
                    Icon::new(IconName::FolderOpen)
                        .size(px(16.))
                        .flex_shrink_0()
                        .text_color(theme.muted_foreground),
                )
                .child(
                    div()
                        .flex()
                        .flex_col()
                        .flex_1()
                        .min_w_0()
                        .child(
                            div()
                                .truncate()
                                .text_size(px(13.))
                                .font_weight(FontWeight::MEDIUM)
                                .child(folder.name()),
                        )
                        .child(
                            div()
                                .truncate()
                                .text_xs()
                                .text_color(theme.muted_foreground)
                                .child(folder.describe_use()),
                        ),
                )
                .on_click(move |_, window, cx| {
                    if let Some(choose) = &on_choose {
                        choose(&folder, window, cx);
                    }
                })
        });
        section = section
            .mt_8()
            .child(
                div()
                    .mb_2()
                    .px_1()
                    .text_xs()
                    .font_weight(FontWeight::MEDIUM)
                    .text_color(theme.muted_foreground)
                    .child(self.title),
            )
            .child(
                div()
                    .flex()
                    .flex_col()
                    .overflow_hidden()
                    .rounded(theme.radius_lg)
                    .bg(theme.group_box)
                    .border_1()
                    .border_color(theme.border)
                    .children(rows),
            );
        section
    }
}

/// A divider under every row but the last, as `divide-y` draws them.
trait DividedRow: gpui_kit::Styled + Sized {
    fn when_not_last(self, divided: bool, color: gpui_kit::Hsla) -> Self {
        if divided {
            self.border_b_1().border_color(color)
        } else {
            self
        }
    }
}

impl<T: gpui_kit::Styled> DividedRow for T {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn says_which_modes_use_a_folder() {
        let one = KnownFolder::new("/a/archive", [ModeId::Tidy]);
        assert_eq!(one.describe_use(), "In Tidy");
        let two = KnownFolder::new("/a/archive", [ModeId::View, ModeId::Sync]);
        assert_eq!(two.describe_use(), "In View and Sync");
        let three = KnownFolder::new("/a", ModeId::ALL);
        assert_eq!(three.describe_use(), "In View, Tidy and Sync");
        assert_eq!(three.name(), "a");
    }

    #[test]
    fn a_folder_two_modes_use_is_one_in_the_order_first_found() {
        let view = [PathBuf::from("/a/archive")];
        let tidy = [PathBuf::from("/a/other"), PathBuf::from("/a/x/../archive")];
        let sync = [PathBuf::from("/a/other/")];
        let known = KnownFolder::collect([
            (ModeId::View, &view[..]),
            (ModeId::Tidy, &tidy[..]),
            (ModeId::Sync, &sync[..]),
        ]);
        assert_eq!(
            known,
            [
                KnownFolder::new("/a/archive", [ModeId::View, ModeId::Tidy]),
                KnownFolder::new("/a/other", [ModeId::Tidy, ModeId::Sync]),
            ]
        );
    }

    #[test]
    fn finds_the_folder_that_holds_a_path_most_closely() {
        assert_eq!(
            relative_inside(
                Path::new("/a/archive"),
                Path::new("/a/archive/bulk/one.png")
            ),
            Some("bulk/one.png".into())
        );
        assert_eq!(
            relative_inside(Path::new("/a/archive"), Path::new("/a/archive")),
            Some(String::new())
        );
        assert_eq!(
            relative_inside(Path::new("/a/archive"), Path::new("/a/archive-2/one.png")),
            None
        );
        let folders = [PathBuf::from("/a"), PathBuf::from("/a/archive")];
        let closest = closest_folder(&folders, Path::new("/a/archive/bulk"), |path| path);
        assert_eq!(closest, Some(&folders[1]));
        assert_eq!(closest_folder(&folders, Path::new("/b"), |path| path), None);
    }
}
