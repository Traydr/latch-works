//! Holding, from glazier-core's `plans/holding.ts`: where files a change takes out of a root wait
//! until the owner empties them into the Trash, and how they come back.
//!
//! Holding is always outside the root, so nothing that syncs or indexes the root (Sync, View, a
//! cloud drive) sees what is held. It is Tidy's data folder (`tidy/holding/<id>-<name>`), and
//! holding a file there is a rename when the root shares the data folder's volume. glazier-core
//! holds a root on another volume at the top of that volume instead
//! (`<volume>/.latch-works/glazier/holding`), and so does Oriel, in `oriel` rather than
//! Electron Oriel's `glazier` ([`HoldingPlaces`]). A sandboxed run (`ORIEL_DATA_DIR` set)
//! writes nothing outside its data folder and its roots, so there such a root holds in the data
//! folder, by copying across and checking the copy.

use std::collections::HashMap;
use std::fs;
use std::io;
use std::path::{Component, Path, PathBuf};
use std::sync::{Mutex, PoisonError};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

#[cfg(target_os = "macos")]
use anyhow::Context as _;
use anyhow::bail;
use oriel_runtime::fs_meta::MetadataExt as _;
use rusqlite::{Connection, OptionalExtension as _, params};

use crate::catalog::rows::to_absolute_path;
use crate::catalog::{Catalog, now_ms};
use crate::contract::{HoldingId, HoldingItem, HoldingList, HoldingRequest, PlanId, RootId};

/// A root's own folder inside holding: `12-Photos`, readable when someone looks. Runs of
/// characters that are not letters, digits, spaces, dots, underscores or hyphens become one `_`.
/// (`char::is_alphabetic` stands in for the TypeScript's `\p{L}`; it also admits the few
/// combining marks Unicode counts as alphabetic.)
pub fn root_folder_name(root_id: RootId, root_path: &str) -> String {
    let base = Path::new(root_path)
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    let mut name = String::with_capacity(base.len());
    let mut replacing = false;
    for character in base.chars() {
        let kept = character.is_alphabetic()
            || character.is_numeric()
            || matches!(character, ' ' | '.' | '_' | '-');
        if kept {
            name.push(character);
            replacing = false;
        } else if !replacing {
            name.push('_');
            replacing = true;
        }
    }
    if name.is_empty() {
        name.push_str("root");
    }
    format!("{root_id}-{name}")
}

/// Where each root's held files go, chosen once per root (glazier-core's `HoldingPlaces`):
/// `<data>/holding/<id>-<name>` when the root shares the data folder's volume, so holding is a
/// rename. With [`Self::on_volumes`], a root on another volume holds at the top of that volume,
/// in `.latch-works/oriel/holding/<id>-<name>`, still a rename; glazier-core's folder there is
/// `glazier`, which Oriel leaves alone. A root that is a whole volume, or a volume
/// that takes no folder, holds in the data folder by copying across.
#[derive(Debug)]
pub struct HoldingPlaces {
    data_dir: PathBuf,
    on_volumes: bool,
    folders: Mutex<HashMap<RootId, PathBuf>>,
}

impl HoldingPlaces {
    pub fn new(data_dir: impl Into<PathBuf>) -> Self {
        Self {
            data_dir: data_dir.into(),
            on_volumes: false,
            folders: Mutex::new(HashMap::new()),
        }
    }

    /// Holds a root on another volume on that volume. Off in a sandboxed run, which writes
    /// nothing outside its data folder and its roots.
    pub fn on_volumes(mut self, on_volumes: bool) -> Self {
        self.on_volumes = on_volumes;
        self
    }

    pub fn data_dir(&self) -> &Path {
        &self.data_dir
    }

    /// The holding folder of a root, once the data folder exists.
    pub fn folder_for(&self, root_id: RootId, root_path: &str) -> io::Result<PathBuf> {
        let mut folders = self.folders.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some(folder) = folders.get(&root_id) {
            return Ok(folder.clone());
        }
        fs::create_dir_all(&self.data_dir)?;
        let name = root_folder_name(root_id, root_path);
        let folder = self
            .on_volume(Path::new(root_path), &name)
            .unwrap_or_else(|| self.data_dir.join("holding").join(&name));
        folders.insert(root_id, folder.clone());
        Ok(folder)
    }

    /// The holding folder at the top of the root's own volume, when the root is on another
    /// volume than the data folder and is not that whole volume. On Windows a volume is told by
    /// its serial number, Node's `dev` there, so a root on `D:\Photos` holds in
    /// `D:\.latch-works\oriel\holding`, as glazier-core holds in `D:\.latch-works\glazier`.
    fn on_volume(&self, root: &Path, name: &str) -> Option<PathBuf> {
        if !self.on_volumes {
            return None;
        }
        let device = volume_of(root)?;
        if volume_of(&self.data_dir)? == device {
            return None;
        }
        let mount_point = mount_point_of(root, device);
        if mount_point == root {
            return None;
        }
        let folder = mount_point
            .join(oriel_core_domain::LATCH_WORKS_DIRECTORY_NAME)
            .join("oriel")
            .join("holding")
            .join(name);
        fs::create_dir_all(&folder).ok()?;
        Some(folder)
    }

    /// Whether `path` lies inside a holding folder of the kind this run hands out, the only
    /// places Restore, Undo and Empty Holding move or trash from: `<data>/holding`, or, holding on
    /// volumes, `.latch-works/oriel/holding` at the top of a volume other than the data
    /// folder's. Anything else, Electron Oriel's `glazier` holding above all, is refused, so a
    /// catalog row that points elsewhere (an old catalog's, an edited one) never moves another
    /// app's files. A place that climbs out (`..`), or whose folders lead elsewhere through a
    /// link, is refused too.
    pub fn holds(&self, path: &Path) -> bool {
        if !path.is_absolute()
            || path
                .components()
                .any(|part| matches!(part, Component::ParentDir | Component::CurDir))
        {
            return false;
        }
        let own = self.data_dir.join("holding");
        if path.starts_with(&own) {
            return path != own && resolves_inside(path, &own);
        }
        if !self.on_volumes {
            return false;
        }
        let Some(top) = volume_holding_top(path) else {
            return false;
        };
        let holding = top
            .join(oriel_core_domain::LATCH_WORKS_DIRECTORY_NAME)
            .join("oriel")
            .join("holding");
        let Some(device) = volume_of(top) else {
            return false;
        };
        path != holding
            && volume_of(&self.data_dir) != Some(device)
            && mount_point_of(top, device) == top
            && resolves_inside(path, &holding)
    }

    /// The folder a root's held files go to if it has been chosen already this run.
    pub fn known_folder(&self, root_id: RootId) -> Option<PathBuf> {
        self.folders
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .get(&root_id)
            .cloned()
    }
}

/// The folder at whose top `path`'s `.latch-works/oriel/holding` sits, the highest one when
/// there are several.
fn volume_holding_top(path: &Path) -> Option<&Path> {
    path.ancestors()
        .filter(|folder| {
            let names: Vec<_> = folder
                .components()
                .rev()
                .take(3)
                .map(Component::as_os_str)
                .collect();
            names.len() == 3
                && names[0] == "holding"
                && names[1] == "oriel"
                && names[2] == oriel_core_domain::LATCH_WORKS_DIRECTORY_NAME
        })
        .last()
        .and_then(|holding| holding.parent()?.parent()?.parent())
}

/// Whether `path`, once the links in its folders are followed, is still inside `folder`. Its
/// last part is not followed: a held link moves or goes to the Trash as the link it is. A place
/// whose folder is not there has nothing to move, so it passes.
fn resolves_inside(path: &Path, folder: &Path) -> bool {
    let (Some(parent), Some(name)) = (path.parent(), path.file_name()) else {
        return false;
    };
    let Ok(parent) = fs::canonicalize(parent) else {
        return true;
    };
    let folder = fs::canonicalize(folder).unwrap_or_else(|_| folder.to_path_buf());
    let resolved = parent.join(name);
    resolved.starts_with(&folder) && resolved != folder
}

/// The device `path` is on, as `fs.stat`'s `dev` gives it.
#[cfg(unix)]
fn volume_of(path: &Path) -> Option<u64> {
    fs::metadata(path).map(|meta| meta.dev()).ok()
}

/// The serial number of the volume `path` is on, libuv's `dev` on Windows; `None` for a path
/// that cannot be opened.
#[cfg(windows)]
fn volume_of(path: &Path) -> Option<u64> {
    let metadata = fs::metadata(path).ok()?;
    let (serial, _) = oriel_runtime::fs_meta::dev_ino(path, &metadata);
    (serial != 0).then_some(serial)
}

/// The folder `path`'s volume is mounted at: its highest ancestor still on `device`
/// (`mountPointOf`). On Windows that is the drive's top, `D:\`, or the folder a volume is
/// mounted in.
fn mount_point_of(path: &Path, device: u64) -> PathBuf {
    let mut current = path.to_path_buf();
    while let Some(parent) = current.parent() {
        if volume_of(parent) != Some(device) {
            break;
        }
        current = parent.to_path_buf();
    }
    current
}

/// Local time's fields, from the C library, as JavaScript's `Date` getters read them.
#[cfg(unix)]
fn local_time(at: SystemTime) -> (i32, i32, i32, i32, i32, i32) {
    let seconds = at
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_secs()) as libc::time_t;
    // SAFETY: `tm` is plain data; `localtime_r` fills it from `seconds` and is thread-safe.
    let mut tm: libc::tm = unsafe { std::mem::zeroed() };
    // SAFETY: both pointers are valid for the call.
    let filled = unsafe { !libc::localtime_r(&seconds, &mut tm).is_null() };
    if !filled {
        return (1970, 1, 1, 0, 0, 0);
    }
    (
        tm.tm_year + 1900,
        tm.tm_mon + 1,
        tm.tm_mday,
        tm.tm_hour,
        tm.tm_min,
        tm.tm_sec,
    )
}

/// Local time's fields on Windows, in the zone and with the daylight saving rules Windows' clock
/// shows, as JavaScript's `Date` getters read them there. The C library's `localtime_s` would
/// read a `TZ` variable as POSIX spells it, which Node does not.
#[cfg(windows)]
fn local_time(at: SystemTime) -> (i32, i32, i32, i32, i32, i32) {
    use windows_sys::Win32::Foundation::{FILETIME, SYSTEMTIME};
    use windows_sys::Win32::System::Time::{
        DYNAMIC_TIME_ZONE_INFORMATION, FileTimeToSystemTime, GetDynamicTimeZoneInformation,
        SystemTimeToTzSpecificLocalTimeEx,
    };

    /// 100-nanosecond intervals from 1601 to 1970.
    const EPOCH_DIFFERENCE: u64 = 116_444_736_000_000_000;
    let ticks = at
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_secs() * 10_000_000)
        + EPOCH_DIFFERENCE;
    let file_time = FILETIME {
        dwLowDateTime: ticks as u32,
        dwHighDateTime: (ticks >> 32) as u32,
    };
    // SAFETY: plain data, filled by the calls on success.
    let (mut utc, mut local): (SYSTEMTIME, SYSTEMTIME) = unsafe { std::mem::zeroed() };
    // SAFETY: plain data, filled by the call.
    let mut zone: DYNAMIC_TIME_ZONE_INFORMATION = unsafe { std::mem::zeroed() };
    // SAFETY: every pointer is valid for its call.
    let filled = unsafe {
        GetDynamicTimeZoneInformation(&raw mut zone) != u32::MAX
            && FileTimeToSystemTime(&raw const file_time, &raw mut utc) != 0
            && SystemTimeToTzSpecificLocalTimeEx(&raw const zone, &raw const utc, &raw mut local)
                != 0
    };
    if !filled {
        return (1970, 1, 1, 0, 0, 0);
    }
    (
        i32::from(local.wYear),
        i32::from(local.wMonth),
        i32::from(local.wDay),
        i32::from(local.wHour),
        i32::from(local.wMinute),
        i32::from(local.wSecond),
    )
}

/// One folder per plan run, named so the newest sort last: `2026-10-24_093012-plan-12`, in local
/// time.
pub fn holding_batch_name(plan_id: Option<PlanId>, now: SystemTime) -> String {
    let (year, month, day, hour, minute, second) = local_time(now);
    let stamp = format!("{year}-{month:02}-{day:02}_{hour:02}{minute:02}{second:02}");
    match plan_id {
        Some(plan_id) => format!("{stamp}-plan-{plan_id}"),
        None => format!("{stamp}-manual"),
    }
}

/// `SystemTime` of a file time in whole milliseconds, as Node's `utimes` with a `Date` sets it.
fn whole_ms_time(time: SystemTime) -> SystemTime {
    let since = time.duration_since(UNIX_EPOCH).unwrap_or_default();
    UNIX_EPOCH + Duration::from_millis(since.as_millis() as u64)
}

/// Gives `path` the access and modification times of `like`, in whole milliseconds, as
/// glazier-core's `utimes(path, stats.atime, stats.mtime)` does.
pub fn copy_times(path: &Path, like: &fs::Metadata) -> io::Result<()> {
    let times = fs::FileTimes::new()
        .set_accessed(whole_ms_time(like.accessed()?))
        .set_modified(whole_ms_time(like.modified()?));
    fs::File::options().write(true).open(path)?.set_times(times)
}

/// Moves a file, by rename when source and target share a volume and otherwise by copying,
/// checking the copy's size, giving it the original's times and deleting the original.
pub fn move_file(source: &Path, target: &Path) -> io::Result<()> {
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent)?;
    }
    match fs::rename(source, target) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::CrossesDevices => {
            let before = fs::metadata(source)?;
            fs::copy(source, target)?;
            if fs::metadata(target)?.len() != before.len() {
                let _ = fs::remove_file(target);
                return Err(io::Error::other(format!(
                    "The copy of {} came out a different size.",
                    source.display()
                )));
            }
            let finished = copy_times(target, &before).and_then(|()| fs::remove_file(source));
            // Windows will not delete a file another program has open, though it copies it: the
            // copy comes back out, so the move leaves things as they were and the error says
            // why (plan 062). Elsewhere an open file deletes.
            #[cfg(windows)]
            if finished.is_err() {
                let _ = fs::remove_file(target);
            }
            finished
        }
        Err(error) => Err(error),
    }
}

/// Whether anything (a file, a folder, a broken link) sits at `target`.
pub fn path_exists(target: &Path) -> bool {
    fs::symlink_metadata(target).is_ok()
}

/// A free name for `target`: itself, or `name (2).ext`, `name (3).ext`, … beside it.
pub fn free_path(target: &Path) -> PathBuf {
    if !path_exists(target) {
        return target.to_path_buf();
    }
    let parent = target.parent().unwrap_or(Path::new(""));
    let stem = target
        .file_stem()
        .map(|stem| stem.to_string_lossy().into_owned())
        .unwrap_or_default();
    let extension = target
        .extension()
        .map(|extension| format!(".{}", extension.to_string_lossy()))
        .unwrap_or_default();
    (2..)
        .map(|suffix| parent.join(format!("{stem} ({suffix}){extension}")))
        .find(|candidate| !path_exists(candidate))
        .expect("some suffix is free")
}

/// A path relative to `base`, with forward slashes.
fn relative_slashes(base: &Path, path: &Path) -> String {
    path.strip_prefix(base)
        .unwrap_or(path)
        .components()
        .map(|part| part.as_os_str().to_string_lossy().into_owned())
        .collect::<Vec<_>>()
        .join("/")
}

/// What to hold, from which root, and why.
#[derive(Clone, Debug)]
pub struct HoldRequest<'a> {
    pub root_id: RootId,
    pub root_path: &'a str,
    pub rel_path: &'a str,
    pub batch: &'a str,
    pub plan_id: Option<PlanId>,
    pub reason: &'a str,
}

/// The catalog and the places holding writes to.
#[derive(Clone, Copy)]
pub struct HoldingStore<'a> {
    pub catalog: &'a Catalog,
    pub places: &'a HoldingPlaces,
}

/// Moves a file into its root's holding folder, keeping its path inside the batch, and records
/// where it went. Called from a worker thread.
pub fn hold_file(store: HoldingStore<'_>, request: &HoldRequest<'_>) -> anyhow::Result<HoldingId> {
    let source = to_absolute_path(request.root_path, request.rel_path);
    let size = fs::metadata(&source)?.size() as i64;
    let folder = store
        .places
        .folder_for(request.root_id, request.root_path)?;
    let batch_path = folder.join(request.batch);
    let target = free_path(&to_absolute_path(
        &batch_path.to_string_lossy(),
        request.rel_path,
    ));
    move_file(&source, &target)?;

    let row = (
        request.root_id,
        request.rel_path.to_owned(),
        relative_slashes(&folder, &target),
        target.to_string_lossy().into_owned(),
        request.batch.to_owned(),
        batch_path.to_string_lossy().into_owned(),
        size,
        request.plan_id,
        request.reason.to_owned(),
    );
    store.catalog.blocking(move |connection| {
        connection.execute(
            "INSERT INTO holding (root_id, original_rel, hold_rel, hold_path, batch, batch_path,
          size, held_at, plan_id, reason)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![
                row.0,
                row.1,
                row.2,
                row.3,
                row.4,
                row.5,
                row.6,
                now_ms(),
                row.7,
                row.8
            ],
        )?;
        Ok(connection.last_insert_rowid())
    })
}

/// A holding row with its root's path.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HoldingRecord {
    pub id: HoldingId,
    pub root_id: RootId,
    pub root_path: String,
    pub original_rel: String,
    pub hold_path: String,
    pub batch: String,
    pub batch_path: String,
    pub size: i64,
    pub held_at: i64,
    pub plan_id: Option<PlanId>,
    pub reason: String,
    pub state: String,
}

const HOLDING_COLUMNS: &str = "h.id, h.root_id, r.path AS root_path, h.original_rel, \
  h.hold_path, h.batch, h.batch_path, h.size, h.held_at, h.plan_id, h.reason, h.state";

fn holding_record(row: &rusqlite::Row<'_>) -> rusqlite::Result<HoldingRecord> {
    Ok(HoldingRecord {
        id: row.get(0)?,
        root_id: row.get(1)?,
        root_path: row.get(2)?,
        original_rel: row.get(3)?,
        hold_path: row.get(4)?,
        batch: row.get(5)?,
        batch_path: row.get(6)?,
        size: row.get(7)?,
        held_at: row.get(8)?,
        plan_id: row.get(9)?,
        reason: row.get(10)?,
        state: row.get(11)?,
    })
}

impl HoldingRecord {
    pub fn to_item(&self) -> HoldingItem {
        HoldingItem {
            id: self.id,
            root_id: self.root_id,
            original_path: to_absolute_path(&self.root_path, &self.original_rel)
                .to_string_lossy()
                .into_owned(),
            hold_path: self.hold_path.clone(),
            size: self.size,
            held_at: self.held_at,
            plan_id: self.plan_id,
            reason: self.reason.clone(),
        }
    }
}

/// A root's held files, newest first, with their count and bytes.
pub fn list_holding(
    connection: &Connection,
    request: &HoldingRequest,
) -> anyhow::Result<HoldingList> {
    let (total, bytes): (i64, Option<i64>) = connection.query_row(
        "SELECT COUNT(*) AS total, SUM(size) AS bytes FROM holding
      WHERE root_id = ?1 AND state = 'held'",
        [request.root_id],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;
    let mut statement = connection.prepare_cached(&format!(
        "SELECT {HOLDING_COLUMNS} FROM holding h JOIN roots r ON r.id = h.root_id
      WHERE h.root_id = ?1 AND h.state = 'held'
      ORDER BY h.held_at DESC, h.id DESC LIMIT ?2 OFFSET ?3"
    ))?;
    let items = statement
        .query_map(
            params![request.root_id, request.limit, request.offset],
            holding_record,
        )?
        .map(|record| record.map(|record| record.to_item()))
        .collect::<rusqlite::Result<_>>()?;
    Ok(HoldingList {
        total_bytes: bytes.unwrap_or(0),
        total,
        items,
    })
}

pub fn holding_record_by_id(
    connection: &Connection,
    id: HoldingId,
) -> anyhow::Result<Option<HoldingRecord>> {
    Ok(connection
        .query_row(
            &format!(
                "SELECT {HOLDING_COLUMNS} FROM holding h JOIN roots r ON r.id = h.root_id
          WHERE h.id = ?1"
            ),
            [id],
            holding_record,
        )
        .optional()?)
}

/// A restore that would overwrite whatever now sits at the original path.
#[derive(Debug)]
pub struct RestoreConflict(pub String);

impl std::fmt::Display for RestoreConflict {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for RestoreConflict {}

/// Moves a held file back to where it came from. Refuses when something now sits at the
/// original path, so a restore never overwrites, and when the file is not in one of Tidy's own
/// holding folders ([`HoldingPlaces::holds`]). Called from a worker thread.
pub fn restore_held(store: HoldingStore<'_>, id: HoldingId) -> anyhow::Result<HoldingRecord> {
    let record = restorable(store, id)?;
    let original = to_absolute_path(&record.root_path, &record.original_rel);
    if path_exists(&original) {
        bail!(RestoreConflict(format!(
            "Something already exists at {}.",
            record.original_rel
        )));
    }
    move_file(Path::new(&record.hold_path), &original)?;
    store.catalog.blocking(move |connection| {
        connection.execute("UPDATE holding SET state = 'restored' WHERE id = ?1", [id])?;
        Ok(())
    })?;
    Ok(record)
}

/// The held row `id`, when its file can come back: still held, in one of Tidy's own holding
/// folders, and there. An undo checks it before it changes anything else.
pub fn restorable(store: HoldingStore<'_>, id: HoldingId) -> anyhow::Result<HoldingRecord> {
    let record = store
        .catalog
        .blocking(move |connection| holding_record_by_id(connection, id))?;
    let Some(record) = record.filter(|record| record.state == "held") else {
        bail!("That item is no longer in holding.");
    };
    if !store.places.holds(Path::new(&record.hold_path)) {
        bail!(
            "{} is not in Oriel's holding, so Tidy leaves it where it is.",
            record.hold_path
        );
    }
    // A row whose file stayed on a volume that was not there, or a file someone took out of
    // holding by hand.
    if !path_exists(Path::new(&record.hold_path)) {
        bail!("{} is missing from holding.", record.original_rel);
    }
    Ok(record)
}

/// The holding batch folders of a root that still hold something, as absolute paths.
pub fn held_batch_paths(connection: &Connection, root_id: RootId) -> anyhow::Result<Vec<String>> {
    let mut statement = connection.prepare_cached(
        "SELECT DISTINCT batch_path FROM holding WHERE root_id = ?1 AND state = 'held'
      ORDER BY batch_path",
    )?;
    let rows = statement.query_map([root_id], |row| row.get(0))?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

/// Records that whole batch folders went to the Trash: everything still marked held in them is
/// gone (restored items had already left). Only folders this catalog handed out count, and the
/// root's holding folder goes once its last batch has, when it is one of Tidy's own. Called from
/// a worker thread.
pub fn mark_batches_emptied(
    store: HoldingStore<'_>,
    root_id: RootId,
    batch_paths: &[String],
) -> anyhow::Result<i64> {
    let mut emptied = 0;
    for batch_path in batch_paths {
        let batch = batch_path.clone();
        emptied += store.catalog.blocking(move |connection| {
            Ok(connection.execute(
                "UPDATE holding SET state = 'emptied'
          WHERE root_id = ?1 AND batch_path = ?2 AND state = 'held'",
                params![root_id, batch],
            )? as i64)
        })?;
        if let Some(folder) = Path::new(batch_path).parent()
            && store.places.holds(folder)
        {
            let _ = fs::remove_dir(folder);
        }
    }
    Ok(emptied)
}

/// Keeps held files findable when the data folder moves, since the catalog records each one's
/// absolute place: the catalog notes the folder it was opened from, and opened from another one
/// it rewrites every place under the old folder to the same place under the new.
pub fn follow_data_folder(connection: &Connection, data_dir: &Path) -> anyhow::Result<()> {
    let current = data_dir.to_string_lossy().into_owned();
    let recorded: Option<String> = connection
        .query_row(
            "SELECT value FROM settings WHERE key = 'data_dir'",
            [],
            |row| row.get(0),
        )
        .optional()?;
    if let Some(recorded) = recorded.filter(|recorded| *recorded != current) {
        let prefix = format!("{recorded}{}", std::path::MAIN_SEPARATOR);
        let moved = |place: &str| match place.strip_prefix(&prefix) {
            Some(rest) => Path::new(&current)
                .join(rest)
                .to_string_lossy()
                .into_owned(),
            None => place.to_owned(),
        };
        let placed: Vec<(i64, String, Option<String>)> = {
            let mut statement = connection.prepare(
                "SELECT id, hold_path, batch_path FROM holding WHERE hold_path IS NOT NULL",
            )?;
            let rows =
                statement.query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?;
            rows.collect::<rusqlite::Result<_>>()?
        };
        for (id, hold_path, batch_path) in placed {
            connection.execute(
                "UPDATE holding SET hold_path = ?1, batch_path = ?2 WHERE id = ?3",
                params![moved(&hold_path), batch_path.as_deref().map(moved), id],
            )?;
        }
    }
    connection.execute(
        "INSERT INTO settings (key, value) VALUES ('data_dir', ?1)
      ON CONFLICT (key) DO UPDATE SET value = excluded.value",
        [current],
    )?;
    Ok(())
}

/// Moves a file or folder to the Trash through `NSFileManager`, as Electron's `shell.trashItem`
/// does on macOS. Emptying holding goes through here, so the owner can still take a batch back
/// out of the Trash.
#[cfg(target_os = "macos")]
pub fn move_to_trash(path: &Path) -> anyhow::Result<()> {
    use objc2_foundation::{NSFileManager, NSString, NSURL};

    let text = path
        .to_str()
        .with_context(|| format!("{} is not a Unicode path", path.display()))?;
    let url = NSURL::fileURLWithPath(&NSString::from_str(text));
    let manager = NSFileManager::defaultManager();
    manager
        .trashItemAtURL_resultingItemURL_error(&url, None)
        .map_err(|error| anyhow::anyhow!("{}", error.localizedDescription()))
}

/// Moves a file or folder to the Recycle Bin through the shell's `IFileOperation`, as Electron's
/// `shell.trashItem` does on Windows, with Chromium's flags: no dialogs, an undo record, and the
/// Recycle Bin rather than a delete. An item the Recycle Bin cannot take (too large for it, or on
/// a drive without one) stops the operation rather than being deleted outright, as Chromium's
/// progress sink stops it, so emptying holding never deletes what the owner cannot take back.
#[cfg(windows)]
pub fn move_to_trash(path: &Path) -> anyhow::Result<()> {
    let owned = path.to_path_buf();
    // `IFileOperation` runs only in a single-threaded apartment, so it gets a thread of its own
    // whatever apartment the caller's thread is in.
    std::thread::Builder::new()
        .name("tidy recycle".into())
        .spawn(move || recycle::move_to_recycle_bin(&owned))?
        .join()
        .map_err(|_| anyhow::anyhow!("Moving {} to the Recycle Bin failed.", path.display()))?
        .map_err(|error| {
            anyhow::anyhow!(
                "Moving {} to the Recycle Bin failed: {error}",
                path.display()
            )
        })
}

#[cfg(not(any(target_os = "macos", windows)))]
pub fn move_to_trash(path: &Path) -> anyhow::Result<()> {
    bail!(
        "Moving {} to the Trash is not ported to this platform yet.",
        path.display()
    )
}

/// The Recycle Bin, as Chromium's `platform_util::MoveItemToTrash` reaches it.
#[cfg(windows)]
mod recycle {
    use std::path::Path;

    use windows::Win32::Foundation::E_ABORT;
    use windows::Win32::System::Com::{
        CLSCTX_ALL, COINIT_APARTMENTTHREADED, COINIT_DISABLE_OLE1DDE, CoCreateInstance,
        CoInitializeEx, CoUninitialize,
    };
    use windows::Win32::UI::Shell::{
        FOF_NO_UI, FOF_NOERRORUI, FOF_SILENT, FOFX_ADDUNDORECORD, FOFX_RECYCLEONDELETE,
        FOFX_SHOWELEVATIONPROMPT, FileOperation, IFileOperation, IFileOperationProgressSink,
        IFileOperationProgressSink_Impl, IShellItem, SHCreateItemFromParsingName,
        TSF_DELETE_RECYCLE_IF_POSSIBLE,
    };
    use windows::core::{HRESULT, HSTRING, PCWSTR, Ref, implement};

    /// Stops a delete the shell would not send to the Recycle Bin: it leaves
    /// `TSF_DELETE_RECYCLE_IF_POSSIBLE` off for an item it would delete outright.
    #[implement(IFileOperationProgressSink)]
    struct RecycleOnly;

    impl IFileOperationProgressSink_Impl for RecycleOnly_Impl {
        fn PreDeleteItem(&self, flags: u32, _item: Ref<IShellItem>) -> windows::core::Result<()> {
            if flags & TSF_DELETE_RECYCLE_IF_POSSIBLE.0 as u32 == 0 {
                return Err(E_ABORT.into());
            }
            Ok(())
        }

        fn StartOperations(&self) -> windows::core::Result<()> {
            Ok(())
        }

        fn FinishOperations(&self, _result: HRESULT) -> windows::core::Result<()> {
            Ok(())
        }

        fn PreRenameItem(
            &self,
            _flags: u32,
            _item: Ref<IShellItem>,
            _name: &PCWSTR,
        ) -> windows::core::Result<()> {
            Ok(())
        }

        fn PostRenameItem(
            &self,
            _flags: u32,
            _item: Ref<IShellItem>,
            _name: &PCWSTR,
            _result: HRESULT,
            _created: Ref<IShellItem>,
        ) -> windows::core::Result<()> {
            Ok(())
        }

        fn PreMoveItem(
            &self,
            _flags: u32,
            _item: Ref<IShellItem>,
            _folder: Ref<IShellItem>,
            _name: &PCWSTR,
        ) -> windows::core::Result<()> {
            Ok(())
        }

        fn PostMoveItem(
            &self,
            _flags: u32,
            _item: Ref<IShellItem>,
            _folder: Ref<IShellItem>,
            _name: &PCWSTR,
            _result: HRESULT,
            _created: Ref<IShellItem>,
        ) -> windows::core::Result<()> {
            Ok(())
        }

        fn PreCopyItem(
            &self,
            _flags: u32,
            _item: Ref<IShellItem>,
            _folder: Ref<IShellItem>,
            _name: &PCWSTR,
        ) -> windows::core::Result<()> {
            Ok(())
        }

        fn PostCopyItem(
            &self,
            _flags: u32,
            _item: Ref<IShellItem>,
            _folder: Ref<IShellItem>,
            _name: &PCWSTR,
            _result: HRESULT,
            _created: Ref<IShellItem>,
        ) -> windows::core::Result<()> {
            Ok(())
        }

        fn PostDeleteItem(
            &self,
            _flags: u32,
            _item: Ref<IShellItem>,
            _result: HRESULT,
            _created: Ref<IShellItem>,
        ) -> windows::core::Result<()> {
            Ok(())
        }

        fn PreNewItem(
            &self,
            _flags: u32,
            _folder: Ref<IShellItem>,
            _name: &PCWSTR,
        ) -> windows::core::Result<()> {
            Ok(())
        }

        fn PostNewItem(
            &self,
            _flags: u32,
            _folder: Ref<IShellItem>,
            _name: &PCWSTR,
            _template: &PCWSTR,
            _attributes: u32,
            _result: HRESULT,
            _item: Ref<IShellItem>,
        ) -> windows::core::Result<()> {
            Ok(())
        }

        fn UpdateProgress(&self, _total: u32, _done: u32) -> windows::core::Result<()> {
            Ok(())
        }

        fn ResetTimer(&self) -> windows::core::Result<()> {
            Ok(())
        }

        fn PauseTimer(&self) -> windows::core::Result<()> {
            Ok(())
        }

        fn ResumeTimer(&self) -> windows::core::Result<()> {
            Ok(())
        }
    }

    /// Recycles `path` on the calling thread, which this makes a single-threaded apartment.
    pub(super) fn move_to_recycle_bin(path: &Path) -> anyhow::Result<()> {
        // SAFETY: the thread's first COM call; balanced by `CoUninitialize` below.
        unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE) }.ok()?;
        let result = recycle(path);
        // SAFETY: balances the successful `CoInitializeEx`, after every COM object is released.
        unsafe { CoUninitialize() };
        result
    }

    fn recycle(path: &Path) -> anyhow::Result<()> {
        // SAFETY: COM is initialised on this thread; each call gets live interfaces.
        unsafe {
            let operation: IFileOperation = CoCreateInstance(&FileOperation, None, CLSCTX_ALL)?;
            operation.SetOperationFlags(
                FOF_NO_UI
                    | FOFX_ADDUNDORECORD
                    | FOF_NOERRORUI
                    | FOF_SILENT
                    | FOFX_SHOWELEVATIONPROMPT
                    | FOFX_RECYCLEONDELETE,
            )?;
            let item: IShellItem = SHCreateItemFromParsingName(&HSTRING::from(path), None)?;
            let sink: IFileOperationProgressSink = RecycleOnly.into();
            operation.DeleteItem(&item, &sink)?;
            operation.PerformOperations()?;
            if operation.GetAnyOperationsAborted()?.as_bool() {
                anyhow::bail!("the Recycle Bin could not take it");
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_roots_holding_folder_is_named_after_it() {
        assert_eq!(root_folder_name(12, "/a/Photos"), "12-Photos");
        assert_eq!(root_folder_name(3, "/a/My: Pics?!"), "3-My_ Pics_");
        assert_eq!(root_folder_name(4, "/"), "4-root");
        assert_eq!(root_folder_name(5, "/a/Ünï 2024"), "5-Ünï 2024");
    }

    #[test]
    fn batch_names_sort_by_local_time_and_name_their_plan() {
        let name = holding_batch_name(Some(12), SystemTime::now());
        assert!(name.ends_with("-plan-12"), "{name}");
        assert_eq!(name.len(), "2026-10-24_093012-plan-12".len());
        assert!(holding_batch_name(None, SystemTime::now()).ends_with("-manual"));
    }

    /// The safety rule behind Restore, Undo and Empty Holding: only Oriel's own holding.
    #[cfg(unix)]
    #[test]
    fn only_oriels_holding_folders_are_held_places() {
        let scratch = std::env::temp_dir().join(format!("oriel-holds-{}", std::process::id()));
        let _ = fs::remove_dir_all(&scratch);
        let data_dir = scratch.join("home/.latch-works/oriel/tidy");
        let batch = data_dir.join("holding/1-Photos/2026-10-31_000000-manual");
        fs::create_dir_all(&batch).unwrap();
        let places = HoldingPlaces::new(&data_dir).on_volumes(true);
        assert!(places.holds(&batch));
        assert!(places.holds(&batch.join("a.jpg")));
        assert!(
            !places.holds(&data_dir.join("holding")),
            "the whole holding"
        );
        assert!(!places.holds(&data_dir.join("catalog.sqlite")));
        assert!(!places.holds(&batch.join("../../../catalog.sqlite")));
        assert!(!places.holds(Path::new("holding/1-Photos/b")));
        // Electron Oriel's holding, in its data folder or at the top of a volume.
        let glazier = scratch.join("home/.latch-works/glazier/holding/1-Photos/b");
        fs::create_dir_all(&glazier).unwrap();
        assert!(!places.holds(&glazier));
        assert!(!places.holds(Path::new(
            "/Volumes/Photos/.latch-works/glazier/holding/1-Photos/b"
        )));
        // A folder that is not a volume's top holds nothing, whatever it is called.
        let fake = scratch.join("Volumes/X/.latch-works/oriel/holding/1-Photos/b");
        fs::create_dir_all(&fake).unwrap();
        assert!(!places.holds(&fake));
        // A link inside holding that leads into Electron Oriel's holding.
        std::os::unix::fs::symlink(&glazier, data_dir.join("holding/2-Linked")).unwrap();
        assert!(!places.holds(&data_dir.join("holding/2-Linked/a.jpg")));
        // A sandboxed run holds only in its data folder.
        assert!(HoldingPlaces::new(&data_dir).holds(&batch));
        fs::remove_dir_all(&scratch).unwrap();
    }

    #[test]
    fn a_taken_name_gets_a_number() {
        let folder = std::env::temp_dir().join(format!("oriel-free-path-{}", std::process::id()));
        fs::create_dir_all(&folder).unwrap();
        let target = folder.join("a.tar.gz");
        assert_eq!(free_path(&target), target);
        fs::write(&target, b"x").unwrap();
        fs::write(folder.join("a.tar (2).gz"), b"x").unwrap();
        assert_eq!(free_path(&target), folder.join("a.tar (3).gz"));
        let hidden = folder.join(".DS_Store");
        fs::write(&hidden, b"x").unwrap();
        assert_eq!(free_path(&hidden), folder.join(".DS_Store (2)"));
        fs::remove_dir_all(&folder).unwrap();
    }
}
