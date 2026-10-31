//! Naming a file's format from its first bytes, and whether its extension agrees, from
//! glazier-core's `scan/sniff.ts`.

use std::fs::File;
use std::io::Read as _;
use std::path::Path;

use crate::contract::{FileFormat, FileKind};

/// Enough bytes for every signature below, including MPEG-TS's second sync byte at 188.
const SNIFF_BYTES: usize = 512;

/// Reads a file's first bytes and names its format. An empty file is `empty`; one that cannot
/// be read is an error, which the sniff pass records as `unknown`.
pub fn sniff_file(path: &Path, size: i64) -> std::io::Result<FileFormat> {
    if size == 0 {
        return Ok(FileFormat::Empty);
    }
    let wanted = usize::try_from(size)
        .unwrap_or(SNIFF_BYTES)
        .min(SNIFF_BYTES);
    let mut buffer = vec![0; wanted];
    let mut file = File::open(path)?;
    let mut read = 0;
    while read < wanted {
        match file.read(&mut buffer[read..])? {
            0 => break,
            count => read += count,
        }
    }
    Ok(sniff_bytes(&buffer[..read]))
}

/// The bytes from `start` to `end` as Latin-1 text, clamped to what there is, as Node's
/// `buffer.subarray(start, end).toString("latin1")`.
fn latin1(bytes: &[u8], start: usize, end: usize) -> String {
    let end = end.min(bytes.len());
    let start = start.min(end);
    bytes[start..end]
        .iter()
        .map(|&byte| char::from(byte))
        .collect()
}

/// Names the format a file's leading bytes identify.
pub fn sniff_bytes(bytes: &[u8]) -> FileFormat {
    use FileFormat::*;

    if bytes.is_empty() {
        return Empty;
    }
    let ascii = |start, end| latin1(bytes, start, end);
    let starts = |signature: &[u8]| bytes.starts_with(signature);

    if starts(&[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) {
        return Png;
    }
    if starts(&[0xff, 0xd8, 0xff]) {
        return Jpeg;
    }
    if ascii(0, 6) == "GIF87a" || ascii(0, 6) == "GIF89a" {
        return Gif;
    }
    if ascii(0, 4) == "RIFF" {
        return match ascii(8, 12).as_str() {
            "WEBP" => Webp,
            "AVI " => Avi,
            "WAVE" => Wav,
            _ => Unknown,
        };
    }
    if ascii(4, 8) == "ftyp" {
        return sniff_iso_brand(bytes);
    }
    if starts(&[0x1a, 0x45, 0xdf, 0xa3]) {
        return if ascii(0, bytes.len()).contains("webm") {
            Webm
        } else {
            Matroska
        };
    }
    if bytes[0] == 0x47 && bytes.len() > 188 && bytes[188] == 0x47 {
        return Mpegts;
    }
    if ascii(0, 2) == "BM" {
        return Bmp;
    }
    if ascii(0, 4) == "II*\u{0}" || ascii(0, 4) == "MM\u{0}*" {
        return Tiff;
    }
    if ascii(0, 4) == "8BPS" {
        return Psd;
    }
    if ascii(0, 4) == "%PDF" {
        return Pdf;
    }
    if ascii(0, 3) == "FLV" {
        return Flv;
    }
    if starts(&[0x30, 0x26, 0xb2, 0x75, 0x8e, 0x66, 0xcf, 0x11]) {
        return Asf;
    }
    if starts(&[0x50, 0x4b, 0x03, 0x04]) {
        return Zip;
    }
    if ascii(0, 4) == "Rar!" {
        return Rar;
    }
    if starts(&[0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]) {
        return SevenZ;
    }
    if ascii(0, 4) == "fLaC" {
        return Flac;
    }
    if ascii(0, 4) == "OggS" {
        return Ogg;
    }
    if ascii(0, 3) == "ID3"
        || (bytes[0] == 0xff && (bytes.get(1).copied().unwrap_or(0) & 0xe0) == 0xe0)
    {
        return Mp3;
    }

    // `trimStart` on Latin-1 text: JavaScript's white space and line ends in that range, the
    // no-break space among them. Only ASCII letters matter to the tests, so ASCII lowercasing
    // is `toLowerCase` here.
    let leading = ascii(0, bytes.len().min(256));
    let leading = leading
        .trim_start_matches(['\t', '\n', '\u{b}', '\u{c}', '\r', ' ', '\u{a0}'])
        .to_ascii_lowercase();
    if leading.starts_with("<svg") || (leading.starts_with("<?xml") && leading.contains("<svg")) {
        return Svg;
    }
    Unknown
}

/// ISO base media files name their flavour in the `ftyp` box: major brand, then compatibles.
fn sniff_iso_brand(bytes: &[u8]) -> FileFormat {
    let box_size = u32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]) as usize;
    let end = bytes.len().min(box_size.max(16));
    let mut brands = Vec::new();
    let mut offset = 8;
    while offset + 4 <= end {
        // Bytes 12–16 are the minor version, not a brand.
        if offset != 12 {
            brands.push(latin1(bytes, offset, offset + 4));
        }
        offset += 4;
    }
    let major = brands.first().map_or("", String::as_str);
    let has = |brand: &str| brands.iter().any(|candidate| candidate == brand);
    match major {
        "avif" | "avis" => FileFormat::Avif,
        "heic" | "heix" | "hevc" | "hevx" | "heim" | "heis" => FileFormat::Heic,
        "mif1" | "msf1" if has("avif") || has("avis") => FileFormat::Avif,
        "mif1" | "msf1" => FileFormat::Heic,
        "qt  " => FileFormat::Mov,
        "M4A " | "M4B " => FileFormat::M4a,
        _ => FileFormat::Mp4,
    }
}

/// What a file of this format is.
pub fn kind_for_format(format: FileFormat) -> FileKind {
    use FileFormat::*;
    match format {
        Png | Jpeg | Gif | Webp | Bmp | Tiff | Avif | Heic => FileKind::Image,
        Mp4 | Mov | Matroska | Webm | Mpegts | Avi | Flv | Asf => FileKind::Video,
        Mp3 | M4a | Wav | Flac | Ogg => FileKind::Audio,
        Pdf => FileKind::Pdf,
        Psd | Svg | Zip | Rar | SevenZ | Empty | Unknown => FileKind::Other,
    }
}

/// The extensions each format is correctly named with; an empty list accepts any extension.
pub fn format_extensions(format: FileFormat) -> &'static [&'static str] {
    use FileFormat::*;
    match format {
        Png => &["png", "apng"],
        Jpeg => &["jpg", "jpeg", "jpe", "jfif"],
        Gif => &["gif"],
        Webp => &["webp"],
        Bmp => &["bmp", "dib"],
        Tiff => &["tif", "tiff", "dng", "nef", "cr2", "arw"],
        Avif => &["avif"],
        Heic => &["heic", "heif", "hif"],
        Psd => &["psd", "psb"],
        Svg => &["svg"],
        Mp4 => &["mp4", "m4v", "3gp", "3g2", "f4v"],
        Mov => &["mov", "qt"],
        Matroska => &["mkv", "mka", "mk3d"],
        Webm => &["webm"],
        Mpegts => &["ts", "mts", "m2ts", "tsv"],
        Avi => &["avi"],
        Flv => &["flv"],
        Asf => &["wmv", "wma", "asf"],
        Mp3 => &["mp3"],
        M4a => &["m4a", "m4b", "aac"],
        Wav => &["wav"],
        Flac => &["flac"],
        Ogg => &["ogg", "oga", "ogv", "opus"],
        Pdf => &["pdf"],
        Zip => &[
            "zip", "cbz", "epub", "docx", "xlsx", "pptx", "jar", "apk", "ipa", "pages", "key",
            "numbers",
        ],
        Rar => &["rar", "cbr"],
        SevenZ => &["7z", "cb7"],
        Empty | Unknown => &[],
    }
}

/// Archive formats other file types are built on: zip bytes say little about what a file is for
/// (a game's `.zipmod`, an add-on, a document), and a `.r00` or `.7z.001` is one part of a split
/// archive. Such a file's extension is wrong only when it names another format here.
fn is_container_format(format: FileFormat) -> bool {
    matches!(
        format,
        FileFormat::Zip | FileFormat::Rar | FileFormat::SevenZ
    )
}

fn is_known_extension(extension: &str) -> bool {
    FileFormat::ALL
        .iter()
        .any(|&format| format_extensions(format).contains(&extension))
}

/// True when the bytes are a known format the file's extension does not name.
pub fn is_extension_mismatch(format: FileFormat, ext: &str) -> bool {
    let accepted = format_extensions(format);
    let extension = ext.to_lowercase();
    if accepted.is_empty() || accepted.contains(&extension.as_str()) {
        return false;
    }
    !is_container_format(format) || is_known_extension(&extension)
}

/// The extension a file of this format is renamed to when its own is wrong.
pub fn preferred_extension(format: FileFormat) -> Option<&'static str> {
    format_extensions(format).first().copied()
}
