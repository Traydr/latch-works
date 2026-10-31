//! The import against a synthetic Electron Oriel: a stand-in home under the temp folder, laid out
//! and written as Electron Oriel writes it. Tidy's catalog and holding are made by a real Tidy
//! change (Oriel RS's engine writes glazier-core's format, which its differential tests keep
//! equal), and the window's preferences are a LevelDB Electron itself wrote
//! (`tests/fixtures/local-storage`).

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use aes_gcm::aead::AeadInPlace as _;
use aes_gcm::{Aes256Gcm, KeyInit as _, Nonce};
use base64::Engine as _;
use futures::executor::block_on;
use oriel_core_paths::DataRoot;
use oriel_core_tidy::TidyEngine;
use oriel_core_tidy::contract::{PlanListRequest, PlanRequest, PlanStatus};
use oriel_core_tidy::passes::{Media, Quiet};
use oriel_migrate::{
    Area, ElectronData, Owners, Platform, Progress, Report, Survey, finish_pending, import,
    import_now, pending,
};
use rusqlite::Connection;
use serde_json::{Value, json};

const KEY: [u8; 32] = [7; 32];

/// A scratch folder under the temp folder, removed when dropped.
struct Scratch(PathBuf);

impl Scratch {
    fn new(label: &str) -> Self {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let folder = std::env::temp_dir().join(format!(
            "oriel-migrate-{label}-{}-{nanos}",
            std::process::id()
        ));
        fs::create_dir_all(&folder).unwrap();
        Self(fs::canonicalize(folder).unwrap())
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

/// Electron Oriel's data, made under `scratch/home`, with the archive its modes work on.
struct Electron {
    home: PathBuf,
    archive: PathBuf,
    /// A volume outside the stand-in home, where a root held a file.
    elsewhere: PathBuf,
}

impl Electron {
    fn latch_works(&self) -> PathBuf {
        self.home.join(".latch-works")
    }

    fn source(&self) -> ElectronData {
        ElectronData::under(&self.home, &Owners::default(), false, Platform::CURRENT)
    }

    fn make(scratch: &Scratch) -> Self {
        let home = scratch.0.join("home");
        let archive = scratch.0.join("archive");
        copy_folder(&conformance().join("archive"), &archive);
        let electron = Self {
            home,
            archive,
            elsewhere: scratch.0.join("Volumes/Elsewhere"),
        };
        electron.make_shell();
        electron.make_view();
        electron.make_tidy(scratch);
        electron.make_sync();
        let cache = electron.latch_works().join("hash-cache/v1");
        fs::create_dir_all(&cache).unwrap();
        fs::write(
            cache.join("0f1e.json"),
            json!({ "entries": [], "sourceRoot": electron.archive, "version": 1 }).to_string(),
        )
        .unwrap();
        // Lockstep's settings from before profiles, which Sync reads only without its own.
        fs::write(
            electron.latch_works().join("lockstep.json"),
            json!({ "apiUrl": "http://old.example", "source": "/old" }).to_string(),
        )
        .unwrap();
        electron
    }

    fn make_shell(&self) {
        let oriel = self.latch_works().join("oriel");
        fs::create_dir_all(&oriel).unwrap();
        fs::write(
            oriel.join("window-state.json"),
            r#"{"bounds":{"x":40,"y":60,"width":1500,"height":950},"maximized":true}"#,
        )
        .unwrap();
        copy_folder(
            &Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/local-storage"),
            &oriel.join("Local Storage/leveldb"),
        );
        fs::write(oriel.join("welcomed"), "2026-10-01T08:00:00.000Z\n").unwrap();
        fs::write(
            oriel.join("migration.json"),
            json!({ "ranAt": "2026-10-01T08:00:00.000Z", "folders": ["/from/the/old/apps"] })
                .to_string(),
        )
        .unwrap();
        // Chromium's own caches beside them, which are not the owner's data.
        fs::create_dir_all(oriel.join("GPUCache")).unwrap();
        fs::write(oriel.join("GPUCache/data_0"), b"cache").unwrap();
    }

    fn make_view(&self) {
        let view = self.latch_works().join("frame-view");
        fs::create_dir_all(view.join("frame-view/thumbnails")).unwrap();
        fs::write(
            view.join("frame-view-settings.json"),
            json!({
                "version": 3,
                "settings": { "theme": "dark", "lastFolderPath": self.archive },
                "windowBounds": null,
                "windowMaximized": false,
            })
            .to_string(),
        )
        .unwrap();
        for key in ["0a1b", "2c3d"] {
            fs::write(
                view.join(format!("frame-view/thumbnails/{key}.webp")),
                b"RIFF",
            )
            .unwrap();
        }
        // The index with its last rows still in the log, as a crash leaves it: the connection
        // is never closed, so they are never folded into the file.
        let index = Connection::open(view.join("media-index.sqlite")).unwrap();
        index
            .execute_batch(
                "PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;
                 CREATE TABLE media_index (path TEXT PRIMARY KEY, size INTEGER NOT NULL);
                 INSERT INTO media_index VALUES ('a.jpg', 1), ('b.jpg', 2), ('c.jpg', 3);",
            )
            .unwrap();
        std::mem::forget(index);
        assert!(view.join("media-index.sqlite-wal").is_file());
    }

    /// A real Tidy change in Electron Oriel's folder: Clean Up holds one file and renames
    /// another, so the catalog has a journal entry and the holding a file.
    fn make_tidy(&self, scratch: &Scratch) {
        let glazier = self.latch_works().join("glazier");
        let data = DataRoot::at(scratch.0.join("engine-data")).unwrap();
        let catalog = glazier.join("catalog.sqlite");
        {
            let engine = block_on(TidyEngine::open_with(
                data,
                catalog.clone(),
                Media::default(),
            ))
            .unwrap();
            let root = block_on(engine.add_root(&self.archive)).unwrap();
            engine.scan_blocking(root.id, &Quiet::new()).unwrap();
            let performed = engine
                .perform_blocking(PlanRequest::Cleanup { root_id: root.id }, &Quiet::new())
                .unwrap();
            assert_eq!(performed.applied.plan.held.files, 1);
        }
        wait_for_close(&catalog);
        assert!(!self.archive.join("._sunset.png").exists());

        // Two more held files, as a root on another volume holds them: one on a volume inside
        // the stand-in home, one outside it, which a dry run never reads.
        let inside = self
            .home
            .join("Volumes/Photos/.latch-works/glazier/holding/1-archive/2026-10-02_101010-manual");
        let outside = self
            .elsewhere
            .join(".latch-works/glazier/holding/1-archive/2026-10-02_101010-manual");
        let connection = Connection::open(&catalog).unwrap();
        for (folder, name) in [(&inside, "inside.jpg"), (&outside, "outside.jpg")] {
            fs::create_dir_all(folder).unwrap();
            fs::write(folder.join(name), b"held elsewhere").unwrap();
            connection
                .execute(
                    "INSERT INTO holding (root_id, original_rel, hold_rel, hold_path, batch,
                       batch_path, size, held_at, plan_id, reason, state)
                     VALUES (1, ?1, ?1, ?2, 'manual', ?3, 14, 0, NULL, 'Test', 'held')",
                    rusqlite::params![
                        name,
                        folder.join(name).to_string_lossy(),
                        folder.to_string_lossy()
                    ],
                )
                .unwrap();
        }
        connection.close().unwrap();
        wait_for_close(&catalog);
    }

    fn make_sync(&self) {
        let lockstep = self.latch_works().join("lockstep");
        fs::create_dir_all(&lockstep).unwrap();
        fs::write(lockstep.join("secret-storage.key"), KEY).unwrap();
        let settings = json!({
            "activeProfileId": "p1",
            "profiles": [
                {
                    "apiUrl": "http://127.0.0.1:3000",
                    "encryptedToken": seal("token-one"),
                    "id": "p1",
                    "name": "archive",
                    "sourceRoot": self.archive,
                },
                {
                    // The old standalone Lockstep's token, which this key does not open.
                    "apiUrl": "https://pane.example",
                    "encryptedToken": base64::engine::general_purpose::STANDARD
                        .encode(b"v10 not sealed with the file key"),
                    "id": "p2",
                    "name": "Old",
                    "sourceRoot": "/elsewhere",
                },
            ],
        });
        fs::write(
            lockstep.join("lockstep-settings.json"),
            format!("{}\n", serde_json::to_string_pretty(&settings).unwrap()),
        )
        .unwrap();
    }
}

fn conformance() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../conformance/glazier-core")
}

/// A token sealed as `FileSecretStorage` seals it.
fn seal(token: &str) -> String {
    let cipher = Aes256Gcm::new_from_slice(&KEY).unwrap();
    let iv = [3u8; 12];
    let mut data = token.as_bytes().to_vec();
    let tag = cipher
        .encrypt_in_place_detached(Nonce::from_slice(&iv), b"", &mut data)
        .unwrap();
    let mut sealed = iv.to_vec();
    sealed.extend_from_slice(&tag);
    sealed.extend_from_slice(&data);
    base64::engine::general_purpose::STANDARD.encode(sealed)
}

fn copy_folder(from: &Path, to: &Path) {
    fs::create_dir_all(to).unwrap();
    for entry in fs::read_dir(from).unwrap() {
        let entry = entry.unwrap();
        let target = to.join(entry.file_name());
        if entry.file_type().unwrap().is_dir() {
            copy_folder(&entry.path(), &target);
        } else {
            fs::copy(entry.path(), target).unwrap();
        }
    }
}

/// The catalog's thread closes its connection a moment after the engine goes.
fn wait_for_close(catalog: &Path) {
    let wal = PathBuf::from(format!("{}-wal", catalog.display()));
    let since = Instant::now();
    while wal.exists() && since.elapsed() < Duration::from_secs(10) {
        std::thread::sleep(Duration::from_millis(20));
    }
    assert!(!wal.exists(), "the catalog stayed open");
}

/// Every file and folder under `folder`, with its bytes and times, to show nothing changed.
fn snapshot(folder: &Path) -> BTreeMap<PathBuf, (Vec<u8>, Option<std::time::SystemTime>)> {
    let mut seen = BTreeMap::new();
    let mut stack = vec![folder.to_path_buf()];
    while let Some(next) = stack.pop() {
        for entry in fs::read_dir(&next).unwrap() {
            let entry = entry.unwrap();
            let metadata = fs::symlink_metadata(entry.path()).unwrap();
            let contents = if metadata.is_dir() {
                stack.push(entry.path());
                Vec::new()
            } else {
                fs::read(entry.path()).unwrap_or_default()
            };
            seen.insert(entry.path(), (contents, metadata.modified().ok()));
        }
    }
    seen
}

/// Oriel RS's data root, holding leftovers from development runs.
fn oriel_rs(scratch: &Scratch) -> DataRoot {
    let data = DataRoot::at(scratch.0.join("oriel-rs")).unwrap();
    data.create_folders().unwrap();
    fs::write(data.shell().join("window-state.json"), "{\"old\":true}").unwrap();
    fs::write(data.tidy().join("catalog.sqlite"), b"an older catalog").unwrap();
    fs::write(data.sandbox().join("keep.txt"), b"never touched").unwrap();
    data
}

#[test]
fn the_import_brings_every_area_over_and_only_reads_electron_oriel() {
    let scratch = Scratch::new("all");
    let electron = Electron::make(&scratch);
    let data = oriel_rs(&scratch);
    let source = electron.source();
    let before = snapshot(&electron.home);
    let elsewhere = snapshot(&electron.elsewhere);
    let sandbox = snapshot(&data.sandbox());

    let survey = Survey::of(&source, &data);
    assert!(survey.found());
    assert!(survey.window_state && survey.view_settings && survey.view_folder);
    assert_eq!(survey.preferences, 9);
    assert_eq!((survey.tidy_folders, survey.held.files), (1, 3));
    assert_eq!(survey.sync_profiles, 2);
    assert_eq!(survey.thumbnails.files, 2);
    assert_eq!(survey.areas(), Area::ALL);
    assert_eq!(survey.moves_aside(&data), [Area::Shell, Area::Tidy]);

    // Staged while the app runs: nothing live changes yet.
    let progress = Progress::default();
    let staged = import(&source, &data, &progress).unwrap();
    assert!(pending(&data));
    assert_eq!(
        fs::read(data.tidy().join("catalog.sqlite")).unwrap(),
        b"an older catalog"
    );
    assert!(staged.areas.iter().all(|area| area.imported), "{staged:#?}");
    let (done, total) = progress.bytes();
    assert!(done >= total && total > 0, "{done} of {total}");

    // The next start puts it in place, moving what Oriel RS had aside.
    let report = finish_pending(&data).unwrap();
    assert!(!pending(&data));
    assert!(!data.root().join(oriel_migrate::STAGING).exists());
    assert_eq!(finish_pending(&data), None, "it is put in place once");
    let aside = PathBuf::from(report.moved_aside.clone().unwrap());
    assert!(aside.starts_with(data.root()));
    assert_eq!(
        fs::read_to_string(aside.join("shell/window-state.json")).unwrap(),
        "{\"old\":true}"
    );
    assert_eq!(
        fs::read(aside.join("tidy/catalog.sqlite")).unwrap(),
        b"an older catalog"
    );
    assert!(
        !aside.join("view").exists(),
        "an empty area is not moved aside"
    );
    let mut left: Vec<String> = fs::read_dir(data.root())
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .filter(|name| !name.starts_with("before-import-"))
        .collect();
    left.sort();
    assert_eq!(
        left,
        ["hash-cache", "sandbox", "shell", "sync", "tidy", "view"],
        "no scratch or staging folder is left"
    );
    assert_eq!(
        snapshot(&data.sandbox()),
        sandbox,
        "the sandbox is never touched"
    );
    assert_eq!(Report::read(&data.shell()).unwrap(), report);

    // The shell: the window, the preferences out of LevelDB, the welcome as seen.
    assert_eq!(
        fs::read(data.shell().join("window-state.json")).unwrap(),
        fs::read(electron.latch_works().join("oriel/window-state.json")).unwrap()
    );
    let storage: BTreeMap<String, String> =
        serde_json::from_str(&fs::read_to_string(data.shell().join("local-storage.json")).unwrap())
            .unwrap();
    assert_eq!(storage["oriel.theme"], "light");
    assert_eq!(storage["oriel.mode"], "tidy");
    assert_eq!(storage["glazier.library.mode"], "grid");
    assert_eq!(storage["unicode"], "Ünïcødé 日本語 🎞");
    assert!(!storage.contains_key("gone"), "a removed key stays removed");
    assert_eq!(report.preferences.len(), 9);
    assert!(report.window_state);
    assert_eq!(
        fs::read_to_string(data.shell().join("welcomed")).unwrap(),
        "2026-10-01T08:00:00.000Z\n"
    );
    assert!(!data.shell().join("GPUCache").exists());

    // View: the settings as they are, the index with the rows its log held, the thumbnails.
    assert_eq!(
        fs::read(data.view().join("frame-view-settings.json")).unwrap(),
        fs::read(
            electron
                .latch_works()
                .join("frame-view/frame-view-settings.json")
        )
        .unwrap()
    );
    let index = Connection::open(data.view().join("media-index.sqlite")).unwrap();
    let rows: i64 = index
        .query_row("SELECT count(*) FROM media_index", [], |row| row.get(0))
        .unwrap();
    assert_eq!(rows, 3);
    drop(index);
    assert!(
        data.view()
            .join("frame-view/thumbnails/0a1b.webp")
            .is_file()
    );

    // Tidy: every held place is now in Oriel RS's holding, with the file there; the one outside
    // the stand-in home is left where it was and said so.
    let catalog = Connection::open(data.tidy().join("catalog.sqlite")).unwrap();
    let data_dir: String = catalog
        .query_row(
            "SELECT value FROM settings WHERE key = 'data_dir'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(Path::new(&data_dir), data.tidy());
    let places: Vec<(String, String)> = catalog
        .prepare("SELECT original_rel, hold_path FROM holding ORDER BY id")
        .unwrap()
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap();
    drop(catalog);
    assert_eq!(places.len(), 3);
    for (original, place) in &places {
        let place = Path::new(place);
        if original == "outside.jpg" {
            assert!(place.starts_with(&electron.elsewhere));
        } else {
            assert!(place.starts_with(data.tidy().join("holding")), "{original}");
            assert!(place.is_file(), "{original} was not copied");
        }
    }
    let tidy = report.area(Area::Tidy).unwrap();
    assert!(
        tidy.skipped[0].starts_with("1 held file on other volumes"),
        "{tidy:?}"
    );

    // Sync: the profiles and key as they are; one token opens, the old app's does not.
    assert_eq!(
        fs::read(data.sync().join("lockstep-settings.json")).unwrap(),
        fs::read(
            electron
                .latch_works()
                .join("lockstep/lockstep-settings.json")
        )
        .unwrap()
    );
    assert_eq!(
        fs::read(data.sync().join("secret-storage.key")).unwrap(),
        KEY
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        let mode = fs::metadata(data.sync().join("secret-storage.key"))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600);
    }
    assert_eq!((report.tokens.migrated, report.tokens.failed), (1, 1));
    assert!(data.hash_cache().join("v1/0f1e.json").is_file());

    let archive = electron.archive.to_string_lossy().into_owned();
    for folder in [archive.as_str(), "/elsewhere", "/from/the/old/apps"] {
        assert!(
            report.folders.iter().any(|known| known == folder),
            "{folder}"
        );
    }
    assert_eq!(
        report
            .folders
            .iter()
            .filter(|known| **known == archive)
            .count(),
        1
    );

    // Electron Oriel's data is as it was, byte for byte and time for time, with no `-shm` or
    // log of anyone else's beside its databases.
    assert_eq!(snapshot(&electron.home), before);
    assert_eq!(snapshot(&electron.elsewhere), elsewhere);
}

#[test]
fn undo_works_on_a_change_the_import_brought_over() {
    let scratch = Scratch::new("undo");
    let electron = Electron::make(&scratch);
    let data = oriel_rs(&scratch);
    import_now(&electron.source(), &data, &Progress::default()).unwrap();

    let engine = block_on(TidyEngine::open_with(
        data.clone(),
        data.tidy().join("catalog.sqlite"),
        Media::default(),
    ))
    .unwrap();
    let plans = block_on(engine.list_plans(PlanListRequest {
        root_id: None,
        offset: 0,
        limit: 20,
    }))
    .unwrap();
    assert_eq!(plans.len(), 1);
    assert!(plans[0].can_undo());
    let undone = engine.undo_blocking(plans[0].id, &Quiet::new()).unwrap();
    assert!(undone.complete, "{:?}", undone.message);
    assert_eq!(undone.plans[0].status, PlanStatus::Undone);
    // The held file came back from Oriel RS's holding; Electron Oriel's copy stays held.
    assert!(electron.archive.join("._sunset.png").is_file());
    assert!(electron.archive.join("photos/cover.jpg").is_file());
    assert!(electron.archive.join("empty").is_dir());
    let theirs = electron.latch_works().join("glazier/holding");
    assert_eq!(count_files(&theirs), 1);
}

#[test]
fn a_failed_area_leaves_its_folder_as_it_was_and_the_others_come_over() {
    let scratch = Scratch::new("failed");
    let electron = Electron::make(&scratch);
    fs::write(
        electron.latch_works().join("glazier/catalog.sqlite"),
        b"not a database",
    )
    .unwrap();
    let data = oriel_rs(&scratch);
    let report = import_now(&electron.source(), &data, &Progress::default()).unwrap();

    let tidy = report.area(Area::Tidy).unwrap();
    assert!(!tidy.imported);
    assert!(tidy.error.is_some());
    assert_eq!(
        fs::read(data.tidy().join("catalog.sqlite")).unwrap(),
        b"an older catalog",
        "Oriel RS's own Tidy stays in place"
    );
    assert!(report.area(Area::Sync).unwrap().imported);
    assert!(data.sync().join("lockstep-settings.json").is_file());
    let aside = PathBuf::from(report.moved_aside.unwrap());
    assert!(!aside.join("tidy").exists());
}

#[test]
fn a_catalog_newer_than_oriel_rs_is_left_out() {
    let scratch = Scratch::new("newer");
    let electron = Electron::make(&scratch);
    let catalog = electron.latch_works().join("glazier/catalog.sqlite");
    let connection = Connection::open(&catalog).unwrap();
    connection
        .pragma_update(None, "user_version", oriel_migrate::TIDY_USER_VERSION + 1)
        .unwrap();
    connection.close().unwrap();
    let data = oriel_rs(&scratch);
    let report = import_now(&electron.source(), &data, &Progress::default()).unwrap();
    let error = report.area(Area::Tidy).unwrap().error.clone().unwrap();
    assert!(error.contains("newer than this Oriel RS reads"), "{error}");
}

#[cfg(unix)]
#[test]
fn nothing_is_read_while_electron_oriel_runs() {
    let scratch = Scratch::new("running");
    let electron = Electron::make(&scratch);
    let host = {
        let mut name = [0u8; 256];
        // SAFETY: the buffer is valid for its length.
        unsafe { libc::gethostname(name.as_mut_ptr().cast(), name.len()) };
        let end = name.iter().position(|byte| *byte == 0).unwrap();
        String::from_utf8_lossy(&name[..end]).into_owned()
    };
    std::os::unix::fs::symlink(
        format!("{host}-{}", std::process::id()),
        electron.latch_works().join("oriel/SingletonLock"),
    )
    .unwrap();
    let data = oriel_rs(&scratch);
    let survey = Survey::of(&electron.source(), &data);
    assert_eq!(survey.running, ["Electron Oriel"]);
    let error = import(&electron.source(), &data, &Progress::default()).unwrap_err();
    assert_eq!(error.to_string(), "Quit Electron Oriel to import its data.");
    assert!(!pending(&data));
    assert!(!data.root().join(oriel_migrate::STAGING).exists());
}

#[test]
fn sync_without_settings_takes_the_profile_lockstep_json_held() {
    let scratch = Scratch::new("legacy");
    let electron = Electron::make(&scratch);
    fs::remove_dir_all(electron.latch_works().join("lockstep")).unwrap();
    let data = oriel_rs(&scratch);
    let report = import_now(&electron.source(), &data, &Progress::default()).unwrap();
    assert!(report.area(Area::Sync).unwrap().imported);
    let settings: Value = serde_json::from_str(
        &fs::read_to_string(data.sync().join("lockstep-settings.json")).unwrap(),
    )
    .unwrap();
    let profile = &settings["profiles"][0];
    assert_eq!(profile["name"], "Default");
    assert_eq!(profile["apiUrl"], "http://old.example");
    assert_eq!(profile["sourceRoot"], "/old");
    assert_eq!(settings["activeProfileId"], profile["id"]);
}

#[test]
fn the_tidy_catalog_version_is_the_one_oriel_rs_reads() {
    assert_eq!(
        oriel_migrate::TIDY_USER_VERSION,
        oriel_core_tidy::catalog::USER_VERSION
    );
}

fn count_files(folder: &Path) -> usize {
    snapshot(folder)
        .keys()
        .filter(|path| path.is_file())
        .count()
}
