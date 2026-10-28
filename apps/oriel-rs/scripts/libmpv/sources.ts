/**
 * What Oriel RS's LGPL libmpv is built from (plan 063, decisions 7 and 8): each source release
 * pinned by URL and SHA-256, its licence, and the flags it is built with. `build-libmpv.ts` reads
 * these; changing any of them changes the set's id, so a new set is built beside the old one.
 *
 * Every library here is LGPL or more permissive, and the set is built so it stays that way: mpv
 * with `-Dgpl=false`, FFmpeg without `--enable-gpl`, `--enable-version3` or `--enable-nonfree`.
 * mpv cannot be built without libass (its meson file requires it), so libass and what it needs
 * (FreeType, FriBidi, HarfBuzz) are in the set too.
 */

/** A download and the SHA-256 it must hash to before anything unpacks it. */
export interface PinnedArchive {
  /** Where it is published, then mirrors serving the same file, tried in turn. */
  urls: readonly [string, ...string[]];
  sha256: string;
  /** The name it is kept under in the download cache. */
  file: string;
}

/** An archive unpacked into a folder of another source's tree, as a git submodule would be. */
interface SourcePart {
  name: string;
  /** The folder inside the parent's tree, relative to it. */
  folder: string;
  archive: PinnedArchive;
  /** Its licence, and whether any of it ends up in the set or it only runs during the build. */
  licence: string;
  ships: boolean;
  licenceFiles: readonly string[];
}

type BuildSystem = "meson" | "configure";

export interface Source {
  name: string;
  version: string;
  archive: PinnedArchive;
  /** How the pinned hash was checked against the publisher, beyond trusting the first download. */
  hashCheckedAgainst: string;
  /** SPDX expression for the terms the set uses it under. */
  licence: string;
  /** Licence and notice files in its tree, copied beside the set. */
  licenceFiles: readonly string[];
  parts: readonly SourcePart[];
  buildSystem: BuildSystem;
  options: readonly string[];
}

/** The oldest macOS the set runs on: Oriel RS's own floor, set by ImageIO's AVIF decoding. */
export const DEPLOYMENT_TARGET = "13.0";

/** Bump when the build steps change in a way the pins and flags below do not show. Download
 * URLs are not part of the set's id: the hashes are. */
export const RECIPE_REVISION = 1;

/** In build order: each source's dependencies come before it. */
export const SOURCES: readonly Source[] = [
  {
    name: "fribidi",
    version: "1.0.17",
    archive: {
      urls: ["https://github.com/fribidi/fribidi/releases/download/v1.0.17/fribidi-1.0.17.tar.xz"],
      sha256: "6949dcde27d41cebad1fd741fcafc36d55a1020d2d872d4a6eb3914caabbada2",
      file: "fribidi-1.0.17.tar.xz",
    },
    hashCheckedAgainst: "the GitHub release asset's published digest",
    licence: "LGPL-2.1-or-later",
    licenceFiles: ["COPYING"],
    parts: [],
    buildSystem: "meson",
    options: ["-Ddocs=false", "-Dbin=false", "-Dtests=false"],
  },
  {
    name: "freetype",
    version: "2.14.3",
    archive: {
      urls: [
        "https://download.savannah.gnu.org/releases/freetype/freetype-2.14.3.tar.xz",
        "https://downloads.sourceforge.net/project/freetype/freetype2/2.14.3/freetype-2.14.3.tar.xz",
      ],
      sha256: "36bc4f1cc413335368ee656c42afca65c5a3987e8768cc28cf11ba775e785a5f",
      file: "freetype-2.14.3.tar.xz",
    },
    hashCheckedAgainst: "nothing published (savannah signs with GPG only); pinned on first use",
    // FreeType is dual-licensed; the set uses it under the FreeType License, not the GPL.
    licence: "FTL",
    licenceFiles: ["LICENSE.TXT", "docs/FTL.TXT"],
    parts: [],
    buildSystem: "meson",
    // HarfBuzz is built without FreeType and FreeType without HarfBuzz, as libass's own
    // fallback builds them, so neither depends on the other. zlib is FreeType's own copy.
    options: [
      "-Dbrotli=disabled",
      "-Dbzip2=disabled",
      "-Dharfbuzz=disabled",
      "-Dpng=disabled",
      "-Dzlib=internal",
      "-Dtests=disabled",
    ],
  },
  {
    name: "harfbuzz",
    version: "14.6.0",
    archive: {
      urls: [
        "https://github.com/harfbuzz/harfbuzz/releases/download/14.6.0/harfbuzz-14.6.0.tar.xz",
      ],
      sha256: "d07a007327277708a2a73ae437887cdbaf282937f6d03ca5467723e9099af586",
      file: "harfbuzz-14.6.0.tar.xz",
    },
    hashCheckedAgainst: "the GitHub release asset's published digest",
    licence: "MIT",
    licenceFiles: ["COPYING"],
    parts: [],
    buildSystem: "meson",
    // Only libharfbuzz itself: libass shapes with its own FreeType font functions.
    options: [
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
  {
    name: "libass",
    version: "0.17.5",
    archive: {
      urls: ["https://github.com/libass/libass/releases/download/0.17.5/libass-0.17.5.tar.xz"],
      sha256: "2dca25c0e0c837ddf00b52011b3f82cac1e4ddd3ad018227806b0c2288864acc",
      file: "libass-0.17.5.tar.xz",
    },
    hashCheckedAgainst: "the GitHub release asset's published digest",
    licence: "ISC",
    licenceFiles: ["COPYING"],
    parts: [],
    buildSystem: "meson",
    // Fonts come from Core Text, so no fontconfig. Its arm64 assembly needs no nasm.
    options: [
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
  {
    name: "dav1d",
    version: "1.5.4",
    archive: {
      urls: ["https://downloads.videolan.org/pub/videolan/dav1d/1.5.4/dav1d-1.5.4.tar.xz"],
      sha256: "686616b7c69eb88d44459391ab25cac13b6647a3b288835c5784e71c1514a5c5",
      file: "dav1d-1.5.4.tar.xz",
    },
    hashCheckedAgainst: "the .sha256 file VideoLAN publishes beside it",
    licence: "BSD-2-Clause",
    licenceFiles: ["COPYING"],
    parts: [],
    buildSystem: "meson",
    // FFmpeg's own AV1 decoder only drives hardware. dav1d decodes AV1 where VideoToolbox
    // cannot: Macs before the M3, and streams the hardware refuses (4:4:4, 12-bit).
    options: [
      "-Denable_tools=false",
      "-Denable_examples=false",
      "-Denable_tests=false",
      "-Denable_docs=false",
    ],
  },
  {
    name: "ffmpeg",
    version: "9.0.2",
    archive: {
      urls: ["https://ffmpeg.org/releases/ffmpeg-9.0.2.tar.xz"],
      sha256: "8c3850283eb25fa026482078a04051e0be17347b09ef81a0849bec15a96e002e",
      file: "ffmpeg-9.0.2.tar.xz",
    },
    hashCheckedAgainst: "nothing published (ffmpeg.org signs with GPG only); pinned on first use",
    licence: "LGPL-2.1-or-later",
    licenceFiles: ["LICENSE.md", "COPYING.LGPLv2.1"],
    parts: [],
    buildSystem: "configure",
    // The same 9.0 line as the pinned ffmpeg and ffprobe, built as LGPL libraries for playing
    // only: every demuxer, decoder, parser, filter and hardware decoder, but no encoders,
    // muxers, devices or network. Nothing is found by detection; each external library is named.
    // No iconv: with detection off FFmpeg looks for it only in libc, and macOS keeps it in
    // libiconv. FFmpeg uses it only for a subtitle encoding mpv never sets; mpv converts
    // subtitles' encodings itself.
    options: [
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
  {
    name: "libplacebo",
    version: "7.360.1",
    archive: {
      urls: ["https://github.com/haasn/libplacebo/archive/refs/tags/v7.360.1.tar.gz"],
      sha256: "d05fdf90bea2f629eaa2d115e909fd356388ac639e54f77b87a018a6d76224bd",
      file: "libplacebo-7.360.1.tar.gz",
    },
    hashCheckedAgainst: "nothing published (a tag archive); pinned on first use",
    licence: "LGPL-2.1-or-later",
    licenceFiles: ["LICENSE"],
    // The tag's archive leaves its submodules empty, so each is pinned at the commit the tag
    // records.
    parts: [
      {
        name: "Vulkan-Headers",
        folder: "3rdparty/Vulkan-Headers",
        archive: {
          urls: [
            "https://github.com/KhronosGroup/Vulkan-Headers/archive/450bd2232225d6c7728a4108055ac2e37cef6475.tar.gz",
          ],
          sha256: "26df9841c30806a994e2fdf42f7c87bcb1ced9db9a06033469123939fb3fa075",
          file: "Vulkan-Headers-450bd223.tar.gz",
        },
        // Only for the stubs libplacebo compiles in place of Vulkan, which the set leaves out.
        licence: "Apache-2.0 OR MIT",
        ships: false,
        licenceFiles: ["LICENSE.md"],
      },
      {
        name: "glad",
        folder: "3rdparty/glad",
        archive: {
          urls: [
            "https://github.com/Dav1dde/glad/archive/73db193f853e2ee079bf3ca8a64aa2eaf6459043.tar.gz",
          ],
          sha256: "33dbeae44d8315ece57e14eba4b1b4a02ac5406d1c4f49cd20048c91522a6b9a",
          file: "glad-73db193f.tar.gz",
        },
        // The generator runs at build time; the OpenGL loader it writes is in libplacebo.
        licence: "MIT",
        ships: true,
        licenceFiles: ["LICENSE"],
      },
      {
        name: "jinja",
        folder: "3rdparty/jinja",
        archive: {
          urls: [
            "https://github.com/pallets/jinja/archive/15206881c006c79667fe5154fe80c01c65410679.tar.gz",
          ],
          sha256: "b88a20dcc2e34072fcf4159325bc6c34cd4b29a81a8b83d15d2f28ba561da296",
          file: "jinja-15206881.tar.gz",
        },
        licence: "BSD-3-Clause",
        ships: false,
        licenceFiles: ["LICENSE.txt"],
      },
      {
        name: "markupsafe",
        folder: "3rdparty/markupsafe",
        archive: {
          urls: [
            "https://github.com/pallets/markupsafe/archive/297fc8e356e6836a62087949245d09a28e9f1b13.tar.gz",
          ],
          sha256: "da7c010c9c81a66ac73036558c1fcb6212b50482f43211cd1254035b94f82414",
          file: "markupsafe-297fc8e3.tar.gz",
        },
        licence: "BSD-3-Clause",
        ships: false,
        licenceFiles: ["LICENSE.txt"],
      },
      {
        name: "fast_float",
        folder: "3rdparty/fast_float",
        archive: {
          urls: [
            "https://github.com/fastfloat/fast_float/archive/97b54ca9e75f5303507699d27c6b4f4efe4641a1.tar.gz",
          ],
          sha256: "2b132274539286e41f37857cac22aa8441d21bd86d55de825a3342b149f66801",
          file: "fast_float-97b54ca9.tar.gz",
        },
        // Header-only, compiled into libplacebo; offered under MIT, Apache-2.0 or BSL-1.0.
        licence: "MIT",
        ships: true,
        licenceFiles: ["LICENSE-MIT"],
      },
    ],
    buildSystem: "meson",
    options: [
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
  {
    name: "mpv",
    version: "0.41.0",
    archive: {
      urls: ["https://github.com/mpv-player/mpv/archive/refs/tags/v0.41.0.tar.gz"],
      sha256: "ee21092a5ee427353392360929dc64645c54479aefdb5babc5cfbb5fad626209",
      file: "mpv-0.41.0.tar.gz",
    },
    hashCheckedAgainst: "nothing published (a tag archive); pinned on first use",
    licence: "LGPL-2.1-or-later",
    licenceFiles: ["Copyright", "LICENSE.LGPL"],
    parts: [],
    buildSystem: "meson",
    // libmpv only, LGPL, with every optional feature off unless named here. VideoToolbox's
    // zero-copy path into OpenGL (videotoolbox-gl) needs mpv's Cocoa layer, which needs its
    // Swift code; the Swift parts that would take over the window, the Now Playing panel or
    // the Touch Bar stay off, as an embedded player should leave those to the app.
    options: [
      "-Dgpl=false",
      "-Dlibmpv=true",
      "-Dcplayer=false",
      "-Dtests=false",
      "-Dfuzzers=false",
      "-Dbuild-date=false",
      "-Dauto_features=disabled",
      "-Dcocoa=enabled",
      "-Dswift-build=enabled",
      `-Dswift-flags=-target arm64-apple-macos${DEPLOYMENT_TARGET}`,
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
