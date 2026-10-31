//! SHA-256 over archive files: every file, as Lockstep's hash cache needs, and only the possible
//! duplicates, as `glazier-core`'s hash pass (`src/passes/hash-pass.ts`) reads them.

use std::collections::HashMap;
use std::fs::File;
use std::io::{self, Read, Seek, SeekFrom};
use std::path::Path;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::thread;
use std::time::Instant;

use sha2::{Digest, Sha256};

use crate::walk::WalkedFile;

/// Bytes read from each end of a file for the cheap first comparison, as in `hash-pass.ts`.
const EDGE_BYTES: u64 = 64 * 1024;

/// Node's `createReadStream` reads 64 KiB at a time, which is what `hashWholeFile` hashes in.
pub const NODE_STREAM_CHUNK: usize = 64 * 1024;

/// The hash pass's widths: eight files' edges at once, then four whole files.
pub const EDGE_CONCURRENCY: usize = 8;
pub const FULL_CONCURRENCY: usize = 4;

/// A whole file's SHA-256, read `buffer_size` bytes at a time.
pub fn sha256_file(path: &Path, buffer_size: usize) -> io::Result<[u8; 32]> {
    let mut file = File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; buffer_size];

    loop {
        let read = file.read(&mut buffer)?;

        if read == 0 {
            break;
        }

        hasher.update(&buffer[..read]);
    }

    Ok(hasher.finalize().into())
}

/// `hashEdges`: SHA-256 of the size in decimal, the first 64 KiB and the last 64 KiB that do not
/// overlap the first.
pub fn edge_hash(path: &Path, size: u64) -> io::Result<[u8; 32]> {
    let mut file = File::open(path)?;
    let mut hasher = Sha256::new();
    hasher.update(size.to_string().as_bytes());
    let mut head = vec![0u8; EDGE_BYTES.min(size) as usize];
    file.read_exact(&mut head)?;
    hasher.update(&head);

    if size > EDGE_BYTES {
        let tail_length = EDGE_BYTES.min(size - EDGE_BYTES);
        let mut tail = vec![0u8; tail_length as usize];
        file.seek(SeekFrom::Start(size - tail_length))?;
        file.read_exact(&mut tail)?;
        hasher.update(&tail);
    }

    Ok(hasher.finalize().into())
}

/// Runs `work` over `items`, `threads` at a time, like `forEachConcurrent`.
fn for_each_concurrent<T: Sync>(items: &[T], threads: usize, work: impl Fn(&T) + Sync) {
    let next = AtomicUsize::new(0);

    thread::scope(|scope| {
        for _ in 0..threads.max(1) {
            scope.spawn(|| {
                loop {
                    let index = next.fetch_add(1, Ordering::Relaxed);
                    let Some(item) = items.get(index) else {
                        return;
                    };
                    work(item);
                }
            });
        }
    });
}

#[derive(Debug, Clone, Copy, serde::Serialize)]
pub struct HashStats {
    pub files: usize,
    pub bytes: u64,
    pub seconds: f64,
    pub errors: usize,
}

/// SHA-256 of every file, `threads` files at a time.
pub fn hash_all(files: &[WalkedFile], threads: usize, buffer_size: usize) -> HashStats {
    let started = Instant::now();
    let bytes = AtomicU64::new(0);
    let errors = AtomicUsize::new(0);

    for_each_concurrent(files, threads, |file| {
        match sha256_file(&file.abs_path, buffer_size) {
            Ok(_) => {
                bytes.fetch_add(file.size, Ordering::Relaxed);
            }
            Err(_) => {
                errors.fetch_add(1, Ordering::Relaxed);
            }
        }
    });

    HashStats {
        files: files.len(),
        bytes: bytes.into_inner(),
        seconds: started.elapsed().as_secs_f64(),
        errors: errors.into_inner(),
    }
}

/// A file's edge hash, and its whole hash when it was small enough to read at once.
type EdgeResult = ([u8; 32], Option<[u8; 32]>);

#[derive(Debug, Clone, Copy, serde::Serialize)]
pub struct HashPassStats {
    /// Files sharing a size with another, whose edges were hashed.
    pub edge_files: usize,
    pub edge_bytes_read: u64,
    /// Files small enough that the edges covered them, hashed whole at once.
    pub small_files: usize,
    /// Files whose size and edges matched another's, hashed whole.
    pub full_files: usize,
    pub full_bytes: u64,
    /// Sets of byte-identical files found.
    pub duplicate_sets: usize,
    pub seconds: f64,
}

/// What `runHashPass` does on a fresh catalog: edge hashes for every non-junk file whose size
/// another shares, then whole-file hashes for those whose size and edges both match.
pub fn hash_pass(files: &[WalkedFile]) -> HashPassStats {
    let started = Instant::now();
    let mut by_size: HashMap<u64, usize> = HashMap::new();

    for file in files.iter().filter(|file| !file.junk && file.size > 0) {
        *by_size.entry(file.size).or_default() += 1;
    }

    let edge_candidates: Vec<&WalkedFile> = files
        .iter()
        .filter(|file| !file.junk && file.size > 0 && by_size[&file.size] > 1)
        .collect();

    let edges: Mutex<Vec<Option<EdgeResult>>> = Mutex::new(vec![None; edge_candidates.len()]);
    let indexes: Vec<usize> = (0..edge_candidates.len()).collect();
    let edge_bytes_read = AtomicU64::new(0);

    for_each_concurrent(&indexes, EDGE_CONCURRENCY, |&index| {
        let file = edge_candidates[index];
        let Ok(edge) = edge_hash(&file.abs_path, file.size) else {
            return;
        };
        edge_bytes_read.fetch_add(file.size.min(EDGE_BYTES * 2), Ordering::Relaxed);
        let small = file.size <= EDGE_BYTES * 2;
        let whole = if small {
            // The edges cover the whole file, so it is read once more as one SHA-256.
            sha256_file(&file.abs_path, NODE_STREAM_CHUNK).ok()
        } else {
            None
        };

        if let Ok(mut edges) = edges.lock() {
            edges[index] = Some((edge, whole));
        }
    });

    let edges = edges.into_inner().unwrap_or_default();
    let small_files = edges
        .iter()
        .filter(|entry| matches!(entry, Some((_, Some(_)))))
        .count();
    let mut by_size_and_edge: HashMap<(u64, [u8; 32]), usize> = HashMap::new();

    for (file, entry) in edge_candidates.iter().zip(&edges) {
        if let Some((edge, _)) = entry {
            *by_size_and_edge.entry((file.size, *edge)).or_default() += 1;
        }
    }

    let full_candidates: Vec<&WalkedFile> = edge_candidates
        .iter()
        .zip(&edges)
        .filter_map(|(file, entry)| match entry {
            Some((edge, None)) if by_size_and_edge[&(file.size, *edge)] > 1 => Some(*file),
            _ => None,
        })
        .collect();
    let full_bytes = AtomicU64::new(0);
    let sums: Mutex<HashMap<[u8; 32], usize>> = Mutex::new(HashMap::new());

    for_each_concurrent(&full_candidates, FULL_CONCURRENCY, |file| {
        let Ok(sum) = sha256_file(&file.abs_path, NODE_STREAM_CHUNK) else {
            return;
        };
        full_bytes.fetch_add(file.size, Ordering::Relaxed);

        if let Ok(mut sums) = sums.lock() {
            *sums.entry(sum).or_default() += 1;
        }
    });

    let duplicate_sets = sums
        .into_inner()
        .unwrap_or_default()
        .values()
        .filter(|&&count| count > 1)
        .count();

    HashPassStats {
        edge_files: edge_candidates.len(),
        edge_bytes_read: edge_bytes_read.into_inner(),
        small_files,
        full_files: full_candidates.len(),
        full_bytes: full_bytes.into_inner(),
        duplicate_sets,
        seconds: started.elapsed().as_secs_f64(),
    }
}
