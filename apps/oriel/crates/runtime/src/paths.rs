//! [`canonicalize`] is Node's `fs.realpath`, so what Oriel stores and shows matches the paths
//! Node wrote: std's `canonicalize` gives a verbatim path (`\\?\C:\…`,
//! `\\?\UNC\server\share\…`) on Windows, where libuv takes the prefix off again. Elsewhere it
//! is std's own. The long form libvips opens is `oriel_vips`'s.

use std::io;
use std::path::{Path, PathBuf};

/// A folder or file's absolute path with every link resolved, as Node's `fs.realpath` gives it:
/// on Windows without the verbatim prefix, so it reads, stores and compares as Electron Oriel's
/// paths do.
pub fn canonicalize(path: &Path) -> io::Result<PathBuf> {
    std::fs::canonicalize(path).map(without_verbatim)
}

/// `path` without the verbatim prefix of a drive or a share, as libuv's `realpath` takes it off:
/// `\\?\C:\a` is `C:\a`, `\\?\UNC\server\share\a` is `\\server\share\a`. Any other path, such
/// as a volume GUID's, which has no other spelling, is given back as it is.
fn without_verbatim(path: PathBuf) -> PathBuf {
    #[cfg(windows)]
    {
        use std::path::{Component, Prefix};
        let plain = match (path.components().next(), path.to_str()) {
            (Some(Component::Prefix(prefix)), Some(text)) => match prefix.kind() {
                Prefix::VerbatimDisk(_) => text.strip_prefix(r"\\?\").map(str::to_owned),
                Prefix::VerbatimUNC(..) => text
                    .strip_prefix(r"\\?\UNC\")
                    .map(|share| format!(r"\\{share}")),
                _ => None,
            },
            _ => None,
        };
        if let Some(plain) = plain {
            return PathBuf::from(plain);
        }
    }
    path
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(windows)]
    #[test]
    fn verbatim_prefixes_come_off_as_libuv_takes_them_off() {
        let strip = |text: &str| {
            let path = without_verbatim(PathBuf::from(text));
            path.to_str().unwrap().to_owned()
        };
        assert_eq!(strip(r"\\?\C:\Photos\a"), r"C:\Photos\a");
        assert_eq!(strip(r"\\?\D:\"), r"D:\");
        assert_eq!(strip(r"\\?\UNC\nas\media\Photos"), r"\\nas\media\Photos");
        assert_eq!(strip(r"\\?\Volume{0b1}\Photos"), r"\\?\Volume{0b1}\Photos");
        assert_eq!(strip(r"C:\Photos"), r"C:\Photos");
    }

    #[cfg(not(windows))]
    #[test]
    fn paths_elsewhere_are_given_back_as_they_are() {
        assert_eq!(
            canonicalize(&std::env::temp_dir()).unwrap(),
            std::fs::canonicalize(std::env::temp_dir()).unwrap()
        );
    }

    #[cfg(windows)]
    #[test]
    fn windows_paths_read_as_node_gives_them() {
        let real = canonicalize(&std::env::temp_dir()).unwrap();
        assert!(
            !real.to_string_lossy().starts_with(r"\\?\"),
            "{}",
            real.display()
        );
    }
}
