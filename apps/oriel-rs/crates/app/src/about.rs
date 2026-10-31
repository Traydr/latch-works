//! Oriel RS › About Oriel RS: the app's name and version, what it is, and the licences of what
//! it carries, as Electron Oriel's About panel names its version and its bundle carries
//! Electron's and Chromium's licences.
//!
//! The bundle keeps the notices in `Contents/Resources/licenses/`, one folder each for Oriel RS,
//! the libmpv, libvips and libavif sets, ffmpeg and ffprobe, and the Rust crates, with
//! `index.json` listing them (`cargo run -p xtask -- bundle` writes it). The dialog lists that
//! index and Show Licences opens the folder in Finder. A development build has no bundle, so it
//! says where the notices will be.

use std::path::{Path, PathBuf};

use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::dialog::{DialogAction, DialogFooter};
use gpui_kit::component::{ActiveTheme as _, WindowExt as _};
use gpui_kit::{
    App, InteractiveElement as _, IntoElement, ParentElement as _, Role, SharedString,
    StatefulInteractiveElement as _, Styled as _, TestSupportExt as _, Window, div,
    prelude::FluentBuilder as _, px,
};
use serde::Deserialize;

/// The app's version: the workspace's, which the bundle's `Info.plist` carries too.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

/// One folder of notices, as `index.json` lists it.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
pub struct Notice {
    pub folder: String,
    pub name: String,
    pub version: String,
    pub licence: String,
}

/// The bundle's licence notices: where they are and what `index.json` lists.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LicenceIndex {
    pub folder: PathBuf,
    pub notices: Vec<Notice>,
}

#[derive(Deserialize)]
struct IndexFile {
    notices: Vec<Notice>,
}

impl LicenceIndex {
    /// The notices of the bundle the app runs from (`Contents/MacOS/oriel-rs` →
    /// `Contents/Resources/licenses`), or `None` for a development build.
    pub fn of_running_app() -> Option<Self> {
        let executable = std::env::current_exe().ok()?;
        // Windows' installed app keeps them in `licenses` beside its executable.
        #[cfg(windows)]
        return Self::read(&executable.parent()?.join("licenses"));
        #[cfg(not(windows))]
        {
            let contents = executable.parent()?.parent()?;
            Self::read(&contents.join("Resources").join("licenses"))
        }
    }

    /// The notices in `folder`, if its `index.json` reads.
    pub fn read(folder: &Path) -> Option<Self> {
        let text = std::fs::read_to_string(folder.join("index.json")).ok()?;
        let index: IndexFile = serde_json::from_str(&text).ok()?;
        Some(Self {
            folder: folder.to_path_buf(),
            notices: index.notices,
        })
    }
}

/// The dialog's text about the app.
fn summary() -> String {
    "Oriel's View, Tidy and Sync on GPUI, an experiment beside Electron Oriel. It keeps its own \
     data in ~/.latch-works/oriel-rs."
        .to_owned()
}

/// Opens the About dialog, listing `licences` when the app carries them.
pub fn show(licences: Option<LicenceIndex>, window: &mut Window, cx: &mut App) {
    window.open_dialog(cx, move |dialog, _, cx| {
        let theme = cx.theme();
        let muted = theme.muted_foreground;
        let border = theme.border;
        let radius = theme.radius_lg;
        let list = match &licences {
            Some(index) => div()
                .id("about-licences")
                .role(Role::List)
                .test_support()
                .aria_label("Licences")
                .flex()
                .flex_col()
                .rounded(radius)
                .border_1()
                .border_color(border)
                .children(index.notices.iter().enumerate().map(|(ix, notice)| {
                    let name: SharedString = if notice.version.is_empty() {
                        notice.name.clone().into()
                    } else {
                        format!("{} {}", notice.name, notice.version).into()
                    };
                    div()
                        .id(("about-licence", ix))
                        .role(Role::ListItem)
                        .test_support()
                        .aria_label(format!("{name}: {}", notice.licence))
                        .flex()
                        .flex_row()
                        .gap_3()
                        .px_3()
                        .py_2()
                        .when(ix > 0, |row| row.border_t_1().border_color(border))
                        .child(div().flex_1().min_w_0().truncate().child(name))
                        .child(
                            div()
                                .flex_shrink_0()
                                .max_w(px(200.))
                                .truncate()
                                .text_color(muted)
                                .child(notice.licence.clone()),
                        )
                }))
                .into_any_element(),
            None => div()
                .id("about-licences")
                .role(Role::Paragraph)
                .test_support()
                .text_color(muted)
                .child(
                    "This development build carries no licence notices. The app bundle has \
                     them in Contents/Resources/licenses (cargo run -p xtask -- bundle).",
                )
                .into_any_element(),
        };
        let folder = licences.as_ref().map(|index| index.folder.clone());
        dialog
            .w(px(480.))
            .title("Oriel RS")
            .child(
                div()
                    .flex()
                    .flex_col()
                    .gap_3()
                    .text_size(px(13.))
                    .child(
                        div()
                            .id("about-version")
                            .role(Role::Status)
                            .test_support()
                            .aria_label(format!("Version {VERSION}"))
                            .font_weight(gpui_kit::FontWeight::MEDIUM)
                            .child(format!("Version {VERSION}")),
                    )
                    .child(div().text_color(muted).child(summary()))
                    .child(
                        div()
                            .pt_1()
                            .font_weight(gpui_kit::FontWeight::MEDIUM)
                            .child("Licences"),
                    )
                    .child(list),
            )
            .footer(
                DialogFooter::new()
                    .when_some(folder, |footer, folder| {
                        footer.child(
                            Button::new("about-show-licences")
                                .outline()
                                .label("Show Licences")
                                .on_click(move |_, _, cx| cx.open_with_system(&folder)),
                        )
                    })
                    // The action fills what holds it, so it is held at a button's width.
                    .child(
                        div().w(px(88.)).child(
                            DialogAction::new()
                                .child(Button::new("about-ok").primary().w_full().label("OK")),
                        ),
                    ),
            )
            .on_ok(|_, _, _| true)
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_index_the_bundle_writes() {
        let folder = std::env::temp_dir()
            .join("oriel-rs-about-tests")
            .join(std::process::id().to_string());
        let _ = std::fs::remove_dir_all(&folder);
        std::fs::create_dir_all(&folder).unwrap();
        assert_eq!(LicenceIndex::read(&folder), None, "no index yet");
        std::fs::write(
            folder.join("index.json"),
            r#"{"app":"Oriel RS","version":"0.0.1","notices":[
                {"folder":"oriel-rs","name":"Oriel RS","version":"0.0.1","licence":"MIT"},
                {"folder":"media-tools","name":"ffmpeg and ffprobe","version":"9.0.2",
                 "licence":"GPL-3.0-or-later"}]}"#,
        )
        .unwrap();
        let index = LicenceIndex::read(&folder).expect("the index reads");
        assert_eq!(index.folder, folder);
        assert_eq!(
            index
                .notices
                .iter()
                .map(|notice| (notice.folder.as_str(), notice.licence.as_str()))
                .collect::<Vec<_>>(),
            [("oriel-rs", "MIT"), ("media-tools", "GPL-3.0-or-later")]
        );
    }
}
