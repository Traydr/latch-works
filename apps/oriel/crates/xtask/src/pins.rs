//! Every prebuilt download Oriel ships, each pinned by URL and SHA-256 (the owner's decision of
//! 2026-10-29: prebuilt binaries over builds from source): the Mac's libvips and libavif sets,
//! Windows' libmpv, libvips and libavif, and both systems' ffmpeg and ffprobe. Changing a Mac set's
//! pin changes its id, so a new set is fetched beside the old one. The LGPL libmpv for macOS is
//! built from source, and its sources are pinned with its recipe (`libmpv/sources.rs`).

use crate::support::Download;

/// Bump when the steps that lay a set out change in a way the pins below do not show. 2: a
/// relocated set's libraries are stripped of their local symbols.
pub const VENDOR_REVISION: u32 = 2;

/// The anonymous token GitHub's container registry takes for public images such as Homebrew's.
const GHCR_TOKEN: &str = "Authorization: Bearer QQ==";

/// One downloaded package, verified before anything unpacks it.
pub struct Package {
    pub name: &'static str,
    pub version: &'static str,
    pub url: &'static str,
    pub sha256: &'static str,
    /// The name it is kept under in the download cache.
    pub file: &'static str,
    pub headers: &'static [&'static str],
    /// How the pinned hash was checked against the publisher, beyond trusting the first download.
    pub hash_checked_against: &'static str,
    /// SPDX expression for the terms the set uses it under.
    pub licence: &'static str,
    /// Leading folders the archive holds everything under: npm's `package/`, a bottle's
    /// `<formula>/<version>/`.
    pub strip: u32,
    /// The dylibs it provides, by the file name of their install names, in its `lib/`.
    pub libraries: &'static [&'static str],
    /// Licence and notice files in the unpacked package, copied into `licenses/<name>/`.
    pub licence_files: &'static [&'static str],
}

/// A notice a package needs but does not carry, taken from its publisher's source release.
pub struct Notice {
    pub package: &'static str,
    pub url: &'static str,
    pub sha256: &'static str,
    pub file: &'static str,
    pub hash_checked_against: &'static str,
    /// The notice's path inside the archive.
    pub member: &'static str,
}

/// How a set's files are laid out in its folder.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Layout {
    /// The package's own `lib/` folder, untouched: sharp's libvips is used exactly as sharp
    /// ships it, since Tidy's fingerprints were tuned on that build and match only through it.
    PackageLib,
    /// Every library side by side, renamed `@rpath/<file>` and finding the others through
    /// `@loader_path`, as the libmpv set is, so the set can sit in `Contents/Frameworks`.
    Relocated,
}

pub struct VendorSet {
    /// The folder under `.vendor/`, and the command line's name for the set.
    pub name: &'static str,
    /// The id's readable part; a hash of the pins follows it.
    pub label: &'static str,
    pub layout: Layout,
    /// The library the app loads; every other one is there because it needs it.
    pub entry: &'static str,
    /// Header folders kept beside the libraries, relative to the entry's package.
    pub include: &'static [&'static str],
    pub licence: &'static str,
    pub packages: &'static [Package],
    pub notices: &'static [Notice],
}

/// sharp's own libvips build for macOS arm64, the one sharp 0.35.5 installs here (the
/// `@img/sharp-libvips-darwin-arm64@1.3.4` in `pnpm-lock.yaml`): libvips 8.18.7 with everything
/// it uses linked into one dylib that needs only the system.
pub const LIBVIPS: VendorSet = VendorSet {
    name: "libvips",
    label: "vips-8.18.7-sharp-1.3.4",
    layout: Layout::PackageLib,
    entry: "libvips-cpp.8.18.7.dylib",
    include: &[],
    licence: "LGPL-3.0-or-later as a whole: libvips, GLib, libheif, librsvg, pango and others are \
              LGPL; the rest are permissive. README.md lists each library and its terms.",
    packages: &[Package {
        name: "sharp-libvips-darwin-arm64",
        version: "1.3.4",
        url: "https://registry.npmjs.org/@img/sharp-libvips-darwin-arm64/-/sharp-libvips-darwin-arm64-1.3.4.tgz",
        sha256: "e8350e62344d027995ef46cdd97a5ea1c88bc54ab82ab8c3fcb0c076d839675f",
        file: "sharp-libvips-darwin-arm64-1.3.4.tgz",
        headers: &[],
        hash_checked_against: "the npm registry's sha512 integrity (sha512-5R89nBYiRdUlSWJxPhO+GVt\
                               aXzXSxKnRu/xqMn3KTA3L9EB9Oy/P+Nn2f2vlhPuUdy/Zusb2DarbyTpGCfEDuw==), \
                               the same as pnpm-lock.yaml's",
        licence: "LGPL-3.0-or-later",
        strip: 1,
        libraries: &["libvips-cpp.8.18.7.dylib"],
        // The package carries no licence texts; its README is the table of what it links and
        // under which terms, and versions.json each library's version.
        licence_files: &["README.md", "versions.json", "package.json"],
    }],
    notices: &[],
};

/// libavif with aom as its AV1 encoder: Homebrew's bottles for macOS 15 (`arm64_sequoia`, the
/// oldest macOS Homebrew still builds aom for), fetched from Homebrew's registry by digest.
/// libavif publishes only command-line tools for macOS, no library. aom brings libvmaf, and
/// libavif links dav1d for decoding, which the encoder never uses but needs to load.
pub const LIBAVIF: VendorSet = VendorSet {
    name: "libavif",
    label: "avif-1.4.2-aom-3.15.2",
    layout: Layout::Relocated,
    entry: "libavif.16.dylib",
    include: &["include/avif"],
    licence: "BSD-2-Clause as a whole: libavif, aom and dav1d are BSD-2-Clause and libvmaf is \
              BSD-2-Clause-Patent; aom also grants the Alliance for Open Media Patent License 1.0.",
    packages: &[
        Package {
            name: "libavif",
            version: "1.4.2",
            url: "https://ghcr.io/v2/homebrew/core/libavif/blobs/sha256:0d1a9ce6320d9ddacb3e7ca31bb2ef3216529755ab1df24eac833fec27b25c95",
            sha256: "0d1a9ce6320d9ddacb3e7ca31bb2ef3216529755ab1df24eac833fec27b25c95",
            file: "libavif-1.4.2.arm64_sequoia.bottle.tar.gz",
            headers: &[GHCR_TOKEN],
            hash_checked_against: "Homebrew's formula API (formulae.brew.sh/api/formula/libavif.json), \
                                   whose bottle sha256 is the blob's digest in the URL",
            licence: "BSD-2-Clause",
            strip: 2,
            libraries: &["libavif.16.dylib"],
            licence_files: &["LICENSE", "sbom.spdx.json"],
        },
        Package {
            name: "aom",
            version: "3.15.2",
            url: "https://ghcr.io/v2/homebrew/core/aom/blobs/sha256:d8b133d6a8e7b2193f34f2f3cbc2cb327e8898331432daf2cc4cb84164871b35",
            sha256: "d8b133d6a8e7b2193f34f2f3cbc2cb327e8898331432daf2cc4cb84164871b35",
            file: "aom-3.15.2.arm64_sequoia.bottle.tar.gz",
            headers: &[GHCR_TOKEN],
            hash_checked_against: "Homebrew's formula API (formulae.brew.sh/api/formula/aom.json), \
                                   whose bottle sha256 is the blob's digest in the URL",
            licence: "BSD-2-Clause",
            strip: 2,
            libraries: &["libaom.3.dylib"],
            licence_files: &["LICENSE", "AUTHORS", "sbom.spdx.json"],
        },
        Package {
            name: "libvmaf",
            version: "3.2.1",
            url: "https://ghcr.io/v2/homebrew/core/libvmaf/blobs/sha256:d3cf35724639ceb6d9d92ee25a7fa4953f7ff952dc4be90aa83eb006910248b4",
            sha256: "d3cf35724639ceb6d9d92ee25a7fa4953f7ff952dc4be90aa83eb006910248b4",
            file: "libvmaf-3.2.1.arm64_sequoia.bottle.tar.gz",
            headers: &[GHCR_TOKEN],
            hash_checked_against: "Homebrew's formula API (formulae.brew.sh/api/formula/libvmaf.json), \
                                   whose bottle sha256 is the blob's digest in the URL",
            licence: "BSD-2-Clause-Patent",
            strip: 2,
            libraries: &["libvmaf.3.dylib"],
            licence_files: &["LICENSE", "sbom.spdx.json"],
        },
        Package {
            name: "dav1d",
            version: "1.5.4",
            url: "https://ghcr.io/v2/homebrew/core/dav1d/blobs/sha256:5f573db161c0685ba7e8d27bd3b6a494e6952e47c7c99355a0d090b253b566af",
            sha256: "5f573db161c0685ba7e8d27bd3b6a494e6952e47c7c99355a0d090b253b566af",
            file: "dav1d-1.5.4.arm64_sequoia.bottle.tar.gz",
            headers: &[GHCR_TOKEN],
            hash_checked_against: "Homebrew's formula API (formulae.brew.sh/api/formula/dav1d.json), \
                                   whose bottle sha256 is the blob's digest in the URL",
            licence: "BSD-2-Clause",
            strip: 2,
            libraries: &["libdav1d.7.dylib"],
            licence_files: &["COPYING", "sbom.spdx.json"],
        },
    ],
    // Homebrew's bottle leaves out aom's patent grant, which its source release carries.
    notices: &[Notice {
        package: "aom",
        url: "https://storage.googleapis.com/aom-releases/libaom-3.15.2.tar.gz",
        sha256: "67bb54b245f33ed98600e08269e6139986e48114e14042474ddd8885801dfddc",
        file: "libaom-3.15.2.tar.gz",
        hash_checked_against: "nothing published beside it; pinned on first use",
        member: "libaom-3.15.2/PATENTS",
    }],
};

pub const SETS: [&VendorSet; 2] = [&LIBVIPS, &LIBAVIF];

/// One file out of a pinned archive, staged into the Windows package.
pub struct PinnedFile {
    pub name: &'static str,
    pub version: &'static str,
    pub licence: &'static str,
    pub download: Download<'static>,
    /// The archive's member, and the name it is staged under.
    pub member: &'static str,
    pub staged: &'static str,
    /// Members copied into the set's licence folder.
    pub licence_members: &'static [&'static str],
    /// What the notice says about the source.
    pub source: &'static str,
}

/// Windows' libmpv: shinchiro's `mpv-dev-x86_64` build, GPL (fine for the owner's own use).
pub const WINDOWS_LIBMPV: PinnedFile = PinnedFile {
    name: "libmpv",
    version: "mpv-dev-x86_64-20261021-git-e471496c56",
    licence: "GPL-3.0-or-later",
    download: Download {
        urls: &[
            "https://github.com/shinchiro/mpv-winbuild-cmake/releases/download/20261021/mpv-dev-x86_64-20261021-git-e471496c56.7z",
        ],
        // GitHub's own digest of the release asset, and this file's.
        sha256: "efc719eff3dc5954b4a5efc800632808bcec01cc9034940dd14e5eb7fe9ea633",
        file: "mpv-dev-x86_64-20261021-git-e471496c56.7z",
        headers: &[],
    },
    member: "libmpv-2.dll",
    staged: "libmpv-2.dll",
    licence_members: &[],
    source: "shinchiro's mpv-winbuild-cmake, release 20261021: mpv at commit e471496c56 with \
             FFmpeg and its libraries built with GPL parts enabled. The build scripts and the \
             pinned versions of every library are at \
             https://github.com/shinchiro/mpv-winbuild-cmake/tree/20261021, and mpv's source at \
             https://github.com/mpv-player/mpv/commit/e471496c56.",
};

/// Windows' libvips: sharp's `@img/sharp-libvips-win32-x64`, the same libvips release as the
/// Mac's [`LIBVIPS`], with libheif and aom, so it decodes AVIF and HEIC.
pub const WINDOWS_LIBVIPS: PinnedFile = PinnedFile {
    name: "libvips",
    version: "vips-8.18.7-sharp-1.3.4",
    licence: "LGPL-3.0-or-later as a whole; README.md lists each library and its terms",
    download: Download {
        urls: &[
            "https://registry.npmjs.org/@img/sharp-libvips-win32-x64/-/sharp-libvips-win32-x64-1.3.4.tgz",
        ],
        // Checked against the npm registry's sha512 integrity, sha512-7q6lQ6O26YHPLJfF7kMpuE5ZB0Y
        // ht898FXlYEUBCLgc0ffmLvJpZ/jYq1FyjTRCDmgc/t7GYQySEfGgh7+b8VA==.
        sha256: "3d6d4c909ffcf72d70b7d42a29fd8c69b71fd8afa786ce46cd88ebadfd187114",
        file: "sharp-libvips-win32-x64-1.3.4.tgz",
        headers: &[],
    },
    member: "package/lib/libvips-42.dll",
    staged: "libvips-42.dll",
    licence_members: &[
        "package/README.md",
        "package/versions.json",
        "package/package.json",
    ],
    source: "sharp's prebuilt libvips, @img/sharp-libvips-win32-x64 1.3.4 on the npm registry, \
             built by https://github.com/lovell/sharp-libvips at v1.3.4.",
};

/// One MSYS2 package of Windows' libavif set.
pub struct Msys2Package {
    /// The name after `mingw-w64-ucrt-x86_64-`.
    pub name: &'static str,
    /// `pkgver-pkgrel`.
    pub version: &'static str,
    pub sha256: &'static str,
    /// The DLLs it gives the set, from its `ucrt64/bin`.
    pub dlls: &'static [&'static str],
    /// Its `.PKGINFO`'s licence.
    pub licence: &'static str,
}

impl Msys2Package {
    pub fn file(&self) -> String {
        format!(
            "mingw-w64-ucrt-x86_64-{}-{}-any.pkg.tar.zst",
            self.name, self.version
        )
    }
}

/// Windows' libavif set's version, as the notices list it.
pub const WINDOWS_LIBAVIF_VERSION: &str = "libavif 1.4.2-1 (MSYS2 UCRT64)";

/// Windows' libavif set: libavif and every DLL it needs, read from each DLL's imports, checked
/// against the `%SHA256SUM%` MSYS2's signed repository database (`ucrt64.db`) lists for each on
/// 2026-10-31.
pub const WINDOWS_LIBAVIF: [Msys2Package; 11] = [
    Msys2Package {
        name: "libavif",
        version: "1.4.2-1",
        sha256: "9dea354b257d2e593c82c88390a178be547faaaa06f366070b4f8abc784277e6",
        dlls: &["libavif-16.dll"],
        licence: "BSD-2-Clause",
    },
    Msys2Package {
        name: "aom",
        version: "3.15.3-1",
        sha256: "0fcdc93058a9b937e4f4faa0d6b03aa901c2ef568f5bb68ed88bd9c05a7a33f7",
        dlls: &["libaom.dll"],
        licence: "BSD-2-Clause",
    },
    Msys2Package {
        name: "dav1d",
        version: "1.5.4-1",
        sha256: "ccf26c6f29fd36f5692d57fd5e0fe3becec492e0b875fd5e04f47a9582eb8b37",
        dlls: &["libdav1d-7.dll"],
        licence: "BSD-2-Clause",
    },
    Msys2Package {
        name: "rav1e",
        version: "0.8.1-1",
        sha256: "00a03a734f96f66405ad79bae2ffb1c5cf2b050ef90a4ffa508ddbfdb64c0fb1",
        dlls: &["librav1e.dll"],
        licence: "BSD-2-Clause",
    },
    Msys2Package {
        name: "svt-av1",
        version: "4.2.0-1",
        sha256: "87c97a68bab7dd67413ea0cae024c3d2e4bdc2f96fccf38365304642b1b44ee5",
        dlls: &["libSvtAv1Enc-4.dll"],
        licence: "BSD-3-Clause-Clear",
    },
    Msys2Package {
        name: "libyuv",
        version: "1924.r2921.644251f25-2",
        sha256: "3016e0f97bf38313bb336447739f636c8622fc0ca2236fe48e3f6cd662ef56cb",
        dlls: &["libyuv.dll"],
        licence: "BSD-3-Clause",
    },
    Msys2Package {
        name: "libwebp",
        version: "1.6.0-1",
        sha256: "34ff8396c403d484c8777ad49ad0fc06dfb94fadf6f14bcf84d50c45bc6fd17e",
        dlls: &["libsharpyuv-0.dll"],
        licence: "BSD-3-Clause",
    },
    Msys2Package {
        name: "libjpeg-turbo",
        version: "3.2.1-1",
        sha256: "8eed77c1e0d6de7f8822687f7b1dfa32cda09394806ef67b23399e63de1a92a6",
        dlls: &["libjpeg-8.dll"],
        licence: "IJG AND BSD-3-Clause AND Zlib",
    },
    Msys2Package {
        name: "libstdc++",
        version: "16.2.0-6",
        sha256: "33c5e58a85a538cf843a8672991cce591f0231d66da3b66a57629712d64be17f",
        dlls: &["libstdc++-6.dll"],
        licence: "GPL-3.0-or-later WITH GCC-exception-3.1",
    },
    Msys2Package {
        name: "libgcc",
        version: "16.2.0-6",
        sha256: "80b2497f019977dd9528b1abc8621b1328a0115ab1f724047ccbb56bf323f11d",
        dlls: &["libgcc_s_seh-1.dll"],
        licence: "GPL-3.0-or-later WITH GCC-exception-3.1",
    },
    Msys2Package {
        name: "libwinpthread",
        version: "14.0.0.r569.g34eeafb7d-1",
        sha256: "b4ebe2826e848c5e790e06ea7b37d3e0594e005f42382b0506886f17df8127da",
        dlls: &["libwinpthread-1.dll"],
        licence: "MIT AND BSD-3-Clause",
    },
];

/// A download of the pinned ffmpeg and ffprobe, whichever folders in it they sit in.
pub struct MediaToolsArchive {
    pub url: &'static str,
    pub sha256: &'static str,
}

/// One platform's pinned ffmpeg and ffprobe.
pub struct MediaToolsPin {
    /// Node's `${process.platform}-${process.arch}`, as `oriel_core_paths::media_tools_platform`
    /// names this build's.
    pub platform: &'static str,
    pub archives: &'static [MediaToolsArchive],
}

/// The ffmpeg and ffprobe builds Oriel runs: the ones Electron Oriel pinned, so Tidy's outputs
/// stayed the same across the port. Tidy needs these rather than any ffmpeg (plan 060):
/// `ffmpeg-static`'s 6.0 has an SVT-AV1 that runs without SIMD on Apple silicon, about 16 times
/// slower, and no SVT-AV1 at all on Windows. The Mac's are Martin Riedl's static builds and
/// Windows' is gyan.dev's full build, both linked from ffmpeg.org: ffmpeg
/// `oriel_core_paths::MEDIA_TOOLS_VERSION` with SVT-AV1 4.2, dav1d, x264 and x265, GPLv3.
pub const MEDIA_TOOLS: [MediaToolsPin; 2] = [
    MediaToolsPin {
        platform: "darwin-arm64",
        archives: &[
            MediaToolsArchive {
                url: "https://ffmpeg.martin-riedl.de/download/macos/arm64/1789931890_9.0.2/ffmpeg.zip",
                sha256: "c8ed4c4e6978a03c485edbfe4e0a5dc2380f8a30bba5150531b31b094492d924",
            },
            MediaToolsArchive {
                url: "https://ffmpeg.martin-riedl.de/download/macos/arm64/1789931890_9.0.2/ffprobe.zip",
                sha256: "fcbe839537485eaee7a7a8bc5cbc0f90d53617e80943e8a5b2e31cb851197ea6",
            },
        ],
    },
    WINDOWS_MEDIA_TOOLS,
];

/// Windows' ffmpeg and ffprobe, which `package windows` packs from any system.
pub const WINDOWS_MEDIA_TOOLS: MediaToolsPin = MediaToolsPin {
    platform: "win32-x64",
    archives: &[MediaToolsArchive {
        url: "https://github.com/GyanD/codexffmpeg/releases/download/9.0.2/ffmpeg-9.0.2-full_build.zip",
        sha256: "759d0a9831c436a0eb331ad36f236c06cb04aaa0005da46571f0e9d3d9206f6b",
    }],
};

/// The pinned ffmpeg and ffprobe for `platform`, or `None` where nothing is pinned.
pub fn media_tools_for(platform: &str) -> Option<&'static MediaToolsPin> {
    MEDIA_TOOLS.iter().find(|pin| pin.platform == platform)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Windows' libvips is the Mac's release, so a picture decodes the same on both.
    #[test]
    fn windows_libvips_is_the_macs_release() {
        assert_eq!(WINDOWS_LIBVIPS.version, LIBVIPS.label);
    }
}
