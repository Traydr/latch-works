//! The catalog's file format against glazier-core's (plan 063, "Same formats"): a catalog made
//! here has glazier-core's schema at its `user_version`, and a catalog glazier-core wrote reads
//! here as it reads there, so Electron Oriel's catalogs open as they are.

#[path = "support/report.rs"]
mod report;

use std::fs;
use std::path::{Path, PathBuf};

use oriel_core_tidy::catalog::files::list_files;
use oriel_core_tidy::catalog::roots::{list_roots, read_settings};
use oriel_core_tidy::catalog::tidy::catalog_tidy;
use oriel_core_tidy::catalog::{Catalog, USER_VERSION};
use oriel_core_tidy::contract::{FileFilter, FileQuery, FileSortColumn};
use serde_json::{Value, json};

fn conformance(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../conformance/glazier-core")
        .join(name)
}

fn vectors(name: &str) -> Value {
    serde_json::from_str(&fs::read_to_string(conformance(name)).unwrap()).unwrap()
}

fn scratch(label: &str) -> PathBuf {
    let folder = std::env::temp_dir().join(format!("oriel-tidy-{label}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&folder);
    fs::create_dir_all(&folder).unwrap();
    folder
}

fn schema_of(catalog: &Catalog) -> Value {
    catalog
        .blocking(|connection| {
            let version: i64 =
                connection.pragma_query_value(None, "user_version", |row| row.get(0))?;
            let mut statement = connection.prepare(
                "SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name",
            )?;
            let master: Vec<Value> = statement
                .query_map([], |row| {
                    Ok(json!({
                        "type": row.get::<_, String>(0)?,
                        "name": row.get::<_, String>(1)?,
                        "tbl_name": row.get::<_, String>(2)?,
                        "sql": row.get::<_, Option<String>>(3)?,
                    }))
                })?
                .collect::<rusqlite::Result<_>>()?;
            Ok(json!({ "userVersion": version, "master": master }))
        })
        .unwrap()
}

#[test]
fn a_new_catalog_has_glazier_cores_schema_and_user_version() {
    let folder = scratch("schema");
    let catalog = Catalog::open_blocking(folder.join("catalog.sqlite")).unwrap();
    let made = schema_of(&catalog);
    let mut expected = vectors("catalog-schema.json");
    expected.as_object_mut().unwrap().remove("about");
    assert_eq!(made["userVersion"], json!(USER_VERSION));
    let differences = report::differences(&expected, &made);
    assert!(differences.is_empty(), "{}", differences.join("\n"));
    let _ = fs::remove_dir_all(&folder);
}

#[test]
fn a_catalog_glazier_core_wrote_reads_as_glazier_core_reads_it() {
    let folder = scratch("contents");
    // A copy is opened, so the committed file never gains a WAL or a newer header.
    let copy = folder.join("catalog.sqlite");
    fs::copy(conformance("catalog.sqlite"), &copy).unwrap();
    let catalog = Catalog::open_blocking(&copy).unwrap();
    let made = catalog
        .blocking(|connection| {
            let query = FileQuery {
                filter: FileFilter::root(Some(1)),
                sort: FileSortColumn::Path,
                descending: false,
                offset: 0,
                limit: 100,
            };
            Ok(json!({
                "roots": list_roots(connection)?,
                "settings": read_settings(connection)?,
                "files": list_files(connection, &query)?,
                "tidy": catalog_tidy(connection, 1)?,
            }))
        })
        .unwrap();
    let mut expected = vectors("catalog-contents.json");
    expected.as_object_mut().unwrap().remove("about");
    let differences = report::differences(&expected, &made);
    assert!(differences.is_empty(), "{}", differences.join("\n"));
    assert_eq!(
        schema_of(&catalog)["userVersion"],
        json!(USER_VERSION),
        "opening it migrated nothing"
    );
    let _ = fs::remove_dir_all(&folder);
}
