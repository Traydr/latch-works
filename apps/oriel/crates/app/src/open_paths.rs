//! Files and folders the system hands the app: dropped on the Dock icon, opened with Oriel
//! from Finder, or given to a second launch. View opens each (`Shell::open_in_view`).

use std::ffi::OsString;
use std::path::{Path, PathBuf};

/// The local paths among the URLs macOS sends (`file:///…`, percent-encoded); anything else,
/// such as a web address, is left out.
pub fn from_urls(urls: &[String]) -> Vec<PathBuf> {
    urls.iter()
        .filter_map(|url| url::Url::parse(url).ok())
        .filter(|url| url.scheme() == "file")
        .filter_map(|url| url.to_file_path().ok())
        .collect()
}

/// The first argument that names an existing file or folder, as Electron Oriel's
/// `extractLaunchPathFromArgv` finds it: options and the program itself are skipped.
pub fn from_args(args: impl IntoIterator<Item = OsString>, executable: &Path) -> Option<PathBuf> {
    let cwd = std::env::current_dir().ok()?;
    args.into_iter()
        .filter(|arg| !arg.is_empty() && !arg.to_string_lossy().starts_with('-'))
        .map(|arg| cwd.join(arg))
        .find(|path| path != executable && path.exists())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn takes_local_paths_from_urls() {
        let urls = [
            "file:///Users/someone/Pictures/Holiday%202024/".to_string(),
            "https://example.com/photo.jpg".to_string(),
            "file:///tmp/a.jpg".to_string(),
            "not a url".to_string(),
        ];
        assert_eq!(
            from_urls(&urls),
            [
                PathBuf::from("/Users/someone/Pictures/Holiday 2024/"),
                PathBuf::from("/tmp/a.jpg"),
            ]
        );
    }

    #[test]
    fn finds_the_first_existing_path_among_the_arguments() {
        let folder = std::env::temp_dir();
        let executable = PathBuf::from("/Applications/Oriel.app/Contents/MacOS/oriel");
        let args = [
            OsString::from("-psn_0_12345"),
            OsString::from("/no/such/folder"),
            folder.clone().into_os_string(),
        ];
        assert_eq!(from_args(args, &executable), Some(folder));
        assert_eq!(from_args([OsString::from("--flag")], &executable), None);
    }
}
