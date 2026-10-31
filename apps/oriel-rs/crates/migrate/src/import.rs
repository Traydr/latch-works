//! The import itself, in two steps that each leave Oriel RS's data whole.
//!
//! [`import`] reads Electron Oriel's data and builds each area of Oriel RS's data root in a staging
//! folder, `<root>/import-staging`, while the app runs. An area that fails is removed from staging
//! and the others go on. Nothing in the live areas changes yet, since the running modes hold their
//! files open.
//!
//! [`finish_pending`] puts the staged areas in place at the next start, before any mode opens a
//! file: what Oriel RS has in an area moves to `<root>/before-import-<time>/<area>` (never
//! deleted), the staged area takes its place, and the report goes to `shell/migration.json`.
//! `<root>/sandbox` is never an area, so it is never moved or touched.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use anyhow::{Context as _, bail};
use base64::Engine as _;
use oriel_core_paths::DataRoot;
use rusqlite::{Connection, OptionalExtension as _, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::files::{
    Progress, Size, copy_file, copy_tree, folder_timestamp, is_empty, iso_timestamp, remove_own,
    tree_size, with_suffix,
};
use crate::report::{Area, AreaReport, Report, Tokens, bytes, count};
use crate::source::ElectronData;
use crate::survey::{
    CATALOG, MEDIA_INDEX, SECRET_KEY, SYNC_SETTINGS, VIEW_SETTINGS, WELCOMED, WINDOW_STATE,
    local_storage_folder, read_json, thumbnail_folder,
};
use crate::{leveldb, sqlite};

/// The staging folder in the data root.
pub const STAGING: &str = "import-staging";

/// Written last in the staging folder, once every area is staged: its presence says the import is
/// ready to put in place.
const READY: &str = "ready.json";

/// The newest catalog version Oriel RS's Tidy reads: glazier-core's `MIGRATIONS.length`. A test
/// keeps it equal to `oriel_core_tidy::catalog::USER_VERSION`.
pub const TIDY_USER_VERSION: i64 = 9;

/// Oriel RS keeps the window's `localStorage` entries here (`oriel_ui::storage::FILE_NAME`), as
/// one JSON object of strings.
const LOCAL_STORAGE: &str = "local-storage.json";

/// What the staging folder holds once ready.
#[derive(Serialize, Deserialize)]
struct Ready {
    report: Report,
    /// The folder what Oriel RS had goes aside to, chosen by the start that puts the import in
    /// place and noted before anything moves, so a start after a crash midway uses it too.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    aside: Option<PathBuf>,
}

/// Writes the staging folder's note whole, through a temporary file.
fn write_note(staging: &Path, ready: &Ready) -> anyhow::Result<()> {
    let text = serde_json::to_string_pretty(ready)?;
    let temporary = staging.join(format!("{READY}.tmp"));
    fs::write(&temporary, text).context("writing the staging folder's note")?;
    fs::rename(&temporary, staging.join(READY)).context("writing the staging folder's note")?;
    Ok(())
}

/// Whether an import is staged, waiting for the next start to put it in place.
pub fn pending(data: &DataRoot) -> bool {
    data.root().join(STAGING).join(READY).is_file()
}

/// Reads Electron Oriel's data from `source` into the staging folder under `data`, area by area,
/// counting into `progress`; [`finish_pending`] puts it in place. Refuses while Electron Oriel or
/// an old app runs. An area that fails is reported and left out; the report says what came over.
pub fn import(
    source: &ElectronData,
    data: &DataRoot,
    progress: &Progress,
) -> anyhow::Result<Report> {
    let running = source.running();
    if !running.is_empty() {
        bail!("Quit {} to import its data.", and_list(&running));
    }
    let staging = data.root().join(STAGING);
    remove_own(&staging);
    fs::create_dir_all(&staging).context("making the staging folder")?;
    progress.expect(estimate(source));

    let mut report = Report {
        ran_at: iso_timestamp(SystemTime::now()),
        from: source.home().display().to_string(),
        tokens: Tokens::default(),
        preferences: Vec::new(),
        window_state: false,
        folders: Vec::new(),
        removed: Vec::new(),
        areas: Vec::new(),
        moved_aside: None,
    };
    for area in Area::ALL {
        let partial = staging.join(format!("{}.partial", area.folder()));
        let mut outcome = AreaReport::new(area);
        let staged = match area {
            Area::Shell => stage_shell(source, &partial, progress, &mut outcome, &mut report),
            Area::View => stage_view(source, &partial, progress, &mut outcome, &mut report),
            Area::Tidy => {
                let final_tidy = data.tidy();
                progress.begin("Copying Tidy's catalog and held files");
                stage_tidy(
                    source,
                    &partial,
                    &final_tidy,
                    progress,
                    &mut outcome,
                    &mut report,
                )
            }
            Area::Sync => stage_sync(source, &partial, progress, &mut outcome, &mut report),
            Area::HashCache => stage_hash_cache(source, &partial, progress, &mut outcome),
        };
        match staged {
            Ok(false) => {
                remove_own(&partial);
                continue;
            }
            Ok(true) => match fs::rename(&partial, staging.join(area.folder())) {
                Ok(()) => outcome.imported = true,
                Err(error) => outcome.error = Some(format!("It could not be staged: {error}")),
            },
            Err(error) => outcome.error = Some(format!("{error:#}")),
        }
        if !outcome.imported {
            remove_own(&partial);
        }
        report.areas.push(outcome);
    }
    let mut seen = std::collections::HashSet::new();
    report.folders.retain(|folder| seen.insert(folder.clone()));

    write_note(
        &staging,
        &Ready {
            report: report.clone(),
            aside: None,
        },
    )?;
    progress.begin("Imported");
    Ok(report)
}

/// [`import`], then [`finish_pending`] at once: for a data root no running mode holds open, such
/// as a dry run's or a test's.
pub fn import_now(
    source: &ElectronData,
    data: &DataRoot,
    progress: &Progress,
) -> anyhow::Result<Report> {
    import(source, data, progress)?;
    finish_pending(data).context("the staged import was not there to put in place")
}

/// Puts a staged import in place, at a start before anything opens Oriel RS's files. Returns the
/// report, once, or `None` when nothing was staged. A staging folder left without its note (an
/// import stopped halfway) is removed, since none of it was in place and it is only a copy.
///
/// Nothing of the owner's is deleted, and a start after a crash midway finishes the job: an area
/// the note says was staged that is gone from staging, with its live folder there, went in place
/// already; the folder moved aside is the one the note named before anything moved; and an area
/// that could not go in place keeps its staged copy in `<root>/import-not-placed-<time>`, which
/// the report names.
pub fn finish_pending(data: &DataRoot) -> Option<Report> {
    let staging = data.root().join(STAGING);
    if !staging.exists() {
        return None;
    }
    let ready: Option<Ready> = read_json(&staging.join(READY)).and_then(|value| {
        serde_json::from_value(value)
            .map_err(|error| log::warn!("the staged import's note does not read: {error}"))
            .ok()
    });
    let Some(Ready { mut report, aside }) = ready else {
        remove_own(&staging);
        return None;
    };
    let aside = match aside {
        Some(aside) => aside,
        None => {
            let aside = unique(&data.root().join(format!(
                "before-import-{}",
                folder_timestamp(SystemTime::now())
            )));
            let noted = Ready {
                report: report.clone(),
                aside: Some(aside.clone()),
            };
            // Nothing moves until the folder aside is noted, or a crash midway would leave it
            // where no report names it; the import stays staged for the next start.
            if let Err(error) = write_note(&staging, &noted) {
                log::error!("the staged import waits, since its note was not written: {error:#}");
                return None;
            }
            aside
        }
    };
    let kept = unique(&data.root().join(format!(
        "import-not-placed-{}",
        folder_timestamp(SystemTime::now())
    )));
    let mut keeps = false;
    for outcome in report.areas.iter_mut().filter(|outcome| outcome.imported) {
        let name = outcome.area.folder();
        let staged = staging.join(name);
        let live = data.root().join(name);
        if !staged.exists() && live.exists() {
            // A start that stopped after putting this area in place.
            continue;
        }
        if let Err(error) = put_in_place(&staged, &live, &aside.join(name)) {
            log::warn!("the import's {name} was not put in place: {error:#}");
            outcome.imported = false;
            outcome.error = Some(if staged.exists() {
                keeps = true;
                format!(
                    "It could not be put in place: {error:#}. Its copy is in {}.",
                    kept.join(name).display()
                )
            } else {
                format!("It could not be put in place: {error:#}")
            });
        }
    }
    if aside.is_dir() {
        report.moved_aside = Some(aside.display().to_string());
    }
    if let Err(error) = fs::create_dir_all(data.shell()).and_then(|()| report.write(&data.shell()))
    {
        log::warn!("the import's report was not written: {error}");
    }
    // Copies that did not go in place move out of staging whole, note and all, so the import is
    // no longer pending and a crash now cannot leave them where the next start removes them.
    let rest = if keeps {
        match fs::rename(&staging, &kept) {
            Ok(()) => kept,
            Err(error) => {
                log::warn!("the import's copies stay in {}: {error}", staging.display());
                staging
            }
        }
    } else {
        staging
    };
    for note in [READY.to_owned(), format!("{READY}.tmp")] {
        let _ = fs::remove_file(rest.join(note));
    }
    if !keeps {
        remove_own(&rest);
    }
    Some(report)
}

/// Moves what `live` holds to `aside` and `staged` to `live`; on failure, `live` is as it was.
fn put_in_place(staged: &Path, live: &Path, aside: &Path) -> anyhow::Result<()> {
    if !staged.is_dir() {
        bail!("it was not in the staging folder");
    }
    let moved_aside = if !live.exists() {
        false
    } else if is_empty(live) {
        fs::remove_dir(live).with_context(|| format!("clearing {}", live.display()))?;
        false
    } else {
        if fs::symlink_metadata(aside).is_ok() {
            // An empty folder there would be replaced by the move; anything else refuses it.
            bail!("{} is in the way", aside.display());
        }
        if let Some(parent) = aside.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::rename(live, aside).with_context(|| format!("moving {} aside", live.display()))?;
        true
    };
    if let Err(error) = fs::rename(staged, live) {
        if moved_aside && let Err(back) = fs::rename(aside, live) {
            log::warn!("{} stays at {}: {back}", live.display(), aside.display());
        }
        return Err(error).with_context(|| format!("moving the import to {}", live.display()));
    }
    Ok(())
}

/// `path`, or `path-2`, `path-3`, … when it is taken.
fn unique(path: &Path) -> PathBuf {
    let mut candidate = path.to_path_buf();
    let mut number = 2;
    while candidate.exists() {
        candidate = with_suffix(path, &format!("-{number}"));
        number += 1;
    }
    candidate
}

fn and_list(names: &[&str]) -> String {
    match names {
        [] => String::new(),
        [one] => (*one).to_owned(),
        [rest @ .., last] => format!("{} and {last}", rest.join(", ")),
    }
}

/// The bytes the import copies, for its progress.
fn estimate(source: &ElectronData) -> u64 {
    let files = [
        source.frame_view().join(VIEW_SETTINGS),
        source.frame_view().join(MEDIA_INDEX),
        with_suffix(&source.frame_view().join(MEDIA_INDEX), "-wal"),
        source.glazier().join(CATALOG),
        with_suffix(&source.glazier().join(CATALOG), "-wal"),
    ];
    let folders = [
        thumbnail_folder(source.frame_view()),
        source.glazier().join("holding"),
        source.hash_cache().to_path_buf(),
    ];
    files
        .iter()
        .filter_map(|file| fs::metadata(file).ok())
        .map(|metadata| metadata.len())
        .sum::<u64>()
        + folders
            .iter()
            .map(|folder| tree_size(folder).bytes)
            .sum::<u64>()
}

// The shell.

/// The window's place, its `localStorage` (read from Chromium's LevelDB), and the welcome as
/// seen. Always staged, so the welcome does not show again.
fn stage_shell(
    source: &ElectronData,
    out: &Path,
    progress: &Progress,
    outcome: &mut AreaReport,
    report: &mut Report,
) -> anyhow::Result<bool> {
    progress.begin("Copying the window and preferences");
    fs::create_dir_all(out)?;
    let oriel = source.oriel();
    let window = oriel.join(WINDOW_STATE);
    if window.is_file() {
        if read_json(&window).is_some_and(|state| state.get("bounds").is_some()) {
            copy_file(&window, &out.join(WINDOW_STATE), progress)?;
            report.window_state = true;
            outcome
                .details
                .push("the window's size and place".to_owned());
        } else {
            outcome
                .skipped
                .push("The window's size and place, which did not read".to_owned());
        }
    }
    match leveldb::local_storage(&local_storage_folder(oriel), leveldb::FILE_ORIGIN) {
        Ok(entries) if !entries.is_empty() => {
            fs::write(out.join(LOCAL_STORAGE), serde_json::to_string(&entries)?)?;
            outcome
                .details
                .push(count(entries.len() as u64, "preference", "preferences"));
            report.preferences = entries.into_keys().collect();
        }
        Ok(_) => {}
        Err(error) => outcome
            .skipped
            .push(format!("The preferences, which did not read: {error}")),
    }
    // Importing is the owner's way through the welcome, so it shows no more either way.
    let welcomed = oriel.join(WELCOMED);
    if welcomed.is_file() {
        copy_file(&welcomed, &out.join(WELCOMED), progress)?;
    } else {
        fs::write(
            out.join(WELCOMED),
            format!("{}\n", iso_timestamp(SystemTime::now())),
        )?;
    }
    // The folders Electron Oriel's own first start found in the old apps.
    if let Some(theirs) = read_json(&oriel.join(crate::report::REPORT_FILE)) {
        report.folders.extend(
            theirs
                .get("folders")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .map(str::to_owned),
        );
    }
    Ok(true)
}

// View.

/// View's settings and remembered folder, as they are, with its media index and thumbnails,
/// whose schema and keys are the same in both apps. A cache that does not read is left out, since
/// View makes it again.
fn stage_view(
    source: &ElectronData,
    out: &Path,
    progress: &Progress,
    outcome: &mut AreaReport,
    report: &mut Report,
) -> anyhow::Result<bool> {
    let view = source.frame_view();
    let settings = view.join(VIEW_SETTINGS);
    let index = view.join(MEDIA_INDEX);
    let thumbnails = thumbnail_folder(view);
    if !settings.is_file() && !index.is_file() && !thumbnails.is_dir() {
        return Ok(false);
    }
    progress.begin("Copying View's settings and thumbnails");
    fs::create_dir_all(out)?;
    if settings.is_file() {
        let parsed = read_json(&settings).context("View's settings do not read")?;
        copy_file(&settings, &out.join(VIEW_SETTINGS), progress)?;
        outcome.details.push("its settings".to_owned());
        if let Some(folder) = parsed
            .pointer("/settings/lastFolderPath")
            .and_then(Value::as_str)
            .filter(|folder| !folder.is_empty())
        {
            report.folders.push(folder.to_owned());
            outcome.details.push("its folder".to_owned());
        }
    }
    if index.is_file() {
        let copy = out.join(MEDIA_INDEX);
        match sqlite::open_copy(&index, &copy, progress).and_then(sqlite::close_copy) {
            Ok(()) => outcome.details.push(format!(
                "the media index ({})",
                bytes(fs::metadata(&copy).map_or(0, |metadata| metadata.len()))
            )),
            Err(error) => {
                for suffix in ["", "-wal", "-shm"] {
                    let _ = fs::remove_file(with_suffix(&copy, suffix));
                }
                outcome.skipped.push(format!(
                    "The media index, which View makes again: {error:#}"
                ));
            }
        }
    }
    if thumbnails.is_dir() {
        match copy_tree(&thumbnails, &thumbnail_folder(out), progress) {
            Ok(size) => outcome.details.push(format!(
                "{} ({})",
                count(size.files, "thumbnail", "thumbnails"),
                bytes(size.bytes)
            )),
            Err(error) => {
                remove_own(&out.join("frame-view"));
                outcome
                    .skipped
                    .push(format!("The thumbnails, which View makes again: {error}"));
            }
        }
    }
    Ok(true)
}

// Tidy.

/// Tidy's catalog (its folders, settings, decisions, history and journal) and its held files.
/// The catalog records each held file's absolute place, so places in Electron Oriel's holding
/// are rewritten to the same place in Oriel RS's (`tidy/holding`), as glazier-core's
/// `followDataFolder` does when its data folder moves. A root on another volume held its files
/// at the top of that volume (`<volume>/.latch-works/glazier/holding`); those are copied into
/// Oriel RS's holding too, so its Undo and Empty Holding never touch Electron Oriel's.
fn stage_tidy(
    source: &ElectronData,
    out: &Path,
    final_tidy: &Path,
    progress: &Progress,
    outcome: &mut AreaReport,
    report: &mut Report,
) -> anyhow::Result<bool> {
    let glazier = source.glazier();
    let catalog = glazier.join(CATALOG);
    if !catalog.is_file() {
        return Ok(false);
    }
    fs::create_dir_all(out)?;
    let holding = glazier.join("holding");
    if holding.is_dir() {
        copy_tree(&holding, &out.join("holding"), progress).context("copying the held files")?;
    }
    let connection =
        sqlite::open_copy(&catalog, &out.join(CATALOG), progress).context("copying the catalog")?;
    let version = sqlite::user_version(&connection)?;
    if version > TIDY_USER_VERSION {
        bail!(
            "Its catalog is newer than this Oriel RS reads (version {version}, against \
             {TIDY_USER_VERSION}). Update Oriel RS, then import again."
        );
    }
    let left_out = rehome_holding(&connection, source, out, final_tidy, progress)?;

    let roots: Vec<String> = {
        let mut statement = connection.prepare("SELECT path FROM roots ORDER BY id")?;
        let rows = statement.query_map([], |row| row.get(0))?;
        rows.collect::<rusqlite::Result<_>>()?
    };
    let (held_files, held_bytes): (i64, i64) = connection.query_row(
        "SELECT count(*), coalesce(sum(size), 0) FROM holding WHERE state = 'held'",
        [],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;
    let plans: i64 = connection.query_row("SELECT count(*) FROM plans", [], |row| row.get(0))?;
    sqlite::close_copy(connection)?;

    outcome
        .details
        .push(count(roots.len() as u64, "folder", "folders"));
    // The held files that came over; those left out are counted on their own below.
    outcome.details.push(format!(
        "{} ({})",
        count(
            (held_files as u64).saturating_sub(left_out.files),
            "held file",
            "held files"
        ),
        bytes((held_bytes as u64).saturating_sub(left_out.bytes))
    ));
    if plans > 0 {
        outcome.details.push(count(
            plans as u64,
            "change in its history",
            "changes in its history",
        ));
    }
    if left_out.files > 0 {
        outcome.skipped.push(format!(
            "{} on other volumes, which were not there to copy; Tidy lists them as missing",
            count(left_out.files, "held file", "held files")
        ));
    }
    report.folders.extend(roots);
    Ok(true)
}

/// Rewrites the catalog's holding places to Oriel RS's holding, copying in what was held on other
/// volumes, and notes the data folder the catalog now belongs to. Returns the held files left out:
/// gone, or (in a dry run) outside the stand-in home, which a dry run never reads. Their places
/// move into Oriel RS's holding all the same, so no row keeps pointing into Electron Oriel's.
fn rehome_holding(
    connection: &Connection,
    source: &ElectronData,
    out: &Path,
    final_tidy: &Path,
    progress: &Progress,
) -> anyhow::Result<Size> {
    let separator = std::path::MAIN_SEPARATOR;
    let recorded: Option<String> = connection
        .query_row(
            "SELECT value FROM settings WHERE key = 'data_dir'",
            [],
            |row| row.get(0),
        )
        .optional()?;
    let mut homes: Vec<String> = recorded.into_iter().collect();
    homes.push(source.glazier().to_string_lossy().into_owned());
    let new_home = final_tidy.to_string_lossy().into_owned();

    let rows: Vec<(i64, String, Option<String>, String, i64)> = {
        let mut statement = connection.prepare(
            "SELECT id, hold_path, batch_path, state, size FROM holding
              WHERE hold_path IS NOT NULL ORDER BY id",
        )?;
        let rows = statement.query_map([], |row| {
            Ok((
                row.get(0)?,
                row.get(1)?,
                row.get(2)?,
                row.get(3)?,
                row.get(4)?,
            ))
        })?;
        rows.collect::<rusqlite::Result<_>>()?
    };
    let mut left_out = Size::default();
    for (id, hold_path, batch_path, state, size) in rows {
        let place = |path: &str| {
            homes
                .iter()
                .find_map(|home| rehome(path, home, &new_home, separator))
                .map(|moved| (moved, None))
                .or_else(|| {
                    volume_holding_rest(path, separator).map(|rest| {
                        (
                            format!("{new_home}{separator}holding{separator}{rest}"),
                            Some(rest),
                        )
                    })
                })
        };
        let Some((new_hold, on_volume)) = place(&hold_path) else {
            continue;
        };
        // A held file that cannot be copied (its volume is not mounted, or a dry run does not
        // read it) still has its place rewritten into Oriel RS's holding, where no file is: Tidy
        // lists it, and its Restore says the file is missing, as Electron Oriel's does for a held
        // file that went. Left in Electron Oriel's holding, Oriel RS's Restore would move
        // Electron Oriel's own file once the volume came back.
        if let Some(rest) = on_volume
            && state == "held"
        {
            let from = Path::new(&hold_path);
            if source.admits(from) && from.is_file() {
                let to = out.join("holding").join(relative(&rest, separator));
                copy_file(from, &to, progress)
                    .with_context(|| format!("copying the held {}", from.display()))?;
            } else {
                left_out.add(Size {
                    files: 1,
                    bytes: size as u64,
                });
            }
        }
        let new_batch = batch_path
            .as_deref()
            .map(|batch| place(batch).map_or_else(|| batch.to_owned(), |(moved, _)| moved));
        connection.execute(
            "UPDATE holding SET hold_path = ?1, batch_path = ?2 WHERE id = ?3",
            params![new_hold, new_batch, id],
        )?;
    }
    connection.execute(
        "INSERT INTO settings (key, value) VALUES ('data_dir', ?1)
          ON CONFLICT (key) DO UPDATE SET value = excluded.value",
        [new_home],
    )?;
    Ok(left_out)
}

/// `place` moved from under `home` to under `new_home`, as `followDataFolder` moves it, or `None`
/// when it is not under `home`.
fn rehome(place: &str, home: &str, new_home: &str, separator: char) -> Option<String> {
    let rest = place.strip_prefix(home)?.strip_prefix(separator)?;
    Some(format!("{new_home}{separator}{rest}"))
}

/// What follows `.latch-works/glazier/holding/` in a place held at the top of another volume.
fn volume_holding_rest(place: &str, separator: char) -> Option<String> {
    let marker = [".latch-works", "glazier", "holding", ""].join(&separator.to_string());
    let marker = format!("{separator}{marker}");
    let start = place.find(&marker)? + marker.len();
    let rest = &place[start..];
    (!rest.is_empty()).then(|| rest.to_owned())
}

/// A relative path written with `separator`, as this system's path.
fn relative(rest: &str, separator: char) -> PathBuf {
    rest.split(separator)
        .filter(|part| !part.is_empty() && *part != "." && *part != "..")
        .collect()
}

// Sync.

/// Lockstep's settings from before profiles, `~/.latch-works/lockstep.json`, as the one profile
/// Sync makes of them when it has no settings of its own (`migrateLegacyConfig`).
pub(crate) fn legacy_profile(source: &ElectronData) -> Option<Value> {
    let legacy = read_json(source.lockstep_config())?;
    let text = |key: &str| legacy.get(key).and_then(Value::as_str).map(str::to_owned);
    let (api_url, source_root) = (text("apiUrl"), text("source"));
    if api_url.as_deref().is_none_or(str::is_empty)
        && source_root.as_deref().is_none_or(str::is_empty)
    {
        return None;
    }
    let id = uuid::Uuid::new_v4().to_string();
    Some(json!({
        "activeProfileId": id,
        "profiles": [{
            "apiUrl": api_url.unwrap_or_else(|| "http://127.0.0.1:3000".to_owned()),
            "id": id,
            "name": "Default",
            "sourceRoot": source_root.unwrap_or_default(),
        }],
    }))
}

/// Sync's profiles and the key their tokens are sealed with, as they are: Electron Oriel seals
/// tokens with a key file on every system, in the format Oriel RS's `FileSecretStorage` reads.
fn stage_sync(
    source: &ElectronData,
    out: &Path,
    progress: &Progress,
    outcome: &mut AreaReport,
    report: &mut Report,
) -> anyhow::Result<bool> {
    let lockstep = source.lockstep();
    let settings = lockstep.join(SYNC_SETTINGS);
    let state = if settings.is_file() {
        read_json(&settings).context("Sync's profiles do not read")?
    } else if let Some(state) = legacy_profile(source) {
        state
    } else {
        return Ok(false);
    };
    let profiles = state
        .get("profiles")
        .and_then(Value::as_array)
        .context("Sync's profiles do not read")?
        .clone();
    progress.begin("Copying Sync's profiles");
    fs::create_dir_all(out)?;
    restrict(out, 0o700)?;
    if settings.is_file() {
        copy_file(&settings, &out.join(SYNC_SETTINGS), progress)?;
    } else {
        let text = serde_json::to_string_pretty(&state)?;
        fs::write(out.join(SYNC_SETTINGS), format!("{text}\n"))?;
        outcome
            .details
            .push("a profile from Lockstep's lockstep.json".to_owned());
    }
    // A key from before `~/.latch-works` counts when Sync's folder has settings but no key yet,
    // as `fileSecretKeyPath` copies it in.
    let key_file = lockstep.join(SECRET_KEY);
    let key_source = if key_file.is_file() {
        Some(key_file)
    } else {
        let legacy = source.legacy_secret_key();
        (settings.is_file() && legacy.is_file()).then(|| legacy.to_path_buf())
    };
    let key = match &key_source {
        Some(from) => {
            let to = out.join(SECRET_KEY);
            copy_file(from, &to, progress)?;
            restrict(&to, 0o600)?;
            fs::read(&to).ok()
        }
        None => None,
    };
    let mut tokens = Tokens::default();
    for profile in &profiles {
        if let Some(sealed) = profile.get("encryptedToken").and_then(Value::as_str) {
            if key.as_deref().is_some_and(|key| opens(key, sealed)) {
                tokens.migrated += 1;
            } else {
                tokens.failed += 1;
            }
        }
        if let Some(root) = profile
            .get("sourceRoot")
            .and_then(Value::as_str)
            .filter(|root| !root.is_empty())
        {
            report.folders.push(root.to_owned());
        }
    }
    outcome
        .details
        .push(count(profiles.len() as u64, "profile", "profiles"));
    if tokens.migrated > 0 {
        outcome
            .details
            .push(count(tokens.migrated, "saved token", "saved tokens"));
    }
    if tokens.failed > 0 {
        outcome.skipped.push(format!(
            "{} it could not read, which Sync asks for again",
            count(tokens.failed, "saved token", "saved tokens")
        ));
    }
    report.tokens = tokens;
    Ok(true)
}

/// Whether `key` opens a token sealed as `FileSecretStorage` seals it: base64 of
/// `iv | tag | ciphertext`, AES-256-GCM.
fn opens(key: &[u8], sealed: &str) -> bool {
    use aes_gcm::aead::AeadInPlace as _;
    use aes_gcm::{Aes256Gcm, KeyInit as _, Nonce, Tag};
    let Ok(sealed) = base64::engine::general_purpose::STANDARD.decode(sealed) else {
        return false;
    };
    let (Ok(cipher), true) = (Aes256Gcm::new_from_slice(key), sealed.len() >= 28) else {
        return false;
    };
    let (iv, rest) = sealed.split_at(12);
    let (tag, data) = rest.split_at(16);
    let mut data = data.to_vec();
    cipher
        .decrypt_in_place_detached(Nonce::from_slice(iv), b"", &mut data, Tag::from_slice(tag))
        .is_ok()
}

#[cfg(unix)]
fn restrict(path: &Path, mode: u32) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt as _;
    fs::set_permissions(path, fs::Permissions::from_mode(mode))
}

#[cfg(not(unix))]
fn restrict(_: &Path, _: u32) -> std::io::Result<()> {
    Ok(())
}

// The hash cache.

/// Sync's hash cache, as it is: its files are keyed by each source folder's path, which the
/// archive keeps, so pushes and plans start warm.
fn stage_hash_cache(
    source: &ElectronData,
    out: &Path,
    progress: &Progress,
    outcome: &mut AreaReport,
) -> anyhow::Result<bool> {
    let cache = source.hash_cache();
    if tree_size(cache).files == 0 {
        return Ok(false);
    }
    progress.begin("Copying Sync's hash cache");
    let size = copy_tree(cache, out, progress).context("copying the hash cache")?;
    outcome.details.push(format!(
        "{} ({})",
        count(size.files, "folder's hashes", "folders' hashes"),
        bytes(size.bytes)
    ));
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn holding_places_move_to_oriel_rs_on_either_system() {
        assert_eq!(
            rehome(
                "/Users/o/.latch-works/glazier/holding/1-Photos/b/x.jpg",
                "/Users/o/.latch-works/glazier",
                "/Users/o/.latch-works/oriel-rs/tidy",
                '/'
            )
            .as_deref(),
            Some("/Users/o/.latch-works/oriel-rs/tidy/holding/1-Photos/b/x.jpg")
        );
        assert_eq!(
            rehome(
                r"C:\Users\o\.latch-works\glazier\holding\1-Photos\b\x.jpg",
                r"C:\Users\o\.latch-works\glazier",
                r"C:\Users\o\.latch-works\oriel-rs\tidy",
                '\\'
            )
            .as_deref(),
            Some(r"C:\Users\o\.latch-works\oriel-rs\tidy\holding\1-Photos\b\x.jpg")
        );
        // A folder that only begins with the same name is not inside it.
        assert_eq!(
            rehome("/a/glazier2/holding/x", "/a/glazier", "/b", '/'),
            None
        );
    }

    #[test]
    fn a_place_held_on_another_volume_is_found_on_either_system() {
        assert_eq!(
            volume_holding_rest(
                "/Volumes/Photos/.latch-works/glazier/holding/3-Trips/b/x.jpg",
                '/'
            )
            .as_deref(),
            Some("3-Trips/b/x.jpg")
        );
        assert_eq!(
            volume_holding_rest(r"D:\.latch-works\glazier\holding\3-Trips\b\x.jpg", '\\')
                .as_deref(),
            Some(r"3-Trips\b\x.jpg")
        );
        assert_eq!(
            volume_holding_rest("/Volumes/Photos/archive/x.jpg", '/'),
            None
        );
        assert_eq!(
            relative(r"3-Trips\b\..\x.jpg", '\\'),
            ["3-Trips", "b", "x.jpg"].iter().collect::<PathBuf>()
        );
    }

    #[test]
    fn a_list_of_names_reads_as_a_sentence() {
        assert_eq!(and_list(&["Electron Oriel"]), "Electron Oriel");
        assert_eq!(
            and_list(&["Electron Oriel", "Glazier", "Lockstep"]),
            "Electron Oriel, Glazier and Lockstep"
        );
    }
}
