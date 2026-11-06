//! Convert (`views/ConvertView.tsx`): stills to AVIF, animations and videos to MP4, in sections
//! of tiles with what each is estimated to leave, the Options that switch kinds off, and the
//! files left as they are and why. Convert N (⌘↩) runs every section as one change.

use gpui_kit::assets::IconName;
use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::menu::DropdownMenu as _;
use gpui_kit::component::{ActiveTheme as _, Disableable as _, Icon};
use gpui_kit::{
    AnyElement, App, Context, Entity, FocusHandle, Focusable, FontWeight, InteractiveElement as _,
    IntoElement, KeyDownEvent, ParentElement as _, Render, SharedString,
    StatefulInteractiveElement as _, Styled as _, Subscription, TestSupportExt as _, Window, div,
    prelude::FluentBuilder as _, px,
};
use oriel_core_tidy::contract::{
    FileFilter, FileFlag, FileFormat, FileKind, FilePage, FileQuery, FileRow, FileSortColumn,
    RootId, Tidy,
};
use oriel_ui::TextRole as _;
use oriel_ui::focus::FocusReveal;
use oriel_ui::{ControlSize as _, TopBar};

use crate::actions::PerformOptions;
use crate::changes::PlanRequest;
use crate::format;
use crate::loaded::Loaded;
use crate::pages::TidyPage;
use crate::state::{ConvertGroup, LibraryPreset, TidyState};
use crate::thumbs::Thumbs;
use crate::widgets;

const SOURCE: &str = "convert";

/// Tiles shown per section; the rest are a link to the Library.
const TILE_LIMIT: usize = 60;

/// Rows read per section to find its tiles among files of other categories.
const SECTION_PAGE: u32 = 300;

/// Why the engine left files out, said the way the owner would say it (`SKIP_WORDS`).
fn skip_words(reason: &str) -> Option<(&'static str, &'static str)> {
    Some(match reason {
        "Already as small as they get" => ("came out no smaller", "came out no smaller"),
        "Won't decode" => ("won't open", "won't open"),
        "A file with the target name already exists" => (
            "would take a name already in use",
            "would take a name already in use",
        ),
        _ => return None,
    })
}

/// One line per reason files stay as they are, plus kinds switched off in Options.
fn left_reasons(tidy: &Tidy, off: &[ConvertGroup]) -> Vec<String> {
    let skipped = tidy
        .convert
        .skipped
        .iter()
        .filter(|entry| entry.files > 0)
        .map(|entry| match skip_words(&entry.reason) {
            Some((one, many)) => format!(
                "{} {}",
                format::count(entry.files),
                if entry.files == 1 { one } else { many }
            ),
            None => format!(
                "{}: {}",
                format::count(entry.files),
                entry.reason.trim_end_matches('.')
            ),
        });
    let switched_off = off.iter().filter_map(|group| {
        let (files, _) = group.totals(tidy);
        let (one, many) = group.nouns();
        (files > 0).then(|| {
            format!(
                "{} switched off in Options",
                format::plural_as(files, one, many)
            )
        })
    });
    skipped.chain(switched_off).collect()
}

/// The files a section's query reads, and which of them belong to it (`SECTION_FILES`).
fn section_query(group: ConvertGroup) -> (FileKind, Vec<FileFormat>) {
    match group {
        ConvertGroup::Pictures => (
            FileKind::Image,
            vec![
                FileFormat::Png,
                FileFormat::Jpeg,
                FileFormat::Webp,
                FileFormat::Bmp,
            ],
        ),
        ConvertGroup::Animations => (
            FileKind::Image,
            vec![FileFormat::Gif, FileFormat::Png, FileFormat::Webp],
        ),
        ConvertGroup::Videos => (FileKind::Video, Vec::new()),
    }
}

fn belongs(group: ConvertGroup, row: &FileRow) -> bool {
    match group {
        ConvertGroup::Pictures => row.frames.unwrap_or(1) <= 1,
        ConvertGroup::Animations => {
            row.format == Some(FileFormat::Gif) || row.frames.unwrap_or(1) > 1
        }
        // MP4 under another extension only needs renaming, which Clean up does.
        ConvertGroup::Videos => {
            !(row.format == Some(FileFormat::Mp4) && !row.ext.eq_ignore_ascii_case("mp4"))
        }
    }
}

pub struct ConvertPage {
    state: Entity<TidyState>,
    thumbs: Entity<Thumbs>,
    focus: FocusHandle,
    pictures: Loaded<FilePage>,
    animations: Loaded<FilePage>,
    videos: Loaded<FilePage>,
    left_open: bool,
    seen: (Option<RootId>, u64),
    _subscriptions: Vec<Subscription>,
}

impl ConvertPage {
    pub fn new(state: &Entity<TidyState>, thumbs: &Entity<Thumbs>, cx: &mut Context<Self>) -> Self {
        let subscriptions = vec![
            cx.observe(state, |this, _, cx| this.sync(cx)),
            cx.observe(thumbs, |_, _, cx| cx.notify()),
        ];
        Self {
            state: state.clone(),
            thumbs: thumbs.clone(),
            focus: cx.focus_handle(),
            pictures: Loaded::default(),
            animations: Loaded::default(),
            videos: Loaded::default(),
            left_open: false,
            seen: (None, 0),
            _subscriptions: subscriptions,
        }
    }

    fn slot(&mut self, group: ConvertGroup) -> &mut Loaded<FilePage> {
        match group {
            ConvertGroup::Pictures => &mut self.pictures,
            ConvertGroup::Animations => &mut self.animations,
            ConvertGroup::Videos => &mut self.videos,
        }
    }

    fn sync(&mut self, cx: &mut Context<Self>) {
        let state = self.state.read(cx);
        let key = (state.root_id(), state.catalog_version());
        if state.page() != TidyPage::Convert || key == self.seen {
            cx.notify();
            return;
        }
        self.seen = key;
        let (Some(engine), Some(root_id)) = (state.engine().cloned(), state.root_id()) else {
            return;
        };
        for group in ConvertGroup::ALL {
            let (kind, formats) = section_query(group);
            let query = FileQuery {
                filter: FileFilter {
                    kinds: vec![kind],
                    formats,
                    flags: vec![FileFlag::Convertible],
                    ..FileFilter::root(Some(root_id))
                },
                sort: FileSortColumn::Path,
                descending: false,
                offset: 0,
                limit: SECTION_PAGE,
            };
            let answer = engine.list_files(query);
            let slot: fn(&mut Self) -> &mut Loaded<FilePage> = match group {
                ConvertGroup::Pictures => |this| &mut this.pictures,
                ConvertGroup::Animations => |this| &mut this.animations,
                ConvertGroup::Videos => |this| &mut this.videos,
            };
            self.slot(group).load(answer, slot, cx);
        }
        cx.notify();
    }

    /// Convert N: every section switched on, as one change.
    pub fn convert(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let state = self.state.read(cx);
        let Some(root_id) = state.root_id() else {
            return;
        };
        let categories = state.convert_categories();
        if categories.is_empty() || state.change_status(SOURCE).is_some() {
            return;
        }
        self.state.update(cx, |state, cx| {
            state.perform(
                PlanRequest::Optimize {
                    root_id,
                    categories,
                    file_ids: None,
                },
                PerformOptions::from(SOURCE),
                window,
                cx,
            );
        });
    }

    fn on_key_down(&mut self, event: &KeyDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        // It is the open menu's, or nothing's; the page must not act on it behind the menu.
        if oriel_ui::popups::popup_open(window, cx) {
            return;
        }
        if oriel_ui::keys::command_held(&event.keystroke.modifiers)
            && event.keystroke.key == "enter"
        {
            self.convert(window, cx);
            cx.stop_propagation();
        }
    }

    fn render_section(
        &mut self,
        group: ConvertGroup,
        tidy: &Tidy,
        reveal: &FocusReveal,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let state = self.state.read(cx);
        let (files, bytes) = group.totals(tidy);
        let estimate = state.estimate(group.categories());
        // Electron's test, `!video.avc && !ffmpeg`: Oriel encodes video only through ffmpeg.
        let no_video_encoder = group == ConvertGroup::Videos
            && state
                .capabilities()
                .is_some_and(|found| !found.video.avc && !found.ffmpeg);
        let warning = cx.theme().warning;
        let ratio = estimate.ratio();
        let rows: Vec<FileRow> = self
            .slot(group)
            .data()
            .map(|page| {
                page.rows
                    .iter()
                    .filter(|row| belongs(group, row))
                    .take(TILE_LIMIT)
                    .cloned()
                    .collect()
            })
            .unwrap_or_default();
        let more = files - rows.len() as i64;
        let loaded = self.slot(group).data().is_some();
        let repeated = widgets::repeated_names(&rows.iter().collect::<Vec<_>>());
        let running = self.state.read(cx).running_file(cx);
        // Estimates wait behind a running change, so while one runs there is nothing to wait for.
        let changing = self.state.read(cx).has_change();
        let tiles: Vec<AnyElement> = rows
            .iter()
            .map(|row| {
                let folder = repeated.contains(&row.name);
                let badge = running
                    .as_ref()
                    .filter(|file| file.rel_path == row.rel_path)
                    .map(|file| widgets::running_badge("Converting", file, cx));
                widgets::media_tile(&self.thumbs, row, ratio, folder, badge, cx)
            })
            .collect();
        let (one, many) = group.nouns();
        let kind = section_query(group).0;
        let more_button = (more > 0 && loaded).then(|| {
            let button = Button::new(SharedString::from(format!("convert-more-{}", group.key())))
                .row_size()
                .text()
                .label(format!("and {} more", format::count(more)))
                .on_click(cx.listener(move |this, _, _, cx| {
                    this.state.update(cx, |state, cx| {
                        state.open_library(
                            LibraryPreset {
                                flags: vec![FileFlag::Convertible],
                                kinds: vec![kind],
                                ..LibraryPreset::default()
                            },
                            cx,
                        );
                    });
                }));
            reveal.keep(
                format!("convert-more-{}", group.key()),
                div().mt(px(-12.)).mb_6().child(button),
                window,
                cx,
            )
        });
        div()
            .id(SharedString::from(format!(
                "convert-section-{}",
                group.key()
            )))
            .test_support()
            .aria_label(SharedString::from(format!(
                "{} → {}",
                format::plural_as(files, one, many),
                group.target()
            )))
            .flex()
            .flex_col()
            .child(
                div()
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap_3()
                    .h(px(44.))
                    .child(
                        div()
                            .text_body()
                            .font_weight(FontWeight::MEDIUM)
                            .child(format!(
                                "{} → {}",
                                format::plural_as(files, one, many),
                                group.target()
                            )),
                    )
                    .when(no_video_encoder, |this| {
                        this.child(
                            div()
                                .text_caption()
                                .text_color(warning)
                                .child("No H.264 encoder on this machine"),
                        )
                    })
                    .child(div().flex_1())
                    .child(widgets::caption(
                        match estimate {
                            crate::state::Estimate::Pending if changing => {
                                format::bytes(bytes as f64)
                            }
                            _ => estimate.describe(bytes as f64),
                        },
                        cx,
                    )),
            )
            .child(widgets::tile_grid(tiles))
            .children(more_button)
            .into_any_element()
    }

    fn render_left(&self, reasons: &[String], left: i64, cx: &mut Context<Self>) -> AnyElement {
        let theme = cx.theme();
        div()
            .id("convert-left")
            .flex()
            .flex_col()
            .child(
                div()
                    .id("convert-left-toggle")
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap(px(6.))
                    .h(px(44.))
                    .cursor_pointer()
                    .text_body()
                    .font_weight(FontWeight::MEDIUM)
                    .on_click(cx.listener(|this, _, _, cx| {
                        this.left_open = !this.left_open;
                        cx.notify();
                    }))
                    .child(
                        Icon::new(if self.left_open {
                            IconName::ChevronDown
                        } else {
                            IconName::ChevronRight
                        })
                        .size(px(16.))
                        .text_color(theme.muted_foreground),
                    )
                    .child(format!("{} left as they are", format::count(left))),
            )
            .when(self.left_open, |this| {
                this.child(widgets::left_list(reasons, cx))
            })
            .into_any_element()
    }
}

impl Focusable for ConvertPage {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}

impl Render for ConvertPage {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        // The videos' section says when this machine has no encoder for them.
        self.state
            .update(cx, |state, cx| state.ask_capabilities(cx));
        let state = self.state.read(cx);
        let shell = state.shell.clone();
        let tidy = state.overview.data().cloned();
        let error = state.overview.error().cloned();
        let enabled: Vec<ConvertGroup> = state.convert_groups().iter().copied().collect();
        let off: Vec<ConvertGroup> = ConvertGroup::ALL
            .into_iter()
            .filter(|group| !enabled.contains(group))
            .collect();
        let status = state.change_status(SOURCE);
        let changing = state.is_changing();

        let Some(tidy) = tidy else {
            let body = match error {
                Some(error) => {
                    let state = self.state.clone();
                    widgets::error_state(
                        "convert-error",
                        "Couldn't plan the conversion",
                        error,
                        move |_, cx| state.update(cx, |state, cx| state.changed(cx)),
                        cx,
                    )
                }
                None => div().flex_1().into_any_element(),
            };
            return div()
                .id("convert")
                .track_focus(&self.focus)
                .flex()
                .flex_col()
                .size_full()
                .child(TopBar::new(&shell, "Convert"))
                .child(body);
        };

        let sections: Vec<ConvertGroup> = enabled
            .iter()
            .copied()
            .filter(|group| group.totals(&tidy).0 > 0)
            .collect();
        let (files, bytes) = sections.iter().fold((0, 0), |(files, bytes), group| {
            let (f, b) = group.totals(&tidy);
            (files + f, bytes + b)
        });
        let reasons = left_reasons(&tidy, &off);
        let left: i64 = tidy
            .convert
            .skipped
            .iter()
            .map(|entry| entry.files)
            .sum::<i64>()
            + off.iter().map(|group| group.totals(&tidy).0).sum::<i64>();
        let theme = cx.theme();
        let meta = (files > 0).then(|| {
            format!(
                "{} · {}",
                format::plural(files, "file"),
                format::bytes(bytes as f64)
            )
        });
        let options_state = self.state.clone();
        let counts: Vec<(ConvertGroup, i64, bool)> = ConvertGroup::ALL
            .into_iter()
            .map(|group| (group, group.totals(&tidy).0, enabled.contains(&group)))
            .collect();
        let options = Button::new("convert-options")
            .bar_size()
            .outline().quiet_edge(cx)
            .label("Options")
            .dropdown_menu(move |menu, _, _| {
                let mut menu = menu;
                for (group, files, on) in counts.clone() {
                    let state = options_state.clone();
                    menu = menu.item(
                        oriel_ui::menu_row(format!("{}  {}", group.label(), format::count(files)))
                            .checked(on)
                            .on_click(move |_, _, cx| {
                                state.update(cx, |state, cx| state.set_convert_group(group, !on, cx));
                            }),
                    );
                }
                menu.separator().label(
                    "Pictures use AVIF at quality 70. Video tracks MP4 can hold are copied as they are.",
                )
            });
        // Another page's change running, this one queues behind it.
        // With nothing that can run there is no command to offer, only a run still finishing.
        let action = (files > 0 || status.is_some()).then(|| {
            widgets::while_changing(
                widgets::primary_action(
                    "convert-run",
                    format!("Convert {}", format::count(files)),
                    "⌘↩",
                )
                .disabled(files == 0)
                .on_click(cx.listener(|this, _, window, cx| this.convert(window, cx))),
                status,
            )
            .into_any_element()
        });
        let top_bar = TopBar::new(&shell, "Convert")
            .when_some(meta, |bar, meta| {
                bar.quiet(
                    div()
                        .id("convert-meta")
                        .test_support()
                        .aria_label(SharedString::from(meta.clone()))
                        .min_w_0()
                        .truncate()
                        .text_caption()
                        .text_color(theme.muted_foreground)
                        .child(meta),
                )
            })
            .trailing(options)
            .when_some(action, |bar, action| bar.trailing(action));

        let body: AnyElement = if files == 0 && !changing {
            let title = if enabled.is_empty() {
                "Nothing chosen to convert"
            } else {
                "Nothing left to convert"
            };
            let note: Option<AnyElement> = if enabled.is_empty() {
                Some("Turn a kind of file on in Options.".into_any_element())
            } else if left > 0 {
                Some(
                    Button::new("convert-left-link")
                        .row_size()
                        .text()
                        .label(format!("{} left as they are", format::plural(left, "file")))
                        .on_click(cx.listener(|this, _, _, cx| {
                            this.left_open = !this.left_open;
                            cx.notify();
                        }))
                        .into_any_element(),
                )
            } else {
                None
            };
            let list = (self.left_open && !enabled.is_empty() && !reasons.is_empty()).then(|| {
                div()
                    .mx_auto()
                    .w_full()
                    .max_w(widgets::PAGE_COLUMN)
                    .px_6()
                    .pb_10()
                    .child(widgets::left_list(&reasons, cx))
            });
            div()
                .id("convert-scroll")
                .test_support()
                .flex()
                .flex_col()
                .flex_1()
                .min_h_0()
                .overflow_y_scroll()
                .child(widgets::empty_state(
                    "convert-empty",
                    Some(if enabled.is_empty() {
                        IconName::Repeat2
                    } else {
                        IconName::CircleCheck
                    }),
                    title,
                    note,
                    Vec::new(),
                    cx,
                ))
                .children(list)
                .into_any_element()
        } else {
            let reveal = FocusReveal::of("convert-reveal", px(0.), window, cx);
            let sections: Vec<AnyElement> = sections
                .into_iter()
                .map(|group| self.render_section(group, &tidy, &reveal, window, cx))
                .collect();
            let left_section = (left > 0).then(|| self.render_left(&reasons, left, cx));
            div()
                .id("convert-scroll")
                .test_support()
                .flex_1()
                .min_h_0()
                .overflow_y_scroll()
                .track_scroll(reveal.scroll())
                .px_5()
                .pt_4()
                .pb(px(112.))
                .children(sections)
                .children(left_section)
                .into_any_element()
        };

        div()
            .id("convert")
            .track_focus(&self.focus)
            .key_context("TidyConvert")
            .on_key_down(cx.listener(Self::on_key_down))
            .flex()
            .flex_col()
            .size_full()
            .min_h_0()
            .child(top_bar)
            .child(body)
    }
}
