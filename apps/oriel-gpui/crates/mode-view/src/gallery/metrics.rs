//! The gallery grid's geometry, as Electron Oriel's `useVirtualGridMetrics.ts` computes it, so
//! both apps put the same number of tiles of the same size in a row for the same width.
//!
//! These are measured pixels, not the rem scale: the grid is derived from the viewport width
//! and the thumbnail size setting, exactly as the TypeScript does.

use std::ops::Range;

/// The gap between tiles, across and down.
pub const GRID_GAP: f32 = 10.;
/// Rows drawn and thumbnailed beyond the viewport, above and below.
pub const OVERSCAN_ROWS: usize = 4;
/// The gallery's horizontal inset on each side (`px-3`), included in the width it measures.
pub const HORIZONTAL_INSET: f32 = 12.;
/// The gallery's top inset (`pt-4`).
pub const TOP_INSET: f32 = 16.;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TileAspect {
    /// 16:9, for media.
    Wide,
    /// 9:16, for comic covers.
    Tall,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct GridMetrics {
    columns: usize,
    grid_width: f32,
    card_width: f32,
    card_height: f32,
}

impl GridMetrics {
    /// The grid for a gallery `viewport_width` wide, with tiles of about `thumbnail_size`.
    pub fn new(viewport_width: f32, thumbnail_size: f32, aspect: TileAspect) -> Self {
        let column_width = thumbnail_size + 20.;
        let columns = ((viewport_width - 40.) / column_width)
            .floor()
            .clamp(2., 6.) as usize;
        let grid_width = (viewport_width - 2. * HORIZONTAL_INSET).max(240.);
        let gaps = GRID_GAP * (columns - 1) as f32;
        let card_width = ((grid_width - gaps) / columns as f32).floor().max(120.);
        let card_height = match aspect {
            TileAspect::Wide => (card_width * 9. / 16.).floor().max(110.),
            TileAspect::Tall => (card_width * 16. / 9.).floor().max(180.),
        };
        Self {
            columns,
            grid_width,
            card_width,
            card_height,
        }
    }

    pub fn columns(&self) -> usize {
        self.columns
    }

    /// The width the tiles and their gaps are centred in.
    pub fn grid_width(&self) -> f32 {
        self.grid_width
    }

    pub fn card_width(&self) -> f32 {
        self.card_width
    }

    pub fn card_height(&self) -> f32 {
        self.card_height
    }

    /// A row's height with the gap below it: one row of the virtual list.
    pub fn row_stride(&self) -> f32 {
        self.card_height + GRID_GAP
    }

    pub fn row_count(&self, items: usize) -> usize {
        items.div_ceil(self.columns)
    }

    /// The items in `rows`.
    pub fn items_in(&self, rows: Range<usize>, items: usize) -> Range<usize> {
        (rows.start * self.columns).min(items)..(rows.end * self.columns).min(items)
    }

    /// The rows a viewport `height` tall shows with its top `scroll_top` into the grid, widened
    /// by `overscan` rows each way: `getVisibleRowWindow`, as a half-open range.
    pub fn rows_in_view(
        &self,
        scroll_top: f32,
        height: f32,
        row_count: usize,
        overscan: usize,
    ) -> Range<usize> {
        if row_count == 0 {
            return 0..0;
        }
        let stride = self.row_stride();
        let first = (scroll_top / stride).floor().max(0.) as usize;
        let last = ((scroll_top + height) / stride).ceil().max(0.) as usize;
        first.saturating_sub(overscan)..(last + overscan + 1).min(row_count)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The values `useVirtualGridMetrics` gives for the same inputs, worked from its formulas.
    #[test]
    fn matches_the_electron_grid() {
        // Electron Oriel's first window, 1320 wide, less the 240 px sidebar.
        let grid = GridMetrics::new(1080., 220., TileAspect::Wide);
        assert_eq!(grid.columns(), 4);
        assert_eq!(grid.grid_width(), 1056.);
        assert_eq!(grid.card_width(), 256.);
        assert_eq!(grid.card_height(), 144.);
        assert_eq!(grid.row_stride(), 154.);

        // The frame-performance harness's 1280 px window.
        let grid = GridMetrics::new(1040., 220., TileAspect::Wide);
        assert_eq!(
            (grid.columns(), grid.card_width(), grid.card_height()),
            (4, 246., 138.)
        );

        // Narrow and very wide windows clamp to two and six columns, and tiles to their minimum.
        let narrow = GridMetrics::new(300., 220., TileAspect::Wide);
        assert_eq!(
            (narrow.columns(), narrow.card_width(), narrow.card_height()),
            (2, 133., 110.)
        );
        assert_eq!(GridMetrics::new(4000., 220., TileAspect::Wide).columns(), 6);

        let tall = GridMetrics::new(1080., 220., TileAspect::Tall);
        assert_eq!(tall.card_height(), 455.);
    }

    #[test]
    fn rows_in_view_overscan_and_clamp() {
        let grid = GridMetrics::new(1080., 220., TileAspect::Wide);
        assert_eq!(grid.row_count(10), 3);
        assert_eq!(grid.items_in(1..3, 10), 4..10);
        // 154 px rows, a 600 px viewport scrolled 1000 px: rows 6 to 10 show, and Electron's
        // window counts row 11 too, since its end is the ceiling.
        assert_eq!(grid.rows_in_view(1000., 600., 100, 0), 6..12);
        assert_eq!(grid.rows_in_view(1000., 600., 100, 4), 2..16);
        assert_eq!(grid.rows_in_view(0., 600., 3, 4), 0..3);
        assert_eq!(grid.rows_in_view(0., 600., 0, 4), 0..0);
    }
}
