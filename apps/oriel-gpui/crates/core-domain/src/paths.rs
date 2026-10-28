//! Archive paths, from `media-domain`'s `paths.ts`: the relative, `/`-separated paths Pane View
//! keys its library by, and the identities a sync pairs them on.
//!
//! Paths are `&str`, as the TypeScript's are strings. A name the file system gives as an `OsStr`
//! that is not Unicode has no archive path: macOS names are UTF-8, and a Windows name holding a
//! lone surrogate, which a JavaScript string can hold, must be refused or replaced before it gets
//! here (Phase 8).

use std::collections::{HashMap, HashSet};

use icu_normalizer::ComposingNormalizerBorrowed;

use crate::number::{to_fixed, v8_log};

/// The archive form of a path: backslashes become slashes, leading slashes go, and runs of
/// slashes become one. A trailing slash stays; `.` and `..` segments are kept as written.
pub fn to_archive_path(path: &str) -> String {
    let mut archive = String::with_capacity(path.len());
    for character in path.chars() {
        let character = if character == '\\' { '/' } else { character };
        if character == '/' && (archive.is_empty() || archive.ends_with('/')) {
            continue;
        }
        archive.push(character);
    }
    archive
}

/// The path without its trailing slashes. Backslashes are not slashes here.
pub fn trim_trailing_slash(path: &str) -> &str {
    path.trim_end_matches('/')
}

/// The archive path of the folder holding `path`, or `""` at the top.
pub fn get_parent_path(path: &str) -> String {
    let archive = to_archive_path(path);
    let normalized = trim_trailing_slash(&archive);
    normalized
        .rfind('/')
        .map_or_else(String::new, |separator| normalized[..separator].to_owned())
}

/// The last segment of the archive path.
pub fn get_base_name(path: &str) -> String {
    let archive = to_archive_path(path);
    let normalized = trim_trailing_slash(&archive);
    normalized
        .rfind('/')
        .map_or(normalized, |separator| &normalized[separator + 1..])
        .to_owned()
}

/// Joins the parts that are not empty with slashes, as an archive path.
pub fn join_archive_path<S: AsRef<str>>(parts: &[S]) -> String {
    let joined: Vec<&str> = parts
        .iter()
        .map(AsRef::as_ref)
        .filter(|part| !part.is_empty())
        .collect();
    to_archive_path(&joined.join("/"))
}

/// One spelling per extension for sync and storage identities: without one leading dot,
/// lowercased, and `jpeg` as `jpg`.
///
/// Lowercasing is Unicode's full mapping, as JavaScript's `toLowerCase` is: the Kelvin sign
/// becomes `k`, a dotted capital I becomes `i` and a combining dot, and a capital sigma ending
/// the extension becomes a final sigma.
pub fn canonicalize_extension(extension: &str) -> String {
    let normalized = extension
        .strip_prefix('.')
        .unwrap_or(extension)
        .to_lowercase();
    if normalized == "jpeg" {
        "jpg".to_owned()
    } else {
        normalized
    }
}

/// The identity key sync matches paths on: the archive path without its trailing slashes, in
/// NFC, lowercased, with the extension canonical (`jpeg` as `jpg`).
pub fn normalize_path_for_compare(path: &str) -> String {
    canonicalize_path_extension(normalize_path_for_compare_keeping_extensions(path))
}

/// [`normalize_path_for_compare`] with the extension as written, so `a.jpeg` and `a.jpg` differ.
/// The TypeScript asks for this with `{ canonicalizeExtensions: false }`.
pub fn normalize_path_for_compare_keeping_extensions(path: &str) -> String {
    let archive = to_archive_path(path);
    // NFC before lowercasing, as the TypeScript does: lowercasing a composed character can give
    // characters that compose no further.
    ComposingNormalizerBorrowed::new_nfc()
        .normalize(trim_trailing_slash(&archive))
        .to_lowercase()
}

/// Pairs local archive paths with the remote library paths they sync to.
///
/// The server keys library entries by exact path, so exact matches pair first. Paths left over
/// then pair across spellings, case and Unicode (NFC) first and the jpeg-jpg alias last, but only
/// when exactly one leftover local and one leftover remote share the key. A key several paths
/// could claim (`Photo.jpg` and `photo.jpg` on a case-sensitive archive) pairs nothing, so a local
/// file never updates a remote entry that belongs to a different file. A path listed twice on one
/// side claims its key twice, so it pairs nothing.
///
/// Returns each paired local path with its remote, in the order the TypeScript's map holds them:
/// by pass, then by the order the keys first appear, locals before remotes.
pub fn pair_sync_paths<'l, 'r, L: AsRef<str>, R: AsRef<str>>(
    local_paths: &'l [L],
    remote_paths: &'r [R],
) -> Vec<(&'l str, &'r str)> {
    let identities: [fn(&str) -> String; 3] = [
        |path| trim_trailing_slash(&to_archive_path(path)).to_owned(),
        normalize_path_for_compare_keeping_extensions,
        normalize_path_for_compare,
    ];
    let mut pairs = Vec::new();
    let mut paired_locals = HashSet::new();
    let mut paired_remotes = HashSet::new();

    for identity in identities {
        // Groups in the order their keys first appear, as a JavaScript `Map` iterates.
        let mut groups: Vec<(Vec<&'l str>, Vec<&'r str>)> = Vec::new();
        let mut group_of_key: HashMap<String, usize> = HashMap::new();
        let mut group_for = |key: String, groups: &mut Vec<_>| {
            *group_of_key.entry(key).or_insert_with(|| {
                groups.push((Vec::new(), Vec::new()));
                groups.len() - 1
            })
        };

        for local in local_paths.iter().map(AsRef::as_ref) {
            if !paired_locals.contains(local) {
                let group = group_for(identity(local), &mut groups);
                groups[group].0.push(local);
            }
        }
        for remote in remote_paths.iter().map(AsRef::as_ref) {
            if !paired_remotes.contains(remote) {
                let group = group_for(identity(remote), &mut groups);
                groups[group].1.push(remote);
            }
        }

        for (locals, remotes) in groups {
            if let ([local], [remote]) = (locals.as_slice(), remotes.as_slice()) {
                pairs.push((*local, *remote));
                paired_locals.insert(*local);
                paired_remotes.insert(*remote);
            }
        }
    }

    pairs
}

/// Canonicalizes the extension of an already normalized path's last segment. A dotfile, or a
/// name ending in a dot, has no extension to change.
fn canonicalize_path_extension(path: String) -> String {
    let base_start = path.rfind('/').map_or(0, |separator| separator + 1);
    let base_name = &path[base_start..];
    let dot = match base_name.rfind('.') {
        Some(dot) if dot > 0 && dot + 1 < base_name.len() => dot,
        _ => return path,
    };
    let extension = &base_name[dot + 1..];
    let canonical = canonicalize_extension(extension);
    if canonical == extension {
        return path;
    }
    format!("{}{canonical}", &path[..base_start + dot + 1])
}

/// The last segment, with underscores and hyphens shown as spaces.
pub fn display_name_from_path(path: &str) -> String {
    get_base_name(path).replace(['_', '-'], " ")
}

const BYTE_UNITS: [&str; 5] = ["B", "KB", "MB", "GB", "TB"];

/// A byte count as people read it: `"0 B"`, `"512 B"`, `"1.5 KB"`, in steps of 1024.
///
/// This keeps the TypeScript's arithmetic exactly: the unit is the floor of a ratio of V8's
/// logarithms, and the value is printed by JavaScript's `toFixed`, so a tie rounds up. So it keeps
/// its quirks too, which the vectors pin: 1,048,575 bytes is `"1024.0 KB"`, counts from just
/// under 1024 TB up have the unit `"undefined"` (the table stops at TB), as do counts under one
/// byte, and a negative count is `"NaN undefined"`.
pub fn format_bytes(bytes: f64) -> String {
    if bytes == 0.0 {
        return "0 B".to_owned();
    }
    let unit = (v8_log(bytes) / v8_log(1024.0)).floor();
    let value = bytes / power_of_1024(unit);
    let decimals = if unit == 0.0 { 0 } else { 1 };
    let unit_name = if (0.0..5.0).contains(&unit) {
        // A whole number from 0 to 4, so the cast is exact.
        BYTE_UNITS[unit as usize]
    } else {
        "undefined"
    };
    format!("{} {unit_name}", to_fixed(value, decimals))
}

/// `1024 ** exponent` for a whole exponent, or NaN: a power of two, built exactly as V8's `**`
/// returns it, including the subnormal powers that `powi` would flush to zero.
fn power_of_1024(exponent: f64) -> f64 {
    if exponent.is_nan() {
        return f64::NAN;
    }
    let power_of_two = exponent * 10.0;
    if power_of_two > 1023.0 {
        f64::INFINITY
    } else if power_of_two >= -1022.0 {
        // A whole number in range, so the casts are exact.
        f64::from_bits(((power_of_two as i64 + 1023) as u64) << 52)
    } else if power_of_two >= -1074.0 {
        f64::from_bits(1 << (power_of_two as i64 + 1074))
    } else {
        0.0
    }
}
