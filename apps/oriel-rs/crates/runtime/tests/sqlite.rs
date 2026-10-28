//! A catalog's connection: Electron Oriel's settings, glazier-core's migration rule, and calls
//! from GPUI tasks that run in order on the catalog's own thread.

use std::path::PathBuf;

use futures::executor::block_on;
use gpui_kit::{AppContext as _, TestAppContext};
use oriel_runtime::Database;

/// A folder of its own under the temp folder, emptied first.
fn scratch(test: &str) -> PathBuf {
    let folder = std::env::temp_dir()
        .join("oriel-runtime-sqlite-tests")
        .join(format!("{test}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&folder);
    std::fs::create_dir_all(&folder).unwrap();
    folder
}

fn user_version(db: &Database) -> i64 {
    block_on(db.call(|connection| {
        Ok(connection.pragma_query_value(None, "user_version", |row| row.get(0))?)
    }))
    .unwrap()
}

#[test]
fn a_catalog_opens_with_electron_oriels_settings() {
    let path = scratch("settings").join("catalog.sqlite");
    let db = block_on(Database::open(&path, &[])).unwrap();
    assert_eq!(db.path(), path);

    let (mode, synchronous, foreign_keys) = block_on(db.call(|connection| {
        let mode: String = connection.pragma_query_value(None, "journal_mode", |row| row.get(0))?;
        let synchronous: i64 =
            connection.pragma_query_value(None, "synchronous", |row| row.get(0))?;
        let foreign_keys: i64 =
            connection.pragma_query_value(None, "foreign_keys", |row| row.get(0))?;
        Ok((mode, synchronous, foreign_keys))
    }))
    .unwrap();
    assert_eq!(mode, "wal");
    assert_eq!(synchronous, 1, "NORMAL");
    assert_eq!(foreign_keys, 1);

    // As in node:sqlite, a double-quoted name that is no column is an error, not a string.
    let quoted = block_on(db.call(|connection| {
        Ok(connection.query_row(r#"SELECT "not a column""#, [], |row| {
            row.get::<_, String>(0)
        })?)
    }));
    assert!(quoted.is_err());

    block_on(db.call(|connection| Ok(connection.execute_batch("CREATE TABLE t (x)")?))).unwrap();
    assert!(path.with_extension("sqlite-wal").exists());
    block_on(db.close()).unwrap();
    assert!(
        !path.with_extension("sqlite-wal").exists(),
        "closing the last connection checkpoints the WAL"
    );
}

const FIRST: &[&str] = &[
    "CREATE TABLE roots (id INTEGER PRIMARY KEY, path TEXT NOT NULL UNIQUE);",
    "CREATE TABLE files (root_id INTEGER NOT NULL REFERENCES roots (id), rel_path TEXT NOT NULL);",
];

const SECOND: &[&str] = &[
    "CREATE TABLE roots (id INTEGER PRIMARY KEY, path TEXT NOT NULL UNIQUE);",
    "CREATE TABLE files (root_id INTEGER NOT NULL REFERENCES roots (id), rel_path TEXT NOT NULL);",
    "ALTER TABLE files ADD COLUMN size INTEGER;",
];

const BROKEN: &[&str] = &[
    "CREATE TABLE roots (id INTEGER PRIMARY KEY, path TEXT NOT NULL UNIQUE);",
    "CREATE TABLE half (x); CREATE TABLE broken (;",
];

#[test]
fn migrations_run_once_each_and_count_in_user_version() {
    let path = scratch("migrations").join("catalog.sqlite");
    let db = block_on(Database::open(&path, FIRST)).unwrap();
    assert_eq!(user_version(&db), 2);
    block_on(db.close()).unwrap();

    // The first two would fail if they ran again, since their tables exist.
    let db = block_on(Database::open(&path, SECOND)).unwrap();
    assert_eq!(user_version(&db), 3);
    let foreign_key = block_on(db.call(|connection| {
        Ok(connection.execute(
            "INSERT INTO files (root_id, rel_path) VALUES (7, 'a.jpg')",
            [],
        ))
    }))
    .unwrap();
    assert!(foreign_key.is_err(), "a file needs its root");
    block_on(db.close()).unwrap();

    // An app older than the catalog leaves its version alone, as glazier-core does.
    let db = block_on(Database::open(&path, FIRST)).unwrap();
    assert_eq!(user_version(&db), 3);
}

#[test]
fn a_failed_migration_rolls_back_alone_and_the_open_fails() {
    let path = scratch("broken").join("catalog.sqlite");
    let error = block_on(Database::open(&path, BROKEN)).unwrap_err();
    assert!(format!("{error:#}").contains("syntax error"), "{error:#}");

    let db = block_on(Database::open(&path, &BROKEN[..1])).unwrap();
    assert_eq!(user_version(&db), 1);
    let half = block_on(db.call(|connection| {
        Ok(connection.query_row(
            "SELECT count(*) FROM sqlite_master WHERE name = 'half'",
            [],
            |row| row.get::<_, i64>(0),
        )?)
    }))
    .unwrap();
    assert_eq!(
        half, 0,
        "the broken migration's first statement rolled back too"
    );
}

#[gpui_kit::test]
async fn gpui_tasks_call_the_catalog_in_order(cx: &mut TestAppContext) {
    // The catalog answers from its own thread, so the test scheduler has to be allowed to wait.
    cx.executor().allow_parking();
    let path = scratch("gpui").join("catalog.sqlite");
    let db = cx
        .background_spawn(Database::open(
            path,
            &["CREATE TABLE log (step INTEGER NOT NULL);"],
        ))
        .await
        .unwrap();

    let inserts: Vec<_> = (0..20)
        .map(|step| {
            let insert = db.call(move |connection| {
                connection.execute("INSERT INTO log (step) VALUES (?1)", [step])?;
                Ok(connection.last_insert_rowid())
            });
            cx.spawn(async move |_| insert.await)
        })
        .collect();
    for (step, insert) in inserts.into_iter().enumerate() {
        assert_eq!(insert.await.unwrap(), step as i64 + 1);
    }

    // An error and a panic come back to their caller, and the connection carries on.
    let failed =
        db.call(|connection| Ok(connection.execute("INSERT INTO nowhere VALUES (1)", [])?));
    assert!(
        failed
            .await
            .unwrap_err()
            .to_string()
            .contains("no such table")
    );
    let panicked = db.call(|_| -> anyhow::Result<()> { panic!("bad row") });
    assert_eq!(panicked.await.unwrap_err().to_string(), "panicked: bad row");

    let steps = cx
        .background_spawn(db.call(|connection| {
            let mut statement = connection.prepare("SELECT step FROM log ORDER BY rowid")?;
            let steps = statement
                .query_map([], |row| row.get::<_, i64>(0))?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(steps)
        }))
        .await
        .unwrap();
    assert_eq!(steps, (0..20).collect::<Vec<i64>>());

    let closing = db.clone();
    closing.close().await.unwrap();
    assert!(
        db.call(|_| Ok(()))
            .await
            .unwrap_err()
            .to_string()
            .ends_with("is closed")
    );
}
