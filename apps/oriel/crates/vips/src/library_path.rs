//! The path Oriel hands libvips on Windows, as Node's `path.toNamespacedPath` writes it. std's own
//! file calls add the `\\?\` prefix themselves where a path needs it; libvips does not, and opens
//! no path past 260 characters without it, even with long paths enabled (plan 062).

#[cfg(not(unix))]
use std::path::{Path, PathBuf};

/// The form of `path` libvips opens whatever its length, as Node's `path.toNamespacedPath` gives
/// it: an absolute drive path gets the `\\?\` prefix and a share `\\?\UNC\`, with its separators
/// made `\` and its `.` and `..` resolved, which Windows does not do behind that prefix. Anything
/// else is given back as it is.
#[cfg(not(unix))]
pub(crate) fn namespaced(path: &Path) -> PathBuf {
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::path::absolute(path).unwrap_or_else(|_| path.to_path_buf())
    };
    match absolute.to_str().and_then(namespaced_text) {
        Some(namespaced) => PathBuf::from(namespaced),
        None => path.to_path_buf(),
    }
}

/// `C:\…`: a drive letter, a colon and a separator.
fn is_drive_rooted(text: &str) -> bool {
    let bytes = text.as_bytes();
    bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && matches!(bytes[2], b'\\' | b'/')
}

/// [`namespaced`] on an absolute path's text; `None` for one already verbatim or a device's, or
/// one that is not absolute.
fn namespaced_text(text: &str) -> Option<String> {
    let text = text.replace('/', r"\");
    if text.starts_with(r"\\?\") || text.starts_with(r"\\.\") {
        return None;
    }
    let (mut namespaced, rest) = if let Some(unc) = text.strip_prefix(r"\\") {
        // A share's server and name are its root, which `..` never climbs past.
        let mut parts = unc.splitn(3, '\\');
        let (server, share) = (parts.next()?, parts.next()?);
        if server.is_empty() || share.is_empty() {
            return None;
        }
        (
            format!(r"\\?\UNC\{server}\{share}"),
            parts.next().unwrap_or(""),
        )
    } else if is_drive_rooted(&text) {
        (format!(r"\\?\{}", &text[..2]), &text[3..])
    } else {
        return None;
    };
    let mut segments: Vec<&str> = Vec::new();
    for segment in rest.split('\\') {
        match segment {
            "" | "." => {}
            ".." => {
                segments.pop();
            }
            segment => segments.push(segment),
        }
    }
    if segments.is_empty() {
        namespaced.push('\\');
    }
    for segment in segments {
        namespaced.push('\\');
        namespaced.push_str(segment);
    }
    Some(namespaced)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn namespaced_paths_read_as_nodes_to_namespaced_path() {
        let namespaced = |text: &str| namespaced_text(text);
        assert_eq!(
            namespaced(r"C:\Photos\2024\a.avif").as_deref(),
            Some(r"\\?\C:\Photos\2024\a.avif")
        );
        assert_eq!(
            namespaced("C:/Photos/./2024/../a b.jpg").as_deref(),
            Some(r"\\?\C:\Photos\a b.jpg")
        );
        assert_eq!(namespaced(r"D:\").as_deref(), Some(r"\\?\D:\"));
        assert_eq!(namespaced(r"D:\..\..").as_deref(), Some(r"\\?\D:\"));
        assert_eq!(
            namespaced(r"\\nas\media\Photos\..\a.jpg").as_deref(),
            Some(r"\\?\UNC\nas\media\a.jpg")
        );
        assert_eq!(namespaced(r"\\?\C:\Photos"), None);
        assert_eq!(namespaced(r"\\.\pipe\x"), None);
        assert_eq!(namespaced(r"Photos\a.jpg"), None);
        assert_eq!(namespaced(r"\\nas"), None);
    }

    #[cfg(windows)]
    #[test]
    fn windows_paths_read_as_node_gives_them() {
        assert_eq!(
            namespaced(Path::new(r"C:\Photos\..\b.jpg")),
            Path::new(r"\\?\C:\b.jpg")
        );
        let real = std::fs::canonicalize(std::env::temp_dir()).unwrap();
        let plain = real.to_str().unwrap().strip_prefix(r"\\?\").unwrap();
        assert_eq!(namespaced(Path::new(plain)), real);
    }
}
