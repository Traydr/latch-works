//! The Library as a grid (`components/library/FileGrid.tsx`): Frame View's tiles, square pictures
//! about 180 px wide with the name and size under each, paged in as the grid scrolls. Only the
//! lines in view are drawn, so a large archive scrolls as fast as a small one.

use std::ops::Range;

use gpui_kit::component::checkbox::Checkbox;
use gpui_kit::component::input::Input;
use gpui_kit::component::{ActiveTheme as _, Sizable as _};
use gpui_kit::{
    AnyElement, ClickEvent, Context, FontWeight, InteractiveElement as _, IntoElement as _,
    MouseButton, MouseDownEvent, ObjectFit, ParentElement as _, SharedString,
    StatefulInteractiveElement as _, Styled as _, TestSupportExt as _, canvas, div,
    prelude::FluentBuilder as _, px, uniform_list,
};
use oriel_ui::checkbox_target;

use super::{LibraryPage, PAGE};
use crate::format;
use crate::thumbs;

/// The narrowest a tile gets before the grid drops a column.
const MIN_TILE: f32 = 180.;
const GAP: f32 = 12.;
const PAD_X: f32 = 20.;
const PAD_TOP: f32 = 16.;
/// The tile's padding (4 px each side) and the two 16 px lines under the picture.
const TILE_CHROME: f32 = 8. + 44.;

/// How the grid lays out at a width: its columns, a tile's width and its height.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct GridLayout {
    pub columns: usize,
    pub tile: f32,
    pub tile_height: f32,
}

impl GridLayout {
    pub fn at(width: f32) -> Self {
        let inner = (width - PAD_X * 2.).max(MIN_TILE);
        let columns = ((inner + GAP) / (MIN_TILE + GAP)).floor().max(1.) as usize;
        let tile = (inner - GAP * (columns - 1) as f32) / columns as f32;
        Self {
            columns,
            tile,
            tile_height: tile - 8. + TILE_CHROME,
        }
    }
}

impl LibraryPage {
    /// The grid, measured from its own bounds; the selection bar's room under the last line.
    pub(super) fn render_grid(&mut self, bottom_inset: f32, cx: &mut Context<Self>) -> AnyElement {
        let layout = GridLayout::at(self.grid_width);
        self.grid_columns = layout.columns;
        let total = self.table.read(cx).delegate().total().unwrap_or(0);
        let lines = total.div_ceil(layout.columns);
        let page = cx.entity().downgrade();
        div()
            .id("file-grid")
            .relative()
            .flex()
            .flex_col()
            .flex_1()
            .min_h_0()
            .size_full()
            .child(
                canvas(
                    move |bounds, _, cx| {
                        let width = f32::from(bounds.size.width);
                        page.update(cx, |page, cx| {
                            if (page.grid_width - width).abs() >= 0.5 {
                                page.grid_width = width;
                                cx.notify();
                            }
                        })
                        .ok();
                    },
                    |_, _, _, _| {},
                )
                .absolute()
                .size_full(),
            )
            .child(
                uniform_list(
                    "library-grid-lines",
                    lines,
                    cx.processor(move |this, lines: Range<usize>, _, cx| {
                        this.render_grid_lines(lines, layout, cx)
                    }),
                )
                .track_scroll(&self.grid_scroll)
                .size_full()
                .pt(px(PAD_TOP))
                .pb(px(bottom_inset)),
            )
            .into_any_element()
    }

    /// Scrolls the grid so the file at `index` shows.
    pub(super) fn reveal_in_grid(&self, index: usize) {
        self.grid_scroll.scroll_to_item(
            index / self.grid_columns.max(1),
            gpui_kit::ScrollStrategy::Nearest,
        );
    }

    fn render_grid_lines(
        &mut self,
        lines: Range<usize>,
        layout: GridLayout,
        cx: &mut Context<Self>,
    ) -> Vec<AnyElement> {
        let total = self.table.read(cx).delegate().total().unwrap_or(0);
        let columns = layout.columns;
        let first = lines.start * columns;
        let last = (lines.end * columns).min(total);
        if first < last {
            self.table.update(cx, |table, cx| {
                for page in first / PAGE..=(last - 1) / PAGE {
                    table.delegate_mut().request(page, cx);
                }
            });
        }
        lines
            .map(|line| {
                let tiles: Vec<AnyElement> = (line * columns..((line + 1) * columns).min(total))
                    .map(|index| self.render_tile(index, layout, cx))
                    .collect();
                div()
                    .flex()
                    .flex_row()
                    .gap(px(GAP))
                    .px(px(PAD_X))
                    .pb(px(GAP))
                    .children(tiles)
                    .into_any_element()
            })
            .collect()
    }

    fn render_tile(
        &mut self,
        index: usize,
        layout: GridLayout,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let theme = cx.theme().clone();
        let (row, selected, choosing, renaming) = {
            let rows = self.table.read(cx).delegate();
            let row = rows.row(index).cloned();
            let selected = row
                .as_ref()
                .is_some_and(|row| rows.selected().contains(&row.id));
            let renaming = row.as_ref().and_then(|row| {
                rows.renaming
                    .as_ref()
                    .filter(|(id, _)| *id == row.id)
                    .map(|(_, input)| input.clone())
            });
            (row, selected, !rows.selected().is_empty(), renaming)
        };
        let size = (px(layout.tile), px(layout.tile_height));
        let Some(row) = row else {
            // Not read yet: a quiet tile in its place.
            return div()
                .w(size.0)
                .h(size.1)
                .flex_shrink_0()
                .rounded(theme.radius_lg)
                .bg(theme.muted)
                .into_any_element();
        };
        let cursor = self.cursor(cx) == Some(index);
        let picture = thumbs::picture(&self.thumbs, &row, 384, ObjectFit::Cover, cx);
        let id = row.id;
        let name: SharedString = row.name.clone().into();
        div()
            .id(("library-tile", id as u64))
            .test_support()
            .aria_label(name.clone())
            .aria_selected(selected)
            .group("library-tile")
            .w(size.0)
            .h(size.1)
            .flex_shrink_0()
            .flex()
            .flex_col()
            .p_1()
            .rounded(theme.radius_lg)
            .bg(if selected {
                theme.list_active
            } else {
                theme.group_box
            })
            .border_2()
            .border_color(if cursor {
                theme.primary
            } else if selected {
                theme.muted_foreground.opacity(0.4)
            } else {
                theme.transparent
            })
            .on_click(cx.listener(move |this, event: &ClickEvent, window, cx| {
                if event.click_count() >= 2 {
                    this.open_file(index, cx);
                } else {
                    this.click_file(index, event.modifiers(), window, cx);
                }
            }))
            .on_mouse_down(
                MouseButton::Right,
                cx.listener(move |this, _: &MouseDownEvent, window, cx| {
                    this.context_menu(index, window, cx);
                    cx.stop_propagation();
                }),
            )
            .child(
                div()
                    .relative()
                    .w_full()
                    .h(px(layout.tile - 8.))
                    .rounded(theme.radius)
                    .overflow_hidden()
                    .child(picture)
                    .child(
                        div()
                            .absolute()
                            .top_2()
                            .left_2()
                            .when(!choosing && !selected, |this| {
                                this.opacity(0.)
                                    .group_hover("library-tile", |style| style.opacity(1.))
                            })
                            // A 28 px target on a backdrop, so the box reads over any picture.
                            .child(
                                checkbox_target(Checkbox::new(("library-tile-select", id as u64)))
                                    .rounded(theme.radius)
                                    .bg(theme.popover.opacity(0.8))
                                    .checked(selected)
                                    .accessibility_label(SharedString::from(format!(
                                        "Select {name}"
                                    )))
                                    .on_click(cx.listener(move |this, checked: &bool, _, cx| {
                                        this.toggle_file(index, *checked, cx);
                                    })),
                            ),
                    ),
            )
            .child(
                div()
                    .px(px(6.))
                    .py(px(6.))
                    .text_xs()
                    .child(match renaming {
                        Some(input) => Input::new(&input)
                            .small()
                            .aria_label(format!("New name for {name}"))
                            .into_any_element(),
                        None => div()
                            .truncate()
                            .font_weight(FontWeight::MEDIUM)
                            .child(name)
                            .into_any_element(),
                    })
                    .child(
                        div()
                            .truncate()
                            .text_color(theme.muted_foreground)
                            .child(format::bytes(row.size as f64)),
                    ),
            )
            .into_any_element()
    }
}
