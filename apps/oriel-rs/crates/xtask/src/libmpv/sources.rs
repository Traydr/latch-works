//! What Oriel RS's LGPL libmpv is built from (plan 063, decisions 7 and 8): each source release
//! pinned by URL and SHA-256, its licence, and the flags it is built with. Changing any of them
//! changes the set's id, so a new set is built beside the old one.
//!
//! Every library here is LGPL or more permissive, and the set is built so it stays that way: mpv
//! with `-Dgpl=false`, FFmpeg without `--enable-gpl`, `--enable-version3` or `--enable-nonfree`.
//! mpv cannot be built without libass (its meson file requires it), so libass and what it needs
//! (FreeType, FriBidi, HarfBuzz) are in the set too.
//!
//! The set is built from source because no prebuilt LGPL libmpv dylib exists: MPVKit's LGPL
//! builds are static archives, and IINA's and mpv's own are GPL.
//!
//! The fields keep the order and names of the TypeScript this was ported from (`sources.ts`),
//! since the set's id hashes them as JSON: the same pins and flags give the same id.

use serde::Serialize;

/// The oldest macOS the set runs on: Oriel RS's own floor, set by ImageIO's AVIF decoding.
macro_rules! deployment_target {
    () => {
        "13.0"
    };
}

pub const DEPLOYMENT_TARGET: &str = deployment_target!();

/// Bump when the build steps change in a way the pins and flags below do not show. Download
/// URLs are not part of the set's id: the hashes are.
pub const RECIPE_REVISION: u32 = 1;

/// A download and the SHA-256 it must hash to before anything unpacks it.
#[derive(Serialize)]
pub struct PinnedArchive {
    /// Where it is published, then mirrors serving the same file, tried in turn. Left out of the
    /// id: where a source is downloaded from does not change what is built; its hash does.
    #[serde(skip)]
    pub urls: &'static [&'static str],
    pub sha256: &'static str,
    /// The name it is kept under in the download cache.
    pub file: &'static str,
}

/// An archive unpacked into a folder of another source's tree, as a git submodule would be.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourcePart {
    pub name: &'static str,
    /// The folder inside the parent's tree, relative to it.
    pub folder: &'static str,
    pub archive: PinnedArchive,
    /// Its licence, and whether any of it ends up in the set or it only runs during the build.
    pub licence: &'static str,
    pub ships: bool,
    pub licence_files: &'static [&'static str],
}

#[derive(Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum BuildSystem {
    Meson,
    Configure,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Source {
    pub name: &'static str,
    pub version: &'static str,
    pub archive: PinnedArchive,
    /// How the pinned hash was checked against the publisher, beyond trusting the first download.
    pub hash_checked_against: &'static str,
    /// SPDX expression for the terms the set uses it under.
    pub licence: &'static str,
    /// Licence and notice files in its tree, copied beside the set.
    pub licence_files: &'static [&'static str],
    pub parts: &'static [SourcePart],
    pub build_system: BuildSystem,
    pub options: &'static [&'static str],
}

/// In build order: each source's dependencies come before it.
pub const SOURCES: &[Source] = &[
    Source {
        name: "fribidi",
        version: "1.0.17",
        archive: PinnedArchive {
            urls: &[
                "https://github.com/fribidi/fribidi/releases/download/v1.0.17/fribidi-1.0.17.tar.xz",
            ],
            sha256: "6949dcde27d41cebad1fd741fcafc36d55a1020d2d872d4a6eb3914caabbada2",
            file: "fribidi-1.0.17.tar.xz",
        },
        hash_checked_against: "the GitHub release asset's published digest",
        licence: "LGPL-2.1-or-later",
        licence_files: &["COPYING"],
        parts: &[],
        build_system: BuildSystem::Meson,
        options: &["-Ddocs=false", "-Dbin=false", "-Dtests=false"],
    },
    Source {
        name: "freetype",
        version: "2.14.3",
        archive: PinnedArchive {
            urls: &[
                "https://download.savannah.gnu.org/releases/freetype/freetype-2.14.3.tar.xz",
                "https://downloads.sourceforge.net/project/freetype/freetype2/2.14.3/freetype-2.14.3.tar.xz",
            ],
            sha256: "36bc4f1cc413335368ee656c42afca65c5a3987e8768cc28cf11ba775e785a5f",
            file: "freetype-2.14.3.tar.xz",
        },
        hash_checked_against: "nothing published (savannah signs with GPG only); pinned on first use",
        // FreeType is dual-licensed; the set uses it under the FreeType License, not the GPL.
        licence: "FTL",
        licence_files: &["LICENSE.TXT", "docs/FTL.TXT"],
        parts: &[],
        build_system: BuildSystem::Meson,
        // HarfBuzz is built without FreeType and FreeType without HarfBuzz, as libass's own
        // fallback builds them, so neither depends on the other. zlib is FreeType's own copy.
        options: &[
            "-Dbrotli=disabled",
            "-Dbzip2=disabled",
            "-Dharfbuzz=disabled",
            "-Dpng=disabled",
            "-Dzlib=internal",
            "-Dtests=disabled",
        ],
    },
    Source {
        name: "harfbuzz",
        version: "14.6.0",
        archive: PinnedArchive {
            urls: &[
                "https://github.com/harfbuzz/harfbuzz/releases/download/14.6.0/harfbuzz-14.6.0.tar.xz",
            ],
            sha256: "d07a007327277708a2a73ae437887cdbaf282937f6d03ca5467723e9099af586",
            file: "harfbuzz-14.6.0.tar.xz",
        },
        hash_checked_against: "the GitHub release asset's published digest",
        licence: "MIT",
        licence_files: &["COPYING"],
        parts: &[],
        build_system: BuildSystem::Meson,
        // Only libharfbuzz itself: libass shapes with its own FreeType font functions.
        options: &[
            "-Dglib=disabled",
            "-Dgobject=disabled",
            "-Dcairo=disabled",
            "-Dchafa=disabled",
            "-Dpng=disabled",
            "-Dzlib=disabled",
            "-Dicu=disabled",
            "-Dfreetype=disabled",
            "-Dcoretext=disabled",
            "-Draster=disabled",
            "-Dvector=disabled",
            "-Dgpu=disabled",
            "-Dgpu_demo=disabled",
            "-Dsubset=disabled",
            "-Dtests=disabled",
            "-Dintrospection=disabled",
            "-Ddocs=disabled",
            "-Dutilities=disabled",
            "-Dbenchmark=disabled",
        ],
    },
    Source {
        name: "libass",
        version: "0.17.5",
        archive: PinnedArchive {
            urls: &[
                "https://github.com/libass/libass/releases/download/0.17.5/libass-0.17.5.tar.xz",
            ],
            sha256: "2dca25c0e0c837ddf00b52011b3f82cac1e4ddd3ad018227806b0c2288864acc",
            file: "libass-0.17.5.tar.xz",
        },
        hash_checked_against: "the GitHub release asset's published digest",
        licence: "ISC",
        licence_files: &["COPYING"],
        parts: &[],
        build_system: BuildSystem::Meson,
        // Fonts come from Core Text, so no fontconfig. Its arm64 assembly needs no nasm.
        options: &[
            "-Dfontconfig=disabled",
            "-Dcoretext=enabled",
            "-Ddirectwrite=disabled",
            "-Dlibunibreak=disabled",
            "-Dasm=enabled",
            "-Dtest=disabled",
            "-Dcompare=disabled",
            "-Dprofile=disabled",
            "-Dfuzz=disabled",
            "-Dcheckasm=disabled",
        ],
    },
    Source {
        name: "dav1d",
        version: "1.5.4",
        archive: PinnedArchive {
            urls: &["https://downloads.videolan.org/pub/videolan/dav1d/1.5.4/dav1d-1.5.4.tar.xz"],
            sha256: "686616b7c69eb88d44459391ab25cac13b6647a3b288835c5784e71c1514a5c5",
            file: "dav1d-1.5.4.tar.xz",
        },
        hash_checked_against: "the .sha256 file VideoLAN publishes beside it",
        licence: "BSD-2-Clause",
        licence_files: &["COPYING"],
        parts: &[],
        build_system: BuildSystem::Meson,
        // FFmpeg's own AV1 decoder only drives hardware. dav1d decodes AV1 where VideoToolbox
        // cannot: Macs before the M3, and streams the hardware refuses (4:4:4, 12-bit).
        options: &[
            "-Denable_tools=false",
            "-Denable_examples=false",
            "-Denable_tests=false",
            "-Denable_docs=false",
        ],
    },
    Source {
        name: "ffmpeg",
        version: "9.0.2",
        archive: PinnedArchive {
            urls: &["https://ffmpeg.org/releases/ffmpeg-9.0.2.tar.xz"],
            sha256: "8c3850283eb25fa026482078a04051e0be17347b09ef81a0849bec15a96e002e",
            file: "ffmpeg-9.0.2.tar.xz",
        },
        hash_checked_against: "nothing published (ffmpeg.org signs with GPG only); pinned on first use",
        licence: "LGPL-2.1-or-later",
        licence_files: &["LICENSE.md", "COPYING.LGPLv2.1"],
        parts: &[],
        build_system: BuildSystem::Configure,
        // The same 9.0 line as the pinned ffmpeg and ffprobe, built as LGPL libraries for playing
        // only: every demuxer, decoder, parser, filter and hardware decoder, but no encoders,
        // muxers, devices or network. Nothing is found by detection; each external library is
        // named. No iconv: with detection off FFmpeg looks for it only in libc, and macOS keeps
        // it in libiconv. FFmpeg uses it only for a subtitle encoding mpv never sets; mpv
        // converts subtitles' encodings itself.
        options: &[
            "--enable-shared",
            "--disable-static",
            "--disable-programs",
            "--disable-doc",
            "--disable-debug",
            "--disable-autodetect",
            "--enable-pthreads",
            "--enable-videotoolbox",
            "--enable-audiotoolbox",
            "--enable-zlib",
            "--enable-bzlib",
            "--enable-libdav1d",
            "--disable-avdevice",
            "--disable-network",
            "--disable-encoders",
            "--disable-muxers",
        ],
    },
    Source {
        name: "libplacebo",
        version: "7.360.1",
        archive: PinnedArchive {
            urls: &["https://github.com/haasn/libplacebo/archive/refs/tags/v7.360.1.tar.gz"],
            sha256: "d05fdf90bea2f629eaa2d115e909fd356388ac639e54f77b87a018a6d76224bd",
            file: "libplacebo-7.360.1.tar.gz",
        },
        hash_checked_against: "nothing published (a tag archive); pinned on first use",
        licence: "LGPL-2.1-or-later",
        licence_files: &["LICENSE"],
        // The tag's archive leaves its submodules empty, so each is pinned at the commit the tag
        // records.
        parts: &[
            SourcePart {
                name: "Vulkan-Headers",
                folder: "3rdparty/Vulkan-Headers",
                archive: PinnedArchive {
                    urls: &[
                        "https://github.com/KhronosGroup/Vulkan-Headers/archive/450bd2232225d6c7728a4108055ac2e37cef6475.tar.gz",
                    ],
                    sha256: "26df9841c30806a994e2fdf42f7c87bcb1ced9db9a06033469123939fb3fa075",
                    file: "Vulkan-Headers-450bd223.tar.gz",
                },
                // Only for the stubs libplacebo compiles in place of Vulkan, which the set leaves
                // out.
                licence: "Apache-2.0 OR MIT",
                ships: false,
                licence_files: &["LICENSE.md"],
            },
            SourcePart {
                name: "glad",
                folder: "3rdparty/glad",
                archive: PinnedArchive {
                    urls: &[
                        "https://github.com/Dav1dde/glad/archive/73db193f853e2ee079bf3ca8a64aa2eaf6459043.tar.gz",
                    ],
                    sha256: "33dbeae44d8315ece57e14eba4b1b4a02ac5406d1c4f49cd20048c91522a6b9a",
                    file: "glad-73db193f.tar.gz",
                },
                // The generator runs at build time; the OpenGL loader it writes is in libplacebo.
                licence: "MIT",
                ships: true,
                licence_files: &["LICENSE"],
            },
            SourcePart {
                name: "jinja",
                folder: "3rdparty/jinja",
                archive: PinnedArchive {
                    urls: &[
                        "https://github.com/pallets/jinja/archive/15206881c006c79667fe5154fe80c01c65410679.tar.gz",
                    ],
                    sha256: "b88a20dcc2e34072fcf4159325bc6c34cd4b29a81a8b83d15d2f28ba561da296",
                    file: "jinja-15206881.tar.gz",
                },
                licence: "BSD-3-Clause",
                ships: false,
                licence_files: &["LICENSE.txt"],
            },
            SourcePart {
                name: "markupsafe",
                folder: "3rdparty/markupsafe",
                archive: PinnedArchive {
                    urls: &[
                        "https://github.com/pallets/markupsafe/archive/297fc8e356e6836a62087949245d09a28e9f1b13.tar.gz",
                    ],
                    sha256: "da7c010c9c81a66ac73036558c1fcb6212b50482f43211cd1254035b94f82414",
                    file: "markupsafe-297fc8e3.tar.gz",
                },
                licence: "BSD-3-Clause",
                ships: false,
                licence_files: &["LICENSE.txt"],
            },
            SourcePart {
                name: "fast_float",
                folder: "3rdparty/fast_float",
                archive: PinnedArchive {
                    urls: &[
                        "https://github.com/fastfloat/fast_float/archive/97b54ca9e75f5303507699d27c6b4f4efe4641a1.tar.gz",
                    ],
                    sha256: "2b132274539286e41f37857cac22aa8441d21bd86d55de825a3342b149f66801",
                    file: "fast_float-97b54ca9.tar.gz",
                },
                // Header-only, compiled into libplacebo; offered under MIT, Apache-2.0 or BSL-1.0.
                licence: "MIT",
                ships: true,
                licence_files: &["LICENSE-MIT"],
            },
        ],
        build_system: BuildSystem::Meson,
        options: &[
            "-Dvulkan=disabled",
            "-Dvk-proc-addr=disabled",
            "-Dopengl=enabled",
            "-Dgl-proc-addr=enabled",
            "-Dd3d11=disabled",
            "-Dglslang=disabled",
            "-Dshaderc=disabled",
            "-Dlcms=disabled",
            "-Ddovi=enabled",
            "-Dlibdovi=disabled",
            "-Dunwind=disabled",
            "-Dxxhash=disabled",
            "-Ddemos=false",
            "-Dtests=false",
            "-Dbench=false",
            "-Dfuzz=false",
        ],
    },
    Source {
        name: "mpv",
        version: "0.41.0",
        archive: PinnedArchive {
            urls: &["https://github.com/mpv-player/mpv/archive/refs/tags/v0.41.0.tar.gz"],
            sha256: "ee21092a5ee427353392360929dc64645c54479aefdb5babc5cfbb5fad626209",
            file: "mpv-0.41.0.tar.gz",
        },
        hash_checked_against: "nothing published (a tag archive); pinned on first use",
        licence: "LGPL-2.1-or-later",
        licence_files: &["Copyright", "LICENSE.LGPL"],
        parts: &[],
        build_system: BuildSystem::Meson,
        // libmpv only, LGPL, with every optional feature off unless named here. VideoToolbox's
        // zero-copy path into OpenGL (videotoolbox-gl) needs mpv's Cocoa layer, which needs its
        // Swift code; the Swift parts that would take over the window, the Now Playing panel or
        // the Touch Bar stay off, as an embedded player should leave those to the app.
        options: &[
            "-Dgpl=false",
            "-Dlibmpv=true",
            "-Dcplayer=false",
            "-Dtests=false",
            "-Dfuzzers=false",
            "-Dbuild-date=false",
            "-Dauto_features=disabled",
            "-Dcocoa=enabled",
            "-Dswift-build=enabled",
            concat!(
                "-Dswift-flags=-target arm64-apple-macos",
                deployment_target!()
            ),
            "-Dgl=enabled",
            "-Dgl-cocoa=enabled",
            "-Dvideotoolbox-gl=enabled",
            "-Dcoreaudio=enabled",
            "-Diconv=enabled",
            "-Dzlib=enabled",
            "-Dvector=enabled",
            "-Dmacos-10-15-4-features=enabled",
            "-Dmacos-11-features=enabled",
            "-Dmacos-11-3-features=enabled",
            "-Dmacos-12-features=enabled",
            "-Dmanpage-build=disabled",
            "-Dhtml-build=disabled",
            "-Dpdf-build=disabled",
        ],
    },
];

/// The source by name.
pub fn source_by_name(name: &str) -> &'static Source {
    SOURCES
        .iter()
        .find(|source| source.name == name)
        .unwrap_or_else(|| panic!("the libmpv sources have no {name}"))
}

/// The source that makes each library, by the file name's stem.
const LIBRARY_SOURCES: &[(&str, &str)] = &[
    ("libmpv", "mpv"),
    ("libplacebo", "libplacebo"),
    ("libass", "libass"),
    ("libfreetype", "freetype"),
    ("libfribidi", "fribidi"),
    ("libharfbuzz", "harfbuzz"),
    ("libdav1d", "dav1d"),
    ("libavcodec", "ffmpeg"),
    ("libavformat", "ffmpeg"),
    ("libavutil", "ffmpeg"),
    ("libavfilter", "ffmpeg"),
    ("libswscale", "ffmpeg"),
    ("libswresample", "ffmpeg"),
];

/// Which source built a library file, or `None` for a file no source is known to make.
pub fn source_of_library(file: &str) -> Option<&'static Source> {
    let stem = file.split('.').next().unwrap_or(file);
    LIBRARY_SOURCES
        .iter()
        .find(|(library, _)| *library == stem)
        .map(|(_, source)| source_by_name(source))
}
