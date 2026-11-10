//! View's section of the one Settings page: the gallery and viewer preferences, the caches, the
//! keys, and Diagnostics. The theme is the shell's (General). Each switch is named by its row's
//! label.

use gpui_kit::component::slider::{Slider, SliderEvent, SliderState};
use gpui_kit::component::{ActiveTheme as _, WindowExt as _, button::Button};
use gpui_kit::{
    AnyElement, App, AppContext as _, ClipboardItem, Context, ElementId, Entity,
    InteractiveElement as _, IntoElement, ParentElement as _, Role, SharedString,
    StatefulInteractiveElement as _, Styled as _, Subscription, TestSupportExt as _, Window, div,
    px,
};
use oriel_tools::MediaTools;
use oriel_ui::ControlSize as _;
use oriel_ui::TextRole as _;
use oriel_ui::{SettingsGroup, SettingsRow};

use crate::ViewMode;
use crate::gallery::display_name;
use crate::settings::ViewSettings;

/// The thumbnail size slider's range and step.
const THUMBNAIL_SIZE_RANGE: (f32, f32, f32) = (140., 340., 10.);

/// What the section keeps between frames.
pub(crate) struct SettingsPanel {
    thumbnail_size: Entity<SliderState>,
    /// The size being dragged, saved when the slider is let go.
    thumbnail_draft: Option<u32>,
    diagnostics_shown: bool,
    diagnostics_status: Option<SharedString>,
    _subscriptions: Vec<Subscription>,
}

impl SettingsPanel {
    pub(crate) fn new(window: &mut Window, cx: &mut Context<ViewMode>) -> Self {
        let (min, max, step) = THUMBNAIL_SIZE_RANGE;
        let thumbnail_size = cx.new(|_| SliderState::new().max(max).min(min).step(step));
        let subscriptions = vec![cx.subscribe_in(
            &thumbnail_size,
            window,
            |view: &mut ViewMode, _, event: &SliderEvent, window, cx| {
                let (value, release) = match event {
                    SliderEvent::Change(value) => (value.end(), false),
                    SliderEvent::Release(value) => (value.end(), true),
                };
                let size = value.round() as u32;
                if release {
                    view.settings_panel.thumbnail_draft = None;
                    if size != view.settings().thumbnail_size {
                        view.change_settings(window, cx, |settings| settings.thumbnail_size = size);
                    }
                } else {
                    view.settings_panel.thumbnail_draft = Some(size);
                    cx.notify();
                }
            },
        )];
        Self {
            thumbnail_size,
            thumbnail_draft: None,
            diagnostics_shown: false,
            diagnostics_status: None,
            _subscriptions: subscriptions,
        }
    }

    /// Puts the controls at the settings' values.
    pub(crate) fn sync(&mut self, settings: &ViewSettings, window: &mut Window, cx: &mut App) {
        let size = settings.thumbnail_size as f32;
        self.thumbnail_size.update(cx, |slider, cx| {
            if slider.value().end() != size {
                slider.set_value(size, window, cx);
            }
        });
    }
}

/// A titled group of rows, in the card every section's groups have.
fn group(title: &'static str, rows: Vec<AnyElement>) -> AnyElement {
    SettingsGroup::new(title).children(rows).into_any_element()
}

/// A row: the label and its description on the left, the control on the right.
fn row(
    label: impl Into<SharedString>,
    description: Option<SharedString>,
    control: impl IntoElement,
) -> AnyElement {
    let row = SettingsRow::new(label);
    match description {
        Some(description) => row.description(description),
        None => row,
    }
    .child(control)
    .into_any_element()
}

impl ViewMode {
    /// A switch row whose switch is named by `label` and sets one setting.
    fn switch_row(
        &self,
        id: &'static str,
        label: &'static str,
        description: Option<&'static str>,
        checked: bool,
        set: fn(&mut ViewSettings, bool),
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let view = cx.entity().downgrade();
        let control = oriel_ui::switch(id)
            .checked(checked)
            .accessibility_label(label)
            .on_click(move |checked, window, cx| {
                let checked = *checked;
                view.update(cx, |view, cx| {
                    view.change_settings(window, cx, |settings| set(settings, checked));
                })
                .ok();
            });
        row(label, description.map(SharedString::new_static), control)
    }

    pub(crate) fn render_settings_section(&mut self, cx: &mut Context<Self>) -> AnyElement {
        let settings = self.settings.settings().clone();
        let draft = self
            .settings_panel
            .thumbnail_draft
            .unwrap_or(settings.thumbnail_size);

        let gallery = vec![
            self.switch_row(
                "remember-last-folder",
                "Remember last folder",
                Some("Open it again when Oriel starts."),
                settings.remember_last_folder,
                |settings, on| settings.remember_last_folder = on,
                cx,
            ),
            self.switch_row(
                "recursive-default",
                "Enable recursive mode by default",
                Some("Show the media in every subfolder too."),
                settings.recursive_default,
                |settings, on| settings.recursive_default = on,
                cx,
            ),
            row(
                "Thumbnail size",
                Some(format!("{draft} px wide").into()),
                div()
                    .relative()
                    .w(px(160.))
                    // The kit's rest of the track is too faint to see where the scale ends: a
                    // line in the input's colour shows through it.
                    .child(
                        div()
                            .absolute()
                            .left_0()
                            .right_0()
                            .top(px(14.))
                            .h(px(4.))
                            .rounded_full()
                            .bg(cx.theme().input),
                    )
                    .child(
                        Slider::new(&self.settings_panel.thumbnail_size)
                            .accessibility_label("Thumbnail size")
                            .h_8(),
                    ),
            ),
            self.switch_row(
                "show-images",
                "Show images",
                None,
                settings.filters.show_images,
                |settings, on| settings.filters.show_images = on,
                cx,
            ),
            self.switch_row(
                "show-videos",
                "Show videos",
                None,
                settings.filters.show_videos,
                |settings, on| settings.filters.show_videos = on,
                cx,
            ),
            self.switch_row(
                "autoplay-on-hover",
                "Autoplay video on hover",
                None,
                settings.autoplay_on_hover,
                |settings, on| settings.autoplay_on_hover = on,
                cx,
            ),
            self.switch_row(
                "preview-audio",
                "Enable audio in video preview",
                None,
                settings.preview_audio_enabled,
                |settings, on| settings.preview_audio_enabled = on,
                cx,
            ),
        ];

        let viewer = vec![
            self.switch_row(
                "autoplay-videos",
                "Autoplay videos in viewer",
                None,
                settings.autoplay_videos,
                |settings, on| settings.autoplay_videos = on,
                cx,
            ),
            self.switch_row(
                "loop-videos",
                "Loop videos",
                None,
                settings.loop_videos,
                |settings, on| settings.loop_videos = on,
                cx,
            ),
            self.switch_row(
                "loop-viewer-navigation",
                "Loop viewer navigation",
                Some("Step from the last item back to the first."),
                settings.loop_viewer_navigation,
                |settings, on| settings.loop_viewer_navigation = on,
                cx,
            ),
        ];

        let tools = MediaTools::shared().ok();
        let storage = vec![
            row(
                "Thumbnail cache",
                Some("Kept so folders open quickly; made again as they are needed.".into()),
                Button::new("clear-thumbnail-cache")
                    .bar_size()
                    .outline()
                    .quiet_edge(cx)
                    .label("Clear thumbnail cache")
                    .on_click(cx.listener(|this, _, window, cx| {
                        this.gallery.update(cx, |gallery, cx| {
                            gallery
                                .thumbnails()
                                .update(cx, |thumbnails, cx| thumbnails.clear_cache(cx));
                        });
                        window.push_notification("Thumbnail cache cleared", cx);
                        this.rebuild_tiles(cx);
                    })),
            ),
            row(
                "ffmpeg and ffprobe",
                Some(
                    tools
                        .map(|tools| tools.ffmpeg().display().to_string())
                        .unwrap_or_else(|| "No ffmpeg in this build".into())
                        .into(),
                ),
                div()
                    .text_caption()
                    .text_color(cx.theme().muted_foreground)
                    .child(if tools.is_some() {
                        "Available"
                    } else {
                        "Not available"
                    }),
            ),
        ];

        // The keys are in View's shortcut sheet, so they are written once.
        let shortcuts = vec![row(
            "Keyboard shortcuts",
            Some("Press ? anywhere in View".into()),
            Button::new("view-shortcuts")
                .row_size()
                .outline()
                .quiet_edge(cx)
                .label("Show")
                .on_click(|_, window, cx| {
                    window.dispatch_action(Box::new(oriel_ui::shortcuts::ShowShortcuts), cx);
                })
                .into_any_element(),
        )];

        div()
            .id("view-settings")
            .flex()
            .flex_col()
            .child(group("Gallery", gallery))
            .child(group("Viewer", viewer))
            .child(group("Storage", storage))
            .child(group("Keys", shortcuts))
            .child(self.render_diagnostics(&settings, cx))
            .into_any_element()
    }

    /// What Diagnostics shows: facts under a title each, then lists of recent lines.
    pub fn diagnostics(&self, cx: &App) -> Diagnostics {
        let catalog = self.catalog.read(cx);
        let gallery = self.gallery.read(cx);
        let thumbnails = gallery.thumbnails().read(cx);
        let stats = thumbnails.stats();
        let state = thumbnails.diagnostics();
        let tools = MediaTools::shared().ok();
        let debug = self.settings.settings().debug;
        let fact = |label: &str, value: String| (label.to_owned(), value);
        let available = if tools.is_some() {
            "available"
        } else {
            "not available"
        };
        let path = |path: Option<&std::path::Path>| {
            path.map_or("unknown".into(), |path| path.display().to_string())
        };

        let mut facts = vec![
            FactGroup {
                title: "Current folder",
                facts: vec![
                    fact(
                        "Folder",
                        catalog
                            .root()
                            .map(|root| display_name(root))
                            .unwrap_or_else(|| "none".into()),
                    ),
                    fact("Items shown", gallery.media().len().to_string()),
                    fact("Recursive", yes_no(self.is_recursive(cx)).into()),
                    fact("Scan", catalog.state().label().to_string()),
                ],
            },
            FactGroup {
                title: "Runtime",
                facts: vec![
                    fact("Version", env!("CARGO_PKG_VERSION").into()),
                    fact(
                        "Platform",
                        format!("{} / {}", std::env::consts::OS, std::env::consts::ARCH),
                    ),
                    fact(
                        "Packaged",
                        yes_no(oriel_core_paths::Package::of_running_app().is_some()).into(),
                    ),
                    fact("Debug logging", yes_no(debug.enable_debug_logging).into()),
                    fact(
                        "Performance monitoring",
                        yes_no(debug.enable_performance_monitoring).into(),
                    ),
                ],
            },
            FactGroup {
                title: "Thumbnails",
                facts: vec![
                    fact("Image workers", state.image_workers.to_string()),
                    fact("Video workers", state.video_workers.to_string()),
                    fact("Images queued", state.images_queued.to_string()),
                    fact("Videos queued", state.videos_queued.to_string()),
                    fact("In flight", state.in_flight.to_string()),
                    fact("Disk cache hits", stats.from_disk().to_string()),
                    fact("Made", stats.generated().to_string()),
                    fact("Cancelled", stats.cancelled().to_string()),
                    fact(
                        "Video frames that failed",
                        stats.video_failures().to_string(),
                    ),
                    fact(
                        "Images ImageIO could not read",
                        stats.decode_failures().to_string(),
                    ),
                    fact("On disk", state.disk_files.to_string()),
                ],
            },
            FactGroup {
                title: "Media tools",
                facts: vec![
                    fact("ffmpeg", available.into()),
                    fact("ffmpeg path", path(tools.map(MediaTools::ffmpeg))),
                    fact("ffprobe", available.into()),
                    fact("ffprobe path", path(tools.map(MediaTools::ffprobe))),
                ],
            },
        ];
        if let Some(timings) = state.timings {
            facts.push(FactGroup {
                title: "Timings",
                facts: vec![
                    fact("Disk hit", timing(&timings.disk_hit)),
                    fact("Made", timing(&timings.generation)),
                    fact("End to end", timing(&timings.end_to_end)),
                ],
            });
        }
        Diagnostics {
            facts,
            lines: vec![
                LineGroup {
                    title: "Recent thumbnail events",
                    lines: state.recent_events,
                },
                LineGroup {
                    title: "Recent thumbnail failures",
                    lines: state.recent_failures,
                },
            ],
        }
    }

    /// The diagnostics report, as text to paste into a bug report:
    /// each group's title, then its facts or lines, "None" for an empty list.
    pub fn diagnostics_report(&self, cx: &App) -> String {
        let diagnostics = self.diagnostics(cx);
        let mut report = vec!["Oriel View Diagnostics".to_owned()];
        for group in &diagnostics.facts {
            report.push(String::new());
            report.push(group.title.to_owned());
            report.extend(
                group
                    .facts
                    .iter()
                    .map(|(label, value)| format!("{label}: {value}")),
            );
        }
        for group in &diagnostics.lines {
            report.push(String::new());
            report.push(group.title.to_owned());
            if group.lines.is_empty() {
                report.push("None".into());
            } else {
                report.extend(group.lines.iter().cloned());
            }
        }
        report.join("\n")
    }

    fn render_diagnostics(&self, settings: &ViewSettings, cx: &mut Context<Self>) -> AnyElement {
        let shown = self.settings_panel.diagnostics_shown;
        let status = self
            .settings_panel
            .diagnostics_status
            .clone()
            .unwrap_or_else(|| {
                "Worker, cache and runtime details, to paste into a bug report.".into()
            });
        let mut rows =
            vec![
            self.switch_row(
                "debug-logging",
                "Enable debug logging",
                None,
                settings.debug.enable_debug_logging,
                |settings, on| settings.debug.enable_debug_logging = on,
                cx,
            ),
            self.switch_row(
                "performance-monitoring",
                "Enable performance monitoring",
                Some(
                    "Kept across launches, so a packaged build can be profiled without a rebuild.",
                ),
                settings.debug.enable_performance_monitoring,
                |settings, on| settings.debug.enable_performance_monitoring = on,
                cx,
            ),
            row(
                "Diagnostics",
                Some(status),
                div()
                    .flex()
                    .flex_row()
                    .gap_2()
                    .child(
                        Button::new("diagnostics-show")
                            .bar_size()
                            .outline().quiet_edge(cx)
                            .label(if shown { "Hide" } else { "Show" })
                            .on_click(cx.listener(|this, _, _, cx| {
                                this.settings_panel.diagnostics_shown =
                                    !this.settings_panel.diagnostics_shown;
                                cx.notify();
                            })),
                    )
                    .child(
                        Button::new("diagnostics-refresh")
                            .bar_size()
                            .outline().quiet_edge(cx)
                            .label("Refresh")
                            .on_click(cx.listener(|this, _, _, cx| {
                                this.settings_panel.diagnostics_status =
                                    Some("Diagnostics refreshed".into());
                                cx.notify();
                            })),
                    )
                    .child(
                        Button::new("diagnostics-copy")
                            .bar_size()
                            .outline().quiet_edge(cx)
                            .label("Copy diagnostics")
                            .on_click(cx.listener(|this, _, _, cx| {
                                let report = this.diagnostics_report(cx);
                                cx.write_to_clipboard(ClipboardItem::new_string(report));
                                this.settings_panel.diagnostics_status =
                                    Some("Copied to the clipboard".into());
                                cx.notify();
                            })),
                    )),
        ];
        if shown {
            let diagnostics = self.diagnostics(cx);
            let theme = cx.theme();
            let (muted, border) = (theme.muted_foreground, theme.border);
            let heading = |title: &'static str| {
                div()
                    .mb(px(6.))
                    .text_body()
                    .font_weight(gpui_kit::FontWeight::MEDIUM)
                    .child(title)
            };
            let section = || div().px_4().py_3().border_t_1().border_color(border);
            let mut details = div()
                .id(ElementId::Name("diagnostics-details".into()))
                .role(Role::Document)
                .test_support()
                .aria_label("Diagnostics details")
                .flex()
                .flex_col()
                .text_caption();
            for group in diagnostics.facts {
                details = details.child(section().child(heading(group.title)).children(
                    group.facts.into_iter().map(|(label, value)| {
                        div()
                            .flex()
                            .flex_row()
                            .gap_4()
                            .child(div().flex_shrink_0().text_color(muted).child(label))
                            .child(div().flex_1().min_w_0().text_right().child(value))
                    }),
                ));
            }
            for group in diagnostics.lines {
                let lines = if group.lines.is_empty() {
                    vec![div().text_color(muted).child("None")]
                } else {
                    group
                        .lines
                        .into_iter()
                        .map(|line| div().child(line))
                        .collect()
                };
                details = details.child(section().child(heading(group.title)).children(lines));
            }
            rows.push(details.into_any_element());
        }
        group("Diagnostics", rows)
    }
}

/// A titled list of facts in Diagnostics (`Facts`).
pub struct FactGroup {
    pub title: &'static str,
    pub facts: Vec<(String, String)>,
}

/// A titled list of recorded lines in Diagnostics (`Lines`).
pub struct LineGroup {
    pub title: &'static str,
    pub lines: Vec<String>,
}

/// Everything Diagnostics shows.
pub struct Diagnostics {
    pub facts: Vec<FactGroup>,
    pub lines: Vec<LineGroup>,
}

/// A timing as Diagnostics writes it (`timing`): "12.5 ms average, 40 ms at most".
fn timing(aggregate: &crate::thumbnails::TimingAggregate) -> String {
    format!(
        "{} ms average, {} ms at most",
        aggregate.average_ms(),
        aggregate.max_ms()
    )
}

fn yes_no(value: bool) -> &'static str {
    if value { "yes" } else { "no" }
}
