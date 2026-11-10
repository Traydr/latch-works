//! A catalog's connection: Electron Oriel's settings, the migration rule, and calls from other
//! threads that run in order on the catalog's own thread.

use std::path::PathBuf;

use futures::executor::block_on;
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

    // An app older than the catalog leaves its version alone.
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

#[test]
fn calls_reach_the_catalog_in_order() {
    let path = scratch("ordered").join("catalog.sqlite");
    let db = block_on(Database::open(
        path,
        &["CREATE TABLE log (step INTEGER NOT NULL);"],
    ))
    .unwrap();

    let inserts: Vec<_> = (0..20)
        .map(|step| {
            db.call(move |connection| {
                connection.execute("INSERT INTO log (step) VALUES (?1)", [step])?;
                Ok(connection.last_insert_rowid())
            })
        })
        .collect();
    // Awaited from another thread, in reverse: each answer is the place it was asked in.
    let rows = std::thread::spawn(move || {
        inserts
            .into_iter()
            .rev()
            .map(|insert| block_on(insert).unwrap())
            .collect::<Vec<_>>()
    })
    .join()
    .unwrap();
    assert_eq!(rows, (1..=20).rev().collect::<Vec<i64>>());

    // An error and a panic come back to their caller, and the connection carries on.
    let failed =
        db.call(|connection| Ok(connection.execute("INSERT INTO nowhere VALUES (1)", [])?));
    assert!(
        block_on(failed)
            .unwrap_err()
            .to_string()
            .contains("no such table")
    );
    let panicked = db.call(|_| -> anyhow::Result<()> { panic!("bad row") });
    assert_eq!(
        block_on(panicked).unwrap_err().to_string(),
        "panicked: bad row"
    );

    let steps = block_on(db.call(|connection| {
        let mut statement = connection.prepare("SELECT step FROM log ORDER BY rowid")?;
        let steps = statement
            .query_map([], |row| row.get::<_, i64>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(steps)
    }))
    .unwrap();
    assert_eq!(steps, (0..20).collect::<Vec<i64>>());

    let closing = db.clone();
    block_on(closing.close()).unwrap();
    assert!(
        block_on(db.call(|_| Ok(())))
            .unwrap_err()
            .to_string()
            .ends_with("is closed")
    );
}
