//! Shrink (`views/ShrinkView.tsx`): videos re-encoded to AV1 in runs, the most bytes saved first.
//! A run can be stopped at any time: finished videos stay done, and the next run starts with what
//! is left. How much a run takes is remembered (`oriel.tidy.shrink.batch`).

use std::collections::HashMap;

use gpui_kit::assets::IconName;
use gpui_kit::component::{ActiveTheme as _, Disableable as _, Icon};
use gpui_kit::{
    AnyElement, App, Context, Entity, FocusHandle, Focusable, FontWeight, InteractiveElement as _,
    IntoElement, KeyDownEvent, ParentElement as _, Render, SharedString,
    StatefulInteractiveElement as _, Styled as _, Subscription, TestSupportExt as _, Window, div,
    prelude::FluentBuilder as _, px,
};
use oriel_core_tidy::contract::{RootId, ShrinkItem, ShrinkSummary, shrink_batch};
use oriel_ui::segmented::{Segmented, SegmentedItem};
use oriel_ui::{LocalStorage, TopBar};

use crate::actions::PerformOptions;
use crate::changes::PlanRequest;
use crate::format;
use crate::loaded::Loaded;
use crate::pages::TidyPage;
use crate::state::TidyState;
use crate::thumbs::Thumbs;
use crate::widgets;

const SOURCE: &str = "shrink";
const BATCH_KEY: &str = "oriel.tidy.shrink.batch";

/// How much a run takes, by the bytes of its originals; "all" takes every video.
const BATCHES: [(&str, &str, Option<f64>); 3] = [
    ("5", "5 GB", Some(5e9)),
    ("20", "20 GB", Some(20e9)),
    ("all", "All", None),
];

fn skip_words(reason: &str) -> Option<(&'static str, &'static str)> {
    Some(match reason {
        "Already AV1" => ("is already AV1", "are already AV1"),
        "Already compact" => (
            "is already compact, so AV1 would save little",
            "are already compact, so AV1 would save little",
        ),
        "Came out no smaller as AV1" => {
            ("came out no smaller as AV1", "came out no smaller as AV1")
        }
        "Identical copies (resolve duplicates first)" => (
            "is an identical copy and waits for duplicate review",
            "are identical copies and wait for duplicate review",
        ),
        "Similar versions (review them first)" => (
            "is in a similar set and waits for review",
            "are in similar sets and wait for review",
        ),
        "Not checked for similar versions yet" => (
            "is still being checked for similar versions",
            "are still being checked for similar versions",
        ),
        "Won't decode" => ("won't open", "won't open"),
        "A file with the target name already exists" => (
            "would take a name already in use",
            "would take a name already in use",
        ),
        _ => return None,
    })
}

fn left_reasons(summary: &ShrinkSummary) -> Vec<String> {
    summary
        .skipped
        .iter()
        .filter(|entry| entry.files > 0)
        .map(|entry| match skip_words(&entry.reason) {
            Some((one, many)) => format!(
                "{} {}",
                format::plural(entry.files, "video"),
                if entry.files == 1 { one } else { many }
            ),
            None => format!("{}: {}", format::plural(entry.files, "video"), entry.reason),
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
    seen: (Option<RootId>, u64),
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
            seen: (None, 0),
            _subscriptions: subscriptions,
        }
    }

    fn sync(&mut self, cx: &mut Context<Self>) {
        let state = self.state.read(cx);
        let key = (state.root_id(), state.catalog_version());
        if state.page() != TidyPage::Shrink || key == self.seen {
            cx.notify();
            return;
        }
        self.seen = key;
        let (Some(engine), Some(root_id)) = (state.engine().cloned(), state.root_id()) else {
            return;
        };
        self.summary
            .load(engine.shrink_summary(root_id), |this| &mut this.summary, cx);
        cx.notify();
    }

    fn batch(cx: &App) -> (&'static str, Option<f64>) {
        let stored = LocalStorage::get(cx, BATCH_KEY).unwrap_or("5");
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
        if empty || state.is_changing() {
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

    fn on_key_down(&mut self, event: &KeyDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        if event.keystroke.modifiers.platform && event.keystroke.key == "enter" {
            self.shrink(window, cx);
            cx.stop_propagation();
        }
    }
}

impl Focusable for ShrinkPage {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}

impl Render for ShrinkPage {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let shell = self.state.read(cx).shell.clone();
        let changing = self.state.read(cx).is_changing();
        let running = widgets::change_progress(&self.state, SOURCE, "shrink-run", cx);
        let Some(summary) = self.summary.data().cloned() else {
            let body = match self.summary.error().cloned() {
                Some(error) => {
                    widgets::empty_state("shrink-error", None, error, None, Vec::new(), cx)
                        .into_any_element()
                }
                None => div().flex_1().into_any_element(),
            };
            return div()
                .id("shrink")
                .track_focus(&self.focus)
                .flex()
                .flex_col()
                .size_full()
                .child(TopBar::new(&shell, "Shrink"))
                .child(body);
        };
        let (choice, limit) = Self::batch(cx);
        let batch = shrink_batch(&summary.items, limit).to_vec();
        let next = totals(&batch);
        let all = totals(&summary.items);
        let in_batch: HashMap<i64, &ShrinkItem> = summary
            .items
            .iter()
            .map(|item| (item.file_id, item))
            .collect();
        let batch_ids: Vec<i64> = batch.iter().map(|item| item.file_id).collect();
        let tiles: Vec<AnyElement> = summary
            .preview
            .iter()
            .filter(|row| batch_ids.contains(&row.id))
            .map(|row| {
                let ratio = in_batch
                    .get(&row.id)
                    .filter(|item| item.bytes > 0)
                    .map(|item| item.estimated_bytes as f64 / item.bytes as f64);
                widgets::media_tile(&self.thumbs, row, ratio, cx)
            })
            .collect();
        let more = batch.len() as i64 - tiles.len() as i64;
        let reasons = left_reasons(&summary);
        let left: i64 = summary.skipped.iter().map(|entry| entry.files).sum();
        let theme = cx.theme();
        let muted = theme.muted_foreground;

        let meta = (!summary.items.is_empty()).then(|| {
            format!(
                "{} · {} → about {}",
                format::plural(summary.items.len() as i64, "video"),
                format::bytes(all.bytes),
                format::bytes(all.estimated)
            )
        });
        let batches = (!summary.items.is_empty()).then(|| {
            Segmented::new("shrink-batch", "How much each run takes").items(BATCHES.map(
                |(value, label, _)| {
                    SegmentedItem::new(SharedString::from(format!("shrink-batch-{value}")), label)
                        .selected(value == choice)
                        .on_click(move |_, window, cx| {
                            LocalStorage::set(cx, BATCH_KEY, value);
                            window.refresh();
                        })
                },
            ))
        });
        let action: AnyElement = match running {
            Some(running) => running,
            None => widgets::primary_action(
                "shrink-run",
                format!("Shrink {}", format::count(batch.len() as i64)),
                "⌘↩",
            )
            .disabled(batch.is_empty() || changing)
            .on_click(cx.listener(|this, _, window, cx| this.shrink(window, cx)))
            .into_any_element(),
        };
        let top_bar = TopBar::new(&shell, "Shrink")
            .when_some(meta, |bar, meta| bar.trailing(widgets::caption(meta, cx)))
            .when_some(batches, |bar, batches| bar.trailing(batches))
            .trailing(action);

        let next_card = if summary.items.is_empty() {
            widgets::empty_state(
                "shrink-empty",
                Some(IconName::Shrink),
                "Nothing left to shrink",
                None,
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
                        .text_xs()
                        .font_weight(FontWeight::MEDIUM)
                        .text_color(muted)
                        .child(if choice == "all" { "Every video" } else { "Next run" }),
                )
                .child(
                    div()
                        .mt_1()
                        .text_size(px(24.))
                        .font_weight(FontWeight::SEMIBOLD)
                        .child(format!(
                            "{} → about {}",
                            format::bytes(next.bytes),
                            format::bytes(next.estimated)
                        )),
                )
                .child(widgets::caption(
                    format!(
                        "{}, the most space saved first · roughly {} of encoding{}. Stop \
                         whenever you like: finished videos stay done, and the next run starts \
                         with what is left.",
                        format::plural(batch.len() as i64, "video"),
                        format::span(next.encode_ms),
                        if summary.speed_measured {
                            " at this computer's speed"
                        } else {
                            ", a first guess until this computer has shrunk a few videos"
                        }
                    ),
                    cx,
                ).mt(px(6.)))
                .child(widgets::caption(
                    "AV1 with SVT-AV1; Video quality in Settings sets how hard it squeezes (High \
                     is CRF 35). Originals wait in holding, and Undo puts them back. Safari, and \
                     every browser on iPhone and iPad, plays AV1 only on A17 Pro, M3 and later \
                     chips.",
                    cx,
                ).mt_3())
                .into_any_element()
        };
        let left_section = (left > 0).then(|| {
            div()
                .flex()
                .flex_col()
                .child(
                    div()
                        .id("shrink-left-toggle")
                        .flex()
                        .flex_row()
                        .items_center()
                        .gap(px(6.))
                        .h(px(36.))
                        .cursor_pointer()
                        .text_size(px(13.))
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
                            .size(px(14.))
                            .text_color(muted),
                        )
                        .child(format!("{} left as they are", format::count(left))),
                )
                .when(self.left_open, |this| {
                    this.child(widgets::left_list(&reasons, cx))
                })
        });

        div()
            .id("shrink")
            .track_focus(&self.focus)
            .key_context("TidyShrink")
            .on_key_down(cx.listener(Self::on_key_down))
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
