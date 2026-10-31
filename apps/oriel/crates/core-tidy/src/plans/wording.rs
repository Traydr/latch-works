//! What plans are called in History, toasts and job labels, from glazier-core's
//! `plans/wording.ts`.

use crate::contract::PlanKind;
use crate::number::{count_of, format_count};

struct Wording {
    /// The verb once the plan ran: "Converted".
    done: &'static str,
    /// The verb while it runs: "Converting".
    doing: &'static str,
    one: &'static str,
    many: &'static str,
    /// What follows the count, such as " to holding".
    tail: &'static str,
}

const fn wording(
    done: &'static str,
    doing: &'static str,
    one: &'static str,
    many: &'static str,
    tail: &'static str,
) -> Wording {
    Wording {
        done,
        doing,
        one,
        many,
        tail,
    }
}

fn wording_of(kind: PlanKind) -> Wording {
    match kind {
        PlanKind::Hold => wording("Moved", "Moving", "file", "files", " to holding"),
        PlanKind::Move => wording("Moved", "Moving", "file", "files", ""),
        PlanKind::Rename => wording("Renamed", "Renaming", "file", "files", ""),
        PlanKind::FixExtension => wording("Fixed", "Fixing", "extension", "extensions", ""),
        PlanKind::Optimize => wording("Converted", "Converting", "file", "files", ""),
        PlanKind::Reencode => wording("Re-encoded", "Re-encoding", "video", "videos", ""),
        PlanKind::StripAudio => wording("Removed", "Removing", "audio track", "audio tracks", ""),
        PlanKind::ResolveDuplicates => wording(
            "Resolved",
            "Resolving",
            "duplicate set",
            "duplicate sets",
            "",
        ),
        PlanKind::CleanJunk => wording("Moved", "Moving", "junk file", "junk files", " to holding"),
        PlanKind::RemoveEmptyFolders => {
            wording("Removed", "Removing", "empty folder", "empty folders", "")
        }
        PlanKind::Cleanup => wording("Cleaned up", "Cleaning up", "item", "items", ""),
        PlanKind::ShrinkVideos => wording("Shrank", "Shrinking", "video", "videos", ""),
    }
}

/// What a plan is about, as its title and job labels count it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PlanSubject {
    pub kind: PlanKind,
    pub count: i64,
    /// The file a single rename renamed, which the wording names instead of counting.
    pub single_name: Option<String>,
    /// For a plan that stopped or failed partway, how many of `count` finished.
    pub finished: Option<i64>,
}

fn phrase(subject: &PlanSubject, doing: bool) -> String {
    let wording = wording_of(subject.kind);
    let verb = if doing { wording.doing } else { wording.done };
    if subject.kind == PlanKind::Rename
        && subject.count == 1
        && let Some(name) = &subject.single_name
    {
        return format!("{verb} {name}");
    }
    let counted = count_of(subject.count, wording.one, wording.many);
    match subject.finished {
        None => format!("{verb} {counted}{}", wording.tail),
        Some(finished) => format!(
            "{verb} {} of {counted}{}",
            format_count(finished),
            wording.tail
        ),
    }
}

/// The past-tense title History shows: "Converted 206 files", "Renamed IMG_1.png", or for a plan
/// cut short, "Converted 5 of 19 files".
pub fn plan_title(subject: &PlanSubject) -> String {
    phrase(subject, false)
}

/// The label of the job applying a plan: "Converting 206 files".
pub fn apply_label(subject: &PlanSubject) -> String {
    phrase(subject, true)
}

/// The label of the job undoing a plan: `Undoing “Converted 206 files”`.
pub fn undo_label(subject: &PlanSubject) -> String {
    format!("Undoing “{}”", plan_title(subject))
}

/// A job's name before its plan is drafted, when only the request's kind is known: "Converting
/// files", "Cleaning up items".
pub fn doing_label(kind: PlanKind) -> String {
    let wording = wording_of(kind);
    format!("{} {}{}", wording.doing, wording.many, wording.tail)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn subject(kind: PlanKind, count: i64) -> PlanSubject {
        PlanSubject {
            kind,
            count,
            single_name: None,
            finished: None,
        }
    }

    #[test]
    fn titles_and_labels_read_as_glazier_cores() {
        assert_eq!(
            plan_title(&subject(PlanKind::Optimize, 206)),
            "Converted 206 files"
        );
        assert_eq!(
            plan_title(&subject(PlanKind::ResolveDuplicates, 1)),
            "Resolved 1 duplicate set"
        );
        assert_eq!(
            plan_title(&subject(PlanKind::CleanJunk, 3)),
            "Moved 3 junk files to holding"
        );
        let renamed = PlanSubject {
            single_name: Some("IMG_1.png".into()),
            ..subject(PlanKind::Rename, 1)
        };
        assert_eq!(plan_title(&renamed), "Renamed IMG_1.png");
        let cut_short = PlanSubject {
            finished: Some(5),
            ..subject(PlanKind::Optimize, 19)
        };
        assert_eq!(plan_title(&cut_short), "Converted 5 of 19 files");
        assert_eq!(
            apply_label(&subject(PlanKind::ShrinkVideos, 2)),
            "Shrinking 2 videos"
        );
        assert_eq!(
            undo_label(&subject(PlanKind::Cleanup, 3)),
            "Undoing “Cleaned up 3 items”"
        );
    }
}
