//! Paths as Node writes them on Windows, so what Oriel RS stores and shows matches Electron
//! Oriel's, and what it hands a C library opens however long it is. Elsewhere each function is
//! std's own, or gives the path back unchanged.
//!
//! - [`canonicalize`] is Node's `fs.realpath`: std's `canonicalize` gives a verbatim path
//!   (`\\?\C:\…`, `\\?\UNC\server\share\…`) on Windows, where libuv takes the prefix off again.
//! - [`namespaced`] is Node's `path.toNamespacedPath`: the `\\?\` form a library needs to open a
//!   path past 260 characters. std's own file calls add it themselves where a path needs it;
//!   libvips does not, even with long paths enabled (plan 062).

use std::io;
use std::path::{Path, PathBuf};

/// A folder or file's absolute path with every link resolved, as Node's `fs.realpath` gives it:
/// on Windows without the verbatim prefix, so it reads, stores and compares as Electron Oriel's
/// paths do.
pub fn canonicalize(path: &Path) -> io::Result<PathBuf> {
    std::fs::canonicalize(path).map(without_verbatim)
}

/// `path` without the verbatim prefix of a drive or a share, as libuv's `realpath` takes it off;
/// any other path is given back as it is.
pub fn without_verbatim(path: PathBuf) -> PathBuf {
    #[cfg(windows)]
    if let Some(plain) = path.to_str().and_then(without_verbatim_text) {
        return PathBuf::from(plain);
    }
    path
}

/// The form of `path` a library opens on Windows whatever its length, as Node's
/// `path.toNamespacedPath` gives it: an absolute drive path gets the `\\?\` prefix and a share
/// `\\?\UNC\`, with its separators made `\` and its `.` and `..` resolved, which Windows does not
/// do behind that prefix. Anything else, and every path elsewhere, is given back as it is.
pub fn namespaced(path: &Path) -> PathBuf {
    #[cfg(windows)]
    {
        let absolute = if path.is_absolute() {
            path.to_path_buf()
        } else {
            std::path::absolute(path).unwrap_or_else(|_| path.to_path_buf())
        };
        if let Some(namespaced) = absolute.to_str().and_then(namespaced_text) {
            return PathBuf::from(namespaced);
        }
    }
    path.to_path_buf()
}

/// [`without_verbatim`] on text: `\\?\C:\a` is `C:\a`, `\\?\UNC\server\share\a` is
/// `\\server\share\a`.
#[cfg(any(windows, test))]
fn without_verbatim_text(text: &str) -> Option<String> {
    if let Some(share) = text.strip_prefix(r"\\?\UNC\") {
        return Some(format!(r"\\{share}"));
    }
    let rest = text.strip_prefix(r"\\?\")?;
    is_drive_rooted(rest).then(|| rest.to_owned())
}

/// `C:\…`: a drive letter, a colon and a separator.
#[cfg(any(windows, test))]
fn is_drive_rooted(text: &str) -> bool {
    let bytes = text.as_bytes();
    bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && matches!(bytes[2], b'\\' | b'/')
}

/// [`namespaced`] on an absolute path's text; `None` for one already verbatim or a device's, or
/// one that is not absolute.
#[cfg(any(windows, test))]
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
    fn verbatim_prefixes_come_off_as_libuv_takes_them_off() {
        let strip = |text: &str| without_verbatim_text(text);
        assert_eq!(strip(r"\\?\C:\Photos\a").as_deref(), Some(r"C:\Photos\a"));
        assert_eq!(strip(r"\\?\D:\").as_deref(), Some(r"D:\"));
        assert_eq!(
            strip(r"\\?\UNC\nas\media\Photos").as_deref(),
            Some(r"\\nas\media\Photos")
        );
        // A volume GUID path has no other spelling, so it stays.
        assert_eq!(strip(r"\\?\Volume{0b1}\Photos"), None);
        assert_eq!(strip(r"C:\Photos"), None);
    }

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

    #[test]
    fn paths_elsewhere_are_given_back_as_they_are() {
        if cfg!(windows) {
            return;
        }
        let path = Path::new("/tmp/./a/../b.jpg");
        assert_eq!(namespaced(path), path);
        assert_eq!(without_verbatim(path.to_path_buf()), path);
    }
}
