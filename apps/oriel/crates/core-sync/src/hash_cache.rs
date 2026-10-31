//! The hash cache, from `hash-cache.ts`: each source folder's SHA-256s by archive path, kept with
//! the size and times they were taken at, so a plan or a push hashes only what changed.
//!
//! The file format is lockstep-core's, as Electron Oriel wrote it: one
//! JSON file per source folder, `<root>/v1/<sha256 of the folder's path>.json`, holding
//! `{ entries, sourceRoot, version: 1 }`, the entries sorted by path as `localeCompare` sorts
//! them. Oriel keeps its own under `DataRoot::hash_cache()`.

use std::borrow::Cow;
use std::collections::{HashMap, HashSet};
use std::fmt;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use oriel_core_domain::MediaItem;
use oriel_core_index::{ArchiveFileFingerprint, fingerprints_match, locale_compare};
use serde::de::{self, Deserializer, IgnoredAny, MapAccess, Visitor};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest as _, Sha256};

use crate::format::{serialize_js_number, serialize_optional_js_number};
use crate::rules::resolve;

/// The cache format's version, and the folder its files sit in.
pub const CACHE_VERSION: u32 = 1;

/// The folder a hash cache root keeps its version-1 files in: `<hash-cache>/v1`.
pub fn cache_root(hash_cache_folder: &Path) -> PathBuf {
    hash_cache_folder.join(format!("v{CACHE_VERSION}"))
}

/// One cached hash, `HashCacheEntry`.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HashCacheEntry {
    #[serde(
        skip_serializing_if = "Option::is_none",
        serialize_with = "serialize_optional_js_number"
    )]
    pub ctime_ms: Option<f64>,
    #[serde(serialize_with = "serialize_js_number")]
    pub mtime_ms: f64,
    pub path: String,
    pub sha256: String,
    pub size: u64,
}

impl HashCacheEntry {
    fn fingerprint(&self) -> ArchiveFileFingerprint {
        ArchiveFileFingerprint {
            ctime_ms: self.ctime_ms,
            mtime_ms: self.mtime_ms,
            size: self.size,
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PersistedHashCache<'a> {
    entries: Vec<&'a HashCacheEntry>,
    source_root: &'a str,
    version: u32,
}

/// One source folder's cache. Entries keep the order they were added in, as a JavaScript `Map`
/// does, so names the collation ranks equal save in the same order in both apps.
#[derive(Clone, Debug)]
pub struct HashCache {
    file_path: PathBuf,
    source_root: String,
    entries: Vec<HashCacheEntry>,
    index: HashMap<String, usize>,
}

impl HashCache {
    pub fn new(file_path: PathBuf, source_root: String, entries: Vec<HashCacheEntry>) -> Self {
        let mut cache = Self {
            file_path,
            source_root,
            entries: Vec::with_capacity(entries.len()),
            index: HashMap::with_capacity(entries.len()),
        };
        for entry in entries {
            cache.insert(entry);
        }
        cache
    }

    pub fn file_path(&self) -> &Path {
        &self.file_path
    }

    pub fn source_root(&self) -> &str {
        &self.source_root
    }

    pub fn entries(&self) -> &[HashCacheEntry] {
        &self.entries
    }

    /// The cached hash of `path`, if the file still has the fingerprint it was hashed at.
    pub fn get(&self, path: &str, fingerprint: &ArchiveFileFingerprint) -> Option<&str> {
        let entry = &self.entries[*self.index.get(path)?];
        fingerprints_match(&entry.fingerprint(), fingerprint).then_some(entry.sha256.as_str())
    }

    /// Records a hash. The modified time is truncated and the hash lower-cased; a value that is
    /// not a SHA-256 is refused.
    pub fn set(
        &mut self,
        path: &str,
        fingerprint: &ArchiveFileFingerprint,
        sha256: &str,
    ) -> anyhow::Result<()> {
        anyhow::ensure!(
            is_sha256(sha256),
            "Invalid SHA-256 for hash cache entry: {path}"
        );
        self.insert(HashCacheEntry {
            ctime_ms: fingerprint.ctime_ms,
            mtime_ms: fingerprint.mtime_ms.trunc(),
            path: path.to_owned(),
            sha256: sha256.to_ascii_lowercase(),
            size: fingerprint.size,
        });
        Ok(())
    }

    fn insert(&mut self, entry: HashCacheEntry) {
        match self.index.get(&entry.path) {
            Some(&at) => self.entries[at] = entry,
            None => {
                self.index.insert(entry.path.clone(), self.entries.len());
                self.entries.push(entry);
            }
        }
    }

    /// Gives each item whose file is unchanged its cached hash, as its id too; returns the items
    /// and how many it gave a hash.
    pub fn hydrate(
        &self,
        items: Vec<MediaItem>,
        fingerprints: &HashMap<String, ArchiveFileFingerprint>,
    ) -> (Vec<MediaItem>, usize) {
        let mut hits = 0;
        let items = items
            .into_iter()
            .map(|mut item| {
                let cached = fingerprints
                    .get(&item.path)
                    .and_then(|fingerprint| self.get(&item.path, fingerprint));
                if let Some(sha256) = cached {
                    hits += 1;
                    item.id = sha256.to_owned();
                    item.sha256 = Some(sha256.to_owned());
                }
                item
            })
            .collect();
        (items, hits)
    }

    /// Records the hash of every item that has one.
    pub fn update_from_items(
        &mut self,
        items: &[MediaItem],
        fingerprints: &HashMap<String, ArchiveFileFingerprint>,
    ) {
        for item in items {
            if let (Some(fingerprint), Some(sha256)) =
                (fingerprints.get(&item.path), item.sha256.as_deref())
            {
                // Most items come from the cache itself: an entry `set` would write again as it
                // is keeps its place either way, so it is left alone rather than rebuilt.
                if self.holds(&item.path, fingerprint, sha256) {
                    continue;
                }
                // A scan's hashes are always well formed, so this cannot be refused.
                let _ = self.set(&item.path, fingerprint, sha256);
            }
        }
    }

    /// Whether the entry for `path` is already the one `set` would record.
    fn holds(&self, path: &str, fingerprint: &ArchiveFileFingerprint, sha256: &str) -> bool {
        self.index.get(path).is_some_and(|&at| {
            let entry = &self.entries[at];
            entry.size == fingerprint.size
                && entry.mtime_ms == fingerprint.mtime_ms.trunc()
                && entry.ctime_ms == fingerprint.ctime_ms
                // Stored hashes are lower case, so this is `sha256.to_ascii_lowercase() == …`.
                && entry.sha256.eq_ignore_ascii_case(sha256)
        })
    }

    /// Forgets every path not in `paths`.
    pub fn retain(&mut self, paths: &HashSet<String>) {
        self.entries.retain(|entry| paths.contains(&entry.path));
        self.reindex();
    }

    /// Forgets every path that is not one of `items`', as [`retain`](Self::retain) does with
    /// their paths, without collecting them first.
    pub(crate) fn retain_items(&mut self, items: &[MediaItem]) {
        let mut keep = vec![false; self.entries.len()];
        for item in items {
            if let Some(&at) = self.index.get(&item.path) {
                keep[at] = true;
            }
        }
        if keep.iter().all(|kept| *kept) {
            return;
        }
        let mut kept = keep.into_iter();
        self.entries.retain(|_| kept.next().unwrap_or(false));
        self.reindex();
    }

    fn reindex(&mut self) {
        self.index = self
            .entries
            .iter()
            .enumerate()
            .map(|(at, entry)| (entry.path.clone(), at))
            .collect();
    }

    /// The file's contents: the entries sorted by path, as `JSON.stringify(…, null, 2)` writes
    /// them, with a final newline.
    pub fn to_json(&self) -> String {
        let mut entries: Vec<&HashCacheEntry> = self.entries.iter().collect();
        entries.sort_by(|left, right| locale_compare(&left.path, &right.path));
        let persisted = PersistedHashCache {
            entries,
            source_root: &self.source_root,
            version: CACHE_VERSION,
        };
        let mut json =
            serde_json::to_string_pretty(&persisted).expect("a hash cache always serializes");
        json.push('\n');
        json
    }

    /// Writes the cache through a temporary file and a rename, so a failed write never leaves a
    /// partial file.
    pub fn save(&self) -> io::Result<()> {
        if let Some(folder) = self.file_path.parent() {
            fs::create_dir_all(folder)?;
        }
        let temporary = self.file_path.with_file_name(format!(
            "{}.{}.{}.tmp",
            self.file_path
                .file_name()
                .unwrap_or_default()
                .to_string_lossy(),
            std::process::id(),
            unique_suffix()
        ));
        let written = fs::write(&temporary, self.to_json())
            .and_then(|()| fs::rename(&temporary, &self.file_path));
        if written.is_err() {
            let _ = fs::remove_file(&temporary);
        }
        written
    }
}

/// A suffix no other write of this process uses at the same time.
fn unique_suffix() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    format!("{nanos:x}-{}", NEXT.fetch_add(1, Ordering::Relaxed))
}

/// `/^[a-f0-9]{64}$/i`.
fn is_sha256(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

/// `canonicalSourceRoot`: the folder's absolute path, folded, lower-cased on Windows.
pub fn canonical_source_root(source_root: &Path) -> String {
    let resolved = resolve(source_root).to_string_lossy().into_owned();
    if cfg!(windows) {
        resolved.to_lowercase()
    } else {
        resolved
    }
}

/// `hashCachePath`: `<cache root>/<sha256 of the canonical folder path>.json`.
pub fn hash_cache_path(source_root: &Path, cache_root: &Path) -> PathBuf {
    let key = Sha256::digest(canonical_source_root(source_root).as_bytes());
    let hex: String = key.iter().map(|byte| format!("{byte:02x}")).collect();
    cache_root.join(format!("{hex}.json"))
}

/// A cache as `loadHashCache` reads it, with the warning it gives when it had to start over.
#[derive(Debug)]
pub struct HashCacheLoad {
    pub cache: HashCache,
    pub warning: Option<String>,
}

/// `loadHashCache`: the folder's cache, or an empty one when there is none. A file that does not
/// read as a version-1 cache of this folder is replaced on the next save, with a warning.
pub fn load_hash_cache(source_root: &Path, cache_root: &Path) -> HashCacheLoad {
    let canonical = canonical_source_root(source_root);
    let file_path = hash_cache_path(Path::new(&canonical), cache_root);
    let empty = |file_path: PathBuf| HashCache::new(file_path, canonical.clone(), Vec::new());

    let raw = match fs::read_to_string(&file_path) {
        Ok(raw) => raw,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            return HashCacheLoad {
                cache: empty(file_path),
                warning: None,
            };
        }
        Err(error) => {
            return HashCacheLoad {
                cache: empty(file_path),
                warning: Some(rebuilt(&error.to_string())),
            };
        }
    };

    match parse_persisted(&raw, &canonical) {
        Ok(entries) => HashCacheLoad {
            cache: HashCache::new(file_path, canonical, entries),
            warning: None,
        },
        Err(reason) => HashCacheLoad {
            cache: empty(file_path),
            warning: Some(rebuilt(&reason)),
        },
    }
}

fn rebuilt(reason: &str) -> String {
    format!("Hash cache could not be read and will be rebuilt: {reason}")
}

/// `PersistedHashCacheSchema` and the source check: the entries, or why the file is refused.
///
/// A cache holds an entry per file, so the usual, valid file is read straight into entries
/// ([`read_valid`]); any file that does not read that way is read again as a JSON value, which
/// says why it is refused.
fn parse_persisted(raw: &str, canonical_root: &str) -> Result<Vec<HashCacheEntry>, String> {
    match read_valid(raw, canonical_root) {
        Some(entries) => Ok(entries),
        None => parse_value(raw, canonical_root),
    }
}

/// [`parse_persisted`] through a JSON value, naming what is wrong with a file it refuses.
fn parse_value(raw: &str, canonical_root: &str) -> Result<Vec<HashCacheEntry>, String> {
    let document: Value = serde_json::from_str(raw).map_err(|error| error.to_string())?;
    let object = document.as_object().ok_or("the cache is not an object")?;
    if object.get("version").and_then(Value::as_f64) != Some(f64::from(CACHE_VERSION)) {
        return Err("the cache has another version".to_owned());
    }
    let source_root = object
        .get("sourceRoot")
        .and_then(Value::as_str)
        .ok_or("the cache has no source folder")?;
    let entries = object
        .get("entries")
        .and_then(Value::as_array)
        .ok_or("the cache has no entries")?
        .iter()
        .map(parse_entry)
        .collect::<Result<Vec<_>, _>>()?;
    if canonical_source_root(Path::new(source_root)) != canonical_root {
        return Err("cache source root does not match".to_owned());
    }
    Ok(entries)
}

fn parse_entry(value: &Value) -> Result<HashCacheEntry, String> {
    let entry = value.as_object().ok_or("an entry is not an object")?;
    let finite = |name: &str| {
        entry
            .get(name)
            .and_then(Value::as_f64)
            .filter(|number| number.is_finite())
    };
    let ctime_ms = match entry.get("ctimeMs") {
        None => None,
        Some(_) => Some(finite("ctimeMs").ok_or("an entry's ctimeMs is not a number")?),
    };
    let mtime_ms = finite("mtimeMs").ok_or("an entry's mtimeMs is not a number")?;
    let path = entry
        .get("path")
        .and_then(Value::as_str)
        .ok_or("an entry has no path")?;
    let sha256 = entry
        .get("sha256")
        .and_then(Value::as_str)
        .filter(|sha256| is_sha256(sha256))
        .ok_or("an entry's sha256 is not a SHA-256")?;
    let size = finite("size")
        .filter(|size| *size >= 0.0 && size.fract() == 0.0)
        .ok_or("an entry's size is not a whole number")?;
    Ok(HashCacheEntry {
        ctime_ms,
        mtime_ms: mtime_ms.trunc(),
        path: path.to_owned(),
        sha256: sha256.to_ascii_lowercase(),
        size: size as u64,
    })
}

/// The entries of a cache file that `parse_persisted` accepts, read without building a JSON
/// value first; `None` for any file it might refuse, which it then reads the slow way. So this
/// is never more lenient: a top level or an entry that is not an object, a `null` or a string
/// where a number goes, and every check `parse_entry` makes all give `None`. A key named twice
/// keeps its last value, as a JSON value does.
fn read_valid(raw: &str, canonical_root: &str) -> Option<Vec<HashCacheEntry>> {
    let document: FastDocument = serde_json::from_str(raw).ok()?;
    if document.version != Some(f64::from(CACHE_VERSION))
        || canonical_source_root(Path::new(document.source_root?.as_ref())) != canonical_root
    {
        return None;
    }
    document
        .entries?
        .into_iter()
        .map(|entry| {
            let FastEntry {
                ctime_ms,
                mtime_ms,
                path,
                sha256,
                size,
            } = entry;
            let finite = |number: f64| number.is_finite().then_some(number);
            let ctime_ms = match ctime_ms {
                None => None,
                Some(number) => Some(finite(number)?),
            };
            let mtime_ms = finite(mtime_ms?)?;
            let sha256 = sha256.filter(|sha256| is_sha256(sha256))?;
            let size = finite(size?).filter(|size| *size >= 0.0 && size.fract() == 0.0)?;
            Some(HashCacheEntry {
                ctime_ms,
                mtime_ms: mtime_ms.trunc(),
                path: path?.into_owned(),
                sha256: sha256.to_ascii_lowercase(),
                size: size as u64,
            })
        })
        .collect()
}

/// A cache file's top level, as [`read_valid`] reads it.
struct FastDocument<'a> {
    entries: Option<Vec<FastEntry<'a>>>,
    source_root: Option<Cow<'a, str>>,
    version: Option<f64>,
}

/// One entry, as [`read_valid`] reads it: each field as it was written, checked afterwards.
struct FastEntry<'a> {
    ctime_ms: Option<f64>,
    mtime_ms: Option<f64>,
    path: Option<Cow<'a, str>>,
    sha256: Option<Cow<'a, str>>,
    size: Option<f64>,
}

/// A string, borrowed from the file when it has no escapes.
struct Text<'a>(Cow<'a, str>);

impl<'de: 'a, 'a> Deserialize<'de> for Text<'a> {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct TextVisitor;
        impl<'de> Visitor<'de> for TextVisitor {
            type Value = Text<'de>;
            fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.write_str("a string")
            }
            fn visit_borrowed_str<E: de::Error>(self, value: &'de str) -> Result<Self::Value, E> {
                Ok(Text(Cow::Borrowed(value)))
            }
            fn visit_str<E: de::Error>(self, value: &str) -> Result<Self::Value, E> {
                Ok(Text(Cow::Owned(value.to_owned())))
            }
            fn visit_string<E: de::Error>(self, value: String) -> Result<Self::Value, E> {
                Ok(Text(Cow::Owned(value)))
            }
        }
        deserializer.deserialize_str(TextVisitor)
    }
}

/// Reads only a JSON object, never an array, into the fields `F` names.
macro_rules! object_visitor {
    ($visitor:ident, $value:ident, $expecting:literal, { $($key:literal => $field:ident: $kind:ty),* $(,)? }) => {
        struct $visitor;
        impl<'de> Visitor<'de> for $visitor {
            type Value = $value<'de>;
            fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.write_str($expecting)
            }
            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
                $(let mut $field = None;)*
                while let Some(key) = map.next_key::<Text<'de>>()? {
                    match key.0.as_ref() {
                        $($key => $field = Some(map.next_value::<$kind>()?.into()),)*
                        _ => {
                            map.next_value::<IgnoredAny>()?;
                        }
                    }
                }
                Ok($value { $($field),* })
            }
        }
    };
}

object_visitor!(DocumentVisitor, FastDocument, "a hash cache", {
    "entries" => entries: Vec<FastEntry<'de>>,
    "sourceRoot" => source_root: Text<'de>,
    "version" => version: f64,
});

object_visitor!(EntryVisitor, FastEntry, "a hash cache entry", {
    "ctimeMs" => ctime_ms: f64,
    "mtimeMs" => mtime_ms: f64,
    "path" => path: Text<'de>,
    "sha256" => sha256: Text<'de>,
    "size" => size: f64,
});

impl<'a> From<Text<'a>> for Cow<'a, str> {
    fn from(text: Text<'a>) -> Self {
        text.0
    }
}

impl<'de: 'a, 'a> Deserialize<'de> for FastDocument<'a> {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        deserializer.deserialize_map(DocumentVisitor)
    }
}

impl<'de: 'a, 'a> Deserialize<'de> for FastEntry<'a> {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        deserializer.deserialize_map(EntryVisitor)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The direct read accepts a file only when the JSON value read accepts it, with the same
    /// entries; anything else falls through to the value read and its reason.
    #[test]
    fn reads_a_valid_file_directly_and_nothing_the_value_read_refuses() {
        let root = "/Volumes/Archive";
        let sha = "AB".repeat(32);
        let entry = |fields: &str| {
            format!(r#"{{"entries":[{{{fields}}}],"sourceRoot":"{root}","version":1}}"#)
        };
        let valid = format!(r#""mtimeMs":5.9,"path":"a/b.jpg","sha256":"{sha}","size":3"#);
        let documents = [
            entry(&valid),
            entry(&format!(r#""ctimeMs":7.25,{valid}"#)),
            entry(&format!(r#"{valid},"extra":[1,{{"x":null}}]"#)),
            entry(&format!(r#"{valid},"size":4"#)),
            entry(&format!(r#""path":"a\u002fc.jpg",{valid}"#)),
            entry(&format!(r#""ctimeMs":null,{valid}"#)),
            entry(&format!(r#""ctimeMs":"7",{valid}"#)),
            entry(&format!(r#"{valid},"size":-1"#)),
            entry(&format!(r#"{valid},"size":1.5"#)),
            entry(&format!(r#"{valid},"sha256":"abc""#)),
            entry(r#""mtimeMs":5,"path":"a.jpg","size":3"#),
            format!(r#"{{"entries":[[1,2,"a.jpg","{sha}",3]],"sourceRoot":"{root}","version":1}}"#),
            format!(r#"[[],"{root}",1]"#),
            format!(r#"{{"entries":[],"sourceRoot":"{root}","version":1.0}}"#),
            format!(r#"{{"entries":[],"sourceRoot":"{root}","version":2}}"#),
            format!(r#"{{"entries":[],"sourceRoot":"{root}","version":"1"}}"#),
            r#"{"entries":[],"sourceRoot":"/elsewhere","version":1}"#.to_owned(),
            r#"{"entries":[],"version":1}"#.to_owned(),
            format!(r#"{{"entries":{{}},"sourceRoot":"{root}","version":1}}"#),
            format!(r#"{{"entries":[1],"entries":[],"sourceRoot":"{root}","version":1}}"#),
            "not json".to_owned(),
        ];
        let mut direct = 0;
        for document in &documents {
            let by_value = parse_value(document, root);
            if let Some(entries) = read_valid(document, root) {
                direct += 1;
                assert_eq!(Ok(entries), by_value, "{document}");
            }
            assert_eq!(parse_persisted(document, root), by_value, "{document}");
        }
        assert_eq!(direct, 6, "the valid files read directly");
    }
}
