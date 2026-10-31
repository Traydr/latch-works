//! A reader for Chromium's Local Storage, where Electron Oriel's window keeps its `localStorage`
//! (`oriel.theme`, `oriel.sidebar`, `glazier.library.mode`, …): a LevelDB in
//! `<userData>/Local Storage/leveldb`.
//!
//! It reads the files and never opens the database, so nothing is written beside them: no `LOCK`,
//! no `LOG`, no compaction. A LevelDB keeps recent writes in its log (`NNNNNN.log`) and older ones
//! in sorted tables (`NNNNNN.ldb`, Snappy-compressed blocks); every write carries a sequence
//! number, so reading every log and table and keeping each key's highest-numbered record gives
//! the database's contents, deletions included, without its manifest.
//!
//! Chromium's keys are `_<origin>\0<script key>`, and both the script key and the value begin with
//! one byte that says how the rest is encoded: `1` for Latin-1, `0` for UTF-16LE
//! (`LocalStorageStorageFormat`). A packaged Electron app's pages are on the `file://` origin.

use std::collections::BTreeMap;
use std::fs;
use std::io;
use std::path::Path;

/// The origin every packaged Electron app's `localStorage` belongs to.
pub const FILE_ORIGIN: &str = "file://";

/// LevelDB's log blocks.
const BLOCK_SIZE: usize = 32 * 1024;
const LOG_HEADER: usize = 7;
const TABLE_MAGIC: u64 = 0xdb47_7524_8b80_fb57;
const FOOTER: usize = 48;

/// The `localStorage` entries of `origin`, from the LevelDB folder `folder` (`…/leveldb`). A
/// folder that is not there holds none.
pub fn local_storage(folder: &Path, origin: &str) -> io::Result<BTreeMap<String, String>> {
    let mut entries = BTreeMap::new();
    for (key, value) in read_folder(folder)? {
        let Some(rest) = key.strip_prefix(b"_") else {
            continue;
        };
        let Some(split) = rest.iter().position(|byte| *byte == 0) else {
            continue;
        };
        if &rest[..split] != origin.as_bytes() {
            continue;
        }
        if let (Some(key), Some(value)) = (decode_string(&rest[split + 1..]), decode_string(&value))
        {
            entries.insert(key, value);
        }
    }
    Ok(entries)
}

/// A Chromium Local Storage string: a format byte, then Latin-1 or UTF-16LE.
fn decode_string(bytes: &[u8]) -> Option<String> {
    let (format, rest) = bytes.split_first()?;
    match format {
        1 => Some(rest.iter().map(|byte| char::from(*byte)).collect()),
        0 if rest.len() % 2 == 0 => {
            let units: Vec<u16> = rest
                .as_chunks::<2>()
                .0
                .iter()
                .map(|pair| u16::from_le_bytes(*pair))
                .collect();
            String::from_utf16(&units).ok()
        }
        _ => None,
    }
}

/// Every live key and value in the LevelDB folder, as the database would answer them.
pub fn read_folder(folder: &Path) -> io::Result<BTreeMap<Vec<u8>, Vec<u8>>> {
    let listing = match fs::read_dir(folder) {
        Ok(listing) => listing,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(BTreeMap::new()),
        Err(error) => return Err(error),
    };
    // Each key's newest record: its sequence number and its value, or `None` once deleted.
    let mut newest: BTreeMap<Vec<u8>, (u64, Option<Vec<u8>>)> = BTreeMap::new();
    let mut keep = |key: Vec<u8>, sequence: u64, value: Option<Vec<u8>>| match newest.get(&key) {
        Some((seen, _)) if *seen >= sequence => {}
        _ => {
            newest.insert(key, (sequence, value));
        }
    };
    for entry in listing {
        let path = entry?.path();
        let extension = path.extension().and_then(|extension| extension.to_str());
        match extension {
            Some("log") => {
                for batch in log_records(&fs::read(&path)?) {
                    read_batch(&batch, &mut keep).map_err(|problem| corrupt(&path, problem))?;
                }
            }
            Some("ldb" | "sst") => read_table(&fs::read(&path)?, &mut keep)
                .map_err(|problem| corrupt(&path, problem))?,
            _ => {}
        }
    }
    Ok(newest
        .into_iter()
        .filter_map(|(key, (_, value))| Some((key, value?)))
        .collect())
}

fn corrupt(path: &Path, problem: &str) -> io::Error {
    io::Error::new(
        io::ErrorKind::InvalidData,
        format!("{}: {problem}", path.display()),
    )
}

/// The records of a log file, reassembled from its 32 KiB blocks. A torn record at the end (a
/// crash mid-write) is dropped, as LevelDB drops it.
fn log_records(bytes: &[u8]) -> Vec<Vec<u8>> {
    let mut records = Vec::new();
    let mut pending: Option<Vec<u8>> = None;
    let mut block_start = 0;
    while block_start < bytes.len() {
        let block = &bytes[block_start..bytes.len().min(block_start + BLOCK_SIZE)];
        let mut at = 0;
        while at + LOG_HEADER <= block.len() {
            let length = usize::from(u16::from_le_bytes([block[at + 4], block[at + 5]]));
            let kind = block[at + 6];
            let start = at + LOG_HEADER;
            if kind == 0 && length == 0 {
                // Preallocated zeros: the rest of the block holds nothing.
                break;
            }
            let Some(fragment) = block.get(start..start + length) else {
                return records;
            };
            match kind {
                1 => records.push(fragment.to_vec()),
                2 => pending = Some(fragment.to_vec()),
                3 => {
                    if let Some(record) = &mut pending {
                        record.extend_from_slice(fragment);
                    }
                }
                4 => {
                    if let Some(mut record) = pending.take() {
                        record.extend_from_slice(fragment);
                        records.push(record);
                    }
                }
                _ => return records,
            }
            at = start + length;
        }
        block_start += BLOCK_SIZE;
    }
    records
}

/// A `WriteBatch`: its first sequence number, its count, then each put or delete in order.
fn read_batch(
    batch: &[u8],
    keep: &mut impl FnMut(Vec<u8>, u64, Option<Vec<u8>>),
) -> Result<(), &'static str> {
    if batch.len() < 12 {
        return Err("a write batch is too short");
    }
    let sequence = u64::from_le_bytes(batch[..8].try_into().expect("eight bytes"));
    let count = u32::from_le_bytes(batch[8..12].try_into().expect("four bytes"));
    let mut reader = Reader::new(&batch[12..]);
    for index in 0..u64::from(count) {
        let kind = reader.byte()?;
        let key = reader.prefixed()?.to_vec();
        let value = match kind {
            1 => Some(reader.prefixed()?.to_vec()),
            0 => None,
            _ => return Err("a write batch has an unknown record"),
        };
        keep(key, sequence + index, value);
    }
    Ok(())
}

/// A sorted table: the index block names each data block, and each data block holds internal
/// keys (the user key, then eight bytes of sequence number and kind) with their values.
fn read_table(
    table: &[u8],
    keep: &mut impl FnMut(Vec<u8>, u64, Option<Vec<u8>>),
) -> Result<(), &'static str> {
    if table.len() < FOOTER {
        return Err("a table is too short");
    }
    let footer = &table[table.len() - FOOTER..];
    let magic = u64::from_le_bytes(footer[40..].try_into().expect("eight bytes"));
    if magic != TABLE_MAGIC {
        return Err("a table has no LevelDB footer");
    }
    let mut handles = Reader::new(footer);
    let _metaindex = (handles.varint()?, handles.varint()?);
    let index = block(table, handles.varint()?, handles.varint()?)?;
    for (_, handle) in block_entries(&index)? {
        let mut handle = Reader::new(&handle);
        let data = block(table, handle.varint()?, handle.varint()?)?;
        for (internal, value) in block_entries(&data)? {
            if internal.len() < 8 {
                return Err("a table key is too short");
            }
            let (key, trailer) = internal.split_at(internal.len() - 8);
            let trailer = u64::from_le_bytes(trailer.try_into().expect("eight bytes"));
            let value = match trailer & 0xff {
                1 => Some(value),
                0 => None,
                _ => return Err("a table key has an unknown kind"),
            };
            keep(key.to_vec(), trailer >> 8, value);
        }
    }
    Ok(())
}

/// A block's contents, uncompressed: `size` bytes at `offset`, then a byte saying how they were
/// compressed (and a checksum, which is not checked).
fn block(table: &[u8], offset: u64, size: u64) -> Result<Vec<u8>, &'static str> {
    let start = usize::try_from(offset).map_err(|_| "a block is out of range")?;
    let size = usize::try_from(size).map_err(|_| "a block is out of range")?;
    let contents = table
        .get(start..start + size)
        .ok_or("a block is out of range")?;
    match table.get(start + size) {
        Some(0) => Ok(contents.to_vec()),
        Some(1) => snappy(contents),
        Some(_) => Err("a block is compressed in a way this reader does not know"),
        None => Err("a block has no trailer"),
    }
}

/// A block's entries: each shares a prefix with the key before it, and the block ends with its
/// restart points, which a full read does not need.
fn block_entries(block: &[u8]) -> Result<Vec<Entry>, &'static str> {
    if block.len() < 4 {
        return Err("a block is too short");
    }
    let restarts = u32::from_le_bytes(block[block.len() - 4..].try_into().expect("four bytes"));
    let restarts = usize::try_from(restarts).map_err(|_| "a block has too many restarts")?;
    let end = block
        .len()
        .checked_sub(4 + restarts * 4)
        .ok_or("a block's restarts overrun it")?;
    let mut reader = Reader::new(&block[..end]);
    let mut key: Vec<u8> = Vec::new();
    let mut entries = Vec::new();
    while !reader.is_empty() {
        let shared = reader.length()?;
        let unshared = reader.length()?;
        let value_length = reader.length()?;
        if shared > key.len() {
            return Err("a block key shares more than the key before it");
        }
        key.truncate(shared);
        key.extend_from_slice(reader.take(unshared)?);
        entries.push((key.clone(), reader.take(value_length)?.to_vec()));
    }
    Ok(entries)
}

/// Snappy's raw format: the length, then literals and copies of what came before.
fn snappy(input: &[u8]) -> Result<Vec<u8>, &'static str> {
    let mut reader = Reader::new(input);
    let length = reader.length()?;
    let mut output = Vec::with_capacity(length);
    while !reader.is_empty() {
        let tag = reader.byte()?;
        let (copy_length, offset) = match tag & 3 {
            0 => {
                let short = usize::from(tag >> 2);
                let literal = if short < 60 {
                    short + 1
                } else {
                    let bytes = reader.take(short - 59)?;
                    let mut wide = [0u8; 4];
                    wide[..bytes.len()].copy_from_slice(bytes);
                    usize::try_from(u32::from_le_bytes(wide))
                        .map_err(|_| "a literal is too long")?
                        + 1
                };
                output.extend_from_slice(reader.take(literal)?);
                continue;
            }
            1 => (
                usize::from((tag >> 2) & 7) + 4,
                (usize::from(tag >> 5) << 8) | usize::from(reader.byte()?),
            ),
            2 => {
                let bytes = reader.take(2)?;
                (
                    usize::from(tag >> 2) + 1,
                    usize::from(u16::from_le_bytes([bytes[0], bytes[1]])),
                )
            }
            _ => {
                let bytes = reader.take(4)?;
                (
                    usize::from(tag >> 2) + 1,
                    usize::try_from(u32::from_le_bytes(bytes.try_into().expect("four bytes")))
                        .map_err(|_| "a copy is too far")?,
                )
            }
        };
        if offset == 0 || offset > output.len() {
            return Err("a Snappy copy reaches before the start");
        }
        // Copies may overlap what they write, so byte by byte.
        let from = output.len() - offset;
        for index in 0..copy_length {
            let byte = output[from + index];
            output.push(byte);
        }
    }
    if output.len() != length {
        return Err("a Snappy block has the wrong length");
    }
    Ok(output)
}

/// A key and its value.
type Entry = (Vec<u8>, Vec<u8>);

struct Reader<'a> {
    bytes: &'a [u8],
}

impl<'a> Reader<'a> {
    fn new(bytes: &'a [u8]) -> Self {
        Self { bytes }
    }

    fn is_empty(&self) -> bool {
        self.bytes.is_empty()
    }

    fn byte(&mut self) -> Result<u8, &'static str> {
        let (first, rest) = self.bytes.split_first().ok_or("the data ends early")?;
        self.bytes = rest;
        Ok(*first)
    }

    fn take(&mut self, count: usize) -> Result<&'a [u8], &'static str> {
        if count > self.bytes.len() {
            return Err("the data ends early");
        }
        let (taken, rest) = self.bytes.split_at(count);
        self.bytes = rest;
        Ok(taken)
    }

    fn varint(&mut self) -> Result<u64, &'static str> {
        let mut value = 0u64;
        for shift in (0..64).step_by(7) {
            let byte = self.byte()?;
            value |= u64::from(byte & 0x7f) << shift;
            if byte & 0x80 == 0 {
                return Ok(value);
            }
        }
        Err("a number is too long")
    }

    fn length(&mut self) -> Result<usize, &'static str> {
        usize::try_from(self.varint()?).map_err(|_| "a length is too long")
    }

    fn prefixed(&mut self) -> Result<&'a [u8], &'static str> {
        let length = self.length()?;
        self.take(length)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snappy_reads_literals_and_overlapping_copies() {
        // "abcabcabcab": a literal "abc", then a copy of 8 from 3 back (tag 01, length 8).
        let compressed = [11, 0b0000_1000, b'a', b'b', b'c', 0b0001_0001, 3];
        assert_eq!(snappy(&compressed).unwrap(), b"abcabcabcab");
        assert!(
            snappy(&[4, 0b0000_0001, 9]).is_err(),
            "a copy before the start"
        );
    }

    #[test]
    fn strings_decode_from_latin_1_and_utf_16() {
        assert_eq!(decode_string(b"\x01caf\xe9").as_deref(), Some("café"));
        assert_eq!(decode_string(b"\x00h\x00i\x00").as_deref(), Some("hi"));
        assert_eq!(decode_string(b"\x02x"), None);
        assert_eq!(decode_string(b""), None);
    }

    #[test]
    fn a_table_block_shares_key_prefixes() {
        // Two entries, "apple" = "1" and "apricot" = "2" (sharing "ap"), one restart.
        let mut block = vec![0, 5, 1];
        block.extend_from_slice(b"apple1");
        block.extend_from_slice(&[2, 5, 1]);
        block.extend_from_slice(b"ricot2");
        block.extend_from_slice(&0u32.to_le_bytes());
        block.extend_from_slice(&1u32.to_le_bytes());
        assert_eq!(
            block_entries(&block).unwrap(),
            [
                (b"apple".to_vec(), b"1".to_vec()),
                (b"apricot".to_vec(), b"2".to_vec())
            ]
        );
    }
}
