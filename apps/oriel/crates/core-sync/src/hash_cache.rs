//! The hash cache, from `hash-cache.ts`: each source folder's SHA-256s by archive path, kept with
//! the size and times they were taken at, so a plan or a push hashes only what changed.
//!
//! The file format is lockstep-core's: one JSON file per source folder,
//! `<folder>/v1/<sha256 of the source folder's path>.json`, holding
//! `{ entries, sourceRoot, version: 1 }`, the entries sorted by path as `localeCompare` sorts
//! them. Oriel keeps its own under `DataRoot::hash_cache()`.

use std::borrow::Cow;
use std::collections::HashMap;
use std::fmt;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use oriel_core_domain::MediaItem;
use oriel_core_domain::collation::Collation;
use serde::de::{self, Deserializer, Visitor};
use serde::{Deserialize, Serialize};
use sha2::{Digest as _, Sha256};

use crate::format::{serialize_js_number, serialize_optional_js_number};
use crate::rules::resolve;
use crate::scan::{ArchiveFileFingerprint, fingerprints_match};

/// The cache format's version, and the subfolder of the cache's folder its files sit in.
const CACHE_VERSION: u32 = 1;

fn version_folder(hash_cache: &Path) -> PathBuf {
    hash_cache.join(format!("v{CACHE_VERSION}"))
}

/// One cached hash, `HashCacheEntry`.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HashCacheEntry {
    #[serde(
        skip_serializing_if = "Option::is_none",
        serialize_with = "serialize_optional_js_number"
    )]
    ctime_ms: Option<f64>,
    #[serde(serialize_with = "serialize_js_number")]
    mtime_ms: f64,
    path: String,
    sha256: String,
    size: u64,
}

impl HashCacheEntry {
    /// The hash, if the file still has the fingerprint it was taken at.
    pub(crate) fn hash_at(&self, fingerprint: &ArchiveFileFingerprint) -> Option<&str> {
        let taken_at = ArchiveFileFingerprint {
            ctime_ms: self.ctime_ms,
            mtime_ms: self.mtime_ms,
            size: self.size,
        };
        fingerprints_match(&taken_at, fingerprint).then_some(self.sha256.as_str())
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
pub(crate) struct HashCache {
    file_path: PathBuf,
    source_root: String,
    entries: Vec<HashCacheEntry>,
    index: HashMap<String, usize>,
}

impl HashCache {
    fn new(file_path: PathBuf, source_root: String, entries: Vec<HashCacheEntry>) -> Self {
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

    pub(crate) fn entry(&self, path: &str) -> Option<&HashCacheEntry> {
        Some(&self.entries[*self.index.get(path)?])
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
        self.record(path, fingerprint, sha256);
        Ok(())
    }

    fn record(&mut self, path: &str, fingerprint: &ArchiveFileFingerprint, sha256: &str) {
        self.insert(HashCacheEntry {
            ctime_ms: fingerprint.ctime_ms,
            mtime_ms: fingerprint.mtime_ms.trunc(),
            path: path.to_owned(),
            sha256: sha256.to_ascii_lowercase(),
            size: fingerprint.size,
        });
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
                let cached = fingerprints.get(&item.path).and_then(|fingerprint| {
                    self.entry(&item.path)
                        .and_then(|entry| entry.hash_at(fingerprint))
                });
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
    pub(crate) fn update_from_items(
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
                // A scan's hashes are its own or the cache's, so always well formed.
                self.record(&item.path, fingerprint, sha256);
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

    pub fn retain<'a>(&mut self, paths: impl IntoIterator<Item = &'a str>) {
        let mut keep = vec![false; self.entries.len()];
        for path in paths {
            if let Some(&at) = self.index.get(path) {
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
        entries.sort_by(|left, right| Collation::Locale.compare(&left.path, &right.path));
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
fn canonical_source_root(source_root: &Path) -> String {
    let resolved = resolve(source_root).to_string_lossy().into_owned();
    if cfg!(windows) {
        resolved.to_lowercase()
    } else {
        resolved
    }
}

/// `hashCachePath`: the cache file of `source_root` in the cache's folder,
/// `<hash_cache>/v1/<sha256 of the canonical folder path>.json`.
pub fn hash_cache_path(source_root: &Path, hash_cache: &Path) -> PathBuf {
    let key = Sha256::digest(canonical_source_root(source_root).as_bytes());
    let hex: String = key.iter().map(|byte| format!("{byte:02x}")).collect();
    version_folder(hash_cache).join(format!("{hex}.json"))
}

/// A cache as `loadHashCache` reads it, with the warning it gives when it had to start over.
#[derive(Debug)]
pub(crate) struct HashCacheLoad {
    pub cache: HashCache,
    pub warning: Option<String>,
}

/// `loadHashCache`: the source folder's cache in the cache's folder, or an empty one when there is
/// none. A file that does not read as a version-1 cache of this source folder is replaced on the
/// next save, with a warning.
pub(crate) fn load_hash_cache(source_root: &Path, hash_cache: &Path) -> HashCacheLoad {
    let canonical = canonical_source_root(source_root);
    let file_path = hash_cache_path(Path::new(&canonical), hash_cache);
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
fn parse_persisted(raw: &str, canonical_root: &str) -> Result<Vec<HashCacheEntry>, String> {
    let stored: StoredCache = serde_json::from_str(raw).map_err(|error| error.to_string())?;
    if canonical_source_root(Path::new(stored.source_root.as_ref())) != canonical_root {
        return Err("cache source root does not match".to_owned());
    }
    Ok(stored
        .entries
        .into_iter()
        .map(|entry| HashCacheEntry {
            ctime_ms: entry.ctime_ms,
            mtime_ms: entry.mtime_ms.trunc(),
            path: entry.path.into_owned(),
            sha256: entry.sha256.to_ascii_lowercase(),
            size: entry.size,
        })
        .collect())
}

/// A cache file as it is read: straight into its entries, each field checked as it is read.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredCache<'a> {
    #[serde(borrow)]
    entries: Vec<StoredEntry<'a>>,
    #[serde(borrow)]
    source_root: Cow<'a, str>,
    #[serde(rename = "version", deserialize_with = "version_one")]
    _version: (),
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredEntry<'a> {
    #[serde(default, deserialize_with = "present_number")]
    ctime_ms: Option<f64>,
    mtime_ms: f64,
    #[serde(borrow)]
    path: Cow<'a, str>,
    #[serde(borrow, deserialize_with = "sha256")]
    sha256: Cow<'a, str>,
    #[serde(deserialize_with = "whole_size")]
    size: u64,
}

fn version_one<'de, D: Deserializer<'de>>(deserializer: D) -> Result<(), D::Error> {
    if f64::deserialize(deserializer)? == f64::from(CACHE_VERSION) {
        Ok(())
    } else {
        Err(de::Error::custom("the cache has another version"))
    }
}

/// A number, where `null` is refused rather than read as absent.
fn present_number<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Option<f64>, D::Error> {
    f64::deserialize(deserializer).map(Some)
}

/// A SHA-256, borrowed from the file when it has no escapes.
fn sha256<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Cow<'de, str>, D::Error> {
    struct Text;

    impl<'de> Visitor<'de> for Text {
        type Value = Cow<'de, str>;

        fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
            formatter.write_str("a string")
        }

        fn visit_borrowed_str<E>(self, value: &'de str) -> Result<Self::Value, E> {
            Ok(Cow::Borrowed(value))
        }

        fn visit_str<E>(self, value: &str) -> Result<Self::Value, E> {
            Ok(Cow::Owned(value.to_owned()))
        }
    }

    let value = deserializer.deserialize_str(Text)?;
    if is_sha256(&value) {
        Ok(value)
    } else {
        Err(de::Error::custom("an entry's sha256 is not a SHA-256"))
    }
}

fn whole_size<'de, D: Deserializer<'de>>(deserializer: D) -> Result<u64, D::Error> {
    let size = f64::deserialize(deserializer)?;
    if size >= 0.0 && size.fract() == 0.0 {
        Ok(size as u64)
    } else {
        Err(de::Error::custom("an entry's size is not a whole number"))
    }
}
