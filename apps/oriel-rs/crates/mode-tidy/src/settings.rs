//! Tidy's section of Settings (`views/SettingsView.tsx`): how duplicates are chosen (preferred
//! folders, similar versions, Spot variants) and converted (video quality, the tools found), and
//! background analysis. Preferred folders belong to the folder being tidied, so they show only
//! once there is one. Oriel RS adds a line on the sandbox Tidy works in.

use std::path::Path;

use gpui_kit::assets::IconName;
use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::switch::Switch;
use gpui_kit::component::{ActiveTheme as _, Icon, Sizable as _};
use gpui_kit::{
    AnyElement, App, Context, Entity, InteractiveElement as _, IntoElement, ParentElement as _,
    Role, SharedString, StatefulInteractiveElement as _, Styled as _, TestSupportExt as _, Window,
    div, px,
};
use oriel_core_tidy::contract::{
    EncoderCapabilities, PreferredFolder, Settings, SimilarityLevel, VideoQuality,
};
use oriel_ui::segmented::{Segmented, SegmentedItem};
use oriel_ui::{SettingsGroup, SettingsRow, Toast};

use crate::state::TidyState;

/// How alike two pictures or videos must look to count as versions of one, strictest first.
pub const SIMILARITY_LEVELS: [(SimilarityLevel, &str); 3] = [
    (SimilarityLevel::Strict, "Strict"),
    (SimilarityLevel::Balanced, "Balanced"),
    (SimilarityLevel::Loose, "Loose"),
];

/// The quality a video is re-encoded at, when it has to be.
const VIDEO_QUALITIES: [(VideoQuality, &str); 3] = [
    (VideoQuality::Medium, "Medium"),
    (VideoQuality::High, "High"),
    (VideoQuality::VeryHigh, "Very high"),
];

/// A picked folder as a path inside the root, with forward slashes ("" for the root itself), or
/// `None` when it lies outside (`insideRoot`).
pub fn inside_root(root: &Path, folder: &Path) -> Option<String> {
    let rest = folder.strip_prefix(root).ok()?;
    Some(
        rest.components()
            .map(|part| part.as_os_str().to_string_lossy().into_owned())
            .collect::<Vec<_>>()
            .join("/"),
    )
}

/// Makes a folder preferred for duplicate review, with a toast and ⌘Z to take it back
/// (`usePreferFolder`).
pub fn prefer_folder(state: &Entity<TidyState>, dir: String, window: &mut Window, cx: &mut App) {
    let current = state.read(cx);
    let (Some(settings), Some(root_id)) = (current.settings().cloned(), current.root_id()) else {
        return;
    };
    let label = if dir.is_empty() {
        "the top folder".to_string()
    } else {
        dir.clone()
    };
    if settings
        .preferred_folders
        .iter()
        .any(|entry| entry.root_id == root_id && entry.dir == dir)
    {
        crate::widgets::show_toast(
            window,
            Toast::info(format!("{label} is already preferred")),
            cx,
        );
        return;
    }
    let before = settings.clone();
    let mut next = settings;
    next.preferred_folders
        .push(PreferredFolder { root_id, dir });
    state.update(cx, |state, cx| {
        state.update_settings(next, window, cx);
        let restore = before.clone();
        state.push_undo(move |state, window, cx| {
            state.update_settings(restore.clone(), window, cx);
        });
    });
    let undo_state = state.clone();
    crate::widgets::show_toast(
        window,
        Toast::done(format!("Preferring {label}"))
            .detail("Duplicate sets keep their copy there first.")
            .action("Undo", move |window, cx| {
                let before = before.clone();
                undo_state.update(cx, |state, cx| state.update_settings(before, window, cx));
            }),
        cx,
    );
}

/// The encoders Settings lists (`ENCODERS`), and whether this machine has each. Oriel RS adds
/// libavif and libvips, which it converts pictures with where Electron Oriel uses wasm and sharp.
fn encoder_rows(capabilities: &EncoderCapabilities, vips: bool) -> [(&'static str, bool); 8] {
    [
        ("H.264 video", capabilities.video.avc),
        ("HEVC video", capabilities.video.hevc),
        ("AV1 video", capabilities.video.av1 || capabilities.svt_av1),
        ("AAC audio", capabilities.aac),
        ("AVIF pictures", capabilities.avif),
        ("ffmpeg", capabilities.ffmpeg),
        ("ffprobe", capabilities.ffprobe),
        ("libvips", vips),
    ]
}

pub struct SettingsSection {
    state: Entity<TidyState>,
    /// Whether the encoders are listed; until the owner says, only when one is missing.
    encoders_open: Option<bool>,
}

impl SettingsSection {
    pub fn new(state: &Entity<TidyState>) -> Self {
        Self {
            state: state.clone(),
            encoders_open: None,
        }
    }

    /// Encoders as one summary row that lists them when clicked (`Encoders`). It opens by itself
    /// only when something is missing, since a full set is nothing to act on.
    fn encoders(
        &self,
        group: SettingsGroup,
        capabilities: &EncoderCapabilities,
        vips: bool,
        cx: &mut Context<Self>,
    ) -> SettingsGroup {
        let theme = cx.theme();
        let rows = encoder_rows(capabilities, vips);
        let missing = rows.iter().filter(|(_, found)| !found).count();
        let open = self.encoders_open.unwrap_or(missing > 0);
        let status = if missing > 0 {
            format!("{missing} of {} missing", rows.len())
        } else {
            format!("All {} available", rows.len())
        };
        let mut group = group.child(
            div()
                .id("tidy-settings-encoders")
                .test_support()
                .role(Role::Button)
                .aria_label(SharedString::from(format!("Encoders, {status}")))
                .aria_expanded(open)
                .flex()
                .flex_row()
                .items_center()
                .gap_3()
                .min_h(px(52.))
                .px_4()
                .py(px(10.))
                .cursor_pointer()
                .hover(|style| style.bg(theme.list_hover))
                .on_click(cx.listener(move |this, _, _, cx| {
                    this.encoders_open = Some(!open);
                    cx.notify();
                }))
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .text_size(px(13.))
                        .child("Encoders"),
                )
                .child(
                    div()
                        .text_xs()
                        .text_color(if missing > 0 {
                            theme.warning
                        } else {
                            theme.muted_foreground
                        })
                        .child(status),
                )
                .child(
                    Icon::new(if open {
                        IconName::ChevronDown
                    } else {
                        IconName::ChevronRight
                    })
                    .size(px(16.))
                    .text_color(theme.muted_foreground),
                ),
        );
        if open {
            for (label, found) in rows {
                group = group.child(
                    div()
                        .id(SharedString::from(format!("tidy-settings-encoder-{label}")))
                        .test_support()
                        .aria_label(SharedString::from(format!(
                            "{label}: {}",
                            if found { "Available" } else { "Not found" }
                        )))
                        .flex()
                        .flex_row()
                        .items_center()
                        .gap_4()
                        .h(px(40.))
                        .px_4()
                        .text_size(px(13.))
                        .text_color(if found {
                            theme.muted_foreground
                        } else {
                            theme.warning
                        })
                        .child(div().flex_1().min_w_0().truncate().child(label))
                        .child(if found {
                            div().text_xs().child("Available")
                        } else {
                            div().child("Not found")
                        }),
                );
            }
        }
        group
    }

    fn change(
        &self,
        change: impl Fn(&mut Settings) + 'static,
    ) -> impl Fn(&mut Window, &mut App) + 'static {
        let state = self.state.clone();
        move |window, cx| {
            let Some(mut settings) = state.read(cx).settings().cloned() else {
                return;
            };
            change(&mut settings);
            state.update(cx, |state, cx| state.update_settings(settings, window, cx));
        }
    }

    fn add_preferred(&self, window: &mut Window, cx: &mut App) {
        let current = self.state.read(cx);
        let (Some(root), Some(settings)) = (current.root().cloned(), current.settings().cloned())
        else {
            return;
        };
        let options = crate::folder_picker::PickOptions {
            title: "Prefer a folder".into(),
            action: "Prefer".into(),
            start: None,
            select: None,
            within: Some((root.path.clone().into(), root.name.clone())),
            sandbox: None,
        };
        let state = self.state.clone();
        crate::folder_picker::open(options, window, cx, move |folder, window, cx| {
            let Some(dir) = inside_root(Path::new(&root.path), &folder) else {
                crate::widgets::show_toast(
                    window,
                    Toast::error(format!("That folder is outside {}", root.name))
                        .detail("Preferred folders have to be inside the folder being tidied."),
                    cx,
                );
                return;
            };
            if settings
                .preferred_folders
                .iter()
                .any(|entry| entry.root_id == root.id && entry.dir == dir)
            {
                let label = if dir.is_empty() {
                    root.name.clone()
                } else {
                    dir
                };
                crate::widgets::show_toast(
                    window,
                    Toast::info(format!("{label} is already preferred")),
                    cx,
                );
                return;
            }
            let mut next = settings.clone();
            next.preferred_folders.push(PreferredFolder {
                root_id: root.id,
                dir,
            });
            state.update(cx, |state, cx| state.update_settings(next, window, cx));
        });
    }

    pub fn render_section(&mut self, _: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let state = self.state.read(cx);
        let Some(settings) = state.settings().cloned() else {
            return div().into_any_element();
        };
        let root = state.root().cloned();
        let sandbox = state.data().sandbox();
        let capabilities = state.capabilities().copied();
        let vips = state
            .engine()
            .is_some_and(|engine| engine.media().vips.is_some());
        let theme = cx.theme();
        let root_name = root
            .as_ref()
            .map_or_else(|| "this folder".to_string(), |root| root.name.clone());
        let preferred: Vec<String> = settings
            .preferred_folders
            .iter()
            .filter(|entry| Some(entry.root_id) == root.as_ref().map(|root| root.id))
            .map(|entry| entry.dir.clone())
            .collect();

        let mut duplicates = SettingsGroup::new(match &root {
            Some(root) => format!("Duplicates · for {}", root.name),
            None => "Duplicates".into(),
        });
        if root.is_some() {
            let this = cx.entity().downgrade();
            duplicates = duplicates.child(
                SettingsRow::new("Preferred folders")
                    .description(
                        "Review keeps the copy in these folders first. P on a version adds its \
                         folder.",
                    )
                    .child(
                        Button::new("tidy-settings-add-preferred")
                            .outline()
                            .small()
                            .label("Add folder…")
                            .on_click(move |_, window, cx| {
                                this.update(cx, |section, cx| section.add_preferred(window, cx))
                                    .ok();
                            }),
                    ),
            );
        }
        for (index, dir) in preferred.into_iter().enumerate() {
            let label = if dir.is_empty() {
                root_name.clone()
            } else {
                dir.clone()
            };
            let remove = self.change(move |settings| {
                settings.preferred_folders.retain(|entry| entry.dir != dir);
            });
            duplicates = duplicates.child(
                div()
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap_3()
                    .h(px(44.))
                    .pl_4()
                    .pr(px(10.))
                    .child(
                        Icon::new(IconName::Folder)
                            .size(px(16.))
                            .text_color(theme.muted_foreground),
                    )
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .truncate()
                            .text_size(px(13.))
                            .child(label.clone()),
                    )
                    .child(
                        Button::new(("tidy-settings-unprefer", index))
                            .ghost()
                            .xsmall()
                            .icon(Icon::new(IconName::Close))
                            .accessibility_label(SharedString::from(format!(
                                "Stop preferring {label}"
                            )))
                            .tooltip("Stop preferring")
                            .on_click(move |_, window, cx| remove(window, cx)),
                    ),
            );
        }
        let similarity = Segmented::new("tidy-settings-similarity", "Similar versions").items(
            SIMILARITY_LEVELS.map(|(level, label)| {
                let pick = self.change(move |settings| settings.similarity = level);
                SegmentedItem::new(SharedString::from(format!("similarity-{level}")), label)
                    .selected(settings.similarity == level)
                    .on_click(move |_, window, cx| pick(window, cx))
            }),
        );
        let spot = {
            let toggle = self.change(|settings| settings.spot_variants = !settings.spot_variants);
            Switch::new("tidy-settings-spot-variants")
                .checked(settings.spot_variants)
                .accessibility_label("Spot variants")
                .on_click(move |_, window, cx| toggle(window, cx))
        };
        duplicates = duplicates
            .child(
                SettingsRow::new("Similar versions")
                    .description("How alike two pictures or videos must look to count as one")
                    .child(similarity),
            )
            .child(
                SettingsRow::new("Spot variants")
                    .description(
                        "Keep pictures that differ in one area, like a face, an outfit or a \
                         caption's language, and keep each picture's copy in the folder with the \
                         rest of its set",
                    )
                    .child(spot),
            );

        let quality = Segmented::new("tidy-settings-quality", "Video quality").items(
            VIDEO_QUALITIES.map(|(quality, label)| {
                let pick = self.change(move |settings| settings.reencode_quality = quality);
                SegmentedItem::new(SharedString::from(format!("quality-{quality}")), label)
                    .selected(settings.reencode_quality == quality)
                    .on_click(move |_, window, cx| pick(window, cx))
            }),
        );
        let mut convert = SettingsGroup::new("Convert").child(
            SettingsRow::new("Video quality")
                .description(
                    "Used when a video has to be re-encoded. Shrink's AV1 runs at CRF 40, 35 or 30",
                )
                .child(quality),
        );
        if let Some(capabilities) = capabilities {
            convert = self.encoders(convert, &capabilities, vips, cx);
        }

        let analysis = {
            let toggle = self.change(|settings| settings.auto_analyze = !settings.auto_analyze);
            SettingsGroup::new("Background analysis").child(
                SettingsRow::new("Find similar versions and measure soundtracks after each scan")
                    .child(
                        Switch::new("tidy-settings-background-analysis")
                            .checked(settings.auto_analyze)
                            .accessibility_label("Background analysis")
                            .on_click(move |_, window, cx| toggle(window, cx)),
                    ),
            )
        };
        let sandbox_group = SettingsGroup::new("Sandbox").child(
            SettingsRow::new("Tidy changes files only in its sandbox").description(format!(
                "While Oriel RS is an experiment, Tidy looks after folders only inside {} or the \
                 temp folder, so it never changes the archive Electron Oriel tidies.",
                sandbox.display()
            )),
        );

        div()
            .flex()
            .flex_col()
            .child(duplicates)
            .child(convert)
            .child(analysis)
            .child(sandbox_group)
            .into_any_element()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preferred_folders_are_paths_inside_the_root() {
        let root = Path::new("/archive");
        assert_eq!(
            inside_root(root, Path::new("/archive")).as_deref(),
            Some("")
        );
        assert_eq!(
            inside_root(root, Path::new("/archive/a/b")).as_deref(),
            Some("a/b")
        );
        assert_eq!(inside_root(root, Path::new("/elsewhere")), None);
    }
}
