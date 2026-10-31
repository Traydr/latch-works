//! Tidy's section of Settings (`views/SettingsView.tsx`): how duplicates are chosen (preferred
//! folders, similar versions, Spot variants) and converted (video quality, the tools found), and
//! background analysis. Preferred folders belong to the folder being tidied, so they show only
//! once there is one. A sandboxed run (`ORIEL_RS_DATA_DIR` set) adds a line on the sandbox Tidy
//! works in.

use std::path::Path;

use gpui_kit::assets::IconName;
use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::radio::{Radio, RadioGroup};
use gpui_kit::component::switch::Switch;
use gpui_kit::component::{ActiveTheme as _, Icon};
use gpui_kit::{
    AnyElement, App, Context, Entity, InteractiveElement as _, IntoElement, ParentElement as _,
    Role, SharedString, StatefulInteractiveElement as _, Styled as _, TestSupportExt as _, Window,
    div, px,
};
use oriel_core_tidy::contract::{
    EncoderCapabilities, PreferredFolder, Settings, SimilarityLevel, VideoQuality,
};
use oriel_ui::segmented::{Segmented, SegmentedItem};
use oriel_ui::{ControlSize as _, SettingsGroup, SettingsRow, Toast};

use crate::state::TidyState;

/// How alike two pictures or videos must look to count as versions of one, strictest first.
const SIMILARITY_LEVELS: [(SimilarityLevel, &str); 3] = [
    (SimilarityLevel::Strict, "Strict"),
    (SimilarityLevel::Balanced, "Balanced"),
    (SimilarityLevel::Loose, "Loose"),
];

/// What each similarity level lets in, in one line, for the Matching popover. The levels are
/// fingerprint distances (`still_threshold`): a copy saved again lands under 4, resizing and
/// recompression under 8, and heavier changes up to 12.
fn similarity_description(level: SimilarityLevel) -> &'static str {
    match level {
        SimilarityLevel::Strict => "Only near-exact copies, like a picture saved again",
        SimilarityLevel::Balanced => "Also copies that were resized or recompressed",
        SimilarityLevel::Loose => "Also heavier compression and small edits",
    }
}

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

/// A handler that changes Tidy's settings through `change`, as each control here does.
fn change_settings(
    state: &Entity<TidyState>,
    change: impl Fn(&mut Settings) + 'static,
) -> impl Fn(&mut Window, &mut App) + 'static {
    let state = state.clone();
    move |window, cx| {
        let Some(mut settings) = state.read(cx).settings().cloned() else {
            return;
        };
        change(&mut settings);
        state.update(cx, |state, cx| state.update_settings(settings, window, cx));
    }
}

/// The name of a similarity level, as the controls show it.
pub fn similarity_label(level: SimilarityLevel) -> &'static str {
    SIMILARITY_LEVELS
        .iter()
        .find(|(value, _)| *value == level)
        .map_or("Balanced", |(_, label)| label)
}

/// Duplicates' Matching popover: a title, the similarity level as three choices each with what
/// it lets in, and Spot variants as a labelled switch with its description. The controls are
/// named as [`matching_rows`] names them (`{id}-similarity` and `{id}-spot-variants`).
pub fn matching_popover(
    state: &Entity<TidyState>,
    settings: &Settings,
    id: &str,
    cx: &App,
) -> AnyElement {
    let theme = cx.theme();
    let (muted, border) = (theme.muted_foreground, theme.border);
    let selected = SIMILARITY_LEVELS
        .iter()
        .position(|(level, _)| *level == settings.similarity);
    let pick = {
        let state = state.clone();
        move |index: &usize, window: &mut Window, cx: &mut App| {
            let Some((level, _)) = SIMILARITY_LEVELS.get(*index).copied() else {
                return;
            };
            change_settings(&state, move |settings| settings.similarity = level)(window, cx);
        }
    };
    let levels = RadioGroup::vertical(SharedString::from(format!("{id}-similarity")))
        .selected_index(selected)
        .on_click(pick)
        .children(SIMILARITY_LEVELS.map(|(level, label)| {
            Radio::new(SharedString::from(format!("{id}-similarity-{level}")))
                .label(label)
                .child(
                    div()
                        .text_sm()
                        .text_color(muted)
                        .child(similarity_description(level)),
                )
        }));
    let toggle = change_settings(state, |settings| {
        settings.spot_variants = !settings.spot_variants;
    });
    let spot = Switch::new(SharedString::from(format!("{id}-spot-variants")))
        .checked(settings.spot_variants)
        .accessibility_label("Spot variants")
        .on_click(move |_, window, cx| toggle(window, cx));
    let heading = |text: &'static str| {
        div()
            .text_base()
            .font_weight(gpui_kit::FontWeight::MEDIUM)
            .child(text)
    };
    div()
        .w(gpui_kit::rems(24.))
        .p_1()
        .flex()
        .flex_col()
        .gap_3()
        .child(
            div()
                .flex()
                .flex_col()
                .gap_0p5()
                .child(
                    div()
                        .text_lg()
                        .font_weight(gpui_kit::FontWeight::SEMIBOLD)
                        .child("Matching"),
                )
                .child(
                    div()
                        .text_sm()
                        .text_color(muted)
                        .child("What counts as a duplicate"),
                ),
        )
        .child(
            div()
                .flex()
                .flex_col()
                .gap_2()
                .child(heading("Similar versions"))
                .child(levels),
        )
        .child(div().h_px().bg(border))
        .child(
            div()
                .flex()
                .flex_row()
                .items_start()
                .gap_4()
                .child(
                    div()
                        .flex()
                        .flex_col()
                        .flex_1()
                        .min_w_0()
                        .gap_0p5()
                        .child(heading("Spot variants"))
                        .child(div().text_sm().text_color(muted).child(
                            "Keep pictures that differ in one area, like a face, an outfit or a \
                             caption's language, and keep each picture's copy in the folder with \
                             the rest of its set",
                        )),
                )
                .child(div().flex_shrink_0().child(spot)),
        )
        .into_any_element()
}

/// The rows that decide what counts as a duplicate, Similar versions and Spot variants, with
/// their descriptions, as Settings › Tidy draws them (Duplicates' Matching popover draws the
/// same settings as [`matching_popover`]); `id`
/// names their controls (`{id}-similarity`, its levels, and `{id}-spot-variants`).
pub fn matching_rows(state: &Entity<TidyState>, settings: &Settings, id: &str) -> [SettingsRow; 2] {
    let similarity = Segmented::new(
        SharedString::from(format!("{id}-similarity")),
        "Similar versions",
    )
    .items(SIMILARITY_LEVELS.map(|(level, label)| {
        let pick = change_settings(state, move |settings| settings.similarity = level);
        SegmentedItem::new(
            SharedString::from(format!("{id}-similarity-{level}")),
            label,
        )
        .selected(settings.similarity == level)
        .on_click(move |_, window, cx| pick(window, cx))
    }));
    let toggle = change_settings(state, |settings| {
        settings.spot_variants = !settings.spot_variants;
    });
    let spot = Switch::new(SharedString::from(format!("{id}-spot-variants")))
        .checked(settings.spot_variants)
        .accessibility_label("Spot variants")
        .on_click(move |_, window, cx| toggle(window, cx));
    [
        SettingsRow::new("Similar versions")
            .description("How alike two pictures or videos must look to count as one")
            .child(similarity),
        SettingsRow::new("Spot variants")
            .description(
                "Keep pictures that differ in one area, like a face, an outfit or a caption's \
                 language, and keep each picture's copy in the folder with the rest of its set",
            )
            .child(spot),
    ]
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
        change_settings(&self.state, change)
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
        // The Encoders row is the first thing that needs them; asking runs ffmpeg and loads
        // libavif, which Tidy no longer does as it opens.
        self.state
            .update(cx, |state, cx| state.ask_capabilities(cx));
        let state = self.state.read(cx);
        let Some(settings) = state.settings().cloned() else {
            return div().into_any_element();
        };
        let root = state.root().cloned();
        let data = state.data().clone();
        let sandboxed = data.is_sandboxed();
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
                            .bar_size()
                            .outline()
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
                            .row_size()
                            .ghost()
                            .icon(Icon::new(IconName::Close))
                            .accessibility_label(SharedString::from(format!(
                                "Stop preferring {label}"
                            )))
                            .tooltip("Stop preferring")
                            .on_click(move |_, window, cx| remove(window, cx)),
                    ),
            );
        }
        let [similarity, spot] = matching_rows(&self.state, &settings, "tidy-settings");
        duplicates = duplicates.child(similarity).child(spot);

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
        // Only a sandboxed run (checks, agents) keeps Tidy to its sandbox, and says so here.
        let sandbox_group = sandboxed.then(|| {
            SettingsGroup::new("Sandbox").child(
                SettingsRow::new("Tidy changes files only in its sandbox")
                    .description(crate::links::sandbox_rule(&data)),
            )
        });

        div()
            .flex()
            .flex_col()
            .child(duplicates)
            .child(convert)
            .child(analysis)
            .children(sandbox_group)
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
