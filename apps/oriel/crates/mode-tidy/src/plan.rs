//! What Tidy up would do to the folder on screen, row by row, as the Tidy page lists it and the
//! sidebar counts it: files made smaller (videos, pictures, animations) and files cleaned
//! (silent soundtracks, then junk, empty folders and wrong extensions).
//!
//! The videos' row folds Convert and Shrink together. With AV1 off it is Convert's move to MP4;
//! with it on, every video AV1 would shrink is encoded once, straight to AV1 MP4, and Convert's
//! move to MP4 takes only the videos AV1 leaves, so no video counts twice.

use gpui_kit::assets::IconName;
use oriel_core_tidy::contract::Tidy;

use crate::state::{CleanPart, ConvertGroup, Estimate, TidyState};

/// One row of the plan.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum PlanRow {
    Videos,
    Pictures,
    Animations,
    SilentTracks,
    CleanUp,
}

impl PlanRow {
    /// The rows that make files smaller, then those that clean, in the page's order.
    pub const SMALLER: [PlanRow; 3] = [PlanRow::Videos, PlanRow::Pictures, PlanRow::Animations];
    pub const CLEANER: [PlanRow; 2] = [PlanRow::SilentTracks, PlanRow::CleanUp];

    pub fn key(self) -> &'static str {
        match self {
            PlanRow::Videos => "videos",
            PlanRow::Pictures => "pictures",
            PlanRow::Animations => "animations",
            PlanRow::SilentTracks => "silent",
            PlanRow::CleanUp => "cleanup",
        }
    }

    pub fn icon(self) -> IconName {
        match self {
            PlanRow::Videos => IconName::Film,
            PlanRow::Pictures => IconName::Image,
            PlanRow::Animations => IconName::Clapperboard,
            PlanRow::SilentTracks => IconName::VolumeX,
            PlanRow::CleanUp => IconName::Sparkles,
        }
    }

    /// The Convert group the row runs, for the rows that make files smaller.
    pub fn group(self) -> Option<ConvertGroup> {
        match self {
            PlanRow::Videos => Some(ConvertGroup::Videos),
            PlanRow::Pictures => Some(ConvertGroup::Pictures),
            PlanRow::Animations => Some(ConvertGroup::Animations),
            PlanRow::SilentTracks | PlanRow::CleanUp => None,
        }
    }

    fn part(self) -> Option<CleanPart> {
        match self {
            PlanRow::SilentTracks => Some(CleanPart::SilentTracks),
            PlanRow::CleanUp => Some(CleanPart::CleanUp),
            _ => None,
        }
    }

    /// Switches the row on or off: its Convert group, or its clean-up part.
    pub fn set_on(self, state: &mut TidyState, on: bool, cx: &mut gpui_kit::Context<TidyState>) {
        match (self.group(), self.part()) {
            (Some(group), _) => state.set_convert_group(group, on, cx),
            (_, Some(part)) => state.set_clean_part(part, on, cx),
            _ => {}
        }
    }

    /// Whether the row's switch is on.
    pub fn is_on(self, state: &TidyState) -> bool {
        match (self.group(), self.part()) {
            (Some(group), _) => state.convert_groups().contains(&group),
            (_, Some(part)) => state.clean_part_on(part),
            _ => false,
        }
    }
}

/// How much a row's files come to now, and what they are expected to come to.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Saving {
    /// The row removes, renames or strips: there is no size to estimate.
    None,
    Pending,
    Unknown,
    Known {
        before: f64,
        after: f64,
    },
}

impl Saving {
    pub fn saved(self) -> f64 {
        match self {
            Saving::Known { before, after } => (before - after).max(0.),
            _ => 0.,
        }
    }

    fn of(estimate: Estimate) -> Self {
        match estimate {
            Estimate::Pending => Saving::Pending,
            Estimate::Unknown => Saving::Unknown,
            Estimate::Known { before, after } => Saving::Known { before, after },
        }
    }
}

/// One row's work: how many files (folders and fixes too, for clean-up) and the saving.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct RowWork {
    pub row: PlanRow,
    pub on: bool,
    pub files: i64,
    pub bytes: i64,
    pub saving: Saving,
}

impl RowWork {
    pub fn todo(&self) -> bool {
        self.files > 0
    }
}

/// The videos' row split by what happens to each video.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct VideoSplit {
    /// Encoded once to AV1 MP4 (AV1 on).
    pub to_av1: i64,
    /// Of those, videos Convert would otherwise have copied or re-encoded into MP4 first.
    pub to_av1_from_convert: i64,
    /// Copied into MP4 with their tracks kept, or re-encoded into MP4 because MP4 can't hold
    /// their tracks.
    pub remux: i64,
    pub reencode: i64,
}

/// Every row's work, in the page's order.
pub fn rows(state: &TidyState, tidy: &Tidy) -> Vec<RowWork> {
    PlanRow::SMALLER
        .into_iter()
        .chain(PlanRow::CLEANER)
        .map(|row| row_work(state, tidy, row))
        .collect()
}

fn row_work(state: &TidyState, tidy: &Tidy, row: PlanRow) -> RowWork {
    let on = row.is_on(state);
    let (files, bytes, saving) = match row {
        PlanRow::Videos if state.av1() => av1_videos(state, tidy),
        PlanRow::Videos | PlanRow::Pictures | PlanRow::Animations => {
            let group = row
                .group()
                .expect("a row that makes files smaller has a group");
            let (files, bytes) = group.totals(tidy);
            let saving = if files > 0 {
                Saving::of(state.estimate(group.categories()))
            } else {
                Saving::None
            };
            (files, bytes, saving)
        }
        PlanRow::SilentTracks => (tidy.silent_tracks.files, 0, Saving::None),
        PlanRow::CleanUp => (tidy.cleanup.count(), 0, Saving::None),
    };
    RowWork {
        row,
        on,
        files,
        bytes,
        saving,
    }
}

/// The videos' row with AV1 on: AV1's videos at their expected sizes, and the videos only Convert
/// takes at Convert's estimate.
fn av1_videos(state: &TidyState, tidy: &Tidy) -> (i64, i64, Saving) {
    let shrink = tidy.shrink;
    let (convert_files, convert_bytes) = ConvertGroup::Videos.totals(tidy);
    let left_files = (convert_files - shrink.from_remux - shrink.from_reencode).max(0);
    let left_bytes = (convert_bytes - shrink.convert_bytes).max(0) as f64;
    let files = shrink.files + left_files;
    let bytes = shrink.bytes + left_bytes as i64;
    if files == 0 {
        return (0, 0, Saving::None);
    }
    let before = shrink.bytes as f64 + left_bytes;
    let saving = if left_files == 0 {
        Saving::Known {
            before,
            after: shrink.estimated_bytes as f64,
        }
    } else {
        match state.estimate(ConvertGroup::Videos.categories()).ratio() {
            Some(ratio) => Saving::Known {
                before,
                after: shrink.estimated_bytes as f64 + left_bytes * ratio,
            },
            None => match state.estimate(ConvertGroup::Videos.categories()) {
                Estimate::Pending => Saving::Pending,
                // Convert's videos with no saving of their own still leave AV1's.
                _ => Saving::Known {
                    before,
                    after: shrink.estimated_bytes as f64 + left_bytes,
                },
            },
        }
    };
    (files, bytes, saving)
}

/// What happens to the videos on the videos' row.
pub fn video_split(state: &TidyState, tidy: &Tidy) -> VideoSplit {
    use oriel_core_tidy::contract::OptimizeCategory;
    let count = |category| {
        tidy.convert
            .categories
            .iter()
            .filter(|entry| entry.category == category)
            .map(|entry| entry.files)
            .sum::<i64>()
    };
    let (remux, reencode) = (
        count(OptimizeCategory::VideoRemux),
        count(OptimizeCategory::VideoConvert),
    );
    if !state.av1() {
        return VideoSplit {
            remux,
            reencode,
            ..VideoSplit::default()
        };
    }
    let shrink = tidy.shrink;
    VideoSplit {
        to_av1: shrink.files,
        to_av1_from_convert: shrink.from_remux + shrink.from_reencode,
        remux: (remux - shrink.from_remux).max(0),
        reencode: (reencode - shrink.from_reencode).max(0),
    }
}

/// Of the saving on the rows switched on, what is on copies the open duplicate sets would remove,
/// whose whole size Duplicates' own totals count: reading the two together counts nothing twice.
pub fn on_copies(state: &TidyState, tidy: &Tidy, rows: &[RowWork]) -> f64 {
    rows.iter()
        .filter(|work| work.on && work.todo())
        .map(|work| match work.row {
            PlanRow::Videos if state.av1() => tidy.shrink.duplicate_saving as f64,
            PlanRow::Videos | PlanRow::Pictures | PlanRow::Animations => {
                let categories = work.row.group().map_or(&[][..], ConvertGroup::categories);
                match (
                    state.estimate(categories),
                    state.estimate_beside_duplicates(categories),
                ) {
                    (
                        Estimate::Known { before, after },
                        Estimate::Known {
                            before: b,
                            after: a,
                        },
                    ) => ((before - after) - (b - a)).max(0.),
                    _ => 0.,
                }
            }
            PlanRow::SilentTracks | PlanRow::CleanUp => 0.,
        })
        .sum()
}

/// What Tidy up would do with the switches as they are: the changes it makes (a file converted
/// and stripped of a silent soundtrack is two, an empty folder or a renamed file one each) and the
/// saving, and whether part of the saving is still being estimated.
pub fn totals(rows: &[RowWork]) -> (i64, f64, bool) {
    rows.iter()
        .filter(|work| work.on)
        .fold((0, 0., false), |(files, saved, pending), work| {
            (
                files + work.files,
                saved + work.saving.saved(),
                pending || work.saving == Saving::Pending,
            )
        })
}

/// Whether Tidy up has anything to run with the switches as they are.
pub fn todo_any(rows: &[RowWork]) -> bool {
    rows.iter().any(|work| work.on && work.todo())
}
