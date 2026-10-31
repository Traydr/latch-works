//! Clean up (`views/CleanupView.tsx`): silent soundtracks, junk files, empty folders and wrong
//! extensions, each a card with its own action and its first rows, and Clean up N (⌘↩) for all
//! of them as one change.

use gpui_kit::assets::IconName;
use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::{ActiveTheme as _, Disableable as _, Icon, Sizable as _};
use gpui_kit::{
    AnyElement, App, Context, Entity, FocusHandle, Focusable, FontWeight, InteractiveElement as _,
    IntoElement, KeyDownEvent, ObjectFit, ParentElement as _, Render, SharedString,
    StatefulInteractiveElement as _, Styled as _, Subscription, TestSupportExt as _, Window, div,
    prelude::FluentBuilder as _, px,
};
use oriel_core_tidy::contract::{
    AudioState, FileFilter, FileFlag, FileFormat, FileKind, FilePage, FileQuery, FileRow,
    FileSortColumn, RootId,
};
use oriel_ui::TopBar;

use crate::actions::{PerformOptions, TidyStep};
use crate::changes::{PlanRequest, Rename};
use crate::format;
use crate::loaded::Loaded;
use crate::pages::TidyPage;
use crate::sidebar::cleanup_count;
use crate::state::{LibraryPreset, TidyState};
use crate::thumbs::{self, Thumbs};
use crate::widgets;

const SOURCE: &str = "cleanup";

/// Rows shown per section; the rest are a link to the Library.
const ROW_LIMIT: u32 = 50;

/// The extension a file of each format is renamed to, as the engine's Clean up names them.
fn preferred_extension(format: FileFormat) -> Option<&'static str> {
    Some(match format {
        FileFormat::Png => "png",
        FileFormat::Jpeg => "jpg",
        FileFormat::Gif => "gif",
        FileFormat::Webp => "webp",
        FileFormat::Bmp => "bmp",
        FileFormat::Tiff => "tif",
        FileFormat::Avif => "avif",
        FileFormat::Heic => "heic",
        FileFormat::Psd => "psd",
        FileFormat::Svg => "svg",
        FileFormat::Mp4 => "mp4",
        FileFormat::Mov => "mov",
        FileFormat::Matroska => "mkv",
        FileFormat::Webm => "webm",
        FileFormat::Mpegts => "ts",
        FileFormat::Avi => "avi",
        FileFormat::Flv => "flv",
        FileFormat::Asf => "wmv",
        FileFormat::Mp3 => "mp3",
        FileFormat::M4a => "m4a",
        FileFormat::Wav => "wav",
        FileFormat::Flac => "flac",
        FileFormat::Ogg => "ogg",
        FileFormat::Pdf => "pdf",
        FileFormat::Zip => "zip",
        FileFormat::Rar => "rar",
        FileFormat::SevenZ => "7z",
        FileFormat::Empty | FileFormat::Unknown => return None,
    })
}

fn with_extension(name: &str, extension: &str) -> String {
    match name.rfind('.') {
        Some(dot) if dot > 0 => format!("{}.{extension}", &name[..dot]),
        _ => format!("{name}.{extension}"),
    }
}

/// The name Clean up gives a file: AVIF and MP4 always under their own extension, anything else
/// under its format's when the one it has is wrong (`fixedName`).
pub fn fixed_name(row: &FileRow) -> Option<String> {
    let ext = row.ext.to_lowercase();
    if let Some(format @ (FileFormat::Avif | FileFormat::Mp4)) = row.format
        && ext != format.as_str()
    {
        return Some(with_extension(&row.name, format.as_str()));
    }
    let preferred = row.format.and_then(preferred_extension)?;
    row.extension_mismatch
        .then(|| with_extension(&row.name, preferred))
}

fn first_page(filter: FileFilter) -> FileQuery {
    FileQuery {
        filter,
        sort: FileSortColumn::Path,
        descending: false,
        offset: 0,
        limit: ROW_LIMIT,
    }
}

pub struct CleanupPage {
    state: Entity<TidyState>,
    thumbs: Entity<Thumbs>,
    focus: FocusHandle,
    silent: Loaded<FilePage>,
    junk: Loaded<FilePage>,
    folders: Loaded<Vec<String>>,
    mismatched: Loaded<FilePage>,
    renamed: Loaded<FilePage>,
    seen: (Option<RootId>, u64),
    _subscriptions: Vec<Subscription>,
}

impl CleanupPage {
    pub fn new(state: &Entity<TidyState>, thumbs: &Entity<Thumbs>, cx: &mut Context<Self>) -> Self {
        let subscriptions = vec![
            cx.observe(state, |this, _, cx| this.sync(cx)),
            cx.observe(thumbs, |_, _, cx| cx.notify()),
        ];
        Self {
            state: state.clone(),
            thumbs: thumbs.clone(),
            focus: cx.focus_handle(),
            silent: Loaded::default(),
            junk: Loaded::default(),
            folders: Loaded::default(),
            mismatched: Loaded::default(),
            renamed: Loaded::default(),
            seen: (None, 0),
            _subscriptions: subscriptions,
        }
    }

    fn sync(&mut self, cx: &mut Context<Self>) {
        let state = self.state.read(cx);
        let key = (state.root_id(), state.catalog_version());
        if state.page() != TidyPage::CleanUp || key == self.seen {
            cx.notify();
            return;
        }
        self.seen = key;
        let (Some(engine), Some(root_id)) = (state.engine().cloned(), state.root_id()) else {
            return;
        };
        let root = FileFilter::root(Some(root_id));
        self.silent.load(
            engine.list_files(first_page(FileFilter {
                kinds: vec![FileKind::Video],
                audio_states: vec![AudioState::Silent],
                ..root.clone()
            })),
            |this| &mut this.silent,
            cx,
        );
        self.junk.load(
            engine.list_files(first_page(FileFilter {
                flags: vec![FileFlag::Junk],
                ..root.clone()
            })),
            |this| &mut this.junk,
            cx,
        );
        self.folders.load(
            engine.list_empty_folders(root_id),
            |this| &mut this.folders,
            cx,
        );
        self.mismatched.load(
            engine.list_files(first_page(FileFilter {
                flags: vec![FileFlag::ExtensionMismatch],
                ..root.clone()
            })),
            |this| &mut this.mismatched,
            cx,
        );
        // AVIF and MP4 files under another extension the format accepts, such as .m4v.
        self.renamed.load(
            engine.list_files(first_page(FileFilter {
                formats: vec![FileFormat::Avif, FileFormat::Mp4],
                flags: vec![FileFlag::Convertible],
                ..root
            })),
            |this| &mut this.renamed,
            cx,
        );
        cx.notify();
    }

    fn extension_rows(&self) -> Vec<(FileRow, String)> {
        let mut seen = std::collections::HashSet::new();
        self.mismatched
            .data()
            .into_iter()
            .chain(self.renamed.data())
            .flat_map(|page| page.rows.iter())
            .filter(|row| row.kind != FileKind::Junk && seen.insert(row.id))
            .filter_map(|row| fixed_name(row).map(|name| (row.clone(), name)))
            .collect()
    }

    /// Clean up N: junk, empty folders and extensions as one plan, then silent soundtracks, as
    /// one change with one Undo.
    pub fn clean_up(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let state = self.state.read(cx);
        let (Some(root), Some(tidy)) = (state.root().cloned(), state.overview.data().cloned())
        else {
            return;
        };
        if state.change_status(SOURCE).is_some() {
            return;
        }
        let cleanup = tidy.cleanup;
        let mut steps = Vec::new();
        if cleanup.junk + cleanup.empty_folders + cleanup.extensions > 0 {
            steps.push(TidyStep::Planned(PlanRequest::Cleanup { root_id: root.id }));
        }
        if tidy.silent_tracks.files > 0 {
            steps.push(TidyStep::SilentVideos(root.id));
        }
        self.state.update(cx, |state, cx| match steps.as_slice() {
            [TidyStep::Planned(request)] => {
                state.perform(request.clone(), PerformOptions::from(SOURCE), window, cx);
            }
            [] => {}
            _ => state.perform_all(
                "Clean up",
                steps,
                format!("Cleaned up {}", root.name),
                SOURCE,
                window,
                cx,
            ),
        });
    }

    fn remove_sound(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(root_id) = self.state.read(cx).root_id() else {
            return;
        };
        self.state.update(cx, |state, cx| {
            state.perform_all(
                "Remove silent soundtracks",
                vec![TidyStep::SilentVideos(root_id)],
                "Removed silent soundtracks".into(),
                "cleanup:silent",
                window,
                cx,
            );
        });
    }

    fn fix_extensions(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let state = self.state.read(cx);
        let (Some(engine), Some(root_id)) = (state.engine().cloned(), state.root_id()) else {
            return;
        };
        let extensions = state
            .overview
            .data()
            .map_or(0, |tidy| tidy.cleanup.extensions);
        // Renames the mismatch fix leaves alone: AVIF and MP4 under an extension their format
        // allows.
        let renames: Vec<Rename> = self
            .renamed
            .data()
            .map(|page| {
                page.rows
                    .iter()
                    .filter(|row| !row.extension_mismatch)
                    .filter_map(|row| {
                        fixed_name(row).map(|name| Rename {
                            file_id: row.id,
                            name,
                        })
                    })
                    .collect()
            })
            .unwrap_or_default();
        let ids = engine.list_file_ids(FileFilter {
            flags: vec![FileFlag::ExtensionMismatch],
            ..FileFilter::root(Some(root_id))
        });
        cx.spawn_in(window, async move |this, cx| {
            let ids = ids.await.map(|list| list.ids).unwrap_or_default();
            this.update_in(cx, |this, window, cx| {
                let mut steps = Vec::new();
                if !ids.is_empty() {
                    steps.push(TidyStep::Planned(PlanRequest::FixExtension {
                        file_ids: ids,
                    }));
                }
                if !renames.is_empty() {
                    steps.push(TidyStep::Planned(PlanRequest::Rename { renames }));
                }
                this.state.update(cx, |state, cx| match steps.as_slice() {
                    [TidyStep::Planned(request)] => state.perform(
                        request.clone(),
                        PerformOptions::from("cleanup:extensions"),
                        window,
                        cx,
                    ),
                    [] => {}
                    _ => state.perform_all(
                        "Fix extensions",
                        steps,
                        format!("Fixed {}", format::plural(extensions, "extension")),
                        "cleanup:extensions",
                        window,
                        cx,
                    ),
                });
            })
            .ok();
        })
        .detach();
    }

    fn on_key_down(&mut self, event: &KeyDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        if event.keystroke.modifiers.platform && event.keystroke.key == "enter" {
            self.clean_up(window, cx);
            cx.stop_propagation();
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn section(
        &self,
        id: &'static str,
        title: &'static str,
        count: i64,
        action: &'static str,
        source: &'static str,
        run: fn(&mut Self, &mut Window, &mut Context<Self>),
        rows: Vec<AnyElement>,
        more: Option<LibraryPreset>,
        cx: &mut Context<Self>,
    ) -> Option<AnyElement> {
        if count == 0 {
            return None;
        }
        let shown = rows.len() as i64;
        let status = self.state.read(cx).change_status(source);
        let theme = cx.theme();
        let border = theme.border;
        let muted = theme.muted_foreground;
        let footer = (count > shown && shown > 0).then(|| {
            let content: AnyElement = match more {
                Some(preset) => Button::new(SharedString::from(format!("{id}-more")))
                    .text()
                    .small()
                    .label("Show all in Library")
                    .on_click(cx.listener(move |this, _, _, cx| {
                        let preset = preset.clone();
                        this.state
                            .update(cx, |state, cx| state.open_library(preset, cx));
                    }))
                    .into_any_element(),
                None => format!("and {} more", format::count(count - shown)).into_any_element(),
            };
            div()
                .flex()
                .items_center()
                .h(px(44.))
                .px_4()
                .border_t_1()
                .border_color(border)
                .text_size(px(13.))
                .text_color(muted)
                .child(content)
        });
        Some(
            widgets::card(cx)
                .id(SharedString::from(format!("cleanup-{id}")))
                .test_support()
                .aria_label(SharedString::from(format!("{title} {count}")))
                .child(
                    div()
                        .flex()
                        .flex_row()
                        .items_center()
                        .gap_2()
                        .h(px(48.))
                        .px_4()
                        .child(
                            div()
                                .text_size(px(13.))
                                .font_weight(FontWeight::SEMIBOLD)
                                .child(title),
                        )
                        .child(widgets::caption(format::count(count), cx))
                        .child(div().flex_1())
                        .child(widgets::while_changing(
                            Button::new(SharedString::from(format!("cleanup-{id}-run")))
                                .outline()
                                .small()
                                .label(action)
                                .on_click(
                                    cx.listener(move |this, _, window, cx| run(this, window, cx)),
                                ),
                            status,
                        )),
                )
                .child(
                    div()
                        .flex()
                        .flex_col()
                        .border_t_1()
                        .border_color(border)
                        .children(rows.into_iter().enumerate().map(|(index, row)| {
                            div()
                                .when(index > 0, |this| this.border_t_1().border_color(border))
                                .child(row)
                        })),
                )
                .children(footer)
                .into_any_element(),
        )
    }

    fn name_and_folder(name: &str, dir: &str, cx: &App) -> AnyElement {
        div()
            .flex()
            .flex_col()
            .flex_1()
            .min_w_0()
            .child(div().truncate().text_size(px(13.)).child(name.to_string()))
            .when(!dir.is_empty(), |this| {
                this.child(widgets::caption(dir.to_string(), cx).truncate())
            })
            .into_any_element()
    }
}

impl Focusable for CleanupPage {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}

impl Render for CleanupPage {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let state = self.state.read(cx);
        let shell = state.shell.clone();
        let tidy = state.overview.data().cloned();
        let error = state.overview.error().cloned();
        let status = state.change_status(SOURCE);
        let changing = state.is_changing();
        let Some(tidy) = tidy else {
            let body = match error {
                Some(error) => {
                    let state = self.state.clone();
                    widgets::error_state(
                        "cleanup-error",
                        "Couldn't find what to clean up",
                        error,
                        move |_, cx| state.update(cx, |state, cx| state.changed(cx)),
                        cx,
                    )
                }
                None => div().flex_1().into_any_element(),
            };
            return div()
                .id("cleanup")
                .track_focus(&self.focus)
                .flex()
                .flex_col()
                .size_full()
                .child(TopBar::new(&shell, "Clean up"))
                .child(body);
        };
        let total = cleanup_count(&tidy);
        let measuring = tidy.analysis.sound_measured < tidy.analysis.sound_measurable;
        let theme = cx.theme();
        let muted = theme.muted_foreground;
        // Another page's change running, this one queues behind it.
        let action: Option<AnyElement> = (total > 0 || status.is_some()).then(|| {
            widgets::while_changing(
                widgets::primary_action(
                    "cleanup-run-all",
                    format!("Clean up {}", format::count(total)),
                    "⌘↩",
                )
                .disabled(total == 0)
                .on_click(cx.listener(|this, _, window, cx| this.clean_up(window, cx))),
                status,
            )
            .into_any_element()
        });
        let top_bar = TopBar::new(&shell, "Clean up")
            .when(total > 0, |bar| {
                bar.trailing(widgets::caption(format::plural(total, "item"), cx))
            })
            .when_some(action, |bar, action| bar.trailing(action));

        let body: AnyElement = if total == 0 && !changing {
            widgets::empty_state(
                "cleanup-empty",
                Some(IconName::Sparkles),
                "Nothing to clean up",
                Some(if measuring {
                    div()
                        .flex()
                        .flex_row()
                        .items_center()
                        .gap_1p5()
                        .child(gpui_kit::component::spinner::Spinner::new().small())
                        .child(format!(
                            "Still measuring soundtracks · {} of {}",
                            format::count(tidy.analysis.sound_measured),
                            format::count(tidy.analysis.sound_measurable)
                        ))
                        .into_any_element()
                } else {
                    "Silent soundtracks, junk files, empty folders and wrong extensions show up \
                     here."
                        .into_any_element()
                }),
                Vec::new(),
                cx,
            )
            .into_any_element()
        } else {
            let silent_rows: Vec<AnyElement> = self
                .silent
                .data()
                .map(|page| page.rows.clone())
                .unwrap_or_default()
                .iter()
                .map(|row| {
                    let picture = thumbs::picture(&self.thumbs, row, 160, ObjectFit::Cover, cx);
                    let id = row.id;
                    let source: SharedString = format!("cleanup:silent:{id}").into();
                    let busy = self.state.read(cx).change_status(&source);
                    div()
                        .flex()
                        .flex_row()
                        .items_center()
                        .gap_3()
                        .h(px(56.))
                        .px_4()
                        .child(
                            div()
                                .w(px(72.))
                                .h(px(40.))
                                .flex_shrink_0()
                                .rounded(px(6.))
                                .overflow_hidden()
                                .child(picture),
                        )
                        .child(Self::name_and_folder(&row.name, &row.dir, cx))
                        .child(widgets::while_changing(
                            Button::new(("cleanup-silent-one", id as u64))
                                .ghost()
                                .small()
                                .label("Remove sound")
                                .on_click(cx.listener(move |this, _, window, cx| {
                                    let options = PerformOptions {
                                        source: Some(format!("cleanup:silent:{id}").into()),
                                        ..PerformOptions::default()
                                    };
                                    this.state.update(cx, |state, cx| {
                                        state.perform(
                                            PlanRequest::StripAudio { file_ids: vec![id] },
                                            options,
                                            window,
                                            cx,
                                        );
                                    });
                                })),
                            busy,
                        ))
                        .child(
                            div()
                                .w(px(48.))
                                .flex_shrink_0()
                                .text_right()
                                .text_xs()
                                .text_color(muted)
                                .child(format::duration(row.duration_ms)),
                        )
                        .into_any_element()
                })
                .collect();
            let junk_rows: Vec<AnyElement> = self
                .junk
                .data()
                .map(|page| page.rows.clone())
                .unwrap_or_default()
                .iter()
                .map(|row| {
                    div()
                        .flex()
                        .flex_row()
                        .items_center()
                        .gap_3()
                        .h(px(44.))
                        .px_4()
                        .child(Self::name_and_folder(&row.name, &row.dir, cx))
                        .child(widgets::caption(format::bytes(row.size as f64), cx))
                        .into_any_element()
                })
                .collect();
            let folder_rows: Vec<AnyElement> = self
                .folders
                .data()
                .cloned()
                .unwrap_or_default()
                .into_iter()
                .take(ROW_LIMIT as usize)
                .map(|folder| {
                    div()
                        .flex()
                        .flex_row()
                        .items_center()
                        .gap_3()
                        .h(px(44.))
                        .px_4()
                        .child(Icon::new(IconName::Folder).size(px(16.)).text_color(muted))
                        .child(
                            div()
                                .flex_1()
                                .min_w_0()
                                .truncate()
                                .text_size(px(13.))
                                .child(folder),
                        )
                        .into_any_element()
                })
                .collect();
            let warning = cx.theme().warning;
            let extension_rows: Vec<AnyElement> = self
                .extension_rows()
                .into_iter()
                .take(ROW_LIMIT as usize)
                .map(|(row, name)| {
                    div()
                        .flex()
                        .flex_col()
                        .justify_center()
                        .h(px(44.))
                        .px_4()
                        .child(
                            div()
                                .flex()
                                .flex_row()
                                .gap_1()
                                .text_size(px(13.))
                                .child(row.name.clone())
                                .child(div().text_color(muted).child("→"))
                                .child(div().text_color(warning).child(name)),
                        )
                        .when(!row.dir.is_empty(), |this| {
                            this.child(widgets::caption(row.dir.clone(), cx).truncate())
                        })
                        .into_any_element()
                })
                .collect();
            let sections = [
                self.section(
                    "silent",
                    "Silent soundtracks",
                    tidy.silent_tracks.files,
                    "Remove sound",
                    "cleanup:silent",
                    Self::remove_sound,
                    silent_rows,
                    Some(LibraryPreset {
                        kinds: vec![FileKind::Video],
                        audio_states: vec![AudioState::Silent],
                        ..LibraryPreset::default()
                    }),
                    cx,
                ),
                self.section(
                    "junk",
                    "Junk files",
                    tidy.cleanup.junk,
                    "Remove",
                    "cleanup:junk",
                    |this, window, cx| {
                        let Some(root_id) = this.state.read(cx).root_id() else {
                            return;
                        };
                        this.state.update(cx, |state, cx| {
                            state.perform(
                                PlanRequest::CleanJunk { root_id },
                                PerformOptions::from("cleanup:junk"),
                                window,
                                cx,
                            );
                        });
                    },
                    junk_rows,
                    Some(LibraryPreset {
                        flags: vec![FileFlag::Junk],
                        ..LibraryPreset::default()
                    }),
                    cx,
                ),
                self.section(
                    "folders",
                    "Empty folders",
                    tidy.cleanup.empty_folders,
                    "Remove",
                    "cleanup:folders",
                    |this, window, cx| {
                        let Some(root_id) = this.state.read(cx).root_id() else {
                            return;
                        };
                        this.state.update(cx, |state, cx| {
                            state.perform(
                                PlanRequest::RemoveEmptyFolders { root_id },
                                PerformOptions::from("cleanup:folders"),
                                window,
                                cx,
                            );
                        });
                    },
                    folder_rows,
                    None,
                    cx,
                ),
                self.section(
                    "extensions",
                    "Wrong extensions",
                    tidy.cleanup.extensions,
                    "Fix",
                    "cleanup:extensions",
                    Self::fix_extensions,
                    extension_rows,
                    Some(LibraryPreset {
                        flags: vec![FileFlag::ExtensionMismatch],
                        ..LibraryPreset::default()
                    }),
                    cx,
                ),
            ];
            div()
                .id("cleanup-scroll")
                .flex_1()
                .min_h_0()
                .overflow_y_scroll()
                .child(
                    div()
                        .mx_auto()
                        .w_full()
                        .max_w(px(760.))
                        .flex()
                        .flex_col()
                        .gap_4()
                        .px_6()
                        .pt_6()
                        .pb(px(112.))
                        .children(sections.into_iter().flatten()),
                )
                .into_any_element()
        };

        div()
            .id("cleanup")
            .track_focus(&self.focus)
            .key_context("TidyCleanup")
            .on_key_down(cx.listener(Self::on_key_down))
            .flex()
            .flex_col()
            .size_full()
            .min_h_0()
            .child(top_bar)
            .child(body)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fixes_names_as_clean_up_does() {
        assert_eq!(with_extension("cover.jpg", "avif"), "cover.avif");
        assert_eq!(with_extension("README", "txt"), "README.txt");
        assert_eq!(with_extension(".hidden", "png"), ".hidden.png");
    }
}
