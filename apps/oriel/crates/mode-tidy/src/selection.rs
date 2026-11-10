//! Finder's selection over an ordered list of files, which Library and Holding share: a click
//! picks a file alone, ⌘ toggles it, ⇧ extends from the anchor, and ⇧⌘ extends keeping the rest.

use std::collections::BTreeSet;

/// What a click at `at` selects, from `selected`, with ⌘ (`command`) and ⇧ (`shift`) held, and
/// where the anchor is then; `id_at` names the file at a position.
pub(crate) fn click<Id: Ord + Copy>(
    selected: &BTreeSet<Id>,
    anchor: Option<usize>,
    at: usize,
    command: bool,
    shift: bool,
    id_at: impl Fn(usize) -> Option<Id>,
) -> (BTreeSet<Id>, Option<usize>) {
    if shift && let Some(anchor) = anchor {
        let mut next = if command {
            selected.clone()
        } else {
            BTreeSet::new()
        };
        next.extend((anchor.min(at)..=anchor.max(at)).filter_map(&id_at));
        return (next, Some(anchor));
    }
    let Some(id) = id_at(at) else {
        return (BTreeSet::new(), Some(at));
    };
    if command {
        let mut next = selected.clone();
        if !next.remove(&id) {
            next.insert(id);
        }
        return (next, Some(at));
    }
    (BTreeSet::from([id]), Some(at))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clicks_pick_toggle_and_extend_as_finder_does() {
        let files = [10, 11, 12, 13];
        let id_at = |at: usize| files.get(at).copied();
        let (picked, anchor) = click(&BTreeSet::new(), None, 1, false, false, id_at);
        assert_eq!((picked.clone(), anchor), (BTreeSet::from([11]), Some(1)));
        let (picked, anchor) = click(&picked, anchor, 3, false, true, id_at);
        assert_eq!(
            (picked.clone(), anchor),
            (BTreeSet::from([11, 12, 13]), Some(1))
        );
        let (picked, anchor) = click(&picked, anchor, 2, true, false, id_at);
        assert_eq!(
            (picked.clone(), anchor),
            (BTreeSet::from([11, 13]), Some(2))
        );
        let (picked, _) = click(&picked, anchor, 0, true, true, id_at);
        assert_eq!(picked, BTreeSet::from([10, 11, 12, 13]));
    }
}
