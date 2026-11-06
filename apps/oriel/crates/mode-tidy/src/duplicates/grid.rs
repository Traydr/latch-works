//! How a set's versions fill the stage: how many across, and how tall a line. The owner must see
//! at a glance that more versions exist, and a tall portrait must be shown whole, so this is
//! worked out from the pictures' shape and the stage's size rather than from the count.
//!
//! As many as fit stay on the stage whole, while their pictures stay big enough to judge. Past
//! that the lines scroll, with their pictures as large as they can be, and the line below always
//! shows at least [`GridInput::peek`] on the stage, so a tall picture never hides that there is
//! more.

/// What a plan is worked out from, in pixels.
#[derive(Clone, Copy, Debug)]
pub struct GridInput {
    /// The stage's width and height, inside its padding.
    pub width: f32,
    pub height: f32,
    /// The space between tiles and between lines.
    pub gap: f32,
    pub count: usize,
    /// The pictures' width over their height.
    pub aspect: f32,
    /// What a tile takes around its picture: below it, and across it.
    pub facts: f32,
    pub inset: f32,
    /// The narrowest a tile may be.
    pub least_tile: f32,
    /// The shortest a picture's place may be.
    pub least_picture: f32,
    /// A picture's longer side must be at least this for its version to be judged at a glance.
    pub good_side: f32,
    /// How much of the next line always shows when the lines scroll.
    pub peek: f32,
}

/// How a set's versions are laid out.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct GridPlan {
    pub columns: usize,
    /// The height of a line of tiles.
    pub line: f32,
    /// Whether the lines scroll, with the next one showing below the stage's edge.
    pub scrolls: bool,
}

impl GridPlan {
    pub fn lines(&self, count: usize) -> usize {
        count.div_ceil(self.columns.max(1))
    }

    /// How far down the first line's top `line` lies, with `gap` between lines.
    pub fn top_of(&self, line: usize, gap: f32) -> f32 {
        line as f32 * (self.line + gap)
    }
}

/// What's in view at a scroll position: the lines from `first` before `end` show whole.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct InView {
    pub first: usize,
    pub end: usize,
}

/// The lines that show whole with the content `top` px scrolled up and `height` px of stage.
/// A line just peeking below the edge is not one of them: it is what "more below" counts.
pub fn in_view(plan: &GridPlan, lines: usize, top: f32, height: f32, gap: f32) -> InView {
    let pitch = plan.line + gap;
    // Half a pixel of slack, so rounding never counts a line as cut off.
    let first = (((top - 0.5) / pitch).ceil().max(0.) as usize).min(lines);
    let bottom = top + height + 0.5;
    let end = (((bottom + gap) / pitch).floor().max(0.) as usize).min(lines);
    InView {
        first,
        end: end.max(first),
    }
}

/// The picture's size when fitted in `place_w` × `place_h`.
pub fn fitted(place_w: f32, place_h: f32, aspect: f32) -> (f32, f32) {
    if place_w / place_h > aspect {
        (place_h * aspect, place_h)
    } else {
        (place_w, place_w / aspect)
    }
}

impl GridInput {
    fn tile_width(&self, columns: usize) -> f32 {
        (self.width - (columns - 1) as f32 * self.gap) / columns as f32
    }

    /// The most tiles across a stage this wide holds, and never more than there are versions.
    fn most_columns(&self) -> usize {
        let across = ((self.width + self.gap) / (self.least_tile + self.gap)).floor() as usize;
        across.clamp(1, self.count.max(1))
    }

    /// Every line on the stage at once, at `columns`: the tile line and the picture's fitted
    /// size, or nothing when the picture's place is too short.
    fn whole(&self, columns: usize) -> Option<(f32, (f32, f32))> {
        let lines = self.count.div_ceil(columns);
        let line = (self.height - (lines - 1) as f32 * self.gap) / lines as f32;
        let place = line - self.facts;
        (place >= self.least_picture).then(|| {
            let picture = fitted(self.tile_width(columns) - self.inset, place, self.aspect);
            (self.facts + picture.1, picture)
        })
    }

    /// The lines scrolling at `columns`: the picture as large as its width and the stage allow,
    /// with the next line kept in sight. `None` when the stage cannot hold a line and a peek.
    fn scrolling(&self, columns: usize) -> Option<(f32, (f32, f32))> {
        let width = self.tile_width(columns) - self.inset;
        let wanted = self.facts + width / self.aspect;
        let tallest = self.height - self.peek - self.gap;
        let mut line = wanted.min(tallest);
        // Whole lines that fit, and what the stage shows of the next: too little and each whole
        // line gives up enough to show the peek.
        let pitch = line + self.gap;
        let whole = (self.height / pitch).floor().max(1.);
        let left = self.height - whole * pitch;
        if left < self.peek {
            line -= (self.peek - left) / whole;
        }
        let place = line - self.facts;
        (place >= self.least_picture).then(|| (line, fitted(width, place, self.aspect)))
    }

    /// The plan for these versions on this stage.
    pub fn plan(&self) -> GridPlan {
        let most = self.most_columns();
        let area = |picture: (f32, f32)| picture.0 * picture.1;
        // Every version on the stage, at the size that makes them largest; of equal sizes, the
        // fewest across, so the lines stay even.
        let mut best: Option<(usize, f32, (f32, f32))> = None;
        for columns in 1..=most {
            if let Some((line, picture)) = self.whole(columns)
                && best.is_none_or(|(_, _, shown)| area(picture) > area(shown) + 1.)
            {
                best = Some((columns, line, picture));
            }
        }
        if let Some((columns, line, picture)) = best
            && picture.0.max(picture.1) >= self.good_side
        {
            return GridPlan {
                columns,
                line,
                scrolls: false,
            };
        }
        // Too many to judge at once: the lines scroll, as many across as still leave each picture
        // big enough to judge.
        let mut largest: Option<(GridPlan, (f32, f32))> = None;
        for columns in (1..=most).rev() {
            let Some((line, picture)) = self.scrolling(columns) else {
                continue;
            };
            let plan = GridPlan {
                columns,
                line,
                scrolls: true,
            };
            if picture.0.max(picture.1) >= self.good_side {
                return plan;
            }
            if largest.is_none_or(|(_, shown)| area(picture) > area(shown) + 1.) {
                largest = Some((plan, picture));
            }
        }
        // A stage too small for that: whichever shows the pictures larger, and the whole set on
        // the stage if that costs little.
        match (best, largest) {
            (Some((columns, line, whole)), Some((_, scrolling)))
                if area(whole) >= area(scrolling) * 0.8 =>
            {
                GridPlan {
                    columns,
                    line,
                    scrolls: false,
                }
            }
            (_, Some((plan, _))) => plan,
            (Some((columns, line, _)), None) => GridPlan {
                columns,
                line,
                scrolls: false,
            },
            (None, None) => GridPlan {
                columns: 1,
                line: self.facts + self.least_picture,
                scrolls: true,
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stage(width: f32, height: f32, count: usize, aspect: f32) -> GridInput {
        GridInput {
            width,
            height,
            gap: 16.,
            count,
            aspect,
            facts: 160.,
            inset: 12.,
            least_tile: 176.,
            least_picture: 96.,
            good_side: if aspect < 1. { 320. } else { 224. },
            peek: 100.,
        }
    }

    /// How much of the line below the stage's last whole line shows.
    fn peek_of(input: &GridInput, plan: &GridPlan) -> f32 {
        let pitch = plan.line + input.gap;
        input.height - (input.height / pitch).floor() * pitch
    }

    /// The owner's complaint: tall versions, more than fit, and no sign of the rest. Whatever the
    /// stage and the count, when lines scroll the next line shows.
    #[test]
    fn when_lines_scroll_the_next_one_always_shows() {
        for (width, height) in [(752., 640.), (400., 420.), (1200., 880.), (560., 500.)] {
            for count in [5, 7, 9, 12, 40] {
                for aspect in [1. / 3., 0.5, 0.75, 1., 16. / 9., 2., 3.] {
                    let input = stage(width, height, count, aspect);
                    let plan = input.plan();
                    if plan.scrolls && plan.lines(count) > 1 {
                        assert!(
                            peek_of(&input, &plan) >= input.peek - 0.5,
                            "{width}x{height} {count} at {aspect}: {plan:?}"
                        );
                    }
                }
            }
        }
    }

    /// Lines that do not scroll fit the stage, so nothing is hidden without a sign of it.
    #[test]
    fn lines_that_do_not_scroll_fit_the_stage() {
        for count in 2..=12 {
            for aspect in [1. / 3., 0.5, 1., 2.] {
                let input = stage(752., 640., count, aspect);
                let plan = input.plan();
                if !plan.scrolls {
                    let lines = plan.lines(count) as f32;
                    let used = lines * plan.line + (lines - 1.) * input.gap;
                    assert!(used <= input.height + 0.5, "{count} at {aspect}: {plan:?}");
                }
            }
        }
    }

    #[test]
    fn tall_versions_stand_side_by_side_at_a_size_to_judge() {
        // Four tall ones fit on one line, nearly the stage's height.
        let plan = stage(752., 640., 4, 1. / 3.).plan();
        assert_eq!((plan.columns, plan.scrolls), (4, false));
        assert!(plan.line > 500., "{plan:?}");
        // Seven do not fit whole at a size to judge: four across, the rest below the edge.
        let plan = stage(752., 640., 7, 1. / 3.).plan();
        assert_eq!((plan.columns, plan.scrolls), (4, true));
        assert!(plan.line <= 640. - 100. - 16., "{plan:?}");
    }

    #[test]
    fn says_which_lines_show_whole() {
        let plan = GridPlan {
            columns: 4,
            line: 400.,
            scrolls: true,
        };
        // The stage shows the first line whole and the next in part.
        assert_eq!(
            in_view(&plan, 3, 0., 640., 16.),
            InView { first: 0, end: 1 }
        );
        // Scrolled to the second line's top.
        assert_eq!(
            in_view(&plan, 3, 416., 640., 16.),
            InView { first: 1, end: 2 }
        );
        // Scrolled to the end, where the last line shows whole.
        assert_eq!(
            in_view(&plan, 3, 608., 640., 16.),
            InView { first: 2, end: 3 }
        );
    }
}
