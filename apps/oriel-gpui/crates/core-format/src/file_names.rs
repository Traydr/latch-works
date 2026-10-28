//! File names, from `media-format`'s `file-names.ts`.

/// The lowercased extension of a file name or path's last segment, without the dot, or `""`
/// when it has none. Both `/` and `\` end a segment, and a dotfile (`.jpg`) has no extension.
pub fn get_file_extension(file_name: &str) -> String {
    let last_segment = file_name.rsplit(['/', '\\']).next().unwrap_or(file_name);
    match last_segment.rfind('.') {
        Some(dot) if dot > 0 => last_segment[dot + 1..].to_lowercase(),
        _ => String::new(),
    }
}

/// Swaps a file name's extension for `extension`, or appends it when the last segment has none.
///
/// A dotfile keeps its name and gains the extension (`.jpg` becomes `.jpg.avif`), and a name
/// ending in a dot loses the dot (`photo.` becomes `photo.avif`), as in the TypeScript.
pub fn replace_file_extension(file_name: &str, extension: &str) -> String {
    let segment_start = file_name.rfind(['/', '\\']).map_or(0, |slash| slash + 1);
    let base_name = match file_name.rfind('.') {
        Some(dot) if dot > segment_start => &file_name[..dot],
        _ => file_name,
    };
    format!("{base_name}.{extension}")
}
