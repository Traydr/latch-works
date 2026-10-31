//! Settings › General, Oriel's own settings (`GeneralSettings` in Electron Oriel): the one theme
//! every mode follows, where its data lives, and its version. Electron Oriel's third row imported
//! the older apps' data; nothing is left to import, so Oriel has no such row.

use std::path::PathBuf;

use gpui_kit::assets::IconName;
use gpui_kit::component::{ActiveTheme as _, Icon, button::Button};
use gpui_kit::{App, IntoElement, ParentElement as _, RenderOnce, Styled as _, Window, div};
use oriel_ui::segmented::{Segmented, SegmentedItem};
use oriel_ui::theme::ThemeChoice;
use oriel_ui::{ControlSize as _, SettingsGroup, SettingsRow};

#[derive(IntoElement)]
pub struct GeneralSettings {
    data_folder: PathBuf,
}

impl GeneralSettings {
    pub fn new(data_folder: PathBuf) -> Self {
        Self { data_folder }
    }
}

/// The element id of a theme choice's button: `theme-system`, `theme-light`, `theme-dark`.
pub fn theme_button_id(choice: ThemeChoice) -> String {
    format!("theme-{}", choice.key())
}

impl RenderOnce for GeneralSettings {
    fn render(self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        let current = ThemeChoice::stored(cx);
        let folder = self.data_folder;

        div()
            .flex()
            .flex_col()
            .child(
                SettingsGroup::new("Appearance").child(
                    SettingsRow::new("Theme")
                        .description("View, Tidy and Sync all follow it.")
                        .child(Segmented::new("theme", "Theme").items(ThemeChoice::ALL.map(
                            |choice| {
                                SegmentedItem::new(theme_button_id(choice), choice.label())
                                    .selected(choice == current)
                                    .on_click(move |_, window, cx| {
                                        choice.choose(Some(window), cx);
                                    })
                            },
                        ))),
                ),
            )
            .child(
                SettingsGroup::new("Data").child(
                    SettingsRow::new("Data folder")
                        .description(folder.display().to_string())
                        .child(
                            Button::new("reveal-data-folder")
                                .bar_size()
                                .icon(Icon::new(IconName::FolderOpen))
                                .label(if cfg!(target_os = "macos") {
                                    "Show in Finder"
                                } else {
                                    "Show in Explorer"
                                })
                                .on_click(move |_, _, cx| cx.open_with_system(&folder)),
                        ),
                ),
            )
            .child(
                div()
                    .px_1()
                    .text_xs()
                    .text_color(cx.theme().muted_foreground)
                    .child(format!("{} {}", crate::APP_NAME, env!("CARGO_PKG_VERSION"))),
            )
    }
}
