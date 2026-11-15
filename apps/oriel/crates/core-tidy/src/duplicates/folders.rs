//! Folder priority: which folder's copy the owner keeps, learned from the duplicate resolutions
//! they confirmed, and the order they set by hand in Settings, which goes first. Each copy a
//! resolution held names the copy kept instead, so it says one folder won over another. Only steps
//! done and not undone count, so an Undo takes its decision back.

use std::collections::{BTreeSet, HashMap};

use rusqlite::Connection;

use crate::contract::{
    FolderGroup, FolderOrder, FolderStanding, RankedFolder, RootId, kept_rel_path_of,
};

/// How many path parts below the root a folder is told apart by: `nsfw/twitter/croove`.
pub const FOLDER_DEPTH: usize = 3;

/// A folder at a depth: the depth, its root and its first path parts.
type FolderKey = (usize, RootId, String);

/// The first `depth` parts of a folder inside its root.
fn truncated(dir: &str, depth: usize) -> String {
    dir.split('/')
        .filter(|part| !part.is_empty())
        .take(depth)
        .collect::<Vec<_>>()
        .join("/")
}

fn dir_of(rel_path: &str) -> &str {
    rel_path.rfind('/').map_or("", |cut| &rel_path[..cut])
}

/// How often the owner kept one folder's copy over another's, at every depth up to
/// [`FOLDER_DEPTH`], and the orders they set by hand.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct FolderHistory {
    /// (kept, removed) to how many times, both at the same depth.
    wins: HashMap<(FolderKey, FolderKey), i64>,
    orders: Vec<FolderOrder>,
}

impl FolderHistory {
    /// The decisions of every resolution still in effect, and the owner's `orders`.
    pub fn load(connection: &Connection, orders: &[FolderOrder]) -> anyhow::Result<Self> {
        let mut statement = connection.prepare_cached(
            "SELECT s.root_id, s.from_rel, s.spec FROM plan_steps s
              JOIN plans p ON p.id = s.plan_id
              WHERE p.kind = 'resolve-duplicates' AND s.action = 'hold' AND s.status = 'done'
                AND s.undone_at IS NULL",
        )?;
        let rows = statement.query_map([], |row| {
            Ok((
                row.get::<_, RootId>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })?;
        let mut history = Self {
            orders: orders.to_vec(),
            ..Self::default()
        };
        for row in rows {
            let (root_id, removed, spec) = row?;
            let Ok(spec) = serde_json::from_str::<serde_json::Value>(&spec) else {
                continue;
            };
            let Some(kept) = spec
                .get("reason")
                .and_then(serde_json::Value::as_str)
                .and_then(kept_rel_path_of)
            else {
                continue;
            };
            history.record(root_id, dir_of(kept), dir_of(&removed));
        }
        Ok(history)
    }

    /// The owner kept a copy in `kept` over one in `removed`, both folders of `root_id`.
    pub fn record(&mut self, root_id: RootId, kept: &str, removed: &str) {
        let mut counted: Vec<(String, String)> = Vec::new();
        for depth in 1..=FOLDER_DEPTH {
            let pair = (truncated(kept, depth), truncated(removed, depth));
            // A folder shallower than the depth is the same pair again: it counts at the first.
            if pair.0 != pair.1 && !counted.contains(&pair) {
                counted.push(pair.clone());
                let (winner, loser) = pair;
                *self
                    .wins
                    .entry(((depth, root_id, winner), (depth, root_id, loser)))
                    .or_default() += 1;
            }
        }
    }

    pub fn is_empty(&self) -> bool {
        self.wins.is_empty() && self.orders.is_empty()
    }

    /// The owner's order holding both folders at `depth`, as whether `one` comes first.
    fn ordered(&self, depth: usize, root_id: RootId, one: &str, other: &str) -> Option<bool> {
        self.orders
            .iter()
            .filter(|order| order.root_id == root_id && usize::from(order.depth) == depth)
            .find_map(|order| {
                let first = order.folders.iter().position(|folder| folder == one)?;
                let second = order.folders.iter().position(|folder| folder == other)?;
                Some(first < second)
            })
    }

    /// How `left` stands against `right`, at the deepest depth where the two differ and either
    /// the owner's order holds both or they have decided between them: the order first. `None`
    /// when neither, or the folders are one at [`FOLDER_DEPTH`].
    pub fn standing_between(
        &self,
        left: (RootId, &str),
        right: (RootId, &str),
    ) -> Option<FolderStanding> {
        for depth in (1..=FOLDER_DEPTH).rev() {
            let one = truncated(left.1, depth);
            let other = truncated(right.1, depth);
            if left.0 == right.0 && one == other {
                return None;
            }
            if left.0 == right.0
                && let Some(first) = self.ordered(depth, left.0, &one, &other)
            {
                return Some(FolderStanding::Ordered(first));
            }
            let (one, other) = ((depth, left.0, one), (depth, right.0, other));
            let won = self
                .wins
                .get(&(one.clone(), other.clone()))
                .copied()
                .unwrap_or(0);
            let lost = self.wins.get(&(other, one)).copied().unwrap_or(0);
            if won + lost > 0 {
                return Some(FolderStanding::Record(won, lost));
            }
        }
        None
    }

    /// Each folder's score among `folders`: one up for every other folder it comes before or
    /// usually wins over, one down for every one it comes after or usually loses to. Higher is
    /// the folder to keep from.
    pub fn scores(&self, folders: &[(RootId, &str)]) -> Vec<i64> {
        folders
            .iter()
            .map(|&folder| {
                folders
                    .iter()
                    .filter_map(|&other| self.standing_between(folder, other))
                    .map(|standing| match standing {
                        FolderStanding::Ordered(true) => 1,
                        FolderStanding::Ordered(false) => -1,
                        FolderStanding::Record(won, lost) => (won - lost).signum(),
                    })
                    .sum()
            })
            .collect()
    }

    /// The folders of a root the owner has chosen between, as Settings lists them: at each depth,
    /// each group of folders linked by their decisions or an order, best first. A group the owner
    /// ordered keeps that order, with folders learned since after it in learned order.
    pub fn groups(&self, root_id: RootId) -> Vec<FolderGroup> {
        let mut groups = Vec::new();
        for depth in 1..=FOLDER_DEPTH {
            let mut links: HashMap<&str, BTreeSet<&str>> = HashMap::new();
            let mut tally: HashMap<&str, (i64, i64)> = HashMap::new();
            for ((winner, loser), times) in &self.wins {
                if winner.0 != depth || winner.1 != root_id || loser.1 != root_id {
                    continue;
                }
                let (winner, loser) = (winner.2.as_str(), loser.2.as_str());
                links.entry(winner).or_default().insert(loser);
                links.entry(loser).or_default().insert(winner);
                tally.entry(winner).or_default().0 += times;
                tally.entry(loser).or_default().1 += times;
            }
            let orders: Vec<&FolderOrder> = self
                .orders
                .iter()
                .filter(|order| order.root_id == root_id && usize::from(order.depth) == depth)
                .collect();
            for order in &orders {
                for pair in order.folders.windows(2) {
                    links.entry(&pair[0]).or_default().insert(&pair[1]);
                    links.entry(&pair[1]).or_default().insert(&pair[0]);
                }
            }
            let mut seen: BTreeSet<&str> = BTreeSet::new();
            let mut starts: Vec<&str> = links.keys().copied().collect();
            starts.sort_unstable();
            for start in starts {
                if seen.contains(start) {
                    continue;
                }
                let mut members = Vec::new();
                let mut stack = vec![start];
                while let Some(folder) = stack.pop() {
                    if !seen.insert(folder) {
                        continue;
                    }
                    members.push(folder);
                    stack.extend(links.get(folder).into_iter().flatten().copied());
                }
                let score = |folder: &str| -> i64 {
                    links
                        .get(folder)
                        .into_iter()
                        .flatten()
                        .map(|other| {
                            let won = self.direct(depth, root_id, folder, other);
                            let lost = self.direct(depth, root_id, other, folder);
                            (won - lost).signum()
                        })
                        .sum()
                };
                members.sort_by(|left, right| {
                    let net = |folder: &str| {
                        let (won, lost) = tally.get(folder).copied().unwrap_or_default();
                        won - lost
                    };
                    score(right)
                        .cmp(&score(left))
                        .then_with(|| net(right).cmp(&net(left)))
                        .then_with(|| left.cmp(right))
                });
                let order = orders.iter().find(|order| {
                    order
                        .folders
                        .iter()
                        .any(|folder| members.contains(&folder.as_str()))
                });
                if let Some(order) = order {
                    let mut ordered: Vec<&str> = order
                        .folders
                        .iter()
                        .map(String::as_str)
                        .filter(|folder| members.contains(folder))
                        .collect();
                    let learned: Vec<&str> = members
                        .iter()
                        .copied()
                        .filter(|folder| !ordered.contains(folder))
                        .collect();
                    ordered.extend(learned);
                    members = ordered;
                }
                groups.push(FolderGroup {
                    depth: depth as u8,
                    ordered: order.is_some(),
                    folders: members
                        .into_iter()
                        .map(|folder| {
                            let (won, lost) = tally.get(folder).copied().unwrap_or_default();
                            RankedFolder {
                                dir: folder.to_string(),
                                won,
                                lost,
                            }
                        })
                        .collect(),
                });
            }
        }
        groups.sort_by(|left, right| {
            left.depth
                .cmp(&right.depth)
                .then_with(|| right.folders.len().cmp(&left.folders.len()))
                .then_with(|| left.folders[0].dir.cmp(&right.folders[0].dir))
        });
        groups
    }

    /// How often the owner kept `winner`'s copy over `loser`'s at exactly `depth`.
    fn direct(&self, depth: usize, root_id: RootId, winner: &str, loser: &str) -> i64 {
        self.wins
            .get(&(
                (depth, root_id, winner.to_string()),
                (depth, root_id, loser.to_string()),
            ))
            .copied()
            .unwrap_or(0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::catalog::schema::MIGRATIONS;

    fn history(pairs: &[(&str, &str, usize)]) -> FolderHistory {
        let mut history = FolderHistory::default();
        for &(kept, removed, times) in pairs {
            for _ in 0..times {
                history.record(1, kept, removed);
            }
        }
        history
    }

    #[test]
    fn an_artist_folder_decided_before_wins_by_its_own_record() {
        let history = history(&[("nsfw/patreon/croove", "nsfw/twitter/croove", 3)]);
        assert_eq!(
            history.standing_between((1, "nsfw/patreon/croove/2024"), (1, "nsfw/twitter/croove")),
            Some(FolderStanding::Record(3, 0))
        );
        assert_eq!(
            history.scores(&[(1, "nsfw/twitter/croove"), (1, "nsfw/patreon/croove/2024")]),
            vec![-1, 1]
        );
    }

    #[test]
    fn a_new_artist_pair_falls_back_to_the_sites_record() {
        let history = history(&[
            ("nsfw/twitter/a", "nsfw/danbooru/a", 5),
            ("nsfw/danbooru/b", "nsfw/twitter/b", 1),
        ]);
        assert_eq!(
            history.standing_between((1, "nsfw/twitter/c"), (1, "nsfw/danbooru/c")),
            Some(FolderStanding::Record(5, 1))
        );
    }

    #[test]
    fn folders_one_at_the_deepest_depth_or_never_compared_have_no_preference() {
        let history = history(&[("nsfw/patreon/croove", "nsfw/twitter/croove", 3)]);
        assert_eq!(
            history.standing_between((1, "nsfw/patreon/croove/a"), (1, "nsfw/patreon/croove/b")),
            None
        );
        assert_eq!(
            history.standing_between((1, "nsfw/twitter/x"), (1, "nsfw/twitter/y")),
            None
        );
        assert_eq!(history.standing_between((1, "sfw/a"), (1, "sfw/b")), None);
    }

    #[test]
    fn settings_lists_groups_best_first_and_the_owners_order_wins() {
        let mut history = history(&[
            ("nsfw/patreon/a", "nsfw/twitter/a", 4),
            ("nsfw/twitter/b", "nsfw/danbooru/b", 2),
        ]);
        let dirs = |history: &FolderHistory, depth: u8| -> Vec<Vec<String>> {
            history
                .groups(1)
                .into_iter()
                .filter(|group| group.depth == depth)
                .map(|group| group.folders.into_iter().map(|folder| folder.dir).collect())
                .collect()
        };
        assert_eq!(
            dirs(&history, 2),
            [["nsfw/patreon", "nsfw/twitter", "nsfw/danbooru"]]
        );
        assert_eq!(dirs(&history, 3).len(), 2);

        history.orders = vec![FolderOrder {
            root_id: 1,
            depth: 2,
            folders: vec!["nsfw/danbooru".into(), "nsfw/patreon".into()],
        }];
        assert_eq!(
            dirs(&history, 2),
            [["nsfw/danbooru", "nsfw/patreon", "nsfw/twitter"]]
        );
        assert_eq!(
            history.standing_between((1, "nsfw/danbooru/x"), (1, "nsfw/patreon/y")),
            Some(FolderStanding::Ordered(true))
        );
        // Folders the order leaves out still go by what the owner did.
        assert_eq!(
            history.standing_between((1, "nsfw/twitter/x"), (1, "nsfw/danbooru/y")),
            Some(FolderStanding::Record(2, 0))
        );
    }

    #[test]
    fn only_resolutions_still_in_effect_teach_it() {
        let connection = Connection::open_in_memory().unwrap();
        for migration in MIGRATIONS {
            connection.execute_batch(migration).unwrap();
        }
        connection
            .execute_batch(
                "INSERT INTO roots (id, path, added_at) VALUES (1, '/r', 0);
                 INSERT INTO plans (id, kind, created_at, status)
                   VALUES (1, 'resolve-duplicates', 0, 'applied'),
                          (2, 'resolve-duplicates', 0, 'undone'),
                          (3, 'hold', 0, 'applied');",
            )
            .unwrap();
        let step = |plan: i64, from: &str, kept: &str, status: &str| {
            connection
                .execute(
                    "INSERT INTO plan_steps (plan_id, action, root_id, from_rel, spec,
                       expected_size, expected_mtime_ms, expected_ctime_ms, status, bytes_before)
                     VALUES (?1, 'hold', 1, ?2, ?3, 1, 0, 0, ?4, 1)",
                    rusqlite::params![
                        plan,
                        from,
                        format!(r#"{{"kind":"hold","reason":"Duplicate of {kept}"}}"#),
                        status
                    ],
                )
                .unwrap();
        };
        step(1, "nsfw/twitter/a/1.jpg", "nsfw/patreon/a/1.avif", "done");
        step(2, "nsfw/patreon/a/2.avif", "nsfw/twitter/a/2.jpg", "undone");
        step(3, "nsfw/patreon/a/3.avif", "nsfw/twitter/a/3.jpg", "done");
        let history = FolderHistory::load(&connection, &[]).unwrap();
        assert_eq!(
            history.standing_between((1, "nsfw/patreon/a"), (1, "nsfw/twitter/a")),
            Some(FolderStanding::Record(1, 0))
        );
    }
}
