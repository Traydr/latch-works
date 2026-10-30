//! The prebuilt native libraries Oriel RS ships, each pinned by URL and SHA-256 (the owner's
//! decision of 2026-10-29: prebuilt binaries over builds from source). Changing a pin changes its
//! set's id, so a new set is fetched beside the old one.

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
    /// ships it, since the fingerprints match glazier-core's only through that build.
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
