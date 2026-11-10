//! Oriel › About Oriel: the app's name and version, what it is, and the licences of what
//! it carries.
//!
//! The package keeps the notices in [`Package::licenses`], one folder each for Oriel, the libmpv,
//! libvips and libavif sets, ffmpeg and ffprobe, and the Rust crates, with the index xtask writes
//! listing them ([`NoticeIndex`]). The dialog lists that index and Show Licences opens the folder.
//! A development build has no package, so it says where the notices will be.

use std::path::{Path, PathBuf};

use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::dialog::{DialogAction, DialogFooter};
use gpui_kit::component::{ActiveTheme as _, WindowExt as _};
use gpui_kit::{
    App, InteractiveElement as _, IntoElement, ParentElement as _, Role, SharedString,
    StatefulInteractiveElement as _, Styled as _, TestSupportExt as _, Window, div,
    prelude::FluentBuilder as _, px,
};
use oriel_core_paths::{Notice, NoticeIndex, Package};
use oriel_ui::ControlSize as _;
use oriel_ui::TextRole as _;

/// The app's version: the workspace's, which the bundle's `Info.plist` carries too.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

/// The package's licence notices: where they are and what their index lists.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LicenceIndex {
    pub folder: PathBuf,
    pub notices: Vec<Notice>,
}

impl LicenceIndex {
    /// The notices of the package the app runs from, or `None` for a development build.
    pub fn of_running_app() -> Option<Self> {
        Self::read(&Package::of_running_app()?.licenses())
    }

    /// The notices in `folder`, if its index reads.
    pub fn read(folder: &Path) -> Option<Self> {
        Some(Self {
            folder: folder.to_path_buf(),
            notices: NoticeIndex::read(folder)?.notices,
        })
    }
}

/// Opens the About dialog, saying the app keeps its data in `data`, and listing `licences` when
/// the app carries them.
pub fn show(data: &Path, licences: Option<LicenceIndex>, window: &mut Window, cx: &mut App) {
    let summary = format!(
        "A desktop app for a local Latch Works archive: view it, tidy it and sync it. Its data \
         stays in {}.",
        data.display()
    );
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
                    "This development build carries no licence notices. The app bundle has them: \
                     build it with cargo run -p xtask -- bundle.",
                )
                .into_any_element(),
        };
        let folder = licences.as_ref().map(|index| index.folder.clone());
        oriel_ui::dialogs::titled(dialog, "Oriel", cx)
            .w(oriel_ui::dialogs::TEXT_WIDTH)
            .child(
                div()
                    .flex()
                    .flex_col()
                    .gap_3()
                    .text_body()
                    .child(
                        div()
                            .id("about-version")
                            .role(Role::Status)
                            .test_support()
                            .aria_label(format!("Version {VERSION}"))
                            .font_weight(gpui_kit::FontWeight::MEDIUM)
                            .child(format!("Version {VERSION}")),
                    )
                    .child(div().text_color(muted).child(summary.clone()))
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
                                .bar_size()
                                .outline()
                                .quiet_edge(cx)
                                .label("Show licences")
                                .on_click(move |_, _, cx| cx.open_with_system(&folder)),
                        )
                    })
                    // The action fills what holds it, so it is held at a button's width.
                    .child(
                        div().w(px(120.)).child(
                            DialogAction::new().child(
                                Button::new("about-ok")
                                    .primary()
                                    .bar_size()
                                    .w_full()
                                    .label("OK"),
                            ),
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
            .join("oriel-about-tests")
            .join(std::process::id().to_string());
        let _ = std::fs::remove_dir_all(&folder);
        std::fs::create_dir_all(&folder).unwrap();
        assert_eq!(LicenceIndex::read(&folder), None, "no index yet");
        let notice = |folder: &str, name: &str, licence: &str| Notice {
            folder: folder.into(),
            name: name.into(),
            version: "0.0.1".into(),
            licence: licence.into(),
        };
        let written = NoticeIndex {
            app: oriel_core_paths::APP_NAME.into(),
            version: "0.0.1".into(),
            notices: vec![
                notice("oriel", "Oriel", "MIT"),
                notice("media-tools", "ffmpeg and ffprobe", "GPL-3.0-or-later"),
            ],
        };
        std::fs::write(
            folder.join(oriel_core_paths::NOTICE_INDEX_FILE),
            serde_json::to_string(&written).unwrap(),
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
            [("oriel", "MIT"), ("media-tools", "GPL-3.0-or-later")]
        );
    }
}
