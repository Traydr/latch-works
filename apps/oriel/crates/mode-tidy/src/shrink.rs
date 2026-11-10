//! Shrink: videos re-encoded to AV1 in runs, the most bytes saved first.
//! A run can be stopped at any time: finished videos stay done, and the next run starts with what
//! is left. How much a run takes is remembered (`oriel.tidy.shrink.batch`).

use std::collections::HashMap;

use gpui_kit::assets::IconName;
use gpui_kit::component::{ActiveTheme as _, Disableable as _, Icon};
use gpui_kit::{
    AnyElement, App, Context, Entity, FocusHandle, Focusable, FontWeight, InteractiveElement as _,
    IntoElement, ParentElement as _, Render, SharedString, StatefulInteractiveElement as _,
    Styled as _, Subscription, TestSupportExt as _, Window, div, prelude::FluentBuilder as _, px,
};
use oriel_core_domain::format;
use oriel_core_tidy::contract::{ShrinkItem, ShrinkSummary, shrink_batch};
use oriel_ui::JobProgress;
use oriel_ui::TextRole as _;
use oriel_ui::segmented::{Segmented, SegmentedItem};
use oriel_ui::{LocalStorage, TopBar};

use crate::actions::PerformOptions;
use crate::loaded::{Loaded, PageReads, Read};
use crate::pages::TidyPage;
use crate::state::TidyState;
use crate::thumbs::Thumbs;
use crate::widgets;
use oriel_core_tidy::contract::PlanRequest;

/// How many files Shrink re-encodes at a time, as stored.
const SHRINK_BATCH_KEY: &str = "oriel.tidy.shrink.batch";

const SOURCE: &str = "shrink";

/// How much a run takes, by the bytes of its originals; "all" takes every video.
const BATCHES: [(&str, &str, Option<f64>); 3] = [
    ("5", "5 GB", Some(5e9)),
    ("20", "20 GB", Some(20e9)),
    ("all", "All", None),
];

fn left_reasons(summary: &ShrinkSummary) -> Vec<String> {
    summary
        .skipped
        .iter()
        .filter(|entry| entry.files > 0)
        .map(|entry| {
            crate::labels::skip_reason(&entry.reason, entry.files, Some(("video", "videos")))
        })
        .collect()
}

#[derive(Default)]
struct Totals {
    bytes: f64,
    estimated: f64,
    encode_ms: f64,
}

fn totals(items: &[ShrinkItem]) -> Totals {
    items.iter().fold(Totals::default(), |sum, item| Totals {
        bytes: sum.bytes + item.bytes as f64,
        estimated: sum.estimated + item.estimated_bytes as f64,
        encode_ms: sum.encode_ms + item.encode_ms,
    })
}

pub struct ShrinkPage {
    state: Entity<TidyState>,
    thumbs: Entity<Thumbs>,
    focus: FocusHandle,
    summary: Loaded<ShrinkSummary>,
    left_open: bool,
    about_open: bool,
    reads: PageReads,
    _subscriptions: Vec<Subscription>,
}

impl ShrinkPage {
    pub fn new(state: &Entity<TidyState>, thumbs: &Entity<Thumbs>, cx: &mut Context<Self>) -> Self {
        let subscriptions = vec![
            cx.observe(state, |this, _, cx| this.sync(cx)),
            cx.observe(thumbs, |_, _, cx| cx.notify()),
        ];
        Self {
            state: state.clone(),
            thumbs: thumbs.clone(),
            focus: cx.focus_handle(),
            summary: Loaded::default(),
            left_open: false,
            about_open: false,
            reads: PageReads::default(),
            _subscriptions: subscriptions,
        }
    }

    fn sync(&mut self, cx: &mut Context<Self>) {
        cx.notify();
        let Some(Read {
            engine, root_id, ..
        }) = self.reads.due(TidyPage::Shrink, self.state.read(cx))
        else {
            return;
        };
        let summary = engine.ask(move |engine| engine.shrink_summary(root_id), cx);
        self.summary.load(summary, |this| &mut this.summary, cx);
        cx.notify();
    }

    fn batch(cx: &App) -> (&'static str, Option<f64>) {
        let stored = LocalStorage::get(cx, SHRINK_BATCH_KEY).unwrap_or("5");
        BATCHES
            .iter()
            .find(|(value, _, _)| *value == stored)
            .map_or(("5", Some(5e9)), |(value, _, limit)| (*value, *limit))
    }

    pub fn shrink(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let state = self.state.read(cx);
        let Some(root_id) = state.root_id() else {
            return;
        };
        let empty = self
            .summary
            .data()
            .is_none_or(|summary| summary.items.is_empty());
        if empty || state.change_status(SOURCE, cx).is_some() {
            return;
        }
        let (_, limit_bytes) = Self::batch(cx);
        self.state.update(cx, |state, cx| {
            state.perform(
                PlanRequest::ShrinkVideos {
                    root_id,
                    limit_bytes,
                },
                PerformOptions::from(SOURCE),
                window,
                cx,
            );
        });
    }
}

impl Focusable for ShrinkPage {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}

impl Render for ShrinkPage {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let shell = self.state.read(cx).shell().clone();
        let status = self.state.read(cx).change_status(SOURCE, cx);
        let Some(summary) = self.summary.data().cloned() else {
            let body = match self.summary.error().cloned() {
                Some(error) => {
                    let this = cx.entity().downgrade();
                    widgets::error_state(
                        "shrink-error",
                        "Couldn't plan the shrinking",
                        error,
                        move |_, cx| {
                            this.update(cx, |this, cx| {
                                this.reads.forget();
                                this.sync(cx);
                            })
                            .ok();
                        },
                        cx,
                    )
                }
                None => div().flex_1().into_any_element(),
            };
            return div()
                .id("shrink")
                .track_focus(&self.focus)
                .flex()
                .flex_col()
                .size_full()
                .child(TopBar::new(&shell, TidyPage::Shrink.label()))
                .child(body);
        };
        let (choice, limit) = Self::batch(cx);
        let batch = shrink_batch(&summary.items, limit).to_vec();
        let next = totals(&batch);
        // A run going: how far it has got, and the file it is on.
        let run = self
            .state
            .read(cx)
            .change_for(SOURCE)
            .map(|change| change.job.progress(cx));
        let running = self.state.read(cx).running_file(cx);
        let pausing = running.as_ref().filter(|file| file.pausing);
        let paused = run.as_ref().is_some_and(JobProgress::is_paused) && pausing.is_none();
        let in_batch: HashMap<i64, &ShrinkItem> = summary
            .items
            .iter()
            .map(|item| (item.file_id, item))
            .collect();
        let batch_ids: Vec<i64> = batch.iter().map(|item| item.file_id).collect();
        let shown: Vec<_> = summary
            .preview
            .iter()
            .filter(|row| batch_ids.contains(&row.id))
            .collect();
        let repeated = widgets::repeated_names(&shown);
        let tiles: Vec<AnyElement> = shown
            .into_iter()
            .map(|row| {
                let ratio = in_batch
                    .get(&row.id)
                    .filter(|item| item.bytes > 0)
                    .map(|item| item.estimated_bytes as f64 / item.bytes as f64);
                let folder = repeated.contains(&row.name);
                let badge = running
                    .as_ref()
                    .filter(|file| file.rel_path == row.rel_path)
                    .map(|file| widgets::running_badge("Shrinking", file, cx));
                widgets::media_tile(&self.thumbs, row, ratio, folder, badge, cx)
            })
            .collect();
        let more = batch.len() as i64 - tiles.len() as i64;
        let reasons = left_reasons(&summary);
        let left: i64 = summary.skipped.iter().map(|entry| entry.files).sum();
        let theme = cx.theme();
        let muted = theme.muted_foreground;

        // The control says what it sets: how much one run takes on.
        let batches = (!summary.items.is_empty()).then(|| {
            let segmented = Segmented::new("shrink-batch", "How much each run takes").items(
                BATCHES.map(|(value, label, _)| {
                    SegmentedItem::new(SharedString::from(format!("shrink-batch-{value}")), label)
                        .selected(value == choice)
                        .on_click(move |_, window, cx| {
                            LocalStorage::set(cx, SHRINK_BATCH_KEY, value);
                            window.refresh();
                        })
                }),
            );
            div()
                .flex()
                .flex_row()
                .items_center()
                .gap_2()
                .child(widgets::caption("Each run", cx))
                .child(segmented)
        });
        // With nothing left to shrink there is no command to offer, only a run still finishing.
        let action = (!batch.is_empty() || status.is_some()).then(|| {
            widgets::while_changing(
                widgets::primary_action(
                    "shrink-run",
                    format!("Shrink {}", format::count(batch.len() as i64)),
                    widgets::MAIN_ACTION_KEYS,
                )
                .disabled(batch.is_empty())
                .on_click(cx.listener(|this, _, window, cx| this.shrink(window, cx))),
                status,
            )
            .into_any_element()
        });
        let top_bar = TopBar::new(&shell, TidyPage::Shrink.label())
            .when_some(batches, |bar, batches| bar.trailing(batches))
            .when_some(action, |bar, action| bar.trailing(action));

        let next_card =
            if summary.items.is_empty() {
                widgets::empty_state(
                    "shrink-empty",
                    Some(IconName::Shrink),
                    "Nothing left to shrink",
                    Some(if reasons.is_empty() {
                        "Videos that can shrink show up here.".into_any_element()
                    } else {
                        reasons.join(" · ").into_any_element()
                    }),
                    Vec::new(),
                    cx,
                )
                .into_any_element()
            } else {
                widgets::card(cx)
                .id("shrink-next")
                .test_support()
                .aria_label(SharedString::from(format!(
                    "{} → about {}",
                    format::bytes(next.bytes),
                    format::bytes(next.estimated)
                )))
                .mb_5()
                .p_5()
                .child(
                    div()
                        .text_caption()
                        .font_weight(FontWeight::MEDIUM)
                        .text_color(muted)
                        .child(match &run {
                            Some(_) if paused => "This run",
                            Some(_) if pausing.is_some() => "Pausing",
                            Some(_) => "Running now",
                            None if choice == "all" => "Every video",
                            None => "Next run",
                        }),
                )
                .child(
                    div()
                        .id("shrink-headline")
                        .test_support()
                        .mt_1()
                        .text_size(px(32.))
                        .font_weight(FontWeight::SEMIBOLD)
                        .child(match &run {
                            Some(_) if pausing.is_some() => format!(
                                "Pausing after {}",
                                pausing.map_or("", |file| file.name.as_str())
                            ),
                            Some(run) if paused && run.total() > 0 => format!(
                                "Paused, {} of {} done",
                                format::count(run.done() as i64),
                                format::count(run.total() as i64)
                            ),
                            Some(run) if run.total() > 0 => format!(
                                "Shrinking {}, {} done",
                                format::plural(run.total() as i64, "video"),
                                format::count(run.done() as i64)
                            ),
                            Some(_) => "Starting to shrink".to_owned(),
                            None => format!(
                                "{} → about {}",
                                format::bytes(next.bytes),
                                format::bytes(next.estimated)
                            ),
                        }),
                )
                .when_some(run.as_ref().map(|_| running.as_ref()), |this, file| {
                    this.child(
                        widgets::caption(
                            match (file, paused) {
                                (Some(file), true) => format!(
                                    "Paused on {} · resume or stop it from the activity panel",
                                    widgets::file_and_share(file)
                                ),
                                (None, true) => {
                                    "Waiting · resume or stop it from the activity panel".to_owned()
                                }
                                (Some(file), false) => widgets::file_and_share(file),
                                (None, false) => "Getting the next video ready".to_owned(),
                            },
                            cx,
                        )
                        .mt(px(6.)),
                    )
                })
                .when(run.is_none(), |this| this.child(widgets::caption(
                    format!(
                        "{}{}, the most space saved first · roughly {}{}",
                        format::plural(batch.len() as i64, "video"),
                        match batch.iter().filter(|item| item.copy_of.is_some()).count() as i64 {
                            0 => String::new(),
                            1 => " (1 an identical copy, encoded once)".to_owned(),
                            copies => format!(
                                " ({} identical copies, encoded once)",
                                format::count(copies)
                            ),
                        },
                        format::span(next.encode_ms),
                        if summary.speed_measured {
                            ""
                        } else {
                            ", a first guess"
                        }
                    ),
                    cx,
                ).mt(px(6.))))
                .child(widgets::caption(
                    "Stop whenever you like: finished videos stay done, and originals wait in \
                     holding for Undo.",
                    cx,
                ).mt_1())
                .child(
                    div()
                        .id("shrink-about-av1")
                        .test_support()
                        .mt_2()
                        .h_8()
                        .flex()
                        .flex_row()
                        .items_center()
                        .gap_1()
                        .cursor_pointer()
                        .text_sm()
                        .text_color(muted)
                        .on_click(cx.listener(|this, _, _, cx| {
                            this.about_open = !this.about_open;
                            cx.notify();
                        }))
                        .child(
                            Icon::new(if self.about_open {
                                IconName::ChevronDown
                            } else {
                                IconName::ChevronRight
                            })
                            .size_4(),
                        )
                        .child("About AV1"),
                )
                .when(self.about_open, |this| {
                    this.child(widgets::caption(
                        "AV1 with SVT-AV1; Video quality in Settings sets how hard it squeezes. \
                         Safari, and every browser on iPhone and iPad, plays AV1 only on A17 Pro, \
                         M3 and later chips.",
                        cx,
                    ))
                })
                .into_any_element()
            };
        // One reason says it all on one line; several open from a count.
        let left_section =
            (left > 0 && !summary.items.is_empty()).then(|| match reasons.as_slice() {
                [reason] => div()
                    .id("shrink-left")
                    .test_support()
                    .h(px(44.))
                    .flex()
                    .items_center()
                    .text_body()
                    .text_color(muted)
                    .child(reason.clone()),
                _ => div()
                    .id("shrink-left")
                    .test_support()
                    .flex()
                    .flex_col()
                    .child(
                        div()
                            .id("shrink-left-toggle")
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
                                .text_color(muted),
                            )
                            .child(format!("{} not shrunk", format::plural(left, "video"))),
                    )
                    .when(self.left_open, |this| {
                        this.child(widgets::left_list(&reasons, cx))
                    }),
            });

        div()
            .id("shrink")
            .track_focus(&self.focus)
            .key_context("TidyShrink")
            .flex()
            .flex_col()
            .size_full()
            .min_h_0()
            .child(top_bar)
            .child(
                div()
                    .id("shrink-scroll")
                    .flex()
                    .flex_col()
                    .flex_1()
                    .min_h_0()
                    .overflow_y_scroll()
                    .px_5()
                    .pt_4()
                    .pb(px(112.))
                    .child(next_card)
                    .when(!tiles.is_empty(), |this| {
                        this.child(widgets::tile_grid(tiles))
                    })
                    .when(more > 0, |this| {
                        this.child(widgets::caption(
                            format!("and {} more in this run", format::count(more)),
                            cx,
                        ))
                    })
                    .children(left_section),
            )
    }
}
