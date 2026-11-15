//! Tidy's section of Settings: how duplicates are chosen (preferred folders, folder priority,
//! similar versions, Spot variants) and converted (video quality, the tools found), and background
//! analysis. Preferred folders and folder priority belong to the folder being tidied, so they show
//! only once there is one. A sandboxed run (`ORIEL_DATA_DIR` set) adds a line on the sandbox Tidy
//! works in.

use std::path::Path;

use gpui_kit::assets::IconName;
use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::radio::{Radio, RadioGroup};
use gpui_kit::component::{ActiveTheme as _, Disableable as _, Icon};
use gpui_kit::{
    AnyElement, App, Context, Entity, FontWeight, InteractiveElement as _, IntoElement,
    ParentElement as _, Role, SharedString, StatefulInteractiveElement as _, Styled as _, Task,
    TestSupportExt as _, Window, div, prelude::FluentBuilder as _, px,
};
use oriel_core_tidy::contract::{
    EncoderCapabilities, FolderGroup, FolderOrder, RootId, Settings, SimilarityLevel, VideoQuality,
};
use oriel_ui::TextRole as _;
use oriel_ui::ToastExt as _;
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

/// What Spot variants does, wherever its switch is.
const SPOT_VARIANTS_DESCRIPTION: &str = "Keep pictures that differ in one area, like a face, an \
     outfit or a caption's language, and keep each picture's copy in the folder with the rest of \
     its set";

/// The Spot variants switch, its control named `{id}-spot-variants`.
fn spot_variants_switch(
    state: &Entity<TidyState>,
    settings: &Settings,
    id: &str,
) -> oriel_ui::controls::HouseSwitch {
    let toggle = change_settings(state, |settings| {
        settings.spot_variants = !settings.spot_variants;
    });
    oriel_ui::switch(SharedString::from(format!("{id}-spot-variants")))
        .checked(settings.spot_variants)
        .accessibility_label("Spot variants")
        .on_click(move |_, window, cx| toggle(window, cx))
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
    let spot = spot_variants_switch(state, settings, id);
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
                        .child(
                            div()
                                .text_sm()
                                .text_color(muted)
                                .child(SPOT_VARIANTS_DESCRIPTION),
                        ),
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
    let spot = spot_variants_switch(state, settings, id);
    [
        SettingsRow::new("Similar versions")
            .description("How alike two pictures or videos must look to count as one")
            .child(similarity),
        SettingsRow::new("Spot variants")
            .description(SPOT_VARIANTS_DESCRIPTION)
            .child(spot),
    ]
}

/// The encoders Settings lists, and whether this machine has each. Oriel adds
/// libavif and libvips, which it converts pictures with.
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

/// What Folder priority's groups were read for: the root, the catalog's version, and the owner's
/// orders then.
type PriorityKey = (RootId, u64, Vec<FolderOrder>);

/// The levels below the root folder priority compares folders at.
const PRIORITY_LEVELS: [(u8, &str); 3] = [(1, "Level 1"), (2, "Level 2"), (3, "Level 3")];

/// A group's key, which stays as its order changes: its depth and its first folder by name.
fn group_key(group: &FolderGroup) -> String {
    let first = group
        .folders
        .iter()
        .map(|folder| folder.dir.as_str())
        .min()
        .unwrap_or_default();
    format!("{}:{first}", group.depth)
}

/// The owner's orders with `group`'s replaced by `folders`, or dropped when `folders` is `None`:
/// an order of the same root and depth that names any of the group's folders is the group's.
fn with_group_order(
    orders: &[FolderOrder],
    root_id: RootId,
    group: &FolderGroup,
    folders: Option<Vec<String>>,
) -> Vec<FolderOrder> {
    let mut orders: Vec<FolderOrder> = orders
        .iter()
        .filter(|order| {
            order.root_id != root_id
                || order.depth != group.depth
                || !order
                    .folders
                    .iter()
                    .any(|dir| group.folders.iter().any(|folder| &folder.dir == dir))
        })
        .cloned()
        .collect();
    if let Some(folders) = folders {
        orders.push(FolderOrder {
            root_id,
            depth: group.depth,
            folders,
        });
    }
    orders
}

pub struct SettingsSection {
    state: Entity<TidyState>,
    /// Whether the encoders are listed; until the owner says, only when one is missing.
    encoders_open: Option<bool>,
    /// Folder priority's groups and what they were read for, the read under way and its key, the
    /// level shown, and the group open at a level with several.
    priority: Option<(PriorityKey, Vec<FolderGroup>)>,
    priority_read: Option<(PriorityKey, Task<()>)>,
    priority_level: u8,
    priority_open: Option<String>,
}

impl SettingsSection {
    pub fn new(state: &Entity<TidyState>) -> Self {
        Self {
            state: state.clone(),
            encoders_open: None,
            priority: None,
            priority_read: None,
            priority_level: 2,
            priority_open: None,
        }
    }

    /// Reads Folder priority's groups again when the root, the catalog or the owner's orders
    /// moved since they were read.
    fn read_priority(&mut self, settings: &Settings, cx: &mut Context<Self>) {
        let state = self.state.read(cx);
        let (Some(engine), Some(root_id)) = (state.engine().cloned(), state.root_id()) else {
            return;
        };
        let key: PriorityKey = (
            root_id,
            state.catalog_version(),
            settings.folder_orders.clone(),
        );
        let current = self.priority.as_ref().is_some_and(|(read, _)| *read == key)
            || self
                .priority_read
                .as_ref()
                .is_some_and(|(reading, _)| *reading == key);
        if current {
            return;
        }
        let answer = engine.ask(move |engine| engine.folder_priority(root_id), cx);
        let reading = key.clone();
        let task = cx.spawn(async move |this, cx| {
            let answer = answer.await;
            this.update(cx, |this, cx| {
                if this
                    .priority_read
                    .as_ref()
                    .is_some_and(|(read, _)| *read == reading)
                {
                    this.priority_read = None;
                }
                if let Ok(groups) = answer {
                    this.priority = Some((reading, groups));
                }
                cx.notify();
            })
            .ok();
        });
        self.priority_read = Some((key, task));
    }

    /// Moves a folder of a group to `to`, which makes the group's order the owner's. The list
    /// shows it at once; the setting follows.
    fn move_folder(
        &mut self,
        group: usize,
        from: usize,
        to: usize,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(root_id) = self.state.read(cx).root_id() else {
            return;
        };
        let Some((_, groups)) = self.priority.as_mut() else {
            return;
        };
        let Some(entry) = groups.get_mut(group) else {
            return;
        };
        if from >= entry.folders.len() || to >= entry.folders.len() {
            return;
        }
        let before = entry.clone();
        let folder = entry.folders.remove(from);
        entry.folders.insert(to, folder);
        entry.ordered = true;
        let folders: Vec<String> = entry
            .folders
            .iter()
            .map(|folder| folder.dir.clone())
            .collect();
        self.change(move |settings| {
            settings.folder_orders = with_group_order(
                &settings.folder_orders,
                root_id,
                &before,
                Some(folders.clone()),
            );
        })(window, cx);
        cx.notify();
    }

    /// Drops the owner's order of a group, so it goes back to what Tidy learned.
    fn reset_group(&mut self, group: usize, window: &mut Window, cx: &mut Context<Self>) {
        let Some(root_id) = self.state.read(cx).root_id() else {
            return;
        };
        let Some(entry) = self
            .priority
            .as_ref()
            .and_then(|(_, groups)| groups.get(group))
            .cloned()
        else {
            return;
        };
        self.change(move |settings| {
            settings.folder_orders =
                with_group_order(&settings.folder_orders, root_id, &entry, None);
        })(window, cx);
    }

    /// Folder priority: a level picker, then each group of folders at that level best first,
    /// with buttons to move a folder up or down and, for a group the owner ordered, Reset. A
    /// level with several groups shows each as a row that opens it.
    fn priority_group(&mut self, root_name: &str, cx: &mut Context<Self>) -> SettingsGroup {
        let level = self.priority_level;
        let groups: Vec<(usize, FolderGroup)> = self
            .priority
            .as_ref()
            .map(|(_, groups)| {
                groups
                    .iter()
                    .cloned()
                    .enumerate()
                    .filter(|(_, group)| group.depth == level)
                    .collect()
            })
            .unwrap_or_default();
        let this = cx.entity().downgrade();
        let picker = Segmented::new("tidy-settings-priority-level", "Folder level").items(
            PRIORITY_LEVELS.map(|(depth, label)| {
                let this = this.clone();
                SegmentedItem::new(SharedString::from(format!("priority-level-{depth}")), label)
                    .selected(level == depth)
                    .on_click(move |_, _, cx| {
                        this.update(cx, |section, cx| {
                            section.priority_level = depth;
                            section.priority_open = None;
                            cx.notify();
                        })
                        .ok();
                    })
            }),
        );
        let mut group = SettingsGroup::new(format!("Folder priority · for {root_name}")).child(
            SettingsRow::new("Folders compared")
                .description(
                    "Learned from the duplicates you resolve, one to three folders deep. Move a \
                     folder up to keep its copies first; your order goes before what Tidy \
                     learned, and preferred folders before both.",
                )
                .child(picker),
        );
        let theme = cx.theme();
        let (muted, hover, primary) = (theme.muted_foreground, theme.list_hover, theme.primary);
        if groups.is_empty() {
            return group.child(
                div()
                    .id("tidy-settings-priority-empty")
                    .test_support()
                    .px_4()
                    .py_3()
                    .text_body()
                    .text_color(muted)
                    .child(if self.priority.is_some() {
                        "No duplicates resolved between folders at this level yet"
                    } else {
                        "Reading what you resolved…"
                    }),
            );
        }
        let several = groups.len() > 1;
        for (index, entry) in groups {
            let key = group_key(&entry);
            let open = !several || self.priority_open.as_deref() == Some(key.as_str());
            if several {
                let first = match entry.folders[0].dir.as_str() {
                    "" => crate::labels::folder_capitalized("").to_string(),
                    dir => dir.to_string(),
                };
                let more = entry.folders.len() - 1;
                let this = this.clone();
                let toggle_key = key.clone();
                group = group.child(
                    div()
                        .id(SharedString::from(format!(
                            "tidy-settings-priority-group-{key}"
                        )))
                        .test_support()
                        .role(Role::Button)
                        .aria_label(SharedString::from(format!("{first} and {more} more")))
                        .aria_expanded(open)
                        .flex()
                        .flex_row()
                        .items_center()
                        .gap_3()
                        .h(px(48.))
                        .px_4()
                        .cursor_pointer()
                        .hover(|style| style.bg(hover))
                        .on_click(move |_, _, cx| {
                            let key = toggle_key.clone();
                            this.update(cx, |section, cx| {
                                section.priority_open =
                                    (section.priority_open.as_deref() != Some(&key)).then_some(key);
                                cx.notify();
                            })
                            .ok();
                        })
                        .child(
                            Icon::new(if open {
                                IconName::ChevronDown
                            } else {
                                IconName::ChevronRight
                            })
                            .size(px(16.))
                            .text_color(muted),
                        )
                        .child(div().flex_1().min_w_0().truncate().text_body().child(first))
                        .child(
                            div()
                                .text_caption()
                                .text_color(muted)
                                .child(format!("+{more}")),
                        )
                        .when(entry.ordered, |row| {
                            row.child(div().text_caption().text_color(primary).child("Your order"))
                        }),
                );
            }
            if !open {
                continue;
            }
            if entry.ordered {
                let this = this.clone();
                group = group.child(
                    div()
                        .flex()
                        .flex_row()
                        .items_center()
                        .gap_3()
                        .h(px(44.))
                        .px_4()
                        .child(
                            div()
                                .flex_1()
                                .text_caption()
                                .text_color(muted)
                                .child("You set this order"),
                        )
                        .child(
                            Button::new(SharedString::from(format!(
                                "tidy-settings-priority-reset-{key}"
                            )))
                            .row_size()
                            .ghost()
                            .label("Use learned order")
                            .on_click(move |_, window, cx| {
                                this.update(cx, |section, cx| {
                                    section.reset_group(index, window, cx);
                                })
                                .ok();
                            }),
                        ),
                );
            }
            let count = entry.folders.len();
            for (row, folder) in entry.folders.iter().enumerate() {
                let label = if folder.dir.is_empty() {
                    crate::labels::folder_capitalized("").to_string()
                } else {
                    folder.dir.clone()
                };
                let mover = |to: usize, icon: IconName, name: &str, disabled: bool| {
                    let this = this.clone();
                    Button::new(SharedString::from(format!(
                        "tidy-settings-priority-{name}-{key}-{row}"
                    )))
                    .row_size()
                    .ghost()
                    .icon(Icon::new(icon))
                    .accessibility_label(SharedString::from(format!("Move {label} {name}")))
                    .tooltip(if name == "up" {
                        "Keep from it sooner"
                    } else {
                        "Keep from it later"
                    })
                    .disabled(disabled)
                    .on_click(move |_, window, cx| {
                        this.update(cx, |section, cx| {
                            section.move_folder(index, row, to, window, cx);
                        })
                        .ok();
                    })
                };
                group = group.child(
                    div()
                        .id(SharedString::from(format!(
                            "tidy-settings-priority-{key}-{row}"
                        )))
                        .test_support()
                        .aria_label(SharedString::from(format!("{}. {label}", row + 1)))
                        .flex()
                        .flex_row()
                        .items_center()
                        .gap_3()
                        .h(px(48.))
                        .pl_4()
                        .pr(px(10.))
                        .child(
                            div()
                                .w(px(24.))
                                .flex_shrink_0()
                                .text_caption()
                                .text_color(muted)
                                .font_weight(FontWeight::MEDIUM)
                                .child(format!("{}", row + 1)),
                        )
                        .child(
                            div()
                                .flex_1()
                                .min_w_0()
                                .truncate()
                                .text_body()
                                .child(label.clone()),
                        )
                        .child(
                            div()
                                .flex_shrink_0()
                                .text_caption()
                                .text_color(muted)
                                .child(format!("won {} · lost {}", folder.won, folder.lost)),
                        )
                        .child(mover(
                            row.saturating_sub(1),
                            IconName::ChevronUp,
                            "up",
                            row == 0,
                        ))
                        .child(mover(
                            (row + 1).min(count - 1),
                            IconName::ChevronDown,
                            "down",
                            row + 1 == count,
                        )),
                );
            }
        }
        group
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
                .min_h(px(60.))
                .px_4()
                .py(px(10.))
                .cursor_pointer()
                .hover(|style| style.bg(theme.list_hover))
                .on_click(cx.listener(move |this, _, _, cx| {
                    this.encoders_open = Some(!open);
                    cx.notify();
                }))
                .child(div().flex_1().min_w_0().text_body().child("Encoders"))
                .child(
                    div()
                        .text_caption()
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
                    .size(px(20.))
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
                        .h(px(48.))
                        .px_4()
                        .text_body()
                        .text_color(if found {
                            theme.muted_foreground
                        } else {
                            theme.warning
                        })
                        .child(div().flex_1().min_w_0().truncate().child(label))
                        .child(if found {
                            div().text_caption().child("Available")
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
        let Some(root) = current.root().cloned() else {
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
            let Some(dir) = oriel_core_tidy::relative_within(&folder, Path::new(&root.path)) else {
                window.show_toast(
                    Toast::error(format!("That folder is outside {}", root.name))
                        .detail("Preferred folders have to be inside the folder being tidied."),
                    cx,
                );
                return;
            };
            state.update(cx, |state, cx| state.prefer_folder(dir, window, cx));
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
                            .quiet_edge(cx)
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
                    .h(px(52.))
                    .pl_4()
                    .pr(px(10.))
                    .child(
                        Icon::new(IconName::Folder)
                            .size(px(20.))
                            .text_color(theme.muted_foreground),
                    )
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .truncate()
                            .text_body()
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
        let priority = root.is_some().then(|| {
            self.read_priority(&settings, cx);
            self.priority_group(&root_name, cx)
        });

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
                        oriel_ui::switch("tidy-settings-background-analysis")
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
                    .description(oriel_core_tidy::sandbox_rule(&data)),
            )
        });

        div()
            .flex()
            .flex_col()
            .child(duplicates)
            .children(priority)
            .child(convert)
            .child(analysis)
            .children(sandbox_group)
            .into_any_element()
    }
}
