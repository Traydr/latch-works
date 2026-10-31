//! The ffmpeg and ffprobe builds Oriel runs, by URL and SHA-256: the builds Electron Oriel
//! pinned, so Tidy's outputs stayed the same across the port.
//!
//! Tidy needs these rather than any ffmpeg (plan 060): `ffmpeg-static`'s 6.0 has an SVT-AV1 that
//! runs without SIMD on Apple silicon, about 16 times slower, and no SVT-AV1 at all on Windows.
//! The Mac's are Martin Riedl's static builds and Windows' is gyan.dev's full build, both linked
//! from ffmpeg.org: ffmpeg 9.0.2 with SVT-AV1 4.2, dav1d, x264 and x265, GPLv3.

/// A download and the SHA-256 it has to match before anything unpacks it.
#[derive(Debug)]
pub struct PinnedArchive {
    pub url: &'static str,
    pub sha256: &'static str,
}

/// One platform's pinned build.
#[derive(Debug)]
pub struct MediaToolsPin {
    /// Node's `${process.platform}-${process.arch}`, as Electron Oriel names its cache folders.
    pub platform: &'static str,
    pub version: &'static str,
    /// The zips that hold ffmpeg and ffprobe, wherever in each zip's folder tree they sit.
    pub archives: &'static [PinnedArchive],
}

pub const PINS: &[MediaToolsPin] = &[
    MediaToolsPin {
        platform: "darwin-arm64",
        version: "9.0.2",
        archives: &[
            PinnedArchive {
                url: "https://ffmpeg.martin-riedl.de/download/macos/arm64/1789931890_9.0.2/ffmpeg.zip",
                sha256: "c8ed4c4e6978a03c485edbfe4e0a5dc2380f8a30bba5150531b31b094492d924",
            },
            PinnedArchive {
                url: "https://ffmpeg.martin-riedl.de/download/macos/arm64/1789931890_9.0.2/ffprobe.zip",
                sha256: "fcbe839537485eaee7a7a8bc5cbc0f90d53617e80943e8a5b2e31cb851197ea6",
            },
        ],
    },
    MediaToolsPin {
        platform: "win32-x64",
        version: "9.0.2",
        archives: &[PinnedArchive {
            url: "https://github.com/GyanD/codexffmpeg/releases/download/9.0.2/ffmpeg-9.0.2-full_build.zip",
            sha256: "759d0a9831c436a0eb331ad36f236c06cb04aaa0005da46571f0e9d3d9206f6b",
        }],
    },
];

/// The platform this was built for, in Node's spelling (`darwin-arm64`, `win32-x64`).
pub fn current_platform() -> String {
    let os = match std::env::consts::OS {
        "macos" => "darwin",
        "windows" => "win32",
        other => other,
    };
    let arch = match std::env::consts::ARCH {
        "aarch64" => "arm64",
        "x86_64" => "x64",
        other => other,
    };
    format!("{os}-{arch}")
}

/// The pin for `platform`, or `None` where nothing is pinned.
pub fn pin_for(platform: &str) -> Option<&'static MediaToolsPin> {
    PINS.iter().find(|pin| pin.platform == platform)
}

/// The tools' file names on `platform`: `ffmpeg` and `ffprobe`, with `.exe` on Windows.
pub fn tool_files(platform: &str) -> [&'static str; 2] {
    if platform.starts_with("win32") {
        ["ffmpeg.exe", "ffprobe.exe"]
    } else {
        ["ffmpeg", "ffprobe"]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn platforms_are_named_as_node_names_them() {
        if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
            assert_eq!(current_platform(), "darwin-arm64");
        }
        assert_eq!(tool_files("win32-x64"), ["ffmpeg.exe", "ffprobe.exe"]);
        assert_eq!(tool_files("darwin-arm64"), ["ffmpeg", "ffprobe"]);
    }
}
